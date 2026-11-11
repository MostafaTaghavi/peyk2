// WebSocket client: reconnection, ordered event processing, acks, outbox flushing.
import { AppState, type AppStateStatus } from 'react-native';
import { WS_URL } from './config';
import { api } from './api';
import * as DB from './db';
import { dismissChatNotifications } from './push';
import { useStore } from './store';
import type { Chat, Message } from './types';

let ws: WebSocket | null = null;
let stopped = true;
let ready = false;
let retry = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let hbTimer: ReturnType<typeof setInterval> | null = null;
let ackTimer: ReturnType<typeof setTimeout> | null = null;
let lastSeq = 0;
let syncing = false;
let queue: Promise<void> = Promise.resolve();
const inflight = new Set<string>();
let appSub: { remove(): void } | null = null;

const S = () => useStore.getState();
const set = useStore.setState;

export function send(obj: unknown): boolean {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}

export async function start() {
  stopped = false;
  lastSeq = Number((await DB.kvGet('last_seq')) ?? 0);
  appSub?.remove();
  appSub = AppState.addEventListener('change', onAppState);
  set({ appActive: AppState.currentState === 'active' });
  open();
}

export function stop() {
  stopped = true; ready = false;
  appSub?.remove(); appSub = null;
  if (retryTimer) clearTimeout(retryTimer);
  if (hbTimer) clearInterval(hbTimer);
  ws?.close(); ws = null;
  set({ conn: 'offline' });
}

function onAppState(st: AppStateStatus) {
  const active = st === 'active';
  set({ appActive: active });
  send({ t: 'state', fg: active });
  if (active) {
    if (!ws || ws.readyState > 1) { retry = 0; open(); }
    const id = S().activeChat;
    if (id) S().markRead(id);
  }
}

function open() {
  if (stopped || !S().token) return;
  if (ws && ws.readyState <= 1) return;
  set({ conn: 'connecting' });
  const sock = new WebSocket(WS_URL);
  ws = sock;
  sock.onopen = () => {
    retry = 0;
    sock.send(JSON.stringify({
      t: 'hello', token: S().token, device_id: S().deviceId, since: lastSeq, fg: AppState.currentState === 'active',
    }));
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(() => send({ t: 'hb' }), 20_000);
  };
  sock.onmessage = (e) => {
    let m: any; try { m = JSON.parse(String(e.data)); } catch { return; }
    queue = queue.then(() => onServer(m)).catch(() => {});
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ready = false; ws = null; inflight.clear();
    if (hbTimer) clearInterval(hbTimer);
    set({ conn: 'offline' });
    if (!stopped) {
      retryTimer = setTimeout(open, Math.min(1000 * 2 ** retry++, 15_000));
    }
  };
  sock.onerror = () => {};
}

async function onServer(m: any) {
  switch (m.t) {
    case 'ready':
      ready = true; syncing = false;
      set({ conn: 'online' });
      await flushOutbox();
      watchUsers();
      { const id = S().activeChat; if (id) S().markRead(id); }
      return;
    case 'event': return onEvent(m.seq, m.type, m.payload);
    case 'sent': {
      const msg = m.message as Message;
      if (msg.client_id) { inflight.delete(msg.client_id); await DB.outboxRemove(msg.client_id); }
      await S().putMessages(msg.chat_id, [msg]);
      return;
    }
    case 'forwarded':
      for (const msg of m.messages as Message[]) await S().putMessages(msg.chat_id, [msg]);
      return;
    case 'typing': {
      const { chat_id, user_id, on } = m;
      set((s) => {
        const cur = { ...(s.typing[chat_id] ?? {}) };
        if (on) cur[user_id] = Date.now() + 6000; else delete cur[user_id];
        return { typing: { ...s.typing, [chat_id]: cur } };
      });
      if (on) setTimeout(() => set((s) => {
        const cur = { ...(s.typing[chat_id] ?? {}) };
        if (cur[user_id] && cur[user_id] <= Date.now()) { delete cur[user_id]; return { typing: { ...s.typing, [chat_id]: cur } }; }
        return s;
      }), 6100);
      return;
    }
    case 'presence':
      set((s) => {
        const p = { ...s.presence };
        for (const u of m.users) p[u.id] = { online: u.online, last_seen: u.last_seen ?? p[u.id]?.last_seen };
        return { presence: p };
      });
      return;
    case 'error': {
      const id = m.ref as string;
      if (id && inflight.has(id)) {
        inflight.delete(id); await DB.outboxRemove(id);
        const all = S().messages;
        for (const [cid, list] of Object.entries(all)) {
          const lm = list.find((x) => x.client_id === id && x.local);
          if (lm) await S().putMessages(cid, [{ ...lm, local: 'failed' }]);
        }
      }
      return;
    }
  }
}

