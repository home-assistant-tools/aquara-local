#!/usr/bin/env tsx
// Virtual State Light — Matter DIMMABLE light làm "bridge" mã hoá trạng thái khoá D100.
//
// Ý TƯỞNG (thay hướng signal-export rác, trần 15): 1 đèn ảo dimmable duy nhất. Mỗi MỨC
// ĐỘ SÁNG (currentLevel 1..254) = 1 trạng thái/sự kiện khoá (ai mở / cách mở / khoá/mở…).
//   • Hub Aqara commission đèn này (Matter controller) → tạo automation: "sự kiện khoá X →
//     đặt đèn = mức N" (createAutomation trong aqaraMatter.ts, action MoveToLevel + param level).
//   • HA cũng pair đèn (multi-fabric Matter) → đọc currentLevel → decode ra sự kiện.
// 1 thiết bị Matter, sức chứa ~254 mã >> 15 occupancy sensor. Hết rác.
//
// CHẠY (KHÔNG cần Bluetooth, dùng mDNS/mạng):
//   client/node_modules/.bin/tsx tools/virtual_dimmable_matter.ts
//   client/node_modules/.bin/tsx tools/virtual_dimmable_matter.ts --reset   # xoá fabric, commission lại
//
// Commission: app Aqara → Thêm thiết bị → Matter → quét QR in ra đây (hub M100 commission).
// Sau commission: chạy `getDeviceActions(<lightDid>)` để XÁC NHẬN Aqara có lòi action
// "đặt độ sáng = N" (MoveToLevel) dạng param hay không — đây là mảnh cuối cần verify.
//
// Quan sát bridge hoạt động:
//   curl localhost:8090/status                 # onOff + level + đã commission chưa
//   curl -X POST 'localhost:8090/level?v=128'  # set level (giả lập HA/test)
//   # khi Aqara automation set level → log [level] hiện ra ngay (chứng minh decode được).
import "@matter/nodejs"; // đăng ký Node.js platform shims (storage/crypto/net/mdns).

