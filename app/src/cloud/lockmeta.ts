// Decode/nhãn cho dữ liệu khóa D100 (credential type, trạng thái, log).
import { Credential, LockLogEntry, LockResource } from "./AqaraCloud";
import { hexToBytes, bytesToHex } from "../protocol/hex";

// ---- validRange (hiệu lực) ----
// Format 19B: [0:3]header(0c0001) [3:7]startUTC LE [7:11]endUTC LE [11:15]deadline(ffffffff=vĩnh viễn) [15:19]00
const FOREVER = "ffffffff";
function le32(n: number): Uint8Array { return Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff); }

/** deadline (unix giây) của validRange; null nếu vĩnh viễn/không có. */
export function validRangeDeadline(vr?: string): number | null {
  if (!vr || vr.length < 30) return null;
  const dl = vr.slice(22, 30).toLowerCase(); // bytes[11:15]
  if (dl === FOREVER) return null;
  const b = hexToBytes(dl);
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}
/** Credential đang bị vô hiệu hoá? (deadline đã qua) */
export function isCredentialDisabled(c: Credential): boolean {
  const dl = validRangeDeadline(c.validRange);
  return dl != null && dl * 1000 < Date.now();
}
/** userId của credential = 16 bit thấp của typeValue (vd 0x80010005 → 5). */
export function credUserId(c: Credential): number {
  return (parseInt(c.typeValue, 10) >>> 0) & 0xffff;
}
// Dựng validRange mới cho credential CHƯA có lịch — userId LẤY TỪ credential (KHÔNG hardcode!),
// repeatType=everyDay(01), cửa sổ ngày 00:00–23:59, deadline=vĩnh viễn (sẽ ghi đè).
function baseValidRange(c: Credential): Uint8Array {
  const now = new Date();
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime() / 1000);
  const end = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0).getTime() / 1000);
  const uid = credUserId(c);
  const b = new Uint8Array(19);
  b[0] = uid & 0xff; b[1] = (uid >> 8) & 0xff; b[2] = 0x01;   // [0:2]=userId LE, [2]=everyDay
  b.set(le32(start), 3); b.set(le32(end), 7);
  b.set([0xff, 0xff, 0xff, 0xff], 11);
  return b;
}
/** validRange để VÔ HIỆU HOÁ: deadline = quá khứ. Hợp lệ cho mọi loại (kể cả vân tay user thường). */
export function disabledValidRange(c: Credential): string {
  const past = Math.floor(Date.now() / 1000) - 86400;
  const b = c.validRange && c.validRange.length >= 38 ? hexToBytes(c.validRange) : baseValidRange(c);
  b.set(le32(past), 11);
  return bytesToHex(b);
}
/** validRange để KÍCH HOẠT lại: deadline = vĩnh viễn (ffffffff = set về hiện tại, luôn hiệu lực). */
export function enabledValidRange(c: Credential): string {
  const b = c.validRange && c.validRange.length >= 38 ? hexToBytes(c.validRange) : baseValidRange(c);
  b.set([0xff, 0xff, 0xff, 0xff], 11);
  return bytesToHex(b);
}

/** validRange vĩnh viễn (luôn hiệu lực) cho 1 userId — dùng khi tạo credential mới. */
export function permanentValidRangeForUserId(userId: number): string {
  const now = new Date();
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime() / 1000);
  const end = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0).getTime() / 1000);
  const b = new Uint8Array(19);
  b[0] = userId & 0xff; b[1] = (userId >> 8) & 0xff; b[2] = 0x01;
  b.set(le32(start), 3); b.set(le32(end), 7);
  b.set([0xff, 0xff, 0xff, 0xff], 11);
  return bytesToHex(b);
}
/** typeValue = base(loại) + userId. pwd 0x80020000, vân tay 0x80010000, NFC 0x80050000. */
export function typeValueFor(type: number, userId: number): string {
  const base: Record<number, number> = { 1: 0x80010000, 2: 0x80020000, 3: 0x80050000, 6: 0x80070000 };
  return String(((base[type] ?? 0x80020000) + userId) >>> 0);
}

/** unix giây hôm nay tại phút thứ `min` (0..1439). */
function todayAtMin(min: number): number {
  const now = new Date();
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(min / 60), min % 60, 0).getTime() / 1000);
}
/** Dựng validRange linh hoạt: deadline (unix giây | null=vĩnh viễn), khung giờ ngày startMin..endMin. */
export function buildUserValidRange(userId: number, opts: { deadline: number | null; startMin?: number; endMin?: number; repeatType?: number }): string {
  const b = new Uint8Array(19);
  b[0] = userId & 0xff; b[1] = (userId >> 8) & 0xff; b[2] = opts.repeatType ?? 0x01;
  b.set(le32(todayAtMin(opts.startMin ?? 0)), 3);
  b.set(le32(todayAtMin(opts.endMin ?? 23 * 60 + 59)), 7);
  if (opts.deadline == null) b.set([0xff, 0xff, 0xff, 0xff], 11);
  else b.set(le32(opts.deadline), 11);
  return bytesToHex(b);
}

