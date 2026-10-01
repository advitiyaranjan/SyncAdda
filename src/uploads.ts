// Shares a video or song from this device: uploaded straight to Vercel Blob, then played by
// everyone like any other link. The server deletes it when it leaves the queue or the room closes.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const extensionTypes: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
};
export const nameType = (name: string) =>
  extensionTypes[name.split('.').pop()?.toLowerCase() || ''] || '';
const mediaType = (file: File) => file.type || nameType(file.name);

export const fileKind = (file: File) =>
  /^(video|audio)\//.exec(mediaType(file))?.[1] as 'video' | 'audio' | undefined;

export const fileTitle = (file: File) =>
  file.name
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .trim()
    .slice(0, 100) || 'My file';

/** Returns a problem with the file, or '' if it can be shared. */
export function checkFile(file: File) {
  if (!/^(video|audio)\//.test(mediaType(file))) return 'Choose a video or audio file.';
  if (file.size > MAX_UPLOAD_BYTES) return 'That file is over 100 MB. Choose a smaller one.';
  return '';
}

export async function uploadMedia(
  file: File,
  room: { code: string; id: string; token: string },
  onProgress: (percent: number) => void,
): Promise<{ url: string; kind: 'video' | 'audio' }> {
  const problem = checkFile(file);
  if (problem) throw new Error(problem);
  const contentType = mediaType(file);
  const { upload } = await import('@vercel/blob/client');
  const name = file.name.replace(/[^\w.-]+/g, '-').slice(-80) || 'media';
  try {
    const blob = await upload(`rooms/${room.code}/${name}`, file, {
      access: 'public',
      handleUploadUrl: '/api/upload',
      clientPayload: JSON.stringify(room),
      contentType,
      multipart: file.size > 16 * 1024 * 1024,
      onUploadProgress: ({ percentage }) => onProgress(Math.round(percentage)),
    });
    return { url: blob.url, kind: contentType.startsWith('audio/') ? 'audio' : 'video' };
  } catch (e) {
    const message = ((e as Error).message || '').replace(/^Vercel Blob:\s*/i, '');
    throw new Error(
      /content.?type/i.test(message)
        ? 'Choose a video or audio file.'
        : /too large|size/i.test(message)
          ? 'That file is over 100 MB. Choose a smaller one.'
          : message || 'The upload didn’t finish. Check your connection and try again.',
    );
  }
}
