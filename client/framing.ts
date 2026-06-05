import { concatBytes } from "./hex";
import { HS_MAGIC_APP, HS_LAST_IDX } from "./constants";

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
