// A video or song played straight from each person's own device: nothing is uploaded. The room
// shares only the file's name and size (as a `local:` link), and everyone picks their own copy.
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

// The copy chosen on this device for each `local:` link, as something a <video> can play.
const chosen = new Map<string, string>();
const listeners = new Set<() => void>();

export function chooseLocal(url: string, file: File) {
  const previous = chosen.get(url);
  if (previous) URL.revokeObjectURL(previous);
  chosen.set(url, URL.createObjectURL(file));
  listeners.forEach((listener) => listener());
}
export const chosenLocal = (url: string) => chosen.get(url);
export function onLocalChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
