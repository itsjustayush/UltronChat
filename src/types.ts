export type ViewMode = 'AUTH' | 'DASHBOARD' | 'ROOM' | 'HISTORY';

export interface UserSession {
  id: string;
  email: string;
  identifier: string;
  authenticated: boolean;
  nodeType: string; // e.g. 'EPH_NODE_0.4.2'
  encryptionAlgorithm: 'WEBRTC-DTLS-1.3' | 'AES-256-GCM';
}

export interface Peer {
  id: string; // e.g. 'OP_01', 'OP_02'
  name: string;
  isYou: boolean;
  status: 'ONLINE' | 'TRANSFERRING' | 'IDLE';
  latencyMs: number;
  ip: string;
}

export interface BundleItem {
  id: string;
  name: string;
  size: number; // bytes
  type: string; // mime type or category
  fileTypeLabel: string; // e.g., 'ZIP_ARC', 'IMG_DATA', 'MOV_STREAM', 'DOC_BYTE', 'JSON_DATA', 'TXT_SNIPPET'
  fileId: string; // e.g., 'FLX-992-ALPHA-BPRNT'
  dimensions?: string; // e.g. '8192 × 4096 PX' or '240 WORDS // 12 LINES'
  sha256: string;
  encryptedHash: string;
  blobUrl?: string;
  rawBlob?: Blob;
  textContent?: string;
  uploaderId: string;
  uploaderName: string;
  timestamp: number;
  carbonFootprintGrams: number; // CO2e in grams
  peerSeeds: number;
  encryptionStatus: 'WEBRTC DTLS TRANSPORT' | 'WEBRTC-DTLS VERIFIED' | 'AES-256-GCM VERIFIED';
}

export interface TransferProgress {
  active: boolean;
  fileName: string;
  fileSize: number;
  transferredBytes: number;
  progressPercent: number;
  currentSpeedMBps: number;
  etaSeconds: number;
  targetPeerId: string;
  mode: 'PACKAGE' | 'BUNDLE';
  carbonEmittedGrams: number;
  encryptedChunksCount: number;
  totalChunks: number;
}

export interface SystemLogEntry {
  id: string;
  timestamp: string;
  label: string;
  value: string;
  type: 'info' | 'success' | 'warning' | 'encryption';
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  type?: 'text' | 'system' | 'file_notice';
  status?: 'sending' | 'sent' | 'delivered' | 'read';
  encryptedHash?: string;
  reactions?: Record<string, string[]>; // emoji -> array of peerIds who reacted
  attachment?: {
    fileName: string;
    fileSize: number;
    fileId: string;
    blobUrl?: string;
    fileTypeLabel?: string;
  };
}

export interface RoomState {
  id: string; // OTP e.g. 'X-R92-K'
  createdAt: number;
  hostId: string;
  activePeers: Peer[];
  bundleItems: BundleItem[];
  messages?: ChatMessage[];
  selectedTargetPeerId: string; // 'OP_02' or 'ALL_BUNDLE'
}
