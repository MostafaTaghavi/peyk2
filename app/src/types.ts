export type Media = {
  url: string; name?: string; size?: number; mime?: string;
  duration?: number; width?: number; height?: number; local_uri?: string;
};
export type MsgType = 'text' | 'image' | 'video' | 'file' | 'audio';
export type Message = {
  id: string; seq?: number; chat_id: string; sender_id: string; client_id?: string | null;
  type: MsgType; body: string; media?: Media | null;
  reply_to?: string | null;
  reply?: { id: string; sender_id: string; type: MsgType; body: string } | null;
  forwarded_from?: { user_id: string; name: string } | null;
  created_at: number; edited_at?: number | null; deleted?: boolean;
  local?: 'pending' | 'failed';
};
export type Member = {
  user_id: string; role: string; left_at?: number | null;
  last_delivered_seq: number; last_read_seq: number;
  name: string; phone: string; avatar?: string | null; about?: string;
};
export type Chat = {
  id: string; type: 'direct' | 'group'; title?: string | null; avatar?: string | null;
  created_by?: string; created_at: number; updated_at: number;
  members: Member[]; last_message: Message | null; unread: number;
};
export type User = { id: string; phone: string; name: string; about?: string; avatar?: string | null };
export type Contact = User & { alias?: string | null };
export type Presence = { online: boolean; last_seen?: number | null };
export type MsgStatus = 'pending' | 'failed' | 'sent' | 'delivered' | 'read';

export type RootStackParams = {
  Login: undefined;
  Otp: { phone: string; devCode?: string };
  Profile: undefined;
  Home: undefined;
  Chat: { chatId: string };
  Contacts: undefined;
  NewGroup: undefined;
  GroupInfo: { chatId: string };
  Forward: { messageIds: string[] };
  Settings: undefined;
};
