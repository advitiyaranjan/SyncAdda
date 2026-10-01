// A file "played without uploading" never goes to a server. The device it's on streams it
// straight to the others in the room, peer to peer, while everyone watches: nobody waits for
// an upload. Each viewer's <video> asks for the bytes it needs as it would from a web server;
// a service worker (public/stream-sw.js) hands those requests to this page, which fetches them
// from the sharer in blocks over a data channel. So seeking works, and only what is watched
// is sent.
import { request, socket } from './lib';
import { chosenFile, localFile } from './localFiles';
import { nameType } from './uploads';

const PIECE = 32 * 1024; // one message on the data channel
const BLOCK = 16 * PIECE; // what a viewer asks for at a time
const AHEAD = 2 * BLOCK; // what a viewer holds beyond what its player has taken
const STALL_MS = 8000;

type Signal = {
  from: string;
  link: string;
  // Which end of the connection sent it: the one watching, or the one with the file.
  role: 'viewer' | 'source';
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};
type Link = { id: string; peer: string; pc: RTCPeerConnection };
// What a viewer asks the sharer for: bytes `start` up to `end` of the file behind a `local:` link.
type BlockRequest = { id: number; url: string; start: number; end: number };
type Read = { piece(bytes: ArrayBuffer): void; end(failed: boolean): void };
type Upstream = Link & {
  channel: RTCDataChannel;
  opened: Promise<void>;
  pending: RTCIceCandidateInit[];
  reads: Map<number, Read>;
  close(): void;
};
type Stream = {
  url: string;
  size: number;
  type: string;
  source: string;
  link?: Upstream;
  connecting?: Promise<Upstream>;
  readers: Set<{ cancel(): void }>;
  // The sharer's device can't be reached, or no longer has the file open.
  waiting: boolean;
  stopped: boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let ice: Promise<RTCConfiguration> | undefined;
const configuration = () =>
  (ice ??= fetch('/api/ice')
    .then((response) => response.json() as Promise<RTCConfiguration>)
    .catch(() => {
      ice = undefined;
      return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    }));
const signal = (link: Link, role: Signal['role'], data: Partial<Signal>) =>
  request('file:signal', { to: link.peer, link: link.id, role, ...data });

// ── The device that has the file ──────────────────────────────────────────────────────────

const viewers = new Map<string, Link>();
function dropViewer(link: Link) {
  if (viewers.get(link.id) === link) viewers.delete(link.id);
  link.pc.close();
}
const drained = (channel: RTCDataChannel) =>
  new Promise<void>((resolve) => {
    const done = () => {
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', done);
      resolve();
    };
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', done);
  });
function serve(link: Link, channel: RTCDataChannel) {
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = BLOCK;
  const active = new Set<number>();
  const send = async ({ id, url, start, end }: BlockRequest) => {
    const file = chosenFile(url);
    try {
      if (!file || !(start >= 0 && start < end && end <= file.size && end - start <= BLOCK))
        throw new Error('That part of the file isn’t here.');
      active.add(id);
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
      // Each piece carries the number of the request it answers.
      for (let at = 0; at < bytes.length && active.has(id); at += PIECE) {
        // Only as fast as it goes out, so a slow connection doesn't fill this device's memory.
        if (channel.bufferedAmount > 2 * BLOCK) await drained(channel);
        const piece = new Uint8Array(4 + Math.min(PIECE, bytes.length - at));
        new DataView(piece.buffer).setUint32(0, id);
        piece.set(bytes.subarray(at, at + PIECE), 4);
        channel.send(piece);
      }
      if (active.delete(id)) channel.send(JSON.stringify({ id }));
    } catch {
      active.delete(id);
      if (channel.readyState === 'open') channel.send(JSON.stringify({ id, failed: true }));
    }
  };
  channel.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    // The viewer's player moved on (a seek, say) before this block was sent.
    if (message.stop) active.delete(message.stop);
    else void send(message);
  };
  channel.onclose = () => dropViewer(link);
}
async function fromViewer({ from, link: id, description, candidate }: Signal) {
  let link = viewers.get(id);
  if (!link) {
    if (description?.type !== 'offer') return;
    // Each viewer keeps one connection to us: a new one replaces the last.
    for (const old of [...viewers.values()]) if (old.peer === from) dropViewer(old);
    const created: Link = { id, peer: from, pc: new RTCPeerConnection(await configuration()) };
    link = created;
    viewers.set(id, created);
    created.pc.onicecandidate = (event) => {
      if (event.candidate)
        signal(created, 'source', { candidate: event.candidate.toJSON() }).catch(() => {});
    };
    created.pc.onconnectionstatechange = () => {
      if (created.pc.connectionState === 'failed') dropViewer(created);
    };
    created.pc.ondatachannel = ({ channel }) => serve(created, channel);
  }
  if (description) {
    await link.pc.setRemoteDescription(description);
    await link.pc.setLocalDescription();
    if (link.pc.localDescription)
      await signal(link, 'source', { description: link.pc.localDescription.toJSON() });
  } else if (candidate) await link.pc.addIceCandidate(candidate);
}

