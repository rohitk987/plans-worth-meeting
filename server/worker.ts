/// <reference types="@cloudflare/workers-types" />

import { schemaStatements } from "../db/schema";
import { createOtpProvider, OtpProviderUnavailableError } from "./otp";

const COOKIE_NAME = "plans_session";
const SESSION_DAYS = 30;
const MAX_PHOTOS = 4;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const VIBES = ["Food", "Creative", "Events", "Outdoors", "Games", "Chill"];
const PBKDF2_ITERATIONS = 120_000;

type Row = Record<string, any>;
type Stream = {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: ReturnType<typeof setInterval>;
};

interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
}

const encoder = new TextEncoder();
const streams = new Map<string, Set<Stream>>();
let initialized: Promise<void> | undefined;

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

const seedActivities = [
  ["cafe-date", "Café Date", "Indiranagar", "A slow coffee, one good conversation, and nowhere else to be.", "/images/cafe.jpg", "Saturday", "6:30 PM", ["Food", "Chill"]],
  ["momo-cubbon", "Momo + Cubbon Park", "Cubbon Park", "Start with hot momos, then take the long way through the park.", "/images/cubbon.jpg", "Saturday", "5:00 PM", ["Food", "Outdoors"]],
  ["church-street", "Church Street After Dark", "Church Street", "Bookshops, bright signs, and a night that can decide where it goes.", "/images/church.jpg", "Tonight", "8:00 PM", ["Events", "Chill"]],
] as const;

const seedInterests: Record<string, string[]> = {
  "cafe-date": ["aanya", "rohan", "meera", "dev", "priya"],
  "momo-cubbon": ["aanya", "rohan", "kabir", "nisha", "arjun", "priya"],
  "church-street": ["meera", "dev", "rohan", "nisha", "kabir"],
};

const now = () => new Date().toISOString();

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

async function first<T extends Row = Row>(db: D1Database, sql: string, ...values: any[]): Promise<T | undefined> {
  return (await db.prepare(sql).bind(...values).first<T>()) || undefined;
}

async function all<T extends Row = Row>(db: D1Database, sql: string, ...values: any[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...values).all<T>()).results;
}

async function run(db: D1Database, sql: string, ...values: any[]) {
  return db.prepare(sql).bind(...values).run();
}

async function initialize(db: D1Database) {
  if (!initialized) {
    initialized = (async () => {
      await db.batch(schemaStatements.map((statement) => db.prepare(statement)));
      const stamp = now();
      const statements: D1PreparedStatement[] = [];
      for (const activity of seedActivities) {
        statements.push(db.prepare(`INSERT INTO activities (id,name,location,description,image_url,date_label,time_label,categories)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,location=excluded.location,description=excluded.description,image_url=excluded.image_url,date_label=excluded.date_label,time_label=excluded.time_label,categories=excluded.categories`)
          .bind(activity[0], activity[1], activity[2], activity[3], activity[4], activity[5], activity[6], JSON.stringify(activity[7])));
      }
      for (const user of seedUsers) {
        statements.push(db.prepare(`INSERT OR IGNORE INTO users
          (id,email,name,age,gender,preferences,city,vibes,intent,bio,onboarding_complete,verification_status,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'Bangalore',?,?,?,?,?,?,?)`).bind(
          user[0], user[1], user[2], user[3], user[4], JSON.stringify(user[5]), JSON.stringify(user[6]), user[7], user[8], 1, "verified", stamp, stamp,
        ));
        statements.push(db.prepare("INSERT OR IGNORE INTO profile_photos (id,user_id,url,mime,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?)")
          .bind(`seed-${user[0]}`, user[0], user[9], "image/jpeg", 0, 0, stamp));
      }
      for (const [activityId, userIds] of Object.entries(seedInterests)) {
        for (const userId of userIds) statements.push(db.prepare("INSERT OR IGNORE INTO activity_interests (user_id,activity_id,created_at) VALUES (?,?,?)").bind(userId, activityId, stamp));
      }
      await db.batch(statements);
    })().catch((error) => {
      initialized = undefined;
      throw error;
    });
  }
  await initialized;
}

