// Điều phối BLE session: cloud handshake + relay BLE → tái dùng sessionKey cho các lệnh trong 1 màn detail.
// Nhánh cache vẫn giữ cho nghiên cứu/replay, nhưng màn LockDetail gọi forceFresh=true.
// Khung handshake 0610/0710 ĐÃ decode 100% (getAiotLongPackageList, CRC16-ARC) + verify khoá thật.
import { AqaraCloud, hexToBytes, bytesToHex } from "../cloud/AqaraCloud";
import { BlePlxClient } from "./BlePlxClient";
import { UUID, buildAiotFrames, HsReassembler, extractPubKey } from "../protocol/gatt";
import {
  buildOpenLock, buildDoorStatusQuery, buildDoorStatusReportQuery,
  buildSetValidity, buildAddPassword, buildDelUserGroup, parseReportUserId,
  unpack, LockKey, LockFrame, ReplyMainCmd, SystemSub, LogSub,
} from "../protocol/lock";
import { permanentValidRangeForUserId } from "../cloud/lockmeta";
import { loadSession, saveSession, clearSession } from "./sessionCache";
import type { CachedHandshake } from "./sessionCache";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type Progress = (msg: string) => void;
export interface UnlockStatus {
  source: "ble" | "cloud";
  opened: boolean | null;
  label: string;
  raw: string;
  lockState?: string;
  doorStatus?: number;
}
export interface UnlockResult { usedCache: boolean; usedUnverifiedCache: boolean; status: UnlockStatus | null; }

export function unlockResultMessage(result: UnlockResult): string {
  const sent = result.usedUnverifiedCache
    ? "Đã gửi lệnh mở khoá bằng cache cũ ⚠️"
    : "Đã gửi lệnh mở khoá ✅";
  if (!result.status) return `${sent}\nChưa đọc được trạng thái khoá.`;
  const state = result.status.opened === true
    ? "Trạng thái: khoá đã mở ✅"
    : result.status.opened === false
      ? "Trạng thái: khoá vẫn đang khoá ⚠️"
      : `Trạng thái: ${result.status.label}`;
  return `${sent}\n${state}\nNguồn: ${result.status.source.toUpperCase()} (${result.status.raw})`;
}

export class LockController {
  constructor(private cloud: AqaraCloud, private ble: BlePlxClient) {}

  private activeDid: string | null = null;
  private activeKey: LockKey | null = null;

  async connectSession(did: string, log: Progress = () => {}, forceFresh = false): Promise<void> {
    if (!forceFresh) {
      const cached = await loadSession(did, { allowExpired: true });
      if (cached) {
        log("BLE: quét + connect khoá…");
        await this.ble.waitReady();
        await this.ble.connectWithRetry(6, log);
        this.lastUsedCache = true;
        this.lastUsedUnverifiedCache = true;
        this.activeDid = did;
        this.activeKey = this.cachedKey(cached);
        log(`♻️ Dùng session cache local (${this.cacheAge(cached)}) — không gọi cloud`);
        return;
      }
    }
    await this.ensureSession(did, log, forceFresh);
  }

  async disconnect(): Promise<void> {
    this.activeDid = null;
    this.activeKey = null;
    await this.ble.disconnect();
  }

  private async ensureSession(did: string, log: Progress, forceFresh = false): Promise<LockKey> {
    if (!forceFresh && this.activeDid === did && this.activeKey) {
      if (await this.ble.isConnected()) return this.activeKey;
      log("BLE: reconnect session hiện tại…");
      await this.ble.connectWithRetry(6, log);
      return this.activeKey;
    }
    if (forceFresh || (this.activeDid != null && this.activeDid !== did)) {
      await this.disconnect().catch(() => void 0);
      await sleep(700);
    }
    const key = await this.handshake(did, log, forceFresh);
    this.activeDid = did;
    this.activeKey = key;
    return key;
  }

  /** Gửi 1 packCmd (0610/0710) qua ffb1, chờ ghép response 'da' từ ffb2. */
  private async hsExchange(packCmd: number, data: Uint8Array, timeoutMs = 9000): Promise<Uint8Array> {
    const reasm = new HsReassembler();
    return new Promise<Uint8Array>(async (resolve, reject) => {
      const to = setTimeout(() => { sub?.remove(); reject(new Error(`handshake timeout 0x${packCmd.toString(16)}`)); }, timeoutMs);
      let sub: { remove: () => void } | null = null;
      try {
        sub = await this.ble.monitor(UUID.HANDSHAKE_SVC, UUID.HANDSHAKE_NOTIFY, (b) => {
          const full = reasm.push(b);
          if (full) { clearTimeout(to); sub?.remove(); resolve(full); }
        });
        for (const frame of buildAiotFrames(packCmd, data)) await this.ble.write(UUID.HANDSHAKE_SVC, UUID.HANDSHAKE_WRITE, frame);
      } catch (e) { clearTimeout(to); sub?.remove(); reject(e); }
    });
  }

