import { useEffect, useRef, useState } from 'react';
import { Crown, Mic, MicOff } from 'lucide-react';
import { colorFor, initials } from './lib';
import type { Person } from './types';
export default function PersonTile({
  person,
  stream,
  me,
  host,
  speakers,
  failed,
  silent = false,
}: {
  person: Person;
  stream?: MediaStream | null;
  me: boolean;
  host: boolean;
  speakers: boolean;
  failed?: boolean;
  // A second view of someone (e.g. the Video tab) plays no sound, so nobody is heard twice.
  silent?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [speaking, setSpeaking] = useState(false);
  const [needsAudio, setNeedsAudio] = useState(false);
  // Sound and picture play in separate elements: a <video> whose camera track has no frames
  // (camera off) never starts playing, which would silence the voice with it.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const tracks = stream?.getVideoTracks() || [];
    el.srcObject = tracks.length ? new MediaStream(tracks) : null;
    if (tracks.length) el.play().catch(() => {});
  }, [stream]);
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const tracks = me || silent ? [] : stream?.getAudioTracks() || [];
    el.srcObject = tracks.length ? new MediaStream(tracks) : null;
    if (tracks.length)
      el.play()
        .then(() => setNeedsAudio(false))
        .catch(() => setNeedsAudio(true));
  }, [stream, me, silent]);
  // Phones (iPhones always) only start call sound from a tap, and this tile may be off-screen,
  // so any tap or key press anywhere retries it.
  useEffect(() => {
    if (!needsAudio) return;
    const retry = () =>
      audio.current
        ?.play()
        .then(() => setNeedsAudio(false))
        .catch(() => {});
    document.addEventListener('pointerdown', retry);
    document.addEventListener('keydown', retry);
    return () => {
      document.removeEventListener('pointerdown', retry);
      document.removeEventListener('keydown', retry);
    };
  }, [needsAudio]);
  useEffect(() => {
    if (!stream?.getAudioTracks().length || !person.mic) {
      setSpeaking(false);
      return;
    }
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    const source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const interval = setInterval(() => {
      analyser.getByteFrequencyData(data);
      setSpeaking(data.reduce((a, b) => a + b, 0) / data.length > 12);
    }, 180);
    return () => {
      clearInterval(interval);
      source.disconnect();
      void context.close();
    };
  }, [stream, person.mic]);
  return (
    <div
      className={`person-tile ${colorFor(person.name)} ${speaking ? 'speaking' : ''} ${!person.online ? 'offline' : ''}`}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        className={`${person.camera && stream ? 'has-camera' : ''} ${me ? 'mirrored' : ''}`}
      />
      {!silent && <audio ref={audio} autoPlay muted={!speakers} />}
      {(!person.camera || !stream) && <span className="tile-avatar">{initials(person.name)}</span>}
      <span className="tile-top">
        {host && <Crown size={13} />}
        {!person.online
          ? 'Reconnecting…'
          : failed
            ? 'Call reconnecting…'
            : person.inCall
              ? speaking
                ? 'Speaking'
                : 'In the call'
              : 'Watching'}
      </span>
      <div className="tile-bottom">
        <span>
          {person.name}
          {me && <small> (you)</small>}
        </span>
        {person.mic ? <Mic size={13} /> : <MicOff size={13} />}
      </div>
      {needsAudio && !me && stream && (
        <button
          className="enable-audio"
          onClick={() =>
            audio.current
              ?.play()
              .then(() => setNeedsAudio(false))
              .catch(() => {})
          }
        >
          Tap to hear
        </button>
      )}
    </div>
  );
}
