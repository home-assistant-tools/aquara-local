// Headless bootstrap — THIẾT KẾ CHỊU MẤT MẠNG (chạy được khi offline):
//  • Pha A (LOCAL, không cần internet): từ cache /data → dựng đèn-bridge + MQTT entity + state realtime.
//  • Pha B (CLOUD, nền, tự thử lại): login → setup (commission/automation lần đầu) + refresh token.
// Mất mạng: Pha A vẫn chạy (state + mở khóa local); Pha B retry tới khi có mạng, KHÔNG làm sập addon.
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { login } from "./aqara.server";
import { runMatterSetup } from "./matterSetup.server";
import { startMqttBridge } from "./mqtt.server";
import { ensureVirtualLight, registerDynamicLevels } from "./lightBridge.server";
import { setOnline, setOffline, loadBridgeConfig, hubForLock } from "./runtime.server";

const STORAGE_ROOT = process.env.LIGHT_STORAGE_ROOT ?? "/data/aqara-light-bridges";
let started = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Dọn lock matter.js CŨ (stale) lúc khởi động → tránh "Storage is locked (pid X)" khi container cũ bị
 *  SIGKILL không kịp nhả + container mới TRÙNG pid (matter.js tưởng còn sống → không tự dọn). An toàn vì
 *  addon là tiến trình DUY NHẤT dùng các storage này; lúc boot chưa có process nào đang giữ lock. */
function cleanStaleLocks(dir = STORAGE_ROOT): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (statSync(p).isDirectory()) cleanStaleLocks(p);
      else if (name.endsWith(".lock")) {
        unlinkSync(p);
        console.log(`[bootstrap] dọn stale lock: ${p}`);
      }
    } catch {
      /* ignore */
    }
  }
}

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
  let setupOk = false;
  for (let attempt = 1; ; attempt++) {
    try {
      const auth = await login(email, pass, area);
      setOnline(auth); // ONLINE NGAY sau login → cloud poll (pin + lock-state) chạy, KHÔNG chờ matter-setup
      if (!setupOk) {
        try {
          const res = await runMatterSetup(auth, { force: false });
          const bound = res.filter((r) => r.light?.aqaraDid).length;
          const autos = res.reduce((a, r) => a + r.automationsCreated, 0);
          console.log(`[bootstrap] cloud setup OK: ${bound}/${res.length} bound, ${autos} automation mới.`);
          for (const r of res) if (r.error) console.log(`[bootstrap]   ! ${r.lockName}: ${r.error}`);
          if (!mqttStarted) await startLocalFromCache(); // lần đầu (chưa cache): config vừa lưu → dựng LOCAL giờ
          setupOk = true;
        } catch (e: any) {
          // SETUP lỗi KHÔNG làm cloud offline → pin + lock-state VẪN poll được. Thử lại setup lần sau.
          console.log(`[bootstrap] matter-setup lỗi (cloud VẪN online, thử lại 60s): ${e?.message ?? e}`);
        }
      }
      await sleep(setupOk ? 6 * 60 * 60 * 1000 : 60_000); // xong: refresh token 6h; chưa xong: thử setup lại 60s
    } catch (e: any) {
      setOffline(); // CHỈ login lỗi mới → offline (mất mạng). Setup lỗi KHÔNG đụng tới đây.
      console.log(`[bootstrap] login lỗi lần ${attempt} (offline?): ${e?.message ?? e}. LOCAL vẫn chạy, thử lại 30s.`);
      await sleep(30_000);
    }
  }
}

async function boot(): Promise<void> {
  if (started) return;
  started = true;
  cleanStaleLocks(); // dọn lock cũ TRƯỚC khi matter.js mở storage (Pha A)
  const mqttStarted = await startLocalFromCache(); // A: local trước (offline-capable)
  void cloudLoop(mqttStarted); // B: cloud nền
}

/** Kích headless bootstrap (idempotent). Gọi từ loader route công khai. */
export function kickBootstrap(): void {
  void boot();
}
