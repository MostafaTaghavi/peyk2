import path from 'node:path';

const env = process.env;

export function loadConfig(overrides = {}) {
  const prod = env.NODE_ENV === 'production';
  if (prod && !env.JWT_SECRET) throw new Error('JWT_SECRET is required in production');
  return {
    prod,
    port: Number(env.PORT || 3000),
    jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
    // --- storage / scaling switches -------------------------------------------------
    databaseUrl: env.DATABASE_URL || '',            // postgres://... => PostgreSQL (multi-server)
    sqlitePath: env.SQLITE_PATH || path.resolve('data/peyk.db'),
    redisUrl: env.REDIS_URL || '',                  // set => Redis pub/sub bus (multi-server)
    uploadDir: env.UPLOAD_DIR || path.resolve('data/uploads'),
    // --- providers ------------------------------------------------------------------
    smsProvider: env.SMS_PROVIDER || 'console',     // console | kavenegar
    kavenegarKey: env.KAVENEGAR_KEY || '',
    kavenegarTemplate: env.KAVENEGAR_TEMPLATE || 'verify',
    pushProvider: env.PUSH_PROVIDER || 'console',   // console | expo | memory
    expoAccessToken: env.EXPO_ACCESS_TOKEN || '',
    // --- behaviour ------------------------------------------------------------------
    otpTtlMs: 2 * 60_000,
    otpResendMs: 60_000,
    otpMaxPerHour: 5,
    otpMaxAttempts: 5,
    tokenTtl: '60d',
    // A push is only sent if the message is still unread after this delay and the
    // recipient app is not in the foreground. It is withdrawn/cleared once read.
    pushDelayMs: Number(env.PUSH_DELAY_MS || 3000),
    editWindowMs: 48 * 3600_000,
    deleteForAllWindowMs: 48 * 3600_000,
    eventRetentionMs: 30 * 24 * 3600_000,
    presenceTtlSec: 60,
    maxUploadBytes: 100 * 1024 * 1024,
    ...overrides,
  };
}
