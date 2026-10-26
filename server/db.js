import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS } from './defaults.js';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const mainDb = new DatabaseSync(path.join(DATA_DIR, 'poryadok.db'));
mainDb.exec('PRAGMA journal_mode = WAL;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  login TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('chief','cleaner')),
  pass_hash TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#8E1B33',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payouts (
  id INTEGER PRIMARY KEY,
  cleaner_id INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  cleanings_sum INTEGER NOT NULL,
  purchases_sum INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS cleanings (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  type TEXT NOT NULL DEFAULT 'regular' CHECK (type IN ('regular','general')),
  cleaner_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'unassigned',
  note TEXT,
  comment TEXT,
  decline_reason TEXT,
  pay_amount INTEGER NOT NULL DEFAULT 0,
  payout_id INTEGER REFERENCES payouts(id),
  source TEXT NOT NULL DEFAULT 'manual',
  next_checkin TEXT,
  reminded INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cleanings_date ON cleanings(date);
CREATE TABLE IF NOT EXISTS ical_links (
  uid TEXT PRIMARY KEY,
  cleaning_id INTEGER NOT NULL REFERENCES cleanings(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS checklist_items (
  id INTEGER PRIMARY KEY,
  cleaning_id INTEGER NOT NULL REFERENCES cleanings(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  position INTEGER NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT
);
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'needed' CHECK (status IN ('needed','bought','cancelled')),
  created_by INTEGER NOT NULL REFERENCES users(id),
  cleaning_id INTEGER REFERENCES cleanings(id) ON DELETE SET NULL,
  bought_by INTEGER REFERENCES users(id),
  bought_at TEXT,
  amount INTEGER,
  payout_id INTEGER REFERENCES payouts(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('breakage','forgotten','other')),
  description TEXT NOT NULL,
  cleaning_id INTEGER REFERENCES cleanings(id) ON DELETE SET NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('cleaning','problem','purchase')),
  owner_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('video','photo')),
  filename TEXT NOT NULL,
  original_name TEXT,
  mime TEXT,
  size INTEGER,
  uploaded_by INTEGER REFERENCES users(id),
  expired INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_type, owner_id);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
`;

export function createSchema(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
}
createSchema(mainDb);

// ---------- helpers ----------
// Запросы идут в рабочую базу, а внутри withDb() — в другую (так работает демо-песочница).
const dbContext = new AsyncLocalStorage();
export const currentDb = () => dbContext.getStore() || mainDb;
export const withDb = (db, fn) => dbContext.run(db, fn);

export const all = (sql, ...p) => currentDb().prepare(sql).all(...p);
export const get = (sql, ...p) => currentDb().prepare(sql).get(...p);
export const run = (sql, ...p) => currentDb().prepare(sql).run(...p);

export function tx(fn) {
  const db = currentDb();
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- settings ----------
export function getSetting(key) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? JSON.parse(row.value) : structuredClone(DEFAULT_SETTINGS[key]);
}
export function setSetting(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, JSON.stringify(value));
}

// ---------- passwords ----------
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
export function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

// ---------- seed accounts from config/accounts.json ----------
// Аккаунт создаётся, только если такого логина ещё нет; дальше пароли меняются в приложении.
// В файле можно хранить либо password, либо уже готовый pass_hash (чтобы не держать пароли в git).
export function seedAccounts() {
  const file = process.env.ACCOUNTS_FILE || path.join(ROOT, 'config', 'accounts.json');
  if (!fs.existsSync(file)) return;
  const accounts = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const a of accounts) {
    const login = a.login.trim().toLowerCase();
    if (get('SELECT id FROM users WHERE login = ?', login)) continue;
    run('INSERT INTO users(login, name, role, pass_hash, color) VALUES(?,?,?,?,?)',
      login, a.name, a.role, a.pass_hash || hashPassword(a.password), a.color || '#8E1B33');
    console.log(`Создан аккаунт: ${login} (${a.role})`);
  }
}

// ---------- date helpers (server local time, set TZ env) ----------
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => ymd(new Date());
export const nowStr = () => {
  const d = new Date();
  return `${ymd(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
