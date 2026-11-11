import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { z } from 'zod';
import * as S from './service.js';
import { HttpError, normalizePhone, publicUser, uuid } from './service.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function signToken(cfg, userId) {
  return jwt.sign({ sub: userId }, cfg.jwtSecret, { expiresIn: cfg.tokenTtl });
}
export function verifyToken(cfg, token) {
  try { return jwt.verify(token, cfg.jwtSecret).sub; } catch { return null; }
}

export function createHttp(ctx) {
  const { cfg, db } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  fs.mkdirSync(cfg.uploadDir, { recursive: true });
  app.use('/files', express.static(cfg.uploadDir, {
    maxAge: '30d', immutable: true,
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ------------------------------------------------------------------ auth (OTP)
  app.post('/auth/otp', wrap(async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) throw new HttpError(400, 'invalid_phone');
    const now = Date.now();
    const row = await db.get('SELECT * FROM otps WHERE phone = ?', [phone]);
    if (row && now - row.sent_at < cfg.otpResendMs) {
      throw new HttpError(429, 'too_many_requests', { retry_after: Math.ceil((cfg.otpResendMs - (now - row.sent_at)) / 1000) });
    }
    let hourStart = row?.hour_start ?? now, hourCount = row?.hour_count ?? 0;
    if (now - hourStart > 3600_000) { hourStart = now; hourCount = 0; }
    if (hourCount >= cfg.otpMaxPerHour) throw new HttpError(429, 'too_many_requests', { retry_after: 3600 });
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const hash = hashCode(cfg, phone, code);
    await db.run(
      `INSERT INTO otps(phone, code_hash, expires_at, attempts, sent_at, hour_start, hour_count) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0,
         sent_at = excluded.sent_at, hour_start = excluded.hour_start, hour_count = excluded.hour_count`,
      [phone, hash, now + cfg.otpTtlMs, 0, now, hourStart, hourCount + 1]);
    await ctx.sms.sendOtp(phone, code);
    res.json({ ok: true, expires_in: cfg.otpTtlMs / 1000, ...(cfg.prod ? {} : { dev_code: code }) });
  }));

  app.post('/auth/verify', wrap(async (req, res) => {
    const body = z.object({ phone: z.string(), code: z.string().regex(/^\d{4,8}$/), name: z.string().trim().max(60).optional() }).parse(req.body);
    const phone = normalizePhone(body.phone);
    if (!phone) throw new HttpError(400, 'invalid_phone');
    const row = await db.get('SELECT * FROM otps WHERE phone = ?', [phone]);
    if (!row || row.expires_at < Date.now()) throw new HttpError(400, 'code_expired');
    if (row.attempts >= cfg.otpMaxAttempts) throw new HttpError(429, 'too_many_attempts');
    const ok = safeEq(row.code_hash, hashCode(cfg, phone, body.code));
    if (!ok) {
      await db.run('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?', [phone]);
      throw new HttpError(400, 'wrong_code');
    }
    await db.run('DELETE FROM otps WHERE phone = ?', [phone]);
    let user = await db.get('SELECT * FROM users WHERE phone = ?', [phone]);
    const isNew = !user;
    if (!user) {
      user = { id: uuid(), phone, name: body.name ?? '', about: '', avatar: null, created_at: Date.now() };
      await db.run('INSERT INTO users(id, phone, name, about, created_at) VALUES (?,?,?,?,?)', [user.id, phone, user.name, '', user.created_at]);
    } else if (body.name && !user.name) {
      await db.run('UPDATE users SET name = ? WHERE id = ?', [body.name, user.id]);
      user.name = body.name;
    }
    res.json({ token: signToken(cfg, user.id), user: publicUser(user), is_new: isNew });
  }));

  // ------------------------------------------------------------------ authenticated
  const auth = wrap(async (req, _res, next) => {
    const h = req.headers.authorization || '';
    const id = verifyToken(cfg, h.startsWith('Bearer ') ? h.slice(7) : '');
    if (!id) throw new HttpError(401, 'unauthorized');
    const u = await db.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!u) throw new HttpError(401, 'unauthorized');
    req.user = u;
    next();
  });
  const r = express.Router();
  r.use(auth);

  r.get('/me', (req, res) => res.json({ ...publicUser(req.user), ev_seq: req.user.ev_seq }));
  r.put('/me', wrap(async (req, res) => {
    const b = z.object({ name: z.string().trim().min(1).max(60).optional(), about: z.string().max(140).optional(), avatar: z.string().regex(/^\/files\/[\w.\-]+$/).nullish() }).parse(req.body);
    const u = req.user;
    await db.run('UPDATE users SET name = ?, about = ?, avatar = ? WHERE id = ?',
      [b.name ?? u.name, b.about ?? u.about, b.avatar === undefined ? u.avatar : b.avatar, u.id]);
    res.json(publicUser(await db.get('SELECT * FROM users WHERE id = ?', [u.id])));
  }));

  r.post('/devices', wrap(async (req, res) => {
    const b = z.object({ device_id: z.string().min(8).max(64), push_token: z.string().max(300).nullish(), platform: z.string().max(20).optional() }).parse(req.body);
    if (b.push_token) await db.run('UPDATE devices SET push_token = NULL WHERE push_token = ? AND NOT (user_id = ? AND id = ?)', [b.push_token, req.user.id, b.device_id]);
    await db.run(
      `INSERT INTO devices(user_id, id, push_token, platform, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(user_id, id) DO UPDATE SET push_token = excluded.push_token, platform = excluded.platform`,
      [req.user.id, b.device_id, b.push_token ?? null, b.platform ?? null, Date.now()]);
    res.json({ ok: true });
  }));
  r.delete('/devices/:id', wrap(async (req, res) => {
    await db.run('DELETE FROM devices WHERE user_id = ? AND id = ?', [req.user.id, req.params.id]);
    res.json({ ok: true });
  }));

  // contacts
  r.post('/contacts/sync', wrap(async (req, res) => {
    const items = z.array(z.object({ phone: z.string(), name: z.string().optional() })).max(5000).parse(req.body?.contacts ?? []);
    res.json(await S.syncContacts(db, req.user.id, items));
  }));
  r.get('/contacts', wrap(async (req, res) => res.json(await S.listContacts(db, req.user.id, req.query.q ? String(req.query.q) : undefined))));
  r.post('/contacts', wrap(async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) throw new HttpError(400, 'invalid_phone');
    const u = await db.get("SELECT * FROM users WHERE phone = ? AND name <> ''", [phone]);
    if (!u || u.id === req.user.id) throw new HttpError(404, 'user_not_found');
    await db.run('INSERT INTO contacts(user_id, contact_id, alias) VALUES (?,?,?) ON CONFLICT(user_id, contact_id) DO UPDATE SET alias = excluded.alias', [req.user.id, u.id, req.body?.name ?? null]);
    res.json({ ...publicUser(u), alias: req.body?.name ?? null });
  }));

  // chats
  r.get('/chats', wrap(async (req, res) => res.json(await S.listChats(db, req.user.id))));
  r.get('/chats/:id', wrap(async (req, res) => {
    await S.assertMember(db, req.params.id, req.user.id);
    res.json(await S.chatView(db, req.params.id));
  }));
  r.post('/chats/direct', wrap(async (req, res) => {
    const { user_id } = z.object({ user_id: z.string() }).parse(req.body);
    res.json(await S.getOrCreateDirect(ctx, req.user.id, user_id));
  }));
  r.post('/chats/group', wrap(async (req, res) => {
    const b = z.object({ title: z.string().trim().min(1).max(80), member_ids: z.array(z.string()).min(1).max(256) }).parse(req.body);
    res.json(await S.createGroup(ctx, req.user.id, b));
  }));
  r.put('/chats/:id', wrap(async (req, res) => {
    const b = z.object({ title: z.string().trim().min(1).max(80).optional(), add_member_ids: z.array(z.string()).max(256).optional() }).parse(req.body);
    res.json(await S.updateGroup(ctx, req.user.id, req.params.id, b));
  }));
  r.delete('/chats/:id/members/:uid', wrap(async (req, res) => {
    await S.leaveChat(ctx, req.user.id, req.params.id, req.params.uid === 'me' ? req.user.id : req.params.uid);
    res.json({ ok: true });
  }));
  r.get('/chats/:id/messages', wrap(async (req, res) => res.json(await S.history(db, req.user.id, req.params.id, req.query))));

  // messages (REST fallback; the app normally uses the WebSocket)
  r.post('/messages', wrap(async (req, res) => res.json(await S.sendMessage(ctx, req.user.id, req.body))));

  // uploads
  const upload = multer({
    limits: { fileSize: cfg.maxUploadBytes },
    storage: multer.diskStorage({
      destination: cfg.uploadDir,
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.\w]/g, '').slice(0, 10);
        cb(null, `${crypto.randomBytes(16).toString('hex')}${ext}`);
      },
    }),
  });
  r.post('/upload', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'no_file');
    res.json({
      url: `/files/${req.file.filename}`, name: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      size: req.file.size, mime: req.file.mimetype,
    });
  }));

  app.use(r);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: 'validation', details: err.issues });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.retry_after ? { retry_after: err.retry_after } : {}) });
    if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' });
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });
  return app;
}

const hashCode = (cfg, phone, code) => crypto.createHmac('sha256', cfg.jwtSecret).update(`${phone}:${code}`).digest('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
