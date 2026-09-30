# SyncAdda

A private place to watch, listen, and spend time together. No accounts. Create a room, share its six-character code or invitation link, and choose something to play.

## Run locally

Requires Node.js 22.9+ and npm.

```sh
npm install
npm run dev
```

Open **http://localhost:5173**. Vite serves the frontend and proxies Socket.IO and `/api` to the Node server on port 3001. Open the invitation in another browser or a separate tab to join as a friend. Names and private session credentials stay in that tab's session storage.

## What's included

- Responsive landing page, account-free create/join forms, and a dark watch room.
- Private room codes and invitation links, copy/share actions, up to eight participants.
- Server-authoritative play, pause, seek, and speed, clock-offset estimation, periodic drift correction, and late-join synchronization.
- Direct video/audio files and HLS live streams. Queue management and automatic advancement by the active host.
- Real-time chat, room notifications, shared emoji reactions, and participant presence.
- WebRTC voice/video with independent microphone, camera, and call audio controls; live speaking indicators; leave/rejoin calls without leaving the room.
- Enforced host permissions, optional shared controls, host transfer, participant removal, room locking, and room closure.
- Automatic socket reconnect, 90-second session recovery, media/chat restoration, and delayed host succession.
- Dedicated mobile Watch, Chat, People, and Call views.

## Media

Paste a **direct, publicly accessible** media URL, such as `.mp4`, `.webm`, `.mp3`, or `.m3u8`. Browser codec support still applies. For reliable seeking, file servers must support byte-range requests. HLS sources must allow cross-origin requests. Use HTTPS media on an HTTPS deployment.

