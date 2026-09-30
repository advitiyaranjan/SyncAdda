// ICE servers for calls. Direct peer-to-peer connections fail on many mobile and office
// networks, so with a Cloudflare TURN key configured each caller gets short-lived relay
// credentials; ICE_SERVERS_JSON can supply a fixed list instead.
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];

export async function iceServers() {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID,
    token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (keyId && token) {
    try {
      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        },
      );
      if (!response.ok) throw new Error(`Cloudflare TURN responded ${response.status}`);
      const { iceServers } = await response.json();
      // Browsers block port 53, and trying it only slows the connection down.
      return [iceServers]
        .flat()
        .map((server) => ({
          ...server,
          urls: [server.urls].flat().filter((url) => !/:53(\?|$)/.test(url)),
        }))
        .filter((server) => server.urls.length);
    } catch (error) {
      console.error('Could not get TURN credentials; calls fall back to STUN:', error);
    }
  }
  try {
    if (process.env.ICE_SERVERS_JSON) return JSON.parse(process.env.ICE_SERVERS_JSON);
  } catch {
    console.error('Invalid ICE_SERVERS_JSON; using STUN.');
  }
  return STUN;
}
