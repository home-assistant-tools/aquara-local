#!/usr/bin/env bun
// matter_signals_probe.ts — kiểm tra trạng thái sync hiện tại + dò giới hạn thực tế.
import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";

const area = process.env.AQARA_AREA ?? "SEA";
const a = await loginWithPasswordPlain({ email: process.env.AQARA_EMAIL!, password: process.env.AQARA_PASSWORD!, area });
const cloud = new AquaraMobileClient({ area, token: a.token, userId: a.userId });
const matter = new AqaraMatterCloud(cloud);
const locks = await matter.discoverLocks();
const homePid = locks[0].homePositionId;

const synced = await matter.getSignalDetails(homePid);
console.log(`HIỆN ĐANG SYNC: ${synced.length}`);
for (const s of synced) console.log(`  ${s.id}  ${s.name}`);

// nếu rỗng, thử add tăng dần để tìm cap thực tế
if (process.env.PROBE_ADD && synced.length === 0) {
  const all = await matter.iftttEventList(homePid);
  const pool = all.slice(0, 20);
  for (let n = 1; n <= pool.length; n++) {
    const map: Record<string, string> = {};
    for (const e of pool.slice(0, n)) map[e.id] = e.name;
    try {
      await matter.syncSignalsToMatter(map, homePid);
      const now = await matter.getSignalDetails(homePid);
      console.log(`add ${n} → OK, synced=${now.length}`);
      // gỡ lại để thử mức kế tiếp từ 0
      await matter.deleteSignals([locks[0].did], homePid);
    } catch (e: any) {
      console.log(`add ${n} → LỖI: ${e?.message?.slice(0, 60)}`);
      break;
    }
  }
}
