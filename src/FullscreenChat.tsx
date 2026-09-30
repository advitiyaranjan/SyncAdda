import { useState } from 'react';
import { MessageCircle, MessageCircleOff, Send } from 'lucide-react';
import type { Message } from './types';

const EMOJIS = ['❤️', '😂', '🔥', '👏', '🍿', '✨'];
const load = () => {
  try {
    return localStorage.getItem('syncadda-fullscreen-chat') !== 'hidden';
  } catch {
    return true;
  }
};

/** See-through chat and reactions over the fullscreen player, which can be tucked away. */
export default function FullscreenChat({
  messages,
  meId,
  connected,
  reactions,
  onSend,
  onReact,
}: {
  messages: Message[];
  meId: string;
  connected: boolean;
  reactions: { id: string; emoji: string; name: string }[];
  onSend: (text: string) => Promise<boolean>;
  onReact: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(load);
  const [draft, setDraft] = useState('');
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem('syncadda-fullscreen-chat', open ? 'hidden' : 'shown');
    } catch {
      /* remembered for this visit only */
    }
  };
  return (
    <div className="fs-overlay">
      <div className="fs-reactions" aria-live="polite">
        {reactions.map((reaction, index) => (
          <span key={reaction.id} style={{ left: `${30 + (index % 5) * 8}%` }}>
            <span>{reaction.emoji}</span>
            <small>{reaction.name}</small>
          </span>
        ))}
      </div>
      <button
        className="fs-toggle"
        onClick={toggle}
        aria-label={open ? 'Hide chat' : 'Show chat'}
        aria-pressed={open}
      >
        {open ? <MessageCircleOff size={18} /> : <MessageCircle size={18} />}
      </button>
      {open && (
        <div className="fs-chat">
          {/* Newest at the bottom, and the list stays scrolled there. */}
          <div className="fs-messages" aria-live="polite">
            {messages
              .slice(-40)
              .reverse()
              .map((message) =>
                message.system ? (
                  <p className="fs-system" key={message.id}>
                    {message.text}
                  </p>
                ) : (
                  <p key={message.id} className={message.personId === meId ? 'own' : ''}>
                    <strong>{message.name}</strong> {message.text}
                  </p>
                ),
              )}
          </div>
          <div className="fs-emoji">
            {EMOJIS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => onReact(emoji)}
                aria-label={`React ${emoji}`}
                disabled={!connected}
              >
                {emoji}
              </button>
            ))}
          </div>
          <form
            className="fs-composer"
            onSubmit={async (e) => {
              e.preventDefault();
              if (draft.trim() && (await onSend(draft.trim()))) setDraft('');
            }}
          >
            <input
              aria-label="Chat while watching"
              placeholder="Say something…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={1500}
              disabled={!connected}
            />
            <button type="submit" aria-label="Send" disabled={!draft.trim() || !connected}>
              <Send size={15} />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
