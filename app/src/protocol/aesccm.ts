// AES-CCM thuần (RFC 3610) cho RN — dùng aes-js làm block ECB (không cần node:crypto).
// Tham số D100 (đã verify 5/5 khoá thật): nonce 13B dùng trực tiếp làm IV, MIC=4.
import aesjs from "aes-js";

export const CCM_MIC_LEN = 4;

function ecb(key: Uint8Array, block16: Uint8Array): Uint8Array {
  return new aesjs.ModeOfOperation.ecb(Array.from(key)).encrypt(block16);
}
function ctrBlock(nonce: Uint8Array, L: number, counter: number): Uint8Array {
  const b = new Uint8Array(16);
  b[0] = L - 1;
  b.set(nonce, 1);
  for (let i = 0; i < L; i++) b[15 - i] = (counter >> (8 * i)) & 0xff;
  return b;
}

export function aesCcmEncrypt(key: Uint8Array, nonce: Uint8Array, pt: Uint8Array, M = CCM_MIC_LEN): Uint8Array {
  const L = 15 - nonce.length;
  const b0 = new Uint8Array(16);
  b0[0] = (((M - 2) / 2) << 3) | (L - 1);
  b0.set(nonce, 1);
  for (let i = 0; i < L; i++) b0[15 - i] = (pt.length >> (8 * i)) & 0xff;
  let x = ecb(key, b0);
  for (let off = 0; off < pt.length; off += 16) {
    const blk = new Uint8Array(16);
    blk.set(pt.subarray(off, off + 16));
    const t = new Uint8Array(16);
    for (let i = 0; i < 16; i++) t[i] = x[i] ^ blk[i];
    x = ecb(key, t);
  }
  const T = x.subarray(0, M);
  const s0 = ecb(key, ctrBlock(nonce, L, 0));
  const out = new Uint8Array(pt.length + M);
  for (let off = 0; off < pt.length; off += 16) {
    const s = ecb(key, ctrBlock(nonce, L, 1 + off / 16));
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
  const s0 = ecb(key, ctrBlock(nonce, L, 0));
  const pt = new Uint8Array(ctLen);
  for (let off = 0; off < ctLen; off += 16) {
    const s = ecb(key, ctrBlock(nonce, L, 1 + off / 16));
    const n = Math.min(16, ctLen - off);
    for (let i = 0; i < n; i++) pt[off + i] = ct[off + i] ^ s[i];
  }
  const b0 = new Uint8Array(16);
  b0[0] = (((M - 2) / 2) << 3) | (L - 1);
  b0.set(nonce, 1);
  for (let i = 0; i < L; i++) b0[15 - i] = (ctLen >> (8 * i)) & 0xff;
  let x = ecb(key, b0);
  for (let off = 0; off < ctLen; off += 16) {
    const blk = new Uint8Array(16);
    blk.set(pt.subarray(off, off + 16));
    const t = new Uint8Array(16);
    for (let i = 0; i < 16; i++) t[i] = x[i] ^ blk[i];
    x = ecb(key, t);
  }
  for (let i = 0; i < M; i++) if ((x[i] ^ s0[i]) !== U[i]) throw new Error("CCM MAC mismatch");
  return pt;
}
