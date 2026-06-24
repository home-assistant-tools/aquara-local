// Runtime state dùng chung để addon CHẠY ĐƯỢC KHI MẤT MẠNG:
//  - cloud/auth: null khi chưa login được (offline) → caller tự degrade, KHÔNG crash.
//  - bridge-config cache: hub+khóa lưu xuống /data → lần sau (kể cả offline) dựng lại đèn-bridge
//    + MQTT entity mà KHÔNG cần internet. Internet chỉ cần cho: setup lần đầu + pin + lock cloud.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloudFor } from "./aqara.server";
import type { AuthData } from "./session.server";
import type { AqaraMatterCloud } from "../../../client/aqaraMatter";
import type { BridgeHub, BridgeLock } from "./lightBridge.server";

const STORAGE_ROOT = process.env.LIGHT_STORAGE_ROOT ?? "/data/aqara-light-bridges";
const CFG_PATH = join(STORAGE_ROOT, "bridge-config.json");

export interface CredLevel {
  level: number;
  label: string; // "Vân tay — Ba"
  state: "unlocked-out" | "unlocked-in";
  typeValue: string;
}
export interface BridgeConfig {
  hubs: BridgeHub[];
  locks: BridgeLock[];
  lockHub: Record<string, string>; // lockDid → hubDid
  credLevels?: CredLevel[]; // per-người (mở từ ngoài bởi ai) — mức 60+
}

let _cloud: AqaraMatterCloud | null = null;
let _auth: AuthData | null = null;

/** Đăng nhập thành công → có cloud client (online). */
export function setOnline(auth: AuthData): void {
  _auth = auth;
  _cloud = cloudFor(auth);
}
/** Mất mạng / login lỗi → offline (cloud=null). Local vẫn chạy. */
export function setOffline(): void {
  _cloud = null;
}
export function getCloud(): AqaraMatterCloud | null {
  return _cloud;
}
export function getAuth(): AuthData | null {
  return _auth;
}
export function isOnline(): boolean {
  return _cloud != null;
}

export function saveBridgeConfig(cfg: BridgeConfig): void {
  try {
    if (!existsSync(STORAGE_ROOT)) mkdirSync(STORAGE_ROOT, { recursive: true });
    writeFileSync(CFG_PATH, JSON.stringify(cfg));
  } catch {
    /* best-effort */
  }
}
export function loadBridgeConfig(): BridgeConfig | null {
  try {
    const c = JSON.parse(readFileSync(CFG_PATH, "utf8")) as BridgeConfig;
    return c?.locks?.length ? c : null;
  } catch {
    return null;
  }
}
export function hubForLock(cfg: BridgeConfig, lockDid: string): BridgeHub | undefined {
  return cfg.hubs.find((h) => h.did === cfg.lockHub[lockDid]) ?? cfg.hubs[0];
}
