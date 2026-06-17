// Login email/password — port từ app/src/cloud/login.ts cho Bun/Node, dùng node:crypto.
// Đường này verified với tài khoản SEA (rpc-au): server KHÔNG đòi x-aes128gcm cho body,
// chỉ cần header `sign` + RSA-PKCS1 password. Khi token rỗng, sign bỏ "&Token=".
//
// Recipe:
//   password_field = base64( RSA-PKCS1-v1.5( MD5(password) hex-ascii , pubkey hằng số ) )
//   body  = JSON{"account","district":"VN","encryptType":2,"guardCode":"","password":<rsa>}
//   sign  = MD5("Appid=..&Nonce=..&Time=..&"+body+"&"+appKey)   (token rỗng → bỏ &Token=)
//   POST  /app/v1.0/lumi/user/guard-code/login → { result: { token, userId, ... } }
import crypto from "node:crypto";
import { APPID, APPKEY, CLOUD_HOSTS, API_PREFIX } from "./constants";

const PATH = "/user/guard-code/login";

// RSA pubkey hằng số (LumiDevSDK.getCert(), RSA-1024). e=65537. Trích từ app/src/cloud/login.ts.
const RSA_N = BigInt(
  "0x86e3ab25079ef4d77249b3856f8f9715c8ca51f5bf81d85f98254eaa8411186e" +
    "212621d5a914fa4eb818a40ecd8570f4b5f4c896ab522b9b126d908086baba88" +
    "99152de253faf3c2169449aa1df4b14917f6f9a1f4707f15599d8e6999f90d648" +
    "81c83c117693133bd6af2cb66a18895d2866cad9cc11ec32e0700382d077107",
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

/** RSA/ECB/PKCS1Padding (type 2) — encrypt MD5(pw) hex-ascii → 128 byte ciphertext. */
function rsaPkcs1Encrypt(msg: Uint8Array): Uint8Array {
  if (msg.length > RSA_K - 11) throw new Error("RSA: message too long");
  const psLen = RSA_K - 3 - msg.length;
  const ps = new Uint8Array(psLen);
  // Padding bytes: random non-zero
  for (let i = 0; i < psLen; i++) {
    let b = 0;
    while (b === 0) b = (Math.random() * 256) | 0;
    ps[i] = b;
  }
  const em = new Uint8Array(RSA_K);
  em[0] = 0x00;
  em[1] = 0x02;
  em.set(ps, 2);
  em[2 + psLen] = 0x00;
  em.set(msg, 3 + psLen);
  // big-endian to bigint
  let m = 0n;
  for (const byte of em) m = (m << 8n) | BigInt(byte);
  let c = modpow(m, RSA_E, RSA_N);
  // back to bytes
  const out = new Uint8Array(RSA_K);
  for (let i = RSA_K - 1; i >= 0; i--) {
    out[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  return out;
}

function md5Hex(s: string): string {
  return crypto.createHash("md5").update(s).digest("hex");
}

function randomNonceHex(len = 16): string {
  return crypto.randomBytes(len).toString("hex").toUpperCase();
}

/** Sign sans-token (login flow): MD5(Appid=..&Nonce=..&Time=..&<body>&<appkey>). */
function signLogin(nonce: string, time: string, body: string, appid = APPID, appkey = APPKEY): string {
  // App phía native build "Appid=..&Nonce=..&Time=..&Token=<t>&" — khi token rỗng nó BỎ "Token="
  // Sau đó append `<body>&<appkey>`. MD5 hex là sign.
  const head = `Appid=${appid}&Nonce=${nonce}&Time=${time}&`;
  return md5Hex(head + body + "&" + appkey);
}

export interface LoginOpts {
  email: string;
  password: string;
  area?: keyof typeof CLOUD_HOSTS | string;
  district?: string; // "VN" / "CN" / "US" / ...
}

export interface LoginResult {
  token: string;
  userId: string;
  nickName?: string;
  raw: Record<string, unknown>;
}

export async function loginWithPasswordPlain(opts: LoginOpts): Promise<LoginResult> {
  const area = (opts.area ?? "SEA") as keyof typeof CLOUD_HOSTS;
  const host = CLOUD_HOSTS[area] ?? String(opts.area);
  const district = opts.district ?? (area === "CN" ? "CN" : "VN");

  // password = base64(RSA-PKCS1(MD5(pw) hex-ascii))
  const md5pw = md5Hex(opts.password);
  const enc = rsaPkcs1Encrypt(new TextEncoder().encode(md5pw));
  const passwordField = Buffer.from(enc).toString("base64");

  const bodyObj = {
    account: opts.email,
    district,
    encryptType: 2,
    guardCode: "",
    password: passwordField,
  };
  // Compact JSON (no spaces) so the body string used for `sign` matches the wire.
  const body = JSON.stringify(bodyObj);

  const nonce = randomNonceHex(16);
  const time = String(Date.now());
  const sign = signLogin(nonce, time, body);

  const headers: Record<string, string> = {
    appid: APPID,
    token: "",
    sign,
    nonce,
    time,
    area: String(area),
    lang: "en",
    "app-version": "6.1.6",
    "phone-model": "RN-D100",
    "sys-type": "1",
    "sys-version": "14",
    "content-type": "application/json; charset=utf-8",
  };

  const res = await fetch(host + API_PREFIX + PATH, {
    method: "POST",
    headers,
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`login HTTP ${res.status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  const result = json.result ?? json;
  if (!result?.token) throw new Error(`login failed: ${text.slice(0, 200)}`);
  return {
    token: result.token,
    userId: result.userId,
    nickName: result.nickName,
    raw: result,
  };
}
