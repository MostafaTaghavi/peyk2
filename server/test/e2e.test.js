import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../src/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peyk-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app, base, port;

test.before(async () => {
  app = await createApp({ sqlitePath: path.join(tmp, 't.db'), uploadDir: path.join(tmp, 'up'), pushProvider: 'memory', pushDelayMs: 300, otpResendMs: 0 });
  port = await app.listen(0);
  base = `http://127.0.0.1:${port}`;
});
test.after(async () => { await app.close(); });

async function api(method, url, token, body) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
async function signup(phone, name) {
  const o = await api('POST', '/auth/otp', null, { phone });
  assert.equal(o.status, 200);
  const v = await api('POST', '/auth/verify', null, { phone, code: o.json.dev_code, name });
  assert.equal(v.status, 200);
  return { token: v.json.token, user: v.json.user, device: `dev-${name}-0000000`.padEnd(16, 'x') };
}

class Client {
  constructor(u, since = 0, fg = true) {
    this.u = u; this.events = []; this.msgs = []; this.since = since; this.fg = fg;
  }
  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()); this.msgs.push(m);
      if (m.t === 'event') { this.events.push(m); this.ws.send(JSON.stringify({ t: 'ack', seq: m.seq })); }
    });
    await new Promise((r) => this.ws.on('open', r));
    this.ws.send(JSON.stringify({ t: 'hello', token: this.u.token, device_id: this.u.device, since: this.since, fg: this.fg }));
    await this.wait((m) => m.t === 'ready');
    return this;
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  async wait(pred, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const f = this.msgs.find(pred); if (f) return f; await sleep(20); }
    throw new Error('timeout waiting; got ' + JSON.stringify(this.msgs.slice(-5)));
  }
  close() { this.ws.close(); }
}

test('otp: wrong code rejected, resend + normalization', async () => {
  const o = await api('POST', '/auth/otp', null, { phone: '09121110000' });
  const bad = await api('POST', '/auth/verify', null, { phone: '+989121110000', code: '000000' });
  assert.ok([400].includes(bad.status));
  const good = await api('POST', '/auth/verify', null, { phone: '۰۹۱۲۱۱۱۰۰۰۰', code: o.json.dev_code, name: 'x' });
  assert.equal(good.status, 200);
  assert.equal(good.json.user.phone, '+989121110000');
});

