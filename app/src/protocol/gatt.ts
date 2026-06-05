// UUID GATT + khung handshake AIOT (RegLogin) — ĐÃ decode 100% từ getAiotLongPackageList + verify khoá thật.
import { concatBytes } from "./hex";
import { crc16Arc } from "./crc16";

export const UUID = {
  HANDSHAKE_SVC: "0000ffa0-0000-1000-8000-00805f9b34fb",
  HANDSHAKE_WRITE: "0000ffb1-0000-1000-8000-00805f9b34fb",
  HANDSHAKE_NOTIFY: "0000ffb2-0000-1000-8000-00805f9b34fb",
  CMD_SVC: "f2042ffd-87c6-7c9d-1e5b-332360ff0000",
  CMD_WRITE: "0000ff61-2333-5b1e-9d7c-c687fd2f04f2",
  CMD_NOTIFY: "0000ff62-2333-5b1e-9d7c-c687fd2f04f2",
};

export const HS_HEAD = 0x5a; // app→lock
export const HS_LAST = 0xff;

/**
 * Dựng khung AIOT RegLogin (getAiotLongPackageList):
 *   header frag = 5a 00 [enc:00] [packCmd 2B] [0100|ffff] [len:1B 00] [CRC16-ARC(data) 2B LE] + pad(9×00)
 *   data frags  = 5a [idx từ 01] [<=fragMax bytes],  idx cuối = ff
 * @param packCmd vd 0x0610 (publickey) / 0x0710 (verify)
 */
export function buildAiotFrames(packCmd: number, data: Uint8Array, fragMax = 18, needEncrypt = false): Uint8Array[] {
  const out: Uint8Array[] = [];
  const crc = crc16Arc(data); // 2B LE
  const enc = needEncrypt ? 0x01 : 0x00;
  const cmdHi = (packCmd >> 8) & 0xff, cmdLo = packCmd & 0xff;
  const pad9 = new Uint8Array(9);
  if (data.length === 0) {
    out.push(concatBytes(HS_HEAD, HS_LAST, enc, cmdHi, cmdLo, 0xff, 0xff, 0x00, 0x00, crc, pad9));
  } else {
    out.push(concatBytes(HS_HEAD, 0x00, enc, cmdHi, cmdLo, 0x01, 0x00, data.length & 0xff, 0x00, crc, pad9));
    const n = Math.ceil(data.length / fragMax);
    for (let i = 0; i < n; i++) {
      out.push(concatBytes(HS_HEAD, i === n - 1 ? HS_LAST : i + 1, data.subarray(i * fragMax, (i + 1) * fragMax)));
    }
  }
  return out;
}

/** Ghép notify response (magic 'da'): BỎ header frag (idx 00), nối payload idx 01..ff. Trả khi gặp idx ff. */
export class HsReassembler {
  private buf: number[] = [];
  push(pkt: Uint8Array): Uint8Array | null {
    if (pkt.length < 2) return null;
    const idx = pkt[1];
    if (idx !== 0x00) for (let i = 2; i < pkt.length; i++) this.buf.push(pkt[i]);
    if (idx === HS_LAST) { const o = Uint8Array.from(this.buf); this.buf = []; return o; }
    return null;
  }
}

/** Tách devicePublicKey (65B, bắt đầu 0x04) từ payload đã ghép. */
export function extractPubKey(blob: Uint8Array): Uint8Array {
  for (let i = 0; i + 65 <= blob.length; i++) if (blob[i] === 0x04) return blob.subarray(i, i + 65);
  return blob; // fallback
}
