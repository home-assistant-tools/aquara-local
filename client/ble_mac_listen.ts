#!/usr/bin/env bun
// Passive BLE advertisement logger cho D100 — KHÔNG connect, KHÔNG handshake.
// Mục đích: kiểm tra 2 endpoint của khóa (Aqara MiOT + HomeKit) có ĐỔI gì trong
// advertisement khi mở khóa không. Chạy script → mở khóa → xem dòng "CHANGED".
//
// Yêu cầu:
//   - macOS: chạy từ Terminal.app TRỰC TIẾP (TCC Bluetooth). Lần đầu macOS prompt → Allow.
//   - Đặt Mac MINI sát cửa (lần test trước RSSI -84 + adv thưa → xa là không nghe được).
//
// Usage (chạy từ Terminal.app, KHÔNG cần env login):
//   bun run client/ble_mac_listen.ts                 # nghe mãi (Ctrl-C để dừng)
//   LISTEN_SECONDS=120 bun run client/ble_mac_listen.ts
//   LOG_ALL=1 bun run client/ble_mac_listen.ts       # log MỌI thiết bị (debug UUID)
//
// Cách đọc kết quả:
//   - Mỗi endpoint in 1 dòng "first seen" + raw manufacturerData.
//   - Khi payload đổi → in "CHANGED" + diff (vị trí byte khác nhau).
//   - Mở khóa vài lần, để ý có "CHANGED" nào xuất hiện ĐÚNG lúc mở không.
//   - Aqara MiOT: theo dõi frameControl (2 byte). HomeKit: theo dõi GSN (tăng dần).
import noble from "@stoprocent/noble";

// 2 endpoint đã biết của D100 (xem MacBleClient.ts dòng 8-9). UUID per-host của máy này;
// nếu máy khác thấy UUID khác thì bật LOG_ALL=1 để dò lại.
const KNOWN: Record<string, string> = {
  "59e9553dbcf3b01a9eb83288e4a9be46": "Aqara-MiOT",
  "b7c7245d": "HomeKit", // prefix; HomeKit UUID đầy đủ có thể khác, match theo prefix
};
const NAME_MATCH = ["dp1a", "aqara", "lock", "door"];
// D100 nhận diện chắc chắn qua manufacturerData, KHÔNG qua UUID (macOS RPA xoay địa chỉ).
const LOCK_MAC = "5a58004d56ed"; // MAC reversed (ED:56:4D:00:58:5A) nhúng trong mfg
const LOCK_MFG_PREFIX = "4c4d"; // LuMi marker đầu manufacturerData endpoint MiOT

const LISTEN_SECONDS = Number(process.env.LISTEN_SECONDS ?? "0"); // 0 = forever
const LOG_ALL = process.env.LOG_ALL === "1";
const HEARTBEAT_MS = 15_000;

function hex(b?: Buffer | null): string {
  return b && b.length ? Buffer.from(b).toString("hex") : "";
}
function now(): string {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm (UTC)
}
function tagFor(uuid: string, name: string, mfg: string): string | null {
  if (mfg.startsWith(LOCK_MFG_PREFIX) || mfg.includes(LOCK_MAC)) return "Aqara-LOCK";
  const u = uuid.toLowerCase();
  for (const [k, v] of Object.entries(KNOWN)) if (u === k || u.startsWith(k)) return v;
  if (NAME_MATCH.some((n) => name.includes(n))) return `name:${name}`;
  return LOG_ALL ? `other:${u.slice(0, 8)}` : null;
}

// diff 2 chuỗi hex → liệt kê các byte khác nhau (offset: old→new)
function diffHex(a: string, b: string): string {
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 2) {
    const x = a.slice(i, i + 2) || "··";
    const y = b.slice(i, i + 2) || "··";
    if (x !== y) out.push(`[${i / 2}] ${x}→${y}`);
  }
  return out.join("  ");
}

// Parse manufacturerData của Aqara (company 0x115F → LE "5f11"): frameControl/model/mac.
function annotate(tag: string, mfg: string): string {
  if (tag === "Aqara-LOCK" && mfg.startsWith(LOCK_MFG_PREFIX)) {
    // [0:4]=4c4d marker [4:8]frameControl [8:16]model [16:28]mac(reversed)
    return `frameControl=${mfg.slice(4, 8)} model=${mfg.slice(8, 16)} mac=${mfg.slice(16, 28)}`;
  }
  if (tag === "HomeKit" && mfg.startsWith("4c00")) {
    // Apple HomeKit adv: 4c00 06 <subtype/len> <flags> <devid 6B> <category 2B> <GSN 2B> ...
    // GSN tăng mỗi lần state đổi → nếu tăng đúng lúc mở khóa = detector dùng được (kể cả chưa giải mã).
    return `homekit-raw (xem GSN ~offset 13-14): ${mfg.slice(26, 30) || "?"}`;
  }
  return "";
}

