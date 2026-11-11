import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { api, setToken, setUnauthorizedHandler } from './api';
import * as DB from './db';
import { registerForPush, dismissChatNotifications } from './push';
import { rid } from './utils';
import type { Chat, Contact, Media, Message, MsgType, Presence, User } from './types';
import * as RT from './realtime';

type State = {
  booted: boolean;
  token: string | null;
  me: User | null;
  deviceId: string;
  conn: 'connecting' | 'online' | 'offline';
  chats: Record<string, Chat>;
  messages: Record<string, Message[]>;       // ascending by created_at
  typing: Record<string, Record<string, number>>;
  presence: Record<string, Presence>;
  contacts: Contact[];
  aliases: Record<string, string>;
  activeChat: string | null;
  appActive: boolean;

  boot(): Promise<void>;
  login(token: string, user: User): Promise<void>;
  logout(): Promise<void>;
  setMe(u: User): void;
  refreshChats(): Promise<void>;
  refreshContacts(list?: Contact[]): Promise<void>;
  openChat(id: string | null): Promise<void>;
  loadOlder(chatId: string): Promise<void>;
  upsertChat(c: Chat): void;
  putMessages(chatId: string, ms: Message[]): Promise<void>;
  sendMessage(chatId: string, p: { type: MsgType; body?: string; media?: Media; reply_to?: string | null }): Promise<void>;
  retry(m: Message): Promise<void>;
  markRead(chatId: string): void;
  deleteForMe(m: Message): Promise<void>;
};

export const useStore = create<State>((set, get) => ({
  booted: false, token: null, me: null, deviceId: '', conn: 'offline',
  chats: {}, messages: {}, typing: {}, presence: {}, contacts: [], aliases: {},
  activeChat: null, appActive: true,

  async boot() {
    await DB.openDb();
    let deviceId = await SecureStore.getItemAsync('device_id');
    if (!deviceId) { deviceId = 'd' + rid() + rid(); await SecureStore.setItemAsync('device_id', deviceId); }
    const token = await SecureStore.getItemAsync('token');
    const meJson = await DB.kvGet('me');
    setUnauthorizedHandler(() => { get().logout(); });
    if (token && meJson) {
      setToken(token);
      const chats = Object.fromEntries((await DB.loadChats()).map((c) => [c.id, c]));
      const aliases = JSON.parse((await DB.kvGet('aliases')) ?? '{}');
      set({ token, me: JSON.parse(meJson), deviceId, chats, aliases, booted: true });
      RT.start();
      get().refreshChats().catch(() => {});
      get().refreshContacts().catch(() => {});
      registerForPush().then((t) => api.registerDevice(deviceId!, t, Platform.OS).catch(() => {})).catch(() => {});
    } else {
      set({ deviceId, booted: true });
    }
  },

  async login(token, user) {
    await SecureStore.setItemAsync('token', token);
    await DB.wipe();
    await DB.kvSet('me', JSON.stringify(user));
    setToken(token);
    set({ token, me: user, chats: {}, messages: {}, aliases: {}, contacts: [] });
    // remember where the server's event log is NOW, then load the full state
    try { const me = await api.me(); await DB.kvSet('last_seq', String(me.ev_seq)); } catch {}
    RT.start();
    get().refreshChats().catch(() => {});
    registerForPush().then((t) => api.registerDevice(get().deviceId, t, Platform.OS).catch(() => {})).catch(() => {});
  },

  async logout() {
    RT.stop();
    try { await api.unregisterDevice(get().deviceId); } catch {}
    await SecureStore.deleteItemAsync('token');
    await DB.wipe().catch(() => {});
    setToken(null);
    set({ token: null, me: null, chats: {}, messages: {}, contacts: [], aliases: {}, typing: {}, presence: {}, activeChat: null });
  },

  setMe(u) { set({ me: u }); DB.kvSet('me', JSON.stringify(u)); },

  async refreshChats() {
    const list = await api.chats();
    set({ chats: Object.fromEntries(list.map((c) => [c.id, c])) });
    await DB.saveChats(list);
    RT.watchUsers();
  },

  async refreshContacts(list) {
    const contacts = list ?? (await api.contacts());
    const aliases: Record<string, string> = {};
    contacts.forEach((c) => { if (c.alias) aliases[c.id] = c.alias; });
    set({ contacts, aliases });
    DB.kvSet('aliases', JSON.stringify(aliases));
  },

  async openChat(id) {
    set({ activeChat: id });
    if (!id) return;
    const local = await DB.loadMessages(id, 60);
    if (get().activeChat !== id) return;
    set((s) => ({ messages: { ...s.messages, [id]: mergeMsgs(s.messages[id] ?? [], local) } }));
    get().markRead(id);
    try {
      const fresh = await api.history(id, { limit: 60 });
      await get().putMessages(id, fresh);
      get().markRead(id);
    } catch {}
    RT.watchUsers();
  },

  async loadOlder(chatId) {
    const cur = get().messages[chatId] ?? [];
    if (!cur.length) return;
    const oldest = cur[0];
    let older = await DB.loadMessages(chatId, 40, oldest.created_at);
    if (!older.length && oldest.seq) {
      try { older = await api.history(chatId, { before: oldest.seq, limit: 40 }); await DB.saveMessages(older); } catch {}
    }
    if (older.length) set((s) => ({ messages: { ...s.messages, [chatId]: mergeMsgs(s.messages[chatId] ?? [], older) } }));
  },

  upsertChat(c) {
    set((s) => ({ chats: { ...s.chats, [c.id]: { ...c, unread: c.unread ?? s.chats[c.id]?.unread ?? 0 } } }));
    DB.saveChat(get().chats[c.id]);
  },

  async putMessages(chatId, ms) {
    await DB.saveMessages(ms);
    set((s) => {
      const merged = mergeMsgs(s.messages[chatId] ?? [], ms);
      const chat = s.chats[chatId];
      const last = merged[merged.length - 1];
      const chats = chat && last && (!chat.last_message || last.created_at >= chat.last_message.created_at)
        ? { ...s.chats, [chatId]: { ...chat, last_message: last } } : s.chats;
      return { messages: { ...s.messages, [chatId]: merged }, chats };
    });
  },

  async sendMessage(chatId, p) {
    const me = get().me!;
    const client_id = rid();
    const msg: Message = {
      id: 'local:' + client_id, chat_id: chatId, sender_id: me.id, client_id, type: p.type,
      body: p.body ?? '', media: p.media ?? null, reply_to: p.reply_to ?? null,
      reply: p.reply_to ? replySnapshot(get().messages[chatId] ?? [], p.reply_to) : null,
      created_at: Date.now(), local: 'pending',
    };
    await get().putMessages(chatId, [msg]);
    await dispatch(msg);
  },

  async retry(m) {
    const fresh = { ...m, local: 'pending' as const };
    await get().putMessages(m.chat_id, [fresh]);
    await dispatch(fresh);
  },

  markRead(chatId) {
    const s = get();
    if (s.activeChat !== chatId || !s.appActive) return;
    const chat = s.chats[chatId], me = s.me;
    if (!chat || !me) return;
    const mine = chat.members.find((m) => m.user_id === me.id);
    const last = [...(s.messages[chatId] ?? [])].reverse().find((m) => m.sender_id !== me.id && m.seq);
    if (chat.unread > 0 || (last && mine && last.seq! > mine.last_read_seq)) {
      const upto = Math.max(last?.seq ?? 0, chat.last_message?.seq ?? 0);
      set((st) => ({
        chats: { ...st.chats, [chatId]: { ...chat, unread: 0, members: chat.members.map((m) => m.user_id === me.id ? { ...m, last_read_seq: Math.max(m.last_read_seq, upto) } : m) } },
      }));
      DB.saveChat(get().chats[chatId]);
      if (upto) RT.send({ t: 'read', chat_id: chatId, upto });
    }
    dismissChatNotifications(chatId);
  },

  async deleteForMe(m) {
    await DB.hideMessage(m.id);
    set((s) => ({ messages: { ...s.messages, [m.chat_id]: (s.messages[m.chat_id] ?? []).filter((x) => x.id !== m.id) } }));
  },
}));

