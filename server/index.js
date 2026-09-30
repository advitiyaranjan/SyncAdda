import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRooms } from './rooms.js';
import { iceServers } from './ice.js';
import { sameSecret, uploadHandler } from './uploads.js';

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
  next();
});
const server = createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 100_000,
  allowRequest: (req, cb) => {
    const origin = req.headers.origin;
    let allowed = !origin;
    try {
      allowed ||= origin === process.env.APP_ORIGIN || new URL(origin).host === req.headers.host;
    } catch {
      /* invalid origin */
    }
    cb(null, allowed);
  },
});
const { rooms } = attachRooms(io);
app.post('/api/upload', express.json(), (req, res) =>
  uploadHandler(req, res, (code, id, token) => {
    const person = rooms.get(code)?.people.get(id);
    return !!person && sameSecret(person.token, token);
  }),
);
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/ice', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ iceServers: await iceServers() });
});
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
app.use(express.static(dist));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
server.listen(Number(process.env.PORT) || 3001, '0.0.0.0', () =>
  console.log(`SyncAdda server ready on port ${process.env.PORT || 3001}`),
);
