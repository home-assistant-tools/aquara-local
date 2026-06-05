import {
  MainCmd,
  ReplyMainCmd,
  SystemSub,
  UserSub,
  LogSub,
  OpenLockType,
  CredType,
  RepeatType,
  UUID,
} from "./constants";
import { mijiaCrc16 } from "./crc16";
import { NodeAesCcm, type AesCcm } from "./crypto";
import { concatBytes, u16le, u16be, u32le, bytesToHex } from "./hex";
import { fragment } from "./framing";
import type { BleClient, Unsubscribe } from "./BleClient";

export interface LockKey {
  sessionKey: Uint8Array; // 16B
  nonce: Uint8Array; // 13B
}

export interface LockFrame {
  mainCmd: number;
  subCmd: number;
  data: Uint8Array;
}

export interface DoorLockStatus {
  lockStatus: number; // 00 locked / 01 unlocked / 02 error
  doorStatus?: number;
  raw: Uint8Array;
}

export interface BatterySlot {
  pos: number;
  status: number;
  type: number;
  level: number; // %
  onLoad: boolean; // bit0
  charging: boolean; // bit1
}

/**
 * Khoá Aqara D100 qua BLE-direct. Khởi tạo bằng `key` (sessionKey+nonce lấy từ
 * AquaraMobileClient.getLockKey) + 1 BleClient đã kết nối.
 *
 * Đóng gói lệnh = getMiotShortPackString (✅ reverse): packet = mainCmd ‖ AES-CCM(subCmd‖data‖CRC16).
 * ⚠️ Tham số AES-CCM (MIC=4, nonce-direct) là giả thuyết — xem crypto.ts / README §8.
 */
export class AquaraLock {
  private readonly ccm: AesCcm;

  constructor(
    private readonly key: LockKey,
    private readonly ble: BleClient,
    opts: { aesCcm?: AesCcm } = {},
  ) {
    if (key.sessionKey.length !== 16) throw new Error("sessionKey phải 16B");
    if (key.nonce.length !== 13) throw new Error("nonce phải 13B");
    this.ccm = opts.aesCcm ?? NodeAesCcm;
  }

  // ===== đóng gói / giải gói (lõi MIoT) ====================================
  /** packet ngắn = mainCmd ‖ AES-CCM(subCmd ‖ data ‖ CRC16(mainCmd‖subCmd‖data)). */
  packShort(mainCmd: number, subCmd: number, data: Uint8Array = new Uint8Array()): Uint8Array {
    const forCrc = concatBytes(mainCmd, subCmd, data);
    const crc = mijiaCrc16(forCrc); // getCrc16Arr trả [low, high]
    // ⚠️ Wire MIoT append CRC BIG-ENDIAN (đảo) — verify 5/5 với khoá thật (openLock=7401f404).
    const crcBE = Uint8Array.from([crc[1], crc[0]]);
    const plain = concatBytes(subCmd, data, crcBE);
    const cipher = this.ccm.encrypt(this.key.sessionKey, this.key.nonce, plain);
    return concatBytes(mainCmd, cipher);
  }

  /** Giải 1 notify khoá → {mainCmd, subCmd, data}. */
  unpack(packet: Uint8Array): LockFrame {
    const mainCmd = packet[0];
    const plain = this.ccm.decrypt(this.key.sessionKey, this.key.nonce, packet.subarray(1));
    const subCmd = plain[0];
    const data = plain.subarray(1, Math.max(1, plain.length - 2)); // bỏ CRC 2B cuối
    return { mainCmd, subCmd, data };
  }

  // ===== transport ========================================================
  /** Ghi 1 packet ngắn vào kênh lệnh. */
  private async write(mainCmd: number, subCmd: number, data?: Uint8Array): Promise<void> {
    await this.ble.send(UUID.CMD_WRITE, this.packShort(mainCmd, subCmd, data));
  }

  /** Ghi rồi chờ notify đầu tiên khớp `accept`, giải mã trả LockFrame. */
  private async request(
    mainCmd: number,
    subCmd: number,
    data?: Uint8Array,
    accept?: (f: LockFrame) => boolean,
  ): Promise<LockFrame> {
    const raw = await this.ble.request(UUID.CMD_WRITE, UUID.CMD_NOTIFY, this.packShort(mainCmd, subCmd, data), {
      accept: (d) => {
        try {
          return accept ? accept(this.unpack(d)) : true;
        } catch {
          return false;
        }
      },
    });
    return this.unpack(raw);
  }

  /** Lắng nghe mọi notify khoá (đã giải mã). Trả hàm huỷ. */
  async listen(cb: (frame: LockFrame) => void): Promise<Unsubscribe> {
    return this.ble.listen(UUID.CMD_NOTIFY, (d) => {
      try {
        cb(this.unpack(d));
      } catch {
        /* notify không giải được (vd handshake) → bỏ qua */
      }
    });
  }

  /** Gửi packet ngắn tuỳ ý (escape hatch). */
  async send(mainCmd: number, subCmd: number, data?: Uint8Array): Promise<void> {
    return this.write(mainCmd, subCmd, data);
  }

