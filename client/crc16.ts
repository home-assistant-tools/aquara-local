// Mijia CRC16 — reverse từ rn_bundle/lock.bundle (getCrc16Arr).
// init=0, poly=0x8005, MSB-first, KHÔNG reflect. Trả [low, high] (như getCrc16Arr).
// ⚠️ LƯU Ý: wire MIoT append CRC **big-endian** (đảo lại) — AquaraLock.packShort tự đảo.
//    (Verify 5/5 với khoá thật: openLock plaintext = 7401**f404**.)

/** CRC16/ARC — poly 0x8005, init 0, REFLECTED in/out. Dùng cho AIOT handshake header frame.
 *  (Verified: ARC(cloudPublicKey)=8837.) Trả 2 byte little-endian. */
export function crc16Arc(bytes: Uint8Array): Uint8Array {
  const refl = (b: number, n: number): number => {
    let r = 0;
    for (let i = 0; i < n; i++) {
      r = (r << 1) | (b & 1);
      b >>= 1;
    }
    return r;
  };
  let crc = 0;
  for (const byte of bytes) {
    crc ^= refl(byte, 8) << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  crc = refl(crc & 0xffff, 16);
  return Uint8Array.of(crc & 0xff, (crc >> 8) & 0xff);
}

export function mijiaCrc16(bytes: Uint8Array): Uint8Array {
  let u = 0;
  if (!bytes || bytes.length === 0) return Uint8Array.of(0, 0);
  for (let f = 0; f < bytes.length; f++) {
    for (let v = 0; v < 8; v++) {
      const n = u >> 15;
      u = (u << 1) & 0xffff;
      u |= (bytes[f] >> (7 - v)) & 1;
      if (n & 1) u ^= 0x8005;
    }
  }
  u &= 0xffff;
  return Uint8Array.of(u & 0xff, (u >> 8) & 0xff); // little-endian
}
