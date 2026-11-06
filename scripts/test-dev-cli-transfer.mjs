import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { executeNeonRoomAction } from '../src/server/neonRoomRegistry.ts';

const ROOM_CODE = '4567';
const AUTH_KEY = 'dev-secret-99';
const HOST_ID = 'dev-host-tester';
const GUEST_ID = 'dev-guest-tester';
const BAD_GUEST_ID = 'dev-bad-tester';
const ULTRON_DIR = path.resolve('./ultron');

fs.mkdirSync(ULTRON_DIR, { recursive: true });

async function callRegistry(action, payload) {
  return await executeNeonRoomAction(action, payload);
}

async function runDevTest() {
  console.log('[Dev Test] Testing 4-digit room 4567 with auth and two-way file transfer...');

  // 1. Create room 4567 with auth key
  const created = await callRegistry('create', {
    roomCode: ROOM_CODE,
    peerId: HOST_ID,
    peerName: 'Host Developer',
    authKey: AUTH_KEY,
  });
  console.log(`[Dev Test] 1. Created room ${created.room_code} (Host: ${created.host_peer_id}, hasAuth: ${created.hasAuth})`);

  // 2. Test unauthorized guest attempt (wrong key)
  try {
    await callRegistry('join', {
      roomCode: ROOM_CODE,
      peerId: BAD_GUEST_ID,
      peerName: 'Unauthorized Guest',
      authKey: 'wrong-key',
    });
    throw new Error('Unauthorized guest was not rejected!');
  } catch (err) {
    if (err.status === 403 || err.code === 'INVALID_ROOM_AUTH') {
      console.log('[Dev Test] 2. Unauthorized join correctly rejected with 403 INVALID_ROOM_AUTH as expected.');
    } else {
      throw err;
    }
  }

  // 3. Authorized guest joins with correct key
  const joined = await callRegistry('join', {
    roomCode: ROOM_CODE,
    peerId: GUEST_ID,
    peerName: 'Guest Developer',
    authKey: AUTH_KEY,
  });
  console.log(`[Dev Test] 3. Authorized guest joined! Active peers count: ${joined.peers?.length}`);

  // 4. Host sends a file to Guest
  const hostSampleContent = 'Hello from Computer 1 Host to Computer 2 Guest! ' + crypto.randomBytes(1024).toString('hex');
  const hostHash = crypto.createHash('sha256').update(hostSampleContent).digest('hex');
  const hostToken = 'TOKHOST1';

  // Send file_start
  await callRegistry('signal', {
    roomCode: ROOM_CODE,
    peerId: HOST_ID,
    targetPeerId: GUEST_ID,
    type: 'file_start',
    data: {
      file: {
        id: 'file-host-1',
        transferToken: hostToken,
        name: 'sample_from_host.txt',
        size: Buffer.byteLength(hostSampleContent),
        totalChunks: 1,
        sha256: hostHash,
        uploaderId: HOST_ID,
      },
    },
  });

  // Send file_chunk
  await callRegistry('signal', {
    roomCode: ROOM_CODE,
    peerId: HOST_ID,
    targetPeerId: GUEST_ID,
    type: 'file_chunk',
    data: {
      transferToken: hostToken,
      fileId: 'file-host-1',
      index: 0,
      payload: Buffer.from(hostSampleContent).toString('base64'),
    },
  });

  // Send file_end
  await callRegistry('signal', {
    roomCode: ROOM_CODE,
    peerId: HOST_ID,
    targetPeerId: GUEST_ID,
    type: 'file_end',
    data: {
      transferToken: hostToken,
      fileId: 'file-host-1',
    },
  });

  // Guest polls events and receives the file
  const guestPoll = await callRegistry('poll', {
    roomCode: ROOM_CODE,
    peerId: GUEST_ID,
    sinceId: 0,
  });

  const guestMessages = guestPoll.messages || [];
  const startEvent = guestMessages.find((m) => m.type === 'file_start');
  const chunkEvent = guestMessages.find((m) => m.type === 'file_chunk');
  const endEvent = guestMessages.find((m) => m.type === 'file_end');

  if (!startEvent || !chunkEvent || !endEvent) {
    throw new Error('Guest did not receive all file transfer signaling events!');
  }

  // Reassemble on guest side into ./ultron/
  const receivedBuffer = Buffer.from(chunkEvent.data.payload, 'base64');
  const receivedHash = crypto.createHash('sha256').update(receivedBuffer).digest('hex');

  if (receivedHash !== hostHash) {
    throw new Error('Guest file hash mismatch!');
  }

  const guestSavePath = path.join(ULTRON_DIR, 'received_from_host.txt');
  fs.writeFileSync(guestSavePath, receivedBuffer);
  console.log(`[Dev Test] 4. Host -> Guest transfer verified! Saved to: ${guestSavePath}`);

  // 5. Two-Way Transfer: Guest sends a file back to Host!
  const guestSampleContent = 'Response from Computer 2 Guest back to Host! ' + crypto.randomBytes(2048).toString('hex');
  const guestHash = crypto.createHash('sha256').update(guestSampleContent).digest('hex');
  const guestToken = 'TOKGUEST';

  await callRegistry('signal', {
    roomCode: ROOM_CODE,
    peerId: GUEST_ID,
    targetPeerId: HOST_ID,
    type: 'file_start',
    data: {
      file: {
        id: 'file-guest-2',
        transferToken: guestToken,
        name: 'sample_from_guest.txt',
        size: Buffer.byteLength(guestSampleContent),
        totalChunks: 1,
        sha256: guestHash,
        uploaderId: GUEST_ID,
      },
    },
  });

  await callRegistry('signal', {
    roomCode: ROOM_CODE,
    peerId: GUEST_ID,
    targetPeerId: HOST_ID,
    type: 'file_chunk',
    data: {
      transferToken: guestToken,
      fileId: 'file-guest-2',
      index: 0,
      payload: Buffer.from(guestSampleContent).toString('base64'),
    },
  });

  await callRegistry('signal', {
    roomCode: ROOM_CODE,
    peerId: GUEST_ID,
    targetPeerId: HOST_ID,
    type: 'file_end',
    data: {
      transferToken: guestToken,
      fileId: 'file-guest-2',
    },
  });

  // Host polls events and receives the file
  const hostPoll = await callRegistry('poll', {
    roomCode: ROOM_CODE,
    peerId: HOST_ID,
    sinceId: 0,
  });

  const hostMessages = hostPoll.messages || [];
  const hostStartEvent = hostMessages.find((m) => m.type === 'file_start');
  const hostChunkEvent = hostMessages.find((m) => m.type === 'file_chunk');
  const hostEndEvent = hostMessages.find((m) => m.type === 'file_end');

  if (!hostStartEvent || !hostChunkEvent || !hostEndEvent) {
    throw new Error('Host did not receive two-way return file transfer events!');
  }

  const hostReceivedBuffer = Buffer.from(hostChunkEvent.data.payload, 'base64');
  const hostReceivedHash = crypto.createHash('sha256').update(hostReceivedBuffer).digest('hex');

  if (hostReceivedHash !== guestHash) {
    throw new Error('Host return file hash mismatch!');
  }

  const hostSavePath = path.join(ULTRON_DIR, 'received_from_guest.txt');
  fs.writeFileSync(hostSavePath, hostReceivedBuffer);
  console.log(`[Dev Test] 5. Guest -> Host two-way transfer verified! Saved to: ${hostSavePath}`);

  // 6. Clean up room
  await callRegistry('leave', { roomCode: ROOM_CODE, peerId: GUEST_ID });
  await callRegistry('leave', { roomCode: ROOM_CODE, peerId: HOST_ID });
  console.log('[Dev Test] 6. Both peers left and room safely closed.');

  console.log('\n[Dev Test] 🎉 SUCCESS: 4-digit room 4567, Auth, and Two-Way File Transfer verified!');
}

runDevTest().catch((err) => {
  console.error('[Dev Test] Failure:', err);
  process.exit(1);
});

