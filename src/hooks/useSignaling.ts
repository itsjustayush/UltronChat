/**
 * React Hook for WebRTC Signaling via WebSocket
 * Handles WebSocket connection, message relay, and peer discovery
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { SignalMessage } from '../server/signalServer';

export interface UseSignalingOptions {
  signalingUrl: string;
  roomId: string;
  peerId: string;
  peerName?: string;
  isHost?: boolean;
  onRoomState?: (data: any) => void;
  onSignal?: (message: SignalMessage) => void;
  onError?: (error: string) => void;
  autoConnect?: boolean;
}

export interface UseSignalingReturn {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  sendSignal: (message: SignalMessage) => void;
  sendOffer: (targetPeerId: string, offer: RTCSessionDescriptionInit) => void;
  sendAnswer: (targetPeerId: string, answer: RTCSessionDescriptionInit) => void;
  sendCandidate: (targetPeerId: string, candidate: RTCIceCandidateInit) => void;
  disconnect: () => void;
}

const MESSAGE_QUEUE_MAX = 100;
const RECONNECT_DELAY_MS = 1000;
const RECONNECT_MAX_ATTEMPTS = 10;
const HEARTBEAT_TIMEOUT_MS = 10000;

export function useSignaling(options: UseSignalingOptions): UseSignalingReturn {
  const {
    signalingUrl,
    roomId,
    peerId,
    peerName,
    isHost,
    onRoomState,
    onSignal,
    onError,
    autoConnect = true,
  } = options;

  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Store volatile callbacks/options in a ref to avoid recreating connect & triggering effect loops
  const callbacksRef = useRef({ onRoomState, onSignal, onError, isHost });
  useEffect(() => {
    callbacksRef.current = { onRoomState, onSignal, onError, isHost };
  });

  const wsRef = useRef<WebSocket | null>(null);
  const messageQueueRef = useRef<SignalMessage[]>([]);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const heartbeatTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastHeartbeatRef = useRef<number>(Date.now());
  const connectRef = useRef<(() => void) | null>(null);
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);
  const registryHeartbeatTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastEventIdRef = useRef<number>(0);
  const processedEventIdsRef = useRef<Set<number>>(new Set());
  const isPollingRef = useRef<boolean>(false);
  const modeRef = useRef<'ws' | 'http'>('ws');

  /**
   * Stop HTTP polling loop
   */
  const stopHttpPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    isPollingRef.current = false;
  }, []);

  const stopRegistryHeartbeat = useCallback(() => {
    if (registryHeartbeatTimerRef.current) {
      clearInterval(registryHeartbeatTimerRef.current);
      registryHeartbeatTimerRef.current = null;
    }
  }, []);

  const registryRequest = useCallback(async (action: string) => {
    const response = await fetch('/api/signal/registry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, roomCode: roomId, peerId, peerName }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || 'Room registry unavailable');
    return data;
  }, [roomId, peerId, peerName]);

  const startRegistryHeartbeat = useCallback(() => {
    stopRegistryHeartbeat();
    registryHeartbeatTimerRef.current = setInterval(() => {
      registryRequest('heartbeat').catch(() => {});
    }, 25000);
  }, [registryRequest, stopRegistryHeartbeat]);

  /**
   * Send a message through WebSocket or HTTP
   */
  const sendMessage = useCallback((message: SignalMessage) => {
    if (modeRef.current === 'http') {
      fetch('/api/signal/registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'signal', roomCode: roomId, peerId, targetPeerId: message.targetPeerId, type: message.type, data: message.data }),
      }).catch(() => {});
      return;
    }

    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(message));
    } else {
      if (messageQueueRef.current.length < MESSAGE_QUEUE_MAX) {
        messageQueueRef.current.push(message);
      } else {
        console.warn('[useSignaling] Message queue overflow, dropping message');
      }
    }
  }, [roomId, peerId]);

  /**
   * Send WebRTC offer
   */
  const sendOffer = useCallback(
    (targetPeerId: string, offer: RTCSessionDescriptionInit) => {
      sendMessage({
        type: 'offer',
        roomId,
        peerId,
        targetPeerId,
        data: offer,
        timestamp: Date.now(),
      });
    },
    [sendMessage, roomId, peerId]
  );

  /**
   * Send WebRTC answer
   */
  const sendAnswer = useCallback(
    (targetPeerId: string, answer: RTCSessionDescriptionInit) => {
      sendMessage({
        type: 'answer',
        roomId,
        peerId,
        targetPeerId,
        data: answer,
        timestamp: Date.now(),
      });
    },
    [sendMessage, roomId, peerId]
  );

  /**
   * Send ICE candidate
   */
  const sendCandidate = useCallback(
    (targetPeerId: string, candidate: RTCIceCandidateInit) => {
      sendMessage({
        type: 'candidate',
        roomId,
        peerId,
        targetPeerId,
        data: candidate,
        timestamp: Date.now(),
      });
    },
    [sendMessage, roomId, peerId]
  );

  /**
   * Flush queued messages
   */
  const flushMessageQueue = useCallback(() => {
    while (messageQueueRef.current.length > 0) {
      const message = messageQueueRef.current.shift();
      if (message && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message));
      }
    }
  }, []);

  /**
   * Handle incoming WebSocket messages
   */
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const message: SignalMessage = JSON.parse(event.data);

      switch (message.type) {
        case 'room_state':
          callbacksRef.current.onRoomState?.(message.data);
          break;

        case 'offer':
        case 'answer':
        case 'candidate':
        case 'chat':
        case 'chat_ack':
        case 'typing':
        case 'reaction':
          callbacksRef.current.onSignal?.(message);
          break;

        case 'pong':
          lastHeartbeatRef.current = Date.now();
          break;

        case 'error':
          const errorMsg = message.data?.message || 'Unknown signaling error';
          setError(errorMsg);
          callbacksRef.current.onError?.(errorMsg);
          break;

        default:
          console.warn(`[useSignaling] Unknown message type: ${message.type}`);
      }
    } catch (err) {
      console.error('[useSignaling] Error handling message:', err);
    }
  }, []);

  /**
   * Stop heartbeat monitor
   */
  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  /**
   * Start heartbeat monitor
   */
  const startHeartbeat = useCallback(() => {
    stopHeartbeat();
    heartbeatTimerRef.current = setInterval(() => {
      const timeSinceLastHeartbeat = Date.now() - lastHeartbeatRef.current;

      if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        console.warn('[useSignaling] Heartbeat timeout, closing connection...');
        if (wsRef.current) {
          wsRef.current.close();
        }
      } else {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'ping', roomId, peerId, timestamp: Date.now() }));
        }
      }
    }, HEARTBEAT_TIMEOUT_MS / 2);
  }, [stopHeartbeat, roomId, peerId]);

  /**
   * Attempt to reconnect with exponential backoff
   */
  const attemptReconnect = useCallback(() => {
    if (reconnectAttemptsRef.current >= RECONNECT_MAX_ATTEMPTS) {
      const err = `Signaling server unavailable after ${RECONNECT_MAX_ATTEMPTS} attempts`;
      setError(err);
      callbacksRef.current.onError?.(err);
      return;
    }

    const delay = Math.min(10000, RECONNECT_DELAY_MS * Math.pow(2, reconnectAttemptsRef.current));
    reconnectAttemptsRef.current++;

    console.log(
      `[useSignaling] Reconnecting in ${delay}ms (attempt ${reconnectAttemptsRef.current})`
    );

    reconnectTimeoutRef.current = setTimeout(() => {
      connectRef.current?.();
    }, delay);
  }, []);

  /**
   * Start HTTP polling loop as a fallback when WebSocket is unavailable
   */
  const startHttpPolling = useCallback(() => {
    stopHttpPolling();
    modeRef.current = 'http';
    setConnected(true);
    setConnecting(false);
    setError(null);

    registryRequest('join')
      .then((data) => callbacksRef.current.onRoomState?.({
        peers: (data.peers || []).map((peer: { peer_id: string }) => peer.peer_id).filter((id: string) => id !== peerId),
        hostPeerId: data.host_peer_id,
        roomSize: data.peers?.length || 1,
      }))
      .catch((error) => callbacksRef.current.onError?.(error instanceof Error ? error.message : 'Room registry unavailable'));
    startRegistryHeartbeat();

    // Start registry event polling every 800ms so separate app instances share the same room.
    pollTimerRef.current = setInterval(async () => {
      if (isPollingRef.current) return;
      isPollingRef.current = true;
      try {
        const res = await fetch('/api/signal/registry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'poll',
            roomCode: roomId,
            peerId,
            peerName,
            sinceId: lastEventIdRef.current,
          }),
        });
        const data = await res.json().catch(() => null);
        if (data && Array.isArray(data.messages)) {
          for (const msg of data.messages) {
            const msgId = Number(msg.id);
            if (Number.isFinite(msgId)) {
              if (processedEventIdsRef.current.has(msgId)) continue;
              processedEventIdsRef.current.add(msgId);
              if (processedEventIdsRef.current.size > 1000) {
                const first = processedEventIdsRef.current.values().next().value;
                if (first !== undefined) processedEventIdsRef.current.delete(first);
              }
              if (msgId > lastEventIdRef.current) {
                lastEventIdRef.current = msgId;
              }
            }
            handleMessage({ data: JSON.stringify(msg) } as MessageEvent);
          }
        }
      } catch (err) {
        // Transient poll error
      } finally {
        isPollingRef.current = false;
      }
    }, 800);
  }, [roomId, peerId, peerName, handleMessage, registryRequest, startRegistryHeartbeat, stopHttpPolling]);

  /**
   * Connect to signaling server
   */
  const connect = useCallback(() => {
    if (signalingUrl === 'registry') {
      startHttpPolling();
      return;
    }
    if (wsRef.current?.readyState === WebSocket.OPEN || wsRef.current?.readyState === WebSocket.CONNECTING) {
      return; // Already connecting or connected
    }

    setConnecting(true);
    setError(null);

    try {
      let fullUrl = signalingUrl;
      if (signalingUrl.startsWith('/')) {
        const protocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = typeof window !== 'undefined' ? window.location.host : 'localhost:3000';
        fullUrl = `${protocol}//${host}${signalingUrl}`;
      }

      console.log(`[useSignaling] Connecting via WebSocket to ${fullUrl}`);

      const ws = new WebSocket(fullUrl);

      // Connection timeout fallback to HTTP polling after 1.5 seconds if WebSocket is blocked
      const connectionTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          console.log('[useSignaling] WebSocket connection timeout, falling back to HTTP Polling');
          try { ws.close(); } catch {}
          if (wsRef.current === ws) {
            wsRef.current = null;
            startHttpPolling();
          }
        }
      }, 1500);

      ws.onopen = () => {
        clearTimeout(connectionTimeout);
        console.log('[useSignaling] Connected to signaling server via WebSocket');
        modeRef.current = 'ws';
        setConnected(true);
        setConnecting(false);
        setError(null);
        reconnectAttemptsRef.current = 0;

        // WebSocket remains the low-latency transport, while the shared registry
        // owns canonical room identity and peer expiry.
        registryRequest('join')
          .then((data) => {
            callbacksRef.current.onRoomState?.({
              peers: (data.peers || []).map((peer: { peer_id: string }) => peer.peer_id).filter((id: string) => id !== peerId),
              hostPeerId: data.host_peer_id,
              roomSize: data.peers?.length || 1,
            });
            startRegistryHeartbeat();
          })
          .catch((error) => callbacksRef.current.onError?.(error instanceof Error ? error.message : 'Room registry unavailable'));
        ws.send(
          JSON.stringify({
            type: 'join',
            roomId,
            peerId,
            isHost: callbacksRef.current.isHost,
            timestamp: Date.now(),
          })
        );

        flushMessageQueue();
        startHeartbeat();
      };

      ws.onmessage = handleMessage;

      ws.onerror = (event) => {
        clearTimeout(connectionTimeout);
        console.log('[useSignaling] WebSocket error, failing over to HTTP polling');
        if (wsRef.current === ws) {
          wsRef.current = null;
          startHttpPolling();
        }
      };

      ws.onclose = (evt) => {
        clearTimeout(connectionTimeout);
        stopHeartbeat();

        if (modeRef.current === 'ws' && wsRef.current === ws) {
          wsRef.current = null;
          console.log('[useSignaling] WebSocket closed, attempting HTTP fallback');
          startHttpPolling();
        }
      };

      wsRef.current = ws;
    } catch (err) {
      console.log('[useSignaling] WebSocket constructor failed, using HTTP polling:', err);
      startHttpPolling();
    }
  }, [
    signalingUrl,
    roomId,
    peerId,
    handleMessage,
    flushMessageQueue,
    startHeartbeat,
    stopHeartbeat,
    startHttpPolling,
  ]);

  connectRef.current = connect;

  /**
   * Disconnect from signaling server
   */
  const disconnect = useCallback(() => {
    const leaveMessage = { type: 'leave' as const, roomId, peerId, timestamp: Date.now() };
    if (modeRef.current === 'http') {
      fetch('/api/signal/registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'leave', roomCode: roomId, peerId }),
        keepalive: true,
      }).catch(() => {});
    } else if (wsRef.current?.readyState === WebSocket.OPEN) {
      try { wsRef.current.send(JSON.stringify(leaveMessage)); } catch {}
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    stopHeartbeat();
    stopHttpPolling();
    stopRegistryHeartbeat();

    if (wsRef.current) {
      const ws = wsRef.current;
      wsRef.current = null;
      ws.close();
    }

    setConnected(false);
    setConnecting(false);
    messageQueueRef.current = [];
    reconnectAttemptsRef.current = 0;
  }, [roomId, peerId, stopHeartbeat, stopHttpPolling, stopRegistryHeartbeat]);

  /**
   * Setup and teardown effects - only reconnect if roomId, peerId, or signalingUrl actually changes
   */
  useEffect(() => {
    if (autoConnect && roomId && peerId) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [roomId, peerId, signalingUrl, autoConnect]);

  // There is deliberately no database-backed presence or signal listener here.
  // WebSocket is preferred, with the bounded HTTP queue as a transient fallback.

  return {
    connected,
    connecting,
    error,
    sendSignal: sendMessage,
    sendOffer,
    sendAnswer,
    sendCandidate,
    disconnect,
  };
}
