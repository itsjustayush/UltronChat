/**
 * WebCrypto AES-256-GCM & Carbon Footprint calculation utilities for FLUX_P2P
 */

export interface EncryptionResult {
  encryptedBuffer: ArrayBuffer;
  iv: Uint8Array;
  key: CryptoKey;
  sha256Hex: string;
}

/**
 * Generate a new AES-256-GCM CryptoKey
 */
export async function generateKey(): Promise<CryptoKey> {
  return await window.crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt file buffer with AES-256-GCM
 */
export async function encryptFileBuffer(
  buffer: ArrayBuffer,
  key?: CryptoKey
): Promise<EncryptionResult> {
  const activeKey = key || (await generateKey());
  const iv = window.crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV for AES-GCM

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
    },
    activeKey,
    buffer
  );

  const sha256Hex = await calculateSHA256(buffer);

  return {
    encryptedBuffer,
    iv,
    key: activeKey,
    sha256Hex,
  };
}

/**
 * Decrypt file buffer with AES-256-GCM
 */
export async function decryptFileBuffer(
  encryptedBuffer: ArrayBuffer,
  key: CryptoKey,
  iv: Uint8Array
): Promise<ArrayBuffer> {
  return await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv,
    },
    key,
    encryptedBuffer
  );
}

/**
 * Pure TypeScript Streaming / Incremental SHA-256 implementation (FIPS 180-4 compliant).
 * Processes arbitrary stream/slices without holding multi-gigabyte files in memory.
 */