export async function flushOutbox() {
  if (!ready) return;
  for (const p of await DB.outboxAll()) {
    if (inflight.has(p.client_id)) continue;
    inflight.add(p.client_id);
    send({ t: 'send', message: p });
  }
}

export function watchUsers() {
  const s = S();
  const ids = new Set<string>();
  Object.values(s.chats).forEach((c) => c.members.forEach((m) => m.user_id !== s.me?.id && !m.left_at && ids.add(m.user_id)));
  s.contacts.forEach((c) => ids.add(c.id));
  if (ids.size) send({ t: 'watch', users: [...ids].slice(0, 500) });
}

function scheduleAck() {
  if (ackTimer) return;
  ackTimer = setTimeout(() => { ackTimer = null; send({ t: 'ack', seq: lastSeq }); }, 150);
}

async function onEvent(seq: number, type: string, p: any) {
  if (seq <= lastSeq) return;
  if (lastSeq > 0 && seq !== lastSeq + 1) {
    // gap (out-of-order live delivery): ask the server to replay from our cursor
    if (!syncing) { syncing = true; send({ t: 'sync', since: lastSeq }); }
    return;
  }
  try { await apply(type, p); } finally {
    lastSeq = seq;
    DB.kvSet('last_seq', String(seq));
    scheduleAck();
  }
}

async function apply(type: string, p: any) {
  const me = S().me!;
  switch (type) {
    case 'message': {
      const m = p as Message;
      let chat = S().chats[m.chat_id];
      if (!chat) {
        try { chat = await api.chat(m.chat_id); chat.unread = 0; S().upsertChat(chat); } catch { return; }
        watchUsers();
      }
      const isNew = !chat.last_message || (m.seq ?? 0) > (chat.last_message.seq ?? 0);
      await S().putMessages(m.chat_id, [m]);
      if (m.sender_id !== me.id && isNew) {
        const s = S();
        const watching = s.activeChat === m.chat_id && s.appActive;
        if (!watching) {
          const c = s.chats[m.chat_id];
          S().upsertChat({ ...c, unread: (c.unread ?? 0) + 1 });
        }
        if (s.typing[m.chat_id]?.[m.sender_id]) set((st) => ({ typing: { ...st.typing, [m.chat_id]: {} } }));
      }
      S().markRead(m.chat_id);
      return;
    }
    case 'edit': {
      const m = p as Message;
      const old = S().messages[m.chat_id]?.find((x) => x.id === m.id);
      await S().putMessages(m.chat_id, [{ ...m, local: undefined, created_at: old?.created_at ?? m.created_at }]);
      return;
    }
    case 'delete': {
      const cur = S().messages[p.chat_id]?.find((x) => x.id === p.id);
      if (cur) await S().putMessages(p.chat_id, [{ ...cur, deleted: true, body: '', media: null, reply: null }]);
      const chat = S().chats[p.chat_id];
      if (chat?.last_message?.id === p.id) S().upsertChat({ ...chat, last_message: { ...(chat.last_message as Message), deleted: true, body: "", media: null } });
      return;
    }
    case 'receipt': {
      const chat = S().chats[p.chat_id];
      if (!chat) return;
      const members = chat.members.map((m) => m.user_id !== p.user_id ? m : {
        ...m,
        last_delivered_seq: Math.max(m.last_delivered_seq, p.delivered ?? 0),
        last_read_seq: Math.max(m.last_read_seq, p.read ?? 0),
      });
      let unread = chat.unread;
      if (p.user_id === me.id && p.read) {
        // read on another device (or here) => clear badge + remove the notification
        if (p.read >= (chat.last_message?.seq ?? 0)) unread = 0;
        dismissChatNotifications(p.chat_id);
      }
      S().upsertChat({ ...chat, members, unread });
      return;
    }
    case 'chat': {
      const c = p as Chat;
      const mine = c.members.find((m) => m.user_id === me.id);
      if (!mine || mine.left_at) {
        set((s) => { const chats = { ...s.chats }; delete chats[c.id]; return { chats }; });
        await DB.deleteChat(c.id);
        return;
      }
      S().upsertChat({ ...c, unread: S().chats[c.id]?.unread ?? 0 });
      watchUsers();
      return;
    }
  }
}
