import { useCallback, useEffect, useRef, useState } from 'react';
import { callState, request, socket } from './lib';
import type { Person } from './types';

type Peer = {
  pc: RTCPeerConnection;
  // Exactly one side of each pair (the smaller id) makes offers. When both sides offered at
  // once, each added its own audio/video transceivers and tiles could end up showing a dead track.
  offerer: boolean;
  pending: RTCIceCandidateInit[];
  stream: MediaStream;
};
// A signal with neither field is a "hello": the answerer opened a fresh connection and wants an offer.
type Signal = {
  from: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};
// Silence and a black picture, sent while the microphone or camera is off. Every connection then
// always carries sound and picture, exactly as when both are on: phones are unreliable at
// starting a track that joins a connection later, and at playing one that has never carried
// anything.
type StandIns = { audio?: MediaStreamTrack; video?: MediaStreamTrack; stop(): void };
function createStandIns(): StandIns {
  let audio: MediaStreamTrack | undefined,
    video: MediaStreamTrack | undefined,
    context: AudioContext | undefined,
    timer: ReturnType<typeof setInterval> | undefined;
  try {
    context = new AudioContext();
    const output = context.createMediaStreamDestination(),
      source = context.createOscillator(),
      gain = context.createGain();
    gain.gain.value = 0;
    source.connect(gain).connect(output);
    source.start();
    [audio] = output.stream.getAudioTracks();
  } catch {
    /* nothing is sent while the microphone is off */
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const paint = () => canvas.getContext('2d')?.fillRect(0, 0, canvas.width, canvas.height);
    paint();
    [video] = canvas.captureStream(2).getVideoTracks();
    // A canvas only gives out a frame when it's drawn on.
    timer = setInterval(paint, 1000);
  } catch {
    /* nothing is sent while the camera is off */
  }
  return {
    audio,
    video,
    stop() {
      clearInterval(timer);
      audio?.stop();
      video?.stop();
      void context?.close().catch(() => {});
    },
  };
}
export function useCall(myId: string, people: Person[], notify: (message: string) => void) {
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
  const offline = useRef(new Set<string>());
  const configuration = useRef<RTCConfiguration>({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });
  const generation = useRef(0);
  const standIns = useRef<StandIns | null>(null);
  // What we send for sound or picture: our microphone or camera, else its stand-in.
  const outgoing = useCallback(
    (kind: string) =>
      stream.current.getTracks().find((t) => t.kind === kind && t.readyState === 'live') ||
      standIns.current?.[kind as 'audio' | 'video'] ||
      null,
    [],
  );
  const send = useCallback(
    async (kind: 'audio' | 'video') => {
      const track = outgoing(kind);
      for (const peer of peers.current.values()) {
        const sender = peer.pc
          .getTransceivers()
          .find((t) => t.receiver.track.kind === kind)?.sender;
        if (sender && sender.track !== track) await sender.replaceTrack(track).catch(() => {});
      }
    },
    [outgoing],
  );
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
    setMic(nextMic);
    setCamera(nextCamera);
    Object.assign(callState, { inCall: active.current, mic: nextMic, camera: nextCamera });
    try {
      await request('call:status', { ...callState });
    } finally {
      // Connect to peers only once the server knows we're in the call; it drops signals before that.
      setInCall(active.current);
    }
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
    standIns.current?.stop();
    standIns.current = null;
    setLocalStream(null);
    setInCall(false);
    setMic(false);
    setCamera(false);
    closePeers();
    Object.assign(callState, { inCall: false, mic: false, camera: false });
    if (socket.connected)
      request('call:status', { inCall: false, mic: false, camera: false }).catch(() => {});
  }, [closePeers]);
  const dropPeer = useCallback((id: string) => {
    peers.current.get(id)?.pc.close();
    peers.current.delete(id);
    setStreams((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    setFailedPeers((previous) => previous.filter((p) => p !== id));
  }, []);
  const ensurePeer = useCallback(
    (id: string, { announce = false } = {}): Peer => {
      const existing = peers.current.get(id);
      if (existing) return existing;
      const pc = new RTCPeerConnection(configuration.current);
      const peer: Peer = { pc, offerer: myId < id, pending: [], stream: new MediaStream() };
      peers.current.set(id, peer);
      pc.onicecandidate = ({ candidate }) => {
        if (candidate)
          request('call:signal', { to: id, candidate: candidate.toJSON() }).catch(() => {});
      };
      pc.ontrack = ({ track }) => {
        peer.stream.addTrack(track);
        const show = () => {
          if (peers.current.get(id) === peer)
            setStreams((previous) => ({
              ...previous,
              [id]: new MediaStream(peer.stream.getTracks()),
            }));
        };
        // Phones can leave a track silent or black if it was attached before anything arrived
        // on it, so it's attached again once it starts.
        track.onunmute = show;
        show();
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          setFailedPeers((previous) => (previous.includes(id) ? previous : [...previous, id]));
          if (peer.offerer) pc.restartIce();
        } else if (pc.connectionState === 'connected')
          setFailedPeers((previous) => previous.filter((p) => p !== id));
      };
      if (peer.offerer) {
        pc.onnegotiationneeded = async () => {
          try {
            await pc.setLocalDescription();
            if (pc.localDescription)
              await request('call:signal', { to: id, description: pc.localDescription.toJSON() });
          } catch {
            if (pc.connectionState !== 'closed')
              setFailedPeers((previous) => (previous.includes(id) ? previous : [...previous, id]));
          }
        };
        for (const kind of ['audio', 'video'] as const)
          pc.addTransceiver(outgoing(kind) || kind, {
            direction: 'sendrecv',
            streams: [stream.current],
          });
      } else if (announce) request('call:signal', { to: id }).catch(() => {});
      return peer;
    },
    [myId, outgoing],
  );
  useEffect(() => {
    const accept = async (from: string, peer: Peer, description: RTCSessionDescriptionInit) => {
      const pc = peer.pc;
      await pc.setRemoteDescription(description);
      for (const queued of peer.pending.splice(0)) await pc.addIceCandidate(queued).catch(() => {});
      if (description.type !== 'offer') return;
      // Answer with our current tracks on the transceivers the offer created.
      for (const transceiver of pc.getTransceivers()) {
        const track = outgoing(transceiver.receiver.track.kind);
        transceiver.direction = 'sendrecv';
        if (transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track);
      }
      await pc.setLocalDescription();
      if (pc.localDescription)
        await request('call:signal', { to: from, description: pc.localDescription.toJSON() });
    };
    const signal = async ({ from, description, candidate }: Signal) => {
      if (!active.current) return;
      let peer = peers.current.get(from);
      if (!description && !candidate) {
        if (myId > from) return;
        // Our connection belongs to an earlier session of theirs (e.g. they reloaded): start over.
        if (peer?.pc.remoteDescription) dropPeer(from);
        ensurePeer(from);
        return;
      }
      peer ??= ensurePeer(from);
      try {
        if (description) {
          if (description.type === 'offer' && peer.offerer) return;
          try {
            await accept(from, peer, description);
          } catch (error) {
            if (description.type !== 'offer') throw error;
            // An offer from their new session can't be applied to our old connection.
            dropPeer(from);
            peer = ensurePeer(from);
            await accept(from, peer, description);
          }
        } else if (candidate) {
          if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
          else peer.pending.push(candidate);
        }
      } catch {
        if (peer.pc.connectionState !== 'closed')
          setFailedPeers((previous) => (previous.includes(from) ? previous : [...previous, from]));
      }
    };
    socket.on('call:signal', signal);
    return () => {
      socket.off('call:signal', signal);
    };
  }, [myId, ensurePeer, dropPeer, outgoing]);
  useEffect(() => {
    if (!inCall) return;
    // Keep connections to people who are briefly offline; their media flows peer-to-peer meanwhile.
    const present = people.filter((p) => p.id !== myId && p.inCall);
    for (const p of present) {
      if (!p.online) {
        offline.current.add(p.id);
        continue;
      }
      const back = offline.current.delete(p.id);
      const peer = ensurePeer(p.id, { announce: true });
      // A restart attempted while they were offline couldn't reach them; try again now.
      if (back && peer.offerer && peer.pc.connectionState !== 'connected') peer.pc.restartIce();
    }
    for (const id of [...peers.current.keys()]) if (!present.some((p) => p.id === id)) dropPeer(id);
  }, [people, myId, inCall, ensurePeer, dropPeer]);
  useEffect(() => {
    // The room connection drops now and then (hosting limits connections to about 5 minutes).
    // Calls are peer-to-peer, so they keep going; App re-sends our call status when it rejoins.
    const hide = () => {
      if (active.current) socket.emit('call:status', { inCall: false, mic: false, camera: false });
    };
    window.addEventListener('pagehide', hide);
    return () => window.removeEventListener('pagehide', hide);
  }, []);
  useEffect(
    () => () => {
      generation.current++;
      active.current = false;
      Object.assign(callState, { inCall: false, mic: false, camera: false });
      stream.current.getTracks().forEach((t) => t.stop());
      standIns.current?.stop();
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
        void send(kind);
        void status().catch(() => {});
        setLocalStream(new MediaStream(stream.current.getTracks()));
      };
    }
    await send(kind);
    setLocalStream(new MediaStream(stream.current.getTracks()));
  }
  async function toggle(kind: 'audio' | 'video') {
    if (busy) return;
    setBusy(true);
    try {
      // Made here, in the tap itself: phones only let sound start from one.
      standIns.current ??= createStandIns();
      const track = stream.current
        .getTracks()
        .find((t) => t.kind === kind && t.readyState === 'live');
      if (track && kind === 'video') {
        track.stop();
        stream.current.removeTrack(track);
        await send(kind);
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
      if (!active.current) {
        standIns.current?.stop();
        standIns.current = null;
      }
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
