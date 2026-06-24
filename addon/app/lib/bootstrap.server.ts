// Headless bootstrap — THIẾT KẾ CHỊU MẤT MẠNG (chạy được khi offline):
//  • Pha A (LOCAL, không cần internet): từ cache /data → dựng đèn-bridge + MQTT entity + state realtime.
//  • Pha B (CLOUD, nền, tự thử lại): login → setup (commission/automation lần đầu) + refresh token.
// Mất mạng: Pha A vẫn chạy (state + mở khóa local); Pha B retry tới khi có mạng, KHÔNG làm sập addon.
import { login } from "./aqara.server";
import { runMatterSetup } from "./matterSetup.server";
import { startMqttBridge } from "./mqtt.server";
import { ensureVirtualLight, registerDynamicLevels } from "./lightBridge.server";
import { setOnline, setOffline, loadBridgeConfig, hubForLock } from "./runtime.server";

let started = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function startLocalFromCache(): Promise<boolean> {
  const cfg = loadBridgeConfig();
  if (!cfg) {
    console.log("[bootstrap] chưa có cache — cần internet lần đầu để setup.");
    return false;
  }
  console.log(`[bootstrap] cache có ${cfg.locks.length} khóa → dựng LOCAL (đèn-bridge + MQTT), KHÔNG cần internet…`);
  registerDynamicLevels(cfg.credLevels ?? []); // decode mức per-người (60+) khi offline
  for (const lock of cfg.locks) {
    const hub = hubForLock(cfg, lock.did);
    if (hub) await ensureVirtualLight(lock, hub).catch((e) => console.log(`[bootstrap] đèn ${lock.name} lỗi: ${e?.message ?? e}`));
  }
  await startMqttBridge(cfg.locks).catch((e) => console.log(`[mqtt] lỗi: ${e?.message ?? e}`));
  console.log("[bootstrap] LOCAL sẵn sàng (state + mở khóa chạy không cần internet).");
  return true;
}

async function cloudLoop(mqttStarted: boolean): Promise<void> {
  const email = process.env.AQARA_EMAIL;
  const pass = process.env.AQARA_PASS;
  const area = process.env.AQARA_AREA || "SEA";
  if (!email || !pass) {
    console.log("[bootstrap] không có AQARA_EMAIL/PASS → bỏ qua cloud (chỉ LOCAL).");
    return;
  }
  let everOk = false;
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`[bootstrap] login + cloud setup (lần ${attempt})…`);
      const auth = await login(email, pass, area);
      setOnline(auth);
      if (!everOk) {
        const res = await runMatterSetup(auth, { force: false });
        const bound = res.filter((r) => r.light?.aqaraDid).length;
        const autos = res.reduce((a, r) => a + r.automationsCreated, 0);
        console.log(`[bootstrap] cloud OK: ${bound}/${res.length} bound, ${autos} automation mới.`);
        for (const r of res) if (r.error) console.log(`[bootstrap]   ! ${r.lockName}: ${r.error}`);
        if (!mqttStarted) await startLocalFromCache(); // lần đầu (chưa cache): config vừa lưu → dựng LOCAL giờ
        everOk = true;
      }
      await sleep(6 * 60 * 60 * 1000); // refresh token mỗi 6h (giữ pin + unlock-cloud sống)
    } catch (e: any) {
      setOffline();
      console.log(`[bootstrap] cloud chưa lên (offline?) lần ${attempt}: ${e?.message ?? e}. LOCAL vẫn chạy, thử lại sau.`);
      await sleep(everOk ? 60_000 : 30_000);
    }
  }
}

async function boot(): Promise<void> {
  if (started) return;
  started = true;
  const mqttStarted = await startLocalFromCache(); // A: local trước (offline-capable)
  void cloudLoop(mqttStarted); // B: cloud nền
}

/** Kích headless bootstrap (idempotent). Gọi từ loader route công khai. */
export function kickBootstrap(): void {
  void boot();
}
