// Login email+password — THUẦN JS, KHÔNG cần .so / x-aes128gcm.
// Đã reverse + test thật (HTTP 200, trả token). Recipe:
//   password_field = base64( RSA-PKCS1-v1.5( MD5(password) hex-ascii , pubkey hằng số từ getCert() ) )
//   body = {"account":email,"district":"VN","encryptType":2,"guardCode":"","password":password_field}
//   sign = MD5("Appid=..&Nonce=..&Time=..&"+body+"&"+appKey)   (token rỗng → BỎ &Token=)
//   POST /app/v1.0/lumi/user/guard-code/login  (JSON THƯỜNG, KHÔNG content-encoding)
//   → { result: { token, userId } }
// Server KHÔNG đòi mã hoá body ⇒ bỏ hẳn liblumidevsdk.so.
import md5 from "js-md5";
import { aqaraSign, randomNonce, APPID, APPKEY } from "../protocol/sign";
import { Auth } from "../state/auth";
import { Buffer } from "buffer";

const HOSTS: Record<string, string> = {
  SEA: "https://rpc-au.aqara.com",
  CN: "https://rpc.aqara.cn",
  US: "https://rpc-us.aqara.com",
  EU: "https://rpc-ger.aqara.com",
};
const PATH = "/app/v1.0/lumi/user/guard-code/login";

// RSA pubkey hằng số (trích từ LumiDevSDK.getCert(), cert RSA-1024 của Lumi). e=65537.
const RSA_N = BigInt(
  "0x86e3ab25079ef4d77249b3856f8f9715c8ca51f5bf81d85f98254eaa8411186e" +
  "212621d5a914fa4eb818a40ecd8570f4b5f4c896ab522b9b126d908086baba88" +
  "99152de253faf3c2169449aa1df4b14917f6f9a1f4707f15599d8e6999f90d648" +
  "81c83c117693133bd6af2cb66a18895d2866cad9cc11ec32e0700382d077107"
);
const RSA_E = BigInt(65537);
const RSA_K = 128; // 1024-bit = 128 byte

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return r;
}

/** RSA/ECB/PKCS1Padding (type 2) encrypt — trả 128 byte. */
function rsaPkcs1Encrypt(msg: Uint8Array): Uint8Array {
  if (msg.length > RSA_K - 11) throw new Error("RSA: message too long");
  const psLen = RSA_K - 3 - msg.length;
  const ps = new Uint8Array(psLen);
  (global as any).crypto.getRandomValues(ps);
  for (let i = 0; i < psLen; i++) {
    while (ps[i] === 0) {
      const t = new Uint8Array(1);
      (global as any).crypto.getRandomValues(t);
      ps[i] = t[0];
    }
  }
  const em = new Uint8Array(RSA_K);
  em[0] = 0x00; em[1] = 0x02;
  em.set(ps, 2);
  em[2 + psLen] = 0x00;
  em.set(msg, 3 + psLen);

  let m = 0n;
  for (const b of em) m = (m << 8n) | BigInt(b);
  let c = modpow(m, RSA_E, RSA_N);
  const out = new Uint8Array(RSA_K);
  for (let i = RSA_K - 1; i >= 0; i--) { out[i] = Number(c & 0xffn); c >>= 8n; }
  return out;
}

export interface LoginResult extends Auth { nickName?: string; }

export async function loginWithPassword(email: string, password: string, area = "SEA"): Promise<LoginResult> {
  // 1) RSA( ascii của MD5(password) )
  const md5hex = md5(password);                      // 32 hex thường
  const pwEnc = rsaPkcs1Encrypt(Buffer.from(md5hex, "ascii"));
  const pwB64 = Buffer.from(pwEnc).toString("base64");

  // 2) body JSON (thứ tự field cố định để sign khớp)
  const body = JSON.stringify({
    account: email, district: "VN", encryptType: 2, guardCode: "", password: pwB64,
  });

  // 3) sign trên body PLAINTEXT, token rỗng
  const nonce = randomNonce();
  const time = Date.now().toString();
  const sign = aqaraSign({ nonce, time, token: "", body });

  // 4) POST JSON thường
  const host = HOSTS[area] ?? area;
  const headers: Record<string, string> = {
    appid: APPID, token: "", sign, nonce, time, area,
    lang: "en", "app-version": "6.1.6", "phone-model": "RN-D100",
    "sys-type": "1", "sys-version": "14",
    "content-type": "application/json; charset=utf-8",
  };
  const r = await fetch(host + PATH, { method: "POST", headers, body });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error("login: non-JSON response: " + text.slice(0, 120)); }
  if (j.code !== 0 || !j.result?.token) {
    throw new Error(`login thất bại (code=${j.code}): ${j.message ?? text.slice(0, 120)}`);
  }
  return {
    area,
    token: j.result.token,
    userId: j.result.userId ?? j.result.userInfo?.userId,
    nickName: j.result.userInfo?.nickName,
  };
}
