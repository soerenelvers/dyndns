import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import session from 'express-session';

export function openDatabase(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, 'dyndns.sqlite');
  const db = new DatabaseSync(file);
  chmodSync(file, 0o600);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS hosts (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      hostname TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_update TEXT
    );
    CREATE INDEX IF NOT EXISTS hosts_owner ON hosts(owner);
    CREATE TABLE IF NOT EXISTS records (
      host_id INTEGER NOT NULL REFERENCES hosts(id),
      type TEXT NOT NULL CHECK(type IN ('A','AAAA')),
      provider_id TEXT NOT NULL,
      address TEXT NOT NULL,
      PRIMARY KEY (host_id, type)
    );
    CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mock_dns (id INTEGER PRIMARY KEY, name TEXT, type TEXT, ttl INTEGER, data TEXT);
  `);
  return db;
}

export class SqliteSessionStore extends session.Store {
  constructor(db) { super(); this.db = db; }
  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?').get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (error) { callback(error); }
  }
  set(sid, data, callback = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
      this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)').run(sid, JSON.stringify(data), new Date(data.cookie.expires).getTime());
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); callback(null); }
    catch (error) { callback(error); }
  }
}
