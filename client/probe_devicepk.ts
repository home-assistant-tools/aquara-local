#!/usr/bin/env bun
// Probe: khóa D100 có trả CÙNG devicePublicKey qua nhiều lần handshake không?
// → quyết định cache-replay (mở offline) BỀN hay hết hạn mỗi session.
//
// KHÔNG cần cloud/creds: gửi 0610 với 1 cloudPublicKey P-256 HỢP LỆ tự sinh (dummy),
// đọc devicePublicKey khóa trả về. Lặp N lần (disconnect+reconnect giữa các lần) rồi so.
// Nếu khóa KHÔNG reply 0610 cho dummy → khóa validate origin của cloudPublicKey (cũng là
// thông tin quan trọng cho câu hỏi self-handshake offline).
//
// Chạy từ Terminal.app (BT grant), máy gần khóa. Env: PROBES(=2), GAP_MS(=3000).
import { createECDH } from "node:crypto";
import { MacBleClient } from "./MacBleClient";
import { buildAiotFrames, Reassembler, extractPublicKey } from "./framing";
import { UUID } from "./constants";
import { bytesToHex } from "./hex";

const N = Number(process.env.PROBES ?? "2");
const GAP_MS = Number(process.env.GAP_MS ?? "3000");

/** cloudPublicKey dummy = P-256 uncompressed hợp lệ (0x04|X|Y, 65B) tự sinh. */
function dummyCloudPK(): Uint8Array {
  const ec = createECDH("prime256v1");
  ec.generateKeys();
  return new Uint8Array(ec.getPublicKey());
}

/** Gửi 0610(cloudPK) trên kênh handshake, ghép notify 'da…' trả về (mirror bleHandshakeExchange). */
async function exchange0610(ble: MacBleClient, cloudPK: Uint8Array): Promise<Uint8Array> {
  const reasm = new Reassembler();
  return new Promise<Uint8Array>(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("0610 reply timeout (9s)")), 9000);
    const unsub = await ble.listen(UUID.HANDSHAKE_NOTIFY, (pkt) => {
      const full = reasm.push(pkt);
      if (full) {
        clearTimeout(timer);
        unsub();
        resolve(full);
      }
    });
    for (const chunk of buildAiotFrames(0x0610, cloudPK)) await ble.send(UUID.HANDSHAKE_WRITE, chunk);
  });
}

async function probeOnce(i: number): Promise<string | null> {
  const ble = new MacBleClient({ log: (m) => console.log(`  [ble#${i}] ${m}`) });
  try {
    const t = Date.now();
    await ble.connect(""); // MacBleClient scan+connect theo UUID (bỏ qua mac trên macOS)
    console.log(`  [#${i}] connected ${Date.now() - t}ms — gửi 0610…`);
    const reply = await exchange0610(ble, dummyCloudPK());
    const dpk = bytesToHex(extractPublicKey(reply));
    console.log(`  [#${i}] devicePublicKey = ${dpk}`);
    return dpk;
  } catch (e: any) {
    console.log(`  [#${i}] FAIL: ${e?.message ?? e}`);
    return null;
  } finally {
    await ble.disconnect().catch(() => void 0);
  }
}

async function main(): Promise<void> {
  console.log(`probe devicePublicKey x${N} (gap ${GAP_MS}ms)…`);
  const keys: (string | null)[] = [];
  for (let i = 1; i <= N; i++) {
    keys.push(await probeOnce(i));
    if (i < N) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  const ok = keys.filter(Boolean) as string[];
  console.log(`\n=== KẾT QUẢ ===`);
  keys.forEach((k, i) => console.log(`  #${i + 1}: ${k ?? "(fail)"}`));
  if (ok.length < 2) {
    console.log(`→ chưa đủ 2 lần thành công để so. (connect fail vì RSSI xa? hoặc khóa không reply dummy 0610?)`);
    return;
  }
  const allSame = ok.every((k) => k.toLowerCase() === ok[0].toLowerCase());
  console.log(
    allSame
      ? `→ GIỐNG NHAU ✅ — khóa giữ devicePublicKey ỔN ĐỊNH → cache-replay OFFLINE BỀN (warm 1 lần, mở offline lâu dài).`
      : `→ KHÁC NHAU ❌ — khóa XOAY devicePublicKey mỗi session → cache hết hạn ngay → MiOT khó offline, nên đi HomeKit-key.`,
  );
}

main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  process.exit(1);
});
