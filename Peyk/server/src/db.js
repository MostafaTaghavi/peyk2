// Tiny async DB adapter. Same SQL (with ? placeholders) runs on SQLite (dev / single
// server) and PostgreSQL (production / multi server).
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function schema(dialect) {
  const pg = dialect === 'pg';
  const T = pg ? 'BIGINT' : 'INTEGER';
  const AUTO = pg ? 'BIGSERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  return [
    `CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY, phone TEXT UNIQUE NOT NULL, name TEXT NOT NULL DEFAULT '',
      about TEXT NOT NULL DEFAULT '', avatar TEXT, last_seen ${T}, created_at ${T} NOT NULL,
      ev_seq ${T} NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS otps(
      phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at ${T} NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, sent_at ${T} NOT NULL,
      hour_start ${T} NOT NULL, hour_count INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS devices(
      user_id TEXT NOT NULL, id TEXT NOT NULL, push_token TEXT, platform TEXT,
      acked_seq ${T} NOT NULL DEFAULT 0, created_at ${T} NOT NULL, PRIMARY KEY(user_id, id))`,
    `CREATE TABLE IF NOT EXISTS contacts(
      user_id TEXT NOT NULL, contact_id TEXT NOT NULL, alias TEXT, PRIMARY KEY(user_id, contact_id))`,
    `CREATE TABLE IF NOT EXISTS chats(
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT, avatar TEXT, created_by TEXT,
      direct_key TEXT UNIQUE, created_at ${T} NOT NULL, updated_at ${T} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS chat_members(
      chat_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      joined_at ${T} NOT NULL, left_at ${T},
      last_delivered_seq ${T} NOT NULL DEFAULT 0, last_read_seq ${T} NOT NULL DEFAULT 0,
      PRIMARY KEY(chat_id, user_id))`,
    `CREATE INDEX IF NOT EXISTS cm_user ON chat_members(user_id)`,
    `CREATE TABLE IF NOT EXISTS messages(
      seq ${AUTO}, id TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      client_id TEXT, type TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', media TEXT,
      reply_to TEXT, reply_snapshot TEXT, forwarded_from TEXT,
      created_at ${T} NOT NULL, edited_at ${T}, deleted_at ${T},
      UNIQUE(sender_id, client_id))`,
    `CREATE INDEX IF NOT EXISTS msg_chat ON messages(chat_id, seq)`,
    // Per-user ordered event log = the "offline queue". Contiguous seq per user.
    `CREATE TABLE IF NOT EXISTS user_events(
      user_id TEXT NOT NULL, seq ${T} NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
      created_at ${T} NOT NULL, PRIMARY KEY(user_id, seq))`,
    `CREATE TABLE IF NOT EXISTS pending_pushes(
      id ${AUTO}, user_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_seq ${T} NOT NULL,
      due_at ${T} NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, sent_at ${T})`,
    `CREATE INDEX IF NOT EXISTS pp_due ON pending_pushes(state, due_at)`,
    `CREATE INDEX IF NOT EXISTS pp_user ON pending_pushes(user_id, chat_id, state)`,
  ];
}

function sqliteAdapter(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  d.pragma('busy_timeout = 5000');
  for (const s of schema('sqlite')) d.exec(s);

  const direct = {
    dialect: 'sqlite',
    async get(sql, p = []) { return d.prepare(sql).get(...p); },
    async all(sql, p = []) { return d.prepare(sql).all(...p); },
    async run(sql, p = []) { return { changes: d.prepare(sql).run(...p).changes }; },
  };
  // Every non-transaction call waits for the running transaction (single connection).
  let gate = Promise.resolve();
  const guarded = (fn) => async (...a) => { await gate; return fn(...a); };
  return {
    dialect: 'sqlite',
    get: guarded(direct.get), all: guarded(direct.all), run: guarded(direct.run),
    async tx(fn) {
      const prev = gate;
      let release;
      gate = new Promise((r) => (release = r));
      await prev;
      try {
        d.exec('BEGIN IMMEDIATE');
        const r = await fn(direct);
        d.exec('COMMIT');
        return r;
      } catch (e) {
        try { d.exec('ROLLBACK'); } catch {}
        throw e;
      } finally { release(); }
    },
    async close() { await gate; d.close(); },
  };
}

async function pgAdapter(url) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  const conv = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  const mk = (q) => ({
    dialect: 'pg',
    async get(sql, p = []) { return (await q.query(conv(sql), p)).rows[0]; },
    async all(sql, p = []) { return (await q.query(conv(sql), p)).rows; },
    async run(sql, p = []) { return { changes: (await q.query(conv(sql), p)).rowCount }; },
  });
  for (const s of schema('pg')) await pool.query(s);
  return {
    ...mk(pool),
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const r = await fn(mk(c));
        await c.query('COMMIT');
        return r;
      } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    },
    async close() { await pool.end(); },
  };
}

export async function createDb(cfg) {
  return cfg.databaseUrl ? pgAdapter(cfg.databaseUrl) : sqliteAdapter(cfg.sqlitePath);
}
