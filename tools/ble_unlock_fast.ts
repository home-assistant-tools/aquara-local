#!/usr/bin/env bun
// Pre-warm + cached fast-unlock cho D100, kèm đo latency từng phase.
//
// Trả lời 2 câu: (1) handshake lâu thì sao → tách cloud ra khỏi critical path bằng cache;
// (2) "session sẵn" có timeout không → KHÔNG giữ connection (khoá đá standalone), chỉ cache CRYPTO;
//     cache hết hạn khi khoá xoay devicePublicKey — harness này ĐO tuổi cache + báo khi stale.
//
// Chạy từ Terminal.app (BT đã grant), đặt máy gần khoá.
//   MODE=warm   bun run tools/ble_unlock_fast.ts   # handshake cloud + cache, KHÔNG mở (làm nóng)
//   MODE=unlock OP=open bun run tools/ble_unlock_fast.ts   # cached replay (offline) → cache miss thì cloud → mở
//   MODE=status bun run tools/ble_unlock_fast.ts    # như unlock nhưng đọc trạng thái thay vì mở
//
// Env: LOCK_DID (bắt buộc), AQARA_AREA(=SEA), AQARA_DISTRICT(=VN), OP(open|close|unbolt).
//   AQARA_EMAIL/AQARA_PASSWORD: CHỈ cần khi cache miss/stale (fast path offline không cần).
import { loginWithPasswordPlain } from "../client/loginPlain";
import { AquaraMobileClient, type LockSessionKey } from "../client/AquaraMobileClient";
import { MacBleClient } from "../client/MacBleClient";
import { AquaraLock } from "../client/AquaraLock";
import { OpenLockType } from "../client/constants";
import { bytesToHex } from "../client/hex";
import { findLatestByDid, saveSession, sessionFile } from "../client/sessionStore";

const OP_MAP: Record<string, OpenLockType> = {
  open: OpenLockType.OPEN,
  close: OpenLockType.CLOSE,
  unbolt: OpenLockType.UNBOLT,
};

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v != null && v !== "") return v;
  if (fallback != null) return fallback;
  throw new Error(`Missing env var ${name}`);
}
const since = (t: number) => `${Date.now() - t}ms`;

async function main(): Promise<number> {
  const did = env("LOCK_DID");
  const area = env("AQARA_AREA", "SEA");
  const district = env("AQARA_DISTRICT", "VN");
  const mode = (process.env.MODE ?? "unlock").trim().toLowerCase();
  const op = (process.env.OP ?? "open").trim().toLowerCase();

  const ble = new MacBleClient({ log: (m) => console.log(`  [ble] ${m}`) });
  console.log(`session file: ${sessionFile()}`);

  const cached = findLatestByDid(did);
  const timing: Record<string, string> = {};
  let key: LockSessionKey | null = null;
  let pathUsed = "";

  // ---- FAST PATH: cached replay (offline, KHÔNG cloud) -------------------
  if (cached) {
    const ageS = Math.round((Date.now() - cached.ts) / 1000);
    console.log(`→ cache hit (tuổi ${ageS}s) — thử CACHED replay (offline)…`);
    const t = Date.now();
    try {
      const m = new AquaraMobileClient({ area, token: "", userId: "" }); // replay không cần auth
      key = await m.replaySession(cached, ble);
      timing.fast_replay = since(t);
      if (key) {
        pathUsed = `CACHED offline (tuổi ${ageS}s)`;
        console.log(`  ✓ session cũ CÒN VALID ${timing.fast_replay} — devicePublicKey khớp, 0 lần gọi cloud`);
      } else {
        console.log(`  ✗ devicePublicKey ĐỔI → cache STALE (khoá đã xoay key) → fallback cloud`);
      }
    } catch (e: any) {
      console.log(`  ✗ replay lỗi: ${e?.message ?? e} → fallback cloud`);
    }
    if (!key) await ble.disconnect().catch(() => void 0);
  } else {
    console.log(`→ chưa có cache cho ${did} → handshake cloud (online)`);
  }

  // ---- SLOW PATH: cloud handshake (online) → cache ----------------------
  if (!key) {
    const email = env("AQARA_EMAIL");
    const password = env("AQARA_PASSWORD");
    const tL = Date.now();
    const auth = await loginWithPasswordPlain({ email, password, area, district });
    timing.cloud_login = since(tL);
    const m = new AquaraMobileClient({ area, token: auth.token, userId: auth.userId });
    const tH = Date.now();
    key = await m.getLockKey(did, ble);
    timing.cloud_handshake = since(tH);
    if (key.cloudPublicKey && key.devicePublicKey) {
      saveSession({
        did,
        mac: key.mac,
        cloudPublicKey: key.cloudPublicKey,
        devicePublicKey: key.devicePublicKey,
        sessionKey: bytesToHex(key.sessionKey),
        nonce: bytesToHex(key.nonce),
        verifyData: bytesToHex(key.verifyData),
      });
      console.log(`  ✓ đã cache session (devicePublicKey=${key.devicePublicKey.slice(0, 16)}…)`);
    }
    pathUsed = "CLOUD handshake (online)";
  }

  // ---- WARM: chỉ làm nóng + cache, KHÔNG mở -----------------------------
  if (mode === "warm") {
    console.log(`\n=== WARMED (${pathUsed}) — session sẵn sàng, lần mở sau sẽ chạy fast path ===`);
    console.table(timing);
    await ble.disconnect().catch(() => void 0);
    return 0;
  }

  // ---- ACTION: mở khoá / đọc trạng thái ---------------------------------
  const lock = new AquaraLock({ sessionKey: key.sessionKey, nonce: key.nonce }, ble);
  // Khoá cần settle 0710 verifyData trước khi nhận lệnh (TS chạy quá nhanh sẽ bị reject im lặng).
  await new Promise((r) => setTimeout(r, 1000));
  try {
    if (mode === "status") {
      const t = Date.now();
      const st = await lock.getDoorLockStatus();
      timing.status = since(t);
      console.log(`  lockStatus=${st.lockStatus} doorStatus=${st.doorStatus} raw=${bytesToHex(st.raw)}`);
    } else {
      const opCode = OP_MAP[op];
      if (opCode == null) throw new Error(`OP phải là open|close|unbolt (nhận ${JSON.stringify(op)})`);
      console.log(`⚠️ FIRING ${op.toUpperCase()} (01/74) — MỞ KHOÁ THẬT!`);
      const t = Date.now();
      await lock.openLock(opCode);
      timing.openLock = since(t);
      await new Promise((r) => setTimeout(r, 1500)); // giữ link cho khoá execute + ack
    }
  } finally {
    await ble.disconnect().catch(() => void 0);
  }

  console.log(`\n=== DONE — path: ${pathUsed} ===`);
  console.table(timing);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("FATAL:", e?.stack ?? e);
    process.exit(1);
  });
