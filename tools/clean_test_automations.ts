#!/usr/bin/env bun
// clean_test_automations.ts — xóa MỌI automation tên __limit_test_* trong mọi home.
import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";

const area = "SEA";
const a = await loginWithPasswordPlain({ email: process.env.E!, password: process.env.P!, area });
const cloud = new AquaraMobileClient({ area, token: a.token, userId: a.userId });
const matter = new AqaraMatterCloud(cloud);

async function listAll(pid: string): Promise<Array<{ linkageId: string; name: string }>> {
  const out: any[] = [];
  for (let start = 0; start < 2000; start += 200) {
    const r = await cloud.get<any>("/app/position/linkage/query", { positionId: pid, size: 200, startIndex: start });
    const arr = r?.ifttts ?? r?.result?.ifttts ?? [];
    if (!arr.length) break;
    out.push(...arr.map((x: any) => ({ linkageId: x.linkageId, name: x.name })));
    if (arr.length < 200) break;
  }
  return out;
}

const home = await cloud.get<any>("/app/position/query/home/list", { needDefaultRoom: "false", size: 300, startIndex: 0 });
for (const h of (home?.homes ?? [])) {
  const pid = h.positionId ?? h.homeId;
  const ids = (await listAll(pid)).filter((l) => /__limit_test_/.test(l.name)).map((l) => l.linkageId);
  if (!ids.length) { console.log(`home ${pid}: 0 test automation`); continue; }
  console.log(`home ${pid}: xóa ${ids.length} test automation…`);
  for (let i = 0; i < ids.length; i += 20) await matter.deleteLinkages(ids.slice(i, i + 20)).catch((e) => console.log("  lỗi:", e?.message));
  const after = (await listAll(pid)).filter((l) => /__limit_test_/.test(l.name));
  console.log(`  ✓ còn sót: ${after.length}`);
}