  // ===== 1) MỞ KHOÁ (01/74) ==============================================
  async openLock(type: OpenLockType = OpenLockType.OPEN, seq?: number): Promise<void> {
    const data = seq === undefined ? Uint8Array.of(type) : concatBytes(type, u16le(seq));
    await this.write(MainCmd.SYSTEM, SystemSub.BLE_OPEN_LOCK, data);
  }
  close = () => this.openLock(OpenLockType.CLOSE);
  unbolt = () => this.openLock(OpenLockType.UNBOLT);
  toggle = () => this.openLock(OpenLockType.TOGGLE);

  // ===== 10) TRẠNG THÁI ===================================================
  async getDoorLockStatus(): Promise<DoorLockStatus> {
    const f = await this.request(MainCmd.SYSTEM, SystemSub.GET_DOOR_LOCK_STATUS, undefined, (x) => x.mainCmd === ReplyMainCmd.SYSTEM);
    return { lockStatus: f.data[0], doorStatus: f.data[1], raw: f.data };
  }
  async getLockStatus(): Promise<LockFrame> {
    return this.request(MainCmd.SYSTEM, SystemSub.LOCK_STATUS);
  }
  async getTongueState(): Promise<LockFrame> {
    return this.request(MainCmd.SYSTEM, SystemSub.TONGUE_STATUS);
  }
  async getFirmwareVersion(): Promise<string> {
    const f = await this.request(MainCmd.SYSTEM, SystemSub.FIRMWARE_VERSION);
    return bytesToHex(f.data);
  }
  async getHardwareVersion(): Promise<string> {
    const f = await this.request(MainCmd.SYSTEM, SystemSub.HARDWARE_VERSION);
    return bytesToHex(f.data);
  }

  // ===== 9) PIN / BATTERY (01/de) ========================================
  async getBatteryInfo(): Promise<BatterySlot[]> {
    const f = await this.request(MainCmd.SYSTEM, SystemSub.GET_BATTERY_INFO);
    const d = f.data;
    const count = d[0];
    const slots: BatterySlot[] = [];
    for (let i = 0; i < count; i++) {
      const o = 1 + i * 6;
      slots.push({
        pos: d[o],
        status: d[o + 1],
        type: d[o + 2],
        level: d[o + 3],
        onLoad: (d[o + 1] & 0x01) !== 0,
        charging: (d[o + 1] & 0x02) !== 0,
      });
    }
    return slots;
  }

  // ===== 3) XOÁ USER (02/03) =============================================
  async deleteUser(userId: number): Promise<void> {
    await this.write(MainCmd.USER, UserSub.DEL_USER, u16le(userId));
  }
  async deleteUserGroup(groupId: number): Promise<void> {
    await this.write(MainCmd.USER, UserSub.DEL_USER_GROUP, u16le(groupId));
  }

  // ===== 5) THÊM VÂN TAY (02/01) =========================================
  /** Trigger đăng ký vân tay vào slot. Khoá chờ quét → notify ADD_SUCCESS(02/11). */
  async addFingerprint(slot: number, admin = false): Promise<void> {
    const cred = admin ? CredType.ADMIN_FP : CredType.COMMON_FP;
    await this.write(MainCmd.USER, UserSub.ADD_USER, Uint8Array.of(slot, cred));
  }

  // ===== 7) THÊM THẺ NFC (MIOT, 02/13) ===================================
  /** Trigger thêm thẻ NFC (đường MIOT). Khoá đếm ngược 15s chờ tap. */
  async addNfcCard(groupId: number, sourceType: number = CredType.NFC): Promise<void> {
    // data=[groupId:2B][sourceType:1B][03=normal_nfc][totalLen=01][lenHex=00] (pwd rỗng)
    const data = concatBytes(u16be(groupId), sourceType, 0x03, 0x01, 0x00);
    await this.write(MainCmd.USER, UserSub.ADD_VISTOR_PWD, data);
  }
  /** Huỷ thêm NFC (MIOT 02/14 data='03'). */
  async abortAddNfc(): Promise<void> {
    await this.write(MainCmd.USER, UserSub.ABORT_ADD_MIOT_USER, Uint8Array.of(0x03));
  }

  // ===== 2b) THÊM MẬT KHẨU KHÁCH (02/13) =================================
  /**
   * addMIOTUser visitor pwd. VD pwd="1234",group=01,user=0001,type=82
   *   → data = 01 0001 82 03 04 1234
   * (groupId 1B, userId 2B BE, credType 1B, totalLen=1+pwBytes, pwdLen=#digits, pwBytes=BCD)
   */
  async addVisitorPassword(args: {
    groupId: number;
    userId: number;
    pin: string; // chuỗi chữ số
    credType?: CredType;
  }): Promise<void> {
    const { bytes: pwBytes, digits } = packPin(args.pin);
    const totalLen = 1 + pwBytes.length;
    const data = concatBytes(
      args.groupId & 0xff,
      u16be(args.userId),
      args.credType ?? CredType.COMMON_PWD,
      totalLen,
      digits,
      pwBytes,
    );
    await this.write(MainCmd.USER, UserSub.ADD_VISTOR_PWD, data);
  }

