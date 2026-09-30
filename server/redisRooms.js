import { randomBytes, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { createAdapter } from '@socket.io/redis-adapter';
import { z } from 'zod';
import {
  ALONE_MESSAGE,
  IDLE_MESSAGE,
  MAX_MESSAGES,
  STATE_MESSAGES,
  callSchema,
  deniedMessage,
  isIdle,
  permitted,
  positionAt,
} from './rooms.js';
import { deleteUploads, droppedUploads, sameSecret } from './uploads.js';

const identitySchema = z.object({
  id: z.string().uuid(),
  token: z.string().min(32).max(128),
  name: z.string().trim().min(1).max(24),
});
const codeSchema = z.string().regex(/^[A-Z2-9]{6}$/);
const mediaSchema = z.object({
  title: z.string().trim().min(1).max(100),
  url: z
    .string()
    .url()
    .max(2048)
    .refine((url) => /^https?:\/\//i.test(url)),
  kind: z.enum(['video', 'audio']),
});
const key = (code) => `syncadda:room:${code}`;
const lockKey = (code) => `syncadda:lock:${code}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function isRoomMember(redis, code, id, token) {
  if (!codeSchema.safeParse(code).success || typeof id !== 'string') return false;
  const json = await redis.get(key(code));
  const person = json ? JSON.parse(json).people[id] : null;
  return !!person && sameSecret(person.token, token);
}

export async function attachRedisRooms(
  io,
  {
    redisUrl = process.env.REDIS_URL || process.env.KV_URL,
    graceMs = 90_000,
    callGraceMs = 15_000,
    idleMs,
    RedisClass = Redis,
  } = {},
) {
  if (!redisUrl) throw new Error('REDIS_URL or KV_URL is required for shared rooms.');
  const redis = new RedisClass(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 10_000 });
  const subscriber = redis.duplicate();
  await Promise.all([redis.ping(), subscriber.ping()]);
  io.adapter(createAdapter(redis, subscriber));
  const timers = new Map();
  const read = async (code) => {
    const json = await redis.get(key(code));
    return json ? JSON.parse(json) : null;
  };
  const snapshot = (room, full = false) => ({
    code: room.code,
    name: room.name,
    hostId: room.hostId,
    locked: room.locked,
    everyoneControls: room.everyoneControls,
    queueAccess: room.queueAccess ?? [],
    participants: Object.values(room.people).map(
      ({ token, socketId, offlineSince, ...person }) => person,
    ),
    messages: full ? room.messages : room.messages.slice(-STATE_MESSAGES),
    playlist: room.playlist,
    currentId: room.currentId,
    playback: room.playback,
    serverTime: Date.now(),
  });
  const broadcast = (room) => io.to(room.code).emit('room:state', snapshot(room));
  const system = (room, text) => {
    room.messages.push({ id: randomUUID(), name: 'SyncAdda', text, at: Date.now(), system: true });
    room.messages = room.messages.slice(-MAX_MESSAGES);
  };
  const remove = (room, id, { kicked = false } = {}) => {
    const person = room.people[id];
    if (!person) return;
    delete room.people[id];
    room.queueAccess = (room.queueAccess ?? []).filter((p) => p !== id);
    system(room, `${person.name} left the room.`);
    const left = Object.keys(room.people).length;
    if (!kicked && room.hadCompany && left > 0 && left < 2) room.closing = ALONE_MESSAGE;
    if (room.hostId === id && left) {
      room.hostId =
        Object.values(room.people).find((p) => p.online)?.id || Object.keys(room.people)[0];
      system(room, `${room.people[room.hostId].name} is now the host.`);
    }
  };
  const prune = (room) => {
    for (const person of Object.values(room.people)) {
      if (person.online || !person.offlineSince) continue;
      const away = Date.now() - person.offlineSince;
      if (away >= graceMs) remove(room, person.id);
      // If they don't come back quickly (e.g. closed the tab), they're no longer in the call.
      else if (away >= callGraceMs)
        Object.assign(person, { inCall: false, mic: false, camera: false });
    }
  };
  async function mutate(code, handler) {
    const token = randomUUID();
    let acquired = false;
    for (let i = 0; i < 100; i++) {
      if ((await redis.set(lockKey(code), token, 'PX', 3000, 'NX')) === 'OK') {
        acquired = true;
        break;
      }
      await sleep(20);
    }
    if (!acquired) throw new Error('This room is busy. Please try again.');
    let result,
      closing,
      dropped = [];
    try {
      const room = await read(code);
      if (!room)
        throw new Error('That room could not be found. Check the code or create a new one.');
      prune(room);
      const before = [...room.playlist];
      const idle = isIdle(room, Object.values(room.people), idleMs);
      if (idle) room.closing = IDLE_MESSAGE;
      const value = idle ? undefined : await handler(room);
      room.lastActivity = Date.now();
      // Closing: everyone is let go and the room (with its uploads) is deleted below.
      if (room.closing) {
        closing = room.closing;
        room.people = {};
      }
      const open = Object.keys(room.people).length > 0;
      if (open) await redis.set(key(code), JSON.stringify(room), 'EX', 6 * 3600);
      else await redis.del(key(code));
      dropped = droppedUploads(before, open ? room.playlist : []);
      result = { value, room };
    } finally {
      await redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey(code),
        token,
      );
    }
    await deleteUploads(dropped);
    if (closing) {
      io.to(code).emit('room:ended', { message: closing });
      io.in(code).socketsLeave(code);
      if (closing === IDLE_MESSAGE) throw new Error(IDLE_MESSAGE);
    }
    return result;
  }
  io.on('connection', (socket) => {
    let windowStart = Date.now(),
      count = 0,
      signals = 0,
      signalQueue = Promise.resolve();
    const event = (name, handler) =>
      socket.on(name, (data, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        const run = async () => {
          try {
            if (Date.now() - windowStart > 10_000) {
              windowStart = Date.now();
              count = 0;
              signals = 0;
            }
            // Call setup sends a burst of ICE candidates per peer, so it gets its own budget.
            if (name === 'call:signal' ? ++signals > 800 : ++count > 140)
              throw new Error('A little too fast. Please try again in a moment.');
            const result = await handler(data);
            reply({ ok: true, ...result });
          } catch (error) {
            reply({
              ok: false,
              error:
                error instanceof z.ZodError
                  ? 'Please check your details and try again.'
                  : error.message || 'Something went wrong.',
            });
          }
        };
        // Relay call signals in the order they were sent; WebRTC negotiation depends on it.
        if (name === 'call:signal') signalQueue = signalQueue.then(run);
        else void run();
      });
    const current = async (need) => {
      const code = socket.data.code,
        id = socket.data.personId;
      if (!code || !id) throw new Error('Join a room to continue.');
      const room = await read(code);
      // Closes a room that has sat idle too long (mutate notices it and throws).
      if (room && isIdle(room, Object.values(room.people), idleMs)) await mutate(code, () => {});
      if (!room || room.people[id]?.socketId !== socket.id)
        throw new Error('Join a room to continue.');
      if (!permitted(room, id, need)) throw new Error(deniedMessage(need));
      return room;
    };
    const change = async (handler, { need, broadcastState = true } = {}) => {
      const active = await current(need);
      const { value, room } = await mutate(active.code, (room) => {
        if (room.people[socket.data.personId]?.socketId !== socket.id)
          throw new Error('Join a room to continue.');
        if (!permitted(room, socket.data.personId, need)) throw new Error(deniedMessage(need));
        return handler(room);
      });
      if (broadcastState && Object.keys(room.people).length) broadcast(room);
      return { value, room };
    };
    event('room:create', async (data) => {
      const input = z
        .object({ identity: identitySchema, name: z.string().trim().min(1).max(48) })
        .parse(data);
      if (socket.data.code) throw new Error('Leave your current room first.');
      const rateKey = `syncadda:create:${socket.handshake.address}`,
        total = await redis.incr(rateKey);
      if (total === 1) await redis.expire(rateKey, 60);
      if (total > 12) throw new Error('Please wait a minute before creating another room.');
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let room;
      for (let i = 0; i < 8; i++) {
        const code = [...randomBytes(6)].map((n) => alphabet[n % alphabet.length]).join('');
        const candidate = {
          code,
          name: input.name,
          hostId: input.identity.id,
          locked: false,
          everyoneControls: false,
          queueAccess: [],
          lastActivity: Date.now(),
          people: {
            [input.identity.id]: {
              ...input.identity,
              socketId: socket.id,
              online: true,
              mic: false,
              camera: false,
              inCall: false,
            },
          },
          banned: [],
          playlist: [],
          currentId: null,
          playback: { position: 0, playing: false, rate: 1, updatedAt: Date.now() },
          messages: [],
        };
        system(candidate, `${input.identity.name} joined. Make yourself at home!`);
        if (
          (await redis.set(key(code), JSON.stringify(candidate), 'EX', 6 * 3600, 'NX')) === 'OK'
        ) {
          room = candidate;
          break;
        }
      }
      if (!room) throw new Error('Could not create a room. Please try again.');
      socket.data = { code: room.code, personId: input.identity.id };
      await socket.join(room.code);
      broadcast(room);
      return { room: snapshot(room, true) };
    });
    event('room:join', async (data) => {
      const input = z
        .object({ code: codeSchema, identity: identitySchema, call: callSchema })
        .parse(data);
      if (socket.data.code && socket.data.code !== input.code)
        throw new Error('Leave your current room first.');
      const { value: oldSocketId, room } = await mutate(input.code, (room) => {
        const existing = room.people[input.identity.id];
        if (existing && !sameSecret(existing.token, input.identity.token))
          throw new Error('This session could not be restored. Please open a new tab.');
        if (room.banned.includes(input.identity.id))
          throw new Error('You were removed from this room.');
        if (room.locked && !existing)
          throw new Error('This room is locked. Ask the host to unlock it.');
        if (Object.keys(room.people).length >= 8 && !existing)
          throw new Error('This room is full (8 people).');
        const oldId = existing?.socketId;
        room.people[input.identity.id] = {
          ...input.identity,
          socketId: socket.id,
          online: true,
          ...input.call,
        };
        if (!existing) system(room, `${input.identity.name} joined. Make yourself at home!`);
        if (Object.keys(room.people).length >= 2) room.hadCompany = true;
        return oldId;
      });
      if (oldSocketId && oldSocketId !== socket.id) {
        io.to(oldSocketId).emit('room:ended', {
          message: 'Your session was opened in another tab.',
        });
        io.in(oldSocketId).socketsLeave(input.code);
      }
      socket.data = { code: input.code, personId: input.identity.id };
      await socket.join(input.code);
      broadcast(room);
      return { room: snapshot(room, true) };
    });
    event('room:leave', async () => {
      // Leave the broadcast first, so a room closing because of this doesn't notify the leaver.
      await socket.leave(socket.data.code);
      const { room } = await change((room) => remove(room, socket.data.personId), {
        broadcastState: false,
      });
      socket.data = {};
      if (Object.keys(room.people).length) broadcast(room);
    });
    event('room:settings', async (data) => {
      const input = z
        .object({
          locked: z.boolean().optional(),
          everyoneControls: z.boolean().optional(),
          name: z.string().trim().min(1).max(48).optional(),
        })
        .parse(data);
      await change((room) => Object.assign(room, input), { need: 'host' });
    });
    event('room:transfer', async (data) => {
      await change(
        (room) => {
          if (!room.people[data.id]?.online) throw new Error('That person is not connected.');
          room.hostId = data.id;
          system(room, `${room.people[data.id].name} is now the host.`);
        },
        { need: 'host' },
      );
    });
    event('room:queue-access', async (data) => {
      const input = z.object({ id: z.string().uuid(), allowed: z.boolean() }).parse(data);
      await change(
        (room) => {
          const person = room.people[input.id];
          if (!person) throw new Error('That person has already left.');
          room.queueAccess = (room.queueAccess ?? []).filter((id) => id !== input.id);
          if (input.allowed) room.queueAccess.push(input.id);
          system(
            room,
            input.allowed
              ? `${person.name} can now add to the queue.`
              : `${person.name} can no longer add to the queue.`,
          );
        },
        { need: 'host' },
      );
    });
    event('room:kick', async (data) => {
      const { value: target, room } = await change(
        (room) => {
          if (data.id === room.hostId) throw new Error('You cannot remove yourself.');
          const person = room.people[data.id];
          if (!person) throw new Error('That person has already left.');
          room.banned.push(data.id);
          remove(room, data.id, { kicked: true });
          return person.socketId;
        },
        { need: 'host', broadcastState: false },
      );
      io.to(target).emit('room:ended', { message: 'The host removed you from this room.' });
      io.in(target).socketsLeave(room.code);
      if (Object.keys(room.people).length) broadcast(room);
    });
    event('room:close', async () => {
      const { room } = await change(
        (room) => {
          room.people = {};
        },
        { need: 'host', broadcastState: false },
      );
      io.to(room.code).emit('room:ended', {
        message: 'The host ended this watch party. See you next time!',
      });
      io.in(room.code).socketsLeave(room.code);
    });
    event('chat:send', async (data) => {
      const text = z.string().trim().min(1).max(1500).parse(data.text);
      await change((room) => {
        const person = room.people[socket.data.personId];
        room.messages.push({
          id: randomUUID(),
          personId: person.id,
          name: person.name,
          text,
          at: Date.now(),
        });
        room.messages = room.messages.slice(-MAX_MESSAGES);
      });
    });
    event('reaction:send', async (data) => {
      const emoji = z.enum(['❤️', '😂', '🔥', '👏', '🍿', '✨']).parse(data.emoji);
      const room = await current();
      io.to(room.code).emit('reaction', {
        emoji,
        name: room.people[socket.data.personId].name,
        id: randomUUID(),
      });
    });
    event('media:add', async (data) => {
      const media = { ...mediaSchema.parse(data), id: randomUUID() };
      await change(
        (room) => {
          if (room.playlist.length >= 40)
            throw new Error('Your queue is full. Remove an item first.');
          room.playlist.push(media);
          if (!room.currentId) {
            room.currentId = media.id;
            room.playback = { position: 0, playing: false, rate: 1, updatedAt: Date.now() };
          }
        },
        { need: 'add' },
      );
    });
    event('media:select', async (data) => {
      await change(
        (room) => {
          if (!room.playlist.some((m) => m.id === data.id))
            throw new Error('That item is no longer in the queue.');
          room.currentId = data.id;
          room.playback = { position: 0, playing: false, rate: 1, updatedAt: Date.now() };
        },
        { need: 'control' },
      );
    });
    event('media:remove', async (data) => {
      await change(
        (room) => {
          room.playlist = room.playlist.filter((m) => m.id !== data.id);
          if (room.currentId === data.id) {
            room.currentId = room.playlist[0]?.id || null;
            room.playback = { position: 0, playing: false, rate: 1, updatedAt: Date.now() };
          }
        },
        { need: 'control' },
      );
    });
    event('playback:update', async (data) => {
      const input = z
        .object({
          mediaId: z.string().uuid(),
          playing: z.boolean().optional(),
          position: z.number().finite().min(0).max(864000).optional(),
          rate: z.number().min(0.25).max(2).optional(),
        })
        .parse(data);
      const { room } = await change(
        (room) => {
          if (!room.currentId || input.mediaId !== room.currentId)
            throw new Error('The media has changed. Try again.');
          room.playback = {
            playing: input.playing ?? room.playback.playing,
            position: input.position ?? positionAt(room.playback),
            rate: input.rate ?? room.playback.rate,
            updatedAt: Date.now(),
          };
        },
        { need: 'control', broadcastState: false },
      );
      io.to(room.code).emit('playback:state', {
        playback: room.playback,
        currentId: room.currentId,
        serverTime: Date.now(),
      });
    });
    event('playback:sync', async () => {
      const room = await current();
      return { playback: room.playback, currentId: room.currentId, serverTime: Date.now() };
    });
    event('call:status', async (data) => {
      const status = z
        .object({ inCall: z.boolean(), mic: z.boolean(), camera: z.boolean() })
        .parse(data);
      await change((room) =>
        Object.assign(
          room.people[socket.data.personId],
          status.inCall ? status : { inCall: false, mic: false, camera: false },
        ),
      );
    });
    event('call:signal', async (data) => {
      const input = z
        .object({
          to: z.string().uuid(),
          description: z
            .object({ type: z.enum(['offer', 'answer']), sdp: z.string().max(65536) })
            .optional(),
          candidate: z.record(z.unknown()).optional(),
        })
        .parse(data);
      const room = await current(),
        target = room.people[input.to];
      if (!room.people[socket.data.personId].inCall || !target?.online || !target.inCall)
        throw new Error('That person is not in the call.');
      io.to(target.socketId).emit('call:signal', {
        from: socket.data.personId,
        description: input.description,
        candidate: input.candidate,
      });
    });
    event('clock:ping', () => ({ serverTime: Date.now() }));
    socket.on('disconnect', async () => {
      const code = socket.data.code,
        id = socket.data.personId;
      if (!code || !id) return;
      try {
        const { room } = await mutate(code, (room) => {
          const person = room.people[id];
          if (!person || person.socketId !== socket.id) return;
          // Call status is kept: the call is peer-to-peer and survives a brief reconnect.
          Object.assign(person, { online: false, offlineSince: Date.now() });
          // The host keeps hosting while reconnecting; it passes on only if they leave for good.
        });
        if (Object.keys(room.people).length) broadcast(room);
        for (const [name, ms] of [
          [socket.id, graceMs],
          [`${socket.id}:call`, callGraceMs],
        ]) {
          const timer = setTimeout(async () => {
            timers.delete(name);
            try {
              const { room } = await mutate(code, (room) => prune(room));
              if (Object.keys(room.people).length) broadcast(room);
            } catch {
              /* room closed */
            }
          }, ms);
          timer.unref();
          timers.set(name, timer);
        }
      } catch (error) {
        if (!String(error?.message).includes('room could not be found'))
          console.error('Could not save disconnected room state:', error);
      }
    });
  });
  return {
    redis,
    async dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      await Promise.all([redis.quit(), subscriber.quit()]);
    },
  };
}
