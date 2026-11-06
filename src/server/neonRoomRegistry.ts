/**
 * Neon Serverless PostgreSQL Room Registry for UltronChat
 * Exact clone replica alternative to Supabase Edge Function + PostgreSQL.
 * Manages transient room lifecycle, 6-character OTP codes, peer presence, and WebRTC signaling events.
 */

import { neon } from '@neondatabase/serverless';

const DEFAULT_DATABASE_URL =
  'postgresql://neondb_owner:npg_OWXEgl2ae7HC@ep-wandering-voice-bbgycfts-pooler.c-15.us-east-1.aws.neon.tech/neondb?sslmode=require';

const ROOM_TTL_SECONDS = 90;
const EVENT_TTL_SECONDS = 30;
const MAX_EVENT_BYTES = 64 * 1024;
const ROOM_PATTERN = /^[A-Z0-9]{6}$/;
const PEER_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;
const ALLOWED_SIGNAL_TYPES = new Set([
  'offer',
  'answer',
  'candidate',
  'chat',
  'chat_ack',
  'typing',
  'reaction',
]);

function getSql() {
  const dbUrl =
    process.env.DATABASE_URL ||
    process.env.NEON_DATABASE_URL ||
    DEFAULT_DATABASE_URL;
  return neon(dbUrl);
}

export interface RegistryPeer {
  peer_id: string;
  peer_name: string;
  is_host: boolean;
  joined_at: string;
  last_seen_at: string;
  expires_at: string;
}

