import "@matter/nodejs";

import { Endpoint, Environment, Logger, LogLevel, ServerNode } from "@matter/main";

// Tắt DEBUG spam của matter.js (env MATTER_LOG_LEVEL không ăn vì init-order: process.env
// load vào vars SAU khi matter log sớm). WARN = vẫn giữ cảnh báo/lỗi, bỏ DEBUG/INFO/NOTICE.
// Giảm rác json-log trên d2. console.log của addon ([bootstrap]/[mqtt]) KHÔNG bị ảnh hưởng.
Logger.level = LogLevel.WARN;
import { AdministratorCommissioningServer } from "@matter/main/behaviors/administrator-commissioning";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commissionLightOntoAqaraFabric } from "../../../client/commissionLight";
import type { AqaraMatterCloud, MatterFabric } from "../../../client/aqaraMatter";

// ── Bảng mã hoá trạng thái/sự kiện khóa ↔ mức sáng đèn ────────────────────
// Mỗi sự kiện khóa (TD.*) → 1 mức sáng cố định (1..100). Dùng CHUNG cho:
//   • tạo automation "khóa TD.x → SetBrightness(level)" (matterSetup)
//   • addon decode currentLevel → nhãn + trạng thái khóa (locked/unlocked/event)
// FIX (2026-06-22): mức CỐ ĐỊNH (không sequential) để decode tất định + phân loại được.
// Aqara SetBrightness range = 1..100 (KHÔNG 254). Control mở khóa đi qua OnOff (không phải level).
export type LockState = "locked" | "unlocked-out" | "unlocked-in" | "unlocked" | "event";
export interface EventLevel {
  level: number;
  td: string; // triggerDefinitionId trên khóa
  label: string;
  state: LockState;
  params?: any[]; // tham số trigger (vd PD.lockUID cho per-người)
}
// TĨNH — KHÔNG dùng trigger generic "từ ngoài"/"vân tay bất kỳ" (chúng CHỒNG với per-người →
// nhấp nháy). Mở-từ-ngoài-bởi-người đi qua per-credential (động, mức 60+). Ở đây chỉ giữ:
//  • khóa lại, • CÁC kiểu MỞ TỪ TRONG (đi ra), • mở-ngoài KHÔNG gắn người (1-lần/chìa), • sự kiện.
export const EVENT_LEVELS: EventLevel[] = [
  { level: 5, td: "TD.ch31_value1", label: "Đã khóa", state: "locked" },
  // ── MỞ TỪ BÊN TRONG (đi ra) ──
  { level: 11, td: "TD.unlock_someone_indoor", label: "Mở từ bên trong", state: "unlocked-in" },
  { level: 12, td: "TD.ch49_value1", label: "Mở từ bên trong (chế độ vắng)", state: "unlocked-in" },
  { level: 13, td: "TD.unlock_someone_emergency", label: "Mở bằng nút khẩn cấp (bên trong)", state: "unlocked-in" },
  // ── MỞ TỪ BÊN NGOÀI, KHÔNG gắn người ──
  { level: 20, td: "TD.ch46_value0", label: "Mở bằng mật khẩu 1 lần", state: "unlocked-out" },
  { level: 21, td: "TD.ch47_value1", label: "Mở bằng chìa khẩn cấp", state: "unlocked-out" },
  { level: 22, td: "TD.unlock_someone_away", label: "Mở bằng chìa (chế độ vắng)", state: "unlocked-out" },
  // ── SỰ KIỆN (không đổi trạng thái khóa) ──
  { level: 30, td: "TD.ch17_value3", label: "Bấm chuông cửa", state: "event" },
  { level: 31, td: "TD.ch17_value2", label: "Cửa chưa đóng", state: "event" },
  { level: 32, td: "TD.ch17_value4", label: "Khóa bị can thiệp", state: "event" },
  { level: 33, td: "TD.ch32_value10", label: "Xác minh sai nhiều lần", state: "event" },
  { level: 40, td: "TD.ch54_value1", label: "Bật chế độ vắng nhà", state: "event" },
  { level: 41, td: "TD.ch54_value0", label: "Tắt chế độ vắng nhà", state: "event" },
  { level: 50, td: "TD.switch20_turn_on", label: "Bật khóa trẻ em", state: "event" },
  { level: 51, td: "TD.switch20_turn_off", label: "Tắt khóa trẻ em", state: "event" },
];
const LEVEL_INDEX = new Map<number, EventLevel>(EVENT_LEVELS.map((e) => [e.level, e]));

