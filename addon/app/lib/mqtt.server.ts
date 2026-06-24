// MQTT Discovery bridge → Home Assistant. CHẠY ĐƯỢC OFFLINE:
//  - trạng thái khóa: realtime từ mức sáng đèn-bridge (LOCAL, không cần internet).
//  - mở khóa: thử CẢ 2 đường — LOCAL (pulse đèn → automation hub) + CLOUD (/matter/write) song song.
//  - pin: poll cloud khi online; mất mạng thì bỏ qua, KHÔNG sập.
import mqtt, { type MqttClient } from "mqtt";
import { getCloud } from "./runtime.server";
import {
  pulseUnlock,
  onBridgeLevelChange,
  lockStateFromLevel,
  unlockDirectionFromLevel,
  decodeLevel,
  allEventLabels,
  type BridgeLock,
} from "./lightBridge.server";

const DIRECTION_OPTIONS = ["Từ bên ngoài", "Từ bên trong"];

const DISCOVERY_PREFIX = process.env.MQTT_DISCOVERY_PREFIX || "homeassistant";
const BASE = "aqara_d100";
const BATTERY_POLL_MS = 60_000;

let started = false;
let client: MqttClient | null = null;
const lastState = new Map<string, "LOCKED" | "UNLOCKED">();
// Khi addon TỰ mở/khóa (lệnh từ HA), KHÔNG để mức-sáng-bridge ghi đè nhãn "từ Home Assistant".
const selfActionUntil = new Map<string, number>();
const SELF_ACTION_MS = 12_000;
const isSelfAction = (u: string) => Date.now() < (selfActionUntil.get(u) ?? 0);

const uid = (lockDid: string) => lockDid.replace(/[^a-zA-Z0-9]/g, "_");
const stateTopic = (u: string) => `${BASE}/${u}/state`;
const cmdTopic = (u: string) => `${BASE}/${u}/set`;
const battTopic = (u: string) => `${BASE}/${u}/battery`;
const eventTopic = (u: string) => `${BASE}/${u}/event`;
const dirTopic = (u: string) => `${BASE}/${u}/direction`;
const availTopic = (u: string) => `${BASE}/${u}/availability`;

function deviceBlock(u: string, name: string) {
  return { identifiers: [`${BASE}_${u}`], name, manufacturer: "Aqara", model: "aqara.lock.aqgl01 (Matter bridge)" };
}

function publishDiscovery(u: string, name: string) {
  if (!client) return;
  const dev = deviceBlock(u, name);
  const cfg = (component: string, suffix: string, body: Record<string, unknown>) =>
    client!.publish(
      `${DISCOVERY_PREFIX}/${component}/${BASE}_${u}_${suffix}/config`,
      JSON.stringify({ ...body, availability_topic: availTopic(u), device: dev }),
      { retain: true, qos: 1 },
    );
  cfg("lock", "lock", {
    name: null, has_entity_name: true, unique_id: `${BASE}_${u}_lock`,
    state_topic: stateTopic(u), command_topic: cmdTopic(u),
    payload_lock: "LOCK", payload_unlock: "UNLOCK", state_locked: "LOCKED", state_unlocked: "UNLOCKED",
  });
  cfg("sensor", "battery", {
    name: "Pin", has_entity_name: true, unique_id: `${BASE}_${u}_battery`,
    device_class: "battery", unit_of_measurement: "%", state_topic: battTopic(u), entity_category: "diagnostic",
  });
  cfg("sensor", "event", {
    name: "Sự kiện gần nhất", has_entity_name: true, unique_id: `${BASE}_${u}_event`,
    state_topic: eventTopic(u), icon: "mdi:door",
    device_class: "enum", options: allEventLabels(), // → HA cho dropdown chọn (gồm per-người)
  });
  cfg("sensor", "direction", {
    name: "Hướng mở", has_entity_name: true, unique_id: `${BASE}_${u}_direction`,
    state_topic: dirTopic(u), icon: "mdi:door-open",
    device_class: "enum", options: DIRECTION_OPTIONS, // Từ bên ngoài / Từ bên trong
  });
}

/** Mở khóa thử CẢ 2 đường song song, mỗi đường best-effort. Trả nhãn đường nào chạy. */
async function unlockBothPaths(lockDid: string): Promise<string> {
  const cloud = getCloud();
  const tasks: Array<{ name: string; p: Promise<unknown> }> = [
    { name: "local", p: pulseUnlock(lockDid) }, // pulse đèn → automation hub (chạy kể cả offline)
  ];
  if (cloud) tasks.push({ name: "cloud", p: cloud.remoteUnlock(lockDid) }); // /matter/write 35011
  const res = await Promise.allSettled(tasks.map((t) => t.p));
  const ok = tasks.filter((_, i) => res[i].status === "fulfilled").map((t) => t.name);
  const fail = tasks.filter((_, i) => res[i].status === "rejected").map((t) => t.name);
  return `ok=[${ok.join(",")}]${fail.length ? ` fail=[${fail.join(",")}]` : ""}`;
}

