import { useCallback, useEffect, useRef, useState } from 'react';
import { request, socket } from './lib';
import type { Person } from './types';

type Peer = {
  pc: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  pending: RTCIceCandidateInit[];
  stream: MediaStream;
};
type Signal = {
  from: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};
export function useCall(
  myId: string,
  people: Person[],
  connected: boolean,
  notify: (message: string) => void,
) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [streams, setStreams] = useState<Record<string, MediaStream>>({});
  const [inCall, setInCall] = useState(false);
  const [mic, setMic] = useState(false);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failedPeers, setFailedPeers] = useState<string[]>([]);
  const active = useRef(false);
  const stream = useRef(new MediaStream());
  const peers = useRef(new Map<string, Peer>());
  const configuration = useRef<RTCConfiguration>({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  const generation = useRef(0);
  useEffect(() => {
    fetch('/api/ice')
      .then((r) => r.json())
      .then((c) => {
        configuration.current = c;
      })
      .catch(() => {});
  }, []);
  const status = useCallback(async () => {
    const nextMic =
      active.current &&
      stream.current.getAudioTracks().some((t) => t.enabled && t.readyState === 'live');
    const nextCamera =
      active.current &&
      stream.current.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
    setInCall(active.current);
    setMic(nextMic);
    setCamera(nextCamera);
    await request('call:status', { inCall: active.current, mic: nextMic, camera: nextCamera });
  }, []);
  const closePeers = useCallback(() => {
    for (const peer of peers.current.values()) peer.pc.close();
    peers.current.clear();
    setStreams({});
    setFailedPeers([]);
  }, []);
  const leave = useCallback(() => {
    generation.current++;
    active.current = false;
    stream.current.getTracks().forEach((t) => t.stop());
    stream.current = new MediaStream();
    setLocalStream(null);
    setInCall(false);
    setMic(false);
    setCamera(false);
    closePeers();
    if (socket.connected)
      request('call:status', { inCall: false, mic: false, camera: false }).catch(() => {});
  }, [closePeers]);
  const ensurePeer = useCallback((id: string): Peer => {
    const existing = peers.current.get(id);
    if (existing) return existing;
    const pc = new RTCPeerConnection(configuration.current);
    const peer: Peer = {
      pc,
      makingOffer: false,
      ignoreOffer: false,
      settingAnswer: false,
      pending: [],
      stream: new MediaStream(),
    };
    peers.current.set(id, peer);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate)
        request('call:signal', { to: id, candidate: candidate.toJSON() }).catch(() => {});
    };
    pc.ontrack = ({ track }) => {
      peer.stream.addTrack(track);
      setStreams((previous) => ({ ...previous, [id]: new MediaStream(peer.stream.getTracks()) }));
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        setFailedPeers((previous) => (previous.includes(id) ? previous : [...previous, id]));
        pc.restartIce();
      } else if (pc.connectionState === 'connected')
        setFailedPeers((previous) => previous.filter((p) => p !== id));
    };
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription)
          await request('call:signal', { to: id, description: pc.localDescription.toJSON() });
      } catch {
        if (pc.connectionState !== 'closed')
          setFailedPeers((previous) => (previous.includes(id) ? previous : [...previous, id]));
      } finally {
        peer.makingOffer = false;
      }
    };
    for (const kind of ['audio', 'video'] as const) {
      const track = stream.current.getTracks().find((t) => t.kind === kind);
      pc.addTransceiver(track || kind, { direction: 'sendrecv', streams: [stream.current] });
    }
    return peer;
  }, []);
  useEffect(() => {
    const signal = async ({ from, description, candidate }: Signal) => {
      if (!active.current) return;
      const peer = ensurePeer(from),
        pc = peer.pc;
      try {
        if (description) {
          const readyForOffer =
            !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
          const collision = description.type === 'offer' && !readyForOffer;
          peer.ignoreOffer = myId < from && collision;
          if (peer.ignoreOffer) return;
          peer.settingAnswer = description.type === 'answer';
          await pc.setRemoteDescription(description);
          peer.settingAnswer = false;
          for (const queued of peer.pending.splice(0)) await pc.addIceCandidate(queued);
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            if (pc.localDescription)
              await request('call:signal', { to: from, description: pc.localDescription.toJSON() });
          }
        } else if (candidate && !peer.ignoreOffer) {
          if (pc.remoteDescription) await pc.addIceCandidate(candidate);
          else peer.pending.push(candidate);
        }
      } catch {
        peer.settingAnswer = false;
        if (!peer.ignoreOffer && pc.connectionState !== 'closed')
          setFailedPeers((previous) => (previous.includes(from) ? previous : [...previous, from]));
      }
    };
    socket.on('call:signal', signal);
    return () => {
      socket.off('call:signal', signal);
    };
  }, [myId, ensurePeer]);
  useEffect(() => {
    if (!inCall) return;
    const present = people.filter((p) => p.id !== myId && p.inCall && p.online);
    for (const p of present) ensurePeer(p.id);
    for (const [id, peer] of peers.current)
      if (!present.some((p) => p.id === id)) {
        peer.pc.close();
        peers.current.delete(id);
        setStreams((previous) => {
          const next = { ...previous };
          delete next[id];
          return next;
        });
      }
  }, [people, myId, inCall, ensurePeer]);
  useEffect(() => {
    if (!connected && active.current) {
      leave();
      notify('Your call disconnected. Rejoin when the room reconnects.');
    }
  }, [connected, leave, notify]);
  useEffect(
    () => () => {
      generation.current++;
      active.current = false;
      stream.current.getTracks().forEach((t) => t.stop());
      for (const peer of peers.current.values()) peer.pc.close();
      peers.current.clear();
    },
    [],
  );
  async function addTrack(kind: 'audio' | 'video') {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error(
        'Voice and video need HTTPS or localhost. Open a secure link to use your devices.',
      );
    const currentGeneration = generation.current;
    const granted = await navigator.mediaDevices.getUserMedia(
      kind === 'audio'
        ? { audio: { echoCancellation: true, noiseSuppression: true }, video: false }
        : {
            video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' },
            audio: false,
          },
    );
    if (currentGeneration !== generation.current) {
      granted.getTracks().forEach((t) => t.stop());
      return;
    }
    for (const track of granted.getTracks()) {
      stream.current.addTrack(track);
      track.onended = () => {
        void status().catch(() => {});
        setLocalStream(new MediaStream(stream.current.getTracks()));
      };
    }
    for (const peer of peers.current.values()) {
      const sender = peer.pc.getTransceivers().find((t) => t.receiver.track.kind === kind)?.sender;
      if (sender) await sender.replaceTrack(granted.getTracks()[0]);
    }
    setLocalStream(new MediaStream(stream.current.getTracks()));
  }
  async function toggle(kind: 'audio' | 'video') {
    if (busy) return;
    setBusy(true);
    try {
      const track = stream.current
        .getTracks()
        .find((t) => t.kind === kind && t.readyState === 'live');
      if (track && kind === 'video') {
        track.stop();
        stream.current.removeTrack(track);
        for (const peer of peers.current.values()) {
          const sender = peer.pc
            .getTransceivers()
            .find((t) => t.receiver.track.kind === kind)?.sender;
          if (sender) await sender.replaceTrack(null);
        }
        setLocalStream(new MediaStream(stream.current.getTracks()));
      } else if (track) track.enabled = !track.enabled;
      else await addTrack(kind);
      if (!stream.current.getTracks().some((t) => t.readyState === 'live')) {
        await status();
        return;
      }
      active.current = true;
      await status();
    } catch (e) {
      const err = e as Error;
      notify(
        err.name === 'NotAllowedError'
          ? 'Device access was declined. Allow your microphone or camera in browser settings, then try again.'
          : err.name === 'NotFoundError'
            ? 'No microphone or camera was found. Connect a device and try again.'
            : err.message || 'Couldn’t connect your device. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return {
    localStream,
    streams,
    inCall,
    mic,
    camera,
    busy,
    failedPeers,
    toggleMic: () => toggle('audio'),
    toggleCamera: () => toggle('video'),
    leave,
  };
}
