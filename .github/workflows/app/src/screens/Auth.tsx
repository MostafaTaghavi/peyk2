import React, { useEffect, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Platform, TextInput, View } from 'react-native';
import { api, ApiError } from '../api';
import { Btn, Txt } from '../components/ui';
import { font, useTheme } from '../theme';
import { useStore } from '../store';
import { toFaDigits } from '../utils';

function Shell({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.surface, padding: 24, justifyContent: 'center' }}>
      <Image source={require('../../assets/icon.png')} style={{ width: 96, height: 96, borderRadius: 24, alignSelf: 'center', marginBottom: 24 }} />
      <Txt bold style={{ fontSize: 24, textAlign: 'center' }}>{title}</Txt>
      <Txt dim style={{ textAlign: 'center', marginTop: 8, marginBottom: 28, lineHeight: 24 }}>{sub}</Txt>
      {children}
    </KeyboardAvoidingView>
  );
}
const inputStyle = (t: ReturnType<typeof useTheme>) => ({
  height: 56, borderRadius: 16, backgroundColor: t.surface2, color: t.text, paddingHorizontal: 16,
  fontFamily: font.regular, fontSize: 20, textAlign: 'center' as const, marginBottom: 16, letterSpacing: 2,
});

export function LoginScreen({ navigation }: any) {
  const t = useTheme();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.requestOtp(phone);
      navigation.navigate('Otp', { phone, devCode: r.dev_code });
    } catch (e) {
      Alert.alert('خطا', e instanceof ApiError && e.code === 'invalid_phone' ? 'شماره موبایل معتبر نیست.' : e instanceof ApiError && e.status === 429 ? 'تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید.' : 'ارتباط با سرور برقرار نشد.');
    } finally { setBusy(false); }
  };
  return (
    <Shell title="به پیک خوش آمدید" sub="شماره موبایل خود را وارد کنید تا کد تأیید برایتان پیامک شود.">
      <TextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="۰۹۱۲۱۲۳۴۵۶۷" placeholderTextColor={t.sub} style={inputStyle(t)} />
      <Btn title="دریافت کد تأیید" onPress={go} loading={busy} disabled={phone.replace(/\D/g, '').length < 10} />
    </Shell>
  );
}

export function OtpScreen({ route, navigation }: any) {
  const t = useTheme();
  const { phone, devCode } = route.params;
  const [code, setCode] = useState(devCode ?? '');
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(60);
  const login = useStore((s) => s.login);
  useEffect(() => { const i = setInterval(() => setLeft((l) => Math.max(0, l - 1)), 1000); return () => clearInterval(i); }, []);
  const verify = async () => {
    setBusy(true);
    try {
      const r = await api.verifyOtp(phone, code);
      await login(r.token, r.user);
      // root navigator switches automatically; new users are asked for a name
    } catch (e) {
      Alert.alert('خطا', e instanceof ApiError && e.code === 'code_expired' ? 'کد منقضی شده است.' : 'کد واردشده درست نیست.');
    } finally { setBusy(false); }
  };
  const resend = async () => { try { const r = await api.requestOtp(phone); setLeft(60); if (r.dev_code) setCode(r.dev_code); } catch {} };
  return (
    <Shell title="کد تأیید" sub={`کد ارسال‌شده به ${toFaDigits(phone)} را وارد کنید.`}>
      <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} placeholder="------" placeholderTextColor={t.sub} style={inputStyle(t)} autoFocus />
      <Btn title="ورود" onPress={verify} loading={busy} disabled={code.length < 6} />
      <Btn kind="ghost" title={left ? `ارسال مجدد (${toFaDigits(left)})` : 'ارسال مجدد کد'} onPress={resend} disabled={left > 0} style={{ marginTop: 8 }} />
      <Btn kind="ghost" title="ویرایش شماره" onPress={() => navigation.goBack()} />
    </Shell>
  );
}

export function ProfileScreen() {
  const t = useTheme();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const setMe = useStore((s) => s.setMe);
  const save = async () => { setBusy(true); try { setMe(await api.updateMe({ name: name.trim() })); } catch { Alert.alert('خطا', 'ذخیره انجام نشد.'); } finally { setBusy(false); } };
  return (
    <Shell title="نام شما" sub="دوستانتان با این نام شما را می‌بینند.">
      <TextInput value={name} onChangeText={setName} placeholder="نام و نام خانوادگی" placeholderTextColor={t.sub} style={[inputStyle(t), { letterSpacing: 0, fontSize: 18 }]} maxLength={60} />
      <Btn title="شروع گفتگو" onPress={save} loading={busy} disabled={!name.trim()} />
    </Shell>
  );
}
