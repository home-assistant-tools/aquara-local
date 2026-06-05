// Mijia CRC16 — reverse từ rn_bundle/lock.bundle (getCrc16Arr).
// init=0, poly=0x8005, MSB-first, KHÔNG reflect. Trả [low, high] (như getCrc16Arr).
// ⚠️ LƯU Ý: wire MIoT append CRC **big-endian** (đảo lại) — AquaraLock.packShort tự đảo.
//    (Verify 5/5 với khoá thật: openLock plaintext = 7401**f404**.)

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
