import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, TouchableOpacity, View } from 'react-native';
import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { Txt } from './ui';
import { font, useTheme } from '../theme';
import { fmtDuration } from '../utils';

export type Banner = { kind: 'reply' | 'edit'; title: string; text: string } | null;

type Props = {
  banner: Banner;
  initialText?: string;
  onCancelBanner: () => void;
  onSend: (text: string) => void;
  onAttach: () => void;
  onVoice: (uri: string, durationSec: number) => void;
  onTyping: (on: boolean) => void;
};

export default function Composer({ banner, initialText, onCancelBanner, onSend, onAttach, onVoice, onTyping }: Props) {
  const t = useTheme();
  const [text, setText] = useState('');
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recSec, setRecSec] = useState(0);
  const typingOn = useRef(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recStart = useRef(0);

  useEffect(() => { if (initialText !== undefined) setText(initialText); }, [initialText, banner?.kind]);
  useEffect(() => () => { idle.current && clearTimeout(idle.current); }, []);
  useEffect(() => {
    if (!recording) return;
    const i = setInterval(() => setRecSec(Math.floor((Date.now() - recStart.current) / 1000)), 250);
    return () => clearInterval(i);
  }, [recording]);

  const change = (v: string) => {
    setText(v);
    if (banner?.kind === 'edit') return;
    if (v && !typingOn.current) { typingOn.current = true; onTyping(true); }
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => { if (typingOn.current) { typingOn.current = false; onTyping(false); } }, 3500);
    if (!v && typingOn.current) { typingOn.current = false; onTyping(false); }
  };
  const submit = () => {
    const v = text.trim();
    if (!v) return;
    setText('');
    if (typingOn.current) { typingOn.current = false; onTyping(false); }
    onSend(v);
  };

  const startRec = async () => {
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) { Alert.alert('دسترسی میکروفون', 'برای ضبط پیام صوتی اجازه‌ی میکروفون را فعال کنید.'); return; }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording: r } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recStart.current = Date.now(); setRecSec(0); setRecording(r);
    } catch {}
  };
  const stopRec = async (send: boolean) => {
    const r = recording; if (!r) return;
    setRecording(null);
    try {
      await r.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const sec = (Date.now() - recStart.current) / 1000;
      const uri = r.getURI();
      if (send && uri && sec >= 1) onVoice(uri, sec);
    } catch {}
  };

  const hasText = text.trim().length > 0;

  return (
    <View style={{ backgroundColor: t.bg }}>
      {banner ? (
        <View style={[styles.banner, { backgroundColor: t.surface, borderStartColor: t.brand }]}>
          <View style={{ flex: 1 }}>
            <Txt bold style={{ color: t.brand, fontSize: 13 }}>{banner.title}</Txt>
            <Txt dim numberOfLines={1} style={{ fontSize: 13 }}>{banner.text}</Txt>
          </View>
          <TouchableOpacity onPress={() => { onCancelBanner(); if (banner.kind === 'edit') setText(''); }} hitSlop={10}>
            <Ionicons name="close" size={22} color={t.sub} />
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={styles.bar}>
        {recording ? (
          <View style={[styles.input, { backgroundColor: t.input, flexDirection: 'row', alignItems: 'center' }]}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.brand, marginEnd: 8 }} />
            <Txt>{fmtDuration(recSec)}</Txt>
            <Txt dim style={{ marginStart: 12, flex: 1 }}>در حال ضبط… دکمه را رها کنید تا ارسال شود</Txt>
          </View>
        ) : (
          <View style={[styles.input, { backgroundColor: t.input, flexDirection: 'row', alignItems: 'flex-end' }]}>
            <TouchableOpacity onPress={onAttach} hitSlop={8} style={{ paddingBottom: 4, paddingEnd: 6 }}>
              <Ionicons name="attach" size={26} color={t.sub} />
            </TouchableOpacity>
            <TextInput
              value={text} onChangeText={change} multiline placeholder="پیام…" placeholderTextColor={t.sub}
              style={{ flex: 1, maxHeight: 120, color: t.text, fontFamily: font.regular, fontSize: 16, paddingTop: 6, paddingBottom: 6, textAlign: 'auto' }}
            />
          </View>
        )}
        {hasText ? (
          <TouchableOpacity onPress={submit} style={[styles.fab, { backgroundColor: t.brand }]}>
            <Ionicons name={banner?.kind === 'edit' ? 'checkmark' : 'send'} size={banner?.kind === 'edit' ? 26 : 20} color="#fff" style={banner?.kind === 'edit' ? undefined : { transform: [{ scaleX: -1 }] }} />
          </TouchableOpacity>
        ) : (
          <Pressable onPressIn={startRec} onPressOut={() => stopRec(true)} style={[styles.fab, { backgroundColor: recording ? '#ff6a82' : t.brand, transform: [{ scale: recording ? 1.2 : 1 }] }]}>
            <Ionicons name="mic" size={24} color="#fff" />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', marginHorizontal: 10, marginTop: 6, padding: 8, borderRadius: 12, borderStartWidth: 4 },
  bar: { flexDirection: 'row', alignItems: 'flex-end', padding: 8 },
  input: { flex: 1, borderRadius: 24, paddingHorizontal: 12, paddingVertical: 4, minHeight: 48, marginEnd: 8 },
  fab: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});