import { Endpoint, ServerNode, Environment } from "@matter/main";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { existsSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import qrTerminal from "qrcode-terminal";

const STORAGE_DIR = process.env.LIGHT_STORAGE ?? "/tmp/d100-statelight-storage";
const MATTER_PORT = parseInt(process.env.LIGHT_MATTER_PORT ?? "5542", 10); // 5540 lock, 5541 switch
const HTTP_PORT = parseInt(process.env.LIGHT_HTTP_PORT ?? "8090", 10);

if (process.argv.includes("--reset") && existsSync(STORAGE_DIR)) {
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  console.log(`✓ wiped ${STORAGE_DIR} (fabric & commissioning cleared)`);
}

async function main(): Promise<void> {
  Environment.default.vars.set("storage.path", STORAGE_DIR);

  const server = await ServerNode.create({
    id: "d100-state-light",
    network: { port: MATTER_PORT },
    productDescription: { name: "D100 State Light", deviceType: DimmableLightDevice.deviceType },
    commissioning: { passcode: 20202023, discriminator: 3842 }, // khác switch (…22/3841) & lock (…21/3840)
    basicInformation: {
      vendorId: 0xfff1, // Matter test vendor
      vendorName: "Aqara-DIY",
      productId: 0xd102,
      productName: "D100 State Light",
      productLabel: "D100 Lock-State Bridge",
      hardwareVersion: 1,
      hardwareVersionString: "1.0",
      softwareVersion: 1,
      softwareVersionString: "0.1.0-statelight",
      serialNumber: `VSL-${Math.floor(Date.now() / 1000)}`,
      nodeLabel: "D100 State",
      uniqueId: "d100-state-light-uniq-001",
    },
  });

  // Dimmable light: cluster LevelControl (currentLevel 1..254) + OnOff.
  const light = new Endpoint(DimmableLightDevice, {
    id: "light-1",
    onOff: { onOff: true },
    levelControl: { currentLevel: 1 },
  });
  await server.add(light);
  await server.start();

  const { qrPairingCode, manualPairingCode } = server.state.commissioning.pairingCodes;
  console.log("");
  console.log("─".repeat(70));
  console.log(" Virtual State Light — Matter Dimmable (bridge mã hoá trạng thái khoá D100)");
  console.log("─".repeat(70));
  console.log(`  vendor = Aqara-DIY (0xfff1)  product = D100 State Light (0xd102)`);
  console.log(`  storage = ${STORAGE_DIR}   matter port = ${MATTER_PORT}`);
  console.log("");
  console.log(`  Manual pairing code: ${manualPairingCode}`);
  console.log(`  QR pairing code:     ${qrPairingCode}`);
  console.log("");
  qrTerminal.generate(qrPairingCode, { small: true });
  console.log("");
  console.log("→ App Aqara: Thêm thiết bị → Matter → quét QR (hub M100 commission đèn).");
  console.log("→ Rồi: client/node_modules/.bin/tsx tools/probe_actions.ts  → xem action MoveToLevel.");
  console.log("→ HA: Add device → Matter → cùng QR (multi-fabric) → đọc brightness.");
  console.log("");
  console.log("Ctrl+C để dừng (fabric persist tại storage ở trên).");

  // Log MỌI thay đổi level/onOff — chính là tín hiệu decode được khi Aqara automation set.
  light.events.levelControl.currentLevel$Changed.on((v: number | null) => {
    console.log(`[level] currentLevel → ${v}   (← hub Aqara set? = 1 trạng thái khoá)`);
  });
  light.events.onOff.onOff$Changed.on((v: boolean) => console.log(`[onOff] → ${v ? "ON" : "OFF"}`));

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${HTTP_PORT}`}`);
    const json = (d: unknown, status = 200) => {
      const body = JSON.stringify(d);
      res.writeHead(status, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      res.end(body);
    };
    try {
        if (url.pathname === "/" || url.pathname === "/help") {
          return json({
            endpoints: {
              "GET /status": "onOff + currentLevel + commissioned",
              "POST /level?v=<1..254>": "đặt mức sáng (giả lập Aqara/HA để test)",
              "POST /on": "bật", "POST /off": "tắt",
            },
          });
        }
        if (url.pathname === "/status") {
          const fabrics = server.state.commissioning.fabrics ?? {};
          return json({
            onOff: light.state.onOff.onOff,
            currentLevel: light.state.levelControl.currentLevel,
            commissioned: Object.keys(fabrics).length > 0,
            fabricCount: Object.keys(fabrics).length,
            manualPairingCode, qrPairingCode,
          });
        }
        if (req.method === "POST" && url.pathname === "/level") {
          const v = Math.max(1, Math.min(254, parseInt(url.searchParams.get("v") ?? "1", 10)));
          await light.set({ levelControl: { currentLevel: v }, onOff: { onOff: true } });
          return json({ ok: true, currentLevel: v });
        }
        if (req.method === "POST" && url.pathname === "/on") { await light.set({ onOff: { onOff: true } }); return json({ ok: true, onOff: true }); }
        if (req.method === "POST" && url.pathname === "/off") { await light.set({ onOff: { onOff: false } }); return json({ ok: true, onOff: false }); }
        return json({ error: "not found" }, 404);
    } catch (e: any) {
      console.error("[http] error:", e?.stack ?? e);
      return json({ error: String(e?.message ?? e) }, 500);
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(HTTP_PORT, "0.0.0.0", resolve));
  console.log(`→ HTTP control: http://0.0.0.0:${HTTP_PORT}/help`);

  const shutdown = async () => {
    httpServer.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function dumpErr(e: any, indent = ""): void {
  console.error(`${indent}↪ ${e?.message ?? e}`);
  if (e?.cause) dumpErr(e.cause, indent + "  ");
  if (Array.isArray(e?.errors)) for (const sub of e.errors) dumpErr(sub, indent + "  ");
}
main().catch((e) => { console.error("FATAL:", e?.stack ?? e); dumpErr(e); process.exit(1); });
