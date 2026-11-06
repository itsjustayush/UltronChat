/**
 * WebSocket Signaling Server for WebRTC
 * Handles peer signaling, room management, and connection coordination
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import { roomRegistry } from './roomRegistryClient';

export interface SignalMessage {
  type:
    | 'join'
    | 'leave'
    | 'offer'
    | 'answer'
    | 'candidate'
    | 'chat'
    | 'chat_ack'
    | 'typing'
    | 'reaction'
    | 'file_start'
    | 'file_chunk'
    | 'file_end'
    | 'room_state'
    | 'error'
    | 'ping'
    | 'pong';
  roomId?: string;
  peerId?: string;
  isHost?: boolean;
  targetPeerId?: string;
  data?: any;
  timestamp?: number;
}

export interface RoomState {
  roomId: string;
  peers: Map<string, WebSocket | null>;
  hostPeerId: string;
  authHash?: string | null;
  createdAt: number;
  lastActivity: number;
}

const MAX_SIGNAL_BYTES = 64 * 1024;
const MAX_QUEUE_MESSAGES = 100;
const ROOM_ID_PATTERN = /^[A-Z0-9]{3,32}$/;
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;

function normalizeChannel(roomId?: string): string | null {
  if (!roomId) return null;
  const raw = String(roomId).trim().toUpperCase();
  const withoutPrefix = raw.startsWith('ROOM-') ? raw.slice(5) : raw;
  const cleanRoomId = withoutPrefix.replace(/[^A-Z0-9]/g, '');
  if (!ROOM_ID_PATTERN.test(cleanRoomId)) return null;
  return `ROOM-${cleanRoomId}`;
}

function isSafeMessage(message: SignalMessage): boolean {
  if (!message || typeof message.type !== 'string') return false;
  if (message.roomId && !normalizeChannel(message.roomId)) return false;
  if (message.peerId && !PEER_ID_PATTERN.test(message.peerId)) return false;
  if (message.targetPeerId && !PEER_ID_PATTERN.test(message.targetPeerId)) return false;
  try {
    return JSON.stringify(message).length <= MAX_SIGNAL_BYTES;
  } catch {
    return false;
  }
}

export class SignalingServer {
  private app: express.Application;
  private httpServer: ReturnType<typeof createServer>;
  private wss: WebSocketServer;
  private rooms: Map<string, RoomState> = new Map();
  private peerToRoom: Map<WebSocket, { roomId: string; peerId: string }> =
    new Map();
  private httpPeerQueues: Map<string, SignalMessage[]> = new Map();
  private inactivityTimeout = 5 * 60 * 1000; // 5 minutes
  private heartbeatInterval = 30 * 1000; // 30 seconds
  private heartbeatTimers: Map<WebSocket, NodeJS.Timeout> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(serverOrPort: ReturnType<typeof createServer> | number = 3001) {
    this.app = express();
    this.app.use(express.json());
    this.wss = new WebSocketServer({ noServer: true });

    if (typeof serverOrPort === 'number') {
      this.httpServer = createServer(this.app);
      this.setupRoutes();
      this.setupWebSocket();
      this.startCleanupInterval();

      this.httpServer.listen(serverOrPort, '0.0.0.0', () => {
        console.log(`[SignalingServer] Listening on port ${serverOrPort}`);
      });
    } else {
      this.httpServer = serverOrPort;
      this.setupRoutes();
      this.setupWebSocket();
      this.startCleanupInterval();
    }

    this.httpServer.on('upgrade', (request, socket, head) => {
      try {
        const urlStr = request.url || '';
        const pathname = urlStr.split('?')[0];
        if (pathname === '/ws' || pathname === '/ws/' || pathname.endsWith('/ws')) {
          this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.wss.emit('connection', ws, request);
          });
        }
      } catch (err) {
        console.error('[SignalingServer] Upgrade error:', err);
      }
    });
  }

  public getApp() {
    return this.app;
  }

  private setupRoutes() {
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'ok',
        rooms: this.rooms.size,
        timestamp: Date.now(),
      });
    });

    this.app.get('/rooms/:roomId', async (req, res) => {
      const channelId = normalizeChannel(req.params.roomId);
      if (!channelId) {
        res.status(400).json({ active: false, error: 'Invalid room code' });
        return;
      }
      try {
        const registryRoom = await roomRegistry('lookup', { roomCode: channelId.replace(/^ROOM-/, '') });
        res.json({
          active: true,
          roomId: registryRoom.room_code,
          hostPeerId: registryRoom.host_peer_id,
          peers: (registryRoom.peers || []).map((peer) => peer.peer_id),
          peerCount: registryRoom.peers?.length || 0,
        });
      } catch (error: any) {
        res.status(error?.status === 404 ? 404 : 503).json({ active: false, error: error?.message || 'Room registry unavailable' });
      }
    });

    this.app.post('/registry', async (req, res) => {
      const body = req.body || {};
      const action = typeof body.action === 'string' ? body.action : '';
      const roomCode = normalizeChannel(body.roomCode || body.roomId || '');
      const peerId = body.peerId;
      if (!action || !roomCode || (peerId && !PEER_ID_PATTERN.test(peerId))) {
        res.status(400).json({ error: 'Invalid room registry request' });
        return;
      }
      try {
        const result = await roomRegistry(action, {
          ...body,
          roomCode: roomCode.replace(/^ROOM-/, ''),
          peerId,
        });
        res.json(result);
      } catch (error: any) {
        res.status(error?.status || 503).json({ error: error?.message || 'Room registry unavailable', code: error?.code });
      }
    });

    this.app.get('/stats', (req, res) => {
      const stats = {
        totalRooms: this.rooms.size,
        totalPeers: this.peerToRoom.size,
        rooms: Array.from(this.rooms.entries()).map(([roomId, room]) => ({
          roomId,
          peerCount: room.peers.size,
          createdAt: room.createdAt,
          lastActivity: room.lastActivity,
          uptime: Date.now() - room.createdAt,
        })),
      };
      res.json(stats);
    });

    // HTTP Signaling Fallback Endpoints (for environments where WebSockets are blocked/restricted)
    this.app.post('/post', (req, res) => {
      try {
        const message: SignalMessage = req.body;
        if (!message || !message.type) {
          res.status(400).json({ error: 'Invalid message' });
          return;
        }
        this.handleHttpSignalMessage(message);
        res.json({ ok: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/poll', (req, res) => {
      const roomId = req.query.roomId as string;
      const peerId = req.query.peerId as string;
      if (!roomId || !peerId) {
        res.status(400).json({ error: 'Missing roomId or peerId' });
        return;
      }
      const channelId = normalizeChannel(roomId);
      if (!channelId || !PEER_ID_PATTERN.test(peerId)) {
        res.status(400).json({ error: 'Invalid room or peer identity' });
        return;
      }
      const room = this.rooms.get(channelId);
      if (!room || !room.peers.has(peerId)) {
        res.status(403).json({ error: 'Peer is not joined to this room' });
        return;
      }
      const key = `${channelId}:${peerId}`;
      const queue = this.httpPeerQueues.get(key) || [];
      this.httpPeerQueues.set(key, []);
      res.json({ messages: queue });
    });
  }

  private handleHttpSignalMessage(message: SignalMessage) {
    if (!isSafeMessage(message)) return;
    if (message.type === 'join') {
      this.handleJoin(null, message);
    } else if (message.type === 'leave') {
      this.handleLeave(null, message);
    } else if (['offer', 'answer', 'candidate', 'chat', 'chat_ack', 'typing', 'reaction', 'file_start', 'file_chunk', 'file_end'].includes(message.type)) {
      if (message.targetPeerId) {
        this.relayMessage(null, message);
      } else if (message.roomId && message.peerId) {
        const channelId = normalizeChannel(message.roomId);
        const room = channelId ? this.rooms.get(channelId) : undefined;
        if (!room || !room.peers.has(message.peerId)) return;
        this.broadcastToRoom(channelId!, message, message.peerId);
      }
    }
  }

  private setupWebSocket() {
    this.wss.on('connection', (ws: WebSocket) => {
      console.log('[SignalingServer] New WebSocket connection');

      ws.on('message', (data: Buffer) => {
        try {
          const message: SignalMessage = JSON.parse(data.toString());
            this.handleMessage(ws, message);
        } catch (error) {
          console.error('[SignalingServer] Error parsing message:', error);
          this.sendError(ws, 'Invalid message format');
        }
      });

      ws.on('close', () => {
        this.handleDisconnect(ws);
      });

      ws.on('error', (error) => {
        console.error('[SignalingServer] WebSocket error:', error);
      });

      this.startHeartbeat(ws);
    });
  }

  private handleMessage(ws: WebSocket, message: SignalMessage) {
    if (!isSafeMessage(message)) {
      this.sendError(ws, 'Invalid or oversized signaling payload');
      return;
    }
    if (message.type === 'leave') {
      this.handleLeave(ws, message);
      return;
    }
    if (message.type !== 'join' && message.type !== 'ping' && !this.peerToRoom.has(ws)) {
      this.sendError(ws, 'Join a room before sending data');
      return;
    }
    const peerInfo = this.peerToRoom.get(ws);
    if (peerInfo && message.type !== 'join' && message.type !== 'ping') {
      message = { ...message, roomId: peerInfo.roomId, peerId: peerInfo.peerId };
    }
    switch (message.type) {
      case 'join':
        this.handleJoin(ws, message);
        break;
      case 'offer':
        this.relayMessage(ws, message);
        break;
      case 'answer':
        this.relayMessage(ws, message);
        break;
      case 'candidate':
        this.relayMessage(ws, message);
        break;
      case 'chat':
      case 'chat_ack':
      case 'typing':
      case 'reaction':
      case 'file_start':
      case 'file_chunk':
      case 'file_end':
        if (message.targetPeerId) {
          this.relayMessage(ws, message);
        } else if (message.roomId) {
          const channelId = normalizeChannel(message.roomId);
          if (channelId) this.broadcastToRoom(channelId, message, message.peerId);
        }
        break;
      case 'ping':
        this.sendMessage(ws, { type: 'pong', timestamp: Date.now() });
        break;
      default:
        console.warn(
          `[SignalingServer] Unknown message type: ${message.type}`
        );
    }
  }

  private handleJoin(ws: WebSocket | null, message: SignalMessage) {
    const { roomId, peerId, isHost } = message;

    if (!roomId || !peerId) {
      if (ws) this.sendError(ws, 'Missing roomId or peerId');
      return;
    }

    // Standardized room channel string e.g. room-XR92KB
    const channelId = normalizeChannel(roomId);
    if (!channelId) {
      if (ws) this.sendError(ws, 'Invalid room code');
      return;
    }

    // Get or create room
    let room = this.rooms.get(channelId);
    if (!room) {
      if (isHost) {
        const rawAuth = message.data?.authKey || message.data?.password;
        const authHash = typeof rawAuth === 'string' && rawAuth.trim()
          ? createHash('sha256').update(rawAuth.trim()).digest('hex')
          : null;
        room = {
          roomId: channelId,
          peers: new Map(),
          hostPeerId: peerId,
          authHash,
          createdAt: Date.now(),
          lastActivity: Date.now(),
        };
        this.rooms.set(channelId, room);
      } else {
        // Non-host user attempting to join non-existent room -> 404 error
        console.warn(`[SignalingServer] Rejecting join for non-existent room ${channelId}`);
        this.sendToPeer(ws, peerId, channelId, {
          type: 'error',
          data: { message: `Room ${roomId} not found or expired.`, code: 404 },
          timestamp: Date.now(),
        });
        return;
      }
    }

    // Verify room auth if set
    if (room.authHash) {
      const candidateKey = message.data?.authKey || message.data?.password;
      const candidateHash = typeof candidateKey === 'string' && candidateKey.trim()
        ? createHash('sha256').update(candidateKey.trim()).digest('hex')
        : null;
      if (!candidateHash || candidateHash !== room.authHash) {
        if (ws) {
          this.sendToPeer(ws, peerId, channelId, {
            type: 'error',
            data: { message: 'Room requires valid authorization key.', code: 403 },
            timestamp: Date.now(),
          });
        }
        return;
      }
    }

    // Add or update peer
    if (room.peers.has(peerId) && room.peers.get(peerId) !== ws) {
      if (ws) this.sendError(ws, 'Peer identity is already active in this room');
      return;
    }
      room.peers.set(peerId, ws);
      if (ws) {
      this.peerToRoom.set(ws, { roomId: channelId, peerId });
    }
    room.lastActivity = Date.now();

    // Get list of existing peers
    const existingPeers = Array.from(room.peers.keys()).filter(
      (id) => id !== peerId
    );

    // Send room state to new peer
    this.sendToPeer(ws, peerId, channelId, {
      type: 'room_state',
      data: {
        peerId,
        peers: existingPeers,
        hostPeerId: room.hostPeerId,
        roomSize: room.peers.size,
      },
      timestamp: Date.now(),
    });

    // Notify other peers of new peer (triggers SDP offer from Host)
    this.broadcastToRoom(channelId, {
      type: 'room_state',
      data: {
        event: 'peer_joined',
        peerId,
        hostPeerId: room.hostPeerId,
        roomSize: room.peers.size,
      },
      timestamp: Date.now(),
    }, peerId);

    console.log(
      `[SignalingServer] Peer ${peerId} joined channel ${channelId} (total: ${room.peers.size})`
    );
  }

  private relayMessage(ws: WebSocket | null, message: SignalMessage) {
    let roomId = message.roomId;
    let peerId = message.peerId;

    if (ws) {
      const peerInfo = this.peerToRoom.get(ws);
      if (peerInfo) {
        roomId = peerInfo.roomId;
        peerId = peerInfo.peerId;
      }
    }

    if (!roomId || !peerId) {
      if (ws) this.sendError(ws, 'Not in a room');
      return;
    }

    const channelId = normalizeChannel(roomId);
    if (!channelId) {
      if (ws) this.sendError(ws, 'Invalid room code');
      return;
    }
    const { targetPeerId } = message;

    if (!targetPeerId) {
      if (ws) this.sendError(ws, 'Missing targetPeerId');
      return;
    }

    const room = this.rooms.get(channelId);
    if (!room || !room.peers.has(peerId)) {
      if (ws) this.sendError(ws, 'Peer is not joined to this room');
      return;
    }

    const targetWs = room.peers.get(targetPeerId);

    this.sendToPeer(targetWs || null, targetPeerId, channelId, {
      type: message.type,
      peerId,
      data: message.data,
      timestamp: Date.now(),
    });

    room.lastActivity = Date.now();
  }

  private broadcastToRoom(
    channelId: string,
    message: SignalMessage,
    excludePeerId?: string
  ) {
    const room = this.rooms.get(channelId);
    if (!room) return;

    room.peers.forEach((ws, peerId) => {
      if (excludePeerId && peerId === excludePeerId) return;
      this.sendToPeer(ws, peerId, channelId, message);
    });
  }

  private sendToPeer(
    ws: WebSocket | null,
    peerId: string,
    channelId: string,
    message: SignalMessage
  ) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      const key = `${channelId}:${peerId}`;
      let queue = this.httpPeerQueues.get(key);
      if (!queue) {
        queue = [];
        this.httpPeerQueues.set(key, queue);
      }
      if (queue.length >= MAX_QUEUE_MESSAGES) queue.shift();
      queue.push(message);
    }
  }

  private sendMessage(ws: WebSocket, message: SignalMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  private sendError(ws: WebSocket, error: string) {
    this.sendMessage(ws, {
      type: 'error',
      data: { message: error },
      timestamp: Date.now(),
    });
  }

    private handleLeave(ws: WebSocket | null, message: SignalMessage) {
    const peerInfo = ws ? this.peerToRoom.get(ws) : undefined;
    const roomId = peerInfo?.roomId || normalizeChannel(message.roomId || '');
    const peerId = peerInfo?.peerId || message.peerId;
    if (!roomId || !peerId) return;

    const room = this.rooms.get(roomId);
    if (!room || !room.peers.has(peerId)) return;

    room.peers.delete(peerId);
    if (room.hostPeerId === peerId) {
      room.hostPeerId = room.peers.keys().next().value || '';
      if (room.hostPeerId) {
        this.broadcastToRoom(roomId, {
          type: 'room_state',
          data: { event: 'host_changed', hostPeerId: room.hostPeerId },
          timestamp: Date.now(),
        });
      }
    }
    room.lastActivity = Date.now();
    this.broadcastToRoom(roomId, {
      type: 'room_state',
      data: { event: 'peer_left', peerId, roomSize: room.peers.size },
      timestamp: Date.now(),
    });

    if (ws) {
      this.peerToRoom.delete(ws);
      this.stopHeartbeat(ws);
    }
    if (room.peers.size === 0) {
      this.rooms.delete(roomId);
      console.log(`[SignalingServer] Deleted empty room ${roomId}`);
    } else {
      console.log(`[SignalingServer] Peer ${peerId} left room ${roomId} (remaining: ${room.peers.size})`);
    }
  }

  private handleDisconnect(ws: WebSocket) {
    const peerInfo = this.peerToRoom.get(ws);
    if (!peerInfo) return;
    this.handleLeave(ws, { type: 'leave', roomId: peerInfo.roomId, peerId: peerInfo.peerId });
  }

  private startHeartbeat(ws: WebSocket) {
    const timer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendMessage(ws, { type: 'ping', timestamp: Date.now() });
      }
    }, this.heartbeatInterval);

    this.heartbeatTimers.set(ws, timer);
  }

  private stopHeartbeat(ws: WebSocket) {
    const timer = this.heartbeatTimers.get(ws);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(ws);
    }
  }

  private startCleanupInterval() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const toDelete: string[] = [];

      this.rooms.forEach((room, roomId) => {
        if (now - room.lastActivity > this.inactivityTimeout) {
          // Close all connections in inactive room
          room.peers.forEach((ws) => {
            if (ws) ws.close(4000, 'Room inactivity timeout');
          });
          toDelete.push(roomId);
          console.log(
            `[SignalingServer] Deleted inactive room ${roomId}`
          );
        }
      });

      toDelete.forEach((roomId) => this.rooms.delete(roomId));
    }, 60000); // Run cleanup every minute
  }

  public close() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.heartbeatTimers.forEach((timer) => clearInterval(timer));
    this.heartbeatTimers.clear();
    this.wss.close();
    this.httpServer.close();
  }
}

// Export singleton
let instance: SignalingServer | null = null;

export function getSignalingServer(serverOrPort?: ReturnType<typeof createServer> | number): SignalingServer {
  if (!instance) {
    instance = new SignalingServer(serverOrPort);
  }
  return instance;
}
