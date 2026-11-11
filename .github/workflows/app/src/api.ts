import * as FileSystem from 'expo-file-system';
import { API_URL } from './config';
import type { Chat, Contact, Media, Message, User } from './types';

let token: string | null = null;
let onUnauthorized: (() => void) | null = null;
export const setToken = (t: string | null) => { token = t; };
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(public status: number, public code: string, public data?: any) { super(code); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  const json = await res.json().catch(() => null);
  if (res.status === 401 && token) onUnauthorized?.();
  if (!res.ok) throw new ApiError(res.status, json?.error ?? 'error', json);
  return json as T;
}

export const api = {
  requestOtp: (phone: string) => req<{ ok: boolean; expires_in: number; dev_code?: string }>('POST', '/auth/otp', { phone }),
  verifyOtp: (phone: string, code: string) =>
    req<{ token: string; user: User; is_new: boolean }>('POST', '/auth/verify', { phone, code }),
  me: () => req<User & { ev_seq: number }>('GET', '/me'),
  updateMe: (b: Partial<Pick<User, 'name' | 'about' | 'avatar'>>) => req<User>('PUT', '/me', b),
  registerDevice: (device_id: string, push_token: string | null, platform: string) =>
    req('POST', '/devices', { device_id, push_token, platform }),
  unregisterDevice: (device_id: string) => req('DELETE', `/devices/${device_id}`),
  contacts: () => req<Contact[]>('GET', '/contacts'),
  syncContacts: (contacts: { phone: string; name?: string }[]) => req<Contact[]>('POST', '/contacts/sync', { contacts }),
  addContact: (phone: string, name?: string) => req<Contact>('POST', '/contacts', { phone, name }),
  chats: () => req<Chat[]>('GET', '/chats'),
  chat: (id: string) => req<Chat>('GET', `/chats/${id}`),
  directChat: (user_id: string) => req<Chat>('POST', '/chats/direct', { user_id }),
  createGroup: (title: string, member_ids: string[]) => req<Chat>('POST', '/chats/group', { title, member_ids }),
  updateGroup: (id: string, b: { title?: string; add_member_ids?: string[] }) => req<Chat>('PUT', `/chats/${id}`, b),
  leaveGroup: (id: string, uid = 'me') => req('DELETE', `/chats/${id}/members/${uid}`),
  history: (id: string, q: { before?: number; after?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => v !== undefined && p.set(k, String(v)));
    return req<Message[]>('GET', `/chats/${id}/messages?${p}`);
  },
  upload: async (uri: string, name: string, mime: string): Promise<Media> => {
    const r = await FileSystem.uploadAsync(`${API_URL}/upload`, uri, {
      httpMethod: 'POST', uploadType: FileSystem.FileSystemUploadType.MULTIPART, fieldName: 'file',
      mimeType: mime, parameters: {}, headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (r.status !== 200) throw new ApiError(r.status, 'upload_failed');
    const j = JSON.parse(r.body);
    return { url: j.url, name: j.name || name, size: j.size, mime: j.mime || mime };
  },
};
