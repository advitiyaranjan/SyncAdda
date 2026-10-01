import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { deleteUploads, droppedUploads } from './uploads.js';

const identity = z.object({
  id: z.string().uuid(),
  token: z.string().min(32).max(128),
  name: z.string().trim().min(1).max(24),
});
const codeSchema = z.string().regex(/^[A-Z2-9]{6}$/);
const offCall = { inCall: false, mic: false, camera: false };
// Sent when rejoining after a dropped connection, so an ongoing call isn't reset.
export const callSchema = z
  .object({ inCall: z.boolean(), mic: z.boolean(), camera: z.boolean() })
  .transform((call) => (call.inCall ? call : offCall))
  .default(offCall);
const mediaSchema = z.object({
  title: z.string().trim().min(1).max(100),
  url: z
    .string()
    .url()
    .max(2048)
    // A web link, or a file played from the device of whoever added it (its name and size).
    .refine(
      (value) => /^https?:\/\//i.test(value) || /^local:[^#]+#\d+$/.test(value),
      'Use an http or https media URL.',
    ),
  kind: z.enum(['video', 'audio']),
});
// Sets up the peer-to-peer connection that streams such a file to someone watching. `role` is
// the sender's end of it, and `link` tells one connection from the next between the same two.
export const fileSignalSchema = z.object({
  to: z.string().uuid(),
  link: z.string().min(1).max(64),
  role: z.enum(['viewer', 'source']),
  description: z
    .object({ type: z.enum(['offer', 'answer']), sdp: z.string().max(65536) })
    .optional(),
  candidate: z.record(z.unknown()).optional(),
});
/**
 * Whether a person may do something that needs 'host', 'control' (playback and queue order) or 'add'
 * (adding to the queue). The host can do everything; the host can hand out queue access per person,
 * or give everyone the remote with the everyoneControls setting.
 */
export function permitted(room, id, need) {
  if (!need || room.hostId === id) return true;
  if (need === 'host') return false;
  if (room.everyoneControls) return true;
  return need === 'add' && (room.queueAccess ?? []).includes(id);
}
export const deniedMessage = (need) =>
  need === 'add' ? 'Ask the host to let you add to the queue.' : 'Only the host can do that.';
// Chat is kept for the life of the room (up to this many messages); live updates carry only the
// latest ones, and joining sends the whole history.
export const MAX_MESSAGES = 5000;
export const STATE_MESSAGES = 100;
// A room is never closed while anyone is in it. Once everyone has gone it closes, unless
// something is still playing: then it is kept this long, so people whose connections dropped
// (locked phones, say) find it again.
export const EMPTY_MS = 6 * 3600_000;
export const isAbandoned = (room, people, emptyMs = EMPTY_MS, now = Date.now()) =>
  !people.length && (!room.playback.playing || now - (room.lastActivity ?? now) >= emptyMs);
export const positionAt = (playback, now = Date.now()) =>
  playback.position +
  (playback.playing ? (Math.max(0, now - playback.updatedAt) / 1000) * playback.rate : 0);
