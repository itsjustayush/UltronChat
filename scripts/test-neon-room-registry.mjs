import { executeNeonRoomAction } from '../src/server/neonRoomRegistry.ts';

const roomCode = 'NE9X4P';
const hostId = 'neon-reg-host';
const guestId = 'neon-reg-guest';

async function runTest() {
  console.log('[Neon Test] Starting full room lifecycle test against Neon Serverless PostgreSQL...');

  // 1. Create Room with 6-char OTP
  const created = await executeNeonRoomAction('create', { roomCode, peerId: hostId, peerName: 'Neon Host' });
  console.log('[Neon Test] Created room:', created.room_code, 'Host:', created.host_peer_id);
  if (!created.active || created.room_code !== roomCode || created.host_peer_id !== hostId) {
    throw new Error(`Create failed: ${JSON.stringify(created)}`);
  }

  // 2. Duplicate Room Prevention (409 ROOM_EXISTS)
  try {
    await executeNeonRoomAction('create', { roomCode: 'NE-9X-4P', peerId: 'neon-dup', peerName: 'Dup' });
    throw new Error('Duplicate room creation was not rejected!');
  } catch (err) {
    if (err.status !== 409 && err.code !== 'ROOM_EXISTS') throw err;
    console.log('[Neon Test] Duplicate room creation rejected with 409 ROOM_EXISTS as expected.');
  }

  // 3. Guest Join with 6-char OTP
  const joined = await executeNeonRoomAction('join', { roomCode: 'NE-9X-4P', peerId: guestId, peerName: 'Neon Guest' });
  console.log('[Neon Test] Guest joined room. Peers count:', joined.peers?.length);
  if (!joined.active || joined.peers?.length !== 2) {
    throw new Error(`Join failed: ${JSON.stringify(joined)}`);
  }

  // 4. Poll events for host -> verify peer_joined event
  const hostEvents = await executeNeonRoomAction('poll', { roomCode, peerId: hostId });
  const joinMsg = hostEvents.messages?.find((m) => m.type === 'room_state' && m.data?.event === 'peer_joined' && m.data?.peerId === guestId);
  if (!joinMsg) {
    throw new Error(`Host did not receive peer_joined event: ${JSON.stringify(hostEvents)}`);
  }
  console.log('[Neon Test] Host received peer_joined notice.');

  // 5. Guest sends WebRTC signal / chat message
  const signalResult = await executeNeonRoomAction('signal', {
    roomCode,
    peerId: guestId,
    type: 'chat',
    data: { id: 'neon-chat-1', text: 'Hello via Neon Serverless Postgres!' },
  });
  console.log('[Neon Test] Signal delivered to targets count:', signalResult.delivered);

  // 6. Host polls signal
  const hostMessages = await executeNeonRoomAction('poll', { roomCode, peerId: hostId });
  const chatMsg = hostMessages.messages?.find((m) => m.type === 'chat' && m.peerId === guestId);
  if (!chatMsg) {
    throw new Error(`Host did not receive signal message: ${JSON.stringify(hostMessages)}`);
  }
  console.log('[Neon Test] Host received chat message:', chatMsg.data?.text);

  // 7. Heartbeat
  const hb = await executeNeonRoomAction('heartbeat', { roomCode, peerId: guestId });
  if (!hb.active) throw new Error('Heartbeat failed');
  console.log('[Neon Test] Heartbeat acknowledged.');

  // 8. Guest leaves
  const guestLeave = await executeNeonRoomAction('leave', { roomCode, peerId: guestId });
  console.log('[Neon Test] Guest left room. Remaining peers:', guestLeave.peers?.length);
  if (!guestLeave.active || guestLeave.peers?.length !== 1) {
    throw new Error('Guest leave failed');
  }

  // 9. Host leaves -> room closed
  const hostLeave = await executeNeonRoomAction('leave', { roomCode, peerId: hostId });
  console.log('[Neon Test] Host left room. Room closed:', hostLeave.roomClosed);
  if (hostLeave.roomClosed !== true) {
    throw new Error('Host leave did not close empty room');
  }

  // 10. Lookup closed room -> 404
  try {
    await executeNeonRoomAction('lookup', { roomCode });
    throw new Error('Lookup should have failed with 404');
  } catch (err) {
    if (err.status !== 404) throw err;
    console.log('[Neon Test] Lookup returned 404 for closed room as expected.');
  }

  console.log('\n[Neon Test] SUCCESS: All Neon Serverless PostgreSQL Room Registry tests passed!');
}

runTest().catch((err) => {
  console.error('[Neon Test] FAILED:', err);
  process.exit(1);
});

