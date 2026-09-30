import { createServer } from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { attachRedisRooms } from '../server/redisRooms.js';

const server = createServer(express());
const io = new Server(server, {
  path: '/api/socket',
  transports: ['websocket'],
  maxHttpBufferSize: 100_000,
  allowRequest: (request, done) => {
    const origin = request.headers.origin;
    let allowed = !origin;
    try {
      allowed ||=
        origin === process.env.APP_ORIGIN || new URL(origin).host === request.headers.host;
    } catch {
      /* invalid origin */
    }
    done(null, allowed);
  },
});
await attachRedisRooms(io);
export default server;