  // ===== 8) LỊCH SỬ (03/13) ==============================================
  async getLogList(startIdx: number, endIdx: number): Promise<LockFrame> {
    return this.request(MainCmd.LOG, LogSub.SYNC_LOG, concatBytes(u16le(startIdx), u16le(endIdx)), (f) => f.mainCmd === ReplyMainCmd.LOG);
  }

  // ===== 4) KHOÁ USER THEO GIỜ (02/0e, long 3f) ==========================
  /**
   * Trả về DATA đã encode cho USER_EFFECTIVE_PERIOD (everyWeek):
   *   userGroupId(2B) + repeatType(1B) + weekMask(1B) + 000000 + startStamp + endStamp + ff
   * ⚠️ Gói này lớn → đi LONG pack (3f). sendUserValidPeriod() phân mảnh best-effort.
   */
  buildUserValidPeriodData(args: {
    userGroupId: number;
    repeatType?: RepeatType;
    weekMask?: number; // dùng getDaysMask()
    start: Uint8Array; // startStamp (5B BCD YY MM DD HH mm) hoặc 4B unix LE
    end: Uint8Array;
  }): Uint8Array {
    return concatBytes(
      u16be(args.userGroupId),
      args.repeatType ?? RepeatType.EVERY_WEEK,
      args.weekMask ?? 0x00,
      0x00,
      0x00,
      0x00,
      args.start,
      args.end,
      0xff,
    );
  }
  async sendUserValidPeriod(data: Uint8Array): Promise<void> {
    await this.sendLong(MainCmd.USER, UserSub.USER_EFFECTIVE_PERIOD, data);
  }

  // ===== 6) MẬT KHẨU THEO GIỜ (03/21) ====================================
  buildPasswordValidPeriodData(args: {
    userId: number;
    repeatType?: RepeatType;
    start: Uint8Array;
    end: Uint8Array;
    deadline: Uint8Array;
    repeatDate?: Uint8Array;
  }): Uint8Array {
    return concatBytes(
      u16be(args.userId),
      args.repeatType ?? RepeatType.SET_VALID,
      args.start,
      args.end,
      args.deadline,
      args.repeatDate ?? new Uint8Array(),
    );
  }
  async setPasswordValidPeriod(data: Uint8Array): Promise<void> {
    await this.write(MainCmd.LOG, LogSub.SET_VISTOR_PWD_VAILD_TIME, data);
  }

  // ===== LONG pack (mainCmd 3f) — ⚠️ framing RE một phần =================
  /** Phân mảnh gói lớn trên kênh lệnh: [0x3f][idx][chunk], idx ff = cuối. */
  private async sendLong(mainCmd: number, subCmd: number, data: Uint8Array): Promise<void> {
    const packet = this.packShort(mainCmd, subCmd, data); // mainCmd ‖ cipher
    for (const chunk of fragment(packet, MainCmd.LONG, 18)) {
      await this.ble.send(UUID.CMD_WRITE, chunk);
    }
  }
}

// ---- helpers --------------------------------------------------------------

/** Đóng PIN dạng chữ số → bytes BCD (2 chữ/byte) + số chữ số. VD "1234" → {bytes:[0x12,0x34], digits:4}. */
export function packPin(pin: string): { bytes: Uint8Array; digits: number } {
  if (!/^\d+$/.test(pin)) throw new Error("PIN chỉ gồm chữ số");
  const padded = pin.length % 2 ? pin + "0" : pin; // chẵn hoá (nibble cuối = 0)
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(padded.substr(i * 2, 2), 16);
  return { bytes, digits: pin.length };
}

/**
 * weekMask từ bool[7]=[Mon..Sun] (getDaysMask): bit=(idx+1)%7
 * → bit0=CN(Sun), bit1=Mon … bit6=Sat. VD T2+T6 = 0x22.
 */
export function getDaysMask(days: boolean[]): number {
  if (days.length !== 7) throw new Error("days phải 7 phần tử [Mon..Sun]");
  let m = 0;
  for (let idx = 0; idx < 7; idx++) if (days[idx]) m |= 1 << ((idx + 1) % 7);
  return m & 0xff;
}

/** startStamp firmware mới: YY MM DD HH mm (5B BCD). */
export function bcdStamp(d: Date): Uint8Array {
  const bcd = (n: number) => parseInt(String(n).padStart(2, "0"), 16);
  return Uint8Array.of(
    bcd(d.getFullYear() % 100),
    bcd(d.getMonth() + 1),
    bcd(d.getDate()),
    bcd(d.getHours()),
    bcd(d.getMinutes()),
  );
}

/** startStamp firmware cũ: unix giây 4B LE. */
export function unixStamp(d: Date): Uint8Array {
  return u32le(Math.floor(d.getTime() / 1000));
}
