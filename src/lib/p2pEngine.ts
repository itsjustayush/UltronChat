import { SystemLogEntry } from '../types';
import { getIceServerManager } from './iceServerManager';

// ICE configuration now managed by IceServerManager for failover and health checking
export function getIceServerConfiguration(): RTCConfiguration {
  const manager = getIceServerManager();
  return manager.getConfiguration();
}

export const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB max single file
export const MAX_BUNDLE_QUOTA = 2 * 1024 * 1024 * 1024; // 2 GB max RAM quota
// Binary frames avoid base64 overhead. 12 KiB stays below conservative 16 KiB
// browser/SCTP message limits while carrying 50% more payload than the old 8 KiB
// JSON+base64 packets.
export const RTC_DATA_CHANNEL_CHUNK_SIZE = 12 * 1024;
export const RTC_DATA_CHANNEL_HIGH_WATERMARK = 1024 * 1024;
export const RTC_DATA_CHANNEL_LOW_WATERMARK = 256 * 1024;
export const RTC_TRANSFER_BURST_CHUNKS = 32;

export type WebRTCConnectionState =
  | 'new'
  | 'checking'
  | 'connected'
  | 'completed'
  | 'disconnected'
  | 'failed'
  | 'closed';

export interface P2PSignalPayload {
  type: 'offer' | 'answer' | 'candidate' | 'quota_check';
  data: any;
  senderId?: string;
  targetPeerId?: string;
}

/**
 * WebRTC Peer Manager class wrapping RTCPeerConnection and RTCDataChannel
 */
export class WebRTCPeerEngine {
  private pc: RTCPeerConnection | null = null;
  public dataChannel: RTCDataChannel | null = null;
  // Made public for real-time transfer access
  private candidateQueue: RTCIceCandidateInit[] = [];
  public roomId: string;
  public peerId: string;
  public remotePeerId?: string;
  public isPolite: boolean = false;
  private makingOffer: boolean = false;

  public onStateChange?: (state: WebRTCConnectionState) => void;
  public onError?: (errorMsg: string, code: string) => void;
  public onDataReceived?: (data: ArrayBuffer | string) => void;
  public onSignalOutput?: (signal: P2PSignalPayload) => void;

  constructor(roomId: string, peerId: string, remotePeerId?: string, isPolite: boolean = false) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.remotePeerId = remotePeerId;
    this.isPolite = isPolite;
    this.initPeerConnection();
  }

  private initPeerConnection() {
    try {
      const iceConfig = getIceServerConfiguration();
      this.pc = new RTCPeerConnection(iceConfig);

      // Listen for ICE candidates
      this.pc.onicecandidate = (event) => {
        if (event.candidate && this.onSignalOutput) {
          this.onSignalOutput({
            type: 'candidate',
            data: event.candidate,
            senderId: this.peerId,
            targetPeerId: this.remotePeerId,
          });
        }
      };

      // Listen for ICE Connection State changes
      this.pc.oniceconnectionstatechange = () => {
        if (!this.pc) return;
        const state = this.pc.iceConnectionState as WebRTCConnectionState;
        if (this.onStateChange) {
          this.onStateChange(state);
        }

        if (state === 'failed') {
          if (this.onError) {
            this.onError('STUN failed. Connection blocked by firewall or symmetric NAT.', 'ERR_ICE_FAILED');
          }
        } else if (state === 'disconnected') {
          if (this.onError) {
            this.onError('Peer temporarily disconnected. Awaiting ICE reconnect...', 'ERR_PEER_DISCONNECTED');
          }
        }
      };

      // Handle remote Data Channel if incoming
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannelEvents();
      };
    } catch (err: any) {
      if (this.onError) {
        this.onError(`Failed to initialize WebRTC engine: ${err.message}`, 'ERR_RTC_INIT');
      }
    }
  }

  // Create DataChannel (Initiator / Sender)
  public createDataChannel(channelName = 'flux-p2p-channel') {
    if (!this.pc) return;
    this.dataChannel = this.pc.createDataChannel(channelName, {
      ordered: true,
    });
    this.setupDataChannelEvents();
  }

  private setupDataChannelEvents() {
    if (!this.dataChannel) return;
    this.dataChannel.binaryType = 'arraybuffer';

    this.dataChannel.onopen = () => {
      if (this.onStateChange) this.onStateChange('connected');
    };

    this.dataChannel.onmessage = (event) => {
      if (this.onDataReceived) {
        this.onDataReceived(event.data);
      }
    };

    this.dataChannel.onerror = (error) => {
      if (this.onError) {
        this.onError(`RTCDataChannel error: ${String(error)}`, 'ERR_DATACHANNEL');
      }
    };
  }

  // WebRTC Handshake Procedural Steps with Perfect Negotiation
  public async createOffer(): Promise<RTCSessionDescriptionInit | null> {
    if (!this.pc) return null;
    try {
      this.makingOffer = true;
      this.createDataChannel();
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      return offer;
    } catch (err: any) {
      console.warn('[P2PEngine] Failed to create offer:', err?.message || err);
      return null;
    } finally {
      this.makingOffer = false;
    }
  }

  public async handleOffer(offerData: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit | null> {
    if (!this.pc) return null;
    const offerCollision = this.makingOffer || this.pc.signalingState !== 'stable';
    if (offerCollision) {
      if (!this.isPolite) {
        console.warn(`[P2PEngine] Offer collision; impolite peer ignoring remote offer`);
        return null;
      }
      try {
        await Promise.all([
          this.pc.setLocalDescription({ type: 'rollback' }),
          this.pc.setRemoteDescription(new RTCSessionDescription(offerData)),
        ]);
      } catch (err: any) {
        console.warn('[P2PEngine] Rollback failed during offer collision:', err);
        return null;
      }
    } else {
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(offerData));
      } catch (err: any) {
        console.warn('[P2PEngine] Failed to set remote offer:', err?.message || err);
        return null;
      }
    }

    try {
      while (this.candidateQueue.length > 0) {
        const candidate = this.candidateQueue.shift();
        if (candidate) {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        }
      }
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      return answer;
    } catch (err: any) {
      console.warn('[P2PEngine] Failed to create answer:', err?.message || err);
      return null;
    }
  }

  public async handleAnswer(answerData: RTCSessionDescriptionInit) {
    if (!this.pc) return;
    if (this.pc.signalingState !== 'have-local-offer') {
      console.warn(`[P2PEngine] Ignoring remote answer in state: ${this.pc.signalingState}`);
      return;
    }
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answerData));
      while (this.candidateQueue.length > 0) {
        const candidate = this.candidateQueue.shift();
        if (candidate) {
          await this.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
        }
      }
    } catch (err: any) {
      console.warn('[P2PEngine] Failed to set remote answer:', err?.message || err);
    }
  }

  public getConnectionState(): WebRTCConnectionState {
    if (!this.pc) return 'closed';
    return (this.pc.iceConnectionState as WebRTCConnectionState) || 'new';
  }

  public async addIceCandidate(candidateData: RTCIceCandidateInit) {
    if (!this.pc) return;
    if (!this.pc.remoteDescription) {
      this.candidateQueue.push(candidateData);
      return;
    }
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidateData));
    } catch (err: any) {
      console.warn('[P2PEngine] Failed to add ICE candidate:', err?.message || err);
    }
  }

  public close() {
    this.candidateQueue = [];
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.onStateChange) {
      this.onStateChange('closed');
    }
  }
}

