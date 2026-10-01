// Keep several block requests in flight to hide network round trips, while retaining byte
// order and a fixed memory budget even when the media element stops consuming data.
export const BLOCK = 512 * 1024;
const CONCURRENT = 4;
const WINDOW = 8; // At most 4 MiB reserved per HTTP range, including in-flight bytes.

type FetchBlock = (
  start: number,
  end: number,
  piece: (bytes: ArrayBuffer) => void,
  signal: AbortSignal,
) => Promise<void>;

export function createRangeReader(start: number, end: number, fetchBlock: FetchBlock) {
  type Slot = { at: number; end: number; pieces: ArrayBuffer[]; done: boolean };
  const slots: Slot[] = [];
  const controller = new AbortController();
  let planned = start,
    active = 0,
    closed = false;
  let waiter: ((piece: ArrayBuffer | null) => void) | undefined;

  function give() {
    while (slots[0]?.done && !slots[0].pieces.length) slots.shift();
    if (!waiter) return;
    const piece = slots[0]?.pieces.shift();
    if (!piece && !closed && (slots.length || planned < end)) return;
    const resolve = waiter;
    waiter = undefined;
    resolve(piece ?? null);
  }
  async function run(slot: Slot) {
    try {
      while (!closed && slot.at < slot.end) {
        try {
          await fetchBlock(
            slot.at,
            slot.end,
            (bytes) => {
              if (closed) return;
              if (!bytes.byteLength || slot.at + bytes.byteLength > slot.end)
                throw new Error('Invalid file block.');
              slot.at += bytes.byteLength;
              slot.pieces.push(bytes);
              give();
            },
            controller.signal,
          );
          if (slot.at < slot.end) throw new Error('Incomplete file block.');
        } catch {
          if (closed) return;
          // Preserve bytes already received and resume at the first missing byte.
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', done);
              resolve();
            };
            const timer = setTimeout(done, 1500);
            controller.signal.addEventListener('abort', done, { once: true });
          });
        }
      }
      slot.done = true;
    } finally {
      active--;
      give();
      fill();
    }
  }
  function fill() {
    if (closed) return;
    while (active < CONCURRENT && slots.length < WINDOW && planned < end) {
      const slot: Slot = {
        at: planned,
        end: Math.min(end, planned + BLOCK),
        pieces: [],
        done: false,
      };
      planned = slot.end;
      slots.push(slot);
      active++;
      void run(slot);
    }
  }
  const reader = {
    next: () =>
      new Promise<ArrayBuffer | null>((resolve) => {
        waiter = resolve;
        give();
        fill();
      }),
    cancel() {
      closed = true;
      slots.length = 0;
      controller.abort();
      give();
    },
  };
  fill();
  return reader;
}
