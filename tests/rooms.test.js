import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { attachRooms, positionAt } from '../server/rooms.js';

let http, io, service, url, clients;
const user = (name) => ({ id: randomUUID(), token: randomUUID() + randomUUID(), name });
const movie = { title: 'A test movie', url: 'https://example.com/movie.mp4', kind: 'video' };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const emit = (socket, name, value = {}) => socket.timeout(2000).emitWithAck(name, value);
const nextEvent = (socket, name) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No ${name} received`)), 2000);
    socket.once(name, (data) => {
      clearTimeout(timeout);
      resolve(data);
    });
  });
beforeEach(async () => {
  http = createServer();
  io = new Server(http);
  service = attachRooms(io, { graceMs: 120 });
  clients = [];
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${http.address().port}`;
});
afterEach(async () => {
  clients.forEach((s) => s.disconnect());
  service.dispose();
  await new Promise((resolve) => io.close(resolve));
});
async function client() {
  const socket = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
  clients.push(socket);
  await nextEvent(socket, 'connect');
  return socket;
}
async function setup() {
  const host = await client(),
    identity = user('Advitiya');
  const { room, ok } = await emit(host, 'room:create', { identity, name: 'Friday night' });
  assert.equal(ok, true);
  return { host, identity, room };
}
async function guest(room, name = 'Rahul') {
  const socket = await client(),
    identity = user(name);
  const response = await emit(socket, 'room:join', { identity, code: room.code });
  assert.equal(response.ok, true);
  return { socket, identity, room: response.room };
}