// ĐỘNG — per-credential "mở từ ngoài bởi NGƯỜI cụ thể" (mức 60+). matterSetup nạp từ cloud,
// bootstrap nạp lại từ cache để decode offline. {level → {label:"Vân tay — Ba", state}}.
const DYNAMIC_INDEX = new Map<number, { label: string; state: LockState }>();
export function registerDynamicLevels(entries: Array<{ level: number; label: string; state?: LockState }>): void {
  for (const e of entries) DYNAMIC_INDEX.set(e.level, { label: e.label, state: e.state ?? "unlocked-out" });
}
/** Toàn bộ nhãn sự kiện có thể có (tĩnh + động + hành động HA) — cho enum dropdown của HA. */
export function allEventLabels(): string[] {
  return [
    ...EVENT_LEVELS.filter((e) => e.state !== "locked").map((e) => e.label),
    ...[...DYNAMIC_INDEX.values()].map((e) => e.label),
    "Mở từ Home Assistant",
    "Khóa từ Home Assistant",
  ];
}

export interface BridgeLock {
  did: string;
  name: string;
  model: string;
  homePositionId: string;
  roomPositionId: string;
  parentDeviceId: string;
}

export interface BridgeHub {
  did: string;
  name: string;
  model: string;
  homePositionId: string;
  roomPositionId: string;
}

export interface LightBridgeInfo {
  key: string;
  lockDid: string;
  lockName: string;
  hubDid: string;
  homePositionId: string;
  roomPositionId: string;
  nodeIdHex: string | null;
  aqaraDid: string | null;
  model: string;
  currentLevel: number;
  manualPairingCode: string;
  qrPairingCode: string;
  status: "started" | "commissioned" | "bound" | "error";
  error?: string;
}

interface LightHandle {
  info: LightBridgeInfo;
  server: ServerNode;
  endpoint: Endpoint<typeof DimmableLightDevice>;
}

const handles = new Map<string, Promise<LightHandle>>();

// matter.js RuntimeService TỰ shutdown khi hết "worker" (RuntimeService.js: delete→size 0→cancel
// "Shutting down"). ServerNode dùng start() KHÔNG để lại worker bền → sau khi bootstrap xong các
// promise tạm hết → runtime tắt cả addon (~20s sau boot, crash-loop). Giữ 1 worker never-resolve
// để runtime sống mãi cho addon long-running. Chỉ thêm 1 lần.
let runtimeKeptAlive = false;
function keepRuntimeAlive(): void {
  if (runtimeKeptAlive) return;
  runtimeKeptAlive = true;
  try {
    (Environment.default as any).runtime.add(new Promise<void>(() => {}));
  } catch {
    /* nếu API đổi thì bỏ qua — chỉ là phòng shutdown */
  }
}
const STORAGE_ROOT = process.env.LIGHT_STORAGE_ROOT ?? "/data/aqara-light-bridges";
const BASE_MATTER_PORT = Number(process.env.LIGHT_MATTER_BASE_PORT ?? "5542");
const LIGHT_BRIDGE_SCHEMA = "v2";

