import { createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { APPID, APPKEY } from "./constants";
import { bytesToHex } from "./hex";

// ===========================================================================
// 1) `sign` header cloud — ✅ ĐÃ GIẢI XONG (5/5 mẫu khớp, tools/aqara_sign.py)
//    Native Rust getSignHead (liblumidevsdk.so).
// ===========================================================================
export function aqaraSign(opts: {
  nonce: string;
  time: string; // epoch ms (string)
  token: string;
  body?: string; // đúng chuỗi body gửi đi; GET/empty → ''
  appid?: string;
  appkey?: string;
}): string {
  const appid = opts.appid ?? APPID;
  const appkey = opts.appkey ?? APPKEY;
  let pre = `Appid=${appid}&Nonce=${opts.nonce}&Time=${opts.time}&Token=${opts.token}`;
  if (opts.body) pre += `&${opts.body}`;
  pre += `&${appkey}`;
  return createHash("md5").update(pre, "utf8").digest("hex");
}

/** nonce 32 hex hoa (giống app). Truyền randomFn để test cho deterministic. */
export function randomNonce(randomFn: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(randomFn() * 16).toString(16);
  return s.toUpperCase();
}

// ===========================================================================
// 2) AES-CCM cho lệnh BLE (MIoT secure)
//    ⚠️ THAM SỐ CHƯA CHỐT 100%: giả thuyết tốt nhất = nonce 13B dùng trực tiếp
//    làm IV, MIC = 4 byte (gói query empty=8B trong crypto.log ủng hộ). expandedIv=''.
//    Cần test vector (key,nonce,plaintext,ciphertext) để xác nhận — xem README §8.
//    Để pluggable: có thể thay bằng implementation khác qua AesCcm interface.
// ===========================================================================
export const CCM_MIC_LEN = 4; // byte (M, giả thuyết)

export interface AesCcm {
  encrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array; // trả ct‖tag
  decrypt(key: Uint8Array, nonce: Uint8Array, cipherWithTag: Uint8Array): Uint8Array;
}

// ---- AES-CCM thuần (chạy cả Bun lẫn Node; Bun không có cipher 'aes-128-ccm') ----
// CCM = CTR (mã hoá) + CBC-MAC (xác thực) trên block AES-ECB. RFC 3610.
function aesEcbBlock(key: Uint8Array, block16: Uint8Array): Uint8Array {
  const c = createCipheriv("aes-128-ecb", key, null);
  c.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([c.update(Buffer.from(block16)), c.final()]));
}
function xorInto(dst: Uint8Array, a: Uint8Array, b: Uint8Array, n = dst.length): void {
  for (let i = 0; i < n; i++) dst[i] = a[i] ^ b[i];
}
function ctrBlock(nonce: Uint8Array, L: number, counter: number): Uint8Array {
  const b = new Uint8Array(16);
  b[0] = L - 1; // flags = L'-1
  b.set(nonce, 1);
  for (let i = 0; i < L; i++) b[15 - i] = (counter >> (8 * i)) & 0xff;
  return b;
}

/** Tham số CCM mặc định cho D100 (giả thuyết): M=4, nonce 13B → L=2. */
export function aesCcmEncrypt(key: Uint8Array, nonce: Uint8Array, pt: Uint8Array, M = CCM_MIC_LEN): Uint8Array {
  if (key.length !== 16) throw new Error(`sessionKey phải 16B, có ${key.length}`);
  const L = 15 - nonce.length;
  // B0 + CBC-MAC (không AAD)
  const b0 = new Uint8Array(16);
  b0[0] = ((M - 2) / 2) << 3 | (L - 1);
  b0.set(nonce, 1);
  for (let i = 0; i < L; i++) b0[15 - i] = (pt.length >> (8 * i)) & 0xff;
  let x = aesEcbBlock(key, b0);
  for (let off = 0; off < pt.length; off += 16) {
    const blk = new Uint8Array(16);
    blk.set(pt.subarray(off, off + 16));
    const t = new Uint8Array(16);
    xorInto(t, x, blk);
    x = aesEcbBlock(key, t);
  }
  const T = x.subarray(0, M);
  // CTR
  const s0 = aesEcbBlock(key, ctrBlock(nonce, L, 0));
  const out = new Uint8Array(pt.length + M);
  for (let off = 0; off < pt.length; off += 16) {
    const s = aesEcbBlock(key, ctrBlock(nonce, L, 1 + off / 16));
    const n = Math.min(16, pt.length - off);
    for (let i = 0; i < n; i++) out[off + i] = pt[off + i] ^ s[i];
  }
  for (let i = 0; i < M; i++) out[pt.length + i] = T[i] ^ s0[i];
  return out;
}