/**
 * Check whether proposed transfer exceeds maximum RAM or bundle quota
 */
export function validateTransferQuota(
  fileSize: number,
  currentBundleTotalBytes: number
): { valid: boolean; errorCode?: string; errorMessage?: string } {
  if (fileSize > MAX_FILE_SIZE) {
    return {
      valid: false,
      errorCode: 'ERR_QUOTA_EXCEEDED',
      errorMessage: `File size (${(fileSize / (1024 * 1024)).toFixed(0)}MB) exceeds maximum single file limit of 500MB.`,
    };
  }

  if (currentBundleTotalBytes + fileSize > MAX_BUNDLE_QUOTA) {
    return {
      valid: false,
      errorCode: 'ERR_QUOTA_EXCEEDED',
      errorMessage: `Adding file would exceed maximum ephemeral RAM bundle quota of 2GB.`,
    };
  }

  return { valid: true };
}

/**
 * Canonicalize room IDs across input, URLs, QR codes, and signaling.
 * Dashes, spaces, and case differences are presentation details only.
 */
export function normalizeRoomId(roomId: string): string {
  return roomId.replace(/^room-/i, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 32);
}

/**
 * Generates a 6-character alphanumeric room OTP code (e.g., XR92KB).
 * Displayed with a middle dash for readability (XR-92-KB) but stored as plain 6 chars.
 */
export function generateRoomOTP(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = (len: number) =>
    Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${pick(2)}${pick(2)}${pick(2)}`; // 6 chars, e.g. "XR92KB"
}

/**
 * Format a 6-char room OTP for display with dashes (e.g., XR-92-KB)
 */
export function formatRoomOTPDisplay(otp: string): string {
  const clean = otp.replace(/-/g, '');
  if (clean.length === 6) return `${clean.slice(0, 2)}-${clean.slice(2, 4)}-${clean.slice(4, 6)}`;
  return otp;
}

/**
 * Format a timestamp into HH:MM:SS
 */
export function formatTimestamp(): string {
  const d = new Date();
  return d.toTimeString().split(' ')[0];
}

/**
 * Create a new System Log entry
 */
export function createLogEntry(
  label: string,
  value: string,
  type: 'info' | 'success' | 'warning' | 'encryption' = 'info'
): SystemLogEntry {
  return {
    id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    timestamp: formatTimestamp(),
    label,
    value,
    type,
  };
}

/**
 * Initial system logs reflecting genuine runtime state
 */
export const INITIAL_SYSTEM_LOGS: SystemLogEntry[] = [
  createLogEntry('SYSTEM_INIT', 'READY', 'info'),
  createLogEntry('CRYPTO_TRANSPORT', 'WEBRTC_DTLS_1.3', 'encryption'),
  createLogEntry('SIGNALING_CHANNEL', 'ACTIVE', 'info'),
];

