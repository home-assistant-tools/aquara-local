import { AquaraMobileClient } from "../../../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../../../client/aqaraMatter";
import { loginWithPasswordPlain } from "../../../client/loginPlain";
import type { AuthData } from "./session.server";
export { REGIONS } from "./regions";

export async function login(email: string, password: string, area: string): Promise<AuthData> {
  const r = await loginWithPasswordPlain({ email, password, area, district: area === "CN" ? "CN" : "VN" });
  return { token: r.token, userId: r.userId, area, email };
}

export function cloudFor(auth: AuthData): AqaraMatterCloud {
  const c = new AquaraMobileClient({ area: auth.area, token: auth.token, userId: auth.userId });
  return new AqaraMatterCloud(c);
}

export interface LockView {
  did: string;
  name: string;
  model: string;
  homePositionId: string;
  roomPositionId: string;
  lockState: string; // "locked" | "unlocked" | raw
  battery: number | null;
  online: boolean;
  events: LockEvent[];
}

export interface LockEvent {
  ts: number;
  action: "unlock" | "lock" | "event";
  method: string; // fingerprint / password / nfc / key / remote / auto / ...
  user: string | null;
  raw: string;
}

// ---- decode lock_state ----------------------------------------------------
const LOCK_STATE: Record<string, string> = { "1": "unlocked", "2": "locked", "3": "unlocked", "4": "locked" };

// ---- decode lock_local_log (ai mở + cách mở) ------------------------------
// value hex; byte[0]=event type. Map theo coordinator/events HACS (đủ cho hiển thị).
const METHOD: Record<number, { action: LockEvent["action"]; method: string }> = {
  0x01: { action: "unlock", method: "vân tay" },
  0x02: { action: "unlock", method: "mật khẩu" },
  0x03: { action: "unlock", method: "NFC" },
  0x04: { action: "unlock", method: "chìa khóa" },
  0x05: { action: "unlock", method: "mật khẩu 1 lần" },
  0x06: { action: "unlock", method: "khuôn mặt" },
  0x07: { action: "lock", method: "đóng" },
  0x0b: { action: "unlock", method: "từ xa" },
  0x0c: { action: "unlock", method: "tự động" },
};

export function decodeLog(value: string, ts: number): LockEvent {
  const b0 = value.length >= 2 ? parseInt(value.slice(0, 2), 16) : -1;
  const m = METHOD[b0];
  // slot user (byte 1-2) nếu có — chỉ hiển thị id, tên ánh xạ từ credential ở loader
  const slot = value.length >= 6 ? parseInt(value.slice(2, 6), 16) : 0;
  return {
    ts,
    action: m?.action ?? "event",
    method: m?.method ?? `mã ${b0 >= 0 ? "0x" + b0.toString(16) : "?"}`,
    user: slot ? `slot ${slot}` : null,
    raw: value,
  };
}

/** Lấy đầy đủ view 1 khóa: state + battery + online + N event ai-mở gần nhất. */
export async function lockView(cloud: AqaraMatterCloud, lock: { did: string; name: string; model: string; homePositionId: string; roomPositionId: string }, nEvents = 8): Promise<LockView> {
  const [sig, hist] = await Promise.all([
    cloud.getLockSignals(lock.did).catch(() => ({} as Record<string, string>)),
    cloud.getLockHistory(lock.did, nEvents).catch(() => [] as any[]),
  ]);
  const events: LockEvent[] = (hist || [])
    .filter((h) => h?.attr === "lock_local_log" && h?.value)
    .slice(0, nEvents)
    .map((h) => decodeLog(String(h.value), Number(h.timeStamp) || 0));
  return {
    did: lock.did,
    name: lock.name,
    model: lock.model,
    homePositionId: lock.homePositionId,
    roomPositionId: lock.roomPositionId,
    lockState: LOCK_STATE[sig.lock_state] ?? sig.lock_state ?? "?",
    battery: sig.batt_0_remain_percentage != null ? Number(sig.batt_0_remain_percentage) : null,
    online: sig.device_offline_status === "1" || sig.device_offline_status == null,
    events,
  };
}