test('full flow: offline queue, delivered/read, edit, delete, push rules', async () => {
  const A = await signup('09120000001', 'Ali');
  const B = await signup('09120000002', 'Bahar');
  await api('POST', '/devices', B.token, { device_id: B.device, push_token: 'ExpoPushToken[B]', platform: 'android' });

  // contacts
  const c = await api('POST', '/contacts/sync', A.token, { contacts: [{ phone: '0912 000 0002', name: 'بهار' }, { phone: '09999999999' }] });
  assert.equal(c.json.length, 1); assert.equal(c.json[0].alias, 'بهار');

  const chat = (await api('POST', '/chats/direct', A.token, { user_id: B.user.id })).json;
  assert.equal(chat.members.length, 2);
  const chat2 = (await api('POST', '/chats/direct', B.token, { user_id: A.user.id })).json;
  assert.equal(chat2.id, chat.id, 'direct chat is unique');

  const a = await new Client(A).connect();
  // B is OFFLINE. A sends 2 messages (+ a duplicate retry with same client_id)
  a.send({ t: 'send', message: { chat_id: chat.id, client_id: 'c1', type: 'text', body: 'سلام' } });
  const s1 = await a.wait((m) => m.t === 'sent' && m.client_id === 'c1');
  a.send({ t: 'send', message: { chat_id: chat.id, client_id: 'c1', type: 'text', body: 'سلام' } });
  a.send({ t: 'send', message: { chat_id: chat.id, client_id: 'c2', type: 'text', body: 'خوبی؟', reply_to: s1.message.id } });
  await a.wait((m) => m.t === 'sent' && m.client_id === 'c2');
  const hist = (await api('GET', `/chats/${chat.id}/messages`, A.token)).json;
  assert.equal(hist.length, 2, 'idempotent retry did not duplicate');
  assert.equal(hist[1].reply.body, 'سلام');

  // push worker: B offline + unread => ONE push per message
  await sleep(400); await app.workers.pushTick();
  const pushes = app.ctx.push.sent.filter((p) => !p.silent);
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].tokens[0], 'ExpoPushToken[B]');
  assert.equal(pushes[0].title, 'Ali');

  // B comes online later: queue is delivered in order
  const b = await new Client(B).connect();
  const got = b.events.filter((e) => e.type === 'message').map((e) => e.payload.body);
  assert.deepEqual(got, ['سلام', 'خوبی؟']);
  // A sees "delivered"
  const rec = await a.wait((m) => m.t === 'event' && m.type === 'receipt' && m.payload.delivered === s1.message.seq + 1 && m.payload.user_id === B.user.id);

  // B reads => A gets read receipt, and a "clear notification" push goes to B's device
  b.send({ t: 'read', chat_id: chat.id, upto: 999999 });
  const rd = await a.wait((m) => m.t === 'event' && m.type === 'receipt' && m.payload.read);
  assert.equal(rd.payload.read, s1.message.seq + 1);
  await sleep(100);
  assert.ok(app.ctx.push.sent.some((p) => p.silent && p.data.type === 'clear' && p.data.chat_id === chat.id));

  // typing + presence
  b.send({ t: 'typing', chat_id: chat.id, on: true });
  await a.wait((m) => m.t === 'typing' && m.user_id === B.user.id);
  a.send({ t: 'watch', users: [B.user.id] });
  const pr = await a.wait((m) => m.t === 'presence');
  assert.equal(pr.users[0].online, true);

  // edit + delete propagate
  a.send({ t: 'edit', id: s1.message.id, body: 'سلام!' });
  const ed = await b.wait((m) => m.t === 'event' && m.type === 'edit');
  assert.equal(ed.payload.body, 'سلام!'); assert.ok(ed.payload.edited_at);
  a.send({ t: 'delete', id: s1.message.id });
  await b.wait((m) => m.t === 'event' && m.type === 'delete');
  b.send({ t: 'edit', id: s1.message.id, body: 'hack' });
  await b.wait((m) => m.t === 'error' && m.error === 'cannot_edit');

  // forward
  a.send({ t: 'forward', ref: 'f1', message_ids: [hist[1].id], chat_ids: [chat.id] });
  const fw = await a.wait((m) => m.t === 'forwarded');
  assert.equal(fw.messages[0].forwarded_from.name, 'Ali');

  // presence: B goes offline
  b.close();
  const off = await a.wait((m) => m.t === 'presence' && m.users[0].online === false);
  assert.ok(off.users[0].last_seen);
  a.close();
});

test('notification rules: read before delay => no push; foreground => no push; later unread keeps notification', async () => {
  const mine = () => app.ctx.push.sent.filter((p) => p.tokens.includes('ExpoPushToken[B2]'));
  const A = await signup('09120000011', 'A2'), B = await signup('09120000012', 'B2');
  await api('POST', '/devices', B.token, { device_id: B.device, push_token: 'ExpoPushToken[B2]', platform: 'ios' });
  const chat = (await api('POST', '/chats/direct', A.token, { user_id: B.user.id })).json;
  const a = await new Client(A).connect();
  const b = await new Client(B, 0, true).connect(); // B in foreground, reads right away
  a.send({ t: 'send', message: { chat_id: chat.id, client_id: 'x1', type: 'text', body: 'hi' } });
  const ev = await b.wait((m) => m.type === 'message');
  b.send({ t: 'read', chat_id: chat.id, upto: ev.payload.seq });
  await sleep(500); await app.workers.pushTick();
  assert.equal(mine().length, 0, 'no push for read/foreground message');

  b.send({ t: 'state', fg: false }); // app goes to background
  await sleep(50);
  a.send({ t: 'send', message: { chat_id: chat.id, client_id: 'x2', type: 'text', body: 'still there?' } });
  await sleep(500); await app.workers.pushTick();
  const p = mine();
  assert.equal(p.length, 1); assert.equal(p[0].body, 'still there?');
  a.close(); b.close();
});