export function aesCcmDecrypt(key: Uint8Array, nonce: Uint8Array, ctTag: Uint8Array, M = CCM_MIC_LEN): Uint8Array {
  const L = 15 - nonce.length;
  const ctLen = ctTag.length - M;
  const ct = ctTag.subarray(0, ctLen);
  const U = ctTag.subarray(ctLen);
  const s0 = aesEcbBlock(key, ctrBlock(nonce, L, 0));
  const pt = new Uint8Array(ctLen);
  for (let off = 0; off < ctLen; off += 16) {
    const s = aesEcbBlock(key, ctrBlock(nonce, L, 1 + off / 16));
    const n = Math.min(16, ctLen - off);
    for (let i = 0; i < n; i++) pt[off + i] = ct[off + i] ^ s[i];
  }
  // verify MAC
  const b0 = new Uint8Array(16);
  b0[0] = ((M - 2) / 2) << 3 | (L - 1);
  b0.set(nonce, 1);
  for (let i = 0; i < L; i++) b0[15 - i] = (ctLen >> (8 * i)) & 0xff;
  let x = aesEcbBlock(key, b0);
  for (let off = 0; off < ctLen; off += 16) {
    const blk = new Uint8Array(16);
    blk.set(pt.subarray(off, off + 16));
    const t = new Uint8Array(16);
    xorInto(t, x, blk);
    x = aesEcbBlock(key, t);
  }
  for (let i = 0; i < M; i++) if ((x[i] ^ s0[i]) !== U[i]) throw new Error("CCM MAC mismatch (sai key/nonce/MIC-len?)");
  return pt;
}

export const NodeAesCcm: AesCcm = {
  encrypt: (key, nonce, pt) => aesCcmEncrypt(key, nonce, pt),
  decrypt: (key, nonce, ctTag) => aesCcmDecrypt(key, nonce, ctTag),
};

// ===========================================================================
// 3) `x-aes128gcm` cho login/refresh — ⚠️ CHƯA HOÀN CHỈNH
//    Wire format ĐÃ biết: base64(IV) + '-' + base64(ciphertext) + '-' + base64(tag16).
//    key arg native = appKey, NHƯNG KDF key/iv thực tế CHƯA reverse (AESGCM(appKey,IV)
//    chuẩn không giải ra). Để pluggable: cấp keyIvDeriver khi đã reverse aesEncryptedContent.
// ===========================================================================
export type KeyIvDeriver = (appkey: string, ivRaw: Uint8Array) => { key: Uint8Array; iv: Uint8Array };

export class XAes128Gcm {
  constructor(
    private readonly appkey: string = APPKEY,
    /** TODO: thay bằng KDF thật sau khi reverse aesEncryptedContent. */
    private readonly deriveKeyIv: KeyIvDeriver = () => {
      throw new Error(
        "x-aes128gcm KDF chưa reverse — cần đọc native aesEncryptedContent. " +
          "Tạm thời dùng token đã có; hoặc inject keyIvDeriver.",
      );
    },
  ) {}

  /** Tách wire `b64(iv)-b64(ct)-b64(tag)`. */
  static parse(wire: string): { iv: Uint8Array; ct: Uint8Array; tag: Uint8Array } {
    const p = wire.split("-");
    if (p.length !== 3) throw new Error(`x-aes128gcm sai format (cần 3 phần): ${wire.slice(0, 40)}…`);
    return {
      iv: new Uint8Array(Buffer.from(p[0], "base64")),
      ct: new Uint8Array(Buffer.from(p[1], "base64")),
      tag: new Uint8Array(Buffer.from(p[2], "base64")),
    };
  }

  decrypt(wire: string): string {
    const { iv, ct, tag } = XAes128Gcm.parse(wire);
    const { key, iv: realIv } = this.deriveKeyIv(this.appkey, iv);
    const d = createDecipheriv("aes-128-gcm", key, realIv);
    d.setAuthTag(Buffer.from(tag));
    return Buffer.concat([d.update(Buffer.from(ct)), d.final()]).toString("utf8");
  }

  encrypt(plaintext: string, ivRaw: Uint8Array): string {
    const { key, iv } = this.deriveKeyIv(this.appkey, ivRaw);
    const c = createCipheriv("aes-128-gcm", key, iv);
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    const tag = c.getAuthTag();
    return [Buffer.from(ivRaw).toString("base64"), ct.toString("base64"), tag.toString("base64")].join("-");
  }
}

export const md5Hex = (s: string | Uint8Array): string =>
  createHash("md5").update(typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s)).digest("hex");

export { bytesToHex };