function randomHex(bytes: number) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return [...data].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function derivePassword(password: string, salt = randomHex(16)) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  const passwordHash = [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { salt, passwordHash };
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function passwordMatches(password: string, salt: string, stored: string) {
  const actual = await derivePassword(password, salt);
  return constantTimeEqual(actual.passwordHash, stored);
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter(([key]) => key).map(([key, ...value]) => [key, decodeURIComponent(value.join("="))]));
}

function securityHeaders(headers: Headers) {
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  return headers;
}

function json(data: unknown, status = 200, headers = new Headers()) {
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers: securityHeaders(headers) });
}

function empty(status = 204, headers = new Headers()) {
  return new Response(null, { status, headers: securityHeaders(headers) });
}

async function readBody(request: Request) {
  try {
    return (await request.json()) as Row;
  } catch {
    return {};
  }
}

async function currentUserId(db: D1Database, request: Request) {
  const token = parseCookies(request.headers.get("Cookie") || "")[COOKIE_NAME];
  if (!token) return undefined;
  const row = await first(db, "SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?", await sha256(token), now());
  return row?.user_id as string | undefined;
}

async function userIsReady(db: D1Database, userId: string | undefined) {
  if (!userId) return false;
  const row = await first(db, "SELECT onboarding_complete FROM users WHERE id=?", userId);
  return Boolean(row?.onboarding_complete);
}

function requireUser(userId: string | undefined) {
  return userId ? null : json({ error: "Please log in to continue." }, 401);
}

function requireReady(userId: string | undefined, ready: boolean) {
  if (!userId) return json({ error: "Please log in to continue." }, 401);
  return ready ? null : json({ error: "Finish setting up your profile first." }, 403);
}

