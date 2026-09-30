import { useEffect } from 'react';

/** Keeps the screen on (phones especially) while `active`, e.g. during a movie or a call. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null,
      done = false;
    const acquire = async () => {
      if (done || lock || document.visibilityState !== 'visible') return;
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => (lock = null));
        if (done) void lock.release();
      } catch {
        /* not allowed right now (e.g. battery saver); the screen may still sleep */
      }
    };
    void acquire();
    // The browser drops the lock whenever the page is hidden, so take it again on return.
    document.addEventListener('visibilitychange', acquire);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release();
    };
  }, [active]);
}