interface Seen {
  mfg: string;
  svc: string;
  count: number;
  rssi: number;
}
const seen = new Map<string, Seen>();

function onDiscover(p: any): void {
  const uuid = (p.uuid ?? "").toLowerCase();
  const name = (p.advertisement?.localName ?? "").trim().toLowerCase();
  const mfg = hex(p.advertisement?.manufacturerData);
  const tag = tagFor(uuid, name, mfg);
  if (!tag) return;

  const svc = (p.advertisement?.serviceData ?? [])
    .map((s: any) => `${s.uuid}=${hex(s.data)}`)
    .join(",");
  const rssi = p.rssi;
  // Khóa xoay địa chỉ (RPA) → key theo identity khóa để bắt thay đổi xuyên các uuid.
  const key = tag === "Aqara-LOCK" ? "lock" : uuid;
  const prev = seen.get(key);

  if (!prev) {
    console.log(
      `${now()} [${tag}] FIRST rssi=${rssi} uuid=${uuid}\n` +
        `         mfg=${mfg} ${annotate(tag, mfg)}` +
        (svc ? `\n         svc=${svc}` : ""),
    );
    seen.set(key, { mfg, svc, count: 1, rssi });
    return;
  }

  prev.count++;
  prev.rssi = rssi;
  if (mfg !== prev.mfg || svc !== prev.svc) {
    console.log(
      `${now()} [${tag}] ⚡ CHANGED rssi=${rssi} (after ${prev.count} advs)\n` +
        (mfg !== prev.mfg
          ? `         mfg: ${prev.mfg}\n          →   ${mfg}   ${annotate(tag, mfg)}\n         diff: ${diffHex(prev.mfg, mfg)}\n`
          : "") +
        (svc !== prev.svc ? `         svc: ${prev.svc} → ${svc}\n` : ""),
    );
    prev.mfg = mfg;
    prev.svc = svc;
  }
}

async function main(): Promise<void> {
  const state = (noble as any).state;
  if (state !== "poweredOn") {
    await new Promise<void>((resolve, reject) => {
      (noble as any).on("stateChange", (s: string) => {
        console.log(`${now()} bluetooth state: ${s}`);
        if (s === "poweredOn") resolve();
        else if (s === "unauthorized" || s === "unsupported")
          reject(new Error(`BT state=${s} — macOS TCC chưa cấp BT. Chạy từ Terminal.app trực tiếp.`));
      });
    });
  }

  (noble as any).on("discover", onDiscover);
  console.log(
    `${now()} scanning (allowDuplicates=true)… ${LOG_ALL ? "[LOG_ALL]" : `targets=${Object.values(KNOWN).join("|")}|name~${NAME_MATCH.join("/")}`}`,
  );
  console.log(`${now()} → Bây giờ MỞ KHÓA vài lần và để ý dòng "⚡ CHANGED".\n`);
  await noble.startScanningAsync([], true); // allowDuplicates=TRUE = mấu chốt để thấy thay đổi

  const hb = setInterval(() => {
    const parts = [...seen.entries()].map(
      ([u, s]) => `${KNOWN[u] ?? u.slice(0, 6)}: ${s.count} advs rssi=${s.rssi}`,
    );
    console.log(`${now()} ·heartbeat· ${parts.join(" | ") || "(chưa thấy endpoint nào — Mac có sát cửa không? chạm khóa để wake)"}`);
  }, HEARTBEAT_MS);

  const stop = async () => {
    clearInterval(hb);
    await noble.stopScanningAsync().catch(() => void 0);
    console.log(`\n${now()} stopped. Tổng:`);
    for (const [u, s] of seen) console.log(`  ${KNOWN[u] ?? u.slice(0, 8)}  advs=${s.count}  lastRssi=${s.rssi}`);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  if (LISTEN_SECONDS > 0) setTimeout(stop, LISTEN_SECONDS * 1000);
}

main().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
