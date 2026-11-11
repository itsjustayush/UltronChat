import crypto from 'node:crypto';
import assert from 'node:assert';

export class IncrementalSHA256 {
  constructor() {
    this.h0 = 0x6a09e667;
    this.h1 = 0xbb67ae85;
    this.h2 = 0x3c6ef372;
    this.h3 = 0xa54ff53a;
    this.h4 = 0x510e527f;
    this.h5 = 0x9b05688c;
    this.h6 = 0x1f83d9ab;
    this.h7 = 0x5be0cd19;

    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesProcessed = 0;
    this.finalized = false;
  }

  static K = new Uint32Array([
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

  static W = new Uint32Array(64);

  _processBlock(block) {
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

  update(chunk) {
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

  digest() {
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

    // 64-bit big-endian bit count
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

  digestHex() {
    const raw = this.digest();
    let hex = '';
    for (let i = 0; i < 32; i++) {
      hex += raw[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
}

// Test cases
function runTests() {
  const testInputs = [
    Buffer.from(''),
    Buffer.from('abc'),
    Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), // 56 bytes
    Buffer.alloc(64, 'a'), // 64 bytes
    Buffer.from('The quick brown fox jumps over the lazy dog'),
    crypto.randomBytes(1000),
    crypto.randomBytes(1024 * 1024 + 17), // 1MB + 17 bytes
  ];

  for (let i = 0; i < testInputs.length; i++) {
    const input = testInputs[i];
    const expected = crypto.createHash('sha256').update(input).digest('hex');

    // Test all at once
    const h1 = new IncrementalSHA256();
    h1.update(input);
    const actual1 = h1.digestHex();
    assert.strictEqual(actual1, expected, `Failed full-chunk test ${i}`);

    // Test in tiny 7-byte slices
    const h2 = new IncrementalSHA256();
    for (let offset = 0; offset < input.length; offset += 7) {
      h2.update(input.subarray(offset, Math.min(offset + 7, input.length)));
    }
    const actual2 = h2.digestHex();
    assert.strictEqual(actual2, expected, `Failed sliced test ${i}`);
  }

  console.log('ALL INCREMENTAL SHA-256 TESTS PASSED PERFECTLY!');
}

runTests();

