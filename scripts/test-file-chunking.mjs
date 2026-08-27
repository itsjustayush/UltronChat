import { createHash, randomBytes } from 'node:crypto';

const CHUNK_SIZE = 12 * 1024;
const HEADER_BYTES = 16;
const file = randomBytes(20 * 1024 * 1024 + 137);
const originalHash = createHash('sha256').update(file).digest('hex');
const packets = [];
let maxBinaryPacketBytes = 0;
let legacyBase64Bytes = 0;

for (let offset = 0, index = 0; offset < file.length; offset += CHUNK_SIZE, index += 1) {
  const payload = file.subarray(offset, Math.min(offset + CHUNK_SIZE, file.length));
  const packet = Buffer.alloc(HEADER_BYTES + payload.length);
  packet.writeUInt32BE(0x55434631, 0);
  Buffer.from('CHUNK001').copy(packet, 4);
  packet.writeUInt32BE(index, 12);
  payload.copy(packet, HEADER_BYTES);
  packets.push({ index, payload: Buffer.from(packet.subarray(HEADER_BYTES)) });
  maxBinaryPacketBytes = Math.max(maxBinaryPacketBytes, packet.length);
  legacyBase64Bytes += Buffer.byteLength(JSON.stringify({ type: 'FILE_CHUNK', fileId: 'chunk-test', index, payload: payload.toString('base64') }));
}

const reassembled = Buffer.concat(packets.sort((a, b) => a.index - b.index).map(({ payload }) => payload));
const reassembledHash = createHash('sha256').update(reassembled).digest('hex');
const binaryPayloadBytes = packets.reduce((total, packet) => total + packet.payload.length, 0);
const overheadReduction = 1 - binaryPayloadBytes / legacyBase64Bytes;

if (reassembled.length !== file.length || originalHash !== reassembledHash) {
  throw new Error('binary chunk reassembly hash or size mismatch');
}
if (maxBinaryPacketBytes >= 16 * 1024) {
  throw new Error(`binary packet exceeds conservative RTCDataChannel limit: ${maxBinaryPacketBytes} bytes`);
}
if (overheadReduction < 0.2) {
  throw new Error(`expected meaningful framing reduction, got ${(overheadReduction * 100).toFixed(1)}%`);
}

console.log(JSON.stringify({
  ok: true,
  fileBytes: file.length,
  chunks: packets.length,
  maxBinaryPacketBytes,
  legacyBase64Bytes,
  binaryPayloadBytes,
  framingReductionPercent: Number((overheadReduction * 100).toFixed(1)),
  sha256: reassembledHash,
}));
