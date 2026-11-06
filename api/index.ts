/**
 * Vercel Serverless Function for UltronChat Room Registry & Signaling
 * Direct native handler backed by Neon Serverless PostgreSQL.
 */

import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';

const DEFAULT_DATABASE_URL =
  'postgresql://neondb_owner:npg_OWXEgl2ae7HC@ep-wandering-voice-bbgycfts-pooler.c-15.us-east-1.aws.neon.tech/neondb?sslmode=require';

const ROOM_TTL_SECONDS = 90;
const EVENT_TTL_SECONDS = 30;
const MAX_EVENT_BYTES = 64 * 1024;
const ROOM_PATTERN = /^[A-Z0-9]{4,16}$/;
const PEER_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;
const ALLOWED_SIGNAL_TYPES = new Set([
  'offer',
  'answer',
  'candidate',
  'chat',
  'chat_ack',
  'typing',
  'reaction',
  'file_start',
  'file_chunk',
  'file_end',
]);
const ALLOWED_ACTIONS = new Set(['create', 'join', 'heartbeat', 'leave', 'poll', 'signal', 'lookup']);

function getSql() {
  const rawUrl = process.env.NEON_DATABASE_URL || process.env.DATABASE_URL;
  const dbUrl = rawUrl && !rawUrl.includes('supabase.co') ? rawUrl : DEFAULT_DATABASE_URL;
  return neon(dbUrl);
}

function hashAuthKey(key: unknown): string | null {
  if (typeof key !== 'string' || !key.trim()) return null;
  return createHash('sha256').update(key.trim()).digest('hex');
}

export function normalizeRoomCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toUpperCase().replace(/^ROOM-/, '');
  const code = raw.replace(/[^A-Z0-9]/g, '');
  return ROOM_PATTERN.test(code) ? code : null;
}

export function normalizePeerId(value: unknown): string | null {
  return typeof value === 'string' && PEER_PATTERN.test(value) ? value : null;
}

export function normalizePeerName(value: unknown): string {
  if (typeof value !== 'string') return 'Guest';
  const name = value.trim().slice(0, 32);
  return name || 'Guest';
}

function validSignalPayload(value: unknown): boolean {
  try {
    return JSON.stringify(value ?? {}).length <= MAX_EVENT_BYTES;
  } catch {
    return false;
  }
}

async function cleanupExpired(sql: ReturnType<typeof neon>) {
  const now = new Date().toISOString();
  await sql`DELETE FROM ultronchat_room_events WHERE expires_at < ${now}::timestamptz`;
  await sql`DELETE FROM ultronchat_room_peers WHERE expires_at < ${now}::timestamptz`;
  await sql`DELETE FROM ultronchat_rooms WHERE expires_at < ${now}::timestamptz`;
}

async function getRoomState(
  sql: ReturnType<typeof neon>,
  roomCode: string
) {
  const now = new Date().toISOString();
  const rooms = (await sql`
    SELECT room_code, host_peer_id, auth_hash, created_at, last_seen_at, expires_at
    FROM ultronchat_rooms
    WHERE room_code = ${roomCode} AND expires_at > ${now}::timestamptz
    LIMIT 1
  `) as Array<{
    room_code: string;
    host_peer_id: string;
    auth_hash?: string | null;
    created_at: string;
    last_seen_at: string;
    expires_at: string;
  }>;

  if (!rooms.length) return null;
  const room = rooms[0];

  const peers = (await sql`
    SELECT peer_id, peer_name, is_host, joined_at, last_seen_at, expires_at
    FROM ultronchat_room_peers
    WHERE room_code = ${roomCode} AND expires_at > ${now}::timestamptz
    ORDER BY joined_at ASC
    LIMIT 100
  `) as Array<{
    peer_id: string;
    peer_name: string;
    is_host: boolean;
    joined_at: string;
    last_seen_at: string;
    expires_at: string;
  }>;

  return {
    active: true,
    room_code: room.room_code,
    host_peer_id: room.host_peer_id,
    hasAuth: Boolean(room.auth_hash),
    auth_hash: room.auth_hash,
    created_at: room.created_at,
    last_seen_at: room.last_seen_at,
    expires_at: room.expires_at,
    peers,
  };
}

async function touchRoom(
  sql: ReturnType<typeof neon>,
  roomCode: string,
  peerId: string
): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + ROOM_TTL_SECONDS * 1000).toISOString();

  const peers = (await sql`
    SELECT peer_id, last_seen_at
    FROM ultronchat_room_peers
    WHERE room_code = ${roomCode} AND peer_id = ${peerId} AND expires_at > ${nowIso}::timestamptz
    LIMIT 1
  `) as Array<{ peer_id: string; last_seen_at: string }>;

  if (!peers.length) return false;

  await sql`
    UPDATE ultronchat_room_peers
    SET last_seen_at = ${nowIso}::timestamptz, expires_at = ${expiresIso}::timestamptz
    WHERE room_code = ${roomCode} AND peer_id = ${peerId}
  `;

  await sql`
    UPDATE ultronchat_rooms
    SET last_seen_at = ${nowIso}::timestamptz, expires_at = ${expiresIso}::timestamptz
    WHERE room_code = ${roomCode}
  `;

  return true;
}

