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
}: {
  person: Person;
  stream?: MediaStream | null;
  me: boolean;
  host: boolean;
  speakers: boolean;
  failed?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [speaking, setSpeaking] = useState(false);
  const [needsAudio, setNeedsAudio] = useState(false);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    el.srcObject = stream || null;
    if (stream)
      el.play()
        .then(() => setNeedsAudio(false))
        .catch(() => setNeedsAudio(true));
  }, [stream]);
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
        muted={me || !speakers}
        className={`${person.camera && stream ? 'has-camera' : ''} ${me ? 'mirrored' : ''}`}
      />
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
            video.current
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