function safeKey(did: string): string {
  return did.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function lightKey(lockDid: string): string {
  return `${LIGHT_BRIDGE_SCHEMA}-${safeKey(lockDid)}`;
}

function asciiShort(value: string, max = 32): string {
  return value.replace(/[^\x20-\x7e]/g, "").slice(0, max) || "D100 State";
}

function shortId(prefix: string, key: string, max = 32): string {
  const suffix = key.slice(-12);
  return `${prefix}-${suffix}`.slice(0, max);
}

function errorSummary(e: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const walk = (x: any) => {
    if (!x || seen.has(x)) return;
    seen.add(x);
    if (x.message) parts.push(String(x.message));
    if (x.cause) walk(x.cause);
    if (Array.isArray(x.errors)) x.errors.forEach(walk);
  };
  walk(e);
  return [...new Set(parts)].join(" | ").slice(0, 220) || String(e);
}

function discriminatorFor(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) & 0xffff;
  return 1000 + (h % 3000);
}

function portFor(key: string): number {
  let h = 0;
  for (const ch of key) h = (h * 33 + ch.charCodeAt(0)) & 0xffff;
  return BASE_MATTER_PORT + (h % 400);
}

// Persist lock→{nodeIdHex, aqaraDid} để restart KHÔNG commission lại (tránh device trùng).
interface BridgePersist {
  nodeIdHex: string | null;
  aqaraDid: string | null;
  roomPositionId?: string;
}
function persistPath(key: string): string {
  return join(STORAGE_ROOT, `${key}.bridge.json`);
}
function loadPersist(key: string): BridgePersist | null {
  try {
    return JSON.parse(readFileSync(persistPath(key), "utf8")) as BridgePersist;
  } catch {
    return null;
  }
}
function savePersist(key: string, p: BridgePersist): void {
  try {
    if (!existsSync(STORAGE_ROOT)) mkdirSync(STORAGE_ROOT, { recursive: true });
    writeFileSync(persistPath(key), JSON.stringify(p));
  } catch {
    /* best-effort */
  }
}

function hubNodeOverride(hubDid: string): string | undefined {
  const mapRaw = process.env.HUB_NODE_ID_HEX_BY_DID;
  if (mapRaw) {
    try {
      const map = JSON.parse(mapRaw) as Record<string, string>;
      const v = map[hubDid];
      if (v) return v.replace(/^0x/i, "").toUpperCase();
    } catch {
      /* ignore bad env */
    }
  }
  return process.env.HUB_NODE_ID_HEX?.replace(/^0x/i, "").toUpperCase();
}

async function createVirtualLight(lock: BridgeLock, hub: BridgeHub): Promise<LightHandle> {
  const key = lightKey(lock.did);
  if (!existsSync(STORAGE_ROOT)) mkdirSync(STORAGE_ROOT, { recursive: true });
  const storagePath = join(STORAGE_ROOT, key);
  Environment.default.vars.set("storage.path", storagePath);

  const server = await ServerNode.create({
    id: `d100-state-light-${key}`,
    network: { port: portFor(key) },
    productDescription: { name: asciiShort(`D100 State ${lock.name}`), deviceType: DimmableLightDevice.deviceType },
    commissioning: { passcode: 20202023, discriminator: discriminatorFor(key) },
    basicInformation: {
      vendorId: 0xfff1,
      vendorName: "Aqara-DIY",
      productId: 0xd102,
      productName: "D100 State Light",
      productLabel: asciiShort(`D100 ${lock.name}`),
      hardwareVersion: 1,
      hardwareVersionString: "1.0",
      softwareVersion: 1,
      softwareVersionString: "0.2.0-lightbridge",
      serialNumber: shortId("D100", key),
      nodeLabel: asciiShort(`D100 ${lock.name}`),
      uniqueId: shortId("d100-light", key),
    },
  } as any);

  // onOff idle = false: pulseUnlock set true (→ automation "đèn ON → unlock") rồi reset false.
  // level = kênh TRẠNG THÁI (hub set qua SetBrightness), độc lập onOff.
  const endpoint = new Endpoint(DimmableLightDevice, {
    id: "light-1",
    onOff: { onOff: false },
    levelControl: { currentLevel: 1 },
  });
  await server.add(endpoint);
  await server.start();
  keepRuntimeAlive(); // giữ matter runtime sống — tránh tự "Shutting down" khi hết worker tạm

  endpoint.events.levelControl.currentLevel$Changed.on((v: number | null) => {
    const info = handlesInfo.get(key);
    if (info) info.currentLevel = Number(v ?? 0);
    for (const cb of levelChangeCbs) {
      try {
        cb(lock.did, Number(v ?? 0));
      } catch {
        /* ignore subscriber error */
      }
    }
  });

  const { manualPairingCode, qrPairingCode } = server.state.commissioning.pairingCodes;
  const persisted = loadPersist(key); // reuse device đã commission ở lần chạy trước
  const info: LightBridgeInfo = {
    key,
    lockDid: lock.did,
    lockName: lock.name,
    hubDid: hub.did,
    homePositionId: lock.homePositionId,
    roomPositionId: persisted?.roomPositionId ?? lock.roomPositionId,
    nodeIdHex: persisted?.nodeIdHex ?? null,
    aqaraDid: persisted?.aqaraDid ?? null,
    model: "aqara.matter.65521_53506",
    currentLevel: endpoint.state.levelControl.currentLevel ?? 1,
    manualPairingCode,
    qrPairingCode,
    status: persisted?.aqaraDid ? "bound" : "started",
  };
  handlesInfo.set(key, info);
  return { info, server, endpoint };
}

