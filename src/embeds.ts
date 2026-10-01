// Videos on Vimeo, Facebook, and Twitch play in those sites' own embedded players, driven by the
// same sync logic as <video> and YouTube. (Sites whose players can't be controlled from outside,
// such as X and Instagram, can't be kept in sync, so they aren't offered.)
import { YT_STATE, type YouTubeEngine } from './youtube';

export type Embed = { site: 'vimeo' | 'facebook' | 'twitch'; url: string };
type Status = 'idle' | 'playing' | 'buffering' | 'paused' | 'ended';
// What each site's player has to do; the rest is the same for all of them.
type Site = {
  play(): unknown;
  pause(): void;
  seek(seconds: number): void;
  time(): number;
  duration(): number;
  setRate?(rate: number): void;
  setVolume(volume: number, muted: boolean): void;
  destroy(): void;
};
type Setup = (
  mount: HTMLElement,
  url: URL,
  emit: (status: Status) => void,
  fail: (message: string) => void,
) => Promise<Site>;

export function embedFor(link: string): Embed | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|web|player)\./, '');
  if (host === 'vimeo.com' && /\/\d{6,}/.test(url.pathname)) return { site: 'vimeo', url: link };
  if (host === 'fb.watch' && url.pathname.length > 1) return { site: 'facebook', url: link };
  if (host === 'facebook.com' && /\/(videos?|watch|reel|share\/[vr])\b/.test(url.pathname))
    return { site: 'facebook', url: link };
  if (host === 'twitch.tv' && /^\/(videos\/\d+|\w+)\/?$/.test(url.pathname))
    return { site: 'twitch', url: link };
  return null;
}

const scripts = new Map<string, Promise<void>>();
function loadScript(src: string) {
  let loading = scripts.get(src);
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        scripts.delete(src);
        script.remove();
        reject(new Error('The player could not load.'));
      };
      document.head.append(script);
    });
    scripts.set(src, loading);
  }
  return loading;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const vimeo: Setup = async (mount, url, emit, fail) => {
  await loadScript('https://player.vimeo.com/api/player.js');
  const player = new (window as any).Vimeo.Player(mount, {
    url: url.href,
    controls: false,
    playsinline: true,
    autopause: false,
    dnt: true,
  });
  // Vimeo only answers questions asynchronously, so the position is kept from its updates.
  let position = 0,
    at = Date.now(),
    duration = NaN,
    rate = 1,
    playing = false;
  const mark = (seconds: number) => {
    position = seconds;
    at = Date.now();
  };
  const time = () => (playing ? position + ((Date.now() - at) / 1000) * rate : position);
  const stopped = (status: Status) => {
    mark(time());
    playing = false;
    emit(status);
  };
  player.on('timeupdate', (data: { seconds: number; duration: number }) => {
    mark(data.seconds);
    duration = data.duration;
  });
  player.on('playing', () => {
    mark(position);
    playing = true;
    emit('playing');
  });
  player.on('bufferstart', () => stopped('buffering'));
  player.on('bufferend', async () => {
    if (!(await player.getPaused())) {
      mark(position);
      playing = true;
      emit('playing');
    }
  });
  player.on('pause', () => stopped('paused'));
  player.on('ended', () => stopped('ended'));
  player.on('error', (error: { name?: string }) => {
    if (error.name === 'PrivacyError' || error.name === 'NotFoundError')
      fail('This Vimeo video is private, removed, or can’t play on other websites.');
  });
  await player.ready();
  duration = await player.getDuration();
  return {
    play: () => player.play(),
    pause: () => void player.pause().catch(() => {}),
    seek(seconds) {
      mark(seconds);
      player.setCurrentTime(seconds).catch(() => {});
    },
    time,
    duration: () => duration,
    setRate(next) {
      mark(time());
      rate = next;
      // Only videos whose owner allows it can change speed.
      player.setPlaybackRate(next).catch(() => {});
    },
    setVolume(volume, muted) {
      player.setVolume(volume).catch(() => {});
      player.setMuted(muted).catch(() => {});
    },
    destroy: () => void player.destroy().catch(() => {}),
  };
};

const twitch: Setup = async (mount, url, emit) => {
  await loadScript('https://player.twitch.tv/js/embed/v1.js');
  const Twitch = (window as any).Twitch;
  const video = /^\/videos\/(\d+)/.exec(url.pathname)?.[1];
  const player = new Twitch.Player(mount, {
    ...(video ? { video } : { channel: url.pathname.split('/')[1] }),
    parent: [location.hostname],
    width: '100%',
    height: '100%',
    autoplay: false,
    controls: false,
  });
  await new Promise<void>((resolve) => player.addEventListener(Twitch.Player.READY, resolve));
  player.addEventListener(Twitch.Player.PLAYING, () => emit('playing'));
  player.addEventListener(Twitch.Player.PAUSE, () => emit('paused'));
  player.addEventListener(Twitch.Player.ENDED, () => emit('ended'));
  return {
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (seconds) => player.seek(seconds),
    time: () => player.getCurrentTime(),
    // A live channel has no length.
    duration: () => (video ? player.getDuration() : Infinity),
    setVolume(volume, muted) {
      player.setVolume(volume);
      player.setMuted(muted);
    },
    destroy: () => mount.replaceChildren(),
  };
};

