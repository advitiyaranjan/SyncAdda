import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowUpRight, Play, X } from 'lucide-react';
export function Brand({ onClick }: { onClick?: () => void }) {
  return (
    <button className="brand" onClick={onClick} aria-label="SyncAdda home">
      <span className="brand-mark">
        <i />
        <Play size={18} fill="currentColor" strokeWidth={1} />
      </span>
      <span>
        sync<span className="brand-soft">adda</span>
        <span className="brand-dot">.</span>
      </span>
    </button>
  );
}
export function Modal({
  title,
  subtitle,
  children,
  onClose,
  className = '',
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const el = ref.current;
    const focusable = () =>
      Array.from(
        el?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, select, textarea, a[href], [tabindex="0"]',
        ) || [],
      );
    (el?.querySelector<HTMLElement>('input') || focusable()[0])?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
      if (event.key === 'Tab') {
        const nodes = focusable();
        const first = nodes[0],
          last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={`modal ${className}`}
      >
        <button className="icon-button modal-close" onClick={onClose} aria-label="Close dialog">
          <X size={20} />
        </button>
        <div className="modal-symbol">
          <Play size={22} fill="currentColor" />
        </div>
        <h2 id="modal-title">{title}</h2>
        {subtitle && <p className="modal-subtitle">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}
export function ArrowLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={17} />
    </button>
  );
}
