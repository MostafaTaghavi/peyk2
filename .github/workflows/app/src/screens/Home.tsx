import React, { useLayoutEffect, useMemo, useState } from 'react';
import { FlatList, TextInput, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Avatar, Empty, Separator, Ticks, Txt } from '../components/ui';
import { font, useTheme } from '../theme';
import { useStore } from '../store';
import { chatTitle, listTime, msgPreview, otherMember, statusOf, toFaDigits } from '../utils';

export default function HomeScreen({ navigation }: any) {
  const t = useTheme();
  const { chats, me, aliases, conn, typing } = useStore();
  const [q, setQ] = useState('');
  useLayoutEffect(() => {
    navigation.setOptions({
      title: conn === 'online' ? 'پیک' : conn === 'connecting' ? 'در حال اتصال…' : 'پیک (آفلاین)',
      headerLeft: () => (
        <TouchableOpacity onPress={() => navigation.navigate('Contacts')} style={{ marginHorizontal: 8 }}>
          <Ionicons name="create-outline" size={24} color="#fff" />
        </TouchableOpacity>
      ),
    });
  }, [conn]);
  const list = useMemo(() => {
    const arr = Object.values(chats).map((c) => ({ c, title: chatTitle(c, me!.id, aliases) }));
    const f = q.trim() ? arr.filter((x) => x.title.includes(q.trim()) || msgPreview(x.c.last_message).includes(q.trim())) : arr;
    return f.sort((a, b) => (b.c.last_message?.created_at ?? b.c.updated_at) - (a.c.last_message?.created_at ?? a.c.updated_at));
  }, [chats, q, aliases, me]);

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <TextInput
        value={q} onChangeText={setQ} placeholder="جستجو در گفتگوها" placeholderTextColor={t.sub}
        style={{ margin: 12, height: 44, borderRadius: 14, backgroundColor: t.surface2, color: t.text, paddingHorizontal: 14, fontFamily: font.regular, textAlign: 'auto' }}
      />
      <FlatList
        data={list} keyExtractor={(x) => x.c.id}
        ItemSeparatorComponent={Separator}
        ListEmptyComponent={<Empty icon="chatbubbles-outline" text={'هنوز گفتگویی ندارید.\nبا دکمه‌ی پایین یک گفتگوی تازه شروع کنید.'} />}
        renderItem={({ item: { c, title } }) => {
          const lm = c.last_message;
          const other = otherMember(c, me!.id);
          const typers = Object.keys(typing[c.id] ?? {});
          const mine = lm?.sender_id === me!.id;
          return (
            <TouchableOpacity onPress={() => navigation.navigate('Chat', { chatId: c.id })} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 10 }}>
              <Avatar name={title} uri={c.type === 'group' ? c.avatar : other?.avatar} size={52} />
              <View style={{ flex: 1, marginHorizontal: 12 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Txt bold numberOfLines={1} style={{ flex: 1, fontSize: 16 }}>{title}</Txt>
                  {lm ? <Txt dim style={{ fontSize: 12, color: c.unread ? t.brand : t.sub }}>{listTime(lm.created_at)}</Txt> : null}
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3 }}>
                  {mine && lm && !lm.deleted ? <View style={{ marginEnd: 4 }}><Ticks status={statusOf(lm, c, me!.id)} color={t.sub} /></View> : null}
                  <Txt dim numberOfLines={1} style={{ flex: 1, fontSize: 14, color: typers.length ? t.brand : t.sub }}>
                    {typers.length ? 'در حال تایپ…' : msgPreview(lm)}
                  </Txt>
                  {c.unread > 0 ? (
                    <View style={{ minWidth: 22, height: 22, borderRadius: 11, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }}>
                      <Txt bold style={{ color: '#fff', fontSize: 12 }}>{toFaDigits(c.unread > 99 ? '99+' : c.unread)}</Txt>
                    </View>
                  ) : null}
                </View>
              </View>
            </TouchableOpacity>
          );
        }}
      />
      <TouchableOpacity onPress={() => navigation.navigate('Contacts')} style={{ position: 'absolute', end: 20, bottom: 28, width: 58, height: 58, borderRadius: 29, backgroundColor: t.brand, alignItems: 'center', justifyContent: 'center', elevation: 6 }}>
        <Ionicons name="chatbubble-ellipses" size={26} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}