export interface RegistryRoomState {
  active: boolean;
  created?: boolean;
  joined?: boolean;
  left?: boolean;
  roomClosed?: boolean;
  room_code?: string;
  host_peer_id?: string;
  created_at?: string;
  last_seen_at?: string;
  expires_at?: string;
  peers?: RegistryPeer[];
  messages?: Array<{
    type: string;
    peerId: string;
    data: unknown;
    timestamp: number;
  }>;
  error?: string;
  code?: string;
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
): Promise<(RegistryRoomState & { peers: RegistryPeer[] }) | null> {
  const now = new Date().toISOString();
  const rooms = (await sql`
    SELECT room_code, host_peer_id, created_at, last_seen_at, expires_at
    FROM ultronchat_rooms
    WHERE room_code = ${roomCode} AND expires_at > ${now}::timestamptz
    LIMIT 1
  `) as Array<{
    room_code: string;
    host_peer_id: string;
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
  `) as RegistryPeer[];

  return {
    active: true,
    room_code: room.room_code,
    host_peer_id: room.host_peer_id,
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
  const expiresIso = new Date(
    now.getTime() + ROOM_TTL_SECONDS * 1000
  ).toISOString();

  const peers = (await sql`
    SELECT peer_id, last_seen_at
    FROM ultronchat_room_peers
    WHERE room_code = ${roomCode} AND peer_id = ${peerId} AND expires_at > ${nowIso}::timestamptz
    LIMIT 1
  `) as Array<{ peer_id: string; last_seen_at: string }>;

  if (!peers.length) return false;

  const lastSeen = peers[0].last_seen_at
    ? new Date(peers[0].last_seen_at).getTime()
    : 0;
  // Throttle updates to at most once per 15s to eliminate write amplification during 800ms client polling
  if (now.getTime() - lastSeen < 15000) {
    return true;
  }

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
  body: Record<string, unknown>
): Promise<RegistryRoomState> {
  const sql = getSql();

  switch (action) {
    case 'create': {
      const roomCode = normalizeRoomCode(body.roomCode);
      const peerId = normalizePeerId(body.peerId);
      if (!roomCode || !peerId) {
        const err = new Error('Invalid room or peer identity') as Error & {
          status?: number;
        };
        err.status = 400;
        throw err;
      }
      const peerName = normalizePeerName(body.peerName);
      const now = new Date();
      const nowIso = now.toISOString();
      const expiresIso = new Date(
        now.getTime() + ROOM_TTL_SECONDS * 1000
      ).toISOString();

      // Prune expired rooms with this code to prevent 409 zombie collision
      await sql`DELETE FROM ultronchat_rooms WHERE room_code = ${roomCode} AND expires_at < ${nowIso}::timestamptz`;
      await cleanupExpired(sql);

      try {
        await sql`
          INSERT INTO ultronchat_rooms (room_code, host_peer_id, created_at, last_seen_at, expires_at)
          VALUES (${roomCode}, ${peerId}, ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${expiresIso}::timestamptz)
        `;
      } catch (err: any) {
        if (err.code === '23505') {
          const conflictErr = new Error('Room code is already active') as Error & {
            status?: number;
            code?: string;
          };
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
        const err = new Error('Invalid room or peer identity') as Error & {
          status?: number;
        };
        err.status = 400;
        throw err;
      }
      const peerName = normalizePeerName(body.peerName);
      await cleanupExpired(sql);

      const room = await getRoomState(sql, roomCode);
      if (!room) {
        const notFoundErr = new Error('Room not found or expired') as Error & {
          status?: number;
        };
        notFoundErr.status = 404;
        throw notFoundErr;
      }

      if (room.peers.some((peer) => peer.peer_id === peerId)) {
        await touchRoom(sql, roomCode, peerId);
        const updated = await getRoomState(sql, roomCode);
        return { active: true, joined: true, ...(updated || {}) };
      }

      const now = new Date();
      const nowIso = now.toISOString();
      const expiresIso = new Date(
        now.getTime() + ROOM_TTL_SECONDS * 1000
      ).toISOString();

      await sql`
        INSERT INTO ultronchat_room_peers (room_code, peer_id, peer_name, is_host, joined_at, last_seen_at, expires_at)
        VALUES (${roomCode}, ${peerId}, ${peerName}, false, ${nowIso}::timestamptz, ${nowIso}::timestamptz, ${expiresIso}::timestamptz)
      `;

      await sql`
        UPDATE ultronchat_rooms
        SET last_seen_at = ${nowIso}::timestamptz, expires_at = ${expiresIso}::timestamptz
        WHERE room_code = ${roomCode}
      `;

      // Broadcast join event to existing room peers
      if (room.peers.length > 0) {
        const eventExpiresIso = new Date(
          Date.now() + EVENT_TTL_SECONDS * 1000
        ).toISOString();
        for (const peer of room.peers) {
          await sql`
            INSERT INTO ultronchat_room_events (room_code, target_peer_id, sender_peer_id, message_type, payload, expires_at)
            VALUES (${roomCode}, ${peer.peer_id}, ${peerId}, 'room_state', ${JSON.stringify(
            {
              event: 'peer_joined',
              peerId,
              peerName,
              hostPeerId: room.host_peer_id,
              roomSize: room.peers.length + 1,
            }
          )}::jsonb, ${eventExpiresIso}::timestamptz)
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
        const err = new Error('Invalid room or peer identity') as Error & {
          status?: number;
        };
        err.status = 400;
        throw err;
      }
      const touched = await touchRoom(sql, roomCode, peerId);
      if (!touched) {
        const forbiddenErr = new Error(
          'Peer is not joined to this room'
        ) as Error & { status?: number };
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
        const err = new Error('Invalid room or peer identity') as Error & {
          status?: number;
        };
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

      const eventExpiresIso = new Date(
        Date.now() + EVENT_TTL_SECONDS * 1000
      ).toISOString();
      for (const peer of remaining) {
        await sql`
          INSERT INTO ultronchat_room_events (room_code, target_peer_id, sender_peer_id, message_type, payload, expires_at)
          VALUES (${roomCode}, ${peer.peer_id}, ${peerId}, 'room_state', ${JSON.stringify(
          {
            event: 'peer_left',
            peerId,
            hostPeerId,
            roomSize: remaining.length,
          }
        )}::jsonb, ${eventExpiresIso}::timestamptz)
        `;
        if (hostPeerId !== room.host_peer_id) {
          await sql`
            INSERT INTO ultronchat_room_events (room_code, target_peer_id, sender_peer_id, message_type, payload, expires_at)
            VALUES (${roomCode}, ${peer.peer_id}, ${peerId}, 'room_state', ${JSON.stringify(
            {
              event: 'host_changed',
              hostPeerId,
              roomSize: remaining.length,
            }
          )}::jsonb, ${eventExpiresIso}::timestamptz)
          `;
        }
      }

      const state = await getRoomState(sql, roomCode);
      return { active: true, left: true, ...(state || {}) };
    }

    case 'poll': {
      const roomCode = normalizeRoomCode(body.roomCode);
      const peerId = normalizePeerId(body.peerId);
      if (!roomCode || !peerId) {
        const err = new Error('Invalid room or peer identity') as Error & {
          status?: number;
        };
        err.status = 400;
        throw err;
      }

      const touched = await touchRoom(sql, roomCode, peerId);
      if (!touched) {
        const forbiddenErr = new Error(
          'Peer is not joined to this room'
        ) as Error & { status?: number };
        forbiddenErr.status = 403;
        throw forbiddenErr;
      }

      const nowIso = new Date().toISOString();
      const events = (await sql`
        SELECT id, sender_peer_id, message_type, payload, created_at
        FROM ultronchat_room_events
        WHERE room_code = ${roomCode} AND target_peer_id = ${peerId} AND expires_at > ${nowIso}::timestamptz
        ORDER BY id ASC
        LIMIT 100
      `) as Array<{
        id: string;
        sender_peer_id: string;
        message_type: string;
        payload: unknown;
        created_at: string;
      }>;

      if (events.length > 0) {
        const ids = events.map((e) => e.id);
        await sql`DELETE FROM ultronchat_room_events WHERE id = ANY(${ids})`;
      }

      return {
        active: true,
        messages: events.map((e) => ({
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
      if (
        !roomCode ||
        !peerId ||
        !ALLOWED_SIGNAL_TYPES.has(type) ||
        !validSignalPayload(body.data)
      ) {
        const err = new Error('Invalid signaling payload') as Error & {
          status?: number;
        };
        err.status = 400;
        throw err;
      }

      const room = await getRoomState(sql, roomCode);
      if (!room || !room.peers.some((p) => p.peer_id === peerId)) {
        const forbiddenErr = new Error(
          'Peer is not joined to this room'
        ) as Error & { status?: number };
        forbiddenErr.status = 403;
        throw forbiddenErr;
      }

      const targetPeerId = normalizePeerId(body.targetPeerId);
      const targets = targetPeerId
        ? room.peers.filter((p) => p.peer_id === targetPeerId)
        : room.peers.filter((p) => p.peer_id !== peerId);

      const eventExpiresIso = new Date(
        Date.now() + EVENT_TTL_SECONDS * 1000
      ).toISOString();

      for (const target of targets) {
        await sql`
          INSERT INTO ultronchat_room_events (room_code, target_peer_id, sender_peer_id, message_type, payload, expires_at)
          VALUES (${roomCode}, ${target.peer_id}, ${peerId}, ${type}, ${JSON.stringify(
          body.data ?? {}
        )}::jsonb, ${eventExpiresIso}::timestamptz)
        `;
      }

      return { active: true, ok: true, delivered: targets.length } as any;
    }

    case 'lookup': {
      const roomCode = normalizeRoomCode(body.roomCode);
      if (!roomCode) {
        const err = new Error('Invalid room code') as Error & {
          status?: number;
        };
        err.status = 400;
        throw err;
      }
      await cleanupExpired(sql);
      const room = await getRoomState(sql, roomCode);
      if (!room) {
        const notFoundErr = new Error('Room not found or expired') as Error & {
          status?: number;
        };
        notFoundErr.status = 404;
        throw notFoundErr;
      }
      return { active: true, ...room };
    }

    default: {
      const err = new Error('Unknown action') as Error & { status?: number };
      err.status = 400;
      throw err;
    }
  }
}

