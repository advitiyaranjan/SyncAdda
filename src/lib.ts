import { io } from 'socket.io-client';
import type { Identity, Media } from './types';
const socketPath = import.meta.env.VITE_SOCKET_PATH || '/socket.io';
export const socket = io({
  path: socketPath,
  transports: socketPath === '/api/socket' ? ['websocket'] : undefined,
  autoConnect: false,
  reconnection: true,
  reconnectionDelay: 500,
  reconnectionDelayMax: 4000,
});
// Our call status, re-sent when rejoining after a dropped connection so the call carries on.
export const callState = { inCall: false, mic: false, camera: false };
export async function request<T = Record<string, never>>(
  event: string,
  data: unknown = {},
): Promise<T> {
  if (!socket.connected) throw new Error('Connecting to your room. Please try again in a moment.');
  const response = await socket
    .timeout(10000)
    .emitWithAck(event, data)
    .catch(() => {
      throw new Error('The connection took too long. Please try again.');
    });
  if (!response.ok) throw new Error(response.error);
  return response as T;
}
export function getIdentity(): Identity {
  try {
    const saved = JSON.parse(sessionStorage.getItem('syncadda-identity') || 'null');
    if (saved?.id && saved?.token) return saved;
  } catch {
    /* start a fresh session */
  }
  return { id: crypto.randomUUID(), token: crypto.randomUUID() + crypto.randomUUID(), name: '' };
}
export function rememberIdentity(identity: Identity) {
  sessionStorage.setItem('syncadda-identity', JSON.stringify(identity));
}
export const samples: Omit<Media, 'id'>[] = [
  {
    title: 'Sintel',
    url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4',
    kind: 'video',
  },
  {
    title: 'Big Buck Bunny',
    url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    kind: 'video',
  },
  {
    title: 'Tears of Steel',
    url: 'https://storage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4',
    kind: 'video',
  },
];
export const time = (seconds: number) => {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const initials = (name: string) =>
  name
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
export const colorFor = (name: string) =>
  ['peach', 'sage', 'lavender', 'blue'][[...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 4];