export async function executeNeonRoomAction(
  action: string,
  body: Record<string, any> = {}
) {
  const sql = getSql();

  switch (action) {
    case 'create': {
      const roomCode = normalizeRoomCode(body.roomCode);
      const peerId = normalizePeerId(body.peerId);
      if (!roomCode || !peerId) {
        const err = new Error('Invalid room or peer identity') as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      const peerName = normalizePeerName(body.peerName);

      const now = new Date();
      const nowIso = now.toISOString();
      const expiresIso = new Date(now.getTime() + ROOM_TTL_SECONDS * 1000).toISOString();

      await sql`DELETE FROM ultronchat_rooms WHERE room_code = ${roomCode} AND expires_at < ${nowIso}::timestamptz`;
      await cleanupExpired(sql);

      const authHash = hashAuthKey(body.authKey || body.password);
      try {
        await sql`
          INSERT INTO ultronchat_rooms (room_code, host_peer_id, auth_hash, created_at, last_seen_at, expires_at)
          VALUES (${roomCode}, ${peerId}, ${authHash}, ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${expiresIso}::timestamptz)
        `;
      } catch (err: any) {
        if (err.code === '23505') {
          const conflictErr = new Error('Room code is already active') as Error & { status?: number; code?: string };
          conflictErr.status = 409;
          conflictErr.code = 'ROOM_EXISTS';
          throw conflictErr;
        }
        throw err;
      }

      await sql`
        INSERT INTO ultronchat_room_peers (room_code, peer_id, peer_name, is_host, joined_at, last_seen_at, expires_at)
        VALUES (${roomCode}, ${peerId}, ${peerName}, true, ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${expiresIso}::timestamptz)
      `;

      const state = await getRoomState(sql, roomCode);
      return { active: true, created: true, ...(state || {}) };
    }

    case 'join': {
      const roomCode = normalizeRoomCode(body.roomCode);
      const peerId = normalizePeerId(body.peerId);
      if (!roomCode || !peerId) {
        const err = new Error('Invalid room or peer identity') as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      const peerName = normalizePeerName(body.peerName);
      await cleanupExpired(sql);

      const room = await getRoomState(sql, roomCode);
      if (!room) {
        const notFoundErr = new Error('Room not found or expired') as Error & { status?: number };
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      if (room.auth_hash) {
        const candidateHash = hashAuthKey(body.authKey || body.password);
        if (!candidateHash || candidateHash !== room.auth_hash) {
          const authErr = new Error('Room requires valid authorization key') as Error & { status?: number; code?: string };
          authErr.status = 403;
          authErr.code = 'INVALID_ROOM_AUTH';
          throw authErr;
        }
      }

      if (room.peers.some((peer) => peer.peer_id === peerId)) {
        await touchRoom(sql, roomCode, peerId);
        const updated = await getRoomState(sql, roomCode);
        return { active: true, joined: true, ...(updated || {}) };
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const expiresIso = new Date(now.getTime() + ROOM_TTL_SECONDS * 1000).toISOString();

      await sql`
        INSERT INTO ultronchat_room_peers (room_code, peer_id, peer_name, is_host, joined_at, last_seen_at, expires_at)
        VALUES (${roomCode}, ${peerId}, ${peerName}, false, ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${expiresIso}::timestamptz)
      `;

      await sql`
        UPDATE ultronchat_rooms
        SET last_seen_at = ${nowIso}::timestamptz, expires_at = ${expiresIso}::timestamptz
        WHERE room_code = ${roomCode}
      `;

      if (room.peers.length > 0) {
        const eventExpiresIso = new Date(Date.now() + EVENT_TTL_SECONDS * 1000).toISOString();
        for (const peer of room.peers) {
          await sql`
            INSERT INTO ultronchat_room_events (room_code, target_peer_id, sender_peer_id, message_type, payload, expires_at)
            VALUES (${roomCode}, ${peer.peer_id}, ${peerId}, 'room_state', ${JSON.stringify({
              event: 'peer_joined',
              peerId,
              peerName,
              hostPeerId: room.host_peer_id,
              roomSize: room.peers.length + 1,
            })}::jsonb, ${eventExpiresIso}::timestamptz)
          `;
        }
      }

      const updated = await getRoomState(sql, roomCode);
      return { active: true, joined: true, ...(updated || {}) };
    }

    case 'heartbeat': {
      const roomCode = normalizeRoomCode(body.roomCode);
      const peerId = normalizePeerId(body.peerId);
      if (!roomCode || !peerId) {
        const err = new Error('Invalid room or peer identity') as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      const touched = await touchRoom(sql, roomCode, peerId);
      if (!touched) {
        const forbiddenErr = new Error('Peer is not joined to this room') as Error & { status?: number };
        forbiddenErr.status = 403;
        throw forbiddenErr;
      }
      const state = await getRoomState(sql, roomCode);
      return { active: true, ...(state || {}) };
    }

    case 'leave': {
      const roomCode = normalizeRoomCode(body.roomCode);
      const peerId = normalizePeerId(body.peerId);
      if (!roomCode || !peerId) {
        const err = new Error('Invalid room or peer identity') as Error & { status?: number };
        err.status = 400;
        throw err;
      }

      const room = await getRoomState(sql, roomCode);
      if (!room) return { active: false, left: true };

      await sql`
        DELETE FROM ultronchat_room_peers
        WHERE room_code = ${roomCode} AND peer_id = ${peerId}
      `;

      const remaining = room.peers.filter((p) => p.peer_id !== peerId);
      if (!remaining.length) {
        await sql`DELETE FROM ultronchat_room_events WHERE room_code = ${roomCode}`;
        await sql`DELETE FROM ultronchat_rooms WHERE room_code = ${roomCode}`;
        return { active: false, left: true, roomClosed: true };
      }

      let hostPeerId = room.host_peer_id;
      if (hostPeerId === peerId) {
        hostPeerId = remaining[0].peer_id;
        await sql`UPDATE ultronchat_rooms SET host_peer_id = ${hostPeerId} WHERE room_code = ${roomCode}`;
        await sql`UPDATE ultronchat_room_peers SET is_host = false WHERE room_code = ${roomCode}`;
        await sql`UPDATE ultronchat_room_peers SET is_host = true WHERE room_code = ${roomCode} AND peer_id = ${hostPeerId}`;
      }

      const eventExpiresIso = new Date(Date.now() + EVENT_TTL_SECONDS * 1000).toISOString();
      for (const peer of remaining) {
        await sql`
          INSERT INTO ultronchat_room_events (room_code, target_peer_id, sender_peer_id, message_type, payload, expires_at)
          VALUES (${roomCode}, ${peer.peer_id}, ${peerId}, 'room_state', ${JSON.stringify({
            event: 'peer_left',
            peerId,
            hostPeerId,
            roomSize: remaining.length,
          })}::jsonb, ${eventExpiresIso}::timestamptz)
        `;
      }

      const state = await getRoomState(sql, roomCode);
      return { active: true, left: true, ...(state || {}) };
    }

    case 'poll': {
      const roomCode = normalizeRoomCode(body.roomCode);
      const peerId = normalizePeerId(body.peerId);
      if (!roomCode || !peerId) {
        const err = new Error('Invalid room or peer identity') as Error & { status?: number };
        err.status = 400;
        throw err;
      }

      const sinceId = Number.isSafeInteger(Number(body.sinceId)) ? Number(body.sinceId) : 0;
      await touchRoom(sql, roomCode, peerId);
      const now = new Date().toISOString();

      const events = (await sql`
        SELECT id, sender_peer_id, message_type, payload, created_at
        FROM ultronchat_room_events
        WHERE room_code = ${roomCode}
          AND target_peer_id = ${peerId}
          AND id > ${sinceId}
          AND expires_at > ${now}::timestamptz
        ORDER BY id ASC
        LIMIT 50
      `) as Array<{
        id: number | string;
        sender_peer_id: string;
        message_type: string;
        payload: any;
        created_at: string;
      }>;

      // Consume events so they cannot be delivered again
      if (events.length > 0) {
        const eventIds = events.map((e) => Number(e.id));
        await sql`
          DELETE FROM ultronchat_room_events
          WHERE id = ANY(${eventIds})
        `;
      }

      return {
        messages: events.map((e) => ({
          id: Number(e.id),
          type: e.message_type,
          peerId: e.sender_peer_id,
          data: e.payload,
          timestamp: new Date(e.created_at).getTime(),
        })),
      };
    }

    case 'signal': {
      const roomCode = normalizeRoomCode(body.roomCode);
      const peerId = normalizePeerId(body.peerId);
      const type = typeof body.type === 'string' ? body.type : '';
      if (!roomCode || !peerId || !ALLOWED_SIGNAL_TYPES.has(type) || !validSignalPayload(body.data)) {
        const err = new Error('Invalid signaling payload') as Error & { status?: number };
        err.status = 400;
        throw err;
      }

      const room = await getRoomState(sql, roomCode);
      if (!room || !room.peers.some((p) => p.peer_id === peerId)) {
        const forbiddenErr = new Error('Peer is not joined to this room') as Error & { status?: number };
        forbiddenErr.status = 403;
        throw forbiddenErr;
      }

      const targetPeerId = normalizePeerId(body.targetPeerId);
      const targets = targetPeerId
        ? room.peers.filter((p) => p.peer_id === targetPeerId)
        : room.peers.filter((p) => p.peer_id !== peerId);

      const eventExpiresIso = new Date(Date.now() + EVENT_TTL_SECONDS * 1000).toISOString();
      for (const target of targets) {
        await sql`
          INSERT INTO ultronchat_room_events (room_code, target_peer_id, sender_peer_id, message_type, payload, expires_at)
          VALUES (${roomCode}, ${target.peer_id}, ${peerId}, ${type}, ${JSON.stringify(body.data || {})}::jsonb, ${eventExpiresIso}::timestamptz)
        `;
      }

      return { ok: true, deliveredTo: targets.length };
    }

    case 'lookup': {
      const roomCode = normalizeRoomCode(body.roomCode);
      if (!roomCode) {
        const err = new Error('Invalid room code') as Error & { status?: number };
        err.status = 400;
        throw err;
      }
      const room = await getRoomState(sql, roomCode);
      if (!room) {
        const notFoundErr = new Error('Room not found or expired') as Error & { status?: number };
        notFoundErr.status = 404;
        throw notFoundErr;
      }
      return room;
    }

    default: {
      const err = new Error(`Unsupported registry action: ${action}`) as Error & { status?: number };
      err.status = 400;
      throw err;
    }
  }
}

function sendResponse(res: any, status: number, data: any) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, User-Agent');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');

  if (typeof res.status === 'function') {
    res.status(status);
  } else {
    res.statusCode = status;
  }

  const jsonStr = JSON.stringify(data);
  if (typeof res.json === 'function' && typeof res.status === 'function') {
    res.json(data);
  } else {
    res.end(jsonStr);
  }
}

/**
 * Universal Request Handler for Vercel Serverless Function & Node.js HTTP
 */
export default async function handler(req: any, res: any) {
  // CORS Preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, User-Agent');
    if (typeof res.status === 'function') {
      res.status(200).end();
    } else {
      res.statusCode = 200;
      res.end();
    }
    return;
  }

  const url = req.url || '';

  // 1. Health check: /health or /api/health
  if (req.method === 'GET' && (url.endsWith('/health') || url.includes('/api/health'))) {
    sendResponse(res, 200, {
      status: 'ok',
      service: 'ultronchat-api',
      database: 'neon-postgres',
      timestamp: Date.now(),
    });
    return;
  }

  // 2. Room lookup: /api/signal/rooms/:roomId or /signal/rooms/:roomId
  const roomsMatch = url.match(/\/rooms\/([A-Za-z0-9_-]+)/);
  if (req.method === 'GET' && roomsMatch) {
    const rawId = roomsMatch[1];
    const roomCode = normalizeRoomCode(rawId);
    if (!roomCode) {
      sendResponse(res, 400, { active: false, error: 'Invalid room code' });
      return;
    }
    try {
      const room: any = await executeNeonRoomAction('lookup', { roomCode });
      sendResponse(res, 200, {
        active: true,
        roomId: room.room_code,
        hostPeerId: room.host_peer_id,
        peers: (room.peers || []).map((p: any) => p.peer_id),
        peerCount: room.peers?.length || 0,
        hasAuth: room.hasAuth || false,
      });
    } catch (err: any) {
      sendResponse(res, err?.status || 503, { active: false, error: err?.message || 'Room registry unavailable' });
    }
    return;
  }

  // 3. Room registry operations: POST /api/signal/registry or /signal/registry
  if (req.method === 'POST') {
    // Read request body safely if not parsed
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    } else if (!body) {
      body = await new Promise((resolve) => {
        let text = '';
        req.on('data', (chunk: any) => {
          text += chunk;
        });
        req.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve({});
          }
        });
        req.on('error', () => resolve({}));
      });
    }

    body = body || {};
    const action = typeof body.action === 'string' ? body.action : '';
    const roomCode = normalizeRoomCode(body.roomCode || body.roomId);
    const peerId = body.peerId;

    if (!ALLOWED_ACTIONS.has(action) || !roomCode || (peerId !== undefined && !PEER_PATTERN.test(peerId))) {
      sendResponse(res, 400, { error: 'Invalid room registry request' });
      return;
    }

    try {
      const result = await executeNeonRoomAction(action, {
        ...body,
        roomCode,
        peerId,
      });
      sendResponse(res, 200, result);
    } catch (err: any) {
      sendResponse(res, err?.status || 503, {
        error: err?.message || 'Room registry unavailable',
        code: err?.code,
      });
    }
    return;
  }

  // Fallback 404
  sendResponse(res, 404, { error: 'Not found' });
}