async function createSession(db: D1Database, userId: string, request: Request) {
  const token = randomHex(32);
  const created = now();
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await run(db, "INSERT INTO sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)", await sha256(token), userId, expires, created);
  const secure = new URL(request.url).protocol === "https:";
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:";
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

async function getProfile(db: D1Database, userId: string) {
  const row = await first(db, "SELECT * FROM users WHERE id=?", userId);
  if (!row) return null;
  const photos = await all(db, "SELECT * FROM profile_photos WHERE user_id=? ORDER BY sort_order,created_at", userId);
  return {
    id: row.id,
    email: row.email || null,
    phone: row.phone || null,
    name: row.name || "",
    age: row.age || null,
    gender: row.gender || "",
    preferences: parseJson<string[]>(row.preferences, []),
    city: row.city || "Bangalore",
    vibes: parseJson<string[]>(row.vibes, []),
    intent: row.intent || "",
    bio: row.bio || "",
    onboardingComplete: Boolean(row.onboarding_complete),
    verificationStatus: row.verification_status || "unverified",
    createdAt: row.created_at,
    photos: photos.map((photo) => ({ id: photo.id, url: photo.url, mime: photo.mime, size: photo.size, sortOrder: photo.sort_order })),
  };
}

async function getPublicProfile(db: D1Database, userId: string) {
  const profile = await getProfile(db, userId);
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

function emit(userId: string, event: string, data: Row = {}) {
  const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const stream of streams.get(userId) || []) {
    try {
      stream.controller.enqueue(chunk);
    } catch {
      clearInterval(stream.heartbeat);
      streams.get(userId)?.delete(stream);
    }
  }
}

function photoType(bytes: Uint8Array, contentType: string) {
  const normalized = contentType.toLowerCase().split(";")[0];
  const options = [
    { mime: "image/jpeg", ext: "jpg", ok: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    { mime: "image/png", ext: "png", ok: bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index]) },
    { mime: "image/webp", ext: "webp", ok: new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP" },
  ];
  return options.find((option) => option.ok && option.mime === normalized) || null;
}

async function activitiesResponse(db: D1Database, viewerId: string | undefined) {
  const viewer = viewerId || "";
  const rows = await all(db, `SELECT a.*, COUNT(iu.id) AS interested_count FROM activities a
    LEFT JOIN activity_interests i ON i.activity_id=a.id AND i.user_id<>?
    LEFT JOIN users iu ON iu.id=i.user_id AND iu.onboarding_complete=1
    GROUP BY a.id ORDER BY CASE a.id WHEN 'cafe-date' THEN 1 WHEN 'momo-cubbon' THEN 2 ELSE 3 END`, viewer);
  const activities = [];
  for (const row of rows) {
    const people = await all(db, `SELECT u.id,u.name,p.url FROM activity_interests i JOIN users u ON u.id=i.user_id
      LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order,created_at LIMIT 1)
      WHERE i.activity_id=? AND i.user_id<>? AND u.onboarding_complete=1 ORDER BY i.created_at LIMIT 4`, row.id, viewer);
    const viewerInterested = Boolean(viewerId && await first(db, "SELECT 1 AS found FROM activity_interests WHERE user_id=? AND activity_id=?", viewerId, row.id));
    activities.push({ ...row, categories: parseJson(row.categories, []), interestedCount: Number(row.interested_count), viewerInterested, people });
  }
  return json({ activities });
}

async function singleActivityResponse(db: D1Database, activityId: string, viewerId: string | undefined) {
  const row = await first(db, `SELECT a.*, COUNT(iu.id) AS interested_count FROM activities a
    LEFT JOIN activity_interests i ON i.activity_id=a.id AND i.user_id<>?
    LEFT JOIN users iu ON iu.id=i.user_id AND iu.onboarding_complete=1
    WHERE a.id=? GROUP BY a.id`, viewerId || "", activityId);
  if (!row) return json({ error: "Plan not found." }, 404);
  const viewerInterested = Boolean(viewerId && await first(db, "SELECT 1 AS found FROM activity_interests WHERE user_id=? AND activity_id=?", viewerId, activityId));
  return json({ activity: { ...row, categories: parseJson(row.categories, []), interestedCount: Number(row.interested_count), viewerInterested } });
}

async function handlePhotoUpload(request: Request, env: Env, userId: string, replaceId?: string) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_PHOTO_BYTES) return json({ error: "That photo is larger than 5 MB." }, 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_PHOTO_BYTES) return json({ error: "That photo is larger than 5 MB." }, 413);
  const type = photoType(bytes, request.headers.get("Content-Type") || "");
  if (!bytes.byteLength || !type) return json({ error: "Choose a JPG, PNG, or WebP image." }, 415);

  let current: Row | undefined;
  let sortOrder = 0;
  if (replaceId) {
    current = await first(env.DB, "SELECT * FROM profile_photos WHERE id=? AND user_id=?", replaceId, userId);
    if (!current) return json({ error: "Photo not found." }, 404);
    sortOrder = Number(current.sort_order);
  } else {
    const count = Number((await first(env.DB, "SELECT COUNT(*) AS count FROM profile_photos WHERE user_id=?", userId))?.count || 0);
    if (count >= MAX_PHOTOS) return json({ error: `You can add up to ${MAX_PHOTOS} photos.` }, 400);
    sortOrder = count;
  }

  const key = `${crypto.randomUUID()}.${type.ext}`;
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: type.mime, cacheControl: "public, max-age=31536000, immutable" } });
  try {
    if (replaceId) {
      await run(env.DB, "UPDATE profile_photos SET url=?,storage_key=?,mime=?,size=?,sort_order=?,created_at=? WHERE id=? AND user_id=?", `/uploads/${key}`, key, type.mime, bytes.byteLength, sortOrder, now(), replaceId, userId);
      if (current?.storage_key) await env.FILES.delete(String(current.storage_key));
    } else {
      await run(env.DB, "INSERT INTO profile_photos (id,user_id,url,storage_key,mime,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)", crypto.randomUUID(), userId, `/uploads/${key}`, key, type.mime, bytes.byteLength, sortOrder, now());
    }
  } catch (error) {
    await env.FILES.delete(key);
    throw error;
  }
  return json({ user: await getProfile(env.DB, userId) }, replaceId ? 200 : 201);
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  await initialize(env.DB);
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();
  const userId = await currentUserId(env.DB, request);
  const ready = await userIsReady(env.DB, userId);

  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return json({ error: "Cross-site request blocked." }, 403);
  }

  if (pathname === "/api/health" && method === "GET") return json({ ok: true });
  if (pathname === "/api/activities" && method === "GET") return activitiesResponse(env.DB, userId);

  let match = pathname.match(/^\/api\/activities\/([^/]+)$/);
  if (match && method === "GET") return singleActivityResponse(env.DB, decodeURIComponent(match[1]), userId);

  match = pathname.match(/^\/api\/activities\/([^/]+)\/people$/);
  if (match && method === "GET") {
    const people = await all(env.DB, `SELECT u.id,u.name,u.age,u.city,u.vibes,u.bio,p.url AS photo_url FROM activity_interests i
      JOIN users u ON u.id=i.user_id LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order,created_at LIMIT 1)
      WHERE i.activity_id=? AND i.user_id<>? AND u.onboarding_complete=1 ORDER BY i.created_at`, decodeURIComponent(match[1]), userId || "");
    return json({ people: people.map((person) => ({ ...person, vibes: parseJson(person.vibes, []) })) });
  }

  if (pathname === "/api/me" && method === "GET") return json({ user: userId ? await getProfile(env.DB, userId) : null });

  match = pathname.match(/^\/api\/profiles\/([^/]+)$/);
  if (match && method === "GET") {
    const auth = requireReady(userId, ready); if (auth) return auth;
    const profile = await getPublicProfile(env.DB, decodeURIComponent(match[1]));
    if (!profile?.onboardingComplete) return json({ error: "Profile not found." }, 404);
    return json({ profile });
  }

  if (pathname === "/api/auth/register" && method === "POST") {
    const body = await readBody(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
    if (password.length < 8) return json({ error: "Use at least 8 characters for your password." }, 400);
    if (await first(env.DB, "SELECT 1 AS found FROM users WHERE email=?", email)) return json({ error: "An account already exists for this email." }, 409);
    const id = crypto.randomUUID();
    const credentials = await derivePassword(password);
    const stamp = now();
    await run(env.DB, "INSERT INTO users (id,email,password_hash,salt,created_at,updated_at) VALUES (?,?,?,?,?,?)", id, email, credentials.passwordHash, credentials.salt, stamp, stamp);
    const headers = new Headers({ "Set-Cookie": await createSession(env.DB, id, request) });
    return json({ user: await getProfile(env.DB, id) }, 201, headers);
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const body = await readBody(request);
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const row = await first(env.DB, "SELECT * FROM users WHERE email=?", email);
    if (!row?.password_hash || !row.salt || !(await passwordMatches(password, String(row.salt), String(row.password_hash)))) return json({ error: "Email or password is incorrect." }, 401);
    const headers = new Headers({ "Set-Cookie": await createSession(env.DB, String(row.id), request) });
    return json({ user: await getProfile(env.DB, String(row.id)) }, 200, headers);
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = parseCookies(request.headers.get("Cookie") || "")[COOKIE_NAME];
    if (token) await run(env.DB, "DELETE FROM sessions WHERE token_hash=?", await sha256(token));
    const headers = new Headers({ "Set-Cookie": clearSessionCookie(request) });
    return empty(204, headers);
  }

  if (pathname === "/api/auth/google" && method === "POST") return json({ error: "Google sign-in is not configured yet. Use email or the development phone flow." }, 501);

  if (pathname === "/api/auth/otp/request" && method === "POST") {
    const body = await readBody(request);
    const phone = String(body.phone || "").replace(/\s|-/g, "");
    const purpose = body.purpose === "safety" ? "safety" : "login";
    if (!/^\+91[6-9]\d{9}$/.test(phone)) return json({ error: "Enter an Indian number in +91 format." }, 400);
    if (purpose === "safety" && !userId) return json({ error: "Please log in first." }, 401);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    let delivery;
    try {
      delivery = createOtpProvider({ development: local, developmentCode: "246810" }).issue(phone, purpose);
    } catch (error) {
      if (error instanceof OtpProviderUnavailableError) return json({ error: error.message }, 503);
      throw error;
    }
    await run(env.DB, "DELETE FROM otp_challenges WHERE phone=? AND purpose=? AND used_at IS NULL", phone, purpose);
    await run(env.DB, "INSERT INTO otp_challenges (id,user_id,phone,code_hash,purpose,expires_at,created_at) VALUES (?,?,?,?,?,?,?)", crypto.randomUUID(), userId || null, phone, await sha256(delivery.verificationCode), purpose, new Date(Date.now() + 600_000).toISOString(), now());
    return json(delivery.response);
  }

  if (pathname === "/api/auth/otp/verify" && method === "POST") {
    const body = await readBody(request);
    const phone = String(body.phone || "").replace(/\s|-/g, "");
    const code = String(body.code || "");
    const purpose = body.purpose === "safety" ? "safety" : "login";
    const challenge = await first(env.DB, "SELECT * FROM otp_challenges WHERE phone=? AND purpose=? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1", phone, purpose);
    if (!challenge || String(challenge.expires_at) <= now()) return json({ error: "That code has expired. Request a new one." }, 400);
    await run(env.DB, "UPDATE otp_challenges SET attempts=attempts+1 WHERE id=?", challenge.id);
    if (Number(challenge.attempts) >= 5 || !constantTimeEqual(await sha256(code), String(challenge.code_hash))) return json({ error: "That code is not correct." }, 400);
    await run(env.DB, "UPDATE otp_challenges SET used_at=? WHERE id=?", now(), challenge.id);
    if (purpose === "safety") {
      if (!userId || challenge.user_id !== userId) return json({ error: "Please request a new code." }, 401);
      try {
        await run(env.DB, "UPDATE users SET phone=?,verification_status='verified',updated_at=? WHERE id=?", phone, now(), userId);
      } catch {
        return json({ error: "That phone number is already attached to another account." }, 409);
      }
      return json({ user: await getProfile(env.DB, userId) });
    }
    let user = await first(env.DB, "SELECT id FROM users WHERE phone=?", phone);
    if (!user) {
      const id = crypto.randomUUID();
      const stamp = now();
      await run(env.DB, "INSERT INTO users (id,phone,verification_status,created_at,updated_at) VALUES (?,?,'verified',?,?)", id, phone, stamp, stamp);
      user = { id };
    }
    const headers = new Headers({ "Set-Cookie": await createSession(env.DB, String(user.id), request) });
    return json({ user: await getProfile(env.DB, String(user.id)) }, 200, headers);
  }

  if (pathname === "/api/me" && method === "PATCH") {
    const auth = requireUser(userId); if (auth) return auth;
    const body = await readBody(request);
    const name = String(body.name || "").trim().slice(0, 60);
    const age = Number(body.age);
    const gender = String(body.gender || "").slice(0, 40);
    const preferences = Array.isArray(body.preferences) ? [...new Set(body.preferences.map(String))].slice(0, 4) : [];
    const vibes = Array.isArray(body.vibes) ? [...new Set<string>(body.vibes.map(String).filter((vibe: string) => VIBES.includes(vibe)))].slice(0, 4) : [];
    const intent = String(body.intent || "").slice(0, 80);
    const bio = String(body.bio || "").trim().slice(0, 180);
    if (!name || age < 18 || age > 80) return json({ error: "Add your name and a valid age." }, 400);
    if (!gender || preferences.length === 0 || !intent) return json({ error: "Complete the gender, preference, and dating intention fields." }, 400);
    if (ready && vibes.length < 2) return json({ error: "Keep at least two vibes on a live profile." }, 400);
    await run(env.DB, "UPDATE users SET name=?,age=?,gender=?,preferences=?,city='Bangalore',vibes=?,intent=?,bio=?,updated_at=? WHERE id=?", name, age, gender, JSON.stringify(preferences), JSON.stringify(vibes), intent, bio, now(), userId);
    return json({ user: await getProfile(env.DB, userId!) });
  }

  if (pathname === "/api/me/complete" && method === "POST") {
    const auth = requireUser(userId); if (auth) return auth;
    const user = await getProfile(env.DB, userId!);
    if (!user?.name || !user.age || !user.gender || !user.intent || user.preferences.length === 0) return json({ error: "Finish your profile details first." }, 400);
    if (user.photos.length < 2) return json({ error: "Add at least two photos." }, 400);
    if (user.vibes.length < 2) return json({ error: "Choose at least two vibes." }, 400);
    if (user.verificationStatus !== "verified") return json({ error: "Verify your phone to finish." }, 400);
    await run(env.DB, "UPDATE users SET onboarding_complete=1,updated_at=? WHERE id=?", now(), userId);
    return json({ user: await getProfile(env.DB, userId!) });
  }

  if (pathname === "/api/me/photos" && method === "POST") {
    const auth = requireUser(userId); if (auth) return auth;
    return handlePhotoUpload(request, env, userId!);
  }

  match = pathname.match(/^\/api\/me\/photos\/([^/]+)$/);
  if (match && method === "PUT") {
    const auth = requireUser(userId); if (auth) return auth;
    return handlePhotoUpload(request, env, userId!, decodeURIComponent(match[1]));
  }
  if (match && method === "DELETE") {
    const auth = requireUser(userId); if (auth) return auth;
    const photoId = decodeURIComponent(match[1]);
    const current = await first(env.DB, "SELECT * FROM profile_photos WHERE id=? AND user_id=?", photoId, userId);
    if (!current) return json({ error: "Photo not found." }, 404);
    const count = Number((await first(env.DB, "SELECT COUNT(*) AS count FROM profile_photos WHERE user_id=?", userId))?.count || 0);
    if (ready && count <= 2) return json({ error: "Keep at least two photos on a live profile. Replace one instead." }, 400);
    await run(env.DB, "DELETE FROM profile_photos WHERE id=?", photoId);
    if (current.storage_key) await env.FILES.delete(String(current.storage_key));
    return empty();
  }

  match = pathname.match(/^\/api\/activities\/([^/]+)\/interest$/);
  if (match && method === "POST") {
    const auth = requireReady(userId, ready); if (auth) return auth;
    const activityId = decodeURIComponent(match[1]);
    if (!(await first(env.DB, "SELECT 1 AS found FROM activities WHERE id=?", activityId))) return json({ error: "Plan not found." }, 404);
    await run(env.DB, "INSERT OR IGNORE INTO activity_interests (user_id,activity_id,created_at) VALUES (?,?,?)", userId, activityId, now());
    return empty();
  }

  if (pathname === "/api/invitations" && method === "GET") {
    const auth = requireReady(userId, ready); if (auth) return auth;
    const incoming = await all(env.DB, `SELECT i.*,u.name,u.age,p.url AS photo_url,a.name AS activity_name,a.location FROM invitations i
      JOIN users u ON u.id=i.sender_id JOIN activities a ON a.id=i.activity_id
      LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order LIMIT 1)
      WHERE i.receiver_id=? ORDER BY i.created_at DESC`, userId);
    const outgoing = await all(env.DB, `SELECT i.*,u.name,u.age,p.url AS photo_url,a.name AS activity_name,a.location FROM invitations i
      JOIN users u ON u.id=i.receiver_id JOIN activities a ON a.id=i.activity_id
      LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order LIMIT 1)
      WHERE i.sender_id=? ORDER BY i.created_at DESC`, userId);
    return json({ incoming, outgoing });
  }

  if (pathname === "/api/invitations" && method === "POST") {
    const auth = requireReady(userId, ready); if (auth) return auth;
    const body = await readBody(request);
    const receiverId = String(body.receiverId || "");
    const activityId = String(body.activityId || "");
    if (receiverId === userId) return json({ error: "Choose someone else for this plan." }, 400);
    const receiver = await first(env.DB, `SELECT 1 AS found FROM activity_interests i JOIN users u ON u.id=i.user_id
      WHERE i.user_id=? AND i.activity_id=? AND u.onboarding_complete=1`, receiverId, activityId);
    if (!receiver) return json({ error: "That person is not down for this plan." }, 400);
    await run(env.DB, "INSERT OR IGNORE INTO activity_interests (user_id,activity_id,created_at) VALUES (?,?,?)", userId, activityId, now());
    const existing = await first(env.DB, "SELECT * FROM invitations WHERE sender_id=? AND receiver_id=? AND activity_id=?", userId, receiverId, activityId);
    if (existing) return json({ invitation: existing });
    const id = crypto.randomUUID();
    await run(env.DB, "INSERT INTO invitations (id,sender_id,receiver_id,activity_id,created_at) VALUES (?,?,?,?,?)", id, userId, receiverId, activityId, now());
    emit(receiverId, "invitation", { invitationId: id });
    return json({ invitation: await first(env.DB, "SELECT * FROM invitations WHERE id=?", id) }, 201);
  }

  match = pathname.match(/^\/api\/invitations\/([^/]+)\/respond$/);
  if (match && method === "POST") {
    const auth = requireReady(userId, ready); if (auth) return auth;
    const body = await readBody(request);
    const action = body.action === "accept" ? "accepted" : body.action === "reject" ? "rejected" : "";
    if (!action) return json({ error: "Choose accept or reject." }, 400);
    const invitation = await first(env.DB, "SELECT * FROM invitations WHERE id=? AND receiver_id=?", decodeURIComponent(match[1]), userId);
    if (!invitation || invitation.status !== "pending") return json({ error: "Pending invitation not found." }, 404);
    const updated = await run(env.DB, "UPDATE invitations SET status=?,responded_at=? WHERE id=? AND status='pending'", action, now(), invitation.id);
    if (!updated.meta.changes) return json({ error: "Pending invitation not found." }, 404);
    let matchId: string | null = null;
    let conversationId: string | null = null;
    if (action === "accepted") {
      const users = [String(invitation.sender_id), String(invitation.receiver_id)].sort();
      const existingMatch = await first(env.DB, "SELECT id FROM matches WHERE activity_id=? AND user_low=? AND user_high=?", invitation.activity_id, users[0], users[1]);
      matchId = existingMatch ? String(existingMatch.id) : crypto.randomUUID();
      if (!existingMatch) await run(env.DB, "INSERT INTO matches (id,activity_id,user_low,user_high,invitation_id,created_at) VALUES (?,?,?,?,?,?)", matchId, invitation.activity_id, users[0], users[1], invitation.id, now());
      const conversation = await first(env.DB, "SELECT id FROM conversations WHERE match_id=?", matchId);
      conversationId = conversation ? String(conversation.id) : crypto.randomUUID();
      if (!conversation) await run(env.DB, "INSERT INTO conversations (id,match_id,created_at) VALUES (?,?,?)", conversationId, matchId, now());
    }
    emit(String(invitation.sender_id), "invitation-response", { invitationId: invitation.id, status: action, conversationId });
    emit(String(invitation.receiver_id), "conversation", { conversationId });
    return json({ status: action, matchId, conversationId });
  }

  if (pathname === "/api/conversations" && method === "GET") {
    const auth = requireReady(userId, ready); if (auth) return auth;
    const conversations = await all(env.DB, `SELECT c.id,c.match_id,c.created_at,a.id AS activity_id,a.name AS activity_name,a.location,a.image_url,
      CASE WHEN m.user_low=? THEN m.user_high ELSE m.user_low END AS other_id,
      u.name AS other_name,u.age AS other_age,p.url AS other_photo,
      (SELECT content FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE conversation_id=c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
      FROM conversations c JOIN matches m ON m.id=c.match_id JOIN activities a ON a.id=m.activity_id
      JOIN users u ON u.id=CASE WHEN m.user_low=? THEN m.user_high ELSE m.user_low END
      LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order LIMIT 1)
      WHERE m.user_low=? OR m.user_high=? ORDER BY COALESCE(last_message_at,c.created_at) DESC`, userId, userId, userId, userId);
    return json({ conversations });
  }

  match = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (match && method === "GET") {
    const auth = requireReady(userId, ready); if (auth) return auth;
    const conversationId = decodeURIComponent(match[1]);
    const conversation = await first(env.DB, `SELECT c.id,c.match_id,c.created_at,m.activity_id,a.name AS activity_name,a.location,a.image_url,a.date_label,a.time_label,
      CASE WHEN m.user_low=? THEN m.user_high ELSE m.user_low END AS other_id,u.name AS other_name,u.age AS other_age,p.url AS other_photo
      FROM conversations c JOIN matches m ON m.id=c.match_id JOIN activities a ON a.id=m.activity_id
      JOIN users u ON u.id=CASE WHEN m.user_low=? THEN m.user_high ELSE m.user_low END
      LEFT JOIN profile_photos p ON p.id=(SELECT id FROM profile_photos WHERE user_id=u.id ORDER BY sort_order LIMIT 1)
      WHERE c.id=? AND (m.user_low=? OR m.user_high=?)`, userId, userId, conversationId, userId, userId);
    if (!conversation) return json({ error: "Conversation not found." }, 404);
    const messages = await all(env.DB, "SELECT id,sender_id,content,created_at FROM messages WHERE conversation_id=? ORDER BY created_at,id", conversationId);
    const datePlan = await first(env.DB, "SELECT * FROM date_plans WHERE match_id=?", conversation.match_id);
    return json({ conversation, messages, datePlan: datePlan || null });
  }

  match = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (match && method === "POST") {
    const auth = requireReady(userId, ready); if (auth) return auth;
    const conversationId = decodeURIComponent(match[1]);
    const body = await readBody(request);
    const content = String(body.content || "").trim().slice(0, 1000);
    const nonce = String(body.clientNonce || crypto.randomUUID()).slice(0, 100);
    if (!content) return json({ error: "Write a message first." }, 400);
    const membership = await first(env.DB, `SELECT m.user_low,m.user_high FROM conversations c JOIN matches m ON m.id=c.match_id
      WHERE c.id=? AND (m.user_low=? OR m.user_high=?)`, conversationId, userId, userId);
    if (!membership) return json({ error: "Conversation not found." }, 404);
    const id = crypto.randomUUID();
    try {
      await run(env.DB, "INSERT INTO messages (id,conversation_id,sender_id,content,client_nonce,created_at) VALUES (?,?,?,?,?,?)", id, conversationId, userId, content, nonce, now());
    } catch (error) {
      const existing = await first(env.DB, "SELECT id,sender_id,content,created_at FROM messages WHERE conversation_id=? AND sender_id=? AND client_nonce=?", conversationId, userId, nonce);
      if (existing) return json({ message: existing });
      throw error;
    }
    const message = await first(env.DB, "SELECT id,sender_id,content,created_at FROM messages WHERE id=?", id);
    const otherId = membership.user_low === userId ? String(membership.user_high) : String(membership.user_low);
    emit(otherId, "message", { conversationId, message });
    emit(userId!, "message", { conversationId, message });
    return json({ message }, 201);
  }

  match = pathname.match(/^\/api\/matches\/([^/]+)\/date$/);
  if (match && method === "POST") {
    const auth = requireReady(userId, ready); if (auth) return auth;
    const matchId = decodeURIComponent(match[1]);
    const matched = await first(env.DB, `SELECT m.*,a.date_label,a.time_label,a.location FROM matches m JOIN activities a ON a.id=m.activity_id
      WHERE m.id=? AND (m.user_low=? OR m.user_high=?)`, matchId, userId, userId);
    if (!matched) return json({ error: "Match not found." }, 404);
    const existing = await first(env.DB, "SELECT * FROM date_plans WHERE match_id=?", matchId);
    if (!existing) await run(env.DB, "INSERT INTO date_plans (id,match_id,confirmed_by,date_label,time_label,location,created_at) VALUES (?,?,?,?,?,?,?)", crypto.randomUUID(), matchId, userId, matched.date_label, matched.time_label, matched.location, now());
    const otherId = matched.user_low === userId ? String(matched.user_high) : String(matched.user_low);
    emit(otherId, "date-plan", { matchId });
    return json({ datePlan: await first(env.DB, "SELECT * FROM date_plans WHERE match_id=?", matchId) });
  }

  if (pathname === "/api/events" && method === "GET") {
    const auth = requireReady(userId, ready); if (auth) return auth;
    let stream: Stream;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({ at: now() })}\n\n`));
        stream = { controller, heartbeat: setInterval(() => {
          try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { clearInterval(stream.heartbeat); }
        }, 25_000) };
        const userStreams = streams.get(userId!) || new Set<Stream>();
        userStreams.add(stream);
        streams.set(userId!, userStreams);
        request.signal.addEventListener("abort", () => {
          clearInterval(stream.heartbeat);
          userStreams.delete(stream);
          if (!userStreams.size) streams.delete(userId!);
          try { controller.close(); } catch { /* already closed */ }
        }, { once: true });
      },
      cancel() {
        if (stream) clearInterval(stream.heartbeat);
        streams.get(userId!)?.delete(stream);
      },
    });
    const headers = securityHeaders(new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    }));
    return new Response(body, { headers });
  }

  return json({ error: "API route not found." }, 404);
}

async function handleUpload(request: Request, env: Env) {
  const key = decodeURIComponent(new URL(request.url).pathname.replace(/^\/uploads\//, ""));
  if (!key || key.includes("/")) return json({ error: "File not found." }, 404);
  const object = await env.FILES.get(key);
  if (!object) return json({ error: "File not found." }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers: securityHeaders(headers) });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith("/api/")) return await handleApi(request, env);
      if (pathname.startsWith("/uploads/")) return await handleUpload(request, env);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ error: "Something went wrong. Please try again." }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
