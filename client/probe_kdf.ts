#!/usr/bin/env bun
// Probe guess-KDF cho MiOT handshake (hướng MiOT-offline).
//
// Ta tự sinh keypair P-256 → 0610 → khóa trả devicePublicKey → ta tính S=ECDH(ourPriv,devicePK)
// (ta biết ourPriv → biết S, khác app thường). sessionKey/nonce/verifyData = KDF(S) cloud-side.
// Thử nhiều KDF chuẩn → dựng verifyData → gửi 0710. Oracle: khóa CHỈ reply 0710 khi verifyData
// ĐÚNG (verifyData sai → im lặng/timeout, đã verify với 'zeros'). Có reply = KDF đúng = MiOT offline.
//
// MỖI candidate dùng 1 CONNECTION RIÊNG (S mới mỗi lần — KDF là hàm của S nên vẫn test được;
// gửi nhiều 0710/connection không ổn vì session chết sau reject). Dừng ngay khi có reply.
//
// Chạy từ Terminal.app, máy gần khóa. Env: ONLY=<tên> để chỉ thử 1 KDF; mặc định thử hết.
import { createECDH, createHash, createHmac, hkdfSync } from "node:crypto";
import { MacBleClient } from "./MacBleClient";
import { buildAiotFrames, Reassembler, extractPublicKey } from "./framing";
import { UUID } from "./constants";
import { bytesToHex } from "./hex";

const ONLY = (process.env.ONLY ?? "").trim();
const T0710_MS = Number(process.env.T0710_MS ?? "5000");

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const md5 = (b: Uint8Array) => new Uint8Array(createHash("md5").update(b).digest());
const hmac256 = (key: Uint8Array, msg: Uint8Array) => new Uint8Array(createHmac("sha256", key).update(msg).digest());
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number) => new Uint8Array(hkdfSync("sha256", ikm, salt, info, len));
const enc = (s: string) => new TextEncoder().encode(s);
const cat = (...a: Uint8Array[]) => { const t = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { t.set(x, o); o += x.length; } return t; };
const slice = (b: Uint8Array, a: number, c: number) => b.subarray(a, c);

/** Sinh verifyData(8B) ứng viên từ S + 2 public key (chỉ cần verifyData cho oracle 0710). */
function verifyCandidates(S: Uint8Array, ourPub: Uint8Array, devPub: Uint8Array): Record<string, Uint8Array> {
  const zero32 = new Uint8Array(32);
  const vd29 = (km: Uint8Array) => slice(km, 29, 37); // sk[0:16] nonce[16:29] vd[29:37]
  const out: Record<string, Uint8Array> = {};
  for (const info of ["", "mible-login-info", "mible-setup-info", "lumi", "aqara", "AES", "secure-auth"])
    out[`hkdf_${info || "empty"}`] = vd29(hkdf(S, zero32, enc(info), 37));
  out["hkdf_saltpub"] = vd29(hkdf(S, sha256(cat(ourPub, devPub)), enc(""), 37));
  out["sha256_S_lo"] = slice(sha256(S), 0, 8);
  out["sha256_S_hi"] = slice(sha256(S), 24, 32);
  out["sha256_verify"] = slice(sha256(cat(S, enc("verify"))), 0, 8);
  out["sk_then_hash"] = slice(sha256(slice(sha256(S), 0, 16)), 0, 8);
  out["md5_S"] = slice(md5(S), 0, 8);
  out["hmac_S_pub"] = slice(hmac256(S, cat(ourPub, devPub)), 0, 8);
  out["hmac_S_verify"] = slice(hmac256(S, enc("verify")), 0, 8);
  return out;
}

async function exchange(ble: MacBleClient, packCmd: number, data: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
  const reasm = new Reassembler();
  return new Promise<Uint8Array>(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${packCmd.toString(16)} timeout`)), timeoutMs);
    const unsub = await ble.listen(UUID.HANDSHAKE_NOTIFY, (pkt) => {
      const full = reasm.push(pkt);
      if (full) { clearTimeout(timer); unsub(); resolve(full); }
    });
    for (const chunk of buildAiotFrames(packCmd, data)) await ble.send(UUID.HANDSHAKE_WRITE, chunk);
  });
}

/** 1 connection: keypair → 0610 → S → verifyData(name) → 0710. Trả reply hex hoặc null (no-reply). */
async function tryCandidate(name: string, i: number, total: number): Promise<string | null> {
  const ble = new MacBleClient({ log: () => void 0 });
  try {
    const ec = createECDH("prime256v1"); ec.generateKeys();
    const ourPub = new Uint8Array(ec.getPublicKey());
    await ble.connect("");
    const reply0610 = await exchange(ble, 0x0610, ourPub, 9000);
    const devPub = extractPublicKey(reply0610);
    const S = new Uint8Array(ec.computeSecret(Buffer.from(devPub)));
    const vd = name === "zeros" ? new Uint8Array(8) : verifyCandidates(S, ourPub, devPub)[name];
    if (!vd) { console.log(`  [${i}/${total}] ${name}: (không có)`); return null; }
    const r = await exchange(ble, 0x0710, vd, T0710_MS).then((b) => bytesToHex(b)).catch(() => null);
    console.log(`  [${i}/${total}] ${name.padEnd(18)} vd=${bytesToHex(vd)} → ${r ? "REPLY=" + r : "(no reply/timeout)"}`);
    return r;
  } catch (e: any) {
    console.log(`  [${i}/${total}] ${name.padEnd(18)} connect/0610 lỗi: ${e?.message ?? e}`);
    return null;
  } finally {
    await ble.disconnect().catch(() => void 0);
  }
}

async function main(): Promise<void> {
  // dùng 1 connection tạm để lấy danh sách tên candidate
  const names = ["zeros", ...Object.keys(verifyCandidates(new Uint8Array(32), new Uint8Array(65), new Uint8Array(65)))];
  const order = ONLY ? [ONLY] : names;
  console.log(`thử ${order.length} verifyData (mỗi cái 1 connection, oracle = có reply 0710)…`);
  let hit: string | null = null;
  for (let k = 0; k < order.length; k++) {
    const r = await tryCandidate(order[k], k + 1, order.length);
    if (r && order[k] !== "zeros") { hit = order[k]; console.log(`\n  ✅✅ HIT: KDF '${order[k]}' → khóa REPLY 0710 = verifyData ĐÚNG → MiOT MỞ ĐƯỢC OFFLINE!`); break; }
    await new Promise((res) => setTimeout(res, 800));
  }
  console.log(`\n=== KẾT LUẬN ===`);
  if (hit) console.log(`  ✅ KDF = ${hit}. Bước tiếp: dùng cùng KDF dựng sessionKey/nonce → mã hóa lệnh 0x74 (cần chốt AES-CCM params).`);
  else console.log(`  ❌ Không KDF chuẩn nào khớp (kể cả baseline zeros không reply). → KDF cloud trộn secret/salt riêng → MiOT-offline self-handshake BẤT KHẢ bằng guessing. Đi HomeKit-key.`);
}

main().catch((e) => { console.error("FATAL:", e?.stack ?? e); process.exit(1); });
