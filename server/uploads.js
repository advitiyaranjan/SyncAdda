import { timingSafeEqual } from 'node:crypto';
import { del, list } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';

// Local videos and songs are uploaded straight from the browser to Vercel Blob (never through
// this server), then played like any other link. They're deleted when removed from the queue or
// when the room closes; a daily sweep catches anything left behind by rooms that simply expired.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_UPLOAD_AGE_MS = 24 * 3600 * 1000;

export const isUpload = (url) => {
  try {
    return new URL(url).hostname.endsWith('.blob.vercel-storage.com');
  } catch {
    return false;
  }
};
export const sameSecret = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function deleteUploads(urls) {
  const targets = [...new Set(urls)].filter(isUpload);
  if (!targets.length || !process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await del(targets);
  } catch (error) {
    console.error('Could not delete uploads:', error);
  }
}

/** Removed from the queue, or the whole room closed: returns the upload URLs no longer needed. */
export const droppedUploads = (before, after) => {
  const kept = new Set(after.map((m) => m.url));
  return before.map((m) => m.url).filter((url) => isUpload(url) && !kept.has(url));
};

/**
 * Issues a short-lived upload token to a current member of the room.
 * `isMember(code, id, token)` checks the room store.
 */
export async function uploadHandler(req, res, isMember) {
  if (!process.env.BLOB_READ_WRITE_TOKEN)
    return res.status(503).json({ error: 'Uploads aren’t set up on this server.' });
  try {
    const result = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        let payload = {};
        try {
          payload = JSON.parse(clientPayload || '{}');
        } catch {
          /* rejected below */
        }
        const { code, id, token } = payload;
        if (typeof code !== 'string' || !(await isMember(code, id, token)))
          throw new Error('Join the room to share a file.');
        if (!pathname.startsWith(`rooms/${code}/`)) throw new Error('That upload isn’t allowed.');
        return {
          allowedContentTypes: ['video/*', 'audio/*'],
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: true,
          validUntil: Date.now() + 30 * 60 * 1000,
        };
      },
    });
    res.status(200).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message || 'The upload could not start.' });
  }
}

export async function sweepOldUploads() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return 0;
  let cursor,
    removed = 0;
  do {
    const page = await list({ prefix: 'rooms/', cursor, limit: 1000 });
    const old = page.blobs
      .filter((blob) => Date.now() - new Date(blob.uploadedAt).getTime() > MAX_UPLOAD_AGE_MS)
      .map((blob) => blob.url);
    if (old.length) await del(old);
    removed += old.length;
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return removed;
}
