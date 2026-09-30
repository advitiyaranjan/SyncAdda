import { iceServers } from '../server/ice.js';

export default async function handler(_request, response) {
  response.setHeader('Cache-Control', 'no-store');
  response.json({ iceServers: await iceServers() });
}
