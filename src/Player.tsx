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
import type { Playback, Room } from './types';

export default function Player({
  room,
  canControl,
  isHost,
  onAdd,
  notify,
}: {
  room: Room;
  canControl: boolean;
  isHost: boolean;
  onAdd: () => void;
  notify: (message: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const state = useRef(room.playback);
  const offset = useRef(room.serverTime - Date.now());
  const bestRtt = useRef(Infinity);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [playback, setPlayback] = useState(room.playback);
  const media = room.playlist.find((m) => m.id === room.currentId);
  const mediaIdRef = useRef(room.currentId);
  mediaIdRef.current = room.currentId;
  const apply = useCallback(() => {
    const el = videoRef.current,
      target = state.current;
    if (!el || el.readyState < 1) return;
    let targetTime =
      target.position +
      (target.playing
        ? (Math.max(0, Date.now() + offset.current - target.updatedAt) / 1000) * target.rate
        : 0);
    if (Number.isFinite(el.duration)) targetTime = Math.min(targetTime, el.duration);
    else if (el.seekable.length)
      targetTime = Math.max(
        el.seekable.start(0),
        Math.min(targetTime, el.seekable.end(el.seekable.length - 1)),
      );
    const drift = targetTime - el.currentTime;
    if (Math.abs(drift) > 1.2 || (!target.playing && Math.abs(drift) > 0.1))
      el.currentTime = targetTime;
    el.playbackRate =
      target.playing && Math.abs(drift) > 0.15 && Math.abs(drift) <= 1.2
        ? target.rate * (drift > 0 ? 1.03 : 0.97)
        : target.rate;
    if (target.playing && el.paused && !el.ended)
      el.play()
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
    else if (!target.playing && !el.paused) el.pause();
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
    const sync = async () => {
      if (!socket.connected) return;
      const start = Date.now();
      try {
        const clock = await request<{ serverTime: number }>('clock:ping');
        const rtt = Date.now() - start;
        if (rtt < bestRtt.current) {
          bestRtt.current = rtt;
          offset.current = clock.serverTime - start - rtt / 2;
        }
        receive(await request<{ playback: Playback; currentId: string }>('playback:sync'));
      } catch {
        /* reconnect will restore state */
      }
    };
    socket.on('playback:state', receive);
    void sync();
    const timer = setInterval(sync, 4000);
    const driftTimer = setInterval(apply, 1500);
    return () => {
      socket.off('playback:state', receive);
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
    if (!el || !media) return;
    let hls: Hls | undefined,
      disposed = false;
    if (/\.m3u8(?:\?|$)/i.test(media.url) && !el.canPlayType('application/vnd.apple.mpegurl')) {
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
      disposed = true;
      hls?.destroy();
      el.pause();
      el.removeAttribute('src');
      el.load();
    };
  }, [media?.url, media?.id]);
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = muted;
    }
  }, [volume, muted, media?.id]);
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
    if (videoRef.current) videoRef.current.currentTime = value;
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
        await videoRef.current?.play();
        setBlocked(false);
      } catch {
        notify('Your browser could not play this source. Try another media link.');
      }
      return;
    }
    await update({ playing: !playback.playing, position: videoRef.current?.currentTime || 0 });
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
    } else await update({ playing: false, position: videoRef.current?.currentTime || 0 });
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await containerRef.current?.requestFullscreen();
    } catch {
      notify('Fullscreen is unavailable in this browser.');
    }
  }
  return (
    <div className="player-shell" ref={containerRef}>
      <div className={`player-screen ${media?.kind === 'audio' ? 'audio-screen' : ''}`}>
        <video
          ref={videoRef}
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
          onClick={() => {
            if (canControl || blocked) void toggle();
          }}
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
              {canControl
                ? 'Add something you love. Make a moment of it.'
                : 'The host is picking something good. Settle in.'}
            </p>
            {canControl && (
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
        {media?.kind === 'audio' && (
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
            {canControl && (
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
