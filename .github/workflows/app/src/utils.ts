import type { Chat, Contact, Message, MsgStatus } from './types';

export const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const fmtTime = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });
const fmtShort = new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' });

export const timeOf = (ts: number) => fmtTime.format(ts);
const startOfDay = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function listTime(ts: number) {
  const today = startOfDay(Date.now());
  if (ts >= today) return timeOf(ts);
  if (ts >= today - 86400_000) return 'دیروز';
  if (ts >= today - 6 * 86400_000) return new Intl.DateTimeFormat('fa-IR', { weekday: 'long' }).format(ts);
  return fmtShort.format(ts);
}
export function dayLabel(ts: number) {
  const today = startOfDay(Date.now());
  if (ts >= today) return 'امروز';
  if (ts >= today - 86400_000) return 'دیروز';
  return fmtDate.format(ts);
}
export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

export function lastSeenText(ts?: number | null) {
  if (!ts) return 'اخیراً آنلاین بوده';
  const today = startOfDay(Date.now());
  if (ts >= today) return `آخرین بازدید امروز ${timeOf(ts)}`;
  if (ts >= today - 86400_000) return `آخرین بازدید دیروز ${timeOf(ts)}`;
  return `آخرین بازدید ${fmtShort.format(ts)}`;
}

export const fmtDuration = (sec = 0) => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
};
export const fmtSize = (b = 0) =>
  (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export function msgPreview(m?: Message | null): string {
  if (!m) return '';
  if (m.deleted) return '🚫 این پیام حذف شد';
  const cap = m.body ? ` ${m.body}` : '';
  switch (m.type) {
    case 'image': return `📷 عکس${cap}`;
    case 'video': return `🎬 ویدیو${cap}`;
    case 'audio': return '🎤 پیام صوتی';
    case 'file': return `📎 ${m.media?.name ?? 'فایل'}`;
    default: return m.body;
  }
}

export function chatTitle(chat: Chat, meId: string, aliases: Record<string, string>) {
  if (chat.type === 'group') return chat.title || 'گروه';
  const o = chat.members.find((m) => m.user_id !== meId);
  return (o && (aliases[o.user_id] || o.name || o.phone)) || 'ناشناس';
}
export const otherMember = (chat: Chat, meId: string) => chat.members.find((m) => m.user_id !== meId);

/** WhatsApp-style status derived from the members' delivered/read pointers. */
export function statusOf(m: Message, chat: Chat | undefined, meId: string): MsgStatus {
  if (m.local) return m.local;
  if (!chat || !m.seq) return 'sent';
  const others = chat.members.filter((x) => x.user_id !== meId && !x.left_at);
  if (!others.length) return 'sent';
  if (others.every((x) => x.last_read_seq >= m.seq!)) return 'read';
  if (others.every((x) => x.last_delivered_seq >= m.seq!)) return 'delivered';
  return 'sent';
}

export const colorFor = (s: string) => {
  const palette = ['#FD1D3F', '#7C5CFF', '#16A5A5', '#F59E0B', '#3B82F6', '#EC4899', '#10B981', '#8B5CF6'];
  let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return palette[Math.abs(h) % palette.length];
};
export const initials = (n: string) => (n.trim()[0] ?? '?').toUpperCase();

export const toFaDigits = (s: string | number) => String(s).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
export const displayName = (c: Contact) => c.alias || c.name || c.phone;
