#!/usr/bin/env node
/**
 * UltronChat Developer CLI & SDK (Node.js / JavaScript)
 * Cross-platform peer-to-peer streaming and file transfer.
 * Automatically receives and saves files to the local './ultron' directory.
 *
 * Usage:
 *   node ultron.mjs create 4567 [--key secret] [--server http://localhost:3000]
 *   node ultron.mjs join 4567 [--key secret] [--server http://localhost:3000]
 *   node ultron.mjs (interactive prompt)
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';

const DEFAULT_SERVER = process.env.ULTRON_SERVER_URL || 'http://localhost:3000';
const DEFAULT_SAVE_DIR = process.env.ULTRON_SAVE_DIR || './ultron';
const CHUNK_SIZE_BYTES = 24 * 1024; // 24 KB chunk size

export class UltronClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.roomCode = String(options.roomCode || '').trim().toUpperCase();
    this.isHost = Boolean(options.isHost);
    this.authKey = options.authKey ? String(options.authKey).trim() : null;
    this.serverUrl = (options.serverUrl || DEFAULT_SERVER).replace(/\/$/, '');
    this.saveDir = path.resolve(options.saveDir || DEFAULT_SAVE_DIR);
    this.peerId = `dev-js-${Date.now() % 100000}-${crypto.randomBytes(2).toString('hex')}`;
    this.peerName = options.peerName || `NodeDev-${this.peerId.slice(-4)}`;

    this.running = false;
    this.connected = false;
    this.peers = [];
    this.lastEventId = 0;
    this.incomingTransfers = new Map(); // token -> transfer object

    // Ensure save directory exists
    fs.mkdirSync(this.saveDir, { recursive: true });
  }

  async _callRegistry(action, payload = {}) {
    const url = `${this.serverUrl}/api/signal/registry`;
    const body = JSON.stringify({ action, ...payload });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Ultron-Node-Client/1.0',
      },
      body,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data;
  }

  async connect() {
    const action = this.isHost ? 'create' : 'join';
    const payload = {
      roomCode: this.roomCode,
      peerId: this.peerId,
      peerName: this.peerName,
    };
    if (this.authKey) {
      payload.authKey = this.authKey;
    }

    const res = await this._callRegistry(action, payload);
    this.connected = true;
    this.running = true;

    if (Array.isArray(res.peers)) {
      this.peers = res.peers
        .map((p) => p.peer_id)
        .filter((id) => id !== this.peerId);
    }

    this._startHeartbeat();
    this._startPolling();
    this.emit('connected', res);
    return res;
  }

  _startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        await this._callRegistry('heartbeat', {
          roomCode: this.roomCode,
          peerId: this.peerId,
        });
      } catch (err) {
        // Heartbeat error silently ignored until reconnect
      }
    }, 15000);
  }

  async _startPolling() {
    while (this.running) {
      try {
        const res = await this._callRegistry('poll', {
          roomCode: this.roomCode,
          peerId: this.peerId,
          sinceId: this.lastEventId,
        });

        const messages = res.messages || [];
        for (const msg of messages) {
          if (msg.id > this.lastEventId) {
            this.lastEventId = msg.id;
          }
          this._handleIncomingEvent(msg);
        }
      } catch (err) {
        // Transient poll error
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  _handleIncomingEvent(event) {
    const eventType = event.type;
    const sender = event.peerId;
    const data = event.data || {};

    if (eventType === 'room_state') {
      if (data.event === 'peer_joined') {
        const newPeer = data.peerId;
        if (newPeer && !this.peers.includes(newPeer)) {
          this.peers.push(newPeer);
        }
        this.emit('peer_joined', { peerId: newPeer, peerName: data.peerName });
      } else if (data.event === 'peer_left') {
        const leftPeer = data.peerId;
        this.peers = this.peers.filter((p) => p !== leftPeer);
        this.emit('peer_left', { peerId: leftPeer });
      }
    } else if (eventType === 'chat') {
      this.emit('chat', {
        sender,
        senderName: data.senderName || sender,
        text: data.text,
      });
    } else if (eventType === 'file_start') {
      const fileInfo = data.file || {};
      const token = fileInfo.transferToken || fileInfo.id;
      const totalChunks = Number(fileInfo.totalChunks || 0);
      const fileName = path.basename(fileInfo.name || 'downloaded_file');
      const fileSize = Number(fileInfo.size || 0);
      const expectedSha256 = fileInfo.sha256 || '';

      this.incomingTransfers.set(token, {
        name: fileName,
        size: fileSize,
        totalChunks,
        expectedSha256,
        chunks: new Array(totalChunks).fill(null),
        receivedChunks: 0,
        receivedBytes: 0,
        sender,
        startedAt: Date.now(),
      });

      this.emit('file_start', {
        fileName,
        fileSize,
        totalChunks,
        sender,
      });
    } else if (eventType === 'file_chunk') {
      const token = data.transferToken || data.fileId;
      const index = data.index;
      const payloadB64 = data.payload;

      if (!token || index == null || !payloadB64) return;
      const transfer = this.incomingTransfers.get(token);
      if (!transfer || index >= transfer.totalChunks) return;

      if (transfer.chunks[index] === null) {
        const rawChunk = Buffer.from(payloadB64, 'base64');
        transfer.chunks[index] = rawChunk;
        transfer.receivedChunks += 1;
        transfer.receivedBytes += rawChunk.length;

        this.emit('file_progress', {
          token,
          fileName: transfer.name,
          receivedChunks: transfer.receivedChunks,
          totalChunks: transfer.totalChunks,
          receivedBytes: transfer.receivedBytes,
          totalBytes: transfer.size,
          percent: Math.round((transfer.receivedChunks / transfer.totalChunks) * 100),
        });
      }
    } else if (eventType === 'file_end') {
      const token = data.transferToken || data.fileId;
      const transfer = this.incomingTransfers.get(token);
      if (!transfer) return;
      this.incomingTransfers.delete(token);

      // Verify completeness
      if (
        transfer.receivedChunks !== transfer.totalChunks ||
        transfer.chunks.some((c) => c === null)
      ) {
        this.emit('file_error', {
          token,
          fileName: transfer.name,
          error: 'Transfer ended before all chunks arrived.',
        });
        return;
      }

      // Reassemble buffer and compute SHA-256
      const fileBuffer = Buffer.concat(transfer.chunks);
      const actualSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');

      if (
        transfer.expectedSha256 &&
        actualSha256.toLowerCase() !== transfer.expectedSha256.toLowerCase()
      ) {
        this.emit('file_error', {
          token,
          fileName: transfer.name,
          error: 'SHA-256 integrity verification failed! Discarding file.',
        });
        return;
      }

      // Save automatically into ./ultron folder
      let savePath = path.join(this.saveDir, transfer.name);
      const ext = path.extname(transfer.name);
      const base = path.basename(transfer.name, ext);
      let counter = 1;
      while (fs.existsSync(savePath)) {
        savePath = path.join(this.saveDir, `${base}_${counter}${ext}`);
        counter += 1;
      }

      fs.writeFileSync(savePath, fileBuffer);

      this.emit('file_saved', {
        fileName: transfer.name,
        filePath: savePath,
        size: fileBuffer.length,
        sha256: actualSha256,
        sender: transfer.sender,
      });
    }
  }

  async sendFile(filePath, targetPeerId = null) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File '${filePath}' does not exist.`);
    }

    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const fileSize = stat.size;
    const transferToken = `TOK${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const fileId = `file-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;

    // Read full file and compute SHA-256
    const fileBuffer = fs.readFileSync(filePath);
    const fileSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const totalChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE_BYTES));

    // Send FILE_START
    await this._callRegistry('signal', {
      type: 'file_start',
      roomCode: this.roomCode,
      peerId: this.peerId,
      targetPeerId,
      data: {
        file: {
          id: fileId,
          transferToken,
          name: fileName,
          size: fileSize,
          totalChunks,
          sha256: fileSha256,
          uploaderId: this.peerId,
        },
      },
    });

    // Stream chunks
    for (let idx = 0; idx < totalChunks; idx += 1) {
      const start = idx * CHUNK_SIZE_BYTES;
      const end = Math.min(start + CHUNK_SIZE_BYTES, fileBuffer.length);
      const chunkBuf = fileBuffer.subarray(start, end);
      const payload = chunkBuf.toString('base64');

      await this._callRegistry('signal', {
        type: 'file_chunk',
        roomCode: this.roomCode,
        peerId: this.peerId,
        targetPeerId,
        data: {
          transferToken,
          fileId,
          index: idx,
          payload,
        },
      });

      this.emit('send_progress', {
        fileName,
        chunkIndex: idx + 1,
        totalChunks,
        percent: Math.round(((idx + 1) / totalChunks) * 100),
      });
    }

    // Send FILE_END
    await this._callRegistry('signal', {
      type: 'file_end',
      roomCode: this.roomCode,
      peerId: this.peerId,
      targetPeerId,
      data: {
        transferToken,
        fileId,
      },
    });

    return {
      fileName,
      fileSize,
      sha256: fileSha256,
      totalChunks,
    };
  }

  async sendChat(text, targetPeerId = null) {
    return await this._callRegistry('signal', {
      type: 'chat',
      roomCode: this.roomCode,
      peerId: this.peerId,
      targetPeerId,
      data: {
        text,
        senderName: this.peerName,
        timestamp: Date.now(),
      },
    });
  }

  async leave() {
    if (!this.running) return;
    this.running = false;
    clearInterval(this.heartbeatTimer);
    try {
      await this._callRegistry('leave', {
        roomCode: this.roomCode,
        peerId: this.peerId,
      });
    } catch (err) {}
  }

  static formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }
}

// -------------------------------------------------------------
// Interactive CLI Interface
// -------------------------------------------------------------
async function runInteractiveCli(client) {
  console.log('\n' + '='.repeat(60));
  console.log(' ⚡ ULTRON DEVELOPER P2P FILE STREAM ACTIVE (Node.js)');
  console.log(` Room Code  : ${client.roomCode}`);
  console.log(` Role       : ${client.isHost ? 'HOST' : 'GUEST'}`);
  console.log(` Peer ID    : ${client.peerId} (${client.peerName})`);
  console.log(` Save Dir   : ${client.saveDir}`);
  console.log('='.repeat(60));
  console.log('Commands:');
  console.log('  send <path>   - Send a file to connected peer(s)');
  console.log('  chat <msg>    - Send a text message');
  console.log('  peers         - List connected peers');
  console.log('  clear         - Clear terminal screen');
  console.log('  exit / quit   - Leave room and disconnect');
  console.log('-'.repeat(60) + '\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'ultron> ',
  });

  client.on('peer_joined', ({ peerId, peerName }) => {
    process.stdout.write(`\n🔔 Peer joined: ${peerName} (${peerId})\nultron> `);
  });

  client.on('peer_left', ({ peerId }) => {
    process.stdout.write(`\n🚪 Peer left: ${peerId}\nultron> `);
  });

  client.on('chat', ({ senderName, text }) => {
    process.stdout.write(`\n💬 [${senderName}]: ${text}\nultron> `);
  });

  client.on('file_start', ({ fileName, fileSize, totalChunks, sender }) => {
    process.stdout.write(
      `\n[Ultron] 📥 Incoming file '${fileName}' (${UltronClient.formatBytes(fileSize)}) in ${totalChunks} chunks from ${sender}...\n`
    );
  });

  client.on('file_progress', ({ fileName, percent, receivedBytes, totalBytes }) => {
    process.stdout.write(
      `\r[Ultron] 📥 Receiving '${fileName}': ${percent}% (${UltronClient.formatBytes(receivedBytes)} / ${UltronClient.formatBytes(totalBytes)})`
    );
  });

  client.on('file_saved', ({ fileName, filePath, size, sha256 }) => {
    console.log(`\n[Ultron] ✅ File saved successfully!`);
    console.log(`       📂 Destination: ${filePath}`);
    console.log(`       📦 Size: ${UltronClient.formatBytes(size)}`);
    console.log(`       🔒 SHA-256: ${sha256}\n`);
    rl.prompt();
  });

  client.on('file_error', ({ fileName, error }) => {
    console.log(`\n[Ultron] ❌ File error '${fileName}': ${error}`);
    rl.prompt();
  });

  client.on('send_progress', ({ chunkIndex, totalChunks, percent }) => {
    process.stdout.write(`\r[Ultron] 📤 Sending: ${percent}% (Chunk ${chunkIndex}/${totalChunks})`);
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    const [action, ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(' ');

    switch (action.toLowerCase()) {
      case 'exit':
      case 'quit':
      case 'q':
        console.log('[Ultron] Disconnecting...');
        await client.leave();
        rl.close();
        process.exit(0);
        break;

      case 'send':
        if (!arg) {
          console.log('Usage: send <file_path>');
        } else {
          const filePath = arg.replace(/^['"]|['"]$/g, '');
          try {
            console.log(`[Ultron] 📤 Preparing to send '${path.basename(filePath)}'...`);
            const result = await client.sendFile(filePath);
            console.log(
              `\n[Ultron] ✅ Transfer of '${result.fileName}' complete! (SHA-256: ${result.sha256.slice(0, 12)}...)`
            );
          } catch (err) {
            console.log(`\n[Ultron] ❌ Send error: ${err.message}`);
          }
        }
        break;

      case 'chat':
        if (!arg) {
          console.log('Usage: chat <message>');
        } else {
          try {
            await client.sendChat(arg);
          } catch (err) {
            console.log(`[Ultron] Chat error: ${err.message}`);
          }
        }
        break;

      case 'peers':
        if (client.peers.length) {
          console.log(`[Ultron] Active peers: ${client.peers.join(', ')}`);
        } else {
          console.log('[Ultron] No other peers in room. Waiting for friend to join...');
        }
        break;

      case 'clear':
        console.clear();
        break;

      default:
        console.log(`Unknown command: '${action}'. Available: send, chat, peers, clear, exit`);
        break;
    }
    rl.prompt();
  });

  rl.on('close', async () => {
    await client.leave();
    process.exit(0);
  });
}

// -------------------------------------------------------------
// CLI Argument Parsing & Entry Point
// -------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  function getArg(flag, defaultValue = null) {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultValue;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(`
Usage:
  node ultron.mjs create <room_code> [--key secret] [--server http://localhost:3000] [--dir ./ultron]
  node ultron.mjs join <room_code>   [--key secret] [--server http://localhost:3000] [--dir ./ultron]
  node ultron.mjs (interactive menu)

Commands:
  create <room_code>  Create and host a new P2P room (e.g. 4567)
  join <room_code>    Join an existing room as a guest peer

Options:
  --key <secret>      Optional room authorization key / password
  --server <url>      Signaling server URL (default: http://localhost:3000)
  --dir <path>        Directory to automatically save received files (default: ./ultron)
  --name <string>     Custom developer handle name
  --help, -h          Show this help message
`);
    process.exit(0);
  }

  if (command === 'create' || command === 'join') {
    const roomCode = args[1];
    if (!roomCode) {
      console.error(`Usage: node ultron.mjs ${command} <room_code> [--key secret]`);
      process.exit(1);
    }
    const authKey = getArg('--key');
    const serverUrl = getArg('--server', DEFAULT_SERVER);
    const saveDir = getArg('--dir', DEFAULT_SAVE_DIR);
    const peerName = getArg('--name');

    const client = new UltronClient({
      roomCode,
      isHost: command === 'create',
      authKey,
      serverUrl,
      saveDir,
      peerName,
    });

    try {
      await client.connect();
      await runInteractiveCli(client);
    } catch (err) {
      console.error(`\n[Ultron] Connection error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Interactive Prompt
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (prompt) => new Promise((res) => rl.question(prompt, res));

  console.log('='.repeat(55));
  console.log(' ⚡ UltronChat Developer Setup (Node.js)');
  console.log('='.repeat(55));

  const choice = (await question('Do you want to (1) Create a room or (2) Join a room? [1/2]: ')).trim();
  const isHost = choice === '1';
  const roomCode = (await question('Enter Room Code (e.g. 4567): ')).trim().toUpperCase();
  if (!roomCode) {
    console.error('Error: Room code is required.');
    rl.close();
    process.exit(1);
  }
  const authKey = (await question('Enter Auth Key (optional, press Enter to skip): ')).trim() || null;
  const peerName = (await question('Enter your Dev Name (optional): ')).trim() || null;
  const saveDir = (await question('Save received files to [default: ./ultron]: ')).trim() || DEFAULT_SAVE_DIR;

  rl.close();

  const client = new UltronClient({
    roomCode,
    isHost,
    authKey,
    peerName,
    serverUrl: DEFAULT_SERVER,
    saveDir,
  });

  try {
    await client.connect();
    await runInteractiveCli(client);
  } catch (err) {
    console.error(`\n[Ultron] Error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('ultron.mjs')) {
  main().catch((err) => {
    console.error('[Ultron] Fatal:', err);
    process.exit(1);
  });
}
