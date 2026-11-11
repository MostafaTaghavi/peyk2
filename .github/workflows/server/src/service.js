// Core domain logic. Everything that changes state goes through here (REST + WS share it).
import crypto from 'node:crypto';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}
export const uuid = () => crypto.randomUUID();
const now = () => Date.now();
const J = (s) => (s ? JSON.parse(s) : null);

// ---------------------------------------------------------------- phone helpers
export function normalizePhone(input) {
  const fa = '۰۱۲۳۴۵۶۷۸۹', ar = '٠١٢٣٤٥٦٧٨٩';
  let s = String(input ?? '').replace(/[۰-۹٠-٩]/g, (c) => String(fa.includes(c) ? fa.indexOf(c) : ar.indexOf(c)));
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^09\d{9}$/.test(s)) s = '+98' + s.slice(1);
  else if (/^9\d{9}$/.test(s)) s = '+98' + s;
  else if (/^989\d{9}$/.test(s)) s = '+' + s;
  else if (!s.startsWith('+') && /^\d{8,15}$/.test(s)) s = '+' + s;
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

// ---------------------------------------------------------------- mappers
export const publicUser = (u) => ({ id: u.id, phone: u.phone, name: u.name, about: u.about, avatar: u.avatar });

export function toMsg(r) {
  const deleted = !!r.deleted_at;
  return {
    id: r.id, seq: r.seq, chat_id: r.chat_id, sender_id: r.sender_id, client_id: r.client_id,
    type: r.type, body: deleted ? '' : r.body, media: deleted ? null : J(r.media),
    reply_to: r.reply_to, reply: deleted ? null : J(r.reply_snapshot),
    forwarded_from: deleted ? null : J(r.forwarded_from),
    created_at: r.created_at, edited_at: r.edited_at, deleted,
  };
}

// ---------------------------------------------------------------- events (offline queue)
// Appends an ordered event to a user's queue inside the caller's transaction.
// Publishing to live sockets happens after commit via flush().
export async function emitEvent(t, out, userId, type, payload) {
  const r = await t.get('UPDATE users SET ev_seq = ev_seq + 1 WHERE id = ? RETURNING ev_seq', [userId]);
  if (!r) return;
  const created = now();
  await t.run('INSERT INTO user_events(user_id, seq, type, payload, created_at) VALUES (?,?,?,?,?)',
    [userId, r.ev_seq, type, JSON.stringify(payload), created]);
  out.push({ userId, ev: { seq: r.ev_seq, type, payload } });
}
export async function flush(ctx, out) {
  for (const o of out) await ctx.bus.publish(`u:${o.userId}`, { ev: o.ev });
}
const sortedUnique = (ids) => [...new Set(ids)].sort();

// ---------------------------------------------------------------- chats
async function activeMemberIds(t, chatId) {
  return (await t.all('SELECT user_id FROM chat_members WHERE chat_id = ? AND left_at IS NULL', [chatId])).map((r) => r.user_id);
}
export async function assertMember(db, chatId, userId) {
  const m = await db.get('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ? AND left_at IS NULL', [chatId, userId]);
  if (!m) throw new HttpError(403, 'not_a_member');
  return m;
}

export async function chatView(db, chatId) {
  const c = await db.get('SELECT * FROM chats WHERE id = ?', [chatId]);
  if (!c) return null;
  const members = await db.all(
    `SELECT cm.user_id, cm.role, cm.left_at, cm.last_delivered_seq, cm.last_read_seq,
            u.name, u.phone, u.avatar, u.about
       FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ?`, [chatId]);
  const last = await db.get('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1', [chatId]);
  return {
    id: c.id, type: c.type, title: c.title, avatar: c.avatar, created_by: c.created_by,
    created_at: c.created_at, updated_at: c.updated_at, members, last_message: last ? toMsg(last) : null,
  };
}

export async function listChats(db, userId) {
  const ids = (await db.all('SELECT chat_id FROM chat_members WHERE user_id = ? AND left_at IS NULL', [userId])).map((r) => r.chat_id);
  const out = [];
  for (const id of ids) {
    const v = await chatView(db, id);
    const me = v.members.find((m) => m.user_id === userId);
    const u = await db.get(
      'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND seq > ? AND sender_id <> ? AND deleted_at IS NULL',
      [id, me.last_read_seq, userId]);
    out.push({ ...v, unread: u.n });
  }
  return out.sort((a, b) => (b.last_message?.created_at ?? b.updated_at) - (a.last_message?.created_at ?? a.updated_at));
}

