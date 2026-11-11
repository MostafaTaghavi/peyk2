import http from 'node:http';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { createBus } from './bus.js';
import { createSms, createPush } from './providers.js';
import { createHttp } from './http.js';
import { createGateway } from './gateway.js';
import { startWorkers } from './workers.js';

export async function createApp(overrides = {}) {
  const cfg = loadConfig(overrides);
  const ctx = { cfg, db: await createDb(cfg), bus: await createBus(cfg), sms: createSms(cfg), push: createPush(cfg) };
  const server = http.createServer(createHttp(ctx));
  const gateway = createGateway(ctx, server);
  const workers = startWorkers(ctx);
  return {
    ctx, server, workers,
    listen: (port = cfg.port) => new Promise((res) => server.listen(port, '0.0.0.0', () => res(server.address().port))),
    async close() {
      workers.stop(); gateway.close();
      await new Promise((r) => server.close(r));
      await ctx.bus.close(); await ctx.db.close();
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await createApp();
  const port = await app.listen();
  console.log(`Peyk server listening on :${port}  (db=${app.ctx.cfg.databaseUrl ? 'postgres' : 'sqlite'}, bus=${app.ctx.cfg.redisUrl ? 'redis' : 'memory'}, push=${app.ctx.push.name}, sms=${app.ctx.sms.name})`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
}
