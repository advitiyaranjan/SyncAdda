// Lets a <video> play a file that is on a friend's device. Its requests for /p2p/… are answered
// by the page (src/fileShare.ts), which fetches just the bytes asked for from that friend, peer
// to peer. Every other request is left alone.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  // A page loaded without this worker (a hard reload) asks to be served by it. Any other
  // message is only there to keep the worker awake while a file is streaming.
  if (event.data === 'claim') event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith('/p2p/'))
    event.respondWith(serve(event, url.pathname));
});

async function serve(event, path) {
  const own = event.clientId && (await self.clients.get(event.clientId));
  const pages = own
    ? [own]
    : await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const range = event.request.headers.get('range');
  // The page streaming this file answers with the response's status and headers.
  const answer = await new Promise((resolve) => {
    let left = pages.length;
    if (!left) resolve(null);
    for (const page of pages) {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = ({ data }) => {
        if (data) resolve({ head: data, port: port1 });
        else if (!--left) resolve(null);
      };
      page.postMessage({ type: 'p2p-range', path, range }, [port2]);
    }
    setTimeout(() => resolve(null), 10_000);
  });
  if (!answer) return new Response(null, { status: 404 });
  const { head, port } = answer;
  return new Response(
    new ReadableStream({
      // One piece per pull, so nothing piles up here once the player has buffered enough.
      pull: (controller) =>
        new Promise((resolve) => {
          port.onmessage = ({ data }) => {
            if (data) controller.enqueue(new Uint8Array(data));
            else {
              port.onmessage = null;
              controller.close();
            }
            resolve();
          };
          port.postMessage(true);
        }),
      // The player gave up on this request (a seek, say): the page stops fetching for it.
      cancel() {
        port.onmessage = null;
        port.postMessage(false);
      },
    }),
    head,
  );
}
