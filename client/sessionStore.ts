// File-based cache phiên handshake BLE D100 cho Bun/Node (tương đương app/src/ble/sessionCache.ts
// của RN, nhưng ghi ra 1 file JSON thay vì AsyncStorage).
//
// Ý tưởng: handshake cloud 1 lần → lưu {cloudPublicKey, devicePublicKey, sessionKey, nonce,
// verifyData, mac}. Lần sau replay 0610 → nếu khoá trả CÙNG devicePublicKey thì tái dùng session
// (0 lần gọi cloud = mở OFFLINE). Cache hết hạn khi khoá XOAY devicePublicKey.
//
// File mặc định: ~/.aqara-sessions.json (override bằng env AQARA_SESSION_FILE).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CachedHandshake {
  did: string;
  mac: string;
  cloudPublicKey: string;
  devicePublicKey: string; // KHOÁ TRA CỨU — đổi = khoá xoay key = cache stale
  sessionKey: string;
  nonce: string;
  verifyData: string;
  ts: number; // epoch ms lúc tạo (để tính tuổi + LRU)
}

const FILE = process.env.AQARA_SESSION_FILE ?? join(homedir(), ".aqara-sessions.json");
const MAX = 50;

export function sessionFile(): string {
  return FILE;
}

function load(): CachedHandshake[] {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as CachedHandshake[]) : [];
  } catch {
    return [];
  }
}

function persist(list: CachedHandshake[]): void {
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

/** Phiên mới nhất của 1 did (ứng viên để replay 0610 dò devicePublicKey hiện tại). */
export function findLatestByDid(did: string): CachedHandshake | null {
  return (
    load()
      .filter((e) => e.did === did)
      .sort((a, b) => b.ts - a.ts)[0] ?? null
  );
}

/** Lưu/thay phiên theo (did, devicePublicKey), đẩy lên đầu, cắt LRU về MAX. */
export function saveSession(entry: Omit<CachedHandshake, "ts">): void {
  const k = entry.devicePublicKey.toLowerCase();
  const list = load().filter((e) => !(e.did === entry.did && e.devicePublicKey.toLowerCase() === k));
  list.unshift({ ...entry, ts: Date.now() });
  if (list.length > MAX) list.length = MAX;
  persist(list);
}

/** Xoá phiên của 1 did (khi khoá từ chối session cũ → buộc handshake mới). */
export function clearDid(did: string): void {
  const list = load();
  const next = list.filter((e) => e.did !== did);
  if (next.length !== list.length) persist(next);
}
