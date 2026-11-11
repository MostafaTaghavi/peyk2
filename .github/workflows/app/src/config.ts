export const API_URL = (process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:3000').replace(/\/$/, '');
export const WS_URL = API_URL.replace(/^http/, 'ws') + '/ws';
export const fileUrl = (u?: string | null) => (!u ? undefined : /^(https?:|file:|content:)/.test(u) ? u : API_URL + u);