export class IncrementalSHA256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;

  private buffer = new Uint8Array(64);
  private bufferLength = 0;
  private bytesProcessed = 0;
  private finalized = false;

  private static readonly K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  private static readonly W = new Uint32Array(64);

  private _processBlock(block: Uint8Array) {
    const W = IncrementalSHA256.W;
    const K = IncrementalSHA256.K;

    for (let t = 0; t < 16; t++) {
      const idx = t * 4;
      W[t] = ((block[idx] << 24) | (block[idx + 1] << 16) | (block[idx + 2] << 8) | block[idx + 3]) >>> 0;
    }

    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15];
      const s0 = ((w15 >>> 7 | w15 << 25) ^ (w15 >>> 18 | w15 << 14) ^ (w15 >>> 3)) >>> 0;
      const w2 = W[t - 2];
      const s1 = ((w2 >>> 17 | w2 << 15) ^ (w2 >>> 19 | w2 << 13) ^ (w2 >>> 10)) >>> 0;
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;

    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) >>> 0;
      const ch = ((e & f) ^ ((~e) & g)) >>> 0;
      const temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
      const S0 = ((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }

  public update(chunk: Uint8Array | ArrayBuffer): this {
    if (this.finalized) throw new Error('Cannot update after digest has been called');
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    let offset = 0;
    const len = bytes.length;
    this.bytesProcessed += len;

    if (this.bufferLength > 0) {
      const needed = 64 - this.bufferLength;
      const toCopy = Math.min(needed, len);
      this.buffer.set(bytes.subarray(0, toCopy), this.bufferLength);
      this.bufferLength += toCopy;
      offset += toCopy;

      if (this.bufferLength === 64) {
        this._processBlock(this.buffer);
        this.bufferLength = 0;
      }
    }

    while (offset + 64 <= len) {
      this._processBlock(bytes.subarray(offset, offset + 64));
      offset += 64;
    }

    if (offset < len) {
      const remaining = bytes.subarray(offset);
      this.buffer.set(remaining, 0);
      this.bufferLength = remaining.length;
    }

    return this;
  }

  public digest(): Uint8Array {
    if (this.finalized) throw new Error('Digest already called');
    this.finalized = true;

    const totalBits = this.bytesProcessed * 8;
    this.buffer[this.bufferLength++] = 0x80;

    if (this.bufferLength > 56) {
      this.buffer.fill(0, this.bufferLength);
      this._processBlock(this.buffer);
      this.buffer.fill(0);
    } else {
      this.buffer.fill(0, this.bufferLength);
    }

    const highBits = Math.floor(totalBits / 0x100000000);
    const lowBits = totalBits >>> 0;

    this.buffer[56] = (highBits >>> 24) & 0xff;
    this.buffer[57] = (highBits >>> 16) & 0xff;
    this.buffer[58] = (highBits >>> 8) & 0xff;
    this.buffer[59] = highBits & 0xff;
    this.buffer[60] = (lowBits >>> 24) & 0xff;
    this.buffer[61] = (lowBits >>> 16) & 0xff;
    this.buffer[62] = (lowBits >>> 8) & 0xff;
    this.buffer[63] = lowBits & 0xff;

    this._processBlock(this.buffer);

    const out = new Uint8Array(32);
    const words = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (words[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (words[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (words[i] >>> 8) & 0xff;
      out[i * 4 + 3] = words[i] & 0xff;
    }
    return out;
  }

  public digestHex(): string {
    const raw = this.digest();
    let hex = '';
    for (let i = 0; i < 32; i++) {
      hex += raw[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
}

/**
 * Calculate SHA-256 checksum hex string for any buffer
 */
export async function calculateSHA256(buffer: ArrayBuffer): Promise<string> {
  const subtle = (typeof window !== 'undefined' ? window.crypto : (globalThis as any).crypto)?.subtle;
  if (subtle) {
    const hashBuffer = await subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const hasher = new IncrementalSHA256();
  hasher.update(new Uint8Array(buffer));
  return hasher.digestHex();
}

/**
 * Calculate SHA-256 checksum hex string for a Blob or File of ANY size (up to multi-GB).
 * Hashes 100% of the bytes on both sender and receiver without memory exhaustion.
 */
export async function calculateBlobSHA256(
  blob: Blob,
  onProgress?: (percent: number) => void
): Promise<string> {
  const subtle = (typeof window !== 'undefined' ? window.crypto : (globalThis as any).crypto)?.subtle;
  // If <= 32 MB and SubtleCrypto is present, hardware-accelerate
  if (blob.size <= 32 * 1024 * 1024 && subtle) {
    const buffer = await blob.arrayBuffer();
    return calculateSHA256(buffer);
  }

  // Files > 32 MB (or when subtle is unavailable): stream in 2 MB slices
  const CHUNK_SIZE = 2 * 1024 * 1024;
  const hasher = new IncrementalSHA256();
  let offset = 0;
  const total = blob.size;

  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total);
    const slice = blob.slice(offset, end);
    const sliceBuf = await slice.arrayBuffer();
    hasher.update(new Uint8Array(sliceBuf));
    offset = end;

    if (onProgress && total > 0) {
      onProgress(Math.round((offset / total) * 100));
    }

    // Yield every 8 MB to keep browser rendering loop smooth
    if (offset % (8 * 1024 * 1024) === 0 && offset < total) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return hasher.digestHex();
}

/**
 * Calculate Carbon Footprint for P2P data transfer vs traditional cloud storage
 * Benchmark:
 * - Centralized cloud storage & transfer: ~0.06 g CO2e / MB
 * - Direct Ephemeral P2P WebRTC data channel: ~0.005 g CO2e / MB
 */
export function calculateCarbonMetrics(bytes: number) {
  const sizeInMB = bytes / (1024 * 1024);
  const p2pCarbonGrams = sizeInMB * 0.005;
  const cloudCarbonGrams = sizeInMB * 0.06;
  const savedGrams = cloudCarbonGrams - p2pCarbonGrams;
  const savingsPercent = 91.6;

  return {
    p2pCarbonGrams: parseFloat(p2pCarbonGrams.toFixed(3)),
    cloudCarbonGrams: parseFloat(cloudCarbonGrams.toFixed(3)),
    savedGrams: parseFloat(savedGrams.toFixed(3)),
    savingsPercent,
    formattedP2p: p2pCarbonGrams < 0.01 ? '< 0.01 g CO2e' : `${p2pCarbonGrams.toFixed(2)} g CO2e`,
  };
}

/**
 * Helper to format readable file sizes
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

/**
 * Derive label for file type e.g. ZIP_ARC, IMG_DATA, MOV_STREAM, DOC_BYTE
 */
export function getFileTypeLabel(fileType: string, fileName: string): string {
  const ext = fileName.split('.').pop()?.toUpperCase() || '';
  if (fileType.includes('image') || ['PNG', 'JPG', 'JPEG', 'WEBP', 'SVG'].includes(ext)) return 'IMG_DATA';
  if (fileType.includes('video') || ['MP4', 'MOV', 'WEBM', 'MKV'].includes(ext)) return 'MOV_STREAM';
  if (fileType.includes('zip') || fileType.includes('archive') || ['ZIP', 'RAR', '7Z', 'TAR', 'GZ'].includes(ext)) return 'ZIP_ARC';
  if (fileType.includes('pdf') || fileType.includes('word') || ['PDF', 'DOC', 'DOCX', 'TXT', 'MD'].includes(ext)) return 'DOC_BYTE';
  if (fileType.includes('json') || fileType.includes('code') || ['JSON', 'TS', 'JS', 'PY', 'HTML'].includes(ext)) return 'JSON_DATA';
  return `${ext || 'DATA'}_FILE`;
}
