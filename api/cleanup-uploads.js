import { sweepOldUploads } from '../server/uploads.js';

// Daily cron (vercel.json): deletes uploads left behind by rooms that expired without closing.
export default async function handler(request, response) {
  if (
    process.env.CRON_SECRET &&
    request.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`
  )
    return response.status(401).json({ error: 'Unauthorized.' });
  try {
    response.json({ removed: await sweepOldUploads() });
  } catch (error) {
    console.error('Upload sweep failed:', error);
    response.status(500).json({ error: 'Upload sweep failed.' });
  }
}
