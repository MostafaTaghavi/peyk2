import { useColorScheme } from 'react-native';

export const BRAND = '#FD1D3F';
export const NAVY = '#20222F';

const dark = {
  dark: true, brand: BRAND, bg: '#171925', surface: NAVY, surface2: '#2A2D3F', header: NAVY,
  text: '#F2F3F8', sub: '#9AA0B4', border: '#33364A',
  bubbleIn: '#2C2F42', bubbleInText: '#F2F3F8', bubbleOut: BRAND, bubbleOutText: '#FFFFFF',
  tickRead: '#8FE9FF', input: '#2A2D3F', chatBg: '#171925', danger: '#FF5470',
};
const light: typeof dark = {
  dark: false, brand: BRAND, bg: '#F4F5FA', surface: '#FFFFFF', surface2: '#ECEEF5', header: NAVY,
  text: '#1A1C28', sub: '#6B7088', border: '#E2E4EE',
  bubbleIn: '#FFFFFF', bubbleInText: '#1A1C28', bubbleOut: BRAND, bubbleOutText: '#FFFFFF',
  tickRead: '#8FE9FF', input: '#FFFFFF', chatBg: '#ECEEF5', danger: '#D80F2E',
};
export type Theme = typeof dark;
export const useTheme = (): Theme => (useColorScheme() === 'light' ? light : dark);

export const font = { regular: 'Vazir', bold: 'Vazir-Bold' };
