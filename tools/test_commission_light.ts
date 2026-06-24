#!/usr/bin/env tsx
// Live test: auto-commission đèn ảo dimmable vào fabric Aqara qua CommissioningController.
// Yêu cầu: virtual_dimmable_matter.ts đang chạy (commissionable, passcode 20202023/disc 3842).
//
// Env: E,P (login)  AREA=SEA  [PASSCODE=20202023] [DISCRIMINATOR=3842]
//      [HUB_NODE_ID_HEX=...]  dùng nodeId Matter của M100 làm caseAdminSubject để test adopt.
import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";
import { commissionLightOntoAqaraFabric } from "../client/commissionLight";

const area = process.env.AREA ?? "SEA";
const passcode = Number(process.env.PASSCODE ?? "20202023");
const discriminator = Number(process.env.DISCRIMINATOR ?? "3842");
const hubNodeIdHex = process.env.HUB_NODE_ID_HEX?.replace(/^0x/i, "").toUpperCase();

const a = await loginWithPasswordPlain({ email: process.env.E!, password: process.env.P!, area });
const cloud = new AquaraMobileClient({ area, token: a.token, userId: a.userId });
const m = new AqaraMatterCloud(cloud);

// hub Matter + home chứa khóa
const hubs = await m.discoverMatterHubs();
const hub = hubs.find((h) => /gateway/i.test(h.model)) ?? hubs[0];
const homePid = hub.homePositionId;
console.log(`hub=${hub.did} (${hub.model})  home=${homePid}`);

console.log("1) getFabric…");
const fabric = await m.getFabric(homePid);
console.log(`   fabricId=${fabric.fabricId} icacId=${fabric.icacId} rcacId=${fabric.rcacId} ipk=${fabric.ipk?.slice(0,8)}…`);

console.log(`2) genNodeId ${hubNodeIdHex ? "x1 (device; controller=hub override)" : "x2 (device + controller)"}…`);
const deviceNodeIdHex = await m.genNodeId(homePid);
const controllerNodeIdHex = hubNodeIdHex ?? await m.genNodeId(homePid);
console.log(`   device=${deviceNodeIdHex}  controller=${controllerNodeIdHex}`);
if (hubNodeIdHex) console.log("   ⚠ controller rootNodeId đang được ép = HUB_NODE_ID_HEX để caseAdminSubject là M100");

console.log("3) commissionLightOntoAqaraFabric (CommissioningController → đèn local)…");
await commissionLightOntoAqaraFabric({
  fabric, deviceNodeIdHex, controllerNodeIdHex, passcode, discriminator,
  storagePath: "/tmp/aqara-cc-storage",
  onAfterCase: async () => {
    console.log("   ✓ device vào fabric. signup (bind→hub)…");
    await m.signup(hub.did, deviceNodeIdHex, homePid);
    console.log("   waitBind…");
    const bind = await m.waitBind(deviceNodeIdHex, homePid, 45000);
    console.log(`   ✓ Aqara DID = ${bind.did}`);
  },
});

console.log("\n✅ AUTO-COMMISSION đèn OK — không cần app.");
process.exit(0);
