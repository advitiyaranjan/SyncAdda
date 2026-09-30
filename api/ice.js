export default function handler(_request, response) {
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  try {
    if (process.env.ICE_SERVERS_JSON) iceServers = JSON.parse(process.env.ICE_SERVERS_JSON);
  } catch {
    console.error('Invalid ICE_SERVERS_JSON.');
  }
  response.setHeader('Cache-Control', 'no-store');
  response.json({ iceServers });
}
