// `sign` header cloud Aqara (đã verify 5/5). md5 thuần JS (js-md5) — không cần node:crypto.
import md5 from "js-md5";

export const APPID = "444c476ef7135e53330f46e7";
export const APPKEY = "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi";

export function aqaraSign(opts: {
  nonce: string; time: string; token: string; body?: string; appid?: string; appkey?: string;
}): string {
  const appid = opts.appid ?? APPID;
  const appkey = opts.appkey ?? APPKEY;
  let pre = `Appid=${appid}&Nonce=${opts.nonce}&Time=${opts.time}`;
  if (opts.token) pre += `&Token=${opts.token}`;   // token rỗng (login) → BỎ HẲN đoạn &Token=
  if (opts.body) pre += `&${opts.body}`;
  pre += `&${appkey}`;
  return md5(pre);
}

export function randomNonce(): string {
  const a = new Uint8Array(16);
  // react-native-get-random-values polyfill cho crypto.getRandomValues (import ở index.ts)
  (global as any).crypto.getRandomValues(a);
  let s = "";
  for (const b of a) s += b.toString(16).padStart(2, "0");
  return s.toUpperCase();
}
