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

    // Only the host adds to the queue until they give someone access; access doesn't include the remote.
    const media = { title: 'Guest pick', url: 'https://example.com/guest.mp4', kind: 'video' };
    const denied = await emit(guest, 'media:add', media);
    assert.equal(denied.ok, false);
    assert.match(denied.error, /Ask the host/);
    assert.equal(
      (await emit(guest, 'room:queue-access', { id: guestIdentity.id, allowed: true })).ok,
      false,
    );
    const granted = next(guest, 'room:state');
    assert.equal(
      (await emit(host, 'room:queue-access', { id: guestIdentity.id, allowed: true })).ok,
      true,
    );
    assert.deepEqual((await granted).queueAccess, [guestIdentity.id]);
    assert.equal((await emit(guest, 'media:add', media)).ok, true);
    assert.equal((await emit(guest, 'playback:update', { mediaId, playing: false })).ok, false);
    assert.equal((await emit(guest, 'media:remove', { id: mediaId })).ok, false);

    // A host whose connection drops stays the host when they reconnect.
    host.disconnect();
    const dropped = await next(guest, 'room:state');
    assert.equal(dropped.hostId, hostIdentity.id);
    const back = await client(0);
    const rejoined = await emit(back, 'room:join', {
      code: created.room.code,
      identity: hostIdentity,
    });
    assert.equal(rejoined.ok, true, rejoined.error);
    assert.equal(rejoined.room.hostId, hostIdentity.id);
    assert.equal((await emit(guest, 'room:settings', { locked: true })).ok, false);
    assert.equal((await emit(back, 'room:settings', { locked: true })).ok, true);
    assert.equal(
      (await emit(guest, 'room:join', { code: created.room.code, identity: guestIdentity })).ok,
      true,
    );
    const close = next(guest, 'room:ended');
    assert.equal((await emit(back, 'room:close')).ok, true);
    assert.match((await close).message, /ended/);
  } finally {
    clients.forEach((socket) => socket.disconnect());
    for (const server of servers) await new Promise((resolve) => server.io.close(resolve));
    for (const service of services) await service.dispose();
  }
});

test('Redis rooms close when everyone else leaves, or after a stretch without activity', async () => {
  const http = createServer(),
    io = new Server(http);
  const redisUrl = `redis://127.0.0.1:6379/${Math.floor(Math.random() * 1000000)}`;
  const service = await attachRedisRooms(io, { redisUrl, RedisClass: MockRedis, idleMs: 300 });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const clients = [];
  const client = async () => {
    const socket = connect(`http://127.0.0.1:${http.address().port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    clients.push(socket);
    await next(socket, 'connect');
    return socket;
  };
  try {
    const host = await client(),
      guest = await client();
    const { room } = await emit(host, 'room:create', { identity: identity('Asha'), name: 'One' });
    assert.equal(
      (await emit(guest, 'room:join', { code: room.code, identity: identity('Bina') })).ok,
      true,
    );
    const alone = next(host, 'room:ended');
    assert.equal((await emit(guest, 'room:leave')).ok, true);
    assert.match((await alone).message, /Everyone else left/);

    const quiet = await client();
    const created = await emit(quiet, 'room:create', { identity: identity('Chetan'), name: 'Two' });
    assert.equal(created.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const ended = next(quiet, 'room:ended');
    const sync = await emit(quiet, 'playback:sync');
    assert.equal(sync.ok, false);
    assert.match(sync.error, /without activity/);
    assert.match((await ended).message, /without activity/);
  } finally {
    clients.forEach((socket) => socket.disconnect());
    await new Promise((resolve) => io.close(resolve));
    await service.dispose();
  }
});
