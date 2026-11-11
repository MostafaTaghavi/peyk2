import React from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextProps, View, ViewStyle, StyleProp, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { font, useTheme } from '../theme';
import { fileUrl } from '../config';
import { colorFor, initials } from '../utils';
import type { MsgStatus } from '../types';

export function Txt({ bold, dim, style, ...p }: TextProps & { bold?: boolean; dim?: boolean }) {
  const t = useTheme();
  return <Text {...p} style={[{ fontFamily: bold ? font.bold : font.regular, color: dim ? t.sub : t.text, fontSize: 15 }, style]} />;
}

export function Avatar({ name, uri, size = 48 }: { name: string; uri?: string | null; size?: number }) {
  if (uri) return <Image source={{ uri: fileUrl(uri) }} style={{ width: size, height: size, borderRadius: size / 2 }} />;
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: colorFor(name || '?'), alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontFamily: font.bold, fontSize: size * 0.42 }}>{initials(name || '?')}</Text>
    </View>
  );
}

export function Ticks({ status, color }: { status: MsgStatus; color?: string }) {
  const t = useTheme();
  const c = color ?? 'rgba(255,255,255,.75)';
  switch (status) {
    case 'pending': return <Ionicons name="time-outline" size={14} color={c} />;
    case 'failed': return <Ionicons name="alert-circle" size={15} color="#FFD166" />;
    case 'sent': return <Ionicons name="checkmark" size={15} color={c} />;
    case 'delivered': return <Ionicons name="checkmark-done" size={16} color={c} />;
    case 'read': return <Ionicons name="checkmark-done" size={16} color={t.tickRead} />;
  }
}

export function Btn({ title, onPress, loading, disabled, style, kind = 'primary' }: {
  title: string; onPress: () => void; loading?: boolean; disabled?: boolean; style?: StyleProp<ViewStyle>; kind?: 'primary' | 'ghost';
}) {
  const t = useTheme();
  const off = disabled || loading;
  return (
    <TouchableOpacity
      activeOpacity={0.85} onPress={onPress} disabled={off}
      style={[{ height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: kind === 'primary' ? t.brand : 'transparent', opacity: off ? 0.55 : 1 }, style]}>
      {loading ? <ActivityIndicator color="#fff" /> : <Txt bold style={{ color: kind === 'primary' ? '#fff' : t.brand, fontSize: 16 }}>{title}</Txt>}
    </TouchableOpacity>
  );
}

export type SheetItem = { label: string; icon: keyof typeof Ionicons.glyphMap; onPress: () => void; danger?: boolean };
export function Sheet({ visible, onClose, items, title }: { visible: boolean; onClose: () => void; items: SheetItem[]; title?: string }) {
  const t = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={[styles.sheet, { backgroundColor: t.surface }]}>
          {title ? <Txt dim style={{ textAlign: 'center', paddingVertical: 8 }} numberOfLines={1}>{title}</Txt> : null}
          {items.map((it) => (
            <TouchableOpacity key={it.label} style={styles.sheetRow} onPress={() => { onClose(); setTimeout(it.onPress, 120); }}>
              <Ionicons name={it.icon} size={22} color={it.danger ? t.danger : t.text} />
              <Txt style={{ color: it.danger ? t.danger : t.text, marginHorizontal: 14, fontSize: 16 }}>{it.label}</Txt>
            </TouchableOpacity>
          ))}
        </View>
      </Pressable>
    </Modal>
  );
}

export const Separator = () => {
  const t = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginStart: 76 }} />;
};

export function Empty({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, opacity: 0.8 }}>
      <Ionicons name={icon} size={56} color={t.sub} />
      <Txt dim style={{ marginTop: 12, textAlign: 'center', lineHeight: 24 }}>{text}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,.5)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingVertical: 10, paddingBottom: 28 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 14 },
});