test('group chat: members, receipts, leave', async () => {
  const U = [await signup('09130000001', 'G1'), await signup('09130000002', 'G2'), await signup('09130000003', 'G3')];
  const g = (await api('POST', '/chats/group', U[0].token, { title: 'خانواده', member_ids: [U[1].user.id, U[2].user.id] })).json;
  assert.equal(g.members.length, 3);
  const [c0, c1, c2] = [await new Client(U[0]).connect(), await new Client(U[1]).connect(), await new Client(U[2]).connect()];
  assert.ok(c1.events.some((e) => e.type === 'chat' && e.payload.title === 'خانواده'));
  c0.send({ t: 'send', message: { chat_id: g.id, client_id: 'g1', type: 'text', body: 'سلام گروه' } });
  await c1.wait((m) => m.type === 'message'); await c2.wait((m) => m.type === 'message');
  const chats = (await api('GET', '/chats', U[1].token)).json;
  assert.equal(chats[0].unread, 1);
  // non-member cannot read
  const X = await signup('09130000009', 'X');
  assert.equal((await api('GET', `/chats/${g.id}/messages`, X.token)).status, 403);
  // media message must reference an uploaded file path
  c0.send({ t: 'send', message: { chat_id: g.id, client_id: 'g2', type: 'image', media: { url: 'http://evil/x.jpg' } } });
  await c0.wait((m) => m.t === 'error');
  assert.equal((await api('DELETE', `/chats/${g.id}/members/me`, U[2].token)).status, 200);
  c0.send({ t: 'send', message: { chat_id: g.id, client_id: 'g3', type: 'text', body: 'bye 3' } });
  await c0.wait((m) => m.t === 'sent' && m.client_id === 'g3');
  await sleep(100);
  assert.equal(c2.events.filter((e) => e.type === 'message').length, 1, 'left member gets no new messages');
  [c0, c1, c2].forEach((c) => c.close());
});

test('upload + files served', async () => {
  const A = await signup('09140000001', 'U1');
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'یادداشت.txt');
  const r = await fetch(base + '/upload', { method: 'POST', headers: { authorization: `Bearer ${A.token}` }, body: fd });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.name, 'یادداشت.txt');
  assert.equal(await (await fetch(base + j.url)).text(), 'hello');
  assert.equal((await fetch(base + '/upload', { method: 'POST', body: fd })).status, 401);
});

test('gap resync: reconnect with since replays only newer events', async () => {
  const A = await signup('09150000001', 'S1'), B = await signup('09150000002', 'S2');
  const chat = (await api('POST', '/chats/direct', A.token, { user_id: B.user.id })).json;
  const a = await new Client(A).connect();
  a.send({ t: 'send', message: { chat_id: chat.id, client_id: 'a', type: 'text', body: '1' } });
  a.send({ t: 'send', message: { chat_id: chat.id, client_id: 'b', type: 'text', body: '2' } });
  await a.wait((m) => m.t === 'sent' && m.client_id === 'b');
  const b1 = await new Client(B).connect();
  const last = b1.events.at(-1).seq; b1.close(); await sleep(100);
  a.send({ t: 'send', message: { chat_id: chat.id, client_id: 'c', type: 'text', body: '3' } });
  await a.wait((m) => m.t === 'sent' && m.client_id === 'c');
  const b2 = await new Client(B, last).connect();
  assert.deepEqual(b2.events.filter((e) => e.type === 'message').map((e) => e.payload.body), ['3']);
  a.close(); b2.close();
});
