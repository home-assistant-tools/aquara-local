// Tiện ích hex/byte dùng chung.

export type Hex = string;

export function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new Error(`hex lẻ nibble: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array | number[]): Hex {
  let s = "";
  for (const b of bytes) s += (b & 0xff).toString(16).padStart(2, "0");
  return s;
}

export function concatBytes(...parts: (Uint8Array | number[] | number)[]): Uint8Array {
  const arrs = parts.map((p) =>
    typeof p === "number" ? Uint8Array.of(p & 0xff) : p instanceof Uint8Array ? p : Uint8Array.from(p),
  );
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

/** byte → 2 hex */
export const b2 = (n: number): Hex => (n & 0xff).toString(16).padStart(2, "0");

/** uint16 → 2 byte little-endian */
export function u16le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
}

/** uint16 → 2 byte big-endian */
export function u16be(n: number): Uint8Array {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

/** uint32 → 4 byte little-endian */
export function u32le(n: number): Uint8Array {
  return Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
}

export function readU16le(b: Uint8Array, off = 0): number {
  return b[off] | (b[off + 1] << 8);
}

export function readU32le(b: Uint8Array, off = 0): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}
