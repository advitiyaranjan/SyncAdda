import { MessageCircle, Phone, X } from 'lucide-react';

export type Notice = {
  id: string;
  kind: 'chat' | 'call';
  title: string;
  text: string;
  // Tapping the card: opens the chat, say.
  open?: () => void;
  action?: { label: string; run: () => void };
};

// The device's own notifications, for while the room is in the background. They need the
// person's permission, which is asked for when they first chat or join the call. iPhones only
// offer them to sites added to the home screen.
const supported = () => typeof window !== 'undefined' && 'Notification' in window;
export function askNotifications() {
  if (supported() && Notification.permission === 'default')
    void Notification.requestPermission().catch(() => {});
}
export function systemNotify(title: string, body: string, tag: string) {
  if (document.visibilityState === 'visible' || !supported()) return;
  if (Notification.permission !== 'granted') return;
  const options = { body, tag, icon: '/favicon.svg' };
  // Android only shows them through a service worker; elsewhere the page can show them itself.
  const page = () => {
    try {
      const shown = new Notification(title, options);
      shown.onclick = () => {
        window.focus();
        shown.close();
      };
    } catch {
      /* not allowed here */
    }
  };
  if (!('serviceWorker' in navigator)) return page();
  navigator.serviceWorker
    .register('/stream-sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((worker) => worker.showNotification(title, options))
    .catch(page);
}

export default function NoticeStack({
  notices,
  dismiss,
}: {
  notices: Notice[];
  dismiss: (id: string) => void;
}) {
  if (!notices.length) return null;
  return (
    <div className="notice-stack" aria-live="polite">
      {notices.map((notice) => (
        <div className={`notice notice-${notice.kind}`} key={notice.id}>
          <button
            className="notice-body"
            onClick={() => {
              notice.open?.();
              dismiss(notice.id);
            }}
          >
            <span className="notice-icon">
              {notice.kind === 'chat' ? <MessageCircle size={16} /> : <Phone size={16} />}
            </span>
            <span className="notice-text">
              <strong>{notice.title}</strong>
              <span>{notice.text}</span>
            </span>
          </button>
          {notice.action && (
            <button
              className="button primary small notice-action"
              onClick={() => {
                notice.action!.run();
                dismiss(notice.id);
              }}
            >
              {notice.action.label}
            </button>
          )}
          <button
            className="notice-close"
            aria-label="Dismiss notification"
            onClick={() => dismiss(notice.id)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
