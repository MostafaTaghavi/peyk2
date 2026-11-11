# Peyk (پیک) – Messenger MVP

server/  Node 22 + Express + ws. SQLite (dev) or PostgreSQL (DATABASE_URL), memory bus or Redis (REDIS_URL).
app/     Expo (React Native, TypeScript), RTL/Persian, local SQLite storage.
design/  icon generator (icon.py) + exported icons (also in app/assets).

## Run server
cd server && npm install && npm start      # tests: npm test
Env: JWT_SECRET (required in production), SMS_PROVIDER=kavenegar + KAVENEGAR_KEY, PUSH_PROVIDER=expo,
     DATABASE_URL=postgres://..., REDIS_URL=redis://..., PUSH_DELAY_MS=3000
In dev the OTP code is returned in the API response (dev_code) and printed in the console.

## Run app
cd app && npm install && cp .env.example .env   # set EXPO_PUBLIC_API_URL to your server
npx expo prebuild && npx expo run:android       # a development build is needed (push, contacts, audio)
Set extra.eas.projectId in app.json and add google-services.json (FCM) for Android push.

## Design
- Offline queue: every change is a per-user ordered event (user_events). Offline users replay from their cursor on connect.
- Delivered = device ack of the event; read = explicit read pointer. Client outbox retries with idempotent client_id.
- Notifications: pushed only if message is still unread after PUSH_DELAY_MS and app not in foreground;
  stays until read, then a silent "clear" push + local dismiss removes it (on all devices).
- Multi-server: stateless servers; Redis pub/sub + presence; PostgreSQL; push worker uses SKIP LOCKED.
