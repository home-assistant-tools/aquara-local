// Cache phiên handshake BLE D100 — đánh INDEX theo LOCK PUBLIC KEY (devicePublicKey).
// Ý tưởng: mỗi lần handshake cloud thành công, lưu trọn {cloudPublicKey, devicePublicKey,
// sessionKey, nonce, verifyData}. Lần sau replay 0610 → nếu khoá trả về CÙNG devicePublicKey
// (cùng epoch khoá chưa xoay key) thì TÁI DÙNG phiên cũ luôn, 0 lần gọi cloud.
// Giữ tối đa MAX_SESSIONS phiên (LRU — cũ nhất bị loại), kèm clearAllSessions() cho nút xoá cache.
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface CachedHandshake {
  did: string;
  cloudPublicKey: string;
  devicePublicKey: string; // KHOÁ TRA CỨU — public key của ổ khoá
  sessionKey: string;
  nonce: string;
  verifyData: string;
  ts: number; // epoch ms — cập nhật mỗi lần tạo / tái dùng (phục vụ LRU + hiển thị tuổi)
}

const STORE_KEY = "hs.sessions.v2";
const LEGACY_PREFIX = "hs.session."; // cache v1 (theo did) — dọn khi clear
export const MAX_SESSIONS = 1000;

let mem: CachedHandshake[] | null = null; // newest-first, đồng bộ với storage

const norm = (h: string) => (h || "").toLowerCase();

async function loadAll(): Promise<CachedHandshake[]> {
  if (mem) return mem;
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    mem = raw ? (JSON.parse(raw) as CachedHandshake[]) : [];
  } catch {
    mem = [];
  }
  return mem!;
}

async function persist(list: CachedHandshake[]): Promise<void> {
  mem = list;
  try {
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* bỏ qua lỗi ghi */
  }
}

/** Tìm phiên theo public key của khoá (so khớp không phân biệt hoa/thường). */
export async function findByDevicePublicKey(devicePublicKey: string): Promise<CachedHandshake | null> {
  const list = await loadAll();
  const k = norm(devicePublicKey);
  return list.find((e) => norm(e.devicePublicKey) === k) ?? null;
}

/** Phiên mới nhất của 1 did — dùng làm "ứng viên" để replay 0610 dò public key hiện tại. */
export async function findLatestByDid(did: string): Promise<CachedHandshake | null> {
  const list = await loadAll(); // newest-first
  return list.find((e) => e.did === did) ?? null;
}

/** Lưu / thay phiên theo devicePublicKey, đẩy lên đầu (mới nhất), cắt LRU về MAX_SESSIONS. */
export async function saveSession(entry: Omit<CachedHandshake, "ts">): Promise<void> {
  const list = await loadAll();
  const k = norm(entry.devicePublicKey);
  const next = list.filter((e) => norm(e.devicePublicKey) !== k);
  next.unshift({ ...entry, ts: Date.now() });
  if (next.length > MAX_SESSIONS) next.length = MAX_SESSIONS; // loại các phiên cũ nhất ở đuôi
  await persist(next);
}

/** Đánh dấu phiên vừa được tái dùng → đưa lên đầu LRU + làm mới ts. */
export async function touchSession(devicePublicKey: string): Promise<void> {
  const list = await loadAll();
  const k = norm(devicePublicKey);
  const idx = list.findIndex((e) => norm(e.devicePublicKey) === k);
  if (idx < 0) return;
  const [e] = list.splice(idx, 1);
  e.ts = Date.now();
  list.unshift(e);
  await persist(list);
}

/** Xoá mọi phiên của 1 did (khi khoá từ chối session cũ → buộc handshake mới). */
export async function clearSessionsForDid(did: string): Promise<void> {
  const list = await loadAll();
  const next = list.filter((e) => e.did !== did);
  if (next.length !== list.length) await persist(next);
}

/** Xoá TOÀN BỘ cache phiên (nút "Xoá cache"). Dọn luôn cache v1 cũ nếu còn. */
export async function clearAllSessions(): Promise<void> {
  await persist([]);
  try {
    await AsyncStorage.removeItem(STORE_KEY);
  } catch {
    /* bỏ qua */
  }
  try {
    const keys = await AsyncStorage.getAllKeys();
    const legacy = keys.filter((x) => x.startsWith(LEGACY_PREFIX));
    if (legacy.length) await AsyncStorage.multiRemove(legacy);
  } catch {
    /* bỏ qua */
  }
}

export async function sessionCount(): Promise<number> {
  return (await loadAll()).length;
}

/** Danh sách did đã từng có phiên (LockListScreen dùng để đoán fallbackDid). */
export async function listCachedSessionDids(): Promise<string[]> {
  const list = await loadAll();
  return [...new Set(list.map((e) => e.did).filter(Boolean))];
}