The included sample chooser offers **Sintel**, **Big Buck Bunny**, and **Tears of Steel**, open movies by the Blender Foundation, streamed from Google's public sample library. YouTube links play through YouTube's embedded player (videos that disallow embedding won't play). DRM-protected sources and subscription streaming services are not supported.

**From your device:** a video or song up to 100 MB can be uploaded once to Vercel Blob (straight from the browser, never through the app server) and streamed to everyone in the room. Uploads are deleted when removed from the queue or when the room closes, and a daily cron (`/api/cleanup-uploads`) removes anything older than 24 hours left by rooms that expired. Uploads need `BLOB_READ_WRITE_TOKEN`, which Vercel provides when a Blob store is connected to the project.

Each device streams its own copy directly from the source. The server shares the playback clock, not the media bytes. Buffering, autoplay rules, device performance, and network conditions can cause temporary differences; a browser may ask the user to tap once to start playback. Live streams synchronize within their available seek window.

## Production

```sh
npm run build
npm start
```

The Node server serves `dist/`, invitation routes, `/api`, and Socket.IO on **port 3001** (or `PORT`). Deploy this as a persistent Node service, not a static-only website. A sample Dockerfile is included.

Copy `.env.example` to `.env` to configure the service:

- `PORT`: HTTP port; defaults to 3001.
- `APP_ORIGIN`: exact public origin, e.g. `https://watch.example.com`, for WebSocket origin validation behind a reverse proxy.
- `ICE_SERVERS_JSON`: WebRTC ICE server configuration; defaults to a public STUN server. Configure a **TURN relay** for calls across restrictive mobile, enterprise, and NAT networks. Use short-lived TURN credentials in a production deployment; the ICE configuration is necessarily sent to participating browsers.

Put the server behind **HTTPS** with WebSocket support. Microphone/camera access works on localhost, but remote devices require HTTPS. A localhost invitation only works on the same computer; use the deployed origin to invite friends elsewhere. Development network HTTP can test watching/chat, but generally cannot access cameras or microphones.

### Vercel

The Vite site is configured in `vercel.json`. Its `/api/socket` Function handles WebSocket connections, `/api/ice` provides call relay configuration, and `/room/:code` opens the invitation route. Vercel WebSocket functions can run in separate instances and close at their maximum duration, so the deployed room server uses Redis for shared state and cross-instance broadcasts. Connect a Redis database to the Vercel project so it provides `KV_URL` or `REDIS_URL`. The project is configured for the Mumbai region, and WebSocket clients reconnect and restore their room session automatically.

The local `npm run dev` server continues to use in-memory state for quick development and tests. If you run a persistent Node server in production, the original single-process behavior still applies.

Local rooms and chat are **in memory** and disappear on server restart. Vercel rooms use Redis with a six-hour expiry after the last room change; the room remains available across Function restarts during that period. A room is never closed while anyone is in it: it closes when the host ends it, or once everyone has left. If something is still playing when the last person goes (say, everyone's phone locked and their connections dropped), the room is kept for up to six more hours, and whoever comes back first becomes the host. Chat is kept for the life of the room (up to 5,000 messages), and people who join later receive the whole history. Disconnected guests have a 90-second reconnect window. Vercel closes WebSockets after about five minutes; clients reconnect automatically and calls carry on, since call audio and video flow peer-to-peer. Someone who stays offline for 15 seconds is taken out of the call. The host stays the host through disconnects and reconnects; hosting passes to someone else only when the host leaves the room or doesn't return within the reconnect window (or hands it over with **Make host**). Only the host controls playback and the queue order. From the People panel, the host can let individual people add to the queue, or give everyone the remote in room settings. Calls use a small peer mesh and are capped at eight people. A removed anonymous user can create a new session; use the room lock if stronger invitation control is needed.

Text is rendered as text, session tokens are excluded from all public room snapshots, privileged events are authorized on the server, signaling is scoped to room/call membership, inputs are bounded and validated, and socket actions are rate limited. Rooms have no public directory.

## Verification

```sh
npm test                     # Server integration tests with independent Socket.IO clients
npx playwright install chromium
npm run test:e2e             # Desktop/mobile Chromium flows with simulated call devices
npm run check               # Type check, production build, server and browser tests
```

The browser tests use a local CC0 media fixture and byte-range responses, so playback tests don't depend on third-party streaming availability. They cover desktop/mobile rendering, room entry, two-browser chat/play/pause/seek/speed, host permissions, session restoration, simulated two-way video/audio, independent call controls, and validation. Screenshots and failure traces are written to `test-results/`.

A few tests need more than the local dev server and are skipped otherwise:

```sh
# Reconnects: the production room logic (Redis) with network-like latency, and a route that
# drops every connection the way hosting does (optionally while the room is still busy).
npm run build && node tests/support/prod-like-server.js
SYNCADDA_URL=http://localhost:3001 SYNCADDA_DROP_URL=http://localhost:3001/api/test/drop-all \
  npx playwright test tests/browser/call.spec.ts tests/browser/room.spec.ts

# Against the deployment, including a ~6 minute wait for Vercel to recycle a real connection
# (the owner, queue access, and the call must all survive it).
SYNCADDA_URL=https://adda.advitiyaranjan.in SYNCADDA_LIVE_RECONNECT=1 \
  npx playwright test tests/browser/call.spec.ts tests/browser/room.spec.ts
```

Uploads (`upload.spec.ts`) run when the server has `BLOB_READ_WRITE_TOKEN`, and YouTube playback (`youtube.spec.ts`) needs access to youtube.com.

Real iOS/Android hardware, public-network TURN connectivity, and long-session synchronization should be validated in the intended hosting environment before a public launch.

## Project map

```text
src/App.tsx             Session lifecycle, entry and invitation dialogs
src/Landing.tsx         Home page
src/WatchRoom.tsx       Room, chat, queue, participants, host controls
src/Player.tsx          Shared media player and clock correction
src/useCall.ts          WebRTC signaling, tracks, and call lifecycle
src/PersonTile.tsx      Participant video/audio and speaking indicator
server/rooms.js         Room state, validation, authorization, socket events
server/redisRooms.js    Shared Redis room state for Vercel functions
server/index.js         HTTP, Socket.IO, production asset server
api/                    Vercel WebSocket, ICE, upload, and upload-cleanup functions
server/uploads.js       Local file uploads to Vercel Blob and their cleanup
tests/                 Server and browser regression coverage
```

## Asset credits

Landing photographs: [mountains](https://images.unsplash.com/photo-1464822759023-fed622ff2c3b), [music](https://images.unsplash.com/photo-1470225620780-dba8ba36b745), [projector](https://images.unsplash.com/photo-1478720568477-152d9b164e26), and [landscape](https://images.unsplash.com/photo-1500534623283-312aade485b7), served from Unsplash's image CDN and stored locally. Fonts: DM Sans and Manrope from Google Fonts. Icons: Lucide. Sample films: [Blender Studio open movies](https://studio.blender.org/films/). The test-only flower clip is the [MDN CC0 video fixture](https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4).

Implementation references: [Socket.IO documentation](https://socket.io/docs/v4/), [MDN WebRTC perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation), and [HLS.js](https://github.com/video-dev/hls.js).
