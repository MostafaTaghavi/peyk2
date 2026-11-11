// Background jobs. Safe to run on every server instance (claims use atomic UPDATE).
import { toMsg } from './service.js';

const label = { image: '📷 عکس', video: '🎬 ویدیو', audio: '🎤 پیام صوتی', file: '📎 فایل' };

export function startWorkers(ctx) {
  const { db, cfg, bus, push } = ctx;
  let busy = false;

  async function pushTick() {
    if (busy) return; busy = true;
    try {
      const skip = db.dialect === 'pg' ? ' FOR UPDATE SKIP LOCKED' : '';
      const rows = await db.all(
        `UPDATE pending_pushes SET state = 'processing' WHERE id IN
           (SELECT id FROM pending_pushes WHERE state = 'pending' AND due_at <= ? ORDER BY id LIMIT 50${skip}) RETURNING *`,
        [Date.now()]);
      for (const p of rows) await processPush(p);
    } catch (e) { console.error('push worker', e); } finally { busy = false; }
  }

  async function processPush(p) {
    const setState = (s) => db.run('UPDATE pending_pushes SET state = ?, sent_at = ? WHERE id = ?', [s, Date.now(), p.id]);
    const m = await db.get('SELECT * FROM messages WHERE seq = ?', [p.message_seq]);
    const mem = await db.get('SELECT last_read_seq, left_at FROM chat_members WHERE chat_id = ? AND user_id = ?', [p.chat_id, p.user_id]);
    // RULE: a notification exists only for messages that are still unread.
    if (!m || m.deleted_at || !mem || mem.left_at || mem.last_read_seq >= p.message_seq) return setState('cancelled');
    if ((await bus.presenceGet(p.user_id)).online) return setState('skipped_foreground');
    const devices = await db.all('SELECT push_token FROM devices WHERE user_id = ? AND push_token IS NOT NULL', [p.user_id]);
    const tokens = devices.map((d) => d.push_token);
    if (!tokens.length) return setState('no_device');
    const chat = await db.get('SELECT type, title FROM chats WHERE id = ?', [p.chat_id]);
    const sender = await db.get('SELECT name FROM users WHERE id = ?', [m.sender_id]);
    const text = m.type === 'text' ? m.body.slice(0, 140) : (label[m.type] + (m.body ? ` ${m.body.slice(0, 100)}` : ''));
    const isGroup = chat.type === 'group';
    try {
      const res = await push.send(tokens, {
        title: isGroup ? chat.title : sender.name,
        body: isGroup ? `${sender.name}: ${text}` : text,
        tag: p.chat_id,
        data: { type: 'message', chat_id: p.chat_id, message_id: toMsg(m).id, seq: m.seq },
      });
      for (const bad of res.invalid ?? []) await db.run('UPDATE devices SET push_token = NULL WHERE push_token = ?', [bad]);
      await setState('sent');
    } catch (e) {
      const attempts = p.attempts + 1;
      if (attempts >= 5) return setState('failed');
      await db.run("UPDATE pending_pushes SET state = 'pending', attempts = ?, due_at = ? WHERE id = ?", [attempts, Date.now() + 10_000 * attempts, p.id]);
    }
  }

  async function cleanup() {
    try {
      await db.run('DELETE FROM user_events WHERE created_at < ?', [Date.now() - cfg.eventRetentionMs]);
      await db.run("DELETE FROM pending_pushes WHERE state <> 'pending' AND state <> 'processing' AND due_at < ?", [Date.now() - 7 * 86400_000]);
      await db.run('DELETE FROM otps WHERE expires_at < ?', [Date.now() - 3600_000]);
    } catch (e) { console.error('cleanup', e); }
  }

  const t1 = setInterval(pushTick, 1000);
  const t2 = setInterval(cleanup, 3600_000);
  return { pushTick, stop: () => { clearInterval(t1); clearInterval(t2); } };
}