test('private rooms expose no session secrets and use unique short codes', async () => {
  const { room, identity } = await setup();
  assert.match(room.code, /^[A-Z2-9]{6}$/);
  assert.equal(room.hostId, identity.id);
  assert.equal(room.locked, false);
  assert.equal(room.everyoneControls, false);
  assert.equal(JSON.stringify(room).includes(identity.token), false);
  assert.equal('people' in room, false);
  assert.equal('banned' in room, false);
  const second = await client();
  const created = await emit(second, 'room:create', {
    identity: user('Maya'),
    name: 'Another room',
  });
  assert.notEqual(created.room.code, room.code);
});
test('late joiners receive the current shared clock and media', async () => {
  const { host, room } = await setup();
  await emit(host, 'media:add', movie);
  const mediaId = service.rooms.get(room.code).currentId;
  assert.equal(
    (await emit(host, 'playback:update', { mediaId, position: 82, playing: true, rate: 1.5 })).ok,
    true,
  );
  await wait(40);
  const joined = await guest(room);
  assert.equal(joined.room.currentId, mediaId);
  assert.equal(joined.room.playback.playing, true);
  assert.ok(positionAt(joined.room.playback) >= 82.05);
  assert.equal(joined.room.playback.rate, 1.5);
});
test('host-only permissions are enforced on the server, then can be shared', async () => {
  const { host, room } = await setup();
  const { socket } = await guest(room);
  assert.equal((await emit(socket, 'media:add', movie)).ok, false);
  assert.equal((await emit(socket, 'room:settings', { everyoneControls: true })).ok, false);
  await emit(host, 'media:add', movie);
  const mediaId = service.rooms.get(room.code).currentId;
  assert.equal((await emit(socket, 'playback:update', { mediaId, playing: true })).ok, false);
  await emit(host, 'room:settings', { everyoneControls: true });
  assert.equal(
    (await emit(socket, 'playback:update', { mediaId, position: 34, playing: true })).ok,
    true,
  );
  assert.equal((await emit(socket, 'media:add', { ...movie, title: 'Shared choice' })).ok, true);
  assert.equal((await emit(socket, 'room:close')).ok, false);
});
test('play, pause, seek, and rate changes are broadcast to every client', async () => {
  const { host, room } = await setup();
  const { socket } = await guest(room);
  await emit(host, 'media:add', movie);
  const mediaId = service.rooms.get(room.code).currentId;
  for (const patch of [
    { playing: true, position: 23 },
    { position: 84 },
    { rate: 1.25 },
    { playing: false },
  ]) {
    const event = nextEvent(socket, 'playback:state');
    await emit(host, 'playback:update', { mediaId, ...patch });
    const data = await event;
    for (const [key, value] of Object.entries(patch)) assert.equal(data.playback[key], value);
  }
  assert.equal((await emit(host, 'playback:update', { mediaId, position: -1 })).ok, false);
  assert.equal(
    (await emit(host, 'playback:update', { mediaId: randomUUID(), playing: true })).ok,
    false,
  );
});
test('locking blocks new guests while a known session can reconnect', async () => {
  const { host, room } = await setup();
  const original = await guest(room);
  await emit(host, 'room:settings', { locked: true });
  const stranger = await client();
  assert.match(
    (await emit(stranger, 'room:join', { code: room.code, identity: user('Stranger') })).error,
    /locked/,
  );
  original.socket.disconnect();
  await wait(20);
  const restored = await client();
  const joined = await emit(restored, 'room:join', {
    code: room.code,
    identity: original.identity,
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.room.participants.length, 2);
  assert.equal(joined.room.participants.find((p) => p.id === original.identity.id).online, true);
});
test('a public participant id cannot be used to hijack its session', async () => {
  const { room, identity } = await setup();
  const attacker = await client();
  const result = await emit(attacker, 'room:join', {
    code: room.code,
    identity: { ...user('Attacker'), id: identity.id },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /session/);
});
test('chat messages and reactions arrive only inside the same room', async () => {
  const { host, room } = await setup();
  const { socket } = await guest(room);
  const outsider = await client();
  let leak = false;
  outsider.on('room:state', () => {
    leak = true;
  });
  outsider.on('reaction', () => {
    leak = true;
  });
  const event = nextEvent(socket, 'room:state');
  assert.equal((await emit(host, 'chat:send', { text: 'Wait for this scene! 🍿' })).ok, true);
  const data = await event;
  assert.equal(data.messages.at(-1).text, 'Wait for this scene! 🍿');
  assert.equal(data.messages.at(-1).name, 'Advitiya');
  const reaction = nextEvent(socket, 'reaction');
  await emit(host, 'reaction:send', { emoji: '🍿' });
  assert.equal((await reaction).emoji, '🍿');
  assert.equal(leak, false);
  assert.equal((await emit(host, 'chat:send', { text: 'x'.repeat(1501) })).ok, false);
  assert.equal((await emit(host, 'chat:send', { text: '   ' })).ok, false);
});
test('queue updates select and remove media without retaining an old playback clock', async () => {
  const { host, room } = await setup();
  await emit(host, 'media:add', movie);
  await emit(host, 'media:add', { ...movie, title: 'Next film' });
  const r = service.rooms.get(room.code);
  const [first, second] = r.playlist;
  await emit(host, 'playback:update', { mediaId: first.id, position: 84, playing: true });
  await emit(host, 'media:select', { id: second.id });
  assert.equal(r.currentId, second.id);
  assert.equal(r.playback.position, 0);
  assert.equal(r.playback.playing, false);
  await emit(host, 'media:remove', { id: second.id });
  assert.equal(r.currentId, first.id);
  await emit(host, 'media:remove', { id: first.id });
  assert.equal(r.currentId, null);
  assert.equal((await emit(host, 'media:add', { ...movie, url: 'javascript:alert(1)' })).ok, false);
});
test('host transfer changes actual server authorization', async () => {
  const { host, room } = await setup();
  const { socket, identity } = await guest(room);
  await emit(host, 'room:transfer', { id: identity.id });
  assert.equal((await emit(host, 'room:settings', { locked: true })).ok, false);
  assert.equal((await emit(socket, 'room:settings', { locked: true })).ok, true);
});
test('removing a participant revokes membership and disallows session re-entry', async () => {
  const { host, room } = await setup();
  const { socket, identity } = await guest(room);
  const ended = nextEvent(socket, 'room:ended');
  await emit(host, 'room:kick', { id: identity.id });
  assert.match((await ended).message, /removed/);
  assert.equal((await emit(socket, 'chat:send', { text: 'still here?' })).ok, false);
  assert.equal((await emit(socket, 'room:join', { code: room.code, identity })).ok, false);
});
test('call signaling requires shared room membership and call participation', async () => {
  const { host, room, identity } = await setup();
  const guestClient = await guest(room);
  const stranger = await client();
  const description = { type: 'offer', sdp: 'v=0\r\n' };
  assert.equal(
    (await emit(host, 'call:signal', { to: guestClient.identity.id, description })).ok,
    false,
  );
  await emit(host, 'call:status', { inCall: true, mic: true, camera: false });
  await emit(guestClient.socket, 'call:status', { inCall: true, mic: false, camera: true });
  const signal = nextEvent(guestClient.socket, 'call:signal');
  await emit(host, 'call:signal', { to: guestClient.identity.id, description });
  const received = await signal;
  assert.equal(received.from, identity.id);
  assert.deepEqual(received.description, description);
  assert.equal((await emit(stranger, 'call:signal', { to: identity.id, description })).ok, false);
  await emit(guestClient.socket, 'call:status', { inCall: false, mic: true, camera: true });
  assert.equal(service.rooms.get(room.code).people.get(guestClient.identity.id).mic, false);
});
test('leaving transfers hosting, and the last departure deletes the private room', async () => {
  const { host, room } = await setup();
  const { socket, identity } = await guest(room);
  await emit(host, 'room:leave');
  assert.equal(service.rooms.get(room.code).hostId, identity.id);
  await emit(socket, 'room:leave');
  assert.equal(service.rooms.has(room.code), false);
});
test('a dropped connection keeps its seat temporarily, then expires and transfers host', async () => {
  const { host, room, identity } = await setup();
  const joined = await guest(room);
  host.disconnect();
  await wait(30);
  assert.equal(service.rooms.get(room.code).people.get(identity.id).online, false);
  await wait(160);
  assert.equal(service.rooms.get(room.code).people.has(identity.id), false);
  assert.equal(service.rooms.get(room.code).hostId, joined.identity.id);
});
test('closing a room clears its state and notifies participants', async () => {
  const { host, room } = await setup();
  const { socket } = await guest(room);
  const event = nextEvent(socket, 'room:ended');
  await emit(host, 'room:close');
  assert.match((await event).message, /ended/);
  assert.equal(service.rooms.has(room.code), false);
  assert.equal((await emit(socket, 'playback:sync')).ok, false);
});
test('room size is bounded to eight participants', async () => {
  const { room } = await setup();
  for (let i = 0; i < 7; i++) await guest(room, `Friend ${i}`);
  const ninth = await client();
  const result = await emit(ninth, 'room:join', { code: room.code, identity: user('Late friend') });
  assert.equal(result.ok, false);
  assert.match(result.error, /full/);
});
