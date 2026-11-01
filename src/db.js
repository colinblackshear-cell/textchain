import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const NOW = "(strftime('%Y-%m-%d %H:%M:%f', 'now'))";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number TEXT UNIQUE,                   -- the group's own SMS number (E.164); NULL = web only, no texting
  join_code TEXT NOT NULL UNIQUE,             -- shareable join link: /join/<code>
  mode TEXT NOT NULL DEFAULT 'chat',          -- 'chat' | 'announce'
  sms_backup TEXT NOT NULL DEFAULT 'announcements', -- who gets texted when they don't use the web app: 'announcements' | 'all' | 'off'
  suppress_emoji_only INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,                                 -- optional for web-only members
  token TEXT NOT NULL UNIQUE,                 -- secret in the member's personal link: /m/<token>
  role TEXT NOT NULL DEFAULT 'member',        -- 'admin' | 'member'
  status TEXT NOT NULL DEFAULT 'invited',     -- 'invited' | 'active'
  sms_ok INTEGER NOT NULL DEFAULT 0,          -- agreed to texts and hasn't replied STOP
  muted INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (group_id, phone)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,                    -- 'in' (from a member) | 'out' (from the dashboard)
  via TEXT NOT NULL DEFAULT 'sms',            -- 'sms' | 'web' | 'dashboard'
  kind TEXT NOT NULL,                         -- 'message' | 'reaction' | 'command'
  audience TEXT NOT NULL DEFAULT 'all',       -- 'all' | 'admins'
  body TEXT NOT NULL,
  media_urls TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS reactions (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE (message_id, member_id, emoji)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  to_phone TEXT NOT NULL,
  from_phone TEXT NOT NULL,
  body TEXT NOT NULL,
  media_urls TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'queued',      -- 'queued' | 'sent' | 'failed'
  provider_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_to ON deliveries(to_phone, id);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id);
`;

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

/** Normalise a phone number to E.164. Bare 10-digit numbers are treated as US. */
export function normalizePhone(input) {
  const raw = String(input || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

/** URL-safe random id. 16 bytes for member tokens, fewer for join codes. */
export function randomId(bytes = 16) {
  return randomBytes(bytes).toString('base64url');
}