const REPEAT_LBL: Record<number, string> = { 0: "Một lần", 1: "Hàng ngày", 2: "Hàng tuần", 3: "Hàng tháng", 4: "Khoảng cố định" };
function u32le(b: Uint8Array, o: number): number { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function p2(n: number): string { return String(n).padStart(2, "0"); }
function fmtDateTime(s: number): string { const d = new Date(s * 1000); return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`; }
function fmtHm(s: number): string { const d = new Date(s * 1000); return `${p2(d.getHours())}:${p2(d.getMinutes())}`; }

/** Giải mã ĐẦY ĐỦ hiệu lực của credential để hiển thị. */
export function validityInfo(c: Credential): { hasRange: boolean; disabled: boolean; lines: string[] } {
  if (!c.validRange || c.validRange.length < 38) {
    return { hasRange: false, disabled: false, lines: ["Hiệu lực: Vĩnh viễn (không giới hạn thời gian)"] };
  }
  const b = hexToBytes(c.validRange);
  const repeat = b[2];
  const start = u32le(b, 3), end = u32le(b, 7);
  const dlHex = c.validRange.slice(22, 30).toLowerCase();
  const deadline = dlHex === "ffffffff" ? null : u32le(b, 11);
  const disabled = deadline != null && deadline * 1000 < Date.now();
  return {
    hasRange: true, disabled,
    lines: [
      `Trạng thái: ${disabled ? "⛔ Vô hiệu hoá (đã hết hạn)" : "✅ Đang hiệu lực"}`,
      `Hiệu lực đến: ${deadline == null ? "Vĩnh viễn" : fmtDateTime(deadline)}`,
      `Khung giờ trong ngày: ${fmtHm(start)} – ${fmtHm(end)}`,
      `Lặp lại: ${REPEAT_LBL[repeat] ?? `mã ${repeat}`}`,
      `Slot khoá (userId): ${(b[0] | (b[1] << 8))}`,
    ],
  };
}

export const CRED_TYPE: Record<number, { label: string; icon: string }> = {
  1: { label: "Vân tay", icon: "🫆" },
  2: { label: "Mật khẩu", icon: "🔢" },
  3: { label: "Thẻ NFC", icon: "💳" },
  4: { label: "eKey / Bluetooth", icon: "📲" },
  5: { label: "Mật khẩu tạm", icon: "⏱️" },
  6: { label: "Khuôn mặt", icon: "🙂" },
  7: { label: "NFC Tag", icon: "🏷️" },
};

export function credTypeLabel(type: number): string {
  return CRED_TYPE[type]?.label ?? `Loại ${type}`;
}
export function credTypeIcon(type: number): string {
  return CRED_TYPE[type]?.icon ?? "🔑";
}

/** validRange (hex) → có giới hạn hiệu lực hay không + mô tả thô. */
export function validRangeLabel(c: Credential): string | null {
  if (!c.validRange || /^0*$/.test(c.validRange)) return null;
  // Có validRange = lịch/giới hạn. Giải thô: nếu toàn ff ở phần thời gian ⇒ vĩnh viễn theo lịch.
  return "Có lịch / giới hạn hiệu lực";
}

/** Gom credential theo nhóm người dùng. */
export function groupCredentials(creds: Credential[]): { groupId: string; groupName: string; items: Credential[] }[] {
  const map = new Map<string, { groupId: string; groupName: string; items: Credential[] }>();
  for (const c of creds) {
    const id = c.typeGroupId ?? "?";
    if (!map.has(id)) map.set(id, { groupId: id, groupName: c.typeGroupName ?? `Nhóm ${id}`, items: [] });
    map.get(id)!.items.push(c);
  }
  return [...map.values()];
}

// ---- Trạng thái (res/query) ----
export function resourceMap(res: LockResource[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const r of res) m[r.attr] = r.value;
  return m;
}
export function lockStateLabel(v?: string): string {
  // Aqara lock_state (D100): quan sát 4 ≈ đã khóa/đóng, 6 sau BLE unlock thành công.
  switch (v) {
    case "0": return "Mở chốt";
    case "6": return "Đã mở";
    case "1": return "Đã khóa";
    case "2": return "Lỗi";
    case "4": return "Đã khóa";
    default: return v ? `Mã ${v}` : "—";
  }
}

// ---- Log mở khóa ----
// value vd "0b0009b100000000edff206a". Hiển thị thời gian là chính (timeStamp đã có).
// source vd "10,,<ts>,lumi....trg=0,," → số đầu = loại sự kiện/nguồn.
export function logSourceLabel(e: LockLogEntry): string {
  const head = (e.source ?? "").split(",")[0];
  const SRC: Record<string, string> = {
    "10": "Mở bằng vân tay/mật khẩu",
    "46": "Mở từ xa / app",
    "11": "Mở bằng NFC",
    "12": "Mở bằng chìa",
  };
  return SRC[head] ?? (head ? `Sự kiện ${head}` : "Sự kiện khóa");
}

/** Tóm tắt hiệu lực của 1 USER (lấy từ credential đại diện — chúng dùng chung validRange). */
export function userValidityText(items: Credential[]): { text: string; disabled: boolean; hasRange: boolean } {
  const c = items.find((x) => x.validRange && x.validRange.length >= 38);
  if (!c) return { text: "Vĩnh viễn (không giới hạn)", disabled: false, hasRange: false };
  const b = hexToBytes(c.validRange!);
  const start = u32le(b, 3), end = u32le(b, 7);
  const dlHex = c.validRange!.slice(22, 30).toLowerCase();
  const deadline = dlHex === "ffffffff" ? null : u32le(b, 11);
  const disabled = deadline != null && deadline * 1000 < Date.now();
  const win = `${fmtHm(start)}–${fmtHm(end)}`;
  const winPart = win === "00:00–23:59" ? "" : ` · trong ngày ${win}`;
  if (disabled) return { text: `⛔ Vô hiệu (hết hạn ${fmtDateTime(deadline!)})`, disabled: true, hasRange: true };
  if (deadline == null) return { text: `✅ Vĩnh viễn${winPart}`, disabled: false, hasRange: true };
  return { text: `✅ Hiệu lực đến ${fmtDateTime(deadline)}${winPart}`, disabled: false, hasRange: true };
}

/** Đọc hiệu lực HIỆN TẠI của 1 USER để PRE-FILL form sửa.
 * startMin/endMin = phút trong ngày (0..1439); deadline = unix giây | null(vĩnh viễn); allDay = khung phủ cả ngày. */
export function readUserValidity(items: Credential[]): {
  startMin: number; endMin: number; deadline: number | null; allDay: boolean; repeatType: number;
} {
  const c = items.find((x) => x.validRange && x.validRange.length >= 38);
  if (!c) return { startMin: 0, endMin: 23 * 60 + 59, deadline: null, allDay: true, repeatType: 1 };
  const b = hexToBytes(c.validRange!);
  const start = u32le(b, 3), end = u32le(b, 7);
  const ds = new Date(start * 1000), de = new Date(end * 1000);
  const startMin = ds.getHours() * 60 + ds.getMinutes();
  const endMin = de.getHours() * 60 + de.getMinutes();
  const dlHex = c.validRange!.slice(22, 30).toLowerCase();
  const deadline = dlHex === "ffffffff" ? null : u32le(b, 11);
  const allDay = startMin === 0 && endMin >= 23 * 60 + 59;
  return { startMin, endMin, deadline, allDay, repeatType: b[2] };
}

// userId → {tên user, loại credential} để giải log.
export function buildUidMap(creds: Credential[]): Record<number, { who: string; type: number }> {
  const m: Record<number, { who: string; type: number }> = {};
  for (const c of creds) {
    const uid = (parseInt(c.typeValue, 10) >>> 0) & 0xffff;
    m[uid] = { who: c.typeGroupName, type: c.type };
  }
  return m;
}

export interface UnlockLog { icon: string; method: string; who: string }
/** Giải lock_local_log: phương thức + ai mở. value `0b0009 20 [uid LE] 01 [src]` = mở bằng credential; b1=tự khoá. */
export function decodeUnlockLog(e: LockLogEntry, uidMap: Record<number, { who: string; type: number }>): UnlockLog {
  const v = (e.value || "").toLowerCase();
  const src = (e.source || "").split(",")[0];
  let b: Uint8Array; try { b = hexToBytes(v); } catch { b = new Uint8Array(); }
  if (v.startsWith("0b0009") && b.length >= 8) {
    if (b[3] === 0x20) { // mở bằng credential tại khoá
      const uid = b[4] | (b[5] << 8);
      const u = uidMap[uid];
      if (u) return { icon: credTypeIcon(u.type), method: `Mở bằng ${credTypeLabel(u.type).toLowerCase()}`, who: u.who };
      return { icon: "🔓", method: "Mở khoá", who: `slot ${uid}` };
    }
    if (b[3] === 0xb1 || b[3] === 0x00) return { icon: "🔒", method: "Tự động khoá", who: "" };
  }
  if (src === "46") return { icon: "📲", method: "Mở từ xa (app)", who: "" };
  if (src === "11") return { icon: "💳", method: "Mở bằng thẻ NFC", who: "" };
  if (src === "12") return { icon: "🗝️", method: "Mở bằng chìa", who: "" };
  return { icon: "🔓", method: "Sự kiện khoá", who: "" };
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