export function attachRooms(
  io,
  {
    graceMs = 90_000,
    callGraceMs = 15_000,
    emptyMs = EMPTY_MS,
    // Rooms one address may create in a minute. The browser tests create more than that.
    createLimit = Number(process.env.ROOM_CREATE_LIMIT) || 12,
  } = {},
) {
  const rooms = new Map();
  const timers = new Set();
  const creationLimits = new Map();
  const snapshot = (room, full = false) => ({
    ...room,
    messages: full ? room.messages : room.messages.slice(-STATE_MESSAGES),
    banned: undefined,
    participants: [...room.people.values()].map(({ token, socketId, timer, ...person }) => person),
    people: undefined,
    serverTime: Date.now(),
  });
  const broadcast = (room) => {
    room.lastActivity = Date.now();
    io.to(room.code).emit('room:state', snapshot(room));
  };
  const discard = (room) => {
    rooms.delete(room.code);
    void deleteUploads(droppedUploads(room.playlist, []));
  };
  const endRoom = (room, message) => {
    io.to(room.code).emit('room:ended', { message });
    for (const p of room.people.values()) {
      clearTimeout(p.timer);
      timers.delete(p.timer);
      const s = io.sockets.sockets.get(p.socketId);
      if (s) {
        s.leave(room.code);
        s.data = {};
      }
    }
    rooms.delete(room.code);
    void deleteUploads(droppedUploads(room.playlist, []));
  };
  const system = (room, text) => {
    room.messages.push({ id: randomUUID(), name: 'SyncAdda', text, at: Date.now(), system: true });
    room.messages = room.messages.slice(-MAX_MESSAGES);
  };
  const remove = (room, id) => {
    const person = room.people.get(id);
    if (!person) return;
    clearTimeout(person.timer);
    timers.delete(person.timer);
    room.people.delete(id);
    room.queueAccess = room.queueAccess.filter((p) => p !== id);
    system(room, `${person.name} left the room.`);
    if (!room.people.size) {
      room.lastActivity = Date.now();
      if (isAbandoned(room, [], emptyMs)) discard(room);
      return;
    }
    if (room.hostId === id) {
      room.hostId = (
        [...room.people.values()].find((p) => p.online) || [...room.people.values()][0]
      ).id;
      system(room, `${room.people.get(room.hostId).name} is now the host.`);
    }
    broadcast(room);
  };
  io.on('connection', (socket) => {
    let windowStart = Date.now(),
      count = 0,
      signals = 0;
    const event = (name, handler) =>
      socket.on(name, async (data, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          if (Date.now() - windowStart > 10_000) {
            windowStart = Date.now();
            count = 0;
            signals = 0;
          }
          // Connection setup sends a burst of ICE candidates per peer, so it gets its own budget.
          if (name.endsWith(':signal') ? ++signals > 800 : ++count > 140)
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
      });
    const current = (need) => {
      const room = rooms.get(socket.data.code);
      if (!room || room.people.get(socket.data.personId)?.socketId !== socket.id)
        throw new Error('Join a room to continue.');
      if (!permitted(room, socket.data.personId, need)) throw new Error(deniedMessage(need));
      return room;
    };
    const join = async (room, user, call = offCall) => {
      if (socket.data.code && socket.data.code !== room.code)
        throw new Error('Leave your current room first.');
      const existing = room.people.get(user.id);
      if (
        existing &&
        (existing.token.length !== user.token.length ||
          !timingSafeEqual(Buffer.from(existing.token), Buffer.from(user.token)))
      )
        throw new Error('This session could not be restored. Please open a new tab.');
      if (room.banned.has(user.id)) throw new Error('You were removed from this room.');
      // Everyone had left a room that was still playing: whoever returns first hosts it.
      const empty = !room.people.size;
      if (room.locked && !existing && !empty)
        throw new Error('This room is locked. Ask the host to unlock it.');
      if (room.people.size >= 8 && !existing) throw new Error('This room is full (8 people).');
      if (empty) room.hostId = user.id;
      if (existing) {
        clearTimeout(existing.timer);
        timers.delete(existing.timer);
        if (existing.socketId && existing.socketId !== socket.id) {
          const old = io.sockets.sockets.get(existing.socketId);
          if (old) {
            old.leave(room.code);
            old.data = {};
            old.emit('room:ended', { message: 'Your session was opened in another tab.' });
          }
        }
      }
      room.people.set(user.id, {
        id: user.id,
        token: user.token,
        name: user.name,
        socketId: socket.id,
        online: true,
        ...call,
      });
      socket.data = { code: room.code, personId: user.id };
      await socket.join(room.code);
      if (!existing) system(room, `${user.name} joined. Make yourself at home!`);
      broadcast(room);
      return { room: snapshot(room, true) };
    };
    event('room:create', async (data) => {
      const input = z.object({ identity, name: z.string().trim().min(1).max(48) }).parse(data);
      if (socket.data.code) throw new Error('Leave your current room first.');
      const address = socket.handshake.address;
      const limit = creationLimits.get(address) || { count: 0, at: Date.now() };
      if (Date.now() - limit.at > 60_000) {
        limit.count = 0;
        limit.at = Date.now();
      }
      if (++limit.count > createLimit || rooms.size >= 1000)
        throw new Error('Please wait a minute before creating another room.');
      creationLimits.set(address, limit);
      let code;
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      do {
        code = [...randomBytes(6)].map((n) => alphabet[n % alphabet.length]).join('');
      } while (rooms.has(code));
      const room = {
        code,
        name: input.name,
        hostId: input.identity.id,
        locked: false,
        everyoneControls: false,
        queueAccess: [],
        people: new Map(),
        banned: new Set(),
        playlist: [],
        currentId: null,
        playback: { position: 0, playing: false, rate: 1, updatedAt: Date.now() },
        messages: [],
      };
      rooms.set(code, room);
      return join(room, input.identity);
    });
    event('room:join', (data) => {
      const input = z.object({ code: codeSchema, identity, call: callSchema }).parse(data);
      const room = rooms.get(input.code);
      if (!room)
        throw new Error('That room could not be found. Check the code or create a new one.');
      return join(room, input.identity, input.call);
    });
    event('room:leave', async () => {
      const room = current();
      const id = socket.data.personId;
      await socket.leave(room.code);
      socket.data = {};
      remove(room, id);
    });
    event('room:settings', (data) => {
      const room = current('host');
      const input = z
        .object({
          locked: z.boolean().optional(),
          everyoneControls: z.boolean().optional(),
          name: z.string().trim().min(1).max(48).optional(),
        })
        .parse(data);
      Object.assign(room, input);
      broadcast(room);
    });
    event('room:transfer', (data) => {
      const room = current('host');
      if (!room.people.get(data.id)?.online) throw new Error('That person is not connected.');
      room.hostId = data.id;
      system(room, `${room.people.get(data.id).name} is now the host.`);
      broadcast(room);
    });
    event('room:queue-access', (data) => {
      const room = current('host');
      const input = z.object({ id: z.string().uuid(), allowed: z.boolean() }).parse(data);
      const person = room.people.get(input.id);
      if (!person) throw new Error('That person has already left.');
      room.queueAccess = room.queueAccess.filter((id) => id !== input.id);
      if (input.allowed) room.queueAccess.push(input.id);
      system(
        room,
        input.allowed
          ? `${person.name} can now add to the queue.`
          : `${person.name} can no longer add to the queue.`,
      );
      broadcast(room);
    });
    event('room:kick', (data) => {
      const room = current('host');
      if (data.id === room.hostId) throw new Error('You cannot remove yourself.');
      const person = room.people.get(data.id);
      if (!person) throw new Error('That person has already left.');
      room.banned.add(data.id);
      const target = io.sockets.sockets.get(person.socketId);
      if (target) {
        target.leave(room.code);
        target.data = {};
        target.emit('room:ended', { message: 'The host removed you from this room.' });
      }
      remove(room, data.id);
    });
    event('room:close', () => {
      endRoom(current('host'), 'The host ended this watch party. See you next time!');
    });
    event('chat:send', (data) => {
      const room = current();
      const text = z.string().trim().min(1).max(1500).parse(data.text);
      const p = room.people.get(socket.data.personId);
      room.messages.push({ id: randomUUID(), personId: p.id, name: p.name, text, at: Date.now() });
      room.messages = room.messages.slice(-MAX_MESSAGES);
      broadcast(room);
    });
    event('reaction:send', (data) => {
      const room = current();
      const emoji = z.enum(['❤️', '😂', '🔥', '👏', '🍿', '✨']).parse(data.emoji);
      io.to(room.code).emit('reaction', {
        emoji,
        name: room.people.get(socket.data.personId).name,
        id: randomUUID(),
      });
    });
    event('media:add', (data) => {
      const room = current('add');
      if (room.playlist.length >= 40) throw new Error('Your queue is full. Remove an item first.');
      const media = { ...mediaSchema.parse(data), id: randomUUID(), by: socket.data.personId };
      room.playlist.push(media);
      if (!room.currentId) {
        room.currentId = media.id;
        room.playback = { position: 0, playing: false, rate: 1, updatedAt: Date.now() };
      }
      broadcast(room);
    });
    event('media:select', (data) => {
      const room = current('control');
      if (!room.playlist.some((m) => m.id === data.id))
        throw new Error('That item is no longer in the queue.');
      room.currentId = data.id;
      room.playback = { position: 0, playing: false, rate: 1, updatedAt: Date.now() };
      broadcast(room);
    });
    event('media:remove', (data) => {
      const room = current('control');
      const before = room.playlist;
      room.playlist = room.playlist.filter((m) => m.id !== data.id);
      void deleteUploads(droppedUploads(before, room.playlist));
      if (room.currentId === data.id) {
        room.currentId = room.playlist[0]?.id || null;
        room.playback = { position: 0, playing: false, rate: 1, updatedAt: Date.now() };
      }
      broadcast(room);
    });
    event('playback:update', (data) => {
      const room = current('control');
      const input = z
        .object({
          mediaId: z.string().uuid(),
          playing: z.boolean().optional(),
          position: z.number().finite().min(0).max(864000).optional(),
          rate: z.number().min(0.25).max(2).optional(),
        })
        .parse(data);
      if (!room.currentId || input.mediaId !== room.currentId)
        throw new Error('The media has changed. Try again.');
      room.playback = {
        playing: input.playing ?? room.playback.playing,
        position: input.position ?? positionAt(room.playback),
        rate: input.rate ?? room.playback.rate,
        updatedAt: Date.now(),
      };
      io.to(room.code).emit('playback:state', {
        playback: room.playback,
        currentId: room.currentId,
        serverTime: Date.now(),
      });
    });
    event('playback:sync', () => {
      const room = current();
      return { playback: room.playback, currentId: room.currentId, serverTime: Date.now() };
    });
    event('call:status', (data) => {
      const room = current();
      const status = z
        .object({ inCall: z.boolean(), mic: z.boolean(), camera: z.boolean() })
        .parse(data);
      Object.assign(
        room.people.get(socket.data.personId),
        status.inCall ? status : { inCall: false, mic: false, camera: false },
      );
      broadcast(room);
    });
    event('call:signal', (data) => {
      const room = current();
      const input = z
        .object({
          to: z.string().uuid(),
          description: z
            .object({ type: z.enum(['offer', 'answer']), sdp: z.string().max(65536) })
            .optional(),
          candidate: z.record(z.unknown()).optional(),
        })
        .parse(data);
      const target = room.people.get(input.to);
      if (!room.people.get(socket.data.personId).inCall || !target?.online || !target.inCall)
        throw new Error('That person is not in the call.');
      io.to(target.socketId).emit('call:signal', {
        from: socket.data.personId,
        description: input.description,
        candidate: input.candidate,
      });
    });
    event('file:signal', (data) => {
      const room = current();
      const { to, ...signal } = fileSignalSchema.parse(data);
      const target = room.people.get(to);
      if (!target?.online || to === socket.data.personId)
        throw new Error('That person isn’t here right now.');
      io.to(target.socketId).emit('file:signal', { from: socket.data.personId, ...signal });
    });
    event('clock:ping', () => ({ serverTime: Date.now() }));
    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.code),
        person = room?.people.get(socket.data.personId);
      if (!person || person.socketId !== socket.id) return;
      // Call status is kept: the call is peer-to-peer and survives a brief reconnect.
      person.online = false;
      person.timer = setTimeout(() => remove(room, person.id), graceMs);
      person.timer.unref();
      timers.add(person.timer);
      // If they don't come back quickly (e.g. closed the tab), they're no longer in the call.
      const callTimer = setTimeout(() => {
        timers.delete(callTimer);
        if (room.people.get(person.id) !== person || person.online || !person.inCall) return;
        Object.assign(person, offCall);
        broadcast(room);
      }, callGraceMs);
      callTimer.unref();
      timers.add(callTimer);
      broadcast(room);
    });
  });
  const cleanup = setInterval(() => {
    for (const [key, value] of creationLimits)
      if (Date.now() - value.at > 60_000) creationLimits.delete(key);
  }, 60_000);
  cleanup.unref();
  const emptySweep = setInterval(
    () => {
      for (const room of rooms.values())
        if (isAbandoned(room, [...room.people.values()], emptyMs)) discard(room);
    },
    Math.min(60_000, emptyMs / 2),
  );
  emptySweep.unref();
  return {
    rooms,
    dispose() {
      clearInterval(cleanup);
      clearInterval(emptySweep);
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
