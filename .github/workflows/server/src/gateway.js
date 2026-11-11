// WebSocket gateway. One socket per device. Protocol (JSON):
//  c->s  hello{token,device_id,since}  send{...}  edit{id,body}  delete{id}  forward{message_ids,chat_ids}
//        read{chat_id,upto}  typing{chat_id,on}  watch{users}  ack{seq}  sync{since}  state{fg}  hb
//  s->c  ready{last_seq}  event{seq,type,payload}  sent{client_id,message}  typing{...}
//        presence{users:[{id,online,last_seen}]}  error{ref,error}
import { WebSocketServer } from 'ws';
import * as S from './service.js';
import { verifyToken } from './http.js';

export function createGateway(ctx, server) {
  const { cfg, db, bus } = ctx;
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
  const conns = new Set();

  const send = (c, obj) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); };

  async function replay(c, since) {
    let cursor = since;
    for (;;) {
      const rows = await db.all('SELECT seq, type, payload FROM user_events WHERE user_id = ? AND seq > ? ORDER BY seq ASC LIMIT 200', [c.userId, cursor]);
      for (const e of rows) send(c, { t: 'event', seq: e.seq, type: e.type, payload: JSON.parse(e.payload) });
      if (rows.length) cursor = rows[rows.length - 1].seq;
      if (rows.length < 200) break;
    }
    return cursor;
  }

  async function presenceOf(ids) {
    const users = await db.all(`SELECT id, last_seen FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    const out = [];
    for (const u of users) out.push({ id: u.id, online: (await bus.presenceGet(u.id)).online, last_seen: u.last_seen });
    return out;
  }

  async function setPresence(c, state) {
    const before = (await bus.presenceGet(c.userId)).online;
    await bus.presenceSet(c.userId, c.deviceId, state, cfg.presenceTtlSec);
    const after = (await bus.presenceGet(c.userId)).online;
    if (before !== after) {
      const ts = Date.now();
      if (!after) await db.run('UPDATE users SET last_seen = ? WHERE id = ?', [ts, c.userId]);
      await bus.publish(`p:${c.userId}`, { id: c.userId, online: after, last_seen: after ? null : ts });
    }
  }

  async function handle(c, m) {
    switch (m.t) {
      case 'hb':
        await bus.presenceSet(c.userId, c.deviceId, c.fg ? 'fg' : 'bg', cfg.presenceTtlSec);
        return;
      case 'state':
        c.fg = !!m.fg;
        await setPresence(c, c.fg ? 'fg' : 'bg');
        return;
      case 'ack': await S.ackEvents(ctx, c.userId, c.deviceId, m.seq); return;
      case 'sync': {
        const last = await replay(c, Number(m.since) || 0);
        send(c, { t: 'ready', last_seq: last });
        return;
      }
      case 'send': {
        const msg = await S.sendMessage(ctx, c.userId, m.message);
        send(c, { t: 'sent', client_id: m.message?.client_id, message: msg });
        return;
      }
      case 'forward': {
        const msgs = await S.forwardMessages(ctx, c.userId, m);
        send(c, { t: 'forwarded', ref: m.ref, messages: msgs });
        return;
      }
      case 'edit': await S.editMessage(ctx, c.userId, m); return;
      case 'delete': await S.deleteMessage(ctx, c.userId, m); return;
      case 'read': await S.markRead(ctx, c.userId, m.chat_id, m.upto); return;
      case 'typing': {
        const mem = await S.assertMember(db, m.chat_id, c.userId);
        void mem;
        const ids = (await db.all('SELECT user_id FROM chat_members WHERE chat_id = ? AND left_at IS NULL AND user_id <> ?', [m.chat_id, c.userId])).map((r) => r.user_id);
        for (const id of ids) await bus.publish(`u:${id}`, { eph: { t: 'typing', chat_id: m.chat_id, user_id: c.userId, on: !!m.on } });
        return;
      }
      case 'watch': {
        const wanted = Array.isArray(m.users) ? m.users.slice(0, 500) : [];
        // only users that share a chat with me or are in my contacts
        let allowed = [];
        if (wanted.length) {
          const ph = wanted.map(() => '?').join(',');
          const rows = await db.all(
            `SELECT cm2.user_id AS id FROM chat_members cm1 JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id
              WHERE cm1.user_id = ? AND cm2.user_id IN (${ph})
             UNION SELECT contact_id AS id FROM contacts WHERE user_id = ? AND contact_id IN (${ph})`,
            [c.userId, ...wanted, c.userId, ...wanted]);
          allowed = rows.map((r) => r.id);
        }
        for (const [id, off] of c.watching) if (!allowed.includes(id)) { off(); c.watching.delete(id); }
        for (const id of allowed) if (!c.watching.has(id)) {
          c.watching.set(id, bus.subscribe(`p:${id}`, (p) => send(c, { t: 'presence', users: [p] })));
        }
        if (allowed.length) send(c, { t: 'presence', users: await presenceOf(allowed) });
        return;
      }
      default: throw new S.HttpError(400, 'unknown_type');
    }
  }

  wss.on('connection', (ws) => {
    const c = { ws, userId: null, deviceId: null, fg: false, alive: true, watching: new Map(), off: null, buffer: [], replaying: true, lastSent: 0 };
    conns.add(c);
    const authTimer = setTimeout(() => !c.userId && ws.close(4001, 'auth_timeout'), 10_000);
    ws.on('pong', () => (c.alive = true));

    // messages are processed strictly in order per socket
    let chain = Promise.resolve();
    ws.on('message', (raw) => {
      chain = chain.then(async () => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        try {
          if (!c.userId) {
            if (m.t !== 'hello') return ws.close(4001, 'hello_required');
            const uid = verifyToken(cfg, m.token);
            if (!uid || !m.device_id) return ws.close(4001, 'unauthorized');
            const user = await db.get('SELECT id FROM users WHERE id = ?', [uid]);
            if (!user) return ws.close(4001, 'unauthorized');
            clearTimeout(authTimer);
            c.userId = uid; c.deviceId = String(m.device_id).slice(0, 64); c.fg = !!m.fg;
            const since = Number(m.since) || 0;
            await db.run(
              `INSERT INTO devices(user_id, id, acked_seq, created_at) VALUES (?,?,?,?)
               ON CONFLICT(user_id, id) DO UPDATE SET acked_seq = CASE WHEN devices.acked_seq > excluded.acked_seq THEN devices.acked_seq ELSE excluded.acked_seq END`,
              [uid, c.deviceId, 0, Date.now()]);
            // subscribe BEFORE replaying so nothing is missed; buffer live events meanwhile
            c.off = bus.subscribe(`u:${uid}`, (b) => {
              if (b.eph) return send(c, b.eph);
              if (c.replaying) c.buffer.push(b.ev); else send(c, { t: 'event', ...b.ev });
            });
            conns.add(c);
            await setPresence(c, c.fg ? 'fg' : 'bg');
            if (since) await ackFromHello(c, since);
            c.lastSent = await replay(c, since);
            for (const ev of c.buffer) if (ev.seq > c.lastSent) send(c, { t: 'event', ...ev });
            c.buffer = []; c.replaying = false;
            send(c, { t: 'ready', last_seq: c.lastSent });
            return;
          }
          await handle(c, m);
        } catch (e) {
          const error = e instanceof S.HttpError ? e.message : e?.name === 'ZodError' ? 'validation' : 'server_error';
          if (error === 'server_error') console.error(e);
          send(c, { t: 'error', ref: m.ref ?? m.message?.client_id ?? m.t, error });
        }
      });
    });

    ws.on('close', async () => {
      clearTimeout(authTimer);
      conns.delete(c);
      c.off?.();
      for (const off of c.watching.values()) off();
      if (c.userId) await setPresence(c, null).catch(() => {});
    });
    ws.on('error', () => {});
  });

  // `since` the client reports means it has processed everything up to it
  async function ackFromHello(c, since) { await S.ackEvents(ctx, c.userId, c.deviceId, since); }

  const hb = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false; c.ws.ping();
    }
  }, 25_000);

  return { wss, close: () => { clearInterval(hb); for (const c of conns) c.ws.terminate(); wss.close(); } };
}
