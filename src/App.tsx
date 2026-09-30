import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, Copy, Link2, LoaderCircle, LockKeyhole, Users } from 'lucide-react';
import { Modal } from './components';
import { callState, getIdentity, rememberIdentity, request, socket } from './lib';
import type { Identity, Room } from './types';
import Landing from './Landing';
import WatchRoom from './WatchRoom';

const pathCode = () =>
  /^\/room\/([A-Z2-9]{6})\/?$/i.exec(location.pathname)?.[1].toUpperCase() || '';
export default function App() {
  const [identity, setIdentity] = useState<Identity>(getIdentity);
  const [room, setRoom] = useState<Room | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [dialog, setDialog] = useState<'create' | 'join' | 'share' | null>(
    pathCode() ? 'join' : null,
  );
  const [code, setCode] = useState(pathCode);
  const [name, setName] = useState(identity.name);
  const [roomName, setRoomName] = useState('The good company club');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const activeCode = useRef('');
  const identityRef = useRef(identity);
  const notify = useCallback((message: string) => setToast(message), []);
  const closeDialog = useCallback(() => {
    setDialog(null);
    setError('');
  }, []);
  useEffect(() => {
    identityRef.current = identity;
  }, [identity]);
  useEffect(() => {
    const connect = async () => {
      setConnected(true);
      const restore =
        activeCode.current || (pathCode() && identityRef.current.name ? pathCode() : '');
      if (!restore) return;
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await request<{ room: Room }>('room:join', {
            code: restore,
            identity: identityRef.current,
            call: callState,
          });
          activeCode.current = restore;
          setRoom(data.room);
          setDialog(null);
          return;
        } catch (e) {
          // Dropped again: the next connect event tries again.
          if (!socket.connected) return;
          // A brief hiccup on the room server (such as right after hosting recycles a
          // connection) shouldn't send anyone back to the lobby, where their seat, and the
          // host's role, would lapse if they don't rejoin in time.
          if (attempt < 3 && /busy|took too long|too fast/i.test((e as Error).message)) {
            await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
            // Unless they've left or moved on meanwhile.
            if ((activeCode.current || pathCode()) !== restore) return;
            continue;
          }
          activeCode.current = '';
          setRoom(null);
          setDialog('join');
          setError((e as Error).message);
          return;
        }
      }
    };
    const disconnect = () => setConnected(false);
    // Live updates carry only the latest messages; keep the history received when joining.
    const state = (value: Room) =>
      setRoom((previous) => {
        if (!previous || previous.code !== value.code) return value;
        const known = new Set(value.messages.map((m) => m.id)),
          from = value.messages[0]?.at ?? Infinity;
        const earlier = previous.messages.filter((m) => !known.has(m.id) && m.at <= from);
        return { ...value, messages: [...earlier, ...value.messages] };
      });
    const ended = ({ message }: { message: string }) => {
      activeCode.current = '';
      setRoom(null);
      setDialog(null);
      history.pushState({}, '', '/');
      notify(message);
    };
    socket.on('connect', connect);
    socket.on('disconnect', disconnect);
    socket.on('room:state', state);
    socket.on('room:ended', ended);
    socket.connect();
    return () => {
      socket.off('connect', connect);
      socket.off('disconnect', disconnect);
      socket.off('room:state', state);
      socket.off('room:ended', ended);
      socket.disconnect();
    };
  }, [notify]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    document.documentElement.dataset.theme = room ? 'dark' : 'light';
    document.title = room
      ? `${room.name} · SyncAdda`
      : 'SyncAdda — A little closer, wherever you are.';
  }, [room?.name, !!room]);
  useEffect(() => {
    const pop = () => {
      if (activeCode.current) {
        request('room:leave').catch(() => {});
        activeCode.current = '';
        setRoom(null);
      }
      const next = pathCode();
      if (next) {
        setCode(next);
        setDialog('join');
      } else setDialog(null);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  async function enter(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = { ...identity, name: name.trim() };
      const result = await request<{ room: Room }>(
        dialog === 'create' ? 'room:create' : 'room:join',
        { identity: user, name: roomName.trim(), code: code.toUpperCase().trim() },
      );
      rememberIdentity(user);
      identityRef.current = user;
      setIdentity(user);
      activeCode.current = result.room.code;
      setRoom(result.room);
      history.pushState({}, '', `/room/${result.room.code}`);
      closeDialog();
      window.scrollTo(0, 0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function leave() {
    try {
      await request('room:leave');
    } catch {
      socket.disconnect();
      socket.connect();
    }
    activeCode.current = '';
    setRoom(null);
    history.pushState({}, '', '/');
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(`${label} copied. Send it to your favorite people!`);
    } catch {
      notify('Copy is unavailable. Select the link or code to copy it.');
    }
  }
  return (
    <>
      {room ? (
        <WatchRoom
          room={room}
          identity={identity}
          connected={connected}
          onShare={() => setDialog('share')}
          onLeave={leave}
          notify={notify}
        />
      ) : (
        <Landing
          onCreate={() => {
            setError('');
            setDialog('create');
          }}
          onJoin={() => {
            setError('');
            setDialog('join');
          }}
        />
      )}
      {(dialog === 'create' || dialog === 'join') && (
        <Modal
          title={dialog === 'create' ? 'Good times start here.' : 'Your people are waiting.'}
          subtitle={
            dialog === 'create'
              ? 'Make a little space for your favorite people.'
              : 'Grab a seat. You’re just a room code away.'
          }
          onClose={closeDialog}
        >
          <div className="entry-tabs">
            <button
              className={dialog === 'create' ? 'active' : ''}
              onClick={() => {
                setDialog('create');
                setError('');
              }}
            >
              Create a room
            </button>
            <button
              className={dialog === 'join' ? 'active' : ''}
              onClick={() => {
                setDialog('join');
                setError('');
              }}
            >
              Join a room
            </button>
          </div>
          <form onSubmit={enter}>
            <label>
              Your name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="What should we call you?"
                maxLength={24}
                required
                autoComplete="given-name"
              />
            </label>
            {dialog === 'create' ? (
              <label>
                Room name<span className="optional">Make it yours</span>
                <input
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  maxLength={48}
                  required
                />
              </label>
            ) : (
              <label>
                Room code
                <input
                  className="code-input"
                  value={code}
                  onChange={(e) => {
                    const value = e.target.value;
                    const match = /\/room\/([A-Z2-9]{6})/i.exec(value);
                    setCode(
                      match
                        ? match[1].toUpperCase()
                        : value
                            .replace(/[^a-z0-9]/gi, '')
                            .toUpperCase()
                            .slice(0, 6),
                    );
                  }}
                  placeholder="ABC123"
                  minLength={6}
                  maxLength={200}
                  required
                  autoComplete="off"
                />
                <small>Paste a room code or an invitation link.</small>
              </label>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="button primary wide" type="submit" disabled={busy || !connected}>
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <>
                  {connected
                    ? dialog === 'create'
                      ? 'Create my room'
                      : 'Let me in'
                    : 'Connecting…'}
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          <div className="modal-footnote">
            <LockKeyhole size={14} />
            Private room. No account. Just you and your people.
          </div>
        </Modal>
      )}
      {dialog === 'share' && room && (
        <Modal
          title="Better with your people."
          subtitle="Send an invite. Save them a seat."
          onClose={closeDialog}
        >
          <div className="share-code">
            <span>YOUR ROOM CODE</span>
            <strong>{room.code}</strong>
            <button className="button secondary" onClick={() => copy(room.code, 'Room code')}>
              <Copy size={16} />
              Copy code
            </button>
          </div>
          <label>
            Or share the link
            <div className="input-action">
              <input
                readOnly
                value={`${location.origin}/room/${room.code}`}
                onFocus={(e) => e.target.select()}
              />
              <button
                className="icon-button"
                aria-label="Copy invitation link"
                onClick={() => copy(`${location.origin}/room/${room.code}`, 'Invite link')}
              >
                <Link2 size={19} />
              </button>
            </div>
          </label>
          {typeof navigator.share === 'function' && (
            <button
              className="button primary wide"
              onClick={() =>
                navigator
                  .share({
                    title: `Join ${room.name} on SyncAdda`,
                    url: `${location.origin}/room/${room.code}`,
                  })
                  .catch(() => {})
              }
            >
              <Users size={17} />
              Share invitation
            </button>
          )}
          <div className="modal-footnote">
            <Check size={14} />
            Your friends won’t need an account either.
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{toast}</span>
        </div>
      )}
    </>
  );
}
