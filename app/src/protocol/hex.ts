export type Hex = string;

export function hexToBytes(hex: Hex): Uint8Array {
  const c = hex.replace(/\s+/g, "");
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(c.substr(i * 2, 2), 16);
  return out;
}
export function bytesToHex(b: Uint8Array | number[]): Hex {
  let s = "";
  for (const x of b) s += (x & 0xff).toString(16).padStart(2, "0");
  return s;
}
export function concatBytes(...parts: (Uint8Array | number[] | number)[]): Uint8Array {
  const arrs = parts.map((p) =>
    typeof p === "number" ? Uint8Array.of(p & 0xff) : p instanceof Uint8Array ? p : Uint8Array.from(p),
  );
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
export const u16le = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff);
export const u16be = (n: number) => Uint8Array.of((n >> 8) & 0xff, n & 0xff);
export const u32le = (n: number) => Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff);
