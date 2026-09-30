import Redis from 'ioredis';
import { isRoomMember } from '../server/redisRooms.js';
import { uploadHandler } from '../server/uploads.js';

let redis;
export default function handler(request, response) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed.' });
  redis ??= new Redis(process.env.REDIS_URL || process.env.KV_URL, { maxRetriesPerRequest: 1 });
  return uploadHandler(request, response, (code, id, token) =>
    isRoomMember(redis, code, id, token),
  );
}
