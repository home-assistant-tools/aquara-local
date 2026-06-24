#!/usr/bin/env bun
// Port của tools/ble_mac_test.py sang Bun/TypeScript — handshake + openLock D100.
//
// Yêu cầu:
//   - macOS Sequoia+: chạy từ Terminal.app TRỰC TIẾP (TCC Bluetooth).
//   - `bun add @stoprocent/noble` trong thư mục client/ (đã có bun.lock).
//
// Usage:
//   export AQARA_EMAIL=...  AQARA_PASSWORD=...
//   export AQARA_AREA=SEA   AQARA_DISTRICT=VN
//   export LOCK_DID=lumi....
//   export OP=open       # open | close | unbolt | (empty = chỉ handshake)
//   bun run tools/ble_mac_test.ts
import { loginWithPasswordPlain } from "../client/loginPlain";
import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { MacBleClient } from "../client/MacBleClient";
import { AquaraLock } from "../client/AquaraLock";
import { OpenLockType } from "../client/constants";
import { bytesToHex } from "../client/hex";

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v != null && v !== "") return v;
  if (fallback != null) return fallback;
  throw new Error(`Missing env var ${name}`);
}

const OP_MAP: Record<string, OpenLockType> = {
  open: OpenLockType.OPEN,
  close: OpenLockType.CLOSE,
  unbolt: OpenLockType.UNBOLT,
};

async function main(): Promise<number> {
  const email = env("AQARA_EMAIL");
  const password = env("AQARA_PASSWORD");
  const area = env("AQARA_AREA", "SEA");
  const district = env("AQARA_DISTRICT", "VN");
  const did = env("LOCK_DID");
  const op = (process.env.OP ?? "").trim().toLowerCase();

  console.log(`→ cloud login ${email} (area=${area})…`);
  const t0 = Date.now();
  const auth = await loginWithPasswordPlain({ email, password, area, district });
  console.log(`  ✓ login ${Date.now() - t0}ms userId=${auth.userId}`);

  const mobile = new AquaraMobileClient({
    area,
    token: auth.token,
    userId: auth.userId,
  });

  const ble = new MacBleClient({
    log: (m) => console.log(`  [ble] ${m}`),
  });

  console.log(`→ getLockKey did=${did} (scan + connect + 0610/0710)…`);
  const tBle = Date.now();
  try {
    const key = await mobile.getLockKey(did, ble);
    console.log(`  ✓ handshake ${Date.now() - tBle}ms`);
    console.log(`     sessionKey = ${bytesToHex(key.sessionKey)}`);
    console.log(`     nonce      = ${bytesToHex(key.nonce)}`);
    console.log(`     mac        = ${key.mac}`);

    if (!op) {
      console.log("OP env empty → skipping unlock. Set OP=open|close|unbolt to fire.");
      return 0;
    }
    const opCode = OP_MAP[op];
    if (opCode == null) {
      console.error(`OP must be one of: open close unbolt (got ${JSON.stringify(op)})`);
      return 2;
    }

    const lock = new AquaraLock(
      { sessionKey: key.sessionKey, nonce: key.nonce },
      ble,
    );  // default NodeAesCcm — verified byte-perfect với Python
    // Pause cho khoá process 0710 verifyData TRƯỚC khi fire openLock. TS chạy quá nhanh
    // (2ms tới openLock) khoá chưa settle session → có thể silently reject 01/74.
    console.log(`  waiting 1s for lock to settle 0710 verifyData…`);
    await new Promise((r) => setTimeout(r, 1000));
    console.log(`⚠️ FIRING ${op.toUpperCase()} (01/74) — this moves the real lock!`);
    const tFire = Date.now();
    await lock.openLock(opCode);
    console.log(`  ✓ command sent ${Date.now() - tFire}ms`);
    // Giữ BLE link để khoá kịp execute + ack
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    await ble.disconnect().catch(() => void 0);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("FATAL:", e?.stack ?? e);
    process.exit(1);
  });
