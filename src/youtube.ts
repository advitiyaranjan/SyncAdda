// Minimal wrapper around the YouTube IFrame Player API so the shared player can
// drive a YouTube video with the same sync logic it uses for <video>.
import type { Engine } from './types';

type YTPlayer = {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  cueVideoById(options: { videoId: string; startSeconds?: number }): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  setVolume(volume: number): void;
  unloadModule(name: string): void;
  mute(): void;
  unMute(): void;
  destroy(): void;
};
type YTNamespace = {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      width: string;
      height: string;
      playerVars: Record<string, string | number>;
      events: {
        onReady: () => void;
        onStateChange: (event: { data: number }) => void;
        onError: (event: { data: number }) => void;
        onPlaybackRateChange: (event: { data: number }) => void;
        onAutoplayBlocked: () => void;
      };
    },
  ) => YTPlayer;
};
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

const hosts = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;
export function youtubeId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!hosts.test(parsed.hostname)) return null;
  const id = parsed.hostname.toLowerCase().endsWith('youtu.be')
    ? parsed.pathname.split('/')[1]
    : parsed.pathname === '/watch'
      ? parsed.searchParams.get('v')
      : parsed.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/)?.[1];
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}

export async function youtubeTitle(url: string, signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(
    `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
    { signal },
  );
  if (!response.ok) return null;
  const data = (await response.json()) as { title?: unknown };
  return typeof data.title === 'string' ? data.title.slice(0, 100) : null;
}

export function youtubeError(code: number) {
  if (code === 2)
    return 'This YouTube link looks incomplete. Copy the full video link and try again.';
  if (code === 5) return 'This YouTube video can’t play in this browser. Try another browser.';
  if (code === 100) return 'This YouTube video is private, removed, or unavailable.';
  if (code === 101 || code === 150)
    return 'The owner of this YouTube video doesn’t allow it to play on other websites.';
  return 'This YouTube video couldn’t load. Try again or pick another video.';
}

let api: Promise<YTNamespace> | undefined;
function loadYouTube() {
  api ??= new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      api = undefined;
      script.remove();
      reject(new Error('YouTube could not load.'));
    };
    document.head.append(script);
  });
  return api;
}

export type YouTubeEngine = Engine & { destroy(): void };

export async function createYouTubeEngine(
  host: HTMLElement,
  videoId: string,
  on: {
    ready: (engine: YouTubeEngine) => void;
    state: (state: number, automatic: boolean) => void;
    blocked: () => void;
    error: (code: number) => void;
  },
  signal?: AbortSignal,
): Promise<YouTubeEngine> {
  const YT = await loadYouTube();
  if (signal?.aborted) throw new DOMException('Player was removed.', 'AbortError');
  // YouTube replaces the element it is given, so hand it a child React doesn't own.
  const mount = document.createElement('div');
  host.replaceChildren(mount);
  let ready = false;
  // Where a cued (not yet started) video will begin; getCurrentTime() is unreliable until then.
  let cuedAt: number | null = 0;
  let seekPending: { position: number; at: number } | null = null;
  let pausePending = false;
  let autoplayBlocked = false;
  // The room's speed. YouTube resets to 1x whenever it (re)loads the video, so it's re-applied.
  let desiredRate = 1;
  let captionsOff = false;
  const keepRate = () => {
    if (player.getPlaybackRate() !== desiredRate) player.setPlaybackRate(desiredRate);
  };
  let pending: { promise: Promise<void>; done: (ok: boolean) => void; timer: number } | null = null;
  const state = () => player.getPlayerState();
  const active = () => state() === YT_STATE.PLAYING || state() === YT_STATE.BUFFERING;
  const idle = () => [YT_STATE.UNSTARTED, YT_STATE.CUED, YT_STATE.ENDED].includes(state());
  const seeking = () => {
    if (seekPending && state() !== YT_STATE.BUFFERING && !idle()) {
      if (
        Math.abs(player.getCurrentTime() - seekPending.position) < 1 ||
        Date.now() - seekPending.at > 10_000
      )
        seekPending = null;
    }
    return seekPending !== null;
  };
  const player: YTPlayer = new YT.Player(mount, {
    videoId,
    width: '100%',
    height: '100%',
    playerVars: {
      // YouTube's own controls (captions, quality, settings) are shown; Player shares the owner's
      // play, pause, and seek from them with everyone.
      controls: 1,
      cc_load_policy: 0,
      iv_load_policy: 3,
      playsinline: 1,
      rel: 0,
      origin: location.origin,
    },
    events: {
      onReady: () => {
        ready = true;
        on.ready(engine);
      },
      onStateChange: ({ data }) => {
        const automatic = !!pending || !!seekPending || (pausePending && data === YT_STATE.PAUSED);
        if (data === YT_STATE.PAUSED) pausePending = false;
        if (data === YT_STATE.PLAYING) {
          cuedAt = null;
          autoplayBlocked = false;
          seeking();
          pending?.done(true);
        }
        if (data === YT_STATE.PLAYING) {
          keepRate();
          // Captions start off (YouTube may turn them on from someone's account settings);
          // anyone can still switch them on with the CC button.
          if (!captionsOff) {
            captionsOff = true;
            player.unloadModule('captions');
            player.unloadModule('cc');
          }
        }
        on.state(data, automatic);
      },
      onPlaybackRateChange: () => {
        if (state() === YT_STATE.PLAYING) keepRate();
      },
      onError: ({ data }) => {
        pending?.done(false);
        on.error(data);
      },
      onAutoplayBlocked: () => {
        autoplayBlocked = true;
        pending?.done(false);
        on.blocked();
      },
    },
  });
  const engine: YouTubeEngine = {
    nudges: false,
    ready: () => ready,
    syncing: () =>
      !autoplayBlocked && (!!pending || state() === YT_STATE.BUFFERING || (seeking() && !idle())),
    duration: () => {
      const duration = player.getDuration();
      return duration > 0 ? duration : NaN;
    },
    seekable: () => null,
    time: () =>
      seeking()
        ? seekPending!.position
        : cuedAt !== null && idle()
          ? cuedAt
          : player.getCurrentTime(),
    seek(seconds) {
      seekPending = { position: seconds, at: Date.now() };
      // Seeking a cued or ended video starts playback, so re-cue it at the new spot instead.
      if (idle()) {
        cuedAt = seconds;
        player.cueVideoById({ videoId, startSeconds: seconds });
      } else player.seekTo(seconds, true);
    },
    rate: () => player.getPlaybackRate(),
    setRate(rate) {
      desiredRate = rate;
      player.setPlaybackRate(rate);
    },
    paused: () => autoplayBlocked || !active(),
    ended: () => state() === YT_STATE.ENDED,
    play() {
      if (pending) return pending.promise;
      if (!autoplayBlocked && state() === YT_STATE.PLAYING) return Promise.resolve();
      autoplayBlocked = false;
      pausePending = false;
      if (!pending) {
        let resolve!: () => void, reject!: (error: Error) => void;
        const promise = new Promise<void>((a, b) => {
          resolve = a;
          reject = b;
        });
        // Older embeds may omit onAutoplayBlocked. Buffering is not a playback failure.
        const check = () => {
          if (!pending) return;
          if (state() === YT_STATE.BUFFERING) pending.timer = window.setTimeout(check, 8000);
          else pending.done(state() === YT_STATE.PLAYING);
        };
        const timer = window.setTimeout(check, 8000);
        pending = {
          promise,
          timer,
          done(ok) {
            if (pending) clearTimeout(pending.timer);
            pending = null;
            if (ok) resolve();
            else reject(new Error('Playback was blocked.'));
          },
        };
      }
      const { promise } = pending;
      player.playVideo();
      return promise;
    },
    pause: () => {
      pausePending = true;
      pending?.done(false);
      player.pauseVideo();
    },
    setVolume(volume, muted) {
      player.setVolume(Math.round(volume * 100));
      if (muted) player.mute();
      else player.unMute();
    },
    destroy() {
      pending?.done(false);
      player.destroy();
      mount.remove();
    },
  };
  return engine;
}
