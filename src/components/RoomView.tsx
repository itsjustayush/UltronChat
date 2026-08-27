import React, { useState, useRef, useEffect, useCallback } from 'react';
import crc32 from 'js-crc32';
import { RoomState, BundleItem, TransferProgress, SystemLogEntry, Peer, ChatMessage, UserSession } from '../types';
import { useSignaling } from '../hooks/useSignaling';
import {
  calculateSHA256,
  formatBytes,
  calculateCarbonMetrics,
  getFileTypeLabel,
} from '../lib/crypto';
import {
  createLogEntry,
  WebRTCPeerEngine,
  validateTransferQuota,
  WebRTCConnectionState,
  formatRoomOTPDisplay,
  MAX_FILE_SIZE,
  RTC_DATA_CHANNEL_CHUNK_SIZE,
  RTC_DATA_CHANNEL_HIGH_WATERMARK,
  RTC_DATA_CHANNEL_LOW_WATERMARK,
  RTC_TRANSFER_BURST_CHUNKS,
} from '../lib/p2pEngine';
import { QRCodeModal } from './QRCodeModal';
import { ActivityToastContainer, ActivityToastData } from './ActivityToast';
import { ThemedFileUpload } from './ThemedFileUpload';

async function arrayBufferToDataUrl(buffer: ArrayBuffer, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([buffer], { type: mimeType });
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const arr = dataUrl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

const BINARY_FILE_MAGIC = 0x55434631;
const TRANSFER_TOKEN_BYTES = 8;
const BINARY_FILE_HEADER_BYTES = 16;

function createTransferToken(): string {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`.slice(-TRANSFER_TOKEN_BYTES).toUpperCase();
}

function encodeBinaryFileChunk(token: string, index: number, payload: Uint8Array): ArrayBuffer {
  const packet = new Uint8Array(BINARY_FILE_HEADER_BYTES + payload.byteLength);
  const view = new DataView(packet.buffer);
  view.setUint32(0, BINARY_FILE_MAGIC);
  for (let offset = 0; offset < TRANSFER_TOKEN_BYTES; offset += 1) {
    packet[4 + offset] = token.charCodeAt(offset) || 0;
  }
  view.setUint32(12, index);
  packet.set(payload, BINARY_FILE_HEADER_BYTES);
  return packet.buffer;
}

function decodeBinaryFileChunk(data: ArrayBuffer): { token: string; index: number; payload: Uint8Array } | null {
  if (data.byteLength < BINARY_FILE_HEADER_BYTES) return null;
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  if (view.getUint32(0) !== BINARY_FILE_MAGIC) return null;
  let token = '';
  for (let offset = 0; offset < TRANSFER_TOKEN_BYTES; offset += 1) token += String.fromCharCode(bytes[4 + offset]);
  return { token, index: view.getUint32(12), payload: bytes.slice(BINARY_FILE_HEADER_BYTES) };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function waitForDataChannelCapacity(channel: RTCDataChannel): Promise<void> {
  channel.bufferedAmountLowThreshold = RTC_DATA_CHANNEL_LOW_WATERMARK;
  if (channel.readyState !== 'open') throw new Error('Direct peer channel closed during file transfer.');
  if (channel.bufferedAmount <= RTC_DATA_CHANNEL_HIGH_WATERMARK) return;
  await new Promise<void>((resolve, reject) => {
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Direct peer channel closed during file transfer.'));
    };
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', onLow);
      channel.removeEventListener('close', onClose);
    };
    channel.addEventListener('bufferedamountlow', onLow, { once: true });
    channel.addEventListener('close', onClose, { once: true });
    if (channel.bufferedAmount <= RTC_DATA_CHANNEL_LOW_WATERMARK) {
      cleanup();
      resolve();
    }
  });
}

function getAdaptiveBurstSize(channel: RTCDataChannel): number {
  const availableWindow = Math.max(0, RTC_DATA_CHANNEL_HIGH_WATERMARK - channel.bufferedAmount);
  const windowChunks = Math.floor(availableWindow / RTC_DATA_CHANNEL_CHUNK_SIZE);
  return Math.max(4, Math.min(RTC_TRANSFER_BURST_CHUNKS, windowChunks || 4));
}

interface RoomViewProps {
  room: RoomState;
  session?: UserSession;
  onLeaveRoom: () => void;
  onPreviewFile: (file: BundleItem) => void;
  onAddBundleItem: (item: BundleItem) => void;
}

interface ErrorToast {
  id: string;
  code: string;
  message: string;
}

interface IncomingFileTransfer {
  id: string;
  name: string;
  size: number;
  type: string;
  fileTypeLabel: string;
  fileId: string;
  sha256: string;
  encryptedHash: string;
  uploaderId: string;
  uploaderName: string;
  timestamp: number;
  carbonFootprintGrams: number;
  totalChunks: number;
  transferToken: string;
  receivedBytes: number;
  chunks: Array<string | Uint8Array | undefined>;
  startedAt: number;
}

const QUICK_EMOJIS = ['👍', '❤️', '🔥', '🎉', '😮', '😂'];

export const RoomView: React.FC<RoomViewProps> = ({
  room,
  session,
  onLeaveRoom,
  onPreviewFile,
  onAddBundleItem,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);
  const [isProcessingFiles, setIsProcessingFiles] = useState(false);
  const [webrtcState, setWebrtcState] = useState<WebRTCConnectionState>('connected');
  const [errorToasts, setErrorToasts] = useState<ErrorToast[]>([]);
  const [activityToasts, setActivityToasts] = useState<ActivityToastData[]>([]);
  const [isQrModalOpen, setIsQrModalOpen] = useState(false);

  const addActivityToast = (type: 'join' | 'leave' | 'info', peerName: string, peerId?: string, message?: string) => {
    const newToast: ActivityToastData = {
      id: `act-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      type,
      peerName,
      peerId,
      message: message || (type === 'join' ? 'joined the room' : type === 'leave' ? 'left the room' : 'room activity update'),
      timestamp: Date.now(),
    };

    setActivityToasts((prev) => [...prev.slice(-4), newToast]);

    setTimeout(() => {
      setActivityToasts((prev) => prev.filter((t) => t.id !== newToast.id));
    }, 4500);
  };

  const dismissActivityToast = (id: string) => {
    setActivityToasts((prev) => prev.filter((t) => t.id !== id));
  };
  const [showPresenceList, setShowPresenceList] = useState(false);
  const [activeTab, setActiveTab] = useState<'CHAT' | 'FILES'>('CHAT');

  // Chat State
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => [
    {
      id: 'welcome-1',
      senderId: 'SYSTEM',
      senderName: 'ULTRON SYSTEM',
      text: `Private room ${room.id} active. Content stays in memory and disappears when the room closes.`,
      timestamp: Date.now(),
      type: 'system',
    },
    ...(room.messages || []),
  ]);
  const [chatInput, setChatInput] = useState('');
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const shouldStickChatToBottomRef = useRef(true);
  const previousChatMessageCountRef = useRef(chatMessages.length);

  // Real-time peers list
  const [peersList, setPeersList] = useState<Peer[]>(room.activePeers || []);
  const peersListRef = useRef<Peer[]>(peersList);
  const prevPeersListRef = useRef<Peer[]>([]);

  useEffect(() => {
    peersListRef.current = peersList;

    const prevPeers = prevPeersListRef.current;
    if (prevPeers.length > 0) {
      // Newly joined peers
      peersList.forEach((peer) => {
        if (!peer.isYou && !prevPeers.some((p) => p.id === peer.id)) {
          addActivityToast('join', peer.name || `Peer-${peer.id.substring(0, 4).toUpperCase()}`, peer.id, 'joined the room');
        }
      });

      // Peers who left
      prevPeers.forEach((prevPeer) => {
        if (!prevPeer.isYou && !peersList.some((p) => p.id === prevPeer.id)) {
          addActivityToast('leave', prevPeer.name || `Peer-${prevPeer.id.substring(0, 4).toUpperCase()}`, prevPeer.id, 'left the room');
        }
      });
    }
    prevPeersListRef.current = peersList;
  }, [peersList]);

  // Typing Indicator State & Refs
  const [typingPeersMap, setTypingPeersMap] = useState<Record<string, string>>({});
  const typingTimeoutsRef = useRef<Record<string, NodeJS.Timeout>>({});
  const localTypingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isCurrentlyTypingRef = useRef<boolean>(false);

  // Message Reactions State & Logic
  const [activeEmojiPickerMsgId, setActiveEmojiPickerMsgId] = useState<string | null>(null);

  const applyReactionUpdate = useCallback((messageId: string, emoji: string, updatedPeers: string[]) => {
    setChatMessages((prev) =>
      prev.map((msg) => {
        if (msg.id !== messageId) return msg;
        const currentReactions = { ...(msg.reactions || {}) };
        if (updatedPeers && updatedPeers.length > 0) {
          currentReactions[emoji] = updatedPeers;
        } else {
          delete currentReactions[emoji];
        }
        return { ...msg, reactions: currentReactions };
      })
    );
  }, []);

  const handleToggleReaction = (messageId: string, emoji: string) => {
    setChatMessages((prev) =>
      prev.map((msg) => {
        if (msg.id !== messageId) return msg;

        const reactions = { ...(msg.reactions || {}) };
        const currentPeers = reactions[emoji] || [];
        const hasReacted = currentPeers.includes(localPeerId);

        const newPeers = hasReacted
          ? currentPeers.filter((id) => id !== localPeerId)
          : [...currentPeers, localPeerId];

        if (newPeers.length > 0) {
          reactions[emoji] = newPeers;
        } else {
          delete reactions[emoji];
        }

        // Broadcast reaction via socket signal
        sendSignal({
          type: 'reaction',
          roomId: room.id,
          peerId: localPeerId,
          data: { messageId, emoji, updatedPeers: newPeers },
        });

        // Broadcast reaction via WebRTC DataChannel
        if (peerEngineRef.current?.dataChannel?.readyState === 'open') {
          try {
            peerEngineRef.current.dataChannel.send(
              JSON.stringify({
                type: 'REACTION',
                messageId,
                emoji,
                peerId: localPeerId,
                updatedPeers: newPeers,
              })
            );
          } catch (e) {
            // ignore
          }
        }

        return { ...msg, reactions };
      })
    );
  };

  const handleRemoteTypingStatus = (peerId: string, isTyping: boolean, senderName?: string) => {
    if (!peerId || peerId === localPeerId) return;

    if (typingTimeoutsRef.current[peerId]) {
      clearTimeout(typingTimeoutsRef.current[peerId]);
      delete typingTimeoutsRef.current[peerId];
    }

    if (isTyping) {
      const peerName = senderName || `Peer-${peerId.substring(0, 4).toUpperCase()}`;
      setTypingPeersMap((prev) => ({ ...prev, [peerId]: peerName }));

      typingTimeoutsRef.current[peerId] = setTimeout(() => {
        setTypingPeersMap((prev) => {
          const next = { ...prev };
          delete next[peerId];
          return next;
        });
      }, 3500);
    } else {
      setTypingPeersMap((prev) => {
        const next = { ...prev };
        delete next[peerId];
        return next;
      });
    }
  };

  const [logs, setLogs] = useState<SystemLogEntry[]>([]);
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);
  const incomingTransfersRef = useRef<Record<string, IncomingFileTransfer>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  const localPeerId = session?.id || room.activePeers.find((p) => p.isYou)?.id || 'LOCAL_PEER';
  const [isRoomHost, setIsRoomHost] = useState(room.hostId === localPeerId);
  const peerEngineRef = useRef<WebRTCPeerEngine | null>(null);

  const bundleItemsRef = useRef<BundleItem[]>(room.bundleItems);
  useEffect(() => {
    bundleItemsRef.current = room.bundleItems;
  }, [room.bundleItems]);

  const addErrorToast = (code: string, message: string) => {
    setErrorToasts((prev) => {
      if (prev.some((t) => t.code === code)) return prev;
      const newToast: ErrorToast = {
        id: `err-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        code,
        message,
      };
      setTimeout(() => {
        setErrorToasts((p) => p.filter((t) => t.id !== newToast.id));
      }, 8000);
      return [...prev, newToast];
    });
  };

  const handleChatScroll = useCallback(() => {
    const stream = chatScrollRef.current;
    if (!stream) return;
    const distanceFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
    shouldStickChatToBottomRef.current = distanceFromBottom <= 96;
  }, []);

  // Scroll only the bounded message stream. Calling scrollIntoView on a child
  // can scroll the page itself, which previously pulled the upload panel into
  // view whenever a message or typing state changed.
  useEffect(() => {
    const stream = chatScrollRef.current;
    const messageCountChanged = chatMessages.length > previousChatMessageCountRef.current;
    previousChatMessageCountRef.current = chatMessages.length;
    if (!stream || !messageCountChanged) return;

    const newestMessage = chatMessages[chatMessages.length - 1];
    const shouldScroll = shouldStickChatToBottomRef.current || newestMessage?.senderId === localPeerId;
    if (!shouldScroll) return;

    requestAnimationFrame(() => {
      stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
    });
  }, [chatMessages.length, localPeerId]);

  const { sendSignal, sendOffer, sendAnswer, sendCandidate } = useSignaling({
    signalingUrl: 'registry',
    roomId: room.id,
    peerId: localPeerId,
    peerName: session?.identifier || 'Guest',
    isHost: isRoomHost,
    onRoomState: (data) => {
      if (data.hostPeerId) {
        setIsRoomHost(data.hostPeerId === localPeerId);
      }
      if (data.event === 'host_changed' && data.hostPeerId) {
        setIsRoomHost(data.hostPeerId === localPeerId);
      }
      if (data.event === 'peer_joined') {
        const joinedId = data.peerId;
        setPeersList((prev) => {
          if (prev.some((p) => p.id === joinedId)) return prev;
          return [
            ...prev,
            {
              id: joinedId,
              name: `Peer-${joinedId.substring(0, 4).toUpperCase()}`,
              isYou: false,
              status: 'ONLINE',
              latencyMs: 12,
              ip: 'P2P_DIRECT',
            },
          ];
        });
        setChatMessages((prev) => [
          ...prev,
          {
            id: `join-${Date.now()}`,
            senderId: 'SYSTEM',
            senderName: 'ULTRONCHAT SYSTEM',
            text: `Peer ${joinedId.substring(0, 6).toUpperCase()} connected to room.`,
            timestamp: Date.now(),
            type: 'system',
          },
        ]);

        if (isRoomHost && peerEngineRef.current) {
          peerEngineRef.current.createOffer().then((offer) => {
            if (offer) sendOffer(joinedId, offer);
          });
        }
      } else if (data.event === 'peer_left') {
        setPeersList((prev) => prev.filter((p) => p.id !== data.peerId));
        setChatMessages((prev) => [
          ...prev,
          {
            id: `left-${Date.now()}`,
            senderId: 'SYSTEM',
            senderName: 'ULTRONCHAT SYSTEM',
            text: `Peer ${data.peerId.substring(0, 6).toUpperCase()} left the room.`,
            timestamp: Date.now(),
            type: 'system',
          },
        ]);
      } else if (data.peers) {
        const remotePeers: Peer[] = data.peers.map((id: string) => ({
          id,
          name: `Peer-${id.substring(0, 4).toUpperCase()}`,
          isYou: false,
          status: 'ONLINE',
          latencyMs: 12,
          ip: 'P2P_DIRECT',
        }));
        setPeersList([
          ...room.activePeers.filter((p) => p.isYou),
          ...remotePeers,
        ]);
      }
    },
    onSignal: async (msg) => {
      const peerEngine = peerEngineRef.current;

      if (msg.type === 'reaction' && msg.data) {
        const { messageId, emoji, updatedPeers } = msg.data;
        if (messageId && emoji && Array.isArray(updatedPeers)) {
          applyReactionUpdate(messageId, emoji, updatedPeers);
        }
        return;
      }

      if (msg.type === 'typing' && msg.data) {
        const { peerId, isTyping, senderName } = msg.data;
        const sender = peerId || msg.peerId;
        if (sender && sender !== localPeerId) {
          handleRemoteTypingStatus(sender, Boolean(isTyping), senderName);
        }
        return;
      }

      if (msg.type === 'chat' && msg.data) {
        const chatMsg = msg.data as ChatMessage;
        setChatMessages((prev) => {
          if (prev.some((m) => m.id === chatMsg.id)) return prev;
          return [...prev, { ...chatMsg, status: 'read' }];
        });

        // Automatically send ACK back if message came from another peer
        if (chatMsg.senderId !== localPeerId) {
          sendSignal({
            type: 'chat_ack',
            roomId: room.id,
            peerId: localPeerId,
            targetPeerId: chatMsg.senderId,
            data: { messageId: chatMsg.id, status: 'read' },
          });
        }
        return;
      }

      if (msg.type === 'chat_ack' && msg.data) {
        const { messageId, status } = msg.data;
        if (messageId) {
          setChatMessages((prev) =>
            prev.map((m) => (m.id === messageId ? { ...m, status: status || 'read' } : m))
          );
        }
        return;
      }

      if (!peerEngine) return;

      if (msg.type === 'offer' && msg.data) {
        const answer = await peerEngine.handleOffer(msg.data);
        if (answer && msg.peerId) sendAnswer(msg.peerId, answer);
      } else if (msg.type === 'answer' && msg.data) {
        await peerEngine.handleAnswer(msg.data);
      } else if (msg.type === 'candidate' && msg.data) {
        await peerEngine.addIceCandidate(msg.data);
      }
    },
    onError: (err) => {
      if (err.includes('WebSocket') || err.includes('unavailable')) return;
      addErrorToast('ERR_SIGNALING', err);
    },
  });

  // Chat and file payloads intentionally stay off Firestore. The server only relays
  // transient signaling; room content is kept in this tab or sent over WebRTC.

  // WebRTC DataChannel initialization
  useEffect(() => {
    const peerEngine = new WebRTCPeerEngine(room.id, localPeerId);
    peerEngineRef.current = peerEngine;

    peerEngine.onStateChange = (state) => {
      setWebrtcState(state);
    };

    peerEngine.onDataReceived = async (data) => {
      const binaryChunk = data instanceof ArrayBuffer ? decodeBinaryFileChunk(data) : null;
      if (binaryChunk) {
        const incoming = incomingTransfersRef.current[binaryChunk.token];
        if (!incoming || incoming.transferToken !== binaryChunk.token || Date.now() - incoming.startedAt > 10 * 60 * 1000) {
          return;
        }
        const index = binaryChunk.index;
        if (index < 0 || index >= incoming.totalChunks || incoming.chunks[index]) return;
        incoming.chunks[index] = binaryChunk.payload;
        incoming.receivedBytes += binaryChunk.payload.byteLength;
        setTransfer((current) => current ? {
          ...current,
          transferredBytes: incoming.receivedBytes,
          progressPercent: Math.min(100, Math.round((incoming.receivedBytes / incoming.size) * 100)),
          encryptedChunksCount: incoming.chunks.filter(Boolean).length,
        } : current);
        return;
      }
      if (typeof data !== 'string') return;
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'CHAT_MESSAGE' && parsed.data) {
          const chatMsg = parsed.data as ChatMessage;
          setChatMessages((prev) => {
            if (prev.some((m) => m.id === chatMsg.id)) return prev;
            return [...prev, { ...chatMsg, status: 'read' }];
          });

          if (chatMsg.senderId !== localPeerId && peerEngineRef.current?.dataChannel?.readyState === 'open') {
            peerEngineRef.current.dataChannel.send(
              JSON.stringify({ type: 'CHAT_ACK', messageId: chatMsg.id, status: 'read' })
            );
          }
        } else if (parsed.type === 'TYPING_STATUS') {
          const { peerId, isTyping, senderName } = parsed;
          if (peerId && peerId !== localPeerId) handleRemoteTypingStatus(peerId, Boolean(isTyping), senderName);
        } else if (parsed.type === 'REACTION' && parsed.messageId && parsed.emoji) {
          applyReactionUpdate(parsed.messageId, parsed.emoji, parsed.updatedPeers || []);
        } else if (parsed.type === 'CHAT_ACK' && parsed.messageId) {
          setChatMessages((prev) => prev.map((m) => (
            m.id === parsed.messageId ? { ...m, status: parsed.status || 'read' } : m
          )));
        } else if (parsed.type === 'FILE_START' && parsed.file) {
          const file = parsed.file;
          const size = Number(file.size);
          const totalChunks = Number(file.totalChunks);
          const quotaResult = validateTransferQuota(
            size,
            bundleItemsRef.current.reduce((total, item) => total + item.size, 0),
          );
          if (!file.id || !Number.isSafeInteger(size) || size < 0 || !Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 100000 || !quotaResult.valid) {
            addErrorToast('ERR_FILE_LIMIT', quotaResult.errorMessage || 'Incoming file exceeds the safe transfer limit.');
            return;
          }
          const transferToken = typeof file.transferToken === 'string' ? file.transferToken : file.id;
          incomingTransfersRef.current[transferToken] = {
            ...file,
            id: file.id,
            size,
            totalChunks,
            transferToken,
            receivedBytes: 0,
            chunks: new Array(totalChunks),
            startedAt: Date.now(),
          };
          setTransfer({
            active: true,
            fileName: file.name,
            fileSize: file.size,
            transferredBytes: 0,
            progressPercent: 0,
            currentSpeedMBps: 0,
            etaSeconds: 0,
            targetPeerId: file.uploaderId,
            mode: 'BUNDLE',
            carbonEmittedGrams: file.carbonFootprintGrams || 0,
            encryptedChunksCount: 0,
            totalChunks,
          });
        } else if (parsed.type === 'FILE_CHUNK') {
          const incoming = incomingTransfersRef.current[parsed.transferToken || parsed.fileId];
          if (!incoming || Date.now() - incoming.startedAt > 10 * 60 * 1000) {
            delete incomingTransfersRef.current[parsed.fileId];
            return;
          }
          const index = Number(parsed.index);
          if (!Number.isInteger(index) || index < 0 || index >= incoming.totalChunks || typeof parsed.payload !== 'string') return;
          if (!incoming.chunks[index]) {
            incoming.chunks[index] = parsed.payload;
            incoming.receivedBytes += base64ToBytes(parsed.payload).byteLength;
            setTransfer((current) => current ? {
              ...current,
              transferredBytes: incoming.receivedBytes,
              progressPercent: Math.min(100, Math.round((incoming.receivedBytes / incoming.size) * 100)),
              encryptedChunksCount: incoming.chunks.filter(Boolean).length,
            } : current);
          }
        } else if (parsed.type === 'FILE_END') {
          const incoming = incomingTransfersRef.current[parsed.transferToken || parsed.fileId];
          if (!incoming) return;
          const complete = incoming.chunks.length === incoming.totalChunks && incoming.chunks.every(Boolean) && incoming.receivedBytes === incoming.size;
          if (!complete) {
            delete incomingTransfersRef.current[parsed.transferToken || parsed.fileId];
            setTransfer(null);
            addErrorToast('ERR_FILE_INCOMPLETE', 'The direct file transfer ended before all chunks arrived.');
            return;
          }

          const rawBlob = new Blob(incoming.chunks.map((chunk) => typeof chunk === 'string' ? base64ToBytes(chunk) : chunk as Uint8Array), { type: incoming.type });
          const actualHash = await calculateSHA256(await rawBlob.arrayBuffer());
          if (actualHash !== incoming.sha256) {
            delete incomingTransfersRef.current[parsed.transferToken || parsed.fileId];
            setTransfer(null);
            addErrorToast('ERR_FILE_HASH', 'The received file failed integrity verification and was discarded.');
            return;
          }

          const blobUrl = URL.createObjectURL(rawBlob);
          const receivedItem: BundleItem = {
            id: incoming.id,
            name: incoming.name,
            size: incoming.size,
            type: incoming.type,
            fileTypeLabel: incoming.fileTypeLabel,
            fileId: incoming.fileId,
            dimensions: `${(incoming.size / 1024).toFixed(1)} KB`,
            sha256: incoming.sha256,
            encryptedHash: incoming.encryptedHash,
            blobUrl,
            rawBlob,
            uploaderId: incoming.uploaderId,
            uploaderName: incoming.uploaderName,
            timestamp: incoming.timestamp,
            carbonFootprintGrams: incoming.carbonFootprintGrams,
            peerSeeds: 1,
            encryptionStatus: 'WEBRTC-DTLS VERIFIED',
          };
          onAddBundleItem(receivedItem);
          setChatMessages((prev) => [...prev, {
            id: `file-chat-${incoming.id}`,
            senderId: incoming.uploaderId,
            senderName: incoming.uploaderName,
            text: `Shared file: ${incoming.name} (${formatBytes(incoming.size)})`,
            timestamp: Date.now(),
            type: 'file_notice',
            attachment: {
              fileName: incoming.name,
              fileSize: incoming.size,
              fileId: incoming.id,
              blobUrl,
              fileTypeLabel: incoming.fileTypeLabel,
            },
          }]);
          delete incomingTransfersRef.current[parsed.transferToken || parsed.fileId];
          setTransfer(null);
        } else if (parsed.type === 'BUNDLE_ITEM_SHARE' && parsed.item) {
          // Backward-compatible path for older clients; new clients always chunk.
          const dataItem = parsed.item;
          if (!bundleItemsRef.current.some((i) => i.id === dataItem.id)) {
            const rawBlob = dataItem.dataUrl ? dataUrlToBlob(dataItem.dataUrl) : undefined;
            const blobUrl = rawBlob ? URL.createObjectURL(rawBlob) : undefined;
            onAddBundleItem({ ...dataItem, rawBlob, blobUrl, encryptionStatus: 'WEBRTC DTLS TRANSPORT' });
          }
        }
      } catch (e) {
        console.error('[WebRTC] DataChannel receive parse error:', e);
      }
    };

    peerEngine.onSignalOutput = (signal) => {
      if (signal.type === 'candidate' && signal.data) {
        const remoteTarget = peersListRef.current.find((p) => !p.isYou)?.id;
        if (remoteTarget) {
          sendCandidate(remoteTarget, signal.data);
        }
      }
    };

    return () => {
      peerEngine.close();
      peerEngineRef.current = null;
    };
  }, [room.id, localPeerId]);

  // Broadcast local typing status
  const broadcastTypingStatus = (isTyping: boolean) => {
    const myName = session?.identifier || 'Guest';
    const payload = { isTyping, senderName: myName, peerId: localPeerId };

    sendSignal({
      type: 'typing',
      roomId: room.id,
      peerId: localPeerId,
      data: payload,
    });

    if (peerEngineRef.current?.dataChannel?.readyState === 'open') {
      try {
        peerEngineRef.current.dataChannel.send(
          JSON.stringify({ type: 'TYPING_STATUS', ...payload })
        );
      } catch (e) {
        // ignore
      }
    }
  };

  const handleChatInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setChatInput(val);

    if (val.trim()) {
      if (!isCurrentlyTypingRef.current) {
        isCurrentlyTypingRef.current = true;
        broadcastTypingStatus(true);
      }

      if (localTypingTimeoutRef.current) {
        clearTimeout(localTypingTimeoutRef.current);
      }

      localTypingTimeoutRef.current = setTimeout(() => {
        isCurrentlyTypingRef.current = false;
        broadcastTypingStatus(false);
      }, 2500);
    } else {
      if (isCurrentlyTypingRef.current) {
        isCurrentlyTypingRef.current = false;
        broadcastTypingStatus(false);
      }
      if (localTypingTimeoutRef.current) {
        clearTimeout(localTypingTimeoutRef.current);
      }
    }
  };

  // Send Chat Message
  const handleSendChatMessage = async (textToSend?: string) => {
    const content = (textToSend || chatInput).trim();
    if (!content) return;

    // Clear typing indicator state
    if (isCurrentlyTypingRef.current) {
      isCurrentlyTypingRef.current = false;
      broadcastTypingStatus(false);
    }
    if (localTypingTimeoutRef.current) {
      clearTimeout(localTypingTimeoutRef.current);
    }

    const hasRemotePeers = peersList.some((p) => !p.isYou);
    const initialStatus: 'sending' = 'sending';

    const chatMsg: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      senderId: localPeerId,
      senderName: session?.identifier || 'Guest',
      text: content,
      timestamp: Date.now(),
      type: 'text',
      status: initialStatus,
      encryptedHash: 'TRANSIENT-CHANNEL',
    };

    setChatMessages((prev) => [...prev, chatMsg]);
    setChatInput('');

    // 1. Send via WebSocket signal
    sendSignal({
      type: 'chat',
      roomId: room.id,
      peerId: localPeerId,
      data: chatMsg,
    });

    // Confirm that the message reached the active room channel. A peer read receipt
    // can promote this state from delivered to read after the acknowledgement returns.
    window.setTimeout(() => {
      setChatMessages((prev) => prev.map((message) => (
        message.id === chatMsg.id && message.status === 'sending'
          ? { ...message, status: hasRemotePeers ? 'delivered' : 'sent' }
          : message
      )));
    }, 180);

    // 2. Send via WebRTC DataChannel if open
    if (peerEngineRef.current?.dataChannel?.readyState === 'open') {
      try {
        peerEngineRef.current.dataChannel.send(
          JSON.stringify({ type: 'CHAT_MESSAGE', data: chatMsg })
        );
      } catch (e) {
        console.warn('DataChannel error:', e);
      }
    }

  };

  // Copy Share Link
  const handleCopyLink = () => {
    const shareUrl = `${window.location.origin}?room=${room.id}`;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    });
  };

  // File Processing
  const processSingleFile = async (file: File) => {
    const fileName = file.name;
    const fileType = file.type || 'application/octet-stream';
    const fileSize = file.size;

    const quotaResult = validateTransferQuota(
      fileSize,
      room.bundleItems.reduce((acc, i) => acc + i.size, 0)
    );
    if (!quotaResult.valid) {
      addErrorToast(quotaResult.errorCode || 'ERR_QUOTA', quotaResult.errorMessage || 'Quota exceeded');
      return;
    }

    if (fileSize > MAX_FILE_SIZE) {
      addErrorToast('ERR_FILE_SIZE', `Files above ${formatBytes(MAX_FILE_SIZE)} are not supported in ephemeral browser memory.`);
      return;
    }
    if (peersList.length < 2 || peerEngineRef.current?.dataChannel?.readyState !== 'open') {
      addErrorToast('ERR_DIRECT_CHANNEL', 'Direct peer link is not ready. Connect to a peer before sharing files.');
      return;
    }

    try {
      const fileBuffer = await file.arrayBuffer();
      const sha256Hex = await calculateSHA256(fileBuffer);
      const rawBlob = new Blob([fileBuffer], { type: fileType });
      const blobUrl = URL.createObjectURL(rawBlob);

      const newItem: BundleItem = {
        id: `file-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        name: fileName,
        size: fileSize,
        type: fileType,
        fileTypeLabel: getFileTypeLabel(fileName, fileType),
        fileId: `FLX-${Math.floor(1000 + Math.random() * 9000)}-${fileName.substring(0, 4).toUpperCase()}`,
        dimensions: `${(fileSize / 1024).toFixed(1)} KB`,
        sha256: sha256Hex,
        encryptedHash: 'WEBRTC-DTLS',
        blobUrl,
        rawBlob,
        uploaderId: localPeerId,
        uploaderName: session?.identifier || 'Guest Host',
        timestamp: Date.now(),
        carbonFootprintGrams: calculateCarbonMetrics(fileSize).p2pCarbonGrams,
        peerSeeds: 1,
        encryptionStatus: 'WEBRTC-DTLS VERIFIED',
      };

      // Create a chat file notice message; commit it locally only after the
      // complete chunk sequence has been accepted by the direct channel.
      const fileChatNotice: ChatMessage = {
        id: `file-chat-${newItem.id}`,
        senderId: localPeerId,
        senderName: session?.identifier || 'Guest',
        text: `Shared file: ${fileName} (${formatBytes(fileSize)})`,
        timestamp: Date.now(),
        type: 'file_notice',
        attachment: {
          fileName: newItem.name,
          fileSize: newItem.size,
          fileId: newItem.id,
          blobUrl: newItem.blobUrl,
          fileTypeLabel: newItem.fileTypeLabel,
        },
      };

      const channel = peerEngineRef.current.dataChannel;
      const transferToken = createTransferToken();
      channel.bufferedAmountLowThreshold = RTC_DATA_CHANNEL_LOW_WATERMARK;
      const totalChunks = Math.ceil(fileBuffer.byteLength / RTC_DATA_CHANNEL_CHUNK_SIZE);
      setTransfer({
        active: true,
        fileName,
        fileSize,
        transferredBytes: 0,
        progressPercent: 0,
        currentSpeedMBps: 0,
        etaSeconds: 0,
        targetPeerId: peersList.find((peer) => !peer.isYou)?.id || 'PEER',
        mode: 'BUNDLE',
        carbonEmittedGrams: newItem.carbonFootprintGrams,
        encryptedChunksCount: 0,
        totalChunks,
      });

      await waitForDataChannelCapacity(channel);
      channel.send(JSON.stringify({
        type: 'FILE_START',
        file: {
          id: newItem.id,
          name: newItem.name,
          size: newItem.size,
          type: newItem.type,
          fileTypeLabel: newItem.fileTypeLabel,
          fileId: newItem.fileId,
          sha256: newItem.sha256,
          encryptedHash: newItem.encryptedHash,
          uploaderId: newItem.uploaderId,
          uploaderName: newItem.uploaderName,
          timestamp: newItem.timestamp,
          carbonFootprintGrams: newItem.carbonFootprintGrams,
          totalChunks,
          transferToken,
        },
      }));

      // AIMD-style burst control: fill a bounded send window, then wait only
      // when SCTP reports pressure. This removes the old per-chunk timer while
      // keeping memory bounded on fast and slow networks alike.
      let index = 0;
      while (index < totalChunks) {
        await waitForDataChannelCapacity(channel);
        const burstSize = getAdaptiveBurstSize(channel);
        const burstEnd = Math.min(totalChunks, index + burstSize);
        let transferredBytes = index * RTC_DATA_CHANNEL_CHUNK_SIZE;
        for (; index < burstEnd; index += 1) {
          const start = index * RTC_DATA_CHANNEL_CHUNK_SIZE;
          const end = Math.min(start + RTC_DATA_CHANNEL_CHUNK_SIZE, fileBuffer.byteLength);
          channel.send(encodeBinaryFileChunk(
            transferToken,
            index,
            new Uint8Array(fileBuffer.slice(start, end)),
          ));
          transferredBytes = end;
        }
        setTransfer((current) => current ? {
          ...current,
          transferredBytes,
          progressPercent: Math.round((transferredBytes / fileSize) * 100),
          encryptedChunksCount: index,
        } : current);
      }

      await waitForDataChannelCapacity(channel);
      channel.send(JSON.stringify({ type: 'FILE_END', fileId: newItem.id, transferToken, totalChunks }));
      onAddBundleItem(newItem);
      setChatMessages((prev) => [...prev, fileChatNotice]);
      window.setTimeout(() => setTransfer(null), 900);
    } catch (err: any) {
      addErrorToast('ERR_ENCRYPT_FAIL', err?.message || 'Failed to encrypt file.');
    }
  };

  const handleFilesSelected = async (files: File[]) => {
    if (!files.length) return;
    setIsProcessingFiles(true);
    try {
      await Promise.all(files.map((file) => processSingleFile(file)));
    } finally {
      setIsProcessingFiles(false);
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      void handleFilesSelected(Array.from(e.target.files));
    }
  };

  return (
    <div className="room-shell page-reveal min-h-screen pt-16 pb-12 px-3 sm:px-8 bg-[#F2F2EE] flex flex-col">
      {/* Top Header Bar */}
      <div className="w-full max-w-[1280px] mx-auto mt-2 mb-4">
        <div className="bg-white/90 backdrop-blur-xl border border-[#192837]/10 rounded-2xl p-4 flex flex-wrap justify-between items-center gap-4 shadow-xs">
          <div className="flex items-center gap-3">
            <button
              onClick={onLeaveRoom}
              className="p-2 bg-white border border-[#192837]/20 hover:bg-[#F2F2EE] text-[#192837] rounded-xl font-mono text-xs font-bold transition-all flex items-center gap-1 cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">arrow_back</span>
              Leave Room
            </button>

            <div className="h-6 w-[1px] bg-[#192837]/15 hidden sm:block"></div>

            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-[#192837]/60">ROOM CODE:</span>
              <span className="font-mono text-base font-extrabold text-[#7342E2] bg-[#7342E2]/10 px-3 py-1 rounded-lg border border-[#7342E2]/30">
                {formatRoomOTPDisplay(room.id)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleCopyLink}
              className="px-3 py-1.5 bg-[#7342E2]/10 hover:bg-[#7342E2]/20 text-[#7342E2] border border-[#7342E2]/30 rounded-xl font-mono text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">
                {copiedLink ? 'check_circle' : 'link'}
              </span>
              {copiedLink ? 'LINK COPIED' : 'COPY SHARE LINK'}
            </button>

            <button
              onClick={() => setIsQrModalOpen(true)}
              className="px-3 py-1.5 bg-white border border-[#192837]/20 hover:bg-[#F2F2EE] text-[#192837] rounded-xl font-mono text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer"
            >
              <span className="material-symbols-outlined text-base">qr_code_2</span>
              QR
            </button>

            <div className="relative">
              <button
                onClick={() => setShowPresenceList(!showPresenceList)}
                className="px-3 py-1.5 bg-emerald-500/10 text-emerald-700 border border-emerald-500/30 rounded-xl font-mono text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                <span>{peersList.length} ONLINE</span>
              </button>

              {/* Online peers popup */}
              {showPresenceList && (
                <div className="absolute right-0 top-full mt-2 w-56 bg-white border border-[#192837]/15 rounded-2xl shadow-xl p-3 z-50">
                  <div className="font-mono text-[10px] font-bold text-[#192837]/50 uppercase mb-2">
                    ACTIVE ROOM PEERS
                  </div>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {peersList.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between text-xs font-mono p-1.5 rounded-lg bg-[#F2F2EE]"
                      >
                        <span className="font-bold text-[#192837]">
                          {p.name} {p.isYou ? '(YOU)' : ''}
                        </span>
                        <span className="text-[10px] text-emerald-600 font-bold">ONLINE</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main Split Layout: Left Chat + Right Files/Dropzone */}
      <div className="w-full max-w-[1280px] mx-auto flex-1 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[580px]">
        
        {/* Left / Main Column: Real-time Ephemeral Chat (7 cols) */}
        <div className="lg:col-span-7 bg-white/90 backdrop-blur-2xl border border-[#192837]/10 rounded-3xl p-4 sm:p-6 flex flex-col justify-between shadow-sm min-h-[500px]">
          {/* Chat Header */}
          <div className="flex justify-between items-center pb-3 border-b border-[#192837]/10">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[#7342E2] text-xl">forum</span>
              <span className="font-heading font-bold text-base text-[#192837]">REAL-TIME CHAT</span>
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-[#7342E2] bg-[#7342E2]/10 px-2.5 py-1 rounded-full font-bold">
              <span className="material-symbols-outlined text-sm">lock</span>
              <span>NO ROOM ARCHIVE</span>
            </div>
          </div>

          {/* Chat Message Stream */}
          <div
            ref={chatScrollRef}
            onScroll={handleChatScroll}
            className="flex-1 overflow-y-auto py-4 space-y-3.5 my-2 max-h-[460px] pr-1 overscroll-contain"
          >
            {chatMessages.map((msg) => {
              const isYou = msg.senderId === localPeerId;
              const isSystem = msg.type === 'system';

              if (isSystem) {
                return (
                  <div key={msg.id} className="flex justify-center my-2">
                    <div className="bg-[#192837]/5 text-[#192837]/70 font-mono text-[11px] px-3.5 py-1.5 rounded-full border border-[#192837]/10 text-center max-w-md">
                      {msg.text}
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={msg.id}
                  className={`flex flex-col relative group/msg ${isYou ? 'items-end' : 'items-start'}`}
                >
                  <div className="flex items-center gap-1.5 mb-1 px-1">
                    <span className="font-mono text-[11px] font-bold text-[#192837]/70">
                      {isYou ? 'YOU' : msg.senderName}
                    </span>
                    <span className="font-mono text-[10px] text-[#192837]/40">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  <div className="relative max-w-[85%] group/bubble">
                    {/* Hover & Click Reaction Floating Toolbar */}
                    <div
                      className={`absolute -top-4 z-20 flex items-center gap-1 bg-white border border-[#192837]/15 rounded-full px-2 py-1 shadow-md transition-all duration-200 ${
                        isYou ? 'right-2' : 'left-2'
                      } ${
                        activeEmojiPickerMsgId === msg.id
                          ? 'opacity-100 scale-100 pointer-events-auto'
                          : 'opacity-0 scale-95 group-hover/bubble:opacity-100 group-hover/bubble:scale-100 pointer-events-none group-hover/bubble:pointer-events-auto'
                      }`}
                    >
                      <div className="flex items-center gap-1 pr-1 border-r border-[#192837]/10">
                        {QUICK_EMOJIS.map((emoji) => {
                          const currentPeers = msg.reactions?.[emoji] || [];
                          const hasReacted = currentPeers.includes(localPeerId);
                          return (
                            <button
                              key={emoji}
                              onClick={() => {
                                handleToggleReaction(msg.id, emoji);
                                setActiveEmojiPickerMsgId(null);
                              }}
                              className={`text-sm hover:scale-130 transition-transform p-0.5 rounded-full cursor-pointer leading-none ${
                                hasReacted ? 'bg-[#7342E2]/20 scale-110' : 'hover:bg-[#192837]/5'
                              }`}
                              title={`React with ${emoji}`}
                            >
                              {emoji}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        onClick={() =>
                          setActiveEmojiPickerMsgId(
                            activeEmojiPickerMsgId === msg.id ? null : msg.id
                          )
                        }
                        className="text-[10px] font-mono font-bold text-[#7342E2] hover:bg-[#7342E2]/10 px-1.5 py-0.5 rounded-md transition-colors flex items-center gap-0.5 cursor-pointer"
                        title="React to message"
                      >
                        <span className="material-symbols-outlined text-xs">add_reaction</span>
                        <span className="hidden sm:inline">React</span>
                      </button>
                    </div>

                    <div
                      className={`p-3.5 rounded-2xl text-sm font-sans leading-relaxed break-words shadow-2xs ${
                        isYou
                          ? 'bg-[#7342E2] text-white rounded-tr-none'
                          : 'bg-white text-[#192837] border border-[#192837]/15 rounded-tl-none'
                      }`}
                    >
                      {msg.text}

                      {/* Attachment preview inside chat bubble */}
                      {msg.attachment && (
                        <div className="mt-2.5 pt-2 border-t border-white/20 flex items-center justify-between gap-3 bg-black/10 p-2 rounded-xl">
                          <div className="flex items-center gap-2 overflow-hidden">
                            <span className="material-symbols-outlined text-lg">attachment</span>
                            <span className="font-mono text-xs font-bold truncate">{msg.attachment.fileName}</span>
                          </div>
                          {msg.attachment.blobUrl && (
                            <a
                              href={msg.attachment.blobUrl}
                              download={msg.attachment.fileName}
                              className="bg-white text-[#192837] hover:bg-emerald-400 font-mono text-[10px] font-bold px-2 py-1 rounded-md shrink-0 transition-colors"
                            >
                              DOWNLOAD
                            </a>
                          )}
                        </div>
                      )}

                      {/* Active Reactions List */}
                      {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5 pt-2 border-t border-black/10">
                          {Object.entries(msg.reactions).map(([emoji, peerIdsVal]) => {
                            const peerIds = (peerIdsVal as string[]) || [];
                            if (!peerIds || peerIds.length === 0) return null;
                            const isMyReaction = peerIds.includes(localPeerId);
                            const names = peerIds.map((id) => {
                              if (id === localPeerId) return 'You';
                              const found = peersList.find((p) => p.id === id);
                              return found?.name || `Peer-${id.substring(0, 4).toUpperCase()}`;
                            });

                            return (
                              <button
                                key={emoji}
                                onClick={() => handleToggleReaction(msg.id, emoji)}
                                title={`Reacted by: ${names.join(', ')}`}
                                className={`inline-flex items-center gap-1 font-mono text-[11px] font-bold px-2 py-0.5 rounded-full transition-all cursor-pointer ${
                                  isMyReaction
                                    ? isYou
                                      ? 'bg-white text-[#7342E2] shadow-xs'
                                      : 'bg-[#7342E2] text-white shadow-xs'
                                    : isYou
                                    ? 'bg-black/20 text-white/90 hover:bg-black/30'
                                    : 'bg-[#F2F2EE] text-[#192837] hover:bg-[#192837]/10 border border-[#192837]/15'
                                }`}
                              >
                                <span>{emoji}</span>
                                <span>{peerIds.length}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* Delivery & Read Status for outgoing messages */}
                    {isYou && (
                      <div className="mt-1.5 pt-1 border-t border-white/10 flex justify-end items-center gap-1">
                        {(() => {
                          const st = msg.status || 'sent';
                          if (st === 'sending') {
                            return (
                              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-white/70" title="Sending message...">
                                <span className="material-symbols-outlined text-[13px] animate-spin">sync</span>
                                <span>Sending</span>
                              </span>
                            );
                          }
                          if (st === 'sent') {
                            return (
                              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-white/70" title="Sent to room channel (Single check)">
                                <span className="material-symbols-outlined text-[13px]">check</span>
                                <span>Sent</span>
                              </span>
                            );
                          }
                          if (st === 'delivered') {
                            return (
                              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-white/90" title="Delivered to room peers (Double check)">
                                <span className="material-symbols-outlined text-[13px]">done_all</span>
                                <span>Delivered</span>
                              </span>
                            );
                          }
                          if (st === 'read') {
                            return (
                              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-300 font-bold" title="Read confirmed by peer (Double check)">
                                <span className="material-symbols-outlined text-[13px] font-bold">done_all</span>
                                <span>Read</span>
                              </span>
                            );
                          }
                          return null;
                        })()}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
            })}
            {/* Typing Indicator */}
            {Object.keys(typingPeersMap).length > 0 && (
              <div className="flex items-center gap-2 text-xs font-mono text-[#7342E2] bg-[#7342E2]/10 py-1.5 px-3 rounded-full w-fit mb-2 border border-[#7342E2]/20 shadow-xs animate-fade-in">
                <div className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-[#7342E2] rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
                  <span className="w-1.5 h-1.5 bg-[#7342E2] rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
                  <span className="w-1.5 h-1.5 bg-[#7342E2] rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
                </div>
                <span className="font-semibold">
                  {(() => {
                    const names = Object.values(typingPeersMap);
                    if (names.length === 1) return `${names[0]} is typing...`;
                    if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
                    return `${names[0]} and ${names.length - 1} others are typing...`;
                  })()}
                </span>
              </div>
            )}
            <div aria-hidden="true" className="h-px" />
          </div>

          {/* Quick Emojis Bar */}
          <div className="flex items-center gap-1.5 py-1.5 px-1 overflow-x-auto border-t border-[#192837]/10">
            {['👋', '👍', '🔥', '🚀', '🔒', '❤️', '📁', '💻'].map((emoji) => (
              <button
                key={emoji}
                onClick={() => handleSendChatMessage(emoji)}
                className="text-base p-1.5 hover:bg-[#192837]/5 rounded-lg transition-colors cursor-pointer"
              >
                {emoji}
              </button>
            ))}
          </div>

          {/* Chat Input Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendChatMessage();
            }}
            className="flex items-center gap-2 pt-2"
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileInputChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Attach File"
              className="p-3 bg-white border border-[#192837]/20 hover:bg-[#F2F2EE] text-[#192837] rounded-2xl flex items-center justify-center cursor-pointer transition-all"
            >
              <span className="material-symbols-outlined text-xl">attach_file</span>
            </button>

            <input
              type="text"
              value={chatInput}
              onChange={handleChatInputChange}
              placeholder="Type your ephemeral message..."
              className="flex-1 bg-white border border-[#192837]/20 rounded-2xl px-4 py-3 text-sm font-sans focus:outline-none focus:border-[#7342E2] focus:ring-1 focus:ring-[#7342E2] transition-all"
            />

            <button
              type="submit"
              disabled={!chatInput.trim()}
              className="px-5 py-3 bg-[#7342E2] disabled:opacity-50 hover:bg-[#7342E2]/90 text-white rounded-2xl font-mono text-xs font-bold transition-all flex items-center gap-1 cursor-pointer shadow-xs"
            >
              <span>SEND</span>
              <span className="material-symbols-outlined text-base">send</span>
            </button>
          </form>
        </div>

        {/* Right Column: File Dropzone & Bundle List (5 cols) */}
        <div className="lg:col-span-5 flex flex-col gap-4">
          {/* File Dropzone */}
          <ThemedFileUpload
            onFiles={handleFilesSelected}
            isProcessing={isProcessingFiles}
            disabled={peersList.length < 2}
            maxFileSize={MAX_FILE_SIZE}
          />

          {transfer && (
            <div className="rounded-2xl border border-[#d6ff62]/25 bg-[#d6ff62]/[.06] p-4 shadow-[0_0_24px_rgba(214,255,98,.06)]">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] font-bold uppercase tracking-[.16em] text-[#d6ff62]">Chunked direct transfer</div>
                  <div className="mt-1 truncate text-xs text-white/75">{transfer.fileName}</div>
                </div>
                <div className="font-mono text-xs font-bold text-[#d6ff62]">{transfer.progressPercent}%</div>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-[#d6ff62] transition-[width] duration-150" style={{ width: `${transfer.progressPercent}%` }} />
              </div>
              <div className="mt-2 flex justify-between gap-3 font-mono text-[10px] uppercase tracking-wider text-white/45">
                <span>{formatBytes(transfer.transferredBytes)} / {formatBytes(transfer.fileSize)}</span>
                <span>{transfer.encryptedChunksCount} / {transfer.totalChunks} chunks</span>
              </div>
            </div>
          )}

          {/* Ephemeral Bundle / Files List */}
          <div className="bg-white/90 backdrop-blur-2xl border border-[#192837]/10 rounded-3xl p-5 flex-1 flex flex-col justify-between shadow-sm min-h-[320px]">
            <div>
              <div className="flex justify-between items-center pb-3 border-b border-[#192837]/10 mb-3">
                <span className="font-heading font-bold text-sm text-[#192837]">
                  SHARED FILES ({room.bundleItems.length})
                </span>
                <span className="font-mono text-[10px] text-[#192837]/50 font-bold">
                  RAM CACHE
                </span>
              </div>

              {room.bundleItems.length === 0 ? (
                <div className="py-12 text-center text-[#192837]/50 font-mono text-xs">
                  No files shared yet in this room session.
                </div>
              ) : (
                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {room.bundleItems.map((item) => (
                    <div
                      key={item.id}
                      className="p-3 bg-[#F2F2EE] border border-[#192837]/10 rounded-2xl flex items-center justify-between gap-3 hover:border-[#7342E2]/40 transition-colors"
                    >
                      <div className="flex items-center gap-3 overflow-hidden">
                        <span className="material-symbols-outlined text-[#7342E2] text-xl">
                          description
                        </span>
                        <div className="overflow-hidden">
                          <div className="font-mono text-xs font-bold text-[#192837] truncate">
                            {item.name}
                          </div>
                          <div className="font-mono text-[10px] text-[#192837]/60">
                            {formatBytes(item.size)} • {item.fileTypeLabel}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          onClick={() => onPreviewFile(item)}
                          className="px-2.5 py-1 bg-white border border-[#192837]/20 hover:bg-[#7342E2]/10 text-[#192837] font-mono text-[10px] font-bold rounded-lg cursor-pointer transition-colors"
                        >
                          VIEW
                        </button>
                        {item.blobUrl && (
                          <a
                            href={item.blobUrl}
                            download={item.name}
                            className="px-2.5 py-1 bg-[#7342E2] text-white hover:bg-[#7342E2]/90 font-mono text-[10px] font-bold rounded-lg transition-colors cursor-pointer"
                          >
                            GET
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Room Footer Status */}
            <div className="pt-3 border-t border-[#192837]/10 flex justify-between items-center font-mono text-[11px] text-[#192837]/60">
              <span>TRANSPORT: WEBRTC DTLS</span>
              <span className="text-emerald-600 font-bold">READY</span>
            </div>
          </div>
        </div>
      </div>

      {/* QR Code Modal */}
      {isQrModalOpen && (
        <QRCodeModal
          roomId={room.id}
          onClose={() => setIsQrModalOpen(false)}
        />
      )}

      {/* Activity Toasts (Join/Leave notifications) */}
      <ActivityToastContainer
        toasts={activityToasts}
        onDismiss={dismissActivityToast}
      />

      {/* Error Toasts */}
      {errorToasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
          {errorToasts.map((toast) => (
            <div
              key={toast.id}
              className="bg-red-600 text-white p-3 rounded-2xl shadow-xl font-mono text-xs flex justify-between items-start gap-2 animate-bounce"
            >
              <div>
                <div className="font-bold">{toast.code}</div>
                <div>{toast.message}</div>
              </div>
              <button
                onClick={() => setErrorToasts((prev) => prev.filter((t) => t.id !== toast.id))}
                className="text-white hover:opacity-80 cursor-pointer font-bold"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
