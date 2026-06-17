#!/usr/bin/env bun
// Live test: auto-commission công tắc ảo vào fabric Aqara (KHÔNG qua app).
// Yêu cầu: virtual_switch_matter.ts đang chạy (commissionable) + token cloud hợp lệ.
//
// Env: T(token) U(userId) AREA(=SEA) HOME_PID GATEWAY_ID PASSCODE(=20202022) DISCRIMINATOR(=3841)
import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { commissionSwitchOntoAqaraFabric } from "../client/commissionSwitch";

const env = (k: string, d?: string) => process.env[k] ?? d ?? (() => { throw new Error("missing " + k); })();

async function main() {
  const area = env("AREA", "SEA");
  const homePid = env("HOME_PID"); // home positionId (real1.xxx) — bắt buộc set env
  const gatewayId = env("GATEWAY_ID"); // DID hub Matter-controller (M100, lumi3.xxx)
  const passcode = Number(env("PASSCODE", "20202022"));
  const discriminator = Number(env("DISCRIMINATOR", "3841"));

  const cloud = new AquaraMobileClient({ area, token: env("T"), userId: env("U") });
  const m = new AqaraMatterCloud(cloud);

  console.log("1) getFabric…");
  const fabric = await m.getFabric(homePid);
  console.log(`   fabricId=${fabric.fabricId} icacId=${fabric.icacId} rcacId=${fabric.rcacId}`);

  console.log("2) genNodeId…");
  const nodeIdHex = await m.genNodeId(homePid);
  console.log(`   nodeId=${nodeIdHex}`);

  console.log("3) commissionSwitchOntoAqaraFabric (matter.js controller → switch local)…");
  const res = await commissionSwitchOntoAqaraFabric({
    fabric, nodeIdHex, passcode, discriminator,
    storagePath: "/tmp/aqara-controller-storage",
  });
  console.log(`   ✓ commissioned nodeId=${res.nodeIdHex} fabricIndex=${res.fabricIndex}`);

  console.log("4) signup (bind node→hub)…");
  await m.signup(gatewayId, nodeIdHex, homePid);

  console.log("5) waitBind (hub adopt)…");
  const bind = await m.waitBind(nodeIdHex, homePid, 40000);
  console.log(`   ✓ Aqara DID = ${bind.did}  gateway=${bind.gatewayId}`);

  console.log("\n✅ AUTO-COMMISSION OK — switch vào hub KHÔNG cần app.");
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e?.message ?? e); process.exit(1); });
