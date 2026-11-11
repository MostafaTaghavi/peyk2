import React, { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Alert, FlatList, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import Bubble from '../components/MessageBubble';
import Composer, { Banner } from '../components/Composer';
import { Sheet, SheetItem, Txt } from '../components/ui';
import { useTheme } from '../theme';
import { useStore } from '../store';
import * as RT from '../realtime';
import { chatTitle, dayLabel, lastSeenText, otherMember, sameDay, statusOf, msgPreview } from '../utils';
import type { Message } from '../types';

export default function ChatScreen({ route, navigation }: any) {
  const t = useTheme();
  const chatId: string = route.params.chatId;
  const { chats, messages, me, aliases, presence, typing, openChat, loadOlder, sendMessage, retry, deleteForMe } = useStore();
  const chat = chats[chatId];
  const list = messages[chatId] ?? [];
  const [sel, setSel] = useState<Message | null>(null);
  const [attach, setAttach] = useState(false);
  const [reply, setReply] = useState<Message | null>(null);
  const [edit, setEdit] = useState<Message | null>(null);

  useEffect(() => { openChat(chatId); return () => { openChat(null); }; }, [chatId]);

  const name = (uid: string) => {
    const m = chat?.members.find((x) => x.user_id === uid);
    return uid === me!.id ? 'شما' : aliases[uid] || m?.name || m?.phone || '';
  };
  const other = chat ? otherMember(chat, me!.id) : undefined;
  const typers = Object.keys(typing[chatId] ?? {});
  const status = !chat ? '' : typers.length ? 'در حال تایپ…'
    : chat.type === 'group' ? `${chat.members.filter((m) => !m.left_at).length} عضو`
    : presence[other!.user_id]?.online ? 'آنلاین' : lastSeenText(presence[other!.user_id]?.last_seen);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <View>
          <Txt bold style={{ color: '#fff', fontSize: 16 }}>{chat ? chatTitle(chat, me!.id, aliases) : ''}</Txt>
          <Txt style={{ color: typers.length || status === 'آنلاین' ? '#7CF3A8' : '#B6BAD0', fontSize: 12 }}>{status}</Txt>
        </View>
      ),
    });
  }, [chat, status]);

  const data = useMemo(() => [...list].reverse(), [list]);

  const pick = async (kind: 'gallery' | 'file') => {
    if (kind === 'gallery') {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.8 });
      const a = r.assets?.[0]; if (r.canceled || !a) return;
      const isVid = a.type === 'video';
      sendMessage(chatId, { type: isVid ? 'video' : 'image', media: { url: '', local_uri: a.uri, name: a.fileName ?? (isVid ? 'video.mp4' : 'photo.jpg'), mime: a.mimeType ?? (isVid ? 'video/mp4' : 'image/jpeg'), width: a.width, height: a.height, duration: a.duration ? a.duration / 1000 : undefined } });
    } else {
      const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      const a = r.assets?.[0]; if (r.canceled || !a) return;
      sendMessage(chatId, { type: 'file', media: { url: '', local_uri: a.uri, name: a.name, size: a.size, mime: a.mimeType ?? 'application/octet-stream' } });
    }
  };

  const actions = (m: Message): SheetItem[] => {
    const mine = m.sender_id === me!.id;
    const a: SheetItem[] = [];
    if (!m.deleted && !m.local) a.push({ label: 'پاسخ', icon: 'arrow-undo', onPress: () => { setEdit(null); setReply(m); } });
    if (m.body) a.push({ label: 'کپی', icon: 'copy-outline', onPress: () => Clipboard.setStringAsync(m.body) });
    if (mine && !m.deleted && !m.local && Date.now() - m.created_at < 48 * 3600_000) a.push({ label: 'ویرایش', icon: 'create-outline', onPress: () => { setReply(null); setEdit(m); } });
    a.push({ label: 'حذف برای من', icon: 'trash-outline', danger: true, onPress: () => deleteForMe(m) });
    if (mine && !m.deleted && !m.local) a.push({ label: 'حذف برای همه', icon: 'trash', danger: true, onPress: () => RT.send({ t: 'delete', id: m.id }) });
    return a;
  };

  const banner: Banner = edit ? { kind: 'edit', title: 'ویرایش پیام', text: msgPreview(edit) }
    : reply ? { kind: 'reply', title: `پاسخ به ${name(reply.sender_id)}`, text: msgPreview(reply) } : null;

  if (!chat) return <View style={{ flex: 1, backgroundColor: t.chatBg }} />;

  return (
    <View style={{ flex: 1, backgroundColor: t.chatBg }}>
      <FlatList
        inverted data={data} keyExtractor={(m) => m.id}
        contentContainerStyle={{ paddingVertical: 8 }}
        onEndReached={() => loadOlder(chatId)} onEndReachedThreshold={0.4}
        renderItem={({ item, index }) => {
          const older = data[index + 1];
          return (
            <View>
              {!older || !sameDay(older.created_at, item.created_at) ? (
                <View style={{ alignSelf: 'center', backgroundColor: t.surface2, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 3, marginVertical: 8 }}>
                  <Txt dim style={{ fontSize: 12 }}>{dayLabel(item.created_at)}</Txt>
                </View>
              ) : null}
              <Bubble
                msg={item} mine={item.sender_id === me!.id} status={statusOf(item, chat, me!.id)}
                showSender={chat.type === 'group' && item.sender_id !== me!.id && older?.sender_id !== item.sender_id}
                senderName={name(item.sender_id)} replyName={item.reply ? name(item.reply.sender_id) : undefined}
                onLongPress={setSel} onOpenMedia={() => {}} onRetry={retry} onJumpReply={() => {}}
              />
            </View>
          );
        }}
      />
      <Composer
        banner={banner} initialText={edit?.body}
        onCancelBanner={() => { setReply(null); setEdit(null); }}
        onTyping={(on) => RT.send({ t: 'typing', chat_id: chatId, on })}
        onAttach={() => setAttach(true)}
        onVoice={(uri, sec) => sendMessage(chatId, { type: 'audio', media: { url: '', local_uri: uri, name: 'voice.m4a', mime: 'audio/m4a', duration: sec } })}
        onSend={(text) => {
          if (edit) { RT.send({ t: 'edit', id: edit.id, body: text }); setEdit(null); return; }
          sendMessage(chatId, { type: 'text', body: text, reply_to: reply?.id }); setReply(null);
        }}
      />
      <Sheet visible={!!sel} onClose={() => setSel(null)} items={sel ? actions(sel) : []} />
      <Sheet visible={attach} onClose={() => setAttach(false)} title="ارسال"
        items={[{ label: 'عکس و ویدیو', icon: 'images-outline', onPress: () => pick('gallery') }, { label: 'فایل', icon: 'document-outline', onPress: () => pick('file') }]} />
    </View>
  );
}
