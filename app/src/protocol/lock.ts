// Đóng/giải gói lệnh MIoT + opcode (đã verify gói openLock = gói thật từng byte).
import { mijiaCrc16 } from "./crc16";
import { aesCcmEncrypt, aesCcmDecrypt } from "./aesccm";
import { concatBytes, u16le } from "./hex";

export const MainCmd = { SYSTEM: 0x01, USER: 0x02, LOG: 0x03, LONG: 0x3f } as const;
export const SystemSub = {
  LOCK_STATUS: 0x07, TONGUE_STATUS: 0x08, GET_BATTERY_INFO: 0xde,
  GET_DOOR_LOCK_STATUS: 0xe5, REPORT_DOOR_LOCK_STATUS: 0xe6, BLE_OPEN_LOCK: 0x74,
} as const;
export const LogSub = { SET_VISTOR_PWD_VAILD_TIME: 0x21 } as const;   // set hiệu lực credential (validRange)
export const UserSub = { ADD_VISTOR_PWD: 0x13, REPORT_USER_ID_NEW: 0x15, DEL_USER: 0x03, DEL_USER_GROUP: 0x05 } as const;
export const ReplyMainCmd = { SYSTEM: 0x81, USER: 0x82, LOG: 0x83 } as const;
export const OpenLockType = { CLOSE: 0x00, OPEN: 0x01, UNBOLT: 0x02, TOGGLE: 0x03 } as const;

export interface LockKey { sessionKey: Uint8Array; nonce: Uint8Array; }
export interface LockFrame { mainCmd: number; subCmd: number; data: Uint8Array; }

/** packet ngắn = mainCmd ‖ AES-CCM(subCmd ‖ data ‖ CRC16-BE). MIC=4. */
export function packShort(key: LockKey, mainCmd: number, subCmd: number, data = new Uint8Array()): Uint8Array {
  const crc = mijiaCrc16(concatBytes(mainCmd, subCmd, data)); // [low, high]
  const crcBE = Uint8Array.from([crc[1], crc[0]]); // ⚠️ wire big-endian
  const plain = concatBytes(subCmd, data, crcBE);
  const cipher = aesCcmEncrypt(key.sessionKey, key.nonce, plain);
  return concatBytes(mainCmd, cipher);
}

export function unpack(key: LockKey, packet: Uint8Array): LockFrame {
  const mainCmd = packet[0];
  const plain = aesCcmDecrypt(key.sessionKey, key.nonce, packet.subarray(1));
  return { mainCmd, subCmd: plain[0], data: plain.subarray(1, Math.max(1, plain.length - 2)) };
}

/** Gói MỞ KHOÁ: 01/74 data=[opType]. open=01. */
export function buildOpenLock(key: LockKey, type: number = OpenLockType.OPEN, seq?: number): Uint8Array {
  const data = seq === undefined ? Uint8Array.of(type) : concatBytes(type, u16le(seq));
  return packShort(key, MainCmd.SYSTEM, SystemSub.BLE_OPEN_LOCK, data);
}
export function buildDoorStatusQuery(key: LockKey): Uint8Array {
  return packShort(key, MainCmd.SYSTEM, SystemSub.GET_DOOR_LOCK_STATUS);
}
export function buildDoorStatusReportQuery(key: LockKey): Uint8Array {
  return packShort(key, MainCmd.SYSTEM, SystemSub.REPORT_DOOR_LOCK_STATUS);
}
/** Gói SET HIỆU LỰC credential: 03/21 data=validRange (19B). Đẩy thẳng xuống firmware (đã verify ack 83/21/00). */
export function buildSetValidity(key: LockKey, validRange: Uint8Array): Uint8Array {
  return packShort(key, MainCmd.LOG, LogSub.SET_VISTOR_PWD_VAILD_TIME, validRange);
}

/** BCD mã hoá chuỗi số ("135790" → 13 57 90). Lẻ → pad nibble F. */
export function bcdEncode(digits: string): Uint8Array {
  const d = digits.length % 2 ? digits + "f" : digits;
  const out = new Uint8Array(d.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(d.substr(i * 2, 2), 16);
  return out;
}
/** Gói TẠO MẬT KHẨU: 02/13 data=[groupId][userType][credType=02][totalLen=bcdBytes+1][pwdLen=digits][pwd BCD]. (mainCmd 02, verify CRC). */
export function buildAddPassword(key: LockKey, groupId: number, pwdDigits: string, userType = 0x03): Uint8Array {
  const bcd = bcdEncode(pwdDigits);
  const data = concatBytes(groupId & 0xff, userType, 0x02, bcd.length + 1, pwdDigits.length, bcd);
  return packShort(key, MainCmd.USER, UserSub.ADD_VISTOR_PWD, data);
}
/** Gói XOÁ USER (nhóm): 02/05 data=[groupId]. */
export function buildDelUserGroup(key: LockKey, groupId: number): Uint8Array {
  return packShort(key, MainCmd.USER, UserSub.DEL_USER_GROUP, Uint8Array.of(groupId & 0xff));
}
/** Parse notify REPORT_USER_ID_NEW (02/15): trả userId mới khoá vừa gán, hoặc null. data=[err][userType][credType][op][groupId][userId 2B LE]… */
export function parseReportUserId(f: LockFrame): number | null {
  if (f.mainCmd !== 0x02 || f.subCmd !== UserSub.REPORT_USER_ID_NEW || f.data.length < 7) return null;
  return f.data[5] | (f.data[6] << 8);
}
