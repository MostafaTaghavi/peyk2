import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useStore } from './src/store';
import { font, NAVY } from './src/theme';
import { onNotificationOpened } from './src/push';
import { LoginScreen, OtpScreen, ProfileScreen } from './src/screens/Auth';
import HomeScreen from './src/screens/Home';
import ChatScreen from './src/screens/Chat';
import ContactsScreen from './src/screens/Contacts';

const Stack = createNativeStackNavigator<any>();
const nav = createNavigationContainerRef<any>();

export default function App() {
  const [fontsLoaded] = useFonts({ Vazir: require('./assets/fonts/Vazirmatn-Regular.ttf'), 'Vazir-Bold': require('./assets/fonts/Vazirmatn-Bold.ttf') });
  const { booted, token, me, boot } = useStore();
  useEffect(() => { boot(); }, []);
  useEffect(() => onNotificationOpened((chatId) => { if (nav.isReady()) nav.navigate('Chat', { chatId }); }), []);

  if (!fontsLoaded || !booted) {
    return <View style={{ flex: 1, backgroundColor: NAVY, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color="#FD1D3F" /></View>;
  }
  const header = { headerStyle: { backgroundColor: NAVY }, headerTintColor: '#fff', headerTitleStyle: { fontFamily: font.bold }, headerShadowVisible: false };
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer ref={nav}>
        <Stack.Navigator screenOptions={header}>
          {!token ? (
            <>
              <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
              <Stack.Screen name="Otp" component={OtpScreen} options={{ headerShown: false }} />
            </>
          ) : !me?.name ? (
            <Stack.Screen name="Profile" component={ProfileScreen} options={{ headerShown: false }} />
          ) : (
            <>
              <Stack.Screen name="Home" component={HomeScreen} />
              <Stack.Screen name="Chat" component={ChatScreen} />
              <Stack.Screen name="Contacts" component={ContactsScreen} options={{ title: 'گفتگوی تازه' }} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
