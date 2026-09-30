import { useEffect } from 'react';

/** Keeps the screen on (phones especially) while `active`, e.g. during a movie or a call. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null,
      asking = false,
      done = false;
    const acquire = async () => {
      if (lock?.released) lock = null;
      if (done || lock || asking || document.visibilityState !== 'visible') return;
      asking = true;
      try {
        const granted = await navigator.wakeLock.request('screen');
        if (done) return void granted.release();
        lock = granted;
        // The phone can take it back at any time (a low battery, say): ask again.
        granted.addEventListener('release', () => {
          if (lock === granted) lock = null;
          void acquire();
        });
      } catch {
        /* not allowed right now (e.g. battery saver); the retries below try again */
      } finally {
        asking = false;
      }
    };
    void acquire();
    // The browser drops the lock whenever the page is hidden, so take it again on return. Some
    // phones also refuse it until the page is touched, or drop it without saying so.
    document.addEventListener('visibilitychange', acquire);
    document.addEventListener('fullscreenchange', acquire);
    document.addEventListener('pointerdown', acquire);
    const retry = setInterval(acquire, 15_000);
    return () => {
      done = true;
      document.removeEventListener('visibilitychange', acquire);
      document.removeEventListener('fullscreenchange', acquire);
      document.removeEventListener('pointerdown', acquire);
      clearInterval(retry);
      void lock?.release();
    };
  }, [active]);
}