export async function getOrCreateDirect(ctx, userId, otherId) {
  if (userId === otherId) throw new HttpError(400, 'cannot_chat_with_self');
  const other = await ctx.db.get('SELECT id FROM users WHERE id = ?', [otherId]);
  if (!other) throw new HttpError(404, 'user_not_found');
  const key = [userId, otherId].sort().join(':');
  await ctx.db.tx(async (t) => {
    const ex = await t.get('SELECT id FROM chats WHERE direct_key = ?', [key]);
    if (ex) return;
    const id = uuid(), ts = now();
    await t.run('INSERT INTO chats(id, type, direct_key, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)', [id, 'direct', key, userId, ts, ts]);
    for (const u of [userId, otherId]) {
      await t.run('INSERT INTO chat_members(chat_id, user_id, joined_at) VALUES (?,?,?)', [id, u, ts]);
    }
  });
  const c = await ctx.db.get('SELECT id FROM chats WHERE direct_key = ?', [key]);
  return chatView(ctx.db, c.id);
}

export async function createGroup(ctx, userId, { title, member_ids }) {
  const members = sortedUnique([userId, ...member_ids]);
  const found = await ctx.db.all(`SELECT id FROM users WHERE id IN (${members.map(() => '?').join(',')})`, members);
  if (found.length !== members.length) throw new HttpError(400, 'unknown_member');
  if (members.length < 2) throw new HttpError(400, 'group_needs_members');
  const id = uuid(), ts = now(), out = [];
  const view = await ctx.db.tx(async (t) => {
    await t.run('INSERT INTO chats(id, type, title, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?)', [id, 'group', title, userId, ts, ts]);
    for (const u of members) {
      await t.run('INSERT INTO chat_members(chat_id, user_id, role, joined_at) VALUES (?,?,?,?)', [id, u, u === userId ? 'admin' : 'member', ts]);
    }
    const v = await chatView(t, id);
    for (const u of members) await emitEvent(t, out, u, 'chat', v);
    return v;
  });
  await flush(ctx, out);
  return view;
}

