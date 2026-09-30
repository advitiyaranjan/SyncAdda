import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import MockRedis from 'ioredis-mock';
import { attachRedisRooms } from '../server/redisRooms.js';

const identity = (name) => ({ id: randomUUID(), token: randomUUID() + randomUUID(), name });
const emit = (socket, event, data = {}) => socket.timeout(3000).emitWithAck(event, data);
const next = (socket, event) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Missing ${event}`)), 3000);
    socket.once(event, (value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });

test('Redis shares room state and Socket.IO events across independent servers', async () => {
  const servers = [],
    clients = [],
    services = [];
  const redisUrl = `redis://127.0.0.1:6379/${Math.floor(Math.random() * 1000000)}`;
  try {
    for (let i = 0; i < 2; i++) {
      const http = createServer(),
        io = new Server(http);
      services.push(await attachRedisRooms(io, { redisUrl, RedisClass: MockRedis, graceMs: 120 }));
      await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
      servers.push({ http, io, url: `http://127.0.0.1:${http.address().port}` });
    }
    const client = async (index) => {
      const socket = connect(servers[index].url, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });
      clients.push(socket);
      await next(socket, 'connect');
      return socket;
    };
    const host = await client(0),
      hostIdentity = identity('Advitiya');
    const created = await emit(host, 'room:create', {
      identity: hostIdentity,
      name: 'Across two servers',
    });
    assert.equal(created.ok, true, created.error);
    const guest = await client(1),
      guestIdentity = identity('Rahul');
    const joined = await emit(guest, 'room:join', {
      code: created.room.code,
      identity: guestIdentity,
    });
    assert.equal(joined.ok, true, joined.error);
    assert.equal(joined.room.participants.length, 2);
    assert.equal(JSON.stringify(joined.room).includes(hostIdentity.token), false);
    const chat = next(guest, 'room:state');
    const sent = await emit(host, 'chat:send', { text: 'Hello from the other server' });
    assert.equal(sent.ok, true, sent.error);
    assert.equal((await chat).messages.at(-1).text, 'Hello from the other server');
    const add = await emit(host, 'media:add', {
      title: 'Our movie',
      url: 'https://example.com/video.mp4',
      kind: 'video',
    });
    assert.equal(add.ok, true, add.error);
    const mediaId = (await emit(guest, 'playback:sync')).currentId;
    assert.ok(mediaId);
    const play = next(guest, 'playback:state');
    assert.equal(
      (await emit(host, 'playback:update', { mediaId, position: 91, playing: true })).ok,
      true,
    );
    assert.equal((await play).playback.position, 91);
    assert.equal((await emit(guest, 'room:settings', { locked: true })).ok, false);
    assert.equal((await emit(host, 'room:settings', { locked: true })).ok, true);
    assert.equal(
      (await emit(guest, 'room:join', { code: created.room.code, identity: guestIdentity })).ok,
      true,
    );
    const close = next(guest, 'room:ended');
    assert.equal((await emit(host, 'room:close')).ok, true);
    assert.match((await close).message, /ended/);
  } finally {
    clients.forEach((socket) => socket.disconnect());
    for (const server of servers) await new Promise((resolve) => server.io.close(resolve));
    for (const service of services) await service.dispose();
  }
});
