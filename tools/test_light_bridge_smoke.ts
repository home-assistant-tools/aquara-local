import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";

process.env.LIGHT_STORAGE_ROOT = "/tmp/aqara-light-bridge-smoke";
process.env.LIGHT_MATTER_BASE_PORT = "16542";
rmSync(process.env.LIGHT_STORAGE_ROOT, { recursive: true, force: true });

const { closeAllLightBridges, ensureVirtualLight } = await import("../addon/app/lib/lightBridge.server");

const light = await ensureVirtualLight(
  {
    did: "lumi.54ef441000ed0cfa",
    name: "Khóa cửa tự động thông minh D100 (Phiên bản quốc tế)",
    model: "aqara.lock.aqgl01",
    homePositionId: "real1.test",
    roomPositionId: "real2.test",
    parentDeviceId: "lumi.gateway.test",
  },
  {
    did: "lumi.gateway.test",
    name: "M100",
    model: "lumi.gateway.agl008",
    homePositionId: "real1.test",
    roomPositionId: "real2.hub",
  },
);

assert.equal(light.status, "started");
assert.equal(light.currentLevel, 1);
assert.ok(light.manualPairingCode.length > 0);
assert.ok(light.qrPairingCode.startsWith("MT:"));

await closeAllLightBridges();
console.log("light bridge smoke ok");
