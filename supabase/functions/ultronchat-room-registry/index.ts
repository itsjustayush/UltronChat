import { createClient } from 'jsr:@supabase/supabase-js@2';

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const ROOM_TTL_SECONDS = 90;
const EVENT_TTL_SECONDS = 30;
const MAX_EVENT_BYTES = 64 * 1024;
const ROOM_PATTERN = /^[A-Z0-9]{6}$/;
const PEER_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;
const ALLOWED_SIGNAL_TYPES = new Set([
  'offer', 'answer', 'candidate', 'chat', 'chat_ack', 'typing', 'reaction',
]);

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

function normalizeRoomCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toUpperCase().replace(/^ROOM-/, '');
  const code = raw.replace(/[^A-Z0-9]/g, '');
  return ROOM_PATTERN.test(code) ? code : null;
}

function normalizePeerId(value: unknown): string | null {
  return typeof value === 'string' && PEER_PATTERN.test(value) ? value : null;
}

function normalizePeerName(value: unknown): string {
  if (typeof value !== 'string') return 'Guest';
  // Preserve unicode names while enforcing length boundary
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

async function cleanupExpired() {
  const now = new Date().toISOString();
  await supabase.from('ultronchat_room_events').delete().lt('expires_at', now);
  await supabase.from('ultronchat_room_peers').delete().lt('expires_at', now);
  const { data: rooms } = await supabase.from('ultronchat_rooms').select('room_code').lt('expires_at', now).limit(100);
  if (rooms?.length) {
    await supabase.from('ultronchat_rooms').delete().in('room_code', rooms.map((room) => room.room_code));
  }
}

async function getRoomState(roomCode: string) {
  const { data: room, error: roomError } = await supabase
    .from('ultronchat_rooms')
    .select('room_code, host_peer_id, created_at, last_seen_at, expires_at')
    .eq('room_code', roomCode)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();
  if (roomError) throw roomError;
  if (!room) return null;

  const { data: peers, error: peerError } = await supabase
    .from('ultronchat_room_peers')
    .select('peer_id, peer_name, is_host, joined_at, last_seen_at, expires_at')
    .eq('room_code', roomCode)
    .gt('expires_at', new Date().toISOString())
    .order('joined_at', { ascending: true })
    .limit(100);
  if (peerError) throw peerError;

  return { ...room, peers: peers ?? [] };
}

async function touchRoom(roomCode: string, peerId: string) {
  const now = new Date();
  const expires = new Date(now.getTime() + ROOM_TTL_SECONDS * 1000).toISOString();

  const { data: peer, error: peerError } = await supabase
    .from('ultronchat_room_peers')
    .select('peer_id, last_seen_at')
    .eq('room_code', roomCode)
    .eq('peer_id', peerId)
    .gt('expires_at', now.toISOString())
    .maybeSingle();

  if (peerError) throw peerError;
  if (!peer) return false;

  const lastSeen = peer.last_seen_at ? new Date(peer.last_seen_at).getTime() : 0;
  // Throttle updates to at most once per 15s to eliminate write amplification during 800ms client polling
  if (now.getTime() - lastSeen < 15000) {
    return true;
  }

  await supabase
    .from('ultronchat_room_peers')
    .update({ last_seen_at: now.toISOString(), expires_at: expires })
    .eq('room_code', roomCode)
    .eq('peer_id', peerId);

  await supabase
    .from('ultronchat_rooms')
    .update({ last_seen_at: now.toISOString(), expires_at: expires })
    .eq('room_code', roomCode);

  return true;
}

async function insertEvent(roomCode: string, targetPeerId: string, senderPeerId: string, messageType: string, payload: unknown) {
  const { error } = await supabase.from('ultronchat_room_events').insert({
    room_code: roomCode,
    target_peer_id: targetPeerId,
    sender_peer_id: senderPeerId,
    message_type: messageType,
    payload: payload ?? {},
    expires_at: new Date(Date.now() + EVENT_TTL_SECONDS * 1000).toISOString(),
  });
  if (error) throw error;
}

async function createRoom(body: Record<string, unknown>) {
  const roomCode = normalizeRoomCode(body.roomCode);
  const peerId = normalizePeerId(body.peerId);
  if (!roomCode || !peerId) return json({ error: 'Invalid room or peer identity' }, 400);
  const peerName = normalizePeerName(body.peerName);

  const now = new Date();
  // Clear any expired room with this code immediately to prevent 409 zombie collision
  await supabase.from('ultronchat_rooms').delete().eq('room_code', roomCode).lt('expires_at', now.toISOString());
  await cleanupExpired();

  const expires = new Date(now.getTime() + ROOM_TTL_SECONDS * 1000).toISOString();
  const { error: roomError } = await supabase.from('ultronchat_rooms').insert({
    room_code: roomCode,
    host_peer_id: peerId,
    created_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    expires_at: expires,
  });
  if (roomError) {
    if (roomError.code === '23505') return json({ error: 'Room code is already active', code: 'ROOM_EXISTS' }, 409);
    throw roomError;
  }

  const { error: peerError } = await supabase.from('ultronchat_room_peers').insert({
    room_code: roomCode,
    peer_id: peerId,
    peer_name: peerName,
    is_host: true,
    joined_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    expires_at: expires,
  });
  if (peerError) throw peerError;
  return json({ active: true, created: true, ...(await getRoomState(roomCode)) });
}

async function joinRoom(body: Record<string, unknown>) {
  const roomCode = normalizeRoomCode(body.roomCode);
  const peerId = normalizePeerId(body.peerId);
  if (!roomCode || !peerId) return json({ error: 'Invalid room or peer identity' }, 400);
  const peerName = normalizePeerName(body.peerName);
  await cleanupExpired();

  const room = await getRoomState(roomCode);
  if (!room) return json({ active: false, error: 'Room not found or expired' }, 404);
  if (room.peers.some((peer) => peer.peer_id === peerId)) {
    await touchRoom(roomCode, peerId);
    return json({ active: true, joined: true, ...(await getRoomState(roomCode)) });
  }

  const now = new Date();
  const expires = new Date(now.getTime() + ROOM_TTL_SECONDS * 1000).toISOString();
  const { error: peerError } = await supabase.from('ultronchat_room_peers').insert({
    room_code: roomCode,
    peer_id: peerId,
    peer_name: peerName,
    is_host: false,
    joined_at: now.toISOString(),
    last_seen_at: now.toISOString(),
    expires_at: expires,
  });
  if (peerError) throw peerError;
  await supabase.from('ultronchat_rooms').update({ last_seen_at: now.toISOString(), expires_at: expires }).eq('room_code', roomCode);

  // Batch insert join notifications in 1 round-trip
  if (room.peers.length > 0) {
    const expiresAt = new Date(Date.now() + EVENT_TTL_SECONDS * 1000).toISOString();
    const rows = room.peers.map((peer) => ({
      room_code: roomCode,
      target_peer_id: peer.peer_id,
      sender_peer_id: peerId,
      message_type: 'room_state',
      payload: {
        event: 'peer_joined', peerId, peerName, hostPeerId: room.host_peer_id,
        roomSize: room.peers.length + 1,
      },
      expires_at: expiresAt,
    }));
    await supabase.from('ultronchat_room_events').insert(rows);
  }

  return json({ active: true, joined: true, ...(await getRoomState(roomCode)) });
}

async function heartbeat(body: Record<string, unknown>) {
  const roomCode = normalizeRoomCode(body.roomCode);
  const peerId = normalizePeerId(body.peerId);
  if (!roomCode || !peerId) return json({ error: 'Invalid room or peer identity' }, 400);
  const touched = await touchRoom(roomCode, peerId);
  if (!touched) return json({ active: false, error: 'Peer is not joined to this room' }, 403);
  return json({ active: true, ...(await getRoomState(roomCode)) });
}

async function leaveRoom(body: Record<string, unknown>) {
  const roomCode = normalizeRoomCode(body.roomCode);
  const peerId = normalizePeerId(body.peerId);
  if (!roomCode || !peerId) return json({ error: 'Invalid room or peer identity' }, 400);
  const room = await getRoomState(roomCode);
  if (!room) return json({ active: false, left: true });

  const leavingPeer = room.peers.find((peer) => peer.peer_id === peerId);
  if (!leavingPeer) return json({ active: true, left: true, ...room });
  await supabase.from('ultronchat_room_peers').delete().eq('room_code', roomCode).eq('peer_id', peerId);

  const remaining = room.peers.filter((peer) => peer.peer_id !== peerId);
  if (!remaining.length) {
    await supabase.from('ultronchat_room_events').delete().eq('room_code', roomCode);
    await supabase.from('ultronchat_rooms').delete().eq('room_code', roomCode);
    return json({ active: false, left: true, roomClosed: true });
  }

  let hostPeerId = room.host_peer_id;
  if (hostPeerId === peerId) {
    hostPeerId = remaining[0].peer_id;
    await supabase.from('ultronchat_rooms').update({ host_peer_id: hostPeerId }).eq('room_code', roomCode);
    await supabase.from('ultronchat_room_peers').update({ is_host: false }).eq('room_code', roomCode);
    await supabase.from('ultronchat_room_peers').update({ is_host: true }).eq('room_code', roomCode).eq('peer_id', hostPeerId);
  }

  // Batch insert leave notifications
  const expiresAt = new Date(Date.now() + EVENT_TTL_SECONDS * 1000).toISOString();
  const leaveEvents = remaining.map((peer) => ({
    room_code: roomCode,
    target_peer_id: peer.peer_id,
    sender_peer_id: peerId,
    message_type: 'room_state',
    payload: {
      event: 'peer_left', peerId, hostPeerId, roomSize: remaining.length,
    },
    expires_at: expiresAt,
  }));

  if (hostPeerId !== room.host_peer_id) {
    remaining.forEach((peer) => {
      leaveEvents.push({
        room_code: roomCode,
        target_peer_id: peer.peer_id,
        sender_peer_id: peerId,
        message_type: 'room_state',
        payload: {
          event: 'host_changed', hostPeerId, roomSize: remaining.length,
        },
        expires_at: expiresAt,
      });
    });
  }

  if (leaveEvents.length > 0) {
    await supabase.from('ultronchat_room_events').insert(leaveEvents);
  }

  return json({ active: true, left: true, ...(await getRoomState(roomCode)) });
}

async function pollEvents(body: Record<string, unknown>) {
  const roomCode = normalizeRoomCode(body.roomCode);
  const peerId = normalizePeerId(body.peerId);
  if (!roomCode || !peerId) return json({ error: 'Invalid room or peer identity' }, 400);
  const touched = await touchRoom(roomCode, peerId);
  if (!touched) return json({ active: false, error: 'Peer is not joined to this room' }, 403);

  const { data: events, error } = await supabase
    .from('ultronchat_room_events')
    .select('id, sender_peer_id, message_type, payload, created_at')
    .eq('room_code', roomCode)
    .eq('target_peer_id', peerId)
    .gt('expires_at', new Date().toISOString())
    .order('id', { ascending: true })
    .limit(100);

  if (error) throw error;
  if (events?.length) {
    await supabase.from('ultronchat_room_events').delete().in('id', events.map((event) => event.id));
  }

  return json({
    active: true,
    messages: (events ?? []).map((event) => ({
      type: event.message_type,
      peerId: event.sender_peer_id,
      data: event.payload,
      timestamp: new Date(event.created_at).getTime(),
    })),
  });
}

async function signal(body: Record<string, unknown>) {
  const roomCode = normalizeRoomCode(body.roomCode);
  const peerId = normalizePeerId(body.peerId);
  const type = typeof body.type === 'string' ? body.type : '';
  if (!roomCode || !peerId || !ALLOWED_SIGNAL_TYPES.has(type) || !validSignalPayload(body.data)) {
    return json({ error: 'Invalid signaling payload' }, 400);
  }
  const room = await getRoomState(roomCode);
  if (!room || !room.peers.some((peer) => peer.peer_id === peerId)) return json({ error: 'Peer is not joined to this room' }, 403);
  const targetPeerId = normalizePeerId(body.targetPeerId);
  const targets = targetPeerId ? room.peers.filter((peer) => peer.peer_id === targetPeerId) : room.peers.filter((peer) => peer.peer_id !== peerId);

  // Batch insert all signaling events in a single round trip
  if (targets.length > 0) {
    const expiresAt = new Date(Date.now() + EVENT_TTL_SECONDS * 1000).toISOString();
    const rows = targets.map((target) => ({
      room_code: roomCode,
      target_peer_id: target.peer_id,
      sender_peer_id: peerId,
      message_type: type,
      payload: body.data ?? {},
      expires_at: expiresAt,
    }));
    const { error } = await supabase.from('ultronchat_room_events').insert(rows);
    if (error) throw error;
  }

  return json({ ok: true, delivered: targets.length });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = body.action;
    switch (action) {
      case 'create': return await createRoom(body);
      case 'join': return await joinRoom(body);
      case 'heartbeat': return await heartbeat(body);
      case 'leave': return await leaveRoom(body);
      case 'poll': return await pollEvents(body);
      case 'signal': return await signal(body);
      case 'lookup': {
        const roomCode = normalizeRoomCode(body.roomCode);
        if (!roomCode) return json({ error: 'Invalid room code' }, 400);
        await cleanupExpired();
        const room = await getRoomState(roomCode);
        return room ? json({ active: true, ...room }) : json({ active: false, error: 'Room not found or expired' }, 404);
      }
      default: return json({ error: 'Unknown action' }, 400);
    }
  } catch (error) {
    console.error('[ultronchat-room-registry]', error);
    return json({ error: 'Room registry unavailable' }, 503);
  }
});
