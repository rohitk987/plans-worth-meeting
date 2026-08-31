export const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE, phone TEXT UNIQUE, password_hash TEXT, salt TEXT,
    name TEXT NOT NULL DEFAULT '', age INTEGER, gender TEXT NOT NULL DEFAULT '', preferences TEXT NOT NULL DEFAULT '[]',
    city TEXT NOT NULL DEFAULT 'Bangalore', vibes TEXT NOT NULL DEFAULT '[]', intent TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '',
    onboarding_complete INTEGER NOT NULL DEFAULT 0, verification_status TEXT NOT NULL DEFAULT 'unverified',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS profile_photos (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, url TEXT NOT NULL,
    storage_key TEXT, mime TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL, description TEXT NOT NULL, image_url TEXT NOT NULL,
    date_label TEXT NOT NULL, time_label TEXT NOT NULL, categories TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activity_interests (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, PRIMARY KEY (user_id, activity_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS otp_challenges (
    id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, phone TEXT NOT NULL, code_hash TEXT NOT NULL,
    purpose TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used_at TEXT, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY, sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
    responded_at TEXT, UNIQUE(sender_id, receiver_id, activity_id)
  )`,
  `CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY, activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE, user_low TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, invitation_id TEXT NOT NULL UNIQUE REFERENCES invitations(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, UNIQUE(activity_id, user_low, user_high)
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, match_id TEXT NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE, created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, content TEXT NOT NULL, client_nonce TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(conversation_id, sender_id, client_nonce)
  )`,
  `CREATE TABLE IF NOT EXISTS date_plans (
    id TEXT PRIMARY KEY, match_id TEXT NOT NULL UNIQUE REFERENCES matches(id) ON DELETE CASCADE,
    confirmed_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, date_label TEXT NOT NULL, time_label TEXT NOT NULL,
    location TEXT NOT NULL, created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_interests_activity ON activity_interests(activity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invitations_receiver ON invitations(receiver_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)`,
] as const;
