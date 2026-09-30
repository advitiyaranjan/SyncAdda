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
};
