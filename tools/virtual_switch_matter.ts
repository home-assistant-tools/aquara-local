#!/usr/bin/env bun
// Virtual Unlock Switch — Matter On/Off device (PHA 1 của addon D100).
//
// MỤC ĐÍCH: dựng 1 công tắc ảo Matter (OnOffPlugInUnit) để **hub Aqara commission**.
// Sau đó trong app Aqara tạo automation: "công tắc này BẬT → mở khoá D100".
// → HA/CLI bật công tắc (PULSE) → hub chạy automation local → khoá mở. Không chạm crypto khoá.
//
// Đây KHÁC virtual_d100_matter.ts (cái đó là Door Lock để HA điều khiển). Cái này là CÒ:
// thiết bị Matter mà *hub Aqara* đóng vai controller commission, ta chỉ bật/tắt nó.
//
// CƠ CHẾ PULSE: automation Aqara kích theo CẠNH "bật". Mỗi lần mở khoá cần một chuyển
// OFF→ON mới, nên /pulse sẽ bật ON rồi tự tắt OFF sau PULSE_MS để lần sau bật lại được.
//
// Matter dùng mạng/mDNS (KHÔNG dùng Bluetooth) → KHÔNG dính TCC, chạy thẳng được:
//   bun run tools/virtual_switch_matter.ts
//   bun run tools/virtual_switch_matter.ts --reset   # xoá fabric, commission lại
//
// Commission: mở app Aqara → thêm thiết bị Matter → quét QR (hoặc nhập manual code) in ra đây.
// Hub phải là loại làm được Matter CONTROLLER (M100/M3), không chỉ bridge.
//
// Test sau khi commission:
//   curl -X POST localhost:8089/pulse        # OFF→ON→(PULSE_MS)→OFF  → automation mở khoá
//   curl -X POST localhost:8089/on           # giữ ON (để dựng/đặt trigger trong app)
//   curl -X POST localhost:8089/off
//   curl localhost:8089/status
import "@matter/nodejs"; // BẮT BUỘC: đăng ký Node.js platform shims (storage/crypto/net/mdns).

import { Endpoint, ServerNode, Environment } from "@matter/main";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { existsSync, rmSync } from "node:fs";
import qrTerminal from "qrcode-terminal";

const STORAGE_DIR = process.env.SWITCH_STORAGE ?? "/tmp/d100-switch-storage";
const PULSE_MS = parseInt(process.env.PULSE_MS ?? "1500", 10);
const MATTER_PORT = parseInt(process.env.MATTER_PORT ?? "5541", 10); // 5540 đã dành cho virtual_d100_matter.ts
const HTTP_PORT = parseInt(process.env.SWITCH_HTTP_PORT ?? "8089", 10);

if (process.argv.includes("--reset")) {
  if (existsSync(STORAGE_DIR)) {
    rmSync(STORAGE_DIR, { recursive: true, force: true });
    console.log(`✓ wiped ${STORAGE_DIR} (fabric & commissioning cleared)`);
  }
}

