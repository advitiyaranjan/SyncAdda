import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Keep the test command compatible with the project's Node 22.9 minimum.
const source = readFileSync(new URL('../src/rangeReader.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
});
const { createRangeReader, BLOCK } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function collect(reader) {
  const pieces = [];
  for (let piece; (piece = await reader.next());) pieces.push(Buffer.from(piece));
  return Buffer.concat(pieces);
}

test('requests blocks ahead of a network round trip and delivers out-of-order replies in order', async () => {
  const pending = [];
  const reader = createRangeReader(
    7,
    3 * BLOCK + 30,
    (start, end, piece) => new Promise((resolve) => pending.push({ start, end, piece, resolve })),
  );
  assert.equal(pending.length, 4, 'all four requests leave before any reply arrives');
  const result = collect(reader);
  for (const [index, block] of [...pending.entries()].reverse()) {
    block.piece(new Uint8Array(block.end - block.start).fill(index + 1).buffer);
    block.resolve();
  }
  const bytes = await result;
  assert.equal(bytes.length, 3 * BLOCK + 23);
  for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], Math.floor(i / BLOCK) + 1);
  assert.equal(await reader.next(), null);
});

test('read-ahead stays bounded while paused and resumes when the player consumes bytes', async () => {
  let fetched = 0;
  const reader = createRangeReader(0, 20 * BLOCK, async (start, end, piece) => {
    fetched += end - start;
    piece(new ArrayBuffer(end - start));
  });
  await tick();
  assert.equal(fetched, 8 * BLOCK, 'reserve at most 4 MiB, including in-flight blocks');
  for (let i = 0; i < 5; i++) await reader.next();
  await tick();
  assert.ok(fetched > 8 * BLOCK);
  reader.cancel();
  assert.equal(await reader.next(), null);
});

test('a failed block resumes after its last received byte without duplicating or skipping data', async () => {
  const calls = [];
  const reader = createRangeReader(100, 112, async (start, end, piece) => {
    calls.push([start, end]);
    if (calls.length === 1) {
      piece(Uint8Array.from([100, 101, 102, 103]).buffer);
      throw new Error('connection lost');
    }
    piece(Uint8Array.from({ length: end - start }, (_, i) => start + i).buffer);
  });
  assert.deepEqual(
    [...(await collect(reader))],
    Array.from({ length: 12 }, (_, i) => 100 + i),
  );
  assert.deepEqual(calls, [
    [100, 112],
    [104, 112],
  ]);
});

test('seeking cancels every outstanding block and unblocks a waiting player', async () => {
  let cancelled = 0;
  const reader = createRangeReader(
    0,
    20 * BLOCK,
    (_start, _end, _piece, signal) =>
      new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled++;
            resolve();
          },
          { once: true },
        ),
      ),
  );
  const waiting = reader.next();
  reader.cancel();
  assert.equal(await waiting, null);
  await tick();
  assert.equal(cancelled, 4);
  assert.equal(await reader.next(), null);
});

test('an empty range finishes without starting a transfer', async () => {
  const reader = createRangeReader(0, 0, () => {
    throw new Error('unexpected request');
  });
  assert.equal(await reader.next(), null);
});
