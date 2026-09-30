import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  Copy,
  Crown,
  Film,
  Headphones,
  Link2,
  ListMusic,
  ListPlus,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  MonitorPlay,
  MoreHorizontal,
  Music2,
  Phone,
  PhoneOff,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  Smile,
  Upload,
  UserPlus,
  Users,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { Brand, Modal } from './components';
import { colorFor, initials, request, samples, socket } from './lib';
import type { Identity, Room } from './types';
import Player from './Player';
import FullscreenChat from './FullscreenChat';
import PersonTile from './PersonTile';
import { useCall } from './useCall';
import { useWakeLock } from './useWakeLock';
import { youtubeId, youtubeTitle } from './youtube';
import { checkFile, fileTitle, uploadMedia } from './uploads';

export default function WatchRoom({
  room,
  identity,
  connected,
  askLeave,
  onShare,
  onLeave,
  notify,
}: {
  room: Room;
  identity: Identity;
  connected: boolean;
  askLeave: number;
  onShare: () => void;
  onLeave: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const isHost = room.hostId === identity.id;
  const canControl = connected && (isHost || room.everyoneControls);
  const canAdd = canControl || (connected && (room.queueAccess ?? []).includes(identity.id));
  const [panel, setPanel] = useState<'chat' | 'video' | 'queue' | 'people'>('chat');
  const [mobileView, setMobileView] = useState<'watch' | 'chat' | 'people' | 'call'>('watch');
  const [modal, setModal] = useState<'media' | 'settings' | 'leave' | 'close' | null>(null);
  const [mediaTab, setMediaTab] = useState<'link' | 'file' | 'samples'>('link');
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [mediaTitle, setMediaTitle] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaKind, setMediaKind] = useState<'video' | 'audio'>('video');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [showReactions, setShowReactions] = useState(false);
  const [speakers, setSpeakers] = useState(true);
  const [expandCall, setExpandCall] = useState(false);
  const [reactions, setReactions] = useState<{ id: string; emoji: string; name: string }[]>([]);
  const isYouTubeLink = !!youtubeId(mediaUrl.trim());
  useEffect(() => {
    const url = mediaUrl.trim();
    if (!youtubeId(url)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      youtubeTitle(url, controller.signal)
        .then((title) => {
          if (title) setMediaTitle((current) => current || title);
        })
        .catch(() => {
          /* the viewer can type a title themselves */
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [mediaUrl]);
  const chatEnd = useRef<HTMLDivElement>(null);
  const call = useCall(identity.id, room.participants, notify);
  // Back was pressed: ask before leaving (the movie and the call keep going meanwhile).
  useEffect(() => {
    if (askLeave) setModal('leave');
  }, [askLeave]);
  useWakeLock((!!room.currentId && room.playback.playing) || call.inCall);
  const closeModal = useCallback(() => {
    setModal(null);
    setFormError('');
  }, []);
  const current = room.playlist.find((m) => m.id === room.currentId);
  const online = room.participants.filter((p) => p.online).length;
  const callCount = room.participants.filter((p) => p.inCall).length;
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [room.messages.length, panel, mobileView]);
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const react = (reaction: { id: string; emoji: string; name: string }) => {
      setReactions((previous) => [...previous.slice(-8), reaction]);
      const timer = setTimeout(() => {
        setReactions((previous) => previous.filter((r) => r.id !== reaction.id));
        timers.delete(timer);
      }, 3500);
      timers.add(timer);
    };
    socket.on('reaction', react);
    return () => {
      socket.off('reaction', react);
      timers.forEach(clearTimeout);
    };
  }, []);
  async function action(event: string, data: unknown = {}) {
    try {
      await request(event, data);
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function sendText(text: string) {
    try {
      await request('chat:send', { text });
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  }
  const tile = (person: (typeof room.participants)[number], silent = false) => (
    <PersonTile
      key={person.id}
      person={person}
      me={person.id === identity.id}
      host={person.id === room.hostId}
      stream={person.id === identity.id ? call.localStream : call.streams[person.id]}
      speakers={speakers}
      failed={call.failedPeers.includes(person.id)}
      silent={silent}
    />
  );
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!draft.trim() || sending) return;
    setSending(true);
    try {
      await request('chat:send', { text: draft.trim() });
      setDraft('');
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function addMedia(data: { title: string; url: string; kind: 'video' | 'audio' }) {
    setBusy(true);
    setFormError('');
    try {
      await request('media:add', data);
      setMediaUrl('');
      setMediaTitle('');
      closeModal();
      setPanel('queue');
      notify('Added to your shared queue.');
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function shareFile() {
    if (!mediaFile || busy) return;
    if (!canAdd) {
      setFormError('Ask the host to let you add to the queue.');
      return;
    }
    setBusy(true);
    setFormError('');
    setProgress(0);
    try {
      const { url, kind } = await uploadMedia(
        mediaFile,
        { code: room.code, id: identity.id, token: identity.token },
        setProgress,
      );
      setMediaFile(null);
      await addMedia({ title: mediaTitle.trim() || fileTitle(mediaFile), url, kind });
    } catch (e) {
      setFormError((e as Error).message);
      setBusy(false);
    } finally {
      setProgress(null);
    }
  }
  const add = () => {
    setMediaTab('link');
    setFormError('');
    setModal('media');
  };
  const selectMobile = (view: typeof mobileView) => {
    setMobileView(view);
    if (view === 'chat' || view === 'people') setPanel(view);
  };
  return (
    <div className={`watch-app mobile-${mobileView} ${expandCall ? 'expanded-call' : ''}`}>
      <header className="room-header">
        <Brand onClick={() => setModal('leave')} />
        <span className="header-separator" />
        <div className="room-heading">
          <span>{room.name}</span>
          <small>
            <LockKeyhole size={11} />
            Private room <i />
            {online} {online === 1 ? 'person' : 'people'} here
          </small>
        </div>
        <div className="room-header-actions">
          <button
            className="room-code"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(room.code);
                notify('Room code copied.');
              } catch {
                onShare();
              }
            }}
            title="Copy room code"
          >
            {room.code}
            <Copy size={13} />
          </button>
          <button className="button primary small" onClick={onShare}>
            <UserPlus size={16} />
            <span>Invite friends</span>
          </button>
          {isHost && (
            <button
              className="icon-button settings-button"
              onClick={() => setModal('settings')}
              aria-label="Room settings"
            >
              <Settings2 size={20} />
            </button>
          )}
          <button
            className="icon-button leave-button"
            onClick={() => setModal('leave')}
            aria-label="Leave room"
          >
            <LogOut size={19} />
          </button>
        </div>
      </header>
      {!connected && (
        <div className="connection-banner" role="status">
          <LoaderCircle className="spin" size={15} />
          Reconnecting… Your seat is saved. Playback will catch up when you’re back.
        </div>
      )}
      <div className="room-layout">
        <main className="watch-stage">
          <div className="stage-topline">
            <div className="stage-kicker">
              <span className="live-dot" /> YOUR LITTLE CORNER OF THE INTERNET
            </div>
            <span className={`connection-pill ${connected ? '' : 'disconnected'}`}>
              {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
              {connected ? 'Connected' : 'Reconnecting'}
            </span>
          </div>
          <Player
            room={room}
            isHost={isHost}
            canControl={canControl}
            canAdd={canAdd}
            onAdd={add}
            notify={notify}
            overlay={
              <FullscreenChat
                messages={room.messages}
                meId={identity.id}
                connected={connected}
                reactions={reactions}
                onSend={sendText}
                onReact={(emoji) => void action('reaction:send', { emoji })}
              />
            }
          />
          <div className="now-playing">
            <div>
              <span className="eyebrow">{current ? 'NOW PLAYING' : 'MAKE YOURSELF AT HOME'}</span>
              <h1>{current?.title || 'A good night starts with good company.'}</h1>
              <p>
                {current
                  ? `${current.kind === 'audio' ? 'Shared listening' : 'Shared watching'} · ${room.everyoneControls ? 'Everyone has the remote' : 'The host has the remote'}`
                  : 'Invite your people, pick something to watch, and settle in.'}
              </p>
            </div>
            {canAdd && (
              <button className="button dark-secondary small" onClick={add}>
                <Plus size={16} />
                <span>Add media</span>
              </button>
            )}
          </div>
          <div className="people-section">
            <div className="people-section-heading">
              <h2>
                Your people <span>{online}</span>
              </h2>
              <div>
                <span>{callCount ? `${callCount} in the call` : 'Better when you’re here'}</span>
                <button
                  className="icon-button"
                  aria-label={
                    expandCall ? 'Collapse participant videos' : 'Expand participant videos'
                  }
                  onClick={() => setExpandCall(!expandCall)}
                >
                  <Maximize2 size={15} />
                </button>
              </div>
            </div>
            <div className="people-tiles">
              {room.participants.map((person) => tile(person))}
              {room.participants.length < 8 && (
                <button className="invite-tile" onClick={onShare}>
                  <span>
                    <Plus size={20} />
                  </span>
                  <strong>Save someone a seat</strong>
                  <small>Invite a friend</small>
                </button>
              )}
            </div>
          </div>
          <div className="room-small-note">
            <ShieldCheck size={13} />
            Just your people, your picks, and a little time together.
          </div>
        </main>
        <aside className="room-sidebar">
          <div className="sidebar-tabs" role="tablist" aria-label="Room panels">
            <button
              role="tab"
              aria-selected={panel === 'chat'}
              className={panel === 'chat' ? 'active' : ''}
              onClick={() => setPanel('chat')}
            >
              <MessageCircle size={16} />
              Chat
            </button>
            <button
              role="tab"
              aria-selected={panel === 'video'}
              className={panel === 'video' ? 'active' : ''}
              onClick={() => setPanel('video')}
            >
              <Video size={16} />
              Video
            </button>
            <button
              role="tab"
              aria-selected={panel === 'queue'}
              className={panel === 'queue' ? 'active' : ''}
              onClick={() => setPanel('queue')}
            >
              <ListMusic size={17} />
              Queue {room.playlist.length > 0 && <small>{room.playlist.length}</small>}
            </button>
            <button
              role="tab"
              aria-selected={panel === 'people'}
              className={panel === 'people' ? 'active' : ''}
              onClick={() => setPanel('people')}
            >
              <Users size={16} />
              People
            </button>
          </div>
          {panel === 'chat' && (
            <div className="chat-panel" role="tabpanel">
              <div className="chat-messages" aria-live="polite" aria-relevant="additions">
                {room.messages.map((message) =>
                  message.system ? (
                    <div className="system-message" key={message.id}>
                      <span />
                      {message.text}
                    </div>
                  ) : (
                    <div
                      className={`chat-message ${message.personId === identity.id ? 'own' : ''}`}
                      key={message.id}
                    >
                      <span className={`message-avatar ${colorFor(message.name)}`}>
                        {initials(message.name)}
                      </span>
                      <div>
                        <div className="message-meta">
                          <strong>
                            {message.name}
                            {message.personId === identity.id && <small> you</small>}
                          </strong>
                          <time>
                            {new Date(message.at).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        </div>
                        <p>{message.text}</p>
                      </div>
                    </div>
                  ),
                )}
                <div ref={chatEnd} />
              </div>
              <div className="chat-composer-wrap">
                {showReactions && (
                  <div className="emoji-picker">
                    {['❤️', '😂', '🔥', '👏', '🍿', '✨'].map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => {
                          void action('reaction:send', { emoji });
                          setShowReactions(false);
                        }}
                        aria-label={`React ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
                <form className="chat-composer" onSubmit={send}>
                  <input
                    aria-label="Message your room"
                    placeholder="Add to the conversation…"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    maxLength={1500}
                    disabled={!connected}
                  />
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => setShowReactions(!showReactions)}
                    aria-label="Send a reaction"
                    aria-expanded={showReactions}
                  >
                    <Smile size={19} />
                  </button>
                  <button
                    className="send-message"
                    type="submit"
                    aria-label="Send message"
                    disabled={!draft.trim() || sending || !connected}
                  >
                    {sending ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}
                  </button>
                </form>
                <small>Good company. Great commentary.</small>
              </div>
            </div>
          )}
          {panel === 'video' && (
            // Friends' cameras beside the movie. Their sound already plays from the main tiles.
            <div className="video-panel" role="tabpanel">
              {room.participants.map((person) => tile(person, true))}
              {!call.inCall && (
                <p className="video-panel-note">
                  Join the call to see and hear each other while you watch.
                </p>
              )}
            </div>
          )}
          {panel === 'queue' && (
            <div className="queue-panel" role="tabpanel">
              <div className="panel-title">
                <div>
                  <h3>Tonight’s lineup</h3>
                  <p>
                    {room.playlist.length} {room.playlist.length === 1 ? 'moment' : 'moments'} worth
                    sharing
                  </p>
                </div>
                {canAdd && (
                  <button className="icon-button" onClick={add} aria-label="Add media to queue">
                    <Plus size={20} />
                  </button>
                )}
              </div>
              {room.playlist.length ? (
                <div className="queue-list">
                  {room.playlist.map((media, i) => (
                    <div
                      className={`queue-item ${media.id === room.currentId ? 'current' : ''}`}
                      key={media.id}
                    >
                      <span className="queue-number">
                        {media.id === room.currentId ? (
                          <span className="equalizer">
                            <i />
                            <i />
                            <i />
                          </span>
                        ) : (
                          String(i + 1).padStart(2, '0')
                        )}
                      </span>
                      <button
                        className="queue-select"
                        disabled={!canControl}
                        onClick={() => action('media:select', { id: media.id })}
                      >
                        <span className="queue-art">
                          {media.kind === 'audio' ? <Music2 size={22} /> : <Film size={22} />}
                        </span>
                        <span>
                          <strong>{media.title}</strong>
                          <small>
                            {media.id === room.currentId
                              ? 'Now playing'
                              : media.kind === 'audio'
                                ? 'Audio'
                                : 'Video'}
                          </small>
                        </span>
                      </button>
                      {canControl && (
                        <button
                          className="icon-button"
                          onClick={() => action('media:remove', { id: media.id })}
                          aria-label={`Remove ${media.title}`}
                        >
                          <X size={15} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="panel-empty">
                  <ListMusic size={35} strokeWidth={1.2} />
                  <h3>The night is a blank canvas.</h3>
                  <p>
                    {canAdd
                      ? 'Add a video, a song, or a live stream to your shared queue.'
                      : 'Your host will add something to the queue soon.'}
                  </p>
                  {canAdd && (
                    <button className="button primary small" onClick={add}>
                      <Plus size={15} />
                      Add the first one
                    </button>
                  )}
                </div>
              )}
              <div className="queue-note">
                <Link2 size={14} />
                Direct video, audio, and live stream links.
                <br />A shared queue for a shared good time.
              </div>
            </div>
          )}
          {panel === 'people' && (
            <div className="participants-panel" role="tabpanel">
              <div className="panel-title">
                <div>
                  <h3>Good company</h3>
                  <p>{online} of 8 seats filled</p>
                </div>
                <button className="icon-button" onClick={onShare} aria-label="Invite friends">
                  <UserPlus size={20} />
                </button>
              </div>
              {room.participants.map((person) => (
                <div className="participant-row" key={person.id}>
                  <span className={`message-avatar ${colorFor(person.name)}`}>
                    {initials(person.name)}
                    <i className={person.online ? 'online' : ''} />
                  </span>
                  <div className="participant-name">
                    <strong>
                      {person.name}
                      {person.id === identity.id && <small> (you)</small>}
                    </strong>
                    <span>
                      {person.id === room.hostId ? (
                        <>
                          <Crown size={11} />
                          Room host
                        </>
                      ) : !person.online ? (
                        'Reconnecting…'
                      ) : (room.queueAccess ?? []).includes(person.id) ? (
                        <>
                          <ListPlus size={11} />
                          Can add to the queue
                        </>
                      ) : person.inCall ? (
                        'In the call'
                      ) : (
                        'Here for the good times'
                      )}
                    </span>
                  </div>
                  <div className="participant-status">
                    {person.mic ? <Mic size={14} /> : <MicOff size={14} />}
                    {person.camera ? <Video size={14} /> : <VideoOff size={14} />}
                  </div>
                  {isHost && person.id !== identity.id && (
                    <details
                      className="person-menu"
                      // Close the menu once one of its actions is chosen.
                      onClick={(e) => {
                        if ((e.target as HTMLElement).closest('button'))
                          e.currentTarget.removeAttribute('open');
                      }}
                    >
                      <summary aria-label={`Manage ${person.name}`}>
                        <MoreHorizontal size={17} />
                      </summary>
                      <div>
                        <button
                          onClick={() =>
                            action('room:queue-access', {
                              id: person.id,
                              allowed: !(room.queueAccess ?? []).includes(person.id),
                            })
                          }
                        >
                          <ListPlus size={13} />
                          {(room.queueAccess ?? []).includes(person.id)
                            ? 'Stop queue access'
                            : 'Let them add to queue'}
                        </button>
                        <button onClick={() => action('room:transfer', { id: person.id })}>
                          <Crown size={13} />
                          Make host
                        </button>
                        <button
                          className="danger-text"
                          onClick={() => action('room:kick', { id: person.id })}
                        >
                          <LogOut size={13} />
                          Remove
                        </button>
                      </div>
                    </details>
                  )}
                </div>
              ))}
              <button className="button dark-secondary wide" onClick={onShare}>
                <UserPlus size={16} />
                Invite your people
              </button>
              <div className="privacy-note">
                <ShieldCheck size={20} />
                <strong>A room just for you.</strong>
                <p>
                  Only people with your invitation can join.
                  {room.locked
                    ? ' Your room is currently locked.'
                    : ' Your host can lock the room anytime.'}
                </p>
              </div>
            </div>
          )}
        </aside>
      </div>
      <footer className="call-bar">
        <div className="call-bar-left">
          <span className={`call-status-icon ${call.inCall ? 'active' : ''}`}>
            <Headphones size={19} />
          </span>
          <div>
            <strong>
              {call.inCall ? 'You’re in the conversation' : 'A little face-to-face time?'}
            </strong>
            <small>
              {call.inCall
                ? `${callCount} ${callCount === 1 ? 'person' : 'people'} in the call`
                : 'Join with your mic or camera.'}
            </small>
          </div>
        </div>
        <div className="call-buttons">
          <button
            className={`call-control ${call.mic ? 'enabled' : ''}`}
            onClick={call.toggleMic}
            disabled={call.busy || !connected}
            aria-label={
              call.mic ? 'Mute microphone' : call.inCall ? 'Unmute microphone' : 'Join voice call'
            }
            title={call.mic ? 'Mute microphone' : 'Turn on microphone'}
          >
            {call.busy ? (
              <LoaderCircle className="spin" size={20} />
            ) : call.mic ? (
              <Mic size={20} />
            ) : (
              <MicOff size={20} />
            )}
          </button>
          <button
            className={`call-control ${call.camera ? 'enabled' : ''}`}
            onClick={call.toggleCamera}
            disabled={call.busy || !connected}
            aria-label={call.camera ? 'Turn camera off' : 'Turn camera on'}
          >
            {call.camera ? <Video size={20} /> : <VideoOff size={20} />}
          </button>
          <button
            className={`call-control speaker-control ${speakers ? '' : 'muted'}`}
            onClick={() => setSpeakers(!speakers)}
            aria-label={speakers ? 'Mute call audio' : 'Unmute call audio'}
          >
            {speakers ? <Volume2 size={20} /> : <VolumeX size={20} />}
          </button>
          <span className="call-divider" />
          {call.inCall ? (
            <button className="call-control end-call" onClick={call.leave} aria-label="Leave call">
              <PhoneOff size={21} />
            </button>
          ) : (
            <button
              className="button call-join"
              onClick={call.toggleMic}
              disabled={call.busy || !connected}
            >
              <Phone size={16} />
              Join call
            </button>
          )}
        </div>
        <div className="call-bar-right">
          <span className="reaction-buttons">
            {['❤️', '😂', '🍿'].map((emoji) => (
              <button
                key={emoji}
                onClick={() => action('reaction:send', { emoji })}
                aria-label={`React ${emoji}`}
                disabled={!connected}
              >
                {emoji}
              </button>
            ))}
          </span>
          <span className="call-privacy">
            <LockKeyhole size={12} />
            Just us.
          </span>
        </div>
      </footer>
      <nav className="mobile-room-nav" aria-label="Room navigation">
        {(
          [
            { id: 'watch', icon: MonitorPlay, label: 'Watch' },
            { id: 'chat', icon: MessageCircle, label: 'Chat' },
            { id: 'people', icon: Users, label: 'People' },
            { id: 'call', icon: Video, label: 'Call' },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            className={mobileView === item.id ? 'active' : ''}
            onClick={() => selectMobile(item.id)}
          >
            <item.icon size={20} />
            {item.label}
          </button>
        ))}
      </nav>
      <div className="floating-reactions" aria-live="polite">
        {reactions.map((reaction, index) => (
          <span key={reaction.id} style={{ left: `${15 + (index % 5) * 16}%` }}>
            <span>{reaction.emoji}</span>
            <small>{reaction.name}</small>
          </span>
        ))}
      </div>
      {modal === 'media' && (
        <Modal
          title="What’s the mood tonight?"
          subtitle="A great watch. A favorite song. Something worth sharing."
          onClose={closeModal}
        >
          <div className="entry-tabs">
            <button
              className={mediaTab === 'link' ? 'active' : ''}
              onClick={() => setMediaTab('link')}
            >
              <Link2 size={15} />
              Paste a link
            </button>
            <button
              className={mediaTab === 'file' ? 'active' : ''}
              onClick={() => {
                setMediaTab('file');
                setFormError('');
              }}
            >
              <Upload size={15} />
              From your device
            </button>
            <button
              className={mediaTab === 'samples' ? 'active' : ''}
              onClick={() => setMediaTab('samples')}
            >
              <Film size={15} />
              Try an open movie
            </button>
          </div>
          {mediaTab === 'link' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void addMedia({
                  title: mediaTitle.trim(),
                  url: mediaUrl.trim(),
                  kind: isYouTubeLink ? 'video' : mediaKind,
                });
              }}
            >
              <label>
                Media link
                <input
                  type="url"
                  value={mediaUrl}
                  onChange={(e) => setMediaUrl(e.target.value)}
                  placeholder="https://example.com/a-great-movie.mp4"
                  maxLength={2048}
                  required
                />
                <small>
                  YouTube links, or direct MP4, WebM, MP3, or HLS (.m3u8) links. The source must
                  allow playback in your browser.
                </small>
              </label>
              <label>
                Give it a title
                <input
                  value={mediaTitle}
                  onChange={(e) => setMediaTitle(e.target.value)}
                  placeholder="Something everyone should see"
                  required
                  maxLength={100}
                />
              </label>
              {!isYouTubeLink && (
                <label>
                  Type
                  <select
                    value={mediaKind}
                    onChange={(e) => setMediaKind(e.target.value as 'video' | 'audio')}
                  >
                    <option value="video">Video / live stream</option>
                    <option value="audio">Music / audio</option>
                  </select>
                </label>
              )}
              <p className="source-note">
                {isYouTubeLink
                  ? 'Plays in YouTube’s player for everyone. Videos whose owners block embedding won’t play here.'
                  : 'Subscription streaming services aren’t supported. Everyone streams directly from the source.'}
              </p>
              {formError && (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              )}
              <button className="button primary wide" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <>
                    <Plus size={17} />
                    Add to our queue
                  </>
                )}
              </button>
            </form>
          ) : mediaTab === 'file' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void shareFile();
              }}
            >
              <label>
                Video or song
                <input
                  type="file"
                  accept="video/*,audio/*"
                  disabled={busy}
                  required
                  onChange={(e) => {
                    const file = e.target.files?.[0] || null;
                    const problem = file ? checkFile(file) : '';
                    setFormError(problem);
                    setMediaFile(problem ? null : file);
                    if (problem) e.target.value = '';
                    else if (file) setMediaTitle(fileTitle(file));
                  }}
                />
                <small>
                  Up to 100 MB. MP4, WebM, MP3, M4A, and other formats your browser can play.
                </small>
              </label>
              <label>
                Give it a title
                <input
                  value={mediaTitle}
                  onChange={(e) => setMediaTitle(e.target.value)}
                  placeholder="Something everyone should see"
                  required
                  maxLength={100}
                />
              </label>
              <p className="source-note">
                It’s uploaded once and streamed to everyone in this room, then deleted when it
                leaves the queue or the room closes.
              </p>
              {progress !== null && (
                <div
                  className="upload-progress"
                  role="progressbar"
                  aria-label="Upload progress"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
              )}
              {formError && (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              )}
              <button className="button primary wide" disabled={busy || !mediaFile}>
                {busy ? (
                  <>
                    <LoaderCircle className="spin" size={18} />
                    {progress !== null ? `Uploading… ${progress}%` : null}
                  </>
                ) : (
                  <>
                    <Upload size={17} />
                    Upload and add to our queue
                  </>
                )}
              </button>
            </form>
          ) : (
            <div className="sample-list">
              {samples.map((sample, index) => (
                <button disabled={busy} key={sample.title} onClick={() => addMedia(sample)}>
                  <span className={`sample-art sample-${index}`}>
                    <Film size={24} />
                  </span>
                  <span>
                    <strong>{sample.title}</strong>
                    <small>
                      {
                        [
                          'An epic quest. An unlikely friendship.',
                          'A big bunny. A little mischief.',
                          'A sci-fi story with a human heart.',
                        ][index]
                      }
                    </small>
                  </span>
                  <Plus size={18} />
                </button>
              ))}
              <p>
                Open movies by the Blender Foundation. Streamed from Google’s public sample library.
              </p>
              {formError && (
                <p className="form-error" role="alert">
                  {formError}
                </p>
              )}
            </div>
          )}
        </Modal>
      )}
      {modal === 'settings' && isHost && (
        <Modal
          title="Your room. Your rules."
          subtitle="Keep the good times comfortable for everyone."
          onClose={closeModal}
        >
          <div className="setting-row">
            <span>
              <strong>Everyone gets the remote</strong>
              <small>Let friends play, pause, and choose media.</small>
            </span>
            <button
              className={`toggle ${room.everyoneControls ? 'on' : ''}`}
              role="switch"
              aria-checked={room.everyoneControls}
              aria-label="Everyone can control playback"
              onClick={() => action('room:settings', { everyoneControls: !room.everyoneControls })}
            >
              <i />
            </button>
          </div>
          <div className="setting-row">
            <span>
              <strong>Lock the room</strong>
              <small>Keep new guests from joining. Reconnecting friends keep their seat.</small>
            </span>
            <button
              className={`toggle ${room.locked ? 'on' : ''}`}
              role="switch"
              aria-checked={room.locked}
              aria-label="Lock room"
              onClick={() => action('room:settings', { locked: !room.locked })}
            >
              <i />
            </button>
          </div>
          <div className="settings-info">
            <Crown size={18} />
            <p>
              You’re the host. You can hand over hosting or remove a participant in the People tab.
            </p>
          </div>
          <button className="button danger wide" onClick={() => setModal('close')}>
            <LogOut size={17} />
            End room for everyone
          </button>
        </Modal>
      )}
      {(modal === 'leave' || modal === 'close') && (
        <Modal
          title={modal === 'close' ? 'Call it a night?' : 'Heading out?'}
          subtitle={
            modal === 'close'
              ? 'This closes the room for everyone. The chat and queue will be cleared.'
              : room.participants.length === 2
                ? 'Only one person would be left, so this closes the room for them too.'
                : isHost && online > 1
                  ? 'Your friends can keep watching. Another participant will become the host.'
                  : 'You can come back with the same room link while the room is active.'
          }
          onClose={closeModal}
        >
          <div className="confirm-actions">
            <button className="button secondary" onClick={closeModal}>
              Stay a little longer
            </button>
            <button
              className="button primary"
              onClick={async () => {
                if (modal === 'close') await action('room:close');
                else {
                  call.leave();
                  await onLeave();
                }
              }}
            >
              {modal === 'close' ? 'End room' : 'Leave room'}
              <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
