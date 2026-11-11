// Push notifications.
// Rules implemented (together with the server):
//  1. The server only pushes a message that is still UNREAD after a short grace period and
//     only when the app is not in the foreground.
//  2. The notification stays in the tray until the message is READ (on this or any other device).
//     When it is read, the server sends a silent "clear" push and the app also dismisses it locally.
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const BG_TASK = 'PEYK_BACKGROUND_NOTIFICATION';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function dismissChatNotifications(chatId: string) {
  try {
    const shown = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      shown
        .filter((n) => (n.request.content.data as any)?.chat_id === chatId)
        .map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
    );
  } catch {}
}

// Silent (data-only) push => runs even when the app is in the background.
TaskManager.defineTask(BG_TASK, async ({ data }: any) => {
  try {
    const candidates = [data, data?.data, data?.notification?.data];
    for (const c of candidates) {
      let d = c;
      if (typeof c?.dataString === 'string') d = JSON.parse(c.dataString);
      if (typeof c?.body === 'string' && c.body.startsWith('{')) d = JSON.parse(c.body);
      if (d?.type === 'clear' && d?.chat_id) { await dismissChatNotifications(d.chat_id); return; }
    }
  } catch {}
});
Notifications.registerTaskAsync(BG_TASK).catch(() => {});

export async function registerForPush(): Promise<string | null> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('messages', {
      name: 'پیام‌ها', importance: Notifications.AndroidImportance.MAX,
      lightColor: '#FD1D3F', vibrationPattern: [0, 200, 100, 200], lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
  }
  if (!Device.isDevice) return null;
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null;
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId;
  try {
    return (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
  } catch { return null; }
}

export function onNotificationOpened(cb: (chatId: string) => void) {
  const open = (r: Notifications.NotificationResponse) => {
    const id = (r.notification.request.content.data as any)?.chat_id;
    if (id) cb(id);
  };
  Notifications.getLastNotificationResponseAsync().then((r) => r && open(r));
  const sub = Notifications.addNotificationResponseReceivedListener(open);
  return () => sub.remove();
}