let facebookCount = 0;
const facebook: Setup = async (mount, url, emit, fail) => {
  await loadScript('https://connect.facebook.net/en_US/sdk.js');
  const FB = (window as any).FB;
  FB.init({ xfbml: false, version: 'v19.0' });
  const id = `fb-video-${++facebookCount}`;
  const holder = document.createElement('div');
  holder.id = id;
  holder.className = 'fb-video';
  holder.dataset.href = url.href;
  holder.dataset.width = 'auto';
  holder.dataset.controls = 'false';
  holder.dataset.allowfullscreen = 'false';
  mount.append(holder);
  const player = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The player could not load.')), 20_000);
    FB.Event.subscribe('xfbml.ready', (message: { type: string; id: string; instance: any }) => {
      if (message.type !== 'video' || message.id !== id) return;
      clearTimeout(timer);
      resolve(message.instance);
    });
    FB.XFBML.parse(mount);
  });
  player.subscribe('startedPlaying', () => emit('playing'));
  player.subscribe('paused', () => emit('paused'));
  player.subscribe('finishedPlaying', () => emit('ended'));
  player.subscribe('startedBuffering', () => emit('buffering'));
  player.subscribe('finishedBuffering', () => emit('playing'));
  player.subscribe('error', () =>
    fail('This Facebook video is private, removed, or can’t play on other websites.'),
  );
  return {
    play: () => player.play(),
    pause: () => player.pause(),
    seek: (seconds) => player.seek(seconds),
    time: () => player.getCurrentPosition(),
    duration: () => player.getDuration(),
    setVolume(volume, muted) {
      player.setVolume(volume);
      if (muted) player.mute();
      else player.unmute();
    },
    destroy: () => mount.replaceChildren(),
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const sites: Record<Embed['site'], Setup> = { vimeo, facebook, twitch };
const STATES: Record<Status, number> = {
  idle: YT_STATE.CUED,
  playing: YT_STATE.PLAYING,
  buffering: YT_STATE.BUFFERING,
  paused: YT_STATE.PAUSED,
  ended: YT_STATE.ENDED,
};

export async function createEmbedEngine(
  host: HTMLElement,
  embed: Embed,
  on: {
    ready: (engine: YouTubeEngine) => void;
    // A YT_STATE value; `automatic` when the change is our own doing rather than the viewer's.
    state: (state: number, automatic: boolean) => void;
    error: (message: string) => void;
  },
  signal?: AbortSignal,
): Promise<YouTubeEngine> {
  const mount = document.createElement('div');
  mount.className = 'embed-frame';
  host.replaceChildren(mount);
  let status: Status = 'idle',
    rate = 1,
    sought = { position: 0, at: 0 },
    pausePending = false,
    pending: { promise: Promise<void>; done: (ok: boolean) => void; timer: number } | null = null;
  const emit = (next: Status) => {
    const automatic =
      !!pending || Date.now() - sought.at < 1500 || (pausePending && next === 'paused');
    status = next;
    if (next === 'paused') pausePending = false;
    if (next === 'playing') pending?.done(true);
    on.state(STATES[next], automatic);
  };
  const site = await sites[embed.site](mount, new URL(embed.url), emit, (message) => {
    pending?.done(false);
    on.error(message);
  });
  if (signal?.aborted) {
    site.destroy();
    throw new DOMException('Player was removed.', 'AbortError');
  }
  const engine: YouTubeEngine = {
    nudges: false,
    ready: () => true,
    syncing: () => !!pending || status === 'buffering' || Date.now() - sought.at < 2000,
    duration: () => {
      const duration = site.duration();
      return duration > 0 ? duration : NaN;
    },
    seekable: () => null,
    // A player can report where it was for a moment after being moved.
    time: () => (Date.now() - sought.at < 1500 ? sought.position : site.time()),
    seek(seconds) {
      sought = { position: seconds, at: Date.now() };
      site.seek(seconds);
    },
    rate: () => rate,
    setRate(next) {
      rate = next;
      site.setRate?.(next);
    },
    paused: () => status !== 'playing' && status !== 'buffering',
    ended: () => status === 'ended',
    play() {
      if (pending) return pending.promise;
      if (status === 'playing') return Promise.resolve();
      pausePending = false;
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((a, b) => {
        resolve = a;
        reject = b;
      });
      // These players don't all say when the browser refuses to start them.
      const check = () => {
        if (!pending) return;
        if (status === 'buffering') pending.timer = window.setTimeout(check, 8000);
        else pending.done(status === 'playing');
      };
      pending = {
        promise,
        timer: window.setTimeout(check, 8000),
        done(ok) {
          if (pending) clearTimeout(pending.timer);
          pending = null;
          if (ok) resolve();
          else reject(new Error('Playback was blocked.'));
        },
      };
      Promise.resolve(site.play()).catch(() => pending?.done(false));
      return promise;
    },
    pause() {
      pausePending = status === 'playing' || status === 'buffering';
      pending?.done(false);
      site.pause();
    },
    setVolume: (volume, muted) => site.setVolume(volume, muted),
    destroy() {
      pending?.done(false);
      site.destroy();
      mount.remove();
    },
  };
  on.ready(engine);
  return engine;
}
