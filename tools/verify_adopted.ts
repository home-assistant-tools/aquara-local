#!/usr/bin/env tsx
// Xác minh đèn đã được M100 adopt: tìm device matt.* trong cloud + endpoint/paths (LevelControl?).
import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";

const area = process.env.AREA ?? "SEA";
const want = process.env.DID ?? "";
const a = await loginWithPasswordPlain({ email: process.env.E!, password: process.env.P!, area });
const cloud = new AquaraMobileClient({ area, token: a.token, userId: a.userId });
const m = new AqaraMatterCloud(cloud);

const devs = await m.scanAllDevices();
const matt = devs.filter((d) => d.did.startsWith("matt."));
console.log(`${matt.length} Matter device(s) matt.*:`);
for (const d of matt) console.log(`  ${d.did}  model=${d.model}  name=${d.name}  parent=${d.parentDeviceId}`);

const target = want ? matt.find((d) => d.did === want) : matt[matt.length - 1];
if (!target) { console.log("KHÔNG thấy device cần kiểm"); process.exit(1); }

console.log(`\n=== chi tiết ${target.did} ===`);
// endpoint/paths qua /app/position/device/query đã có; thử resource query để xem LevelControl
try {
  const r: any = await cloud.get("/app/device/query/resource/list", { subjectId: target.did });
  console.dir(r, { depth: 5 });
} catch (e: any) { console.log("resource/list:", e?.message ?? e); }
process.exit(0);
