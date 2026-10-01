// A video or song played straight from a device: nothing is uploaded. The room shares only the
// file's name and size (as a `local:` link); the device it's on streams it to everyone else as
// they watch (see fileShare.ts), and anyone with the same file can play their own copy instead.
export const localUrl = (file: File) => `local:${encodeURIComponent(file.name)}#${file.size}`;

export function localFile(url: string): { name: string; size: number } | null {
  const match = /^local:([^#]+)#(\d+)$/.exec(url);
  if (!match) return null;
  try {
    return { name: decodeURIComponent(match[1]), size: Number(match[2]) };
  } catch {
    return null;
  }
}

// The copy chosen on this device for each `local:` link, and the same as something a <video>
// can play.
const chosen = new Map<string, { file: File; src: string }>();
const listeners = new Set<() => void>();

export function chooseLocal(url: string, file: File) {
  const previous = chosen.get(url);
  if (previous) URL.revokeObjectURL(previous.src);
  chosen.set(url, { file, src: URL.createObjectURL(file) });
  listeners.forEach((listener) => listener());
}
export const chosenLocal = (url: string) => chosen.get(url)?.src;
export const chosenFile = (url: string) => chosen.get(url)?.file;
export function onLocalChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
