import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";

const area = "SEA";
const a = await loginWithPasswordPlain({ email: process.env.E!, password: process.env.P!, area });
const cloud = new AquaraMobileClient({ area, token: a.token, userId: a.userId });
const matter = new AqaraMatterCloud(cloud);

// gom devices (kèm room positionId) theo home
const home = await cloud.get<any>("/app/position/query/home/list", { needDefaultRoom: "false", size: 300, startIndex: 0 });
const homes = home?.homes ?? [];
let lock: any, hub: any, homePid = "";
for (const h of homes) {
  const pid = h.positionId ?? h.homeId;
  const d = await cloud.get<any>("/app/position/device/query", { positionId: pid, size: 300, startIndex: 0 });
  for (const x of (d?.devices ?? d?.data ?? [])) {
    const dev = { did: x.did ?? x.subjectId, model: x.model ?? "", name: x.deviceName ?? x.name ?? "", room: x.positionId ?? pid, homePid: pid };
    if (/\.lock\./.test(dev.model)) { lock = dev; homePid = pid; }
    if (/gateway\.agl008/.test(dev.model)) hub = dev;
  }
}
console.log("home:", homePid);
console.log("lock:", lock?.did, lock?.model, "room=", lock?.room);
console.log("hub :", hub?.did, hub?.model, "room=", hub?.room);

const trigs = await matter.getLockTriggerEvents(lock.did);
const trig = trigs.find(t => /someone|unlock/i.test(t.triggerDefinitionId)) ?? trigs[0];
console.log("trigger dùng:", trig?.triggerDefinitionId, trig?.triggerName, "group=", trig?.group);

function mk(n: number) {
  return matter.createAutomation({
    homePositionId: homePid,
    name: `__limit_test_${n}`,
    trigger: {
      subjectId: lock.did, subjectModel: lock.model, subjectName: lock.name, roomPositionId: lock.room,
      triggerDefinitionId: trig.triggerDefinitionId, triggerName: trig.triggerName, group: trig.group,
      usageType: 0, type: -1, endpointId: "",
    },
    action: {
      subjectId: hub.did, subjectModel: hub.model, subjectName: hub.name, roomPositionId: hub.room,
      actionDefinitionId: "AD.stop_delay_action", actionName: "no-op", rids: ["8.0.2385"],
    },
  });
}

// TẠO THỬ 1 cái
const created: string[] = [];
try {
  const id = await mk(0);
  console.log("\n[create #0] →", JSON.stringify(id));
  if (id) created.push(id);
} catch (e: any) {
  console.log("\n[create #0] LỖI:", e?.message);
}

// nếu nhận → loop tới khi chặn (cap an toàn 400)
if (created.length) {
  let n = 1, limitMsg = "";
  for (; n < 400; n++) {
    try {
      const id = await mk(n);
      if (id) created.push(id);
      else { limitMsg = "server trả id rỗng"; break; }
      if (n % 20 === 0) console.log(`  …đã tạo ${created.length}`);
    } catch (e: any) {
      limitMsg = e?.message ?? String(e);
      break;
    }
  }
  console.log(`\n>>> DỪNG ở lần thứ ${n}. Tổng tạo THÀNH CÔNG = ${created.length}. Lý do dừng: ${limitMsg}`);
}

// DỌN SẠCH (bỏ qua nếu KEEP=1 — để user tự test)
if (created.length && !process.env.KEEP) {
  console.log(`\nĐang xóa ${created.length} automation test…`);
  for (let i = 0; i < created.length; i += 20) {
    await matter.deleteLinkages(created.slice(i, i + 20)).catch((e) => console.log("  xóa lỗi:", e?.message));
  }
  const left = await matter.listLinkages(homePid).catch(() => []);
  const leftTest = left.filter((l: any) => /__limit_test_/.test(l.name));
  console.log(`✓ Dọn xong. Còn sót automation test: ${leftTest.length}`);
} else if (created.length) {
  const left = await matter.listLinkages(homePid).catch(() => []);
  const leftTest = left.filter((l: any) => /__limit_test_/.test(l.name));
  console.log(`\n✋ GIỮ LẠI ${created.length} automation (tên __limit_test_*). Tổng linkage trong home: ${left.length}, test: ${leftTest.length}.`);
  console.log(`   Dọn sau: bun tools/clean_test_automations.ts  (hoặc xóa trong app Aqara).`);
}
