#!/usr/bin/env bun
// matter_signals_reset.ts — Xóa TOÀN BỘ tín hiệu Matter (đã sync ra bridge) rồi TẠO LẠI sạch.
//
// Việc làm:
//   1. login + tìm home chứa khóa
//   2. liệt kê tín hiệu Matter đang sync (/dev/signals/detail/list/query)
//   3. XÓA hết khỏi Matter bridge (/dev/signals/delete)  ← "xóa toàn bộ signal matter"
//   4. dựng lại danh sách ưu tiên (ai-mở/credential trước, event chung sau), tối đa 15 (eventLimit)
//   5. sync lại ra Matter (/dev/signals/add)             ← "tạo lại"
//   6. in trạng thái sau cùng
//
// Giới hạn cứng của Aqara: 1 Matter bridge chỉ sync tối đa 15 tín hiệu (eventLimit:15).
//
// Env:
//   AQARA_EMAIL + AQARA_PASSWORD  (hoặc AQARA_TOKEN + AQARA_USERID)
//   AQARA_AREA = SEA
//   DRY=1   → chỉ in kế hoạch, KHÔNG xóa/sync
import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";

const LIMIT = 15;
const LOCK_MODELS = ["aqara.lock.aqgl01", "aqgl", "dp1a", ".lock."];

// Tín hiệu "ai mở" (per-credential / người cụ thể) = ưu tiên cao nhất.
const WHO_HINTS = [/vân tay/i, /fingerprint/i, /mật khẩu/i, /password/i, /nfc/i, /thẻ/i, /face/i, /khuôn mặt/i, /someone/i];
const GENERIC = /bất kỳ|bất ky|\bany\b|mọi |dùng một lần|one[- ]?time/i; // "mở bằng bất kỳ vân tay nào"
function priority(name: string): number {
  if (WHO_HINTS.some((re) => re.test(name))) return GENERIC.test(name) ? 1 : 0; // người cụ thể=0, chung=1
  if (/mở|unlock|open/i.test(name)) return 2; // mở khóa chung
  if (/khóa|lock/i.test(name)) return 3; // khóa
  return 4; // còn lại
}

async function main(): Promise<void> {
  const area = process.env.AQARA_AREA ?? "SEA";
  let token = process.env.AQARA_TOKEN ?? "";
  let userId = process.env.AQARA_USERID ?? "";
  if (!token && process.env.AQARA_EMAIL) {
    const a = await loginWithPasswordPlain({ email: process.env.AQARA_EMAIL!, password: process.env.AQARA_PASSWORD!, area });
    token = a.token; userId = a.userId;
    console.log(`✓ login → userId=${userId}`);
  }
  if (!token) throw new Error("cần AQARA_EMAIL+AQARA_PASSWORD hoặc AQARA_TOKEN+AQARA_USERID");

  const cloud = new AquaraMobileClient({ area, token, userId });
  const matter = new AqaraMatterCloud(cloud);
  const dry = !!process.env.DRY;

  // ---- tìm home chứa khóa ----
  const locks = await matter.discoverLocks();
  if (!locks.length) throw new Error("không thấy khóa nào trong account");
  const lock = locks[0];
  const homePid = lock.homePositionId;
  console.log(`khóa: ${lock.did} (${lock.name}) @home ${homePid}`);

  // ---- (2) tín hiệu Matter đang sync ----
  const synced = await matter.getSignalDetails(homePid);
  console.log(`\nĐang sync ra Matter: ${synced.length} tín hiệu`);
  for (const s of synced) console.log(`  - ${s.id}  ${s.name}`);

  // ---- nguồn để tạo lại: toàn bộ event đã tạo (ưu tiên), fallback = chính các cái đang sync ----
  let candidates: Array<{ id: string; name: string }> = [];
  try {
    const all = await matter.iftttEventList(homePid);
    console.log(`\nTổng event đã tạo trong home: ${all.length}`);
    candidates = all.map((e) => ({ id: e.id, name: e.name }));
  } catch (e: any) {
    console.log(`(ifttt/event/list lỗi: ${e?.message?.slice(0, 80)} → dùng lại danh sách đang sync)`);
  }
  if (!candidates.length) candidates = synced;

  // ---- (4) ưu tiên + cắt 15 ----
  const planned = [...candidates]
    .sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name))
    .slice(0, LIMIT);
  console.log(`\nKế hoạch sync lại (ưu tiên ai-mở, tối đa ${LIMIT}): ${planned.length} tín hiệu`);
  for (const p of planned) console.log(`  [P${priority(p.name)}] ${p.id}  ${p.name}`);

  if (dry) { console.log("\nDRY=1 → dừng, không xóa/sync."); return; }

  // ---- (3) XÓA toàn bộ tín hiệu Matter đang sync (Aqara xóa theo DEVICE) ----
  if (synced.length) {
    // mọi tín hiệu đang sync đều thuộc khóa → xóa theo did khóa là sạch sạch hết.
    const dids = Array.from(new Set(locks.map((l) => l.did)));
    await matter.deleteSignals(dids, homePid);
    console.log(`\n🗑  Đã xóa tín hiệu của ${dids.length} thiết bị khỏi Matter bridge.`);
  } else {
    console.log("\n(không có tín hiệu nào đang sync để xóa)");
  }

  // ---- (5) tạo lại: sync danh sách sạch ----
  if (planned.length) {
    const map: Record<string, string> = {};
    for (const p of planned) map[p.id] = p.name;
    await matter.syncSignalsToMatter(map, homePid);
    console.log(`🔗 Đã sync lại ${planned.length} tín hiệu ra Matter.`);
  }

  // ---- (6) xác nhận ----
  const after = await matter.getSignalDetails(homePid);
  console.log(`\n✅ Sau cùng: ${after.length} tín hiệu đang sync ra Matter`);
  for (const s of after) console.log(`  - ${s.name}`);
}

main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