async function main(): Promise<void> {
  Environment.default.vars.set("storage.path", STORAGE_DIR);

  const server = await ServerNode.create({
    id: "d100-unlock-switch",
    network: { port: MATTER_PORT },
    productDescription: { name: "D100 Unlock Switch", deviceType: OnOffPlugInUnitDevice.deviceType },
    commissioning: {
      // KHÁC virtual_d100_matter.ts (20202021/3840) để 2 thiết bị chạy song song không đụng nhau.
      passcode: 20202022,
      discriminator: 3841,
    },
    basicInformation: {
      vendorId: 0xfff1, // Matter test vendor
      vendorName: "Aqara-DIY",
      productId: 0xd101,
      productName: "D100 Unlock Switch",
      productLabel: "D100 Local Unlock Trigger",
      hardwareVersion: 1,
      hardwareVersionString: "1.0",
      softwareVersion: 1,
      softwareVersionString: "0.1.0-phase1",
      serialNumber: `VSW-${Math.floor(Date.now() / 1000)}`,
      nodeLabel: "D100 Unlock",
      uniqueId: "d100-unlock-switch-uniq-001",
    },
  });

  const sw = new Endpoint(OnOffPlugInUnitDevice, {
    id: "switch-1",
    onOff: { onOff: false },
  });
  await server.add(sw);
  await server.start();

  // ----- In thông tin commissioning -----
  const { qrPairingCode, manualPairingCode } = server.state.commissioning.pairingCodes;
  console.log("");
  console.log("─".repeat(70));
  console.log(" Virtual Unlock Switch — Matter On/Off (cò mở khoá D100)");
  console.log("─".repeat(70));
  console.log(`  vendor   = Aqara-DIY (0xfff1)  product = D100 Unlock Switch (0xd101)`);
  console.log(`  storage  = ${STORAGE_DIR}   matter port = ${MATTER_PORT}   pulse = ${PULSE_MS}ms`);
  console.log("");
  console.log(`  Manual pairing code: ${manualPairingCode}`);
  console.log(`  QR pairing code:     ${qrPairingCode}`);
  console.log("");
  qrTerminal.generate(qrPairingCode, { small: true });
  console.log("");
  console.log("→ App Aqara: Thêm thiết bị → Matter → quét QR (hub M100 sẽ commission công tắc).");
  console.log("→ Sau đó tạo automation Aqara: 'công tắc này BẬT → mở khoá D100'.");
  console.log(`→ Test: curl -X POST localhost:${HTTP_PORT}/pulse  (OFF→ON→OFF) → khoá phải mở.`);
  console.log("");
  console.log("Ctrl+C để dừng (fabric persist tại storage ở trên).");

  sw.events.onOff.onOff$Changed.on((v: boolean) => {
    console.log(`[state] onOff → ${v ? "🟢 ON" : "⚪ OFF"}`);
  });

  // ----- Helpers điều khiển state -----
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;
  const setOnOff = (v: boolean) => sw.set({ onOff: { onOff: v } });
  async function pulse(ms: number): Promise<void> {
    if (pulseTimer) {
      clearTimeout(pulseTimer);
      pulseTimer = null;
    }
    await setOnOff(true);
    console.log(`[pulse] ON → tự OFF sau ${ms}ms`);
    pulseTimer = setTimeout(() => {
      pulseTimer = null;
      setOnOff(false).catch((e) => console.error("[pulse] OFF lỗi:", e?.message ?? e));
    }, ms);
  }

  // ============================================================================
  // HTTP control — để HA/CLI bật cò. Pha 2 addon sẽ gọi /pulse khi HA lock.unlock.
  // ============================================================================
  const httpServer = Bun.serve({
    port: HTTP_PORT,
    fetch: async (req) => {
      const url = new URL(req.url);
      const json = (data: unknown, status = 200) =>
        Response.json(data, { status, headers: { "cache-control": "no-store" } });
      try {
        if (url.pathname === "/" || url.pathname === "/help") {
          return json({
            endpoints: {
              "GET /status": "onOff state + commissioned (đã có hub nào pair chưa)",
              "POST /pulse?ms=<ms>": "OFF→ON→(ms)→OFF — cò mở khoá (mặc định PULSE_MS)",
              "POST /on": "giữ ON (dùng khi đang dựng trigger trong app Aqara)",
              "POST /off": "tắt OFF",
            },
          });
        }

        if (url.pathname === "/status") {
          const fabrics = server.state.commissioning.fabrics ?? {};
          return json({
            onOff: sw.state.onOff.onOff,
            commissioned: Object.keys(fabrics).length > 0,
            fabricCount: Object.keys(fabrics).length,
            manualPairingCode,
            qrPairingCode,
          });
        }

        if (req.method === "POST" && url.pathname === "/pulse") {
          const ms = parseInt(url.searchParams.get("ms") ?? String(PULSE_MS), 10);
          await pulse(ms);
          return json({ ok: true, action: "pulse", ms });
        }
        if (req.method === "POST" && url.pathname === "/on") {
          if (pulseTimer) {
            clearTimeout(pulseTimer);
            pulseTimer = null;
          }
          await setOnOff(true);
          return json({ ok: true, onOff: true });
        }
        if (req.method === "POST" && url.pathname === "/off") {
          if (pulseTimer) {
            clearTimeout(pulseTimer);
            pulseTimer = null;
          }
          await setOnOff(false);
          return json({ ok: true, onOff: false });
        }

        return json({ error: "not found" }, 404);
      } catch (e: any) {
        console.error("[http] error:", e?.stack ?? e);
        return json({ error: String(e?.message ?? e) }, 500);
      }
    },
  });
  console.log(`→ HTTP control: http://0.0.0.0:${httpServer.port}/help`);

  const shutdown = async () => {
    console.log("\n→ shutting down…");
    httpServer.stop();
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
main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  dumpErr(e);
  process.exit(1);
});
