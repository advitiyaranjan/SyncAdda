export type Person = {
  id: string;
  name: string;
  online: boolean;
  mic: boolean;
  camera: boolean;
  inCall: boolean;
};
export type Media = { id: string; title: string; url: string; kind: 'video' | 'audio' };
export type Message = {
  id: string;
  name: string;
  text: string;
  at: number;
  system?: boolean;
  personId?: string;
};
export type Playback = { playing: boolean; position: number; rate: number; updatedAt: number };
export type Room = {
  code: string;
  name: string;
  hostId: string;
  locked: boolean;
  everyoneControls: boolean;
  // People the host has allowed to add to the queue.
  queueAccess: string[];
  participants: Person[];
  messages: Message[];
  playlist: Media[];
  currentId: string | null;
  playback: Playback;
  serverTime: number;
};
export type Identity = { id: string; token: string; name: string };
// What the shared player needs from a media source (<video> or the YouTube embed).
export type Engine = {
  nudges: boolean;
  ready(): boolean;
  // A remote seek or startup is still settling; don't interrupt it with drift corrections.
  syncing?(): boolean;
  duration(): number;
  seekable(): [number, number] | null;
  time(): number;
  seek(seconds: number): void;
  rate(): number;
  setRate(rate: number): void;
  paused(): boolean;
  ended(): boolean;
  play(): Promise<void>;
  pause(): void;
  setVolume(volume: number, muted: boolean): void;
  // Picture qualities this viewer can pick from besides 'auto' (YouTube only), best first.
  qualities?(): string[];
  setQuality?(level: string): void;
};
