import { concatBytes } from "./hex";
import { HS_MAGIC_APP, HS_LAST_IDX } from "./constants";
import { crc16Arc } from "./crc16";

// Phân mảnh MIoT cho kênh handshake (ffb1): mỗi ATT packet = [magic][chunk_idx][data].
// idx 00..fe, ff = mảnh cuối. fragMax = số byte data mỗi mảnh (observed ~18).
// ⚠️ Cấu trúc INNER của payload handshake (length-prefix/status) mới RE một phần — xem README §5.

export function fragment(payload: Uint8Array, magic = HS_MAGIC_APP, fragMax = 18): Uint8Array[] {
  if (payload.length === 0) return [concatBytes(magic, HS_LAST_IDX)];
  const chunks: Uint8Array[] = [];
  const nFull = Math.ceil(payload.length / fragMax);
  for (let i = 0; i < nFull; i++) {
    const slice = payload.subarray(i * fragMax, (i + 1) * fragMax);
    const isLast = i === nFull - 1;
    chunks.push(concatBytes(magic, isLast ? HS_LAST_IDX : i, slice));
  }
  return chunks;
}

/** Build AIOT RegLogin frames (port chính xác từ custom_components/aquara_local/gatt.py).
 *
 *   header frag = [5a][00][enc][cmdHi cmdLo][0100|ffff][len 00][CRC16-ARC LE 2B][pad9 00]
 *   data frags  = [5a][idx>=01][≤fragMax bytes],   idx cuối = 0xff
 *
 *  packCmd ví dụ 0x0610 (publickey) / 0x0710 (verify).
 *  KHÁC với `fragment()` ở chỗ: có HEADER frame với packCmd + length + CRC16-ARC.
 *  Khoá D100 PHẢI thấy header trước, nếu không trả error 0x10/04ffff.
 */
export function buildAiotFrames(
  packCmd: number,
  data: Uint8Array,
  fragMax = 18,
  needEncrypt = false,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  const crc = crc16Arc(data); // LE 2B
  const enc = needEncrypt ? 0x01 : 0x00;
  const cmdHi = (packCmd >> 8) & 0xff;
  const cmdLo = packCmd & 0xff;
  const pad9 = new Uint8Array(9);

  if (data.length === 0) {
    out.push(
      concatBytes(HS_MAGIC_APP, HS_LAST_IDX, enc, cmdHi, cmdLo, 0xff, 0xff, 0x00, 0x00, crc, pad9),
    );
    return out;
  }
  out.push(
    concatBytes(
      HS_MAGIC_APP,
      0x00,
      enc,
      cmdHi,
      cmdLo,
      0x01,
      0x00,
      data.length & 0xff,
      0x00,
      crc,
      pad9,
    ),
  );
  const n = Math.ceil(data.length / fragMax);
  for (let i = 0; i < n; i++) {
    const idx = i === n - 1 ? HS_LAST_IDX : i + 1;
    const chunk = data.subarray(i * fragMax, (i + 1) * fragMax);
    out.push(concatBytes(HS_MAGIC_APP, idx, chunk));
  }
  return out;
}

/** Bóc 65-byte ECDH P-256 uncompressed pubkey (mở đầu 0x04) từ blob đã reassemble.
 *  Reply 0610 của khoá có wrapper bytes trước/sau pubkey; cloud verify yêu cầu pubkey nguyên. */
export function extractPublicKey(blob: Uint8Array): Uint8Array {
  for (let i = 0; i + 65 <= blob.length; i++) {
    if (blob[i] === 0x04) return blob.subarray(i, i + 65);
  }
  return blob; // fallback
}

/** Ghép lại các mảnh notify (da...) cho tới khi gặp idx 0xff. Trả null nếu chưa đủ. */
export class Reassembler {
  private buf: number[] = [];
  push(packet: Uint8Array): Uint8Array | null {
    if (packet.length < 2) return null;
    const idx = packet[1];
    for (let i = 2; i < packet.length; i++) this.buf.push(packet[i]);
    if (idx === HS_LAST_IDX) {
      const out = Uint8Array.from(this.buf);
      this.buf = [];
      return out;
    }
    return null;
  }
  reset() {
    this.buf = [];
  }
}
