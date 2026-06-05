// Cache thử nghiệm cho handshake BLE D100.
// App production không dùng cache khi vào LockDetail; cache chỉ giữ cho nghiên cứu/replay.
// Ý tưởng test: lưu {cloudPublicKey, devicePublicKey, sessionKey, nonce, verifyData}, rồi replay 0610/0710.
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface CachedHandshake {
  cloudPublicKey: string;
  devicePublicKey: string;
  sessionKey: string;
  nonce: string;
  verifyData: string;
  ts: number; // epoch ms lúc cache
}

const TTL_MS = 6 * 60 * 60 * 1000; // 6 giờ
const KEY = (did: string) => `hs.session.${did}`;
const PREFIX = "hs.session.";
const mem = new Map<string, CachedHandshake>();

export async function loadSession(did: string, opts: { allowExpired?: boolean } = {}): Promise<CachedHandshake | null> {
  const m = mem.get(did);
  if (m && (opts.allowExpired || Date.now() - m.ts < TTL_MS)) return m;
  try {
    const raw = await AsyncStorage.getItem(KEY(did));
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedHandshake;
    if (!opts.allowExpired && Date.now() - c.ts >= TTL_MS) { await clearSession(did); return null; }
    mem.set(did, c);
    return c;
  } catch { return null; }
}

export async function saveSession(did: string, c: Omit<CachedHandshake, "ts">): Promise<void> {
  const full: CachedHandshake = { ...c, ts: Date.now() };
  mem.set(did, full);
  try { await AsyncStorage.setItem(KEY(did), JSON.stringify(full)); } catch { /* bỏ qua */ }
}

export async function clearSession(did: string): Promise<void> {
  mem.delete(did);
  try { await AsyncStorage.removeItem(KEY(did)); } catch { /* bỏ qua */ }
}

export async function listCachedSessionDids(): Promise<string[]> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    return keys
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => k.slice(PREFIX.length))
      .filter(Boolean);
  } catch { return []; }
}
