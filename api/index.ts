import express from 'express';
import { executeNeonRoomAction, normalizeRoomCode } from '../src/server/neonRoomRegistry';

const app = express();
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;
const MAX_REGISTRY_BYTES = 64 * 1024;
const ALLOWED_ACTIONS = new Set(['create', 'join', 'heartbeat', 'leave', 'poll', 'signal', 'lookup']);

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'self' ws: wss: https:; form-action 'self'"
  );
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  next();
});
app.use(express.json({ limit: '128kb' }));

async function callRegistry(action: string, payload: Record<string, unknown>) {
  const body = JSON.stringify({ action, ...payload });
  if (body.length > MAX_REGISTRY_BYTES) {
    const error = new Error('Room registry payload is too large') as Error & { status?: number; code?: string };
    error.status = 413;
    throw error;
  }

  // Execute directly against Neon Serverless PostgreSQL
  return await executeNeonRoomAction(action, payload);
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ultronchat-api', database: 'neon-postgres', timestamp: Date.now() });
});

app.get('/api/signal/rooms/:roomId', async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomId);
  if (!roomCode) {
    res.status(400).json({ active: false, error: 'Invalid room code' });
    return;
  }
  try {
    const registryRoom = await callRegistry('lookup', { roomCode });
    res.json({
      active: true,
      roomId: registryRoom.room_code,
      hostPeerId: registryRoom.host_peer_id,
      peers: (registryRoom.peers || []).map((peer: { peer_id: string }) => peer.peer_id),
      peerCount: registryRoom.peers?.length || 0,
    });
  } catch (error: any) {
    res.status(error?.status === 404 ? 404 : 503).json({ active: false, error: error?.message || 'Room registry unavailable' });
  }
});

app.post('/api/signal/registry', async (req, res) => {
  const body = req.body || {};
  const action = typeof body.action === 'string' ? body.action : '';
  const roomCode = normalizeRoomCode(body.roomCode || body.roomId);
  const peerId = body.peerId;

  if (!ALLOWED_ACTIONS.has(action) || !roomCode || (peerId !== undefined && !PEER_ID_PATTERN.test(peerId))) {
    res.status(400).json({ error: 'Invalid room registry request' });
    return;
  }

  try {
    const result = await callRegistry(action, {
      ...body,
      roomCode,
      peerId,
    });
    res.json(result);
  } catch (error: any) {
    res.status(error?.status || 503).json({ error: error?.message || 'Room registry unavailable', code: error?.code });
  }
});

export default app;
