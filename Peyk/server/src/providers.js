// SMS + Push providers (pluggable).

export function createSms(cfg) {
  if (cfg.smsProvider === 'kavenegar') {
    return {
      name: 'kavenegar',
      async sendOtp(phone, code) {
        const receptor = phone.replace(/^\+98/, '0');
        const url = `https://api.kavenegar.com/v1/${cfg.kavenegarKey}/verify/lookup.json` +
          `?receptor=${encodeURIComponent(receptor)}&token=${code}&template=${cfg.kavenegarTemplate}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`kavenegar ${r.status}`);
      },
    };
  }
  return {
    name: 'console',
    async sendOtp(phone, code) { console.log(`[SMS:console] ${phone} -> ${code}`); },
  };
}

// push.send(tokens, {title, body, data, tag, silent}) -> {invalid: string[]}
export function createPush(cfg) {
  if (cfg.pushProvider === 'expo') {
    return {
      name: 'expo',
      async send(tokens, n) {
        if (!tokens.length) return { invalid: [] };
        const messages = tokens.map((to) => n.silent
          ? { to, data: n.data, priority: 'high', _contentAvailable: true }
          : {
              to, title: n.title, body: n.body, data: n.data, sound: 'default',
              priority: 'high', channelId: 'messages', _displayInUnreadAcc: true,
            });
        const r = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.expoAccessToken ? { authorization: `Bearer ${cfg.expoAccessToken}` } : {}),
          },
          body: JSON.stringify(messages),
        });
        if (!r.ok) throw new Error(`expo push ${r.status}`);
        const j = await r.json();
        const invalid = [];
        (j.data || []).forEach((t, i) => {
          if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') invalid.push(tokens[i]);
        });
        return { invalid };
      },
    };
  }
  if (cfg.pushProvider === 'memory') {
    const sent = [];
    return { name: 'memory', sent, async send(tokens, n) { sent.push({ tokens, ...n }); return { invalid: [] }; } };
  }
  return {
    name: 'console',
    async send(tokens, n) { console.log('[PUSH:console]', tokens.length, 'device(s)', JSON.stringify(n)); return { invalid: [] }; },
  };
}
