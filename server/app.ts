import express, { type NextFunction, type Request, type Response } from "express";
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createOtpProvider, OtpProviderUnavailableError, type OtpDeliveryProvider } from "./otp";

const COOKIE_NAME = "plans_session";
const SESSION_DAYS = 30;
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const VIBES = ["Food", "Creative", "Events", "Outdoors", "Games", "Chill"];

type JsonRecord = Record<string, unknown>;
type RequestWithUser = Request & { userId?: string };

export type AppOptions = {
  dataDir?: string;
  devOtp?: string;
  seed?: boolean;
  seedLogin?: boolean;
  secureCookies?: boolean;
  otpProvider?: OtpDeliveryProvider;
};

type Stream = { response: Response; heartbeat: NodeJS.Timeout };

const now = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function asJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function makePassword(password: string, salt = randomBytes(16).toString("hex")) {
  return { salt, passwordHash: scryptSync(password, salt, 64).toString("hex") };
}

function passwordMatches(password: string, salt: string, stored: string) {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(stored, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key]) => key)
      .map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]),
  );
}

function photoType(buffer: Buffer, contentType: string) {
  const signature = [
    { mime: "image/jpeg", ext: "jpg", ok: buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
    { mime: "image/png", ext: "png", ok: buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
    { mime: "image/webp", ext: "webp", ok: buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP" },
  ].find((item) => item.ok);
  return signature?.mime === contentType.toLowerCase().split(";")[0] ? signature : null;
}

function profileFromRow(row: JsonRecord | undefined, photos: JsonRecord[] = []) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email || null,
    phone: row.phone || null,
    name: row.name || "",
    age: row.age || null,
    gender: row.gender || "",
    preferences: asJson<string[]>(row.preferences, []),
    city: row.city || "Bangalore",
    vibes: asJson<string[]>(row.vibes, []),
    intent: row.intent || "",
    bio: row.bio || "",
    onboardingComplete: Boolean(row.onboarding_complete),
    verificationStatus: row.verification_status || "unverified",
    createdAt: row.created_at,
    photos: photos.map((photo) => ({ id: photo.id, url: photo.url, mime: photo.mime, size: photo.size, sortOrder: photo.sort_order })),
  };
}

function createSchema(db: DatabaseSync) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE, phone TEXT UNIQUE, password_hash TEXT, salt TEXT,
      name TEXT NOT NULL DEFAULT '', age INTEGER, gender TEXT NOT NULL DEFAULT '', preferences TEXT NOT NULL DEFAULT '[]',
      city TEXT NOT NULL DEFAULT 'Bangalore', vibes TEXT NOT NULL DEFAULT '[]', intent TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
      onboarding_complete INTEGER NOT NULL DEFAULT 0, verification_status TEXT NOT NULL DEFAULT 'unverified',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS profile_photos (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, url TEXT NOT NULL,
      storage_key TEXT, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL, image_url TEXT NOT NULL,
      date_label TEXT NOT NULL, time_label TEXT NOT NULL, categories TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_interests (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, PRIMARY KEY (user_id, activity_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS otp_challenges (
      id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, phone TEXT NOT NULL, code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
      responded_at TEXT, UNIQUE(sender_id, receiver_id, activity_id)
    );
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY, activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE, user_low TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_high TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, invitation_id TEXT NOT NULL UNIQUE REFERENCES invitations(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL, UNIQUE(activity_id, user_low, user_high)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, match_id TEXT NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, client_nonce TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(conversation_id, sender_id, client_nonce)
    );
    CREATE TABLE IF NOT EXISTS date_plans (
      id TEXT PRIMARY KEY, match_id TEXT NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
      confirmed_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, date_label TEXT NOT NULL, time_label TEXT NOT NULL,
      location TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_interests_activity ON activity_interests(activity_id);
    CREATE INDEX IF NOT EXISTS idx_invitations_receiver ON invitations(receiver_id, status);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  `);
}

const seedUsers = [
  ["aanya", "aanya@example.test", "Aanya", 26, "Woman", ["Men"], ["Food", "Creative", "Chill"], "A relationship", "Usually down for food after 8.", "/images/aanya.jpg"],
  ["rohan", "rohan@example.test", "Rohan", 28, "Man", ["Women"], ["Food", "Outdoors", "Chill"], "A relationship", "Momos, long walks, no big plan.", "/images/rohan.jpg"],
  ["meera", "meera@example.test", "Meera", 27, "Woman", ["Men"], ["Food", "Creative"], "Open to seeing where it goes", "I know too many cafés in Indiranagar.", "/images/meera.jpg"],
  ["kabir", "kabir@example.test", "Kabir", 29, "Man", ["Women"], ["Food", "Outdoors"], "A relationship", "Will walk anywhere for good momos.", "/images/kabir.jpg"],
  ["priya", "priya@example.test", "Priya", 25, "Woman", ["Men"], ["Food", "Games", "Chill"], "Open to seeing where it goes", "Food first. Everything else later.", "/images/priya.jpg"],
  ["nisha", "nisha@example.test", "Nisha", 30, "Woman", ["Men"], ["Outdoors", "Events", "Chill"], "A relationship", "More of a walk-and-talk person.", "/images/nisha.jpg"],
  ["arjun", "arjun@example.test", "Arjun", 27, "Man", ["Women"], ["Outdoors", "Games"], "A relationship", "Usually free after football.", "/images/arjun.jpg"],
  ["dev", "dev@example.test", "Dev", 31, "Man", ["Women"], ["Events", "Creative", "Chill"], "Open to seeing where it goes", "I’d rather wander Church Street than plan the evening.", "/images/dev.jpg"],
] as const;

function seedDatabase(db: DatabaseSync, enableSeedLogin: boolean) {
  const stamp = now();
  const activities = [
    ["cafe-date", "Café Date", "Indiranagar", "A slow coffee, one good conversation, and nowhere else to be.", "/images/cafe.jpg", "Saturday", "6:30 PM", ["Food", "Chill"]],
    ["momo-cubbon", "Momo + Cubbon Park", "Cubbon Park", "Start with hot momos, then take the long way through the park.", "/images/cubbon.jpg", "Saturday", "5:00 PM", ["Food", "Outdoors"]],
    ["church-street", "Church Street After Dark", "Church Street", "Bookshops, bright signs, and a night that can decide where it goes.", "/images/church.jpg", "Tonight", "8:00 PM", ["Events", "Chill"]],
  ] as const;
  const activityStatement = db.prepare(`INSERT INTO activities (id,name,location,description,image_url,date_label,time_label,categories)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,description=excluded.description,image_url=excluded.image_url,date_label=excluded.date_label,time_label=excluded.time_label,categories=excluded.categories`);
  for (const item of activities) activityStatement.run(item[0], item[1], item[2], item[3], item[4], item[5], item[6], JSON.stringify(item[7]));
  const credentials = enableSeedLogin ? makePassword("Meet123!") : { passwordHash: null, salt: null };
  const userStatement = db.prepare(`INSERT OR IGNORE INTO users
    (id,email,password_hash,salt,name,age,gender,preferences,city,vibes,intent,bio,onboarding_complete,verification_status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,'verified',?,?)`);
  const photoStatement = db.prepare(`INSERT OR IGNORE INTO profile_photos (id,user_id,url,mime,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?)`);
  for (const user of seedUsers) {
    userStatement.run(user[0], user[1], credentials.passwordHash, credentials.salt, user[2], user[3], user[4], JSON.stringify(user[5]), "Bangalore", JSON.stringify(user[6]), user[7], user[8], stamp, stamp);
    photoStatement.run(`seed-${user[0]}`, user[0], user[9], "image/jpeg", 0, 0, stamp);
    if (!enableSeedLogin) db.prepare("UPDATE users SET password_hash=NULL,salt=NULL WHERE id=?").run(user[0]);
  }
  const interests: Record<string, string[]> = {
    "cafe-date": ["aanya", "rohan", "meera", "dev", "priya"],
    "momo-cubbon": ["aanya", "rohan", "kabir", "nisha", "arjun", "priya"],
    "church-street": ["meera", "dev", "rohan", "nisha", "kabir"],
  };
  const interestStatement = db.prepare("INSERT OR IGNORE INTO activity_interests (user_id,activity_id,created_at) VALUES (?,?,?)");
  for (const [activityId, userIds] of Object.entries(interests)) for (const userId of userIds) interestStatement.run(userId, activityId, stamp);
}

export function createPlansApp(options: AppOptions = {}) {
  const dataDir = path.resolve(options.dataDir || process.env.PLANS_DATA_DIR || path.join(process.cwd(), "data"));
  const uploadDir = path.join(dataDir, "uploads");
  mkdirSync(uploadDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "plans.sqlite"));
  createSchema(db);
  if (options.seed !== false) seedDatabase(db, options.seedLogin ?? process.env.NODE_ENV !== "production");

  const app = express();
  const streams = new Map<string, Set<Stream>>();
  const otpProvider = options.otpProvider || createOtpProvider({ development: process.env.NODE_ENV !== "production", developmentCode: options.devOtp || "246810" });
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    next();
  });
  app.use("/uploads", express.static(uploadDir, { immutable: true, maxAge: "1y", fallthrough: false }));
  app.use(express.json({ limit: "256kb" }));

  function currentUserId(req: Request) {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (!token) return undefined;
    const row = db.prepare("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?").get(hash(token), now()) as JsonRecord | undefined;
    return row?.user_id as string | undefined;
  }
  function attachUser(req: RequestWithUser, _res: Response, next: NextFunction) {
    req.userId = currentUserId(req);
    next();
  }
  function requireUser(req: RequestWithUser, res: Response, next: NextFunction) {
    if (!req.userId) return res.status(401).json({ error: "Please log in to continue." });
    next();
  }
  function requireReady(req: RequestWithUser, res: Response, next: NextFunction) {
    if (!req.userId) return res.status(401).json({ error: "Please log in to continue." });
    const user = db.prepare("SELECT onboarding_complete FROM users WHERE id=?").get(req.userId) as JsonRecord | undefined;
    if (!user || !Boolean(user.onboarding_complete)) return res.status(403).json({ error: "Finish setting up your profile first." });
    next();
  }
  function setSession(res: Response, userId: string) {
    const token = randomBytes(32).toString("base64url");
    const created = now();
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)").run(hash(token), userId, expires, created);
    const secure = options.secureCookies ?? process.env.NODE_ENV === "production";
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: "lax", secure, maxAge: SESSION_DAYS * 86400000, path: "/" });
  }
  function getProfile(userId: string) {
    const row = db.prepare("SELECT * FROM users WHERE id=?").get(userId) as JsonRecord | undefined;
    const photos = db.prepare("SELECT * FROM profile_photos WHERE user_id=? ORDER BY sort_order,created_at").all(userId) as JsonRecord[];
    return profileFromRow(row, photos);
  }
  function getPublicProfile(userId: string) {
    const profile = getProfile(userId);
    if (!profile) return null;
    return {
      id: profile.id,
      name: profile.name,
      age: profile.age,
      city: profile.city,
      vibes: profile.vibes,
      intent: profile.intent,
      bio: profile.bio,
      onboardingComplete: profile.onboardingComplete,
      photos: profile.photos.map(({ id, url }) => ({ id, url })),
    };
  }
  function emit(userId: string, event: string, data: JsonRecord = {}) {
    for (const stream of streams.get(userId) || []) stream.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  app.use("/api", attachUser);
  app.use("/api", (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && origin !== `${req.protocol}://${req.get("host")}`) return res.status(403).json({ error: "Cross-site request blocked." });
    }
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/activities", (req: RequestWithUser, res) => {
    const viewerId = req.userId || "";
    const rows = db.prepare(`SELECT a.*, COUNT(iu.id) AS interested_count FROM activities a
      LEFT JOIN activity_interests i ON i.activity_id=a.id AND i.user_id<>?
      LEFT JOIN users iu ON iu.id=i.user_id AND iu.onboarding_complete=1
      GROUP BY a.id ORDER BY CASE a.id WHEN 'cafe-date' THEN 1 WHEN 'momo-cubbon' THEN 2 ELSE 3 END`).all(viewerId) as JsonRecord[];
    const items = rows.map((row) => {
      const people = db.prepare(`SELECT u.id,u.name,p.url FROM activity_interests i JOIN users u ON u.id=i.user_id LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order,created_at LIMIT 1) WHERE i.activity_id=? AND i.user_id<>? AND u.onboarding_complete=1 ORDER BY i.created_at LIMIT 4`).all(row.id as string, viewerId);
      const viewerInterested = Boolean(req.userId && db.prepare("SELECT 1 FROM activity_interests WHERE user_id=? AND activity_id=?").get(req.userId, row.id as string));
      return { ...row, categories: asJson(row.categories, []), interestedCount: Number(row.interested_count), viewerInterested, people };
    });
    res.json({ activities: items });
  });
  app.get("/api/activities/:id", (req: RequestWithUser, res) => {
    const row = db.prepare(`SELECT a.*, COUNT(iu.id) AS interested_count FROM activities a
      LEFT JOIN activity_interests i ON i.activity_id=a.id AND i.user_id<>?
      LEFT JOIN users iu ON iu.id=i.user_id AND iu.onboarding_complete=1
      WHERE a.id=? GROUP BY a.id`).get(req.userId || "", req.params.id) as JsonRecord | undefined;
    if (!row) return res.status(404).json({ error: "Plan not found." });
    const viewerInterested = Boolean(req.userId && db.prepare("SELECT 1 FROM activity_interests WHERE user_id=? AND activity_id=?").get(req.userId, req.params.id));
    res.json({ activity: { ...row, categories: asJson(row.categories, []), interestedCount: Number(row.interested_count), viewerInterested } });
  });
  app.get("/api/activities/:id/people", (req: RequestWithUser, res) => {
    const people = db.prepare(`SELECT u.id,u.name,u.age,u.city,u.vibes,u.bio,p.url AS photo_url FROM activity_interests i JOIN users u ON u.id=i.user_id LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order,created_at LIMIT 1) WHERE i.activity_id=? AND i.user_id<>? AND u.onboarding_complete=1 ORDER BY i.created_at`).all(req.params.id, req.userId || "") as JsonRecord[];
    res.json({ people: people.map((person) => ({ ...person, vibes: asJson(person.vibes, []) })) });
  });
  app.get("/api/me", (req: RequestWithUser, res) => res.json({ user: req.userId ? getProfile(req.userId) : null }));
  app.get("/api/profiles/:id", requireReady, (req, res) => {
    const profile = getPublicProfile(req.params.id);
    if (!profile || !profile.onboardingComplete) return res.status(404).json({ error: "Profile not found." });
    res.json({ profile });
  });

  app.post("/api/auth/register", (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
    if (password.length < 8) return res.status(400).json({ error: "Use at least 8 characters for your password." });
    if (db.prepare("SELECT 1 FROM users WHERE email=?").get(email)) return res.status(409).json({ error: "An account already exists for this email." });
    const id = randomUUID();
    const credentials = makePassword(password);
    const stamp = now();
    db.prepare(`INSERT INTO users (id,email,password_hash,salt,created_at,updated_at) VALUES (?,?,?,?,?,?)`).run(id, email, credentials.passwordHash, credentials.salt, stamp, stamp);
    setSession(res, id);
    res.status(201).json({ user: getProfile(id) });
  });
  app.post("/api/auth/login", (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const row = db.prepare("SELECT * FROM users WHERE email=?").get(email) as JsonRecord | undefined;
    if (!row?.password_hash || !row.salt || !passwordMatches(password, String(row.salt), String(row.password_hash))) return res.status(401).json({ error: "Email or password is incorrect." });
    setSession(res, String(row.id));
    res.json({ user: getProfile(String(row.id)) });
  });
  app.post("/api/auth/logout", (req: RequestWithUser, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token));
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.status(204).end();
  });
  app.post("/api/auth/google", (_req, res) => res.status(501).json({ error: "Google sign-in is not configured yet. Use email or the development phone flow." }));
  app.post("/api/auth/otp/request", (req: RequestWithUser, res) => {
    const phone = String(req.body.phone || "").replace(/\s|-/g, "");
    const purpose = req.body.purpose === "safety" ? "safety" : "login";
    if (!/^\+91[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: "Enter an Indian number in +91 format." });
    if (purpose === "safety" && !req.userId) return res.status(401).json({ error: "Please log in first." });
    let delivery;
    try {
      delivery = otpProvider.issue(phone, purpose);
    } catch (error) {
      if (error instanceof OtpProviderUnavailableError) return res.status(503).json({ error: error.message });
      throw error;
    }
    db.prepare("DELETE FROM otp_challenges WHERE phone=? AND purpose=? AND used_at IS NULL").run(phone, purpose);
    db.prepare(`INSERT INTO otp_challenges (id,user_id,phone,code_hash,purpose,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), req.userId || null, phone, hash(delivery.verificationCode), purpose, new Date(Date.now() + 10 * 60000).toISOString(), now());
    res.json(delivery.response);
  });
  app.post("/api/auth/otp/verify", (req: RequestWithUser, res) => {
    const phone = String(req.body.phone || "").replace(/\s|-/g, "");
    const code = String(req.body.code || "");
    const purpose = req.body.purpose === "safety" ? "safety" : "login";
    const challenge = db.prepare(`SELECT * FROM otp_challenges WHERE phone=? AND purpose=? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(phone, purpose) as JsonRecord | undefined;
    if (!challenge || String(challenge.expires_at) <= now()) return res.status(400).json({ error: "That code has expired. Request a new one." });
    db.prepare("UPDATE otp_challenges SET attempts=attempts+1 WHERE id=?").run(String(challenge.id));
    if (Number(challenge.attempts) >= 5 || hash(code) !== challenge.code_hash) return res.status(400).json({ error: "That code is not correct." });
    db.prepare("UPDATE otp_challenges SET used_at=? WHERE id=?").run(now(), String(challenge.id));
    if (purpose === "safety") {
      if (!req.userId || challenge.user_id !== req.userId) return res.status(401).json({ error: "Please request a new code." });
      try {
        db.prepare("UPDATE users SET phone=?,verification_status='verified',updated_at=? WHERE id=?").run(phone, now(), req.userId);
      } catch {
        return res.status(409).json({ error: "That phone number is already attached to another account." });
      }
      return res.json({ user: getProfile(req.userId) });
    }
    let user = db.prepare("SELECT id FROM users WHERE phone=?").get(phone) as JsonRecord | undefined;
    if (!user) {
      const id = randomUUID();
      const stamp = now();
      db.prepare("INSERT INTO users (id,phone,verification_status,created_at,updated_at) VALUES (?,?,'verified',?,?)").run(id, phone, stamp, stamp);
      user = { id };
    }
    setSession(res, String(user.id));
    res.json({ user: getProfile(String(user.id)) });
  });

  app.patch("/api/me", requireUser, (req: RequestWithUser, res) => {
    const name = String(req.body.name || "").trim().slice(0, 60);
    const age = Number(req.body.age);
    const gender = String(req.body.gender || "").slice(0, 40);
    const preferences = Array.isArray(req.body.preferences) ? [...new Set(req.body.preferences.map(String))].slice(0, 4) : [];
    const vibes = Array.isArray(req.body.vibes) ? [...new Set<string>(req.body.vibes.map(String).filter((v: string) => VIBES.includes(v)))].slice(0, 4) : [];
    const intent = String(req.body.intent || "").slice(0, 80);
    const bio = String(req.body.bio || "").trim().slice(0, 180);
    if (!name || age < 18 || age > 80) return res.status(400).json({ error: "Add your name and a valid age." });
    if (!gender || preferences.length === 0 || !intent) return res.status(400).json({ error: "Complete the gender, preference, and dating intention fields." });
    const current = db.prepare("SELECT onboarding_complete FROM users WHERE id=?").get(req.userId!) as JsonRecord;
    if (Boolean(current.onboarding_complete) && vibes.length < 2) return res.status(400).json({ error: "Keep at least two vibes on a live profile." });
    db.prepare(`UPDATE users SET name=?,age=?,gender=?,preferences=?,city='Bangalore',vibes=?,intent=?,bio=?,updated_at=? WHERE id=?`).run(name, age, gender, JSON.stringify(preferences), JSON.stringify(vibes), intent, bio, now(), req.userId!);
    res.json({ user: getProfile(req.userId!) });
  });
  app.post("/api/me/complete", requireUser, (req: RequestWithUser, res) => {
    const user = getProfile(req.userId!);
    if (!user?.name || !user.age || !user.gender || !user.intent || user.preferences.length === 0) return res.status(400).json({ error: "Finish your profile details first." });
    if (user.photos.length < 2) return res.status(400).json({ error: "Add at least two photos." });
    if (user.vibes.length < 2) return res.status(400).json({ error: "Choose at least two vibes." });
    if (user.verificationStatus !== "verified") return res.status(400).json({ error: "Verify your phone to finish." });
    db.prepare("UPDATE users SET onboarding_complete=1,updated_at=? WHERE id=?").run(now(), req.userId!);
    res.json({ user: getProfile(req.userId!) });
  });

  const photoBody = express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: MAX_PHOTO_BYTES });
  app.post("/api/me/photos", requireUser, photoBody, (req: RequestWithUser, res) => {
    const count = Number((db.prepare("SELECT COUNT(*) AS count FROM profile_photos WHERE user_id=?").get(req.userId!) as JsonRecord).count);
    if (count >= MAX_PHOTOS) return res.status(400).json({ error: `You can add up to ${MAX_PHOTOS} photos.` });
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const type = photoType(buffer, req.headers["content-type"] || "");
    if (!buffer.length || !type) return res.status(415).json({ error: "Choose a JPG, PNG, or WebP image." });
    const id = randomUUID();
    const key = `${id}.${type.ext}`;
    const temporary = path.join(uploadDir, `${key}.tmp`);
    writeFileSync(temporary, buffer, { flag: "wx" });
    renameSync(temporary, path.join(uploadDir, key));
    db.prepare("INSERT INTO profile_photos (id,user_id,url,storage_key,mime,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, req.userId!, `/uploads/${key}`, key, type.mime, buffer.length, count, now());
    res.status(201).json({ user: getProfile(req.userId!) });
  });
  app.put("/api/me/photos/:id", requireUser, photoBody, (req: RequestWithUser, res) => {
    const current = db.prepare("SELECT * FROM profile_photos WHERE id=? AND user_id=?").get(req.params.id, req.userId!) as JsonRecord | undefined;
    if (!current) return res.status(404).json({ error: "Photo not found." });
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const type = photoType(buffer, req.headers["content-type"] || "");
    if (!buffer.length || !type) return res.status(415).json({ error: "Choose a JPG, PNG, or WebP image." });
    const key = `${randomUUID()}.${type.ext}`;
    const temporary = path.join(uploadDir, `${key}.tmp`);
    writeFileSync(temporary, buffer, { flag: "wx" });
    renameSync(temporary, path.join(uploadDir, key));
    db.prepare("UPDATE profile_photos SET url=?,storage_key=?,mime=?,size=?,created_at=? WHERE id=?").run(`/uploads/${key}`, key, type.mime, buffer.length, now(), req.params.id);
    if (current.storage_key) rmSync(path.join(uploadDir, String(current.storage_key)), { force: true });
    res.json({ user: getProfile(req.userId!) });
  });
  app.delete("/api/me/photos/:id", requireUser, (req: RequestWithUser, res) => {
    const current = db.prepare("SELECT * FROM profile_photos WHERE id=? AND user_id=?").get(req.params.id, req.userId!) as JsonRecord | undefined;
    if (!current) return res.status(404).json({ error: "Photo not found." });
    const user = db.prepare("SELECT onboarding_complete FROM users WHERE id=?").get(req.userId!) as JsonRecord;
    const photoCount = Number((db.prepare("SELECT COUNT(*) AS count FROM profile_photos WHERE user_id=?").get(req.userId!) as JsonRecord).count);
    if (Boolean(user.onboarding_complete) && photoCount <= 2) return res.status(400).json({ error: "Keep at least two photos on a live profile. Replace one instead." });
    db.prepare("DELETE FROM profile_photos WHERE id=?").run(req.params.id);
    if (current.storage_key) rmSync(path.join(uploadDir, String(current.storage_key)), { force: true });
    res.status(204).end();
  });

  app.post("/api/activities/:id/interest", requireReady, (req: RequestWithUser, res) => {
    if (!db.prepare("SELECT 1 FROM activities WHERE id=?").get(req.params.id)) return res.status(404).json({ error: "Plan not found." });
    db.prepare("INSERT OR IGNORE INTO activity_interests (user_id,activity_id,created_at) VALUES (?,?,?)").run(req.userId!, req.params.id, now());
    res.status(204).end();
  });
  app.get("/api/invitations", requireReady, (req: RequestWithUser, res) => {
    const incoming = db.prepare(`SELECT i.*,u.name,u.age,p.url AS photo_url,a.name AS activity_name,a.location FROM invitations i JOIN users u ON u.id=i.sender_id JOIN activities a ON a.id=i.activity_id LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order LIMIT 1) WHERE i.receiver_id=? ORDER BY i.created_at DESC`).all(req.userId!);
    const outgoing = db.prepare(`SELECT i.*,u.name,u.age,p.url AS photo_url,a.name AS activity_name,a.location FROM invitations i JOIN users u ON u.id=i.receiver_id JOIN activities a ON a.id=i.activity_id LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order LIMIT 1) WHERE i.sender_id=? ORDER BY i.created_at DESC`).all(req.userId!);
    res.json({ incoming, outgoing });
  });
  app.post("/api/invitations", requireReady, (req: RequestWithUser, res) => {
    const receiverId = String(req.body.receiverId || "");
    const activityId = String(req.body.activityId || "");
    if (receiverId === req.userId) return res.status(400).json({ error: "Choose someone else for this plan." });
    const receiver = db.prepare(`SELECT 1 FROM activity_interests i JOIN users u ON u.id=i.user_id WHERE i.user_id=? AND i.activity_id=? AND u.onboarding_complete=1`).get(receiverId, activityId);
    if (!receiver) return res.status(400).json({ error: "That person is not down for this plan." });
    db.prepare("INSERT OR IGNORE INTO activity_interests (user_id,activity_id,created_at) VALUES (?,?,?)").run(req.userId!, activityId, now());
    const existing = db.prepare("SELECT * FROM invitations WHERE sender_id=? AND receiver_id=? AND activity_id=?").get(req.userId!, receiverId, activityId) as JsonRecord | undefined;
    if (existing) return res.json({ invitation: existing });
    const id = randomUUID();
    db.prepare("INSERT INTO invitations (id,sender_id,receiver_id,activity_id,created_at) VALUES (?,?,?,?,?)").run(id, req.userId!, receiverId, activityId, now());
    emit(receiverId, "invitation", { invitationId: id });
    res.status(201).json({ invitation: db.prepare("SELECT * FROM invitations WHERE id=?").get(id) });
  });
  app.post("/api/invitations/:id/respond", requireReady, (req: RequestWithUser, res) => {
    const action = req.body.action === "accept" ? "accepted" : req.body.action === "reject" ? "rejected" : "";
    if (!action) return res.status(400).json({ error: "Choose accept or reject." });
    const invitation = db.prepare("SELECT * FROM invitations WHERE id=? AND receiver_id=?").get(req.params.id, req.userId!) as JsonRecord | undefined;
    if (!invitation || invitation.status !== "pending") return res.status(404).json({ error: "Pending invitation not found." });
    let matchId: string | null = null;
    let conversationId: string | null = null;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE invitations SET status=?,responded_at=? WHERE id=?").run(action, now(), String(invitation.id));
      if (action === "accepted") {
        const users = [String(invitation.sender_id), String(invitation.receiver_id)].sort();
        const existing = db.prepare("SELECT id FROM matches WHERE activity_id=? AND user_low=? AND user_high=?").get(String(invitation.activity_id), users[0], users[1]) as JsonRecord | undefined;
        matchId = existing ? String(existing.id) : randomUUID();
        if (!existing) db.prepare("INSERT INTO matches (id,activity_id,user_low,user_high,invitation_id,created_at) VALUES (?,?,?,?,?,?)").run(matchId, String(invitation.activity_id), users[0], users[1], String(invitation.id), now());
        const conversation = db.prepare("SELECT id FROM conversations WHERE match_id=?").get(matchId) as JsonRecord | undefined;
        conversationId = conversation ? String(conversation.id) : randomUUID();
        if (!conversation) db.prepare("INSERT INTO conversations (id,match_id,created_at) VALUES (?,?,?)").run(conversationId, matchId, now());
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    emit(String(invitation.sender_id), "invitation-response", { invitationId: invitation.id, status: action, conversationId });
    emit(String(invitation.receiver_id), "conversation", { conversationId });
    res.json({ status: action, matchId, conversationId });
  });

  app.get("/api/conversations", requireReady, (req: RequestWithUser, res) => {
    const rows = db.prepare(`SELECT c.id,c.match_id,c.created_at,a.id AS activity_id,a.name AS activity_name,a.location,a.image_url,
      CASE WHEN m.user_low=? THEN m.user_high ELSE m.user_low END AS other_id,
      u.name AS other_name,u.age AS other_age,p.url AS other_photo,
      (SELECT content FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
      FROM conversations c JOIN matches m ON m.id=c.match_id JOIN activities a ON a.id=m.activity_id
      JOIN users u ON u.id=CASE WHEN m.user_low=? THEN m.user_high ELSE m.user_low END
      LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order LIMIT 1)
      WHERE m.user_low=? OR m.user_high=? ORDER BY COALESCE(last_message_at,c.created_at) DESC`).all(req.userId!, req.userId!, req.userId!, req.userId!);
    res.json({ conversations: rows });
  });
  app.get("/api/conversations/:id", requireReady, (req: RequestWithUser, res) => {
    const conversation = db.prepare(`SELECT c.id,c.match_id,c.created_at,m.activity_id,a.name AS activity_name,a.location,a.image_url,a.date_label,a.time_label,
      CASE WHEN m.user_low=? THEN m.user_high ELSE m.user_low END AS other_id,u.name AS other_name,u.age AS other_age,p.url AS other_photo
      FROM conversations c JOIN matches m ON m.id=c.match_id JOIN activities a ON a.id=m.activity_id
      JOIN users u ON u.id=CASE WHEN m.user_low=? THEN m.user_high ELSE m.user_low END
      LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order LIMIT 1)
      WHERE c.id=? AND (m.user_low=? OR m.user_high=?)`).get(req.userId!, req.userId!, req.params.id, req.userId!, req.userId!) as JsonRecord | undefined;
    if (!conversation) return res.status(404).json({ error: "Conversation not found." });
    const messages = db.prepare("SELECT id,sender_id,content,created_at FROM messages WHERE conversation_id=? ORDER BY created_at,id").all(req.params.id);
    const datePlan = db.prepare("SELECT * FROM date_plans WHERE match_id=?").get(String(conversation.match_id));
    res.json({ conversation, messages, datePlan: datePlan || null });
  });
  app.post("/api/conversations/:id/messages", requireReady, (req: RequestWithUser, res) => {
    const content = String(req.body.content || "").trim().slice(0, 1000);
    const nonce = String(req.body.clientNonce || randomUUID()).slice(0, 100);
    if (!content) return res.status(400).json({ error: "Write a message first." });
    const membership = db.prepare(`SELECT m.user_low,m.user_high FROM conversations c JOIN matches m ON m.id=c.match_id WHERE c.id=? AND (m.user_low=? OR m.user_high=?)`).get(req.params.id, req.userId!, req.userId!) as JsonRecord | undefined;
    if (!membership) return res.status(404).json({ error: "Conversation not found." });
    const id = randomUUID();
    try {
      db.prepare("INSERT INTO messages (id,conversation_id,sender_id,content,client_nonce,created_at) VALUES (?,?,?,?,?,?)").run(id, req.params.id, req.userId!, content, nonce, now());
    } catch (error) {
      const existing = db.prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_id=? AND client_nonce=?").get(req.params.id, req.userId!, nonce);
      if (existing) return res.json({ message: existing });
      throw error;
    }
    const message = db.prepare("SELECT id,sender_id,content,created_at FROM messages WHERE id=?").get(id) as JsonRecord;
    const otherId = membership.user_low === req.userId ? String(membership.user_high) : String(membership.user_low);
    emit(otherId, "message", { conversationId: req.params.id, message });
    emit(req.userId!, "message", { conversationId: req.params.id, message });
    res.status(201).json({ message });
  });
  app.post("/api/matches/:id/date", requireReady, (req: RequestWithUser, res) => {
    const match = db.prepare(`SELECT m.*,a.date_label,a.time_label,a.location FROM matches m JOIN activities a ON a.id=m.activity_id WHERE m.id=? AND (m.user_low=? OR m.user_high=?)`).get(req.params.id, req.userId!, req.userId!) as JsonRecord | undefined;
    if (!match) return res.status(404).json({ error: "Match not found." });
    const existing = db.prepare("SELECT * FROM date_plans WHERE match_id=?").get(req.params.id) as JsonRecord | undefined;
    if (!existing) db.prepare("INSERT INTO date_plans (id,match_id,confirmed_by,date_label,time_label,location,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), req.params.id, req.userId!, String(match.date_label), String(match.time_label), String(match.location), now());
    const otherId = match.user_low === req.userId ? String(match.user_high) : String(match.user_low);
    emit(otherId, "date-plan", { matchId: req.params.id });
    res.json({ datePlan: db.prepare("SELECT * FROM date_plans WHERE match_id=?").get(req.params.id) });
  });
  app.get("/api/events", requireReady, (req: RequestWithUser, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: ready\ndata: ${JSON.stringify({ at: now() })}\n\n`);
    const stream: Stream = { response: res, heartbeat: setInterval(() => res.write(": heartbeat\n\n"), 25000) };
    const userStreams = streams.get(req.userId!) || new Set<Stream>();
    userStreams.add(stream);
    streams.set(req.userId!, userStreams);
    req.on("close", () => {
      clearInterval(stream.heartbeat);
      userStreams.delete(stream);
      if (!userStreams.size) streams.delete(req.userId!);
    });
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found." }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof Error && "type" in error && error.type === "entity.too.large") return res.status(413).json({ error: "That photo is larger than 5 MB." });
    if (error && typeof error === "object" && "status" in error && error.status === 404) return res.status(404).json({ error: "File not found." });
    console.error(error);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  });

  return {
    app,
    db,
    dataDir,
    close() {
      for (const userStreams of streams.values()) for (const stream of userStreams) clearInterval(stream.heartbeat);
      db.close();
    },
  };
}