// ── Everyone watching it ──────────────────────────────────────────────────────────────────

const upstreams = new Map<string, Upstream>();
async function connect(peer: string): Promise<Upstream> {
  const pc = new RTCPeerConnection(await configuration());
  const channel = pc.createDataChannel('file');
  channel.binaryType = 'arraybuffer';
  const id = crypto.randomUUID(),
    reads = new Map<number, Read>();
  let close = () => {};
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => close(), 20_000);
    channel.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    close = () => {
      clearTimeout(timer);
      if (!upstreams.delete(id)) return;
      pc.close();
      reject(new Error('The connection was lost.'));
      for (const read of [...reads.values()]) read.end(true);
      reads.clear();
    };
  });
  opened.catch(() => {});
  const link: Upstream = { id, peer, pc, channel, opened, pending: [], reads, close };
  upstreams.set(id, link);
  channel.onclose = () => link.close();
  pc.onconnectionstatechange = () => {
    // A new connection is quicker than waiting to see whether this one recovers.
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') link.close();
  };
  pc.onicecandidate = (event) => {
    if (event.candidate)
      signal(link, 'viewer', { candidate: event.candidate.toJSON() }).catch(() => {});
  };
  channel.onmessage = ({ data }) => {
    if (typeof data !== 'string')
      return reads.get(new DataView(data).getUint32(0))?.piece(data.slice(4));
    const message = JSON.parse(data);
    const read = reads.get(message.id);
    reads.delete(message.id);
    read?.end(!!message.failed);
  };
  try {
    await pc.setLocalDescription();
    await signal(link, 'viewer', { description: pc.localDescription!.toJSON() });
  } catch (error) {
    link.close();
    throw error;
  }
  return link;
}
async function fromSource({ link: id, description, candidate }: Signal) {
  const link = upstreams.get(id);
  if (!link) return;
  if (description) {
    await link.pc.setRemoteDescription(description);
    for (const queued of link.pending.splice(0))
      await link.pc.addIceCandidate(queued).catch(() => {});
  } else if (candidate) {
    if (link.pc.remoteDescription) await link.pc.addIceCandidate(candidate);
    else link.pending.push(candidate);
  }
}

