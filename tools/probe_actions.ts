import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";

const area = "SEA";
const a = await loginWithPasswordPlain({ email: process.env.E!, password: process.env.P!, area });
const cloud = new AquaraMobileClient({ area, token: a.token, userId: a.userId });
const matter = new AqaraMatterCloud(cloud);

const home = await cloud.get<any>("/app/position/query/home/list", { needDefaultRoom: "false", size: 300, startIndex: 0 });
const homes = home?.homes ?? [];
const devs: any[] = [];
for (const h of homes) {
  const pid = h.positionId ?? h.homeId;
  const d = await cloud.get<any>("/app/position/device/query", { positionId: pid, size: 300, startIndex: 0 });
  for (const x of (d?.devices ?? d?.data ?? [])) devs.push({ did: x.did ?? x.subjectId, model: x.model ?? "", name: x.deviceName ?? x.name ?? "" });
}
console.log("DEVICES:");
for (const d of devs) console.log(`  ${d.did}  ${d.model}  ${JSON.stringify(d.name)}`);

for (const d of devs) {
  try {
    const acts = await matter.getDeviceActions(d.did);
    if (!acts.length) { console.log(`\n=== ${d.model} (${d.did}): 0 action`); continue; }
    console.log(`\n=== ACTIONS ${d.model} (${d.did}) — ${acts.length} ===`);
    for (const ac of acts) {
      const hasParam = (ac.params?.length ?? 0) > 0;
      console.log(`  ${ac.actionDefinitionId}  "${ac.actionName}"  rids=${JSON.stringify(ac.rids)}  param=${hasParam?"YES":"-"}`);
      if (hasParam) console.log(`     params=${JSON.stringify(ac.params).slice(0,500)}`);
    }
  } catch (e: any) { console.log(`  (${d.model} action lỗi: ${e?.message?.slice(0,60)})`); }
}
