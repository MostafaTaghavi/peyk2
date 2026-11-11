import React, { memo, useEffect, useRef, useState } from 'react';
import { I18nManager, Pressable, StyleSheet, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Audio, AVPlaybackStatus } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { Avatar, Ticks, Txt } from './ui';
import { fileUrl } from '../config';
import { useTheme } from '../theme';
import { colorFor, fmtDuration, fmtSize, msgPreview, timeOf } from '../utils';
import type { Message, MsgStatus } from '../types';

type Props = {
  msg: Message; mine: boolean; status: MsgStatus; senderName?: string; showSender?: boolean;
  replyName?: string;
  onLongPress: (m: Message) => void; onOpenMedia: (m: Message) => void;
  onRetry: (m: Message) => void; onJumpReply: (id: string) => void;
};

function Bubble({ msg, mine, status, senderName, showSender, replyName, onLongPress, onOpenMedia, onRetry, onJumpReply }: Props) {
  const t = useTheme();
  const bg = mine ? t.bubbleOut : t.bubbleIn;
  const fg = mine ? t.bubbleOutText : t.bubbleInText;
  const sub = mine ? 'rgba(255,255,255,.75)' : t.sub;
  // outgoing on the right, incoming on the left (also in RTL)
  const side = (mine ? !I18nManager.isRTL : I18nManager.isRTL) ? 'flex-end' : 'flex-start';

  if (msg.deleted) {
    return (
      <View style={[styles.row, { alignSelf: side }]}>
        <View style={[styles.bubble, { backgroundColor: t.surface2, opacity: 0.8 }]}>
          <Txt dim style={{ fontStyle: 'italic' }}>🚫 این پیام حذف شد</Txt>
        </View>
      </View>
    );
  }

  const media = msg.media;
  const src = fileUrl(media?.local_uri ?? media?.url);

  return (
    <View style={[styles.row, { alignSelf: side }]}>
      <Pressable
        onLongPress={() => onLongPress(msg)} delayLongPress={250}
        onPress={() => (msg.local === 'failed' ? onRetry(msg) : (msg.type === 'image' || msg.type === 'video') && onOpenMedia(msg))}
        style={[styles.bubble, { backgroundColor: bg }, mine ? styles.tailMine : styles.tailTheirs]}>
        {showSender && senderName ? <Txt bold style={{ color: colorFor(senderName), fontSize: 13, marginBottom: 2 }}>{senderName}</Txt> : null}
        {msg.forwarded_from ? (
          <View style={styles.fwd}><Ionicons name="arrow-redo" size={12} color={sub} /><Txt style={{ color: sub, fontSize: 12, marginHorizontal: 4 }}>فوروارد شده از {msg.forwarded_from.name}</Txt></View>
        ) : null}
        {msg.reply ? (
          <TouchableOpacity onPress={() => onJumpReply(msg.reply!.id)} style={[styles.reply, { backgroundColor: mine ? 'rgba(0,0,0,.18)' : t.surface2, borderStartColor: mine ? '#fff' : t.brand }]}>
            <Txt bold style={{ color: mine ? '#fff' : t.brand, fontSize: 12 }}>{replyName ?? ''}</Txt>
            <Txt numberOfLines={1} style={{ color: fg, fontSize: 13, opacity: 0.85 }}>{msgPreview(msg.reply as any)}</Txt>
          </TouchableOpacity>
        ) : null}

        {msg.type === 'image' && src ? (
          <Image source={{ uri: src }} style={[styles.media, aspect(media)]} contentFit="cover" transition={150} />
        ) : null}
        {msg.type === 'video' ? (
          <View style={[styles.media, { backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' }]}>
            <Ionicons name="play-circle" size={54} color="#fff" />
            {media?.duration ? <Txt style={styles.dur}>{fmtDuration(media.duration)}</Txt> : null}
          </View>
        ) : null}
        {msg.type === 'audio' && src ? <AudioPlayer uri={src} duration={media?.duration} mine={mine} color={fg} /> : null}
        {msg.type === 'file' ? (
          <View style={styles.file}>
            <View style={[styles.fileIcon, { backgroundColor: mine ? 'rgba(255,255,255,.22)' : t.surface2 }]}><Ionicons name="document-text" size={24} color={mine ? '#fff' : t.brand} /></View>
            <View style={{ flexShrink: 1, marginHorizontal: 10 }}>
              <Txt numberOfLines={1} style={{ color: fg, maxWidth: 190 }}>{media?.name ?? 'فایل'}</Txt>
              <Txt style={{ color: sub, fontSize: 12 }}>{fmtSize(media?.size)}</Txt>
            </View>
          </View>
        ) : null}

        {msg.body ? <Txt style={{ color: fg, lineHeight: 23, textAlign: 'auto' }}>{msg.body}</Txt> : null}

        <View style={styles.meta}>
          {msg.edited_at ? <Txt style={{ color: sub, fontSize: 11, marginEnd: 4 }}>ویرایش شد</Txt> : null}
          <Txt style={{ color: sub, fontSize: 11 }}>{timeOf(msg.created_at)}</Txt>
          {mine ? <View style={{ marginStart: 4 }}><Ticks status={status} color={sub} /></View> : null}
        </View>
      </Pressable>
    </View>
  );
}

const aspect = (m?: Message['media']) => {
  const r = m?.width && m?.height ? Math.min(Math.max(m.width / m.height, 0.7), 1.6) : 1;
  return { width: 240, height: 240 / r };
};

function AudioPlayer({ uri, duration, mine, color }: { uri: string; duration?: number; mine: boolean; color: string }) {
  const t = useTheme();
  const sound = useRef<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState((duration ?? 0) * 1000);
  useEffect(() => () => { sound.current?.unloadAsync().catch(() => {}); }, []);
  const onStatus = (s: AVPlaybackStatus) => {
    if (!s.isLoaded) return;
    setPos(s.positionMillis); if (s.durationMillis) setDur(s.durationMillis);
    setPlaying(s.isPlaying);
    if (s.didJustFinish) { sound.current?.setPositionAsync(0).catch(() => {}); setPlaying(false); setPos(0); }
  };
  const toggle = async () => {
    if (!sound.current) {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound: s } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true }, onStatus);
      sound.current = s; return;
    }
    playing ? await sound.current.pauseAsync() : await sound.current.playAsync();
  };
  const pct = dur ? Math.min(pos / dur, 1) : 0;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', width: 220, paddingVertical: 4 }}>
      <TouchableOpacity onPress={toggle} style={[styles.play, { backgroundColor: mine ? 'rgba(255,255,255,.25)' : t.brand }]}>
        <Ionicons name={playing ? 'pause' : 'play'} size={20} color="#fff" />
      </TouchableOpacity>
      <View style={{ flex: 1, marginHorizontal: 10 }}>
        <View style={{ height: 4, borderRadius: 2, backgroundColor: mine ? 'rgba(255,255,255,.3)' : t.border, overflow: 'hidden' }}>
          <View style={{ width: `${pct * 100}%`, height: 4, backgroundColor: mine ? '#fff' : t.brand }} />
        </View>
        <Txt style={{ color, fontSize: 11, marginTop: 4, opacity: 0.8 }}>{fmtDuration((playing || pos ? pos : dur) / 1000)}</Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { maxWidth: '84%', marginVertical: 2, marginHorizontal: 10 },
  bubble: { borderRadius: 18, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 6, minWidth: 90 },
  tailMine: { borderBottomEndRadius: 5 },
  tailTheirs: { borderBottomStartRadius: 5 },
  meta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', marginTop: 2 },
  reply: { borderStartWidth: 3, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 6 },
  fwd: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  media: { borderRadius: 12, marginBottom: 6, overflow: 'hidden' },
  dur: { position: 'absolute', bottom: 6, start: 8, color: '#fff', fontSize: 12 },
  file: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, marginBottom: 4 },
  fileIcon: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  play: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
});

export default memo(Bubble);
