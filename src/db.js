import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone_number TEXT NOT NULL UNIQUE,          -- the group's own number, E.164
  mode TEXT NOT NULL DEFAULT 'chat',          -- 'chat' | 'announce'
  suppress_emoji_only INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',        -- 'admin' | 'member'
  status TEXT NOT NULL DEFAULT 'invited',     -- 'invited' | 'active' | 'opted_out'
  muted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
  UNIQUE (group_id, phone)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,                    -- 'in' (from a member) | 'out' (from the dashboard)
  kind TEXT NOT NULL,                         -- 'message' | 'reaction' | 'command'
  body TEXT NOT NULL,
  media_urls TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
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
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_to ON deliveries(to_phone, id);
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
