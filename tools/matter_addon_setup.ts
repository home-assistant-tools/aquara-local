#!/usr/bin/env bun
// matter_addon_setup.ts — Orchestrator addon: discover + tạo automation "switch ON → mở D100".
//
// Đây là logic SETUP của addon (chạy 1 lần sau khi switch đã commission vào hub).
// Dùng AquaraMobileClient (token có sẵn) → discovery → AqaraMatterCloud.createUnlockAutomation.
//
// Env:
//   AQARA_TOKEN, AQARA_USERID, AQARA_AREA(=SEA)   — hoặc AQARA_EMAIL/AQARA_PASSWORD để tự login
//   SWITCH_DID         (matt.xxx) — bỏ trống thì auto-detect theo model aqara.matter.* / tên
//   DRY=1              — chỉ in payload, KHÔNG gọi create
import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";

const LOCK_MODELS = ["aqara.lock.aqgl01", "aqgl", "dp1a", ".lock."];
const HUB_MATTER_MODELS = ["lumi.gateway.agl008", "lumi.gateway", "agl008"]; // M100-class controller

interface Dev { did: string; model: string; name: string; positionId: string; homePid: string }

// Account có thể có NHIỀU home → mỗi device mang theo homePid của nó. Caller chọn home
// chứa khóa (homes[0] có thể là home rỗng/khác → từng làm getFabric fail).
async function discoverDevices(cloud: AquaraMobileClient): Promise<Dev[]> {
  const home = await cloud.get<any>("/app/position/query/home/list", { needDefaultRoom: "false", size: 300, startIndex: 0 });
  const homes = home?.homes ?? home?.result?.homes ?? [];
  if (!homes.length) throw new Error("không thấy home nào");
  const all: Dev[] = [];
  for (const h of homes) {
    const homePid = h.positionId ?? h.homeId;
    const dev = await cloud.get<any>("/app/position/device/query", { positionId: homePid, size: 300, startIndex: 0 });
    const list = dev?.devices ?? dev?.data ?? dev?.result?.devices ?? [];
    for (const d of list)
      all.push({ did: d.did ?? d.subjectId, model: d.model ?? "", name: d.deviceName ?? d.name ?? "", positionId: d.positionId ?? homePid, homePid });
  }
  return all;
}

function pick(devices: Dev[], match: (d: Dev) => boolean): Dev | undefined {
  return devices.find(match);
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
  if (!token) throw new Error("cần AQARA_TOKEN+AQARA_USERID hoặc AQARA_EMAIL+AQARA_PASSWORD");

  const cloud = new AquaraMobileClient({ area, token, userId });
  const matter = new AqaraMatterCloud(cloud);

  // ---- discovery ----
  const devices = await discoverDevices(cloud);
  console.log(`devices: ${devices.length}`);
  for (const d of devices) console.log(`  ${d.did}  ${d.model}  ${JSON.stringify(d.name)}  @${d.positionId} home=${d.homePid}`);

  const lock = pick(devices, (d) => LOCK_MODELS.some((m) => d.model.toLowerCase().includes(m)));
  if (!lock) throw new Error("không thấy khóa (model aqara.lock.aqgl01)");
  // home ĐÚNG = home chứa khóa (account nhiều home → KHÔNG dùng homes[0]).
  const homePid = lock.homePid;
  console.log(`home positionId (chứa khóa) = ${homePid}`);
  const wantSwitch = process.env.SWITCH_DID;
  const sw =
    pick(devices, (d) => (wantSwitch ? d.did === wantSwitch : false)) ??
    pick(devices, (d) => d.model.startsWith("aqara.matter.") || /unlock switch/i.test(d.name));
  if (!sw) throw new Error("không thấy công tắc ảo Matter (commission switch trước, hoặc set SWITCH_DID)");

  // vendorId/productId từ model aqara.matter.{vid}_{pid}; mặc định switch của ta 0xFFF1/0xD101
  const mm = /^aqara\.matter\.(\d+)_(\d+)$/.exec(sw.model);
  const vid = mm ? Number(mm[1]) : 65521;
  const pid = mm ? Number(mm[2]) : 53505;

  console.log(`\n→ LOCK  : ${lock.did} @${lock.positionId} (${lock.name})`);
  console.log(`→ SWITCH: ${sw.did} model=${sw.model} (vid=${vid} pid=${pid}) @${sw.positionId}`);

  const payloadArgs = {
    homePositionId: homePid,
    name: `[addon] Mở khóa ${lock.name || "D100"} bằng công tắc ảo`,
    switchDid: sw.did,
    switchVendorIdDec: vid,
    switchProductIdDec: pid,
    switchRoomPositionId: sw.positionId,
    lockDid: lock.did,
    lockRoomPositionId: lock.positionId,
    lockName: lock.name,
  };

  if (process.env.DRY) {
    console.log("\nDRY=1 → bỏ qua create. payloadArgs:");
    console.log(JSON.stringify(payloadArgs, null, 2));
    return;
  }
  const linkageId = await matter.createUnlockAutomation(payloadArgs);
  console.log(`\n✅ Đã tạo automation. linkageId=${linkageId || "(server không trả id, kiểm tra app)"}`);
}

main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
