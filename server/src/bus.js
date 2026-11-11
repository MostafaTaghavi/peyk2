// Message bus + presence store. MemoryBus = one server. RedisBus = many servers.
// Topics: "u:<userId>" (events for a user's devices), "p:<userId>" (presence changes).
import { EventEmitter } from 'node:events';

export class MemoryBus {
  constructor() {
    this.em = new EventEmitter();
    this.em.setMaxListeners(0);
    this.pres = new Map(); // userId -> Map(deviceId -> {state, exp})
  }
  async publish(topic, msg) { this.em.emit(topic, msg); }
  subscribe(topic, fn) {
    this.em.on(topic, fn);
    return () => this.em.off(topic, fn);
  }
  async presenceSet(userId, deviceId, state, ttlSec) {
    let m = this.pres.get(userId);
    if (!m) this.pres.set(userId, (m = new Map()));
    if (!state) m.delete(deviceId);
    else m.set(deviceId, { state, exp: Date.now() + ttlSec * 1000 });
    if (!m.size) this.pres.delete(userId);
  }
  /** returns {online: bool (any device in foreground), connected: bool} */
  async presenceGet(userId) {
    const m = this.pres.get(userId);
    let online = false, connected = false;
    if (m) for (const [id, v] of m) {
      if (v.exp < Date.now()) { m.delete(id); continue; }
      connected = true;
      if (v.state === 'fg') online = true;
    }
    return { online, connected };
  }
  async close() {}
}

export class RedisBus {
  constructor(url, Redis) {
    this.pub = new Redis(url);
    this.sub = new Redis(url);
    this.handlers = new Map(); // topic -> Set<fn>
    this.sub.on('message', (ch, raw) => {
      const set = this.handlers.get(ch);
      if (!set) return;
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      for (const fn of set) fn(msg);
    });
  }
  async publish(topic, msg) { await this.pub.publish(topic, JSON.stringify(msg)); }
  subscribe(topic, fn) {
    let set = this.handlers.get(topic);
    if (!set) {
      this.handlers.set(topic, (set = new Set()));
      this.sub.subscribe(topic).catch(() => {});
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) { this.handlers.delete(topic); this.sub.unsubscribe(topic).catch(() => {}); }
    };
  }
  async presenceSet(userId, deviceId, state, ttlSec) {
    const key = `pres:${userId}`;
    await this.pub.zrem(key, `${deviceId}|fg`, `${deviceId}|bg`);
    if (state) {
      await this.pub.zadd(key, Date.now() + ttlSec * 1000, `${deviceId}|${state}`);
      await this.pub.expire(key, ttlSec * 3);
    }
  }
  async presenceGet(userId) {
    const key = `pres:${userId}`;
    await this.pub.zremrangebyscore(key, 0, Date.now());
    const members = await this.pub.zrange(key, 0, -1);
    return { online: members.some((m) => m.endsWith('|fg')), connected: members.length > 0 };
  }
  async close() { this.pub.disconnect(); this.sub.disconnect(); }
}

export async function createBus(cfg) {
  if (cfg.redisUrl) {
    const Redis = (await import('ioredis')).default;
    return new RedisBus(cfg.redisUrl, Redis);
  }
  return new MemoryBus();
}