// ---- helpers -------------------------------------------------------------------------
export function mergeMsgs(a: Message[], b: Message[]): Message[] {
  const byKey = new Map<string, Message>();
  for (const m of [...a, ...b]) {
    // a server message supersedes the local placeholder with the same client_id
    if (m.client_id && !m.id.startsWith('local:')) byKey.delete('local:' + m.client_id);
    if (m.id.startsWith('local:') && m.client_id && [...byKey.values()].some((x) => x.client_id === m.client_id && !x.id.startsWith('local:'))) continue;
    byKey.set(m.id, m);
  }
  return [...byKey.values()].sort((x, y) => x.created_at - y.created_at || (x.seq ?? 1e15) - (y.seq ?? 1e15));
}

function replySnapshot(list: Message[], id: string) {
  const r = list.find((m) => m.id === id);
  return r ? { id: r.id, sender_id: r.sender_id, type: r.type, body: r.body.slice(0, 120) } : null;
}

// Uploads media if needed, then queues the message in the persistent outbox.
async function dispatch(msg: Message) {
  const upd = (patch: Partial<Message>) => useStore.getState().putMessages(msg.chat_id, [{ ...msg, ...patch }]);
  try {
    let media = msg.media ?? null;
    if (media?.local_uri && !media.url) {
      const up = await api.upload(media.local_uri, media.name ?? 'file', media.mime ?? 'application/octet-stream');
      media = { ...media, ...up };
    }
    const payload = {
      chat_id: msg.chat_id, client_id: msg.client_id, type: msg.type, body: msg.body,
      media: media ? { url: media.url, name: media.name, size: media.size, mime: media.mime, duration: media.duration, width: media.width, height: media.height } : null,
      reply_to: msg.reply_to && !msg.reply_to.startsWith('local:') ? msg.reply_to : null,
    };
    await DB.outboxAdd(msg.client_id!, payload);
    RT.flushOutbox();
  } catch {
    await upd({ local: 'failed' });
  }
}