const streams = new Map<string, Stream>(); // by media id
const listeners = new Set<() => void>();
function setWaiting(stream: Stream, waiting: boolean) {
  if (stream.waiting === waiting) return;
  stream.waiting = waiting;
  listeners.forEach((listener) => listener());
}
/** Whether the device streaming this media is out of reach right now. */
export const streamWaiting = (mediaId: string) => !!streams.get(mediaId)?.waiting;
export function onStreamChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
// The stream's connection to the sharer, made when first needed and again whenever it's lost.
function upstream(stream: Stream) {
  if (stream.link && upstreams.has(stream.link.id)) return Promise.resolve(stream.link);
  return (stream.connecting ??= connect(stream.source)
    .then(async (link) => {
      await link.opened;
      if (stream.stopped) {
        link.close();
        throw new Error('No longer watching.');
      }
      return (stream.link = link);
    })
    .finally(() => {
      stream.connecting = undefined;
    }));
}
let requests = 0;
function readBlock(
  link: Upstream,
  stream: Stream,
  start: number,
  end: number,
  piece: (bytes: ArrayBuffer) => void,
) {
  const id = ++requests;
  let stall: ReturnType<typeof setTimeout> | undefined,
    stop = () => {};
  // Nothing for a while: the sharer's device is asleep or out of reach. It carries on if it
  // comes back.
  const watch = () => {
    clearTimeout(stall);
    stall = setTimeout(() => setWaiting(stream, true), STALL_MS);
  };
  const done = new Promise<void>((resolve, reject) => {
    link.reads.set(id, {
      piece(bytes) {
        watch();
        setWaiting(stream, false);
        piece(bytes);
      },
      end: (failed) => (failed ? reject(new Error('The file isn’t available.')) : resolve()),
    });
    stop = () => {
      if (link.reads.delete(id) && link.channel.readyState === 'open')
        link.channel.send(JSON.stringify({ stop: id }));
      resolve();
    };
  }).finally(() => clearTimeout(stall));
  watch();
  try {
    const asked: BlockRequest = { id, url: stream.url, start, end };
    link.channel.send(JSON.stringify(asked));
  } catch {
    const read = link.reads.get(id);
    link.reads.delete(id);
    read?.end(true);
    link.close();
  }
  return { done, stop };
}
// One request from the player: bytes `start` up to `end`, handed over a piece at a time.
function readRange(stream: Stream, start: number, end: number) {
  const queue: ArrayBuffer[] = [];
  let at = start,
    queued = 0,
    busy = false,
    closed = false,
    stop = () => {},
    waiter: ((piece: ArrayBuffer | null) => void) | undefined;
  const give = () => {
    if (!waiter || (!closed && !queue.length && at < end)) return;
    const piece = closed ? undefined : queue.shift();
    if (piece) queued -= piece.byteLength;
    waiter(piece ?? null);
    waiter = undefined;
  };
  const fill = async () => {
    if (busy || closed || at >= end || queued >= AHEAD) return;
    busy = true;
    try {
      const link = await upstream(stream);
      if (!closed) {
        const block = readBlock(link, stream, at, Math.min(end, at + BLOCK), (bytes) => {
          at += bytes.byteLength;
          queued += bytes.byteLength;
          queue.push(bytes);
          give();
        });
        stop = block.stop;
        await block.done;
      }
    } catch {
      // The sharer is offline, reloading, or hasn't opened the file again yet: keep trying.
      if (!closed) {
        setWaiting(stream, true);
        await sleep(1500);
      }
    }
    stop = () => {};
    busy = false;
    give();
    void fill();
  };
  const reader = {
    next: () =>
      new Promise<ArrayBuffer | null>((resolve) => {
        waiter = resolve;
        give();
        void fill();
      }),
    cancel() {
      closed = true;
      stop();
      stream.readers.delete(reader);
      give();
    },
  };
  stream.readers.add(reader);
  void fill();
  return reader;
}
// A request from the player, passed on by the service worker: answer with the response's
// status and headers, then a piece of the body each time it asks.
function answer(event: MessageEvent) {
  if (event.data?.type !== 'p2p-range') return;
  const port = event.ports[0],
    stream = streams.get(String(event.data.path).split('/')[2]);
  if (!stream) return port.postMessage(null);
  const { size } = stream;
  const range = /^bytes=(\d*)-(\d*)$/.exec(event.data.range || '');
  let start = 0,
    end = size;
  if (range?.[1]) {
    start = Number(range[1]);
    if (range[2]) end = Math.min(size, Number(range[2]) + 1);
  } else if (range?.[2]) start = Math.max(0, size - Number(range[2]));
  const satisfiable = start < end;
  port.postMessage({
    status: !satisfiable ? 416 : range ? 206 : 200,
    headers: {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': stream.type,
      ...(satisfiable ? { 'Content-Length': String(end - start) } : {}),
      ...(!satisfiable
        ? { 'Content-Range': `bytes */${size}` }
        : range
          ? { 'Content-Range': `bytes ${start}-${end - 1}/${size}` }
          : {}),
    },
  });
  const reader = readRange(stream, start, Math.max(start, end));
  port.onmessage = async ({ data }) => {
    if (!data) return reader.cancel();
    const piece = await reader.next();
    if (piece) port.postMessage(piece, [piece]);
    else port.postMessage(null);
  };
}
let worker: Promise<void> | undefined;
// The service worker has to be in charge of this page before the player asks for anything.
const ready = () =>
  (worker ??= (async () => {
    const workers = navigator.serviceWorker;
    await workers.register('/stream-sw.js');
    const { active } = await workers.ready;
    workers.addEventListener('message', answer);
    workers.startMessages();
    if (workers.controller) return;
    const claimed = new Promise((resolve) =>
      workers.addEventListener('controllerchange', resolve, { once: true }),
    );
    active?.postMessage('claim');
    await Promise.race([
      claimed,
      sleep(5000).then(() => {
        if (!workers.controller) throw new Error('The stream worker didn’t start.');
      }),
    ]);
  })().catch((error) => {
    navigator.serviceWorker?.removeEventListener('message', answer);
    worker = undefined;
    throw error;
  }));

let awake: ReturnType<typeof setInterval> | undefined;
/**
 * Streams a file from the device of the person sharing it. Resolves with the address to give
 * a <video>, or rejects where that can't work (no service worker: an old browser, or no HTTPS).
 */
export async function watchFile(media: { id: string; url: string }, source: string) {
  const file = localFile(media.url);
  if (!file) throw new Error('Not a file played from a device.');
  await ready();
  const stream: Stream = {
    url: media.url,
    size: file.size,
    type: nameType(file.name) || 'application/octet-stream',
    source,
    readers: new Set(),
    waiting: false,
    stopped: false,
  };
  streams.set(media.id, stream);
  // Browsers put an idle service worker to sleep, which would cut the stream off.
  awake ??= setInterval(() => navigator.serviceWorker.controller?.postMessage('awake'), 20_000);
  return {
    src: `/p2p/${media.id}`,
    stop() {
      stream.stopped = true;
      if (streams.get(media.id) === stream) streams.delete(media.id);
      for (const reader of [...stream.readers]) reader.cancel();
      stream.link?.close();
      if (!streams.size) {
        clearInterval(awake);
        awake = undefined;
      }
      listeners.forEach((listener) => listener());
    },
  };
}

let inbox = Promise.resolve();
const receive = (incoming: Signal) => {
  // One at a time, in order: a connection's description has to be in place before its candidates.
  inbox = inbox
    .then(() => (incoming.role === 'viewer' ? fromViewer(incoming) : fromSource(incoming)))
    .catch(() => {});
};
/** Starts answering friends who want a file that's open on this device, and the reverse. */
export function shareFiles() {
  socket.on('file:signal', receive);
  return () => {
    socket.off('file:signal', receive);
    for (const link of [...viewers.values()]) dropViewer(link);
  };
}
