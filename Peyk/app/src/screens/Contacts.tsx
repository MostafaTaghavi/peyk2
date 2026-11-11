import React, { useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, TextInput, TouchableOpacity, View } from 'react-native';
import * as ContactsLib from 'expo-contacts';
import { Avatar, Btn, Empty, Separator, Txt } from '../components/ui';
import { api } from '../api';
import { font, useTheme } from '../theme';
import { useStore } from '../store';
import { displayName } from '../utils';

export default function ContactsScreen({ navigation }: any) {
  const t = useTheme();
  const { contacts, refreshContacts } = useStore();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  const sync = async () => {
    setBusy(true);
    try {
      const { status } = await ContactsLib.requestPermissionsAsync();
      if (status !== 'granted') return;
      const { data } = await ContactsLib.getContactsAsync({ fields: [ContactsLib.Fields.PhoneNumbers, ContactsLib.Fields.Name] });
      const items = data.flatMap((c) => (c.phoneNumbers ?? []).map((p) => ({ phone: p.number ?? '', name: c.name })));
      await refreshContacts(await api.syncContacts(items));
    } catch {} finally { setBusy(false); }
  };
  useEffect(() => { sync(); }, []);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? contacts.filter((c) => `${displayName(c)} ${c.phone}`.toLowerCase().includes(s)) : contacts;
  }, [contacts, q]);

  const open = async (userId: string) => {
    try { const c = await api.directChat(userId); useStore.getState().upsertChat({ ...c, unread: 0 }); navigation.replace('Chat', { chatId: c.id }); }
    catch { Alert.alert('خطا', 'باز کردن گفتگو ممکن نشد.'); }
  };
  const byNumber = async () => {
    try { const c = await api.addContact(q); await refreshContacts(); open(c.id); }
    catch { Alert.alert('پیدا نشد', 'این شماره هنوز در پیک ثبت‌نام نکرده است.'); }
  };

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <TextInput value={q} onChangeText={setQ} placeholder="جستجوی نام یا شماره" placeholderTextColor={t.sub}
        style={{ margin: 12, height: 44, borderRadius: 14, backgroundColor: t.surface2, color: t.text, paddingHorizontal: 14, fontFamily: font.regular, textAlign: 'auto' }} />
      {/^[+\d۰-۹\s]{8,}$/.test(q) && !list.length ? <Btn title="شروع گفتگو با این شماره" onPress={byNumber} style={{ marginHorizontal: 12 }} /> : null}
      <FlatList
        data={list} keyExtractor={(c) => c.id} ItemSeparatorComponent={Separator} refreshing={busy} onRefresh={sync}
        ListEmptyComponent={<Empty icon="people-outline" text="هنوز مخاطبی از پیک پیدا نشد. شماره‌ی دوستتان را در جستجو وارد کنید." />}
        renderItem={({ item }) => (
          <TouchableOpacity onPress={() => open(item.id)} style={{ flexDirection: 'row', alignItems: 'center', padding: 12 }}>
            <Avatar name={displayName(item)} uri={item.avatar} size={46} />
            <View style={{ marginHorizontal: 12, flex: 1 }}>
              <Txt bold>{displayName(item)}</Txt>
              <Txt dim numberOfLines={1} style={{ fontSize: 13 }}>{item.about || item.phone}</Txt>
            </View>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}