const handlesInfo = new Map<string, LightBridgeInfo>();

// Realtime hook: gọi khi mức sáng đèn-bridge đổi (= hub set theo sự kiện khoá) → MQTT publish ngay.
const levelChangeCbs = new Set<(lockDid: string, level: number) => void>();
export function onBridgeLevelChange(cb: (lockDid: string, level: number) => void): () => void {
  levelChangeCbs.add(cb);
  return () => levelChangeCbs.delete(cb);
}

export async function ensureVirtualLight(lock: BridgeLock, hub: BridgeHub): Promise<LightBridgeInfo> {
  const key = lightKey(lock.did);
  if (!handles.has(key)) {
    handles.set(
      key,
      createVirtualLight(lock, hub).catch((err) => {
        handles.delete(key);
        handlesInfo.delete(key);
        throw err;
      }),
    );
  }
  return (await handles.get(key)!).info;
}

export async function ensureLightBridge(args: {
  cloud: AqaraMatterCloud;
  fabric: MatterFabric;
  hub: BridgeHub;
  lock: BridgeLock;
}): Promise<LightBridgeInfo> {
  const handle = await (handles.get(lightKey(args.lock.did)) ?? createVirtualLight(args.lock, args.hub));
  handles.set(lightKey(args.lock.did), Promise.resolve(handle));
  const info = handle.info;
  if (info.aqaraDid) return info;

  try {
    const deviceNodeIdHex = await args.cloud.genNodeId(args.lock.homePositionId);
    const controllerNodeIdHex =
      hubNodeOverride(args.hub.did) ?? (await args.cloud.genNodeId(args.lock.homePositionId));
    info.nodeIdHex = deviceNodeIdHex;

    await commissionLightOntoAqaraFabric({
      fabric: args.fabric,
      deviceNodeIdHex,
      controllerNodeIdHex,
      passcode: 20202023,
      discriminator: discriminatorFor(info.key),
      storagePath: join(STORAGE_ROOT, `${info.key}-controller`),
      onAfterCase: async () => {
        await args.cloud.signup(args.hub.did, deviceNodeIdHex, args.lock.homePositionId);
        const bind = await args.cloud.waitBind(deviceNodeIdHex, args.lock.homePositionId, 45_000);
        info.aqaraDid = bind.did;
        info.roomPositionId = bind.roomId || info.roomPositionId;
        savePersist(info.key, { nodeIdHex: deviceNodeIdHex, aqaraDid: bind.did, roomPositionId: info.roomPositionId });
      },
    });
    info.status = info.aqaraDid ? "bound" : "commissioned";
  } catch (e: any) {
    info.status = "error";
    info.error = errorSummary(e);
  }
  return info;
}

