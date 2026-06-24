import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";
const area = "SEA";
const a = await loginWithPasswordPlain({ email: process.env.E!, password: process.env.P!, area });
const m = new AqaraMatterCloud(new AquaraMobileClient({ area, token: a.token, userId: a.userId }));
const hubs = await m.discoverMatterHubs();
console.log(`Matter hubs (controller, đọc 13.202.85): ${hubs.length}`);
for (const h of hubs) {
  console.log(`  HUB ${h.did}  ${h.model}  "${h.name}"  home=${h.homePositionId}`);
  try {
    const fabrics = await m.getMatterFabrics(h.did);
    if (fabrics.length) {
      console.log("      Matter fabrics/resource 13.201.700:");
      for (const f of fabrics) {
        console.log(`        vendor=${f.vendorId} fabric=${f.fabric} nodeId=${f.nodeId} manufacturer=${JSON.stringify(f.manufacturer)}`);
      }
    }
  } catch (e: any) {
    console.log(`      (fabric list lỗi: ${e?.message?.slice(0, 80)})`);
  }
  const locks = await m.locksBoundToHub(h);
  for (const l of locks) console.log(`      ↳ KHÓA ${l.did}  ${l.model}  "${l.name}"  parent=${l.parentDeviceId}`);
}
