// Local persistence (SQLite) => the app opens instantly and works offline.
import * as SQLite from 'expo-sqlite';
import type { Chat, Message } from './types';

let db: SQLite.SQLiteDatabase;

export async function openDb() {
  db = await SQLite.openDatabaseAsync('peyk.db');
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, client_id TEXT, created_at INTEGER NOT NULL,
      hidden INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS msg_chat_time ON messages(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS msg_client ON messages(client_id);
    CREATE TABLE IF NOT EXISTS outbox (client_id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
}

export async function kvGet(k: string): Promise<string | null> {
  const r = await db.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', [k]);
  return r?.v ?? null;
}
export const kvSet = (k: string, v: string) =>
  db.runAsync('INSERT INTO kv(k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, v]);

export async function saveChat(c: Chat) {
  await db.runAsync('INSERT INTO chats(id, json) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json', [c.id, JSON.stringify(c)]);
}
export async function saveChats(cs: Chat[]) {
  await db.withTransactionAsync(async () => { for (const c of cs) await saveChat(c); });
}
export async function deleteChat(id: string) {
  await db.runAsync('DELETE FROM chats WHERE id = ?', [id]);
  await db.runAsync('DELETE FROM messages WHERE chat_id = ?', [id]);
}
export async function loadChats(): Promise<Chat[]> {
  return (await db.getAllAsync<{ json: string }>('SELECT json FROM chats')).map((r) => JSON.parse(r.json));
}

export async function saveMessages(ms: Message[]) {
  await db.withTransactionAsync(async () => {
    for (const m of ms) {
      if (m.client_id) await db.runAsync('DELETE FROM messages WHERE client_id = ? AND id <> ?', [m.client_id, m.id]);
      await db.runAsync(
        `INSERT INTO messages(id, chat_id, client_id, created_at, json) VALUES (?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, created_at = excluded.created_at`,
        [m.id, m.chat_id, m.client_id ?? null, m.created_at, JSON.stringify(m)]);
    }
  });
}
export async function loadMessages(chatId: string, limit = 60, before?: number): Promise<Message[]> {
  const rows = await db.getAllAsync<{ json: string }>(
    `SELECT json FROM messages WHERE chat_id = ? AND hidden = 0 ${before ? 'AND created_at < ?' : ''}
     ORDER BY created_at DESC LIMIT ?`,
    before ? [chatId, before, limit] : [chatId, limit]);
  return rows.map((r) => JSON.parse(r.json) as Message).reverse();
}
export const hideMessage = (id: string) => db.runAsync('UPDATE messages SET hidden = 1 WHERE id = ?', [id]);

export async function outboxAdd(clientId: string, payload: unknown) {
  await db.runAsync('INSERT OR REPLACE INTO outbox(client_id, json, created_at) VALUES (?,?,?)', [clientId, JSON.stringify(payload), Date.now()]);
}
export const outboxRemove = (clientId: string) => db.runAsync('DELETE FROM outbox WHERE client_id = ?', [clientId]);
export async function outboxAll(): Promise<any[]> {
  return (await db.getAllAsync<{ json: string }>('SELECT json FROM outbox ORDER BY created_at')).map((r) => JSON.parse(r.json));
}

export async function wipe() {
  await db.execAsync('DELETE FROM kv; DELETE FROM chats; DELETE FROM messages; DELETE FROM outbox;');
}