  /** Đánh dấu phiên gần nhất có dùng cache (để op tự fallback nếu khoá từ chối). */
  private lastUsedCache = false;
  private lastUsedUnverifiedCache = false;

  private cachedKey(cached: CachedHandshake): LockKey {
    return { sessionKey: hexToBytes(cached.sessionKey), nonce: hexToBytes(cached.nonce) };
  }

  private cacheAge(cached: CachedHandshake): string {
    const sec = Math.max(0, Math.round((Date.now() - cached.ts) / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m`;
    return `${Math.round(min / 60)}h`;
  }

  private async cloudCall<T>(label: string, promise: Promise<T>, timeoutMs = 12000): Promise<T> {
    let timer: any = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async bleWriteWithTimeout(label: string, data: Uint8Array, timeoutMs = 1500): Promise<void> {
    let timer: any = null;
    try {
      await Promise.race([
        this.ble.write(UUID.CMD_SVC, UUID.CMD_WRITE, data),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private isCloudUnavailable(e: unknown): boolean {
    const msg = String((e as any)?.message ?? e).toLowerCase();
    return /network request failed|failed to fetch|timeout|aborted|unknownhost|enotfound|econn|etimedout|offline/.test(msg);
  }

  private isBleDisconnected(e: unknown): boolean {
    const msg = String((e as any)?.message ?? e).toLowerCase();
    return /not connected|disconnected|connection.*cancel|device.*closed/.test(msg);
  }

  private doorStatusLabel(v?: number): string {
    if (v == null) return "";
    switch (v) {
      case 0: return " · cửa đóng";
      case 1: return " · cửa mở";
      case 2: return " · cửa chưa khép";
      default: return ` · door=${v}`;
    }
  }

  private bleLockStatusLabel(v?: number): { opened: boolean | null; label: string } {
    switch (v) {
      case 0: return { opened: false, label: "Khoá vẫn đang khoá" };
      case 1: return { opened: true, label: "Khoá đã mở" };
      case 2: return { opened: null, label: "Khoá báo lỗi trạng thái" };
      default: return { opened: null, label: v == null ? "Không có mã trạng thái" : `Mã trạng thái ${v}` };
    }
  }

  private cloudLockStatusLabel(v?: string): { opened: boolean | null; label: string } {
    switch (v) {
      case "0":
      case "6": return { opened: true, label: "Khoá đã mở" };
      case "1":
      case "4": return { opened: false, label: "Khoá vẫn đang khoá" };
      case "2": return { opened: null, label: "Khoá báo lỗi trạng thái" };
      default: return { opened: null, label: v ? `Mã trạng thái ${v}` : "Không có trạng thái" };
    }
  }

  private parseBleStatus(f: LockFrame): UnlockStatus | null {
    if (f.mainCmd !== ReplyMainCmd.SYSTEM) return null;
    if (
      f.subCmd !== SystemSub.REPORT_DOOR_LOCK_STATUS &&
      f.subCmd !== SystemSub.GET_DOOR_LOCK_STATUS &&
      f.subCmd !== SystemSub.LOCK_STATUS
    ) return null;
    const lockStatus = f.data[0];
    const doorStatus = f.data[1];
    const s = this.bleLockStatusLabel(lockStatus);
    return {
      source: "ble",
      opened: s.opened,
      label: `${s.label}${this.doorStatusLabel(doorStatus)}`,
      raw: `main=0x${f.mainCmd.toString(16)} sub=0x${f.subCmd.toString(16)} data=${bytesToHex(f.data) || "<empty>"}`,
      lockState: lockStatus == null ? undefined : String(lockStatus),
      doorStatus,
    };
  }

  private async readBleStatus(key: LockKey, log: Progress): Promise<UnlockStatus | null> {
    let status: UnlockStatus | null = null;
    const sub = await this.ble.monitor(UUID.CMD_SVC, UUID.CMD_NOTIFY, (b) => {
      try {
        const f = unpack(key, b);
        const s = this.parseBleStatus(f);
        if (s) status = s;
      } catch { /* notify khác / MIC mismatch → bỏ qua */ }
    });
    try {
      log("BLE: đọc trạng thái khoá (01/e6)…");
      await this.bleWriteWithTimeout("status e6", buildDoorStatusReportQuery(key)).catch(() => void 0);
      for (let i = 0; i < 16 && !status; i++) await sleep(150);
      if (!status) {
        log("BLE: thử đọc trạng thái khoá (01/e5)…");
        await this.bleWriteWithTimeout("status e5", buildDoorStatusQuery(key)).catch(() => void 0);
        for (let i = 0; i < 16 && !status; i++) await sleep(150);
      }
      return status;
    } finally {
      sub.remove();
    }
  }

  private async readCloudStatus(did: string, log: Progress): Promise<UnlockStatus | null> {
    try {
      log("☁️ Cloud: đọc lock_state…");
      const res = await this.cloudCall("cloud lock_state", this.cloud.lockResources(did, ["lock_state"]), 6000);
      const lockState = res.find((r) => r.attr === "lock_state")?.value;
      const s = this.cloudLockStatusLabel(lockState);
      return {
        source: "cloud",
        opened: s.opened,
        label: s.label,
        raw: `lock_state=${lockState ?? "<none>"}`,
        lockState,
      };
    } catch (e: any) {
      log(`Không đọc được lock_state từ cloud: ${String(e?.message ?? e).slice(0, 80)}`);
      return null;
    }
  }

  private async tryCachedHandshake(
    cached: CachedHandshake,
    log: Progress,
    opts: { bestEffort?: boolean } = {},
  ): Promise<LockKey | null> {
    const bestEffort = !!opts.bestEffort;
    const key = this.cachedKey(cached);
    try {
      log(bestEffort
        ? `⚠️ Cloud lỗi → thử cache local cũ (${this.cacheAge(cached)})…`
        : `♻️ Thử tái dùng session cache (${this.cacheAge(cached)}, replay 0610)…`);
      const resp = await this.hsExchange(0x0610, hexToBytes(cached.cloudPublicKey));
      const devPub = bytesToHex(extractPubKey(resp));
      if (devPub.toLowerCase() === cached.devicePublicKey.toLowerCase()) {
        await this.hsExchange(0x0710, hexToBytes(cached.verifyData)).catch(() => void 0);
        this.lastUsedCache = true;
        this.lastUsedUnverifiedCache = false;
        log("♻️ Tái dùng session OK — 0 lần gọi cloud ✅");
        return key;
      }

      log("Khoá trả devicePublicKey khác cache → session cũ có thể đã bị xoay.");
      if (!bestEffort) return null;

      await this.hsExchange(0x0710, hexToBytes(cached.verifyData)).catch(() => void 0);
      this.lastUsedCache = true;
      this.lastUsedUnverifiedCache = true;
      log("⚠️ Vẫn thử dùng sessionKey/nonce cũ vì cloud không gọi được…");
      return key;
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 80);
      if (!bestEffort) {
        log(`Replay session lỗi (${msg}) → handshake mới…`);
        return null;
      }
      this.lastUsedCache = true;
      this.lastUsedUnverifiedCache = true;
      log(`⚠️ Replay cache lỗi (${msg}) — vẫn thử gửi lệnh bằng sessionKey/nonce cũ…`);
      return key;
    }
  }

  private async fallbackToCachedHandshake(cached: CachedHandshake, log: Progress): Promise<LockKey | null> {
    try {
      await this.ble.disconnect();
      await sleep(700);
      log("BLE: reconnect để replay cache…");
      await this.ble.connectWithRetry(6, log);
      return await this.tryCachedHandshake(cached, log, { bestEffort: true });
    } catch (cacheErr: any) {
      log(`Fallback cache lỗi: ${String(cacheErr?.message ?? cacheErr).slice(0, 80)}`);
      return null;
    }
  }

  /** Handshake BLE. Với forceFresh=true: luôn cloud publickey + verify, không dùng cache/fallback cache. */
  private async handshake(did: string, log: Progress, forceFresh = false): Promise<LockKey> {
    this.lastUsedCache = false;
    this.lastUsedUnverifiedCache = false;
    log("BLE: quét + connect khoá…");
    await this.ble.waitReady();
    await this.ble.connectWithRetry(6, log);

    const cached = !forceFresh ? await loadSession(did, { allowExpired: true }) : null;
    if (cached) {
      const key = await this.tryCachedHandshake(cached, log);
      if (key) return key;
    }

    let pk: { cloudPublicKey: string; mac: string };
    try {
      log("☁️ Cloud: publickey…");
      pk = await this.cloudCall("cloud publickey", this.cloud.publickey(did));
    } catch (e) {
      if (!forceFresh && cached && this.isCloudUnavailable(e)) {
        log("☁️ Cloud publickey không gọi được → fallback cache local…");
        const key = await this.fallbackToCachedHandshake(cached, log);
        if (key) return key;
      }
      throw e;
    }

    log("BLE: gửi cloudPublicKey (0610), nhận devicePublicKey…");
    const resp0610 = await this.hsExchange(0x0610, hexToBytes(pk.cloudPublicKey));
    const devicePublicKey = extractPubKey(resp0610);

    let v: { sessionKey: string; nonce: string; verifyData: string; mac: string };
    try {
      log("☁️ Cloud: verify…");
      v = await this.cloudCall("cloud verify", this.cloud.verify(did, bytesToHex(devicePublicKey)));
    } catch (e) {
      if (!forceFresh && cached && this.isCloudUnavailable(e)) {
        log("☁️ Cloud verify không gọi được → fallback cache local…");
        const key = await this.fallbackToCachedHandshake(cached, log);
        if (key) return key;
      }
      throw e;
    }

    log("BLE: gửi verifyData (0710)…");
    await this.hsExchange(0x0710, hexToBytes(v.verifyData)).catch(() => void 0); // status 'da'

    await saveSession(did, {
      cloudPublicKey: pk.cloudPublicKey,
      devicePublicKey: bytesToHex(devicePublicKey),
      sessionKey: v.sessionKey, nonce: v.nonce, verifyData: v.verifyData,
    });
    return { sessionKey: hexToBytes(v.sessionKey), nonce: hexToBytes(v.nonce) };
  }

  /** MỞ KHOÁ (handshake riêng → openLock). */
  async unlock(
    did: string,
    log: Progress = () => {},
    opts: { skipCloudStatus?: boolean } = {},
  ): Promise<UnlockResult> {
    const key = await this.ensureSession(did, log);
    const result: UnlockResult = { usedCache: this.lastUsedCache, usedUnverifiedCache: this.lastUsedUnverifiedCache, status: null };
    if (this.lastUsedUnverifiedCache) {
      log("⚠️ Đang gửi lệnh mở khoá bằng cache cũ (không có cloud xác minh)…");
    }
    log("BLE: gửi lệnh mở khoá (01/74)…");
    try {
      await this.bleWriteWithTimeout("open lock", buildOpenLock(key), 2500); // gói đã verify byte-perfect
    } catch (e) {
      if (!this.isBleDisconnected(e)) throw e;
      log("BLE rớt kết nối → reconnect và gửi lại lệnh mở khoá…");
      await this.ble.connectWithRetry(6, log);
      await this.bleWriteWithTimeout("open lock retry", buildOpenLock(key), 2500);
    }
    await sleep(700);
    result.status = await this.readBleStatus(key, log).catch(() => null);
    if (!result.status && !this.lastUsedUnverifiedCache && !opts.skipCloudStatus) {
      result.status = await this.readCloudStatus(did, log);
    }
    if (result.status) log(`${result.status.opened === true ? "✅" : result.status.opened === false ? "⚠️" : "ℹ️"} ${result.status.label} (${result.status.source})`);
    else log("⚠️ Đã gửi lệnh nhưng chưa đọc được trạng thái khoá");
    return result;
  }

  /** MỞ KHOÁ TỪ XA qua CLOUD (không cần BLE). Dùng làm fallback khi BLE chưa kết nối / lỗi.
   * Gọi cloud.remoteUnlock (đường Zigbee-remote qua hub) → đọc lại lock_state để xác nhận. */
  async cloudUnlock(did: string, log: Progress = () => {}): Promise<UnlockResult> {
    log("☁️ Mở khoá qua cloud (không dùng BLE)…");
    await this.cloudCall("cloud unlock", this.cloud.remoteUnlock(did), 12000);
    await sleep(1500);
    const status = await this.readCloudStatus(did, log);
    if (status) log(`${status.opened === true ? "✅" : status.opened === false ? "⚠️" : "ℹ️"} ${status.label} (cloud)`);
    return { usedCache: false, usedUnverifiedCache: false, status };
  }

  /** SET HIỆU LỰC 1+ credential XUỐNG FIRMWARE qua BLE 03/21 (đường THẬT — cloud chỉ là mirror).
   * Mỗi validRangeHex: deadline quá khứ = vô hiệu hoá; deadline ffffffff = kích hoạt.
   * 1 handshake → gửi lần lượt từng gói (như app gốc) → đếm ack 0x83/0x21/00 từ khoá. */
  async setValidity(did: string, validRangeHexList: string[], log: Progress = () => {}, forceFresh = false): Promise<{ ack: number; total: number }> {
    const key = await this.ensureSession(did, log, forceFresh);
    const usedCache = this.lastUsedCache;
    let ack = 0;
    const sub = await this.ble.monitor(UUID.CMD_SVC, UUID.CMD_NOTIFY, (b) => {
      try {
        const f = unpack(key, b);
        if (f.mainCmd === ReplyMainCmd.LOG && f.subCmd === LogSub.SET_VISTOR_PWD_VAILD_TIME && f.data[0] === 0x00) ack++;
      } catch { /* notify khác / fragmented → bỏ qua */ }
    });
    try {
      for (let i = 0; i < validRangeHexList.length; i++) {
        log(`BLE: gửi hiệu lực (03/21) ${i + 1}/${validRangeHexList.length}…`);
        await this.ble.write(UUID.CMD_SVC, UUID.CMD_WRITE, buildSetValidity(key, hexToBytes(validRangeHexList[i])));
        await sleep(900); // chờ ack
      }
      await sleep(400);
    } finally {
      sub.remove();
    }
    // Session cache bị khoá từ chối (0 ack) → xoá cache, handshake mới 1 lần.
    if (usedCache && ack === 0 && validRangeHexList.length > 0 && !forceFresh) {
      log("Session cũ bị từ chối → handshake mới rồi gửi lại…");
      await clearSession(did);
      return this.setValidity(did, validRangeHexList, log, true);
    }
    log(`✅ Khoá xác nhận ${ack}/${validRangeHexList.length} (ack 00)`);
    return { ack, total: validRangeHexList.length };
  }

  /** TẠO MẬT KHẨU xuống firmware: handshake → 02/13 (lập trình pwd) → đọc userId từ RX 02/15 → 03/21 (hiệu lực). */
  async createPassword(did: string, groupId: number, pwdDigits: string, userType: number, log: Progress = () => {}, forceFresh = false): Promise<{ userId: number; ackValidity: boolean }> {
    const key = await this.ensureSession(did, log, forceFresh);
    const usedCache = this.lastUsedCache;
    let userId = -1, ackValidity = false;
    const sub = await this.ble.monitor(UUID.CMD_SVC, UUID.CMD_NOTIFY, (b) => {
      try {
        const f = unpack(key, b);
        const uid = parseReportUserId(f);
        if (uid != null && userId < 0) userId = uid;
        if (f.mainCmd === ReplyMainCmd.LOG && f.subCmd === LogSub.SET_VISTOR_PWD_VAILD_TIME && f.data[0] === 0) ackValidity = true;
      } catch { /* notify khác / fragmented */ }
    });
    try {
      log("BLE: lập trình mật khẩu (02/13)…");
      await this.ble.write(UUID.CMD_SVC, UUID.CMD_WRITE, buildAddPassword(key, groupId, pwdDigits, userType));
      for (let i = 0; i < 45 && userId < 0; i++) await sleep(200); // chờ khoá báo userId
      if (userId >= 0) {
        log(`BLE: khoá gán userId ${userId} — set hiệu lực…`);
        await this.ble.write(UUID.CMD_SVC, UUID.CMD_WRITE, buildSetValidity(key, hexToBytes(permanentValidRangeForUserId(userId))));
        await sleep(1000);
      }
    } finally { sub.remove(); await sleep(400); }
    // Session cache bị từ chối (khoá không báo userId) → xoá cache, handshake mới 1 lần.
    if (userId < 0 && usedCache && !forceFresh) {
      log("Session cũ bị từ chối → handshake mới rồi thử lại…");
      await clearSession(did);
      return this.createPassword(did, groupId, pwdDigits, userType, log, true);
    }
    if (userId < 0) throw new Error("khoá không báo userId (02/15) — thử lại / lại gần khoá hơn");
    return { userId, ackValidity };
  }

  /** XOÁ USER (nhóm) khỏi firmware: 02/05. */
  async deleteUserGroup(did: string, groupId: number, log: Progress = () => {}): Promise<void> {
    const key = await this.ensureSession(did, log);
    log("BLE: xoá user (02/05)…");
    await this.ble.write(UUID.CMD_SVC, UUID.CMD_WRITE, buildDelUserGroup(key, groupId));
    await sleep(800);
  }
}
