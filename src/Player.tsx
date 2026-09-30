import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Film,
  LoaderCircle,
  Maximize2,
  Music2,
  Pause,
  Play,
  Plus,
  SkipForward,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type Hls from 'hls.js';
import { request, socket, time } from './lib';
import type { Engine, Playback, Room } from './types';
import {
  YT_STATE,
  createYouTubeEngine,
  youtubeError,
  youtubeId,
  type YouTubeEngine,
} from './youtube';

const videoEngine = (el: HTMLVideoElement): Engine => ({
  nudges: true,
  ready: () => el.readyState >= 1,
  duration: () => el.duration,
  seekable: () =>
    el.seekable.length ? [el.seekable.start(0), el.seekable.end(el.seekable.length - 1)] : null,
  time: () => el.currentTime,
  seek: (seconds) => {
    el.currentTime = seconds;
  },
  rate: () => el.playbackRate,
  setRate: (rate) => {
    el.playbackRate = rate;
  },
  paused: () => el.paused,
  ended: () => el.ended,
  play: () => el.play(),
  pause: () => el.pause(),
  setVolume: (volume, muted) => {
    el.volume = volume;
    el.muted = muted;
  },
});

export default function Player({
  room,
  canControl,
  canAdd,
  isHost,
  onAdd,
  notify,
}: {
  room: Room;
  canControl: boolean;
  canAdd: boolean;
  isHost: boolean;
  onAdd: () => void;
  notify: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const youtubeRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const state = useRef(room.playback);
  const offset = useRef(room.serverTime - Date.now());
  const clockSamples = useRef<{ rtt: number; offset: number }[]>([]);
  const lastSeek = useRef(0);
  const shownAt = useRef(0);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playback, setPlayback] = useState(room.playback);
  const media = room.playlist.find((m) => m.id === room.currentId);
  const videoId = media ? youtubeId(media.url) : null;
  const mediaIdRef = useRef(room.currentId);
  mediaIdRef.current = room.currentId;
  const volumeRef = useRef({ volume, muted });
  volumeRef.current = { volume, muted };
  const endedRef = useRef(() => {});
  endedRef.current = () => {
    if (isHost && canControl) void next();
  };
  // YouTube's own controls only act on this viewer's player: share the owner's play, pause, and
  // seek with everyone, and put anyone else back on the shared position.
  const youtubeActionRef = useRef((_state: number) => {});
  youtubeActionRef.current = (value) => {
    const engine = engineRef.current,
      target = state.current;
    // YouTube pauses itself when the page goes to the background; that isn't the owner's doing.
    if (!engine || document.visibilityState !== 'visible' || Date.now() - shownAt.current < 1500)
      return;
    const playing = value === YT_STATE.PLAYING,
      paused = value === YT_STATE.PAUSED;
    // Our own recent jumps also move the player; don't mistake them for a seek.
    const recentJump = Date.now() - lastSeek.current < 1500;
    const expected =
      target.position +
      (target.playing
        ? (Math.max(0, Date.now() + offset.current - target.updatedAt) / 1000) * target.rate
        : 0);
    const time = engine.time();
    const changed =
      (paused && target.playing) ||
      (playing && !target.playing) ||
      (!recentJump && (paused || playing) && Math.abs(time - expected) > 1.5);
    if (!changed) return;
    if (!canControl) return apply();
    // Take it on right away, so the sync loop doesn't undo it before the server confirms.
    state.current = { ...target, playing, position: time, updatedAt: Date.now() + offset.current };
    setPlayback(state.current);
    void update({ playing, position: time });
  };
  const apply = useCallback(() => {
    const engine = engineRef.current,
      target = state.current;
    if (!engine || !engine.ready()) return;
    let targetTime =
      target.position +
      (target.playing
        ? (Math.max(0, Date.now() + offset.current - target.updatedAt) / 1000) * target.rate
        : 0);
    const duration = engine.duration(),
      range = engine.seekable();
    if (Number.isFinite(duration)) targetTime = Math.min(targetTime, duration);
    else if (range) targetTime = Math.max(range[0], Math.min(targetTime, range[1]));
    let drift = targetTime - engine.time();
    // Big gaps jump straight to the shared position. YouTube can't fine-tune its speed, so it
    // jumps at a smaller gap; seeking rebuffers, so small gaps are closed by speed instead.
    // After a jump, give the player a moment to buffer before jumping again.
    const settled = Date.now() - lastSeek.current > 2000;
    if (
      (settled && Math.abs(drift) > (engine.nudges ? 1 : 0.5)) ||
      (!target.playing && Math.abs(drift) > 0.1)
    ) {
      engine.seek(targetTime);
      lastSeek.current = Date.now();
      drift = 0;
    }
    // Speed up or slow down slightly in proportion to the gap (closing it over about 3 seconds,
    // at most 8%), ignoring gaps under 25 ms. Browsers keep the pitch, so it isn't noticeable.
    // Corrections move in 1% steps, so phones aren't retuning the speed several times a second.
    const correction =
      engine.nudges && target.playing && Math.abs(drift) > 0.025
        ? Math.round(Math.max(-0.08, Math.min(0.08, drift / 3)) * 100) / 100
        : 0;
    const rate = target.rate * (1 + correction);
    if (Math.abs(engine.rate() - rate) > 0.004) engine.setRate(rate);
    if (target.playing && engine.paused() && !engine.ended())
      engine
        .play()
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
    else if (!target.playing && !engine.paused()) engine.pause();
  }, []);
  useEffect(() => {
    state.current = room.playback;
    setPlayback(room.playback);
    apply();
  }, [room.playback, apply]);
  useEffect(() => {
    const receive = (data: { playback: Playback; currentId: string }) => {
      if (data.currentId !== mediaIdRef.current) return;
      state.current = data.playback;
      setPlayback(data.playback);
      apply();
    };
    const ping = async () => {
      const start = Date.now();
      const clock = await request<{ serverTime: number }>('clock:ping');
      const rtt = Date.now() - start;
      clockSamples.current = [
        ...clockSamples.current.slice(-7),
        { rtt, offset: clock.serverTime - start - rtt / 2 },
      ];
      // The quickest recent round trip gives the most accurate reading of the server clock.
      offset.current = clockSamples.current.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
    };
    const sync = async () => {
      if (!socket.connected) return;
      try {
        await ping();
        receive(await request<{ playback: Playback; currentId: string }>('playback:sync'));
      } catch {
        /* reconnect will restore state */
      }
    };
    // A reconnect may reach a different server, so re-measure the clock with a quick burst.
    const calibrate = async () => {
      clockSamples.current = [];
      for (let i = 0; i < 4 && socket.connected; i++) await ping().catch(() => {});
      void sync();
    };
    socket.on('playback:state', receive);
    socket.on('connect', calibrate);
    void calibrate();
    // Back from the background (timers were throttled, the player may have been paused): catch up.
    const shown = () => {
      if (document.visibilityState !== 'visible') return;
      shownAt.current = Date.now();
      apply();
      void sync();
    };
    document.addEventListener('visibilitychange', shown);
    const timer = setInterval(sync, 4000);
    const driftTimer = setInterval(apply, 300);
    return () => {
      document.removeEventListener('visibilitychange', shown);
      socket.off('playback:state', receive);
      socket.off('connect', calibrate);
      clearInterval(timer);
      clearInterval(driftTimer);
    };
  }, [apply]);
  useEffect(() => {
    const el = videoRef.current;
    clearTimeout(seekTimer.current);
    setError('');
    setDuration(0);
    setCurrentTime(0);
    setBlocked(false);
    setLoading(!!media);
    engineRef.current = null;
    const host = youtubeRef.current;
    if (!el || !host || !media) return;
    let hls: Hls | undefined,
      youtube: YouTubeEngine | undefined,
      poll: ReturnType<typeof setInterval> | undefined,
      disposed = false;
    if (!videoId) engineRef.current = videoEngine(el);
    if (videoId) {
      createYouTubeEngine(host, videoId, {
        ready: (engine) => {
          if (disposed) return;
          engineRef.current = engine;
          engine.setVolume(volumeRef.current.volume, volumeRef.current.muted);
          setLoading(false);
          apply();
        },
        state: (value) => {
          if (disposed) return;
          if (value === YT_STATE.BUFFERING) setLoading(true);
          else setLoading(false);
          if (value === YT_STATE.PLAYING) setBlocked(false);
          if (value === YT_STATE.ENDED) endedRef.current();
          if (value === YT_STATE.PLAYING || value === YT_STATE.PAUSED)
            youtubeActionRef.current(value);
        },
        error: (code) => {
          if (disposed) return;
          setLoading(false);
          setError(youtubeError(code));
        },
      })
        .then((engine) => {
          if (disposed) engine.destroy();
          else youtube = engine;
        })
        .catch(() => {
          if (!disposed) {
            setLoading(false);
            setError(
              'YouTube couldn’t load. Check your connection or turn off any blocker for this site, then try again.',
            );
          }
        });
      poll = setInterval(() => {
        const engine = engineRef.current;
        if (!engine) return;
        setCurrentTime(engine.time());
        setDuration(engine.duration());
      }, 250);
    } else if (
      /\.m3u8(?:\?|$)/i.test(media.url) &&
      !el.canPlayType('application/vnd.apple.mpegurl')
    ) {
      import('hls.js')
        .then(({ default: HlsPlayer }) => {
          if (disposed) return;
          if (!HlsPlayer.isSupported()) {
            setLoading(false);
            setError(
              'This browser does not support this live stream. Try another browser or a direct video file.',
            );
            return;
          }
          hls = new HlsPlayer();
          hls.loadSource(media.url);
          hls.attachMedia(el);
          hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
            if (data.fatal) {
              setLoading(false);
              setError(
                'This live stream couldn’t load. Check that the link allows playback on other websites.',
              );
            }
          });
        })
        .catch(() => {
          if (!disposed) {
            setLoading(false);
            setError('The live-stream player could not load. Please refresh and try again.');
          }
        });
    } else {
      el.src = media.url;
      el.load();
    }
    return () => {
      clearTimeout(seekTimer.current);
      clearInterval(poll);
      disposed = true;
      engineRef.current = null;
      hls?.destroy();
      youtube?.destroy();
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
  }, [media?.url, media?.id]);
  useEffect(() => {
    engineRef.current?.setVolume(volume, muted);
  }, [volume, muted, media?.id]);
  // Lock-screen and notification controls. They also help the browser keep the movie or song
  // playing while the page is in the background.
  const updateRef = useRef(update);
  updateRef.current = update;
  useEffect(() => {
    if (!('mediaSession' in navigator) || !media) return;
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({
      title: media.title,
      artist: room.name,
      album: 'SyncAdda',
      artwork: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
    });
    const control = (playing: boolean) =>
      canControl
        ? () => void updateRef.current({ playing, position: engineRef.current?.time() || 0 })
        : null;
    const actions: [MediaSessionAction, MediaSessionActionHandler | null][] = [
      ['play', control(true)],
      ['pause', control(false)],
    ];
    for (const [action, handler] of actions)
      try {
        session.setActionHandler(action, handler);
      } catch {
        /* not supported in this browser */
      }
    return () => {
      session.metadata = null;
      for (const [action] of actions)
        try {
          session.setActionHandler(action, null);
        } catch {
          /* not supported in this browser */
        }
    };
  }, [media?.id, media?.title, room.name, canControl]);
  useEffect(() => {
    if ('mediaSession' in navigator)
      navigator.mediaSession.playbackState = media
        ? playback.playing
          ? 'playing'
          : 'paused'
        : 'none';
  }, [playback.playing, media]);
  async function update(patch: Partial<Playback>) {
    if (!canControl || !room.currentId) return;
    try {
      await request('playback:update', { mediaId: room.currentId, ...patch });
    } catch (e) {
      notify((e as Error).message);
    }
  }
  function seek(value: number) {
    if (!canControl) return;
    state.current = { ...state.current, position: value, updatedAt: Date.now() + offset.current };
    engineRef.current?.seek(value);
    setCurrentTime(value);
    clearTimeout(seekTimer.current);
    seekTimer.current = setTimeout(() => {
      void update({ position: value });
    }, 100);
  }
  async function toggle() {
    if (!media) return;
    if (blocked) {
      try {
        await engineRef.current?.play();
        setBlocked(false);
      } catch {
        notify('Your browser could not play this source. Try another media link.');
      }
      return;
    }
    await update({ playing: !playback.playing, position: engineRef.current?.time() || 0 });
  }
  async function next() {
    const index = room.playlist.findIndex((m) => m.id === room.currentId);
    const item = room.playlist[index + 1];
    if (item) {
      try {
        await request('media:select', { id: item.id });
        await request('playback:update', { mediaId: item.id, playing: true, position: 0 });
      } catch (e) {
        notify((e as Error).message);
      }
    } else await update({ playing: false, position: engineRef.current?.time() || 0 });
  }
  // In fullscreen, the controls fade out after 5 seconds without a move, tap, or key press.
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wake = useCallback(() => {
    setControlsHidden(false);
    clearTimeout(wakeTimer.current);
    if (document.fullscreenElement && document.fullscreenElement === containerRef.current)
      wakeTimer.current = setTimeout(() => setControlsHidden(true), 5000);
  }, []);
  useEffect(() => {
    document.addEventListener('fullscreenchange', wake);
    return () => {
      document.removeEventListener('fullscreenchange', wake);
      clearTimeout(wakeTimer.current);
    };
  }, [wake]);
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await containerRef.current?.requestFullscreen();
    } catch {
      notify('Fullscreen is unavailable in this browser.');
    }
  }
  const audio = media?.kind === 'audio' && !videoId;
  const screenClick = () => {
    if (canControl || blocked) void toggle();
  };
  return (
    <div
      className={`player-shell ${controlsHidden ? 'controls-hidden' : ''}`}
      ref={containerRef}
      onPointerMove={wake}
      onPointerDown={wake}
      onKeyDown={wake}
    >
      {/* YouTube's frame swallows mouse moves, so this edge brings the controls back. */}
      {controlsHidden && <div className="controls-wake" onPointerEnter={wake} />}
      <div className={`player-screen ${audio ? 'audio-screen' : ''}`}>
        <div className="youtube-host" ref={youtubeRef} hidden={!videoId} />
        <video
          ref={videoRef}
          hidden={!!videoId}
          preload="auto"
          playsInline
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration);
            apply();
          }}
          onCanPlay={() => {
            setLoading(false);
            apply();
          }}
          onWaiting={() => setLoading(true)}
          onPlaying={() => setLoading(false)}
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onDurationChange={(e) => setDuration(e.currentTarget.duration)}
          onEnded={() => {
            if (isHost && canControl) void next();
          }}
          onError={() => {
            if (media && videoRef.current?.getAttribute('src')) {
              setLoading(false);
              setError(
                'This media couldn’t load. Use a direct, publicly accessible video or audio link supported by your browser.',
              );
            }
          }}
          onClick={screenClick}
        />
        {!media && (
          <div className="player-empty">
            <div className="empty-orbits">
              <div />
              <div />
              <span>
                <Film size={32} strokeWidth={1.3} />
              </span>
            </div>
            <span className="eyebrow">THE BEST SEAT IS RIGHT HERE</span>
            <h2>What are we watching?</h2>
            <p>
              {canAdd
                ? 'Add something you love. Make a moment of it.'
                : 'The host is picking something good. Settle in.'}
            </p>
            {canAdd && (
              <button className="button primary" onClick={onAdd}>
                <Plus size={18} />
                Choose something to watch
              </button>
            )}
            <span className="empty-formats">
              MOVIES <i /> VIDEOS <i /> MUSIC <i /> LIVE STREAMS
            </span>
          </div>
        )}
        {audio && (
          <div className="audio-art">
            <div className={`vinyl ${playback.playing ? 'is-playing' : ''}`}>
              <div>
                <Music2 size={35} />
              </div>
            </div>
            <h2>{media.title}</h2>
            <span>Good taste is better shared.</span>
          </div>
        )}
        {!!media && !playback.playing && !error && !loading && (
          <button
            className="center-play"
            onClick={toggle}
            disabled={!canControl && !blocked}
            aria-label={
              blocked
                ? 'Enable playback on this device'
                : canControl
                  ? 'Play for everyone'
                  : 'Waiting for host to play'
            }
          >
            <Play size={29} fill="currentColor" />
          </button>
        )}
        {loading && !error && media && (
          <div className="player-buffer">
            <LoaderCircle className="spin" size={28} />
            <span>Getting your moment ready…</span>
          </div>
        )}
        {error && (
          <div className="player-error">
            <Film size={28} />
            <h3>We couldn’t play that one.</h3>
            <p>{error}</p>
            {canAdd && (
              <button className="button secondary" onClick={onAdd}>
                Try another link
              </button>
            )}
          </div>
        )}
        {blocked && !error && (
          <button className="autoplay-prompt" onClick={toggle}>
            <Play size={16} />
            Tap to join playback on this device
          </button>
        )}
        {media && (
          <span className="player-sync">
            <span className="live-dot" />
            {loading ? 'BUFFERING' : 'SHARED PLAYBACK'}
          </span>
        )}
      </div>
      <div className="player-controls">
        <input
          className="seek-bar"
          aria-label="Seek for everyone"
          type="range"
          min="0"
          max={Number.isFinite(duration) && duration > 0 ? duration : 1}
          step="0.1"
          value={Math.min(currentTime, Number.isFinite(duration) && duration > 0 ? duration : 1)}
          disabled={!media || !canControl || !Number.isFinite(duration)}
          onChange={(e) => seek(Number(e.target.value))}
          style={
            {
              '--progress': `${duration > 0 && Number.isFinite(duration) ? (currentTime / duration) * 100 : 0}%`,
            } as React.CSSProperties
          }
        />
        <div className="control-row">
          <button
            className="icon-button"
            aria-label={playback.playing ? 'Pause for everyone' : 'Play for everyone'}
            onClick={toggle}
            disabled={!media || (!canControl && !blocked)}
          >
            {playback.playing ? (
              <Pause size={20} fill="currentColor" />
            ) : (
              <Play size={20} fill="currentColor" />
            )}
          </button>
          <button
            className="icon-button skip-control"
            aria-label="Next in queue"
            onClick={next}
            disabled={
              !canControl ||
              room.playlist.findIndex((m) => m.id === room.currentId) >= room.playlist.length - 1
            }
          >
            <SkipForward size={18} />
          </button>
          <button
            className="icon-button"
            aria-label={muted ? 'Unmute media' : 'Mute media'}
            onClick={() => setMuted(!muted)}
          >
            {muted || volume === 0 ? <VolumeX size={19} /> : <Volume2 size={19} />}
          </button>
          <input
            className="volume-slider"
            aria-label="Media volume"
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={muted ? 0 : volume}
            onChange={(e) => {
              setVolume(Number(e.target.value));
              setMuted(false);
            }}
          />
          <span className="player-time">
            {time(currentTime)}
            <span> / {duration === Infinity ? 'LIVE' : time(duration)}</span>
          </span>
          <div className="control-spacer" />
          <span className="host-control-hint">
            {room.everyoneControls ? 'Everyone can control' : 'Host controls playback'}
          </span>
          <select
            className="speed-select"
            aria-label="Playback speed for everyone"
            value={playback.rate}
            onChange={(e) => update({ rate: Number(e.target.value) })}
            disabled={!canControl || !media}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
              <option key={rate} value={rate}>
                {rate}×
              </option>
            ))}
          </select>
          <button className="icon-button" aria-label="Fullscreen" onClick={fullscreen}>
            <Maximize2 size={19} />
          </button>
        </div>
      </div>
    </div>
  );
}
