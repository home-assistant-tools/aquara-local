// Mijia CRC16 (getCrc16Arr): init=0, poly=0x8005, MSB-first, không reflect. Trả [low, high].
// ⚠️ Wire MIoT append CRC big-endian (đảo) — lock.ts tự đảo. (Verify 5/5 khoá thật.)
export function mijiaCrc16(bytes: Uint8Array): Uint8Array {
  let u = 0;
  if (!bytes || bytes.length === 0) return Uint8Array.of(0, 0);
  for (let f = 0; f < bytes.length; f++)
    for (let v = 0; v < 8; v++) {
      const n = u >> 15;
      u = (u << 1) & 0xffff;
      u |= (bytes[f] >> (7 - v)) & 1;
      if (n & 1) u ^= 0x8005;
    }
  u &= 0xffff;
  return Uint8Array.of(u & 0xff, (u >> 8) & 0xff);
}

// CRC16/ARC (poly 0x8005, init 0, REFLECTED in+out) — dùng cho khung HANDSHAKE (getCrc16String).
// Khác mijiaCrc16 (lệnh, không reflect). Verify: ARC(cloudPublicKey)=8837, ARC(verifyData)=7a2c. Trả LE.
export function crc16Arc(bytes: Uint8Array): Uint8Array {
  const refl = (b: number, n: number) => { let r = 0; for (let k = 0; k < n; k++) { r = (r << 1) | (b & 1); b >>= 1; } return r; };
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= refl(bytes[i], 8) << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  crc = refl(crc & 0xffff, 16);
  return Uint8Array.of(crc & 0xff, (crc >> 8) & 0xff); // little-endian
}