// Mở lại cửa sổ commissioning BASIC trên đèn-bridge để fabric thứ 2 (vd Home Assistant) pair.
// Dùng default passcode → manualPairingCode/qrPairingCode GIỮ NGUYÊN như lúc tạo đèn.
export async function openPairingWindow(
  lockDid: string,
  seconds = 600,
): Promise<{ manualPairingCode: string; qrPairingCode: string }> {
  const handle = await handles.get(lightKey(lockDid));
  if (!handle) throw new Error("Chưa có light bridge cho khóa này. Chạy setup trước.");
  await handle.server.act((agent) =>
    agent.get(AdministratorCommissioningServer).openBasicCommissioningWindow({ commissioningTimeout: seconds }),
  );
  const { manualPairingCode, qrPairingCode } = handle.server.state.commissioning.pairingCodes;
  return { manualPairingCode, qrPairingCode };
}

export function getLightInfo(lockDid: string): LightBridgeInfo | null {
  return handlesInfo.get(lightKey(lockDid)) ?? null;
}

export function allLightInfos(): LightBridgeInfo[] {
  return [...handlesInfo.values()];
}

// Mở khóa LOCAL: pulse OnOff false→true (cạnh changeTo_On kích automation "đèn ON → unlock"
// chạy LOCAL trên hub → mở D100), rồi reset false để arm lần sau. KHÔNG đụng level (kênh state).
export async function pulseUnlock(lockDid: string): Promise<LightBridgeInfo> {
  const handle = await handles.get(lightKey(lockDid));
  if (!handle) throw new Error("Chưa có light bridge cho khóa này. Chạy setup Matter trước.");
  await handle.endpoint.set({ onOff: { onOff: false } });
  await new Promise((r) => setTimeout(r, 250));
  await handle.endpoint.set({ onOff: { onOff: true } }); // ← cạnh ON kích unlock
  setTimeout(() => handle.endpoint.set({ onOff: { onOff: false } }).catch(() => {}), 1500); // re-arm
  return handle.info;
}

/** currentLevel → nhãn sự kiện (tiếng Việt). tĩnh + động (per-người). null nếu không map. */
export function decodeLevel(level: number): string | null {
  if (level <= 1) return null;
  return LEVEL_INDEX.get(level)?.label ?? DYNAMIC_INDEX.get(level)?.label ?? null;
}

/** currentLevel → trạng thái khóa cho HA. Gộp unlocked-out/in → "unlocked" (entity khóa nhị phân);
 *  hướng trong/ngoài đã thể hiện ở nhãn sự kiện. */
export function lockStateFromLevel(level: number): "locked" | "unlocked" | "event" | "unknown" {
  if (level <= 1) return "unknown";
  const st = LEVEL_INDEX.get(level)?.state ?? DYNAMIC_INDEX.get(level)?.state;
  if (st === "locked") return "locked";
  if (st === "unlocked" || st === "unlocked-in" || st === "unlocked-out") return "unlocked";
  if (st === "event") return "event";
  return "unknown";
}

/** currentLevel → hướng mở: "in" (từ trong) / "out" (từ ngoài) / null. Cho sensor riêng trên HA. */
export function unlockDirectionFromLevel(level: number): "in" | "out" | null {
  const st = LEVEL_INDEX.get(level)?.state ?? DYNAMIC_INDEX.get(level)?.state;
  if (st === "unlocked-in") return "in";
  if (st === "unlocked-out") return "out";
  return null;
}

/** currentLevel → đổi Chế độ Vắng nhà (realtime từ bridge): true (vừa BẬT) / false (vừa TẮT) / null. */
export function awayModeFromLevel(level: number): boolean | null {
  const td = LEVEL_INDEX.get(level)?.td;
  if (td === "TD.ch54_value1") return true; // Bật chế độ vắng nhà
  if (td === "TD.ch54_value0") return false; // Tắt chế độ vắng nhà
  return null;
}

export async function closeAllLightBridges(): Promise<void> {
  const settled = await Promise.allSettled(handles.values());
  handles.clear();
  handlesInfo.clear();
  for (const item of settled) {
    if (item.status === "fulfilled") await item.value.server.close();
  }
}
