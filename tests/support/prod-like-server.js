// A local stand-in for the Vercel deployment, for reconnect tests that can't wait five minutes
// for hosting to recycle a connection. It serves the built app (npm run build) and runs the
// production room logic (server/redisRooms.js) on an in-memory Redis with network-like latency.
//
//   node tests/support/prod-like-server.js
//   SYNCADDA_URL=http://localhost:3001 SYNCADDA_DROP_URL=http://localhost:3001/api/test/drop-all \
//     npx playwright test tests/browser/call.spec.ts tests/browser/room.spec.ts
//
// POST /api/test/drop-all closes every WebSocket, like hosting does. With ?busyMs=N it first
// holds every room's lock for N ms, as if the server were still busy saving the disconnects.
import { createServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import MockRedis from 'ioredis-mock';
import { attachRedisRooms } from '../../server/redisRooms.js';

const delay = Number(process.env.REDIS_DELAY ?? 40);
const wait = () => new Promise((resolve) => setTimeout(resolve, delay * (0.5 + Math.random())));
class SlowRedis extends MockRedis {
  constructor(...args) {
    super(...args);
    // ioredis-mock defines its commands on each instance, so wrap them here.
    for (const name of ['get', 'set', 'del', 'eval', 'incr', 'expire']) {
      const command = this[name].bind(this);
      this[name] = async (...commandArgs) => {
        await wait();
        return command(...commandArgs);
      };
    }
  }
}

const app = express();
const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 100_000 });
const { redis } = await attachRedisRooms(io, {
  redisUrl: 'redis://127.0.0.1:6379/9',
  RedisClass: SlowRedis,
});
app.post('/api/test/drop-all', async (req, res) => {
  const busyMs = Number(req.query.busyMs) || 0;
  if (busyMs)
    for (const key of await redis.keys('syncadda:room:*'))
      await redis.set(key.replace(':room:', ':lock:'), 'busy', 'PX', busyMs);
  // Cut each underlying connection, like hosting does, so clients see a dropped connection and
  // reconnect (a Socket.IO disconnect would read as being kicked out). io.disconnectSockets()
  // also wouldn't do: it first goes through the Redis adapter, which the in-memory Redis never
  // completes.
  const sockets = [...io.sockets.sockets.values()];
  for (const socket of sockets) socket.conn.close();
  res.json({ dropped: sockets.length, busyMs });
});
app.get('/api/ice', (_req, res) => res.json({ iceServers: [] }));
app.use(express.static('dist'));
app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
server.listen(Number(process.env.PORT) || 3001, () =>
  console.log(`Production-like server on ${process.env.PORT || 3001} (Redis latency ~${delay}ms)`),
);