export async function updateGroup(ctx, userId, chatId, { title, add_member_ids = [] }) {
  const out = [];
  const view = await ctx.db.tx(async (t) => {
    const c = await t.get('SELECT * FROM chats WHERE id = ?', [chatId]);
    if (!c || c.type !== 'group') throw new HttpError(404, 'chat_not_found');
    const me = await t.get('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ? AND left_at IS NULL', [chatId, userId]);
    if (!me || me.role !== 'admin') throw new HttpError(403, 'admin_only');
    if (title) await t.run('UPDATE chats SET title = ?, updated_at = ? WHERE id = ?', [title, now(), chatId]);
    for (const u of add_member_ids) {
      const ex = await t.get('SELECT left_at FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, u]);
      const lastSeq = (await t.get('SELECT COALESCE(MAX(seq),0) AS s FROM messages WHERE chat_id = ?', [chatId])).s;
      if (!ex) {
        const user = await t.get('SELECT id FROM users WHERE id = ?', [u]);
        if (!user) continue;
        await t.run('INSERT INTO chat_members(chat_id, user_id, joined_at, last_read_seq, last_delivered_seq) VALUES (?,?,?,?,?)', [chatId, u, now(), lastSeq, lastSeq]);
      } else if (ex.left_at) {
        await t.run('UPDATE chat_members SET left_at = NULL, last_read_seq = ?, last_delivered_seq = ? WHERE chat_id = ? AND user_id = ?', [lastSeq, lastSeq, chatId, u]);
      }
    }
    const v = await chatView(t, chatId);
    for (const m of v.members.filter((m) => !m.left_at)) await emitEvent(t, out, m.user_id, 'chat', v);
    return v;
  });
  await flush(ctx, out);
  return view;
}

export async function leaveChat(ctx, userId, chatId, targetId = userId) {
  const out = [];
  await ctx.db.tx(async (t) => {
    const c = await t.get('SELECT * FROM chats WHERE id = ?', [chatId]);
    if (!c || c.type !== 'group') throw new HttpError(404, 'chat_not_found');
    const me = await t.get('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ? AND left_at IS NULL', [chatId, userId]);
    if (!me || (targetId !== userId && me.role !== 'admin')) throw new HttpError(403, 'forbidden');
    await t.run('UPDATE chat_members SET left_at = ? WHERE chat_id = ? AND user_id = ?', [now(), chatId, targetId]);
    await t.run("UPDATE pending_pushes SET state = 'cancelled' WHERE user_id = ? AND chat_id = ? AND state = 'pending'", [targetId, chatId]);
    const v = await chatView(t, chatId);
    for (const m of v.members) if (!m.left_at || m.user_id === targetId) await emitEvent(t, out, m.user_id, 'chat', v);
  });
  await flush(ctx, out);
}

// ---------------------------------------------------------------- messages
export const sendSchema = z.object({
  chat_id: z.string().min(1),
  client_id: z.string().min(1).max(64).optional(),
  type: z.enum(['text', 'image', 'video', 'file', 'audio']),
  body: z.string().max(4096).default(''),
  media: z.object({
    url: z.string().regex(/^\/files\/[\w.\-]+$/),
    name: z.string().max(255).optional(), size: z.number().optional(), mime: z.string().max(100).optional(),
    duration: z.number().optional(), width: z.number().optional(), height: z.number().optional(),
  }).nullish(),
  reply_to: z.string().nullish(),
  forwarded_from: z.object({ user_id: z.string(), name: z.string() }).nullish(),
}).refine((m) => (m.type === 'text' ? m.body.trim().length > 0 : !!m.media), 'invalid_message');

const preview = (m) => m.type === 'text' ? m.body.slice(0, 120) : m.body ? m.body.slice(0, 120) : '';

async function insertMessage(t, out, userId, m) {
  const members = await activeMemberIds(t, m.chat_id);
  if (!members.includes(userId)) throw new HttpError(403, 'not_a_member');
  if (m.client_id) {
    const ex = await t.get('SELECT * FROM messages WHERE sender_id = ? AND client_id = ?', [userId, m.client_id]);
    if (ex) return toMsg(ex); // idempotent retry from the client outbox
  }
  let snapshot = null;
  if (m.reply_to) {
    const r = await t.get('SELECT * FROM messages WHERE id = ? AND chat_id = ?', [m.reply_to, m.chat_id]);
    if (r && !r.deleted_at) snapshot = { id: r.id, sender_id: r.sender_id, type: r.type, body: preview(r) };
  }
  const id = uuid(), ts = now();
  const row = await t.get(
    `INSERT INTO messages(id, chat_id, sender_id, client_id, type, body, media, reply_to, reply_snapshot, forwarded_from, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`,
    [id, m.chat_id, userId, m.client_id ?? null, m.type, m.body, m.media ? JSON.stringify(m.media) : null,
      snapshot ? m.reply_to : null, snapshot ? JSON.stringify(snapshot) : null,
      m.forwarded_from ? JSON.stringify(m.forwarded_from) : null, ts]);
  await t.run('UPDATE chats SET updated_at = ? WHERE id = ?', [ts, m.chat_id]);
  const msg = toMsg(row);
  for (const u of sortedUnique(members)) {
    await emitEvent(t, out, u, 'message', msg);
    if (u !== userId) {
      await t.run('INSERT INTO pending_pushes(user_id, chat_id, message_seq, due_at) VALUES (?,?,?,?)', [u, m.chat_id, row.seq, ts + (t.pushDelayMs ?? 0)]);
    }
  }
  return msg;
}

export async function sendMessage(ctx, userId, input) {
  const m = sendSchema.parse(input);
  const out = [];
  const msg = await ctx.db.tx(async (t) => { t.pushDelayMs = ctx.cfg.pushDelayMs; return insertMessage(t, out, userId, m); });
  await flush(ctx, out);
  return msg;
}

export async function forwardMessages(ctx, userId, { message_ids, chat_ids }) {
  const out = [], res = [];
  await ctx.db.tx(async (t) => {
    t.pushDelayMs = ctx.cfg.pushDelayMs;
    const srcs = [];
    for (const id of message_ids) {
      const r = await t.get('SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL', [id]);
      if (!r) continue;
      const mem = await t.get('SELECT 1 AS x FROM chat_members WHERE chat_id = ? AND user_id = ? AND left_at IS NULL', [r.chat_id, userId]);
      if (mem) srcs.push(r);
    }
    srcs.sort((a, b) => a.seq - b.seq);
    for (const chat_id of chat_ids) for (const r of srcs) {
      const orig = await t.get('SELECT name FROM users WHERE id = ?', [r.sender_id]);
      res.push(await insertMessage(t, out, userId, {
        chat_id, type: r.type, body: r.body, media: J(r.media),
        forwarded_from: J(r.forwarded_from) ?? { user_id: r.sender_id, name: orig?.name ?? '' },
      }));
    }
  });
  await flush(ctx, out);
  return res;
}

export async function editMessage(ctx, userId, { id, body }) {
  const text = z.string().trim().min(1).max(4096).parse(body);
  const out = [];
  const msg = await ctx.db.tx(async (t) => {
    const r = await t.get('SELECT * FROM messages WHERE id = ?', [id]);
    if (!r || r.sender_id !== userId || r.deleted_at) throw new HttpError(403, 'cannot_edit');
    if (now() - r.created_at > ctx.cfg.editWindowMs) throw new HttpError(403, 'edit_window_over');
    const row = await t.get('UPDATE messages SET body = ?, edited_at = ? WHERE id = ? RETURNING *', [text, now(), id]);
    const m = toMsg(row);
    for (const u of sortedUnique(await activeMemberIds(t, r.chat_id))) await emitEvent(t, out, u, 'edit', m);
    return m;
  });
  await flush(ctx, out);
  return msg;
}

export async function deleteMessage(ctx, userId, { id }) {
  const out = [];
  const msg = await ctx.db.tx(async (t) => {
    const r = await t.get('SELECT * FROM messages WHERE id = ?', [id]);
    if (!r || r.sender_id !== userId) throw new HttpError(403, 'cannot_delete');
    if (r.deleted_at) return toMsg(r);
    if (now() - r.created_at > ctx.cfg.deleteForAllWindowMs) throw new HttpError(403, 'delete_window_over');
    const row = await t.get('UPDATE messages SET deleted_at = ? WHERE id = ? RETURNING *', [now(), id]);
    await t.run("UPDATE pending_pushes SET state = 'cancelled' WHERE chat_id = ? AND message_seq = ? AND state = 'pending'", [r.chat_id, r.seq]);
    const m = toMsg(row);
    for (const u of sortedUnique(await activeMemberIds(t, r.chat_id))) await emitEvent(t, out, u, 'delete', { id: m.id, chat_id: m.chat_id, seq: m.seq });
    return m;
  });
  await flush(ctx, out);
  return msg;
}

export async function history(db, userId, chatId, { before, after, limit = 50 }) {
  await assertMember(db, chatId, userId);
  limit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  let rows;
  if (after) rows = await db.all('SELECT * FROM messages WHERE chat_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?', [chatId, Number(after), limit]);
  else if (before) rows = (await db.all('SELECT * FROM messages WHERE chat_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?', [chatId, Number(before), limit])).reverse();
  else rows = (await db.all('SELECT * FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT ?', [chatId, limit])).reverse();
  return rows.map(toMsg);
}

// ---------------------------------------------------------------- receipts
// "read" pointer: also withdraws pending pushes and clears already-shown notifications.
export async function markRead(ctx, userId, chatId, upto) {
  const out = [];
  let clearPush = false;
  const changed = await ctx.db.tx(async (t) => {
    const me = await t.get('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ? AND left_at IS NULL', [chatId, userId]);
    if (!me) throw new HttpError(403, 'not_a_member');
    const max = (await t.get('SELECT COALESCE(MAX(seq),0) AS s FROM messages WHERE chat_id = ?', [chatId])).s;
    upto = Math.min(Number(upto) || 0, max);
    if (upto <= me.last_read_seq) return false;
    await t.run('UPDATE chat_members SET last_read_seq = ?, last_delivered_seq = CASE WHEN last_delivered_seq > ? THEN last_delivered_seq ELSE ? END WHERE chat_id = ? AND user_id = ?', [upto, upto, upto, chatId, userId]);
    await t.run("UPDATE pending_pushes SET state = 'cancelled' WHERE user_id = ? AND chat_id = ? AND message_seq <= ? AND state IN ('pending','processing')", [userId, chatId, upto]);
    const sent = await t.get("SELECT COUNT(*) AS n FROM pending_pushes WHERE user_id = ? AND chat_id = ? AND message_seq <= ? AND state = 'sent'", [userId, chatId, upto]);
    if (sent.n > 0) {
      clearPush = true;
      await t.run("UPDATE pending_pushes SET state = 'cleared' WHERE user_id = ? AND chat_id = ? AND message_seq <= ? AND state = 'sent'", [userId, chatId, upto]);
    }
    for (const u of sortedUnique(await activeMemberIds(t, chatId))) {
      await emitEvent(t, out, u, 'receipt', { chat_id: chatId, user_id: userId, delivered: upto, read: upto });
    }
    return true;
  });
  await flush(ctx, out);
  if (changed) clearPush && (await sendClearPush(ctx, userId, chatId));
  return changed;
}

export async function sendClearPush(ctx, userId, chatId) {
  const tokens = (await ctx.db.all('SELECT push_token FROM devices WHERE user_id = ? AND push_token IS NOT NULL', [userId])).map((r) => r.push_token);
  if (tokens.length) await ctx.push.send(tokens, { silent: true, data: { type: 'clear', chat_id: chatId } }).catch(() => {});
}

// Called when a device acknowledges events up to `seq` => those messages are "delivered".
export async function ackEvents(ctx, userId, deviceId, seq) {
  seq = Number(seq) || 0;
  const out = [];
  await ctx.db.tx(async (t) => {
    const d = await t.get('SELECT acked_seq FROM devices WHERE user_id = ? AND id = ?', [userId, deviceId]);
    if (!d || seq <= d.acked_seq) return;
    const evs = await t.all("SELECT payload FROM user_events WHERE user_id = ? AND seq > ? AND seq <= ? AND type = 'message'", [userId, d.acked_seq, seq]);
    const perChat = new Map();
    for (const e of evs) {
      const m = JSON.parse(e.payload);
      if (m.sender_id === userId) continue;
      perChat.set(m.chat_id, Math.max(perChat.get(m.chat_id) ?? 0, m.seq));
    }
    for (const [chatId, mseq] of perChat) {
      const me = await t.get('SELECT last_delivered_seq FROM chat_members WHERE chat_id = ? AND user_id = ?', [chatId, userId]);
      if (!me || mseq <= me.last_delivered_seq) continue;
      await t.run('UPDATE chat_members SET last_delivered_seq = ? WHERE chat_id = ? AND user_id = ?', [mseq, chatId, userId]);
      for (const u of sortedUnique(await activeMemberIds(t, chatId))) {
        if (u !== userId) await emitEvent(t, out, u, 'receipt', { chat_id: chatId, user_id: userId, delivered: mseq });
      }
    }
    await t.run('UPDATE devices SET acked_seq = ? WHERE user_id = ? AND id = ?', [seq, userId, deviceId]);
  });
  await flush(ctx, out);
}

// ---------------------------------------------------------------- contacts / users
export async function syncContacts(db, userId, items) {
  const clean = [];
  for (const it of items) { const p = normalizePhone(it.phone); if (p) clean.push({ phone: p, alias: it.name || null }); }
  const phones = [...new Set(clean.map((c) => c.phone))];
  if (!phones.length) return listContacts(db, userId);
  for (let i = 0; i < phones.length; i += 400) {
    const chunk = phones.slice(i, i + 400);
    const users = await db.all(`SELECT * FROM users WHERE phone IN (${chunk.map(() => '?').join(',')}) AND name <> ''`, chunk);
    for (const u of users) {
      if (u.id === userId) continue;
      const alias = clean.find((c) => c.phone === u.phone)?.alias ?? null;
      await db.run(
        'INSERT INTO contacts(user_id, contact_id, alias) VALUES (?,?,?) ON CONFLICT(user_id, contact_id) DO UPDATE SET alias = excluded.alias',
        [userId, u.id, alias]);
    }
  }
  return listContacts(db, userId);
}
export async function listContacts(db, userId, q) {
  let rows = await db.all(
    `SELECT u.id, u.phone, u.name, u.about, u.avatar, c.alias FROM contacts c JOIN users u ON u.id = c.contact_id
      WHERE c.user_id = ? ORDER BY COALESCE(c.alias, u.name)`, [userId]);
  if (q) { const s = q.toLowerCase(); rows = rows.filter((r) => `${r.alias ?? ''} ${r.name} ${r.phone}`.toLowerCase().includes(s)); }
  return rows;
}