/** Bắt đầu cầu nối MQTT cho danh sách khóa. CHẠY ĐƯỢC OFFLINE (cloud=null). Idempotent. */
export async function startMqttBridge(locks: BridgeLock[]): Promise<void> {
  if (started) return;
  const url = process.env.MQTT_URL;
  if (!url) {
    console.log("[mqtt] không có MQTT_URL → bỏ qua cầu nối HA.");
    return;
  }
  started = true;
  const byUid = new Map(locks.map((l) => [uid(l.did), l]));

  client = mqtt.connect(url, {
    username: process.env.MQTT_USER,
    password: process.env.MQTT_PASS,
    clientId: `aqara-d100-addon-${Math.floor(Date.now() % 1e6)}`,
    reconnectPeriod: 5000,
  });

  client.on("connect", () => {
    console.log(`[mqtt] connected ${url} — publish discovery cho ${locks.length} khóa`);
    for (const l of locks) {
      const u = uid(l.did);
      publishDiscovery(u, l.name || "Khóa D100");
      client!.publish(availTopic(u), "online", { retain: true }); // addon còn sống = available
      client!.subscribe(cmdTopic(u));
    }
  });

  client.on("message", async (topic, payload) => {
    const m = topic.match(new RegExp(`^${BASE}/(.+)/set$`));
    if (!m) return;
    const lock = byUid.get(m[1]);
    if (!lock) return;
    const u = m[1];
    const cmd = payload.toString().trim().toUpperCase();
    try {
      if (cmd === "UNLOCK") {
        selfActionUntil.set(u, Date.now() + SELF_ACTION_MS);
        client!.publish(eventTopic(u), "Mở từ Home Assistant", { retain: true });
        const how = await unlockBothPaths(lock.did);
        console.log(`[mqtt] UNLOCK ${lock.did} ${how}`);
      } else if (cmd === "LOCK") {
        selfActionUntil.set(u, Date.now() + SELF_ACTION_MS);
        client!.publish(eventTopic(u), "Khóa từ Home Assistant", { retain: true });
        const cloud = getCloud();
        if (cloud) {
          await cloud.remoteLock(lock.did); // chỉ có đường cloud (khóa không lộ action local)
          console.log(`[mqtt] LOCK ${lock.did} (cloud)`);
        } else {
          console.log(`[mqtt] LOCK ${lock.did} BỎ QUA — offline (D100 tự động khóa lại)`);
        }
      }
    } catch (e: any) {
      console.log(`[mqtt] lệnh ${cmd} ${lock.did} lỗi: ${e?.message ?? e}`);
    }
  });

  client.on("error", (e) => console.log("[mqtt] error:", e?.message ?? e));

  // Realtime LOCAL: mức sáng đèn-bridge đổi (hub set theo sự kiện khóa) → publish ngay. KHÔNG cần internet.
  onBridgeLevelChange((lockDid, level) => {
    if (!client?.connected) return;
    const u = uid(lockDid);
    const st = lockStateFromLevel(level);
    if (st === "locked" || st === "unlocked") {
      const v = st === "locked" ? "LOCKED" : "UNLOCKED";
      lastState.set(u, v);
      client.publish(stateTopic(u), v, { retain: true });
    }
    const ev = decodeLevel(level);
    if (ev && !isSelfAction(u)) client.publish(eventTopic(u), ev, { retain: true });
    const dir = unlockDirectionFromLevel(level); // trong/ngoài
    if (dir) client.publish(dirTopic(u), dir === "in" ? "Từ bên trong" : "Từ bên ngoài", { retain: true });
  });

  // Cloud poll (CHỈ khi online): pin + state-fallback. Mất mạng → bỏ qua, không sập.
  setInterval(async () => {
    const cloud = getCloud();
    if (!cloud || !client?.connected) return;
    for (const l of locks) {
      try {
        const sig = await cloud.getLockSignals(l.did);
        const u = uid(l.did);
        if (sig.batt_0_remain_percentage != null) client.publish(battTopic(u), String(sig.batt_0_remain_percentage), { retain: true });
        // state-fallback từ cloud chỉ khi bridge chưa cho trạng thái rõ
        if (!lastState.has(u)) {
          const cs = sig.lock_state === "2" || sig.lock_state === "4" ? "LOCKED" : sig.lock_state === "1" || sig.lock_state === "3" ? "UNLOCKED" : null;
          if (cs) client.publish(stateTopic(u), cs, { retain: true });
        }
      } catch {
        /* offline / lỗi cloud → bỏ qua nhịp này */
      }
    }
  }, BATTERY_POLL_MS);

  console.log("[mqtt] cầu nối HA sẵn sàng (state realtime LOCAL + unlock 2 đường + pin best-effort).");
}
