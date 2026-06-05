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
import {
  findByDevicePublicKey, findLatestByDid, saveSession,
  touchSession, clearSessionsForDid, sessionCount,
} from "./sessionCache";
import type { CachedHandshake } from "./sessionCache";

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

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
    ? "Unlock command sent via cached session ⚠️"
    : "Unlock command sent ✅";
  if (!result.status) return `${sent}\nCould not read lock state.`;
  const state = result.status.opened === true
    ? "State: unlocked ✅"
    : result.status.opened === false
      ? "State: still locked ⚠️"
      : `State: ${result.status.label}`;
  return `${sent}\n${state}\nSource: ${result.status.source.toUpperCase()} (${result.status.raw})`;
}

export class LockController {
  constructor(private cloud: AqaraCloud, private ble: BlePlxClient) {}

  private activeDid: string | null = null;
  private activeKey: LockKey | null = null;

  async connectSession(did: string, log: Progress = () => {}, forceFresh = false): Promise<void> {
    // Reuse phiên cũ (nếu khoá trả cùng public key) được xử lý trong handshake() — không
    // còn dùng cache "mù" ở đây, để tránh gửi lệnh bằng sessionKey đã hết hiệu lực.
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
      log("BLE: reconnecting current session…");
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
      case 0: return " · door closed";
      case 1: return " · door open";
      case 2: return " · door ajar";
      default: return ` · door=${v}`;
    }
  }

  private bleLockStatusLabel(v?: number): { opened: boolean | null; label: string } {
    switch (v) {
      case 0: return { opened: false, label: "Still locked" };
      case 1: return { opened: true, label: "Unlocked" };
      case 2: return { opened: null, label: "Lock reported an error" };
      default: return { opened: null, label: v == null ? "No status code" : `Status code ${v}` };
    }
  }

  private cloudLockStatusLabel(v?: string): { opened: boolean | null; label: string } {
    switch (v) {
      case "0":
      case "6": return { opened: true, label: "Unlocked" };
      case "1":
      case "4": return { opened: false, label: "Still locked" };
      case "2": return { opened: null, label: "Lock reported an error" };
      default: return { opened: null, label: v ? `Status code ${v}` : "No status" };
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
      log("BLE: reading lock state (01/e6)…");
      await this.bleWriteWithTimeout("status e6", buildDoorStatusReportQuery(key)).catch(() => void 0);
      for (let i = 0; i < 16 && !status; i++) await sleep(150);
      if (!status) {
        log("BLE: trying lock state (01/e5)…");
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
      log("☁️ Cloud: reading lock_state…");
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
      log(`Could not read lock_state from cloud: ${String(e?.message ?? e).slice(0, 80)}`);
      return null;
    }
  }

  /** Cloud down: best-effort reuse of a cached session (matched public key, or latest for did). */
  private async reuseBestEffort(did: string, devPub: string | null, log: Progress): Promise<LockKey | null> {
    const hit = devPub ? await findByDevicePublicKey(devPub) : await findLatestByDid(did);
    if (!hit || hit.did !== did) return null;
    try {
      log(`⚠️ Cloud unavailable → using cached session (${this.cacheAge(hit)})…`);
      await this.hsExchange(0x0610, hexToBytes(hit.cloudPublicKey)).catch(() => void 0);
      await this.hsExchange(0x0710, hexToBytes(hit.verifyData)).catch(() => void 0);
      await touchSession(hit.devicePublicKey);
      this.lastUsedCache = true;
      this.lastUsedUnverifiedCache = !devPub; // public key not confirmed → mark unverified
      return this.cachedKey(hit);
    } catch {
      return null;
    }
  }

  /** BLE handshake.
   *  - forceFresh=false (default): replay 0610 to probe the lock's public key; if the lock returns
   *    the SAME public key we have cached → reuse that session (no cloud call). Otherwise fresh.
   *  - forceFresh=true: always cloud publickey + verify.
   *  NOTE: a probe 0610 leaves the AIOT handshake channel mid-exchange; if it doesn't reuse we
   *  reconnect to get a clean channel before the fresh handshake (else the lock drops the 2nd 0610). */
  private async handshake(did: string, log: Progress, forceFresh = false): Promise<LockKey> {
    this.lastUsedCache = false;
    this.lastUsedUnverifiedCache = false;
    log("BLE: scan + connect lock…");
    await this.ble.waitReady();
    await this.ble.connectWithRetry(6, log);

    // 1) Probe the lock's current public key by replaying a cached cloudPublicKey.
    let probeRan = false;
    if (!forceFresh) {
      const candidate = await findLatestByDid(did);
      if (candidate) {
        try {
          log(`♻️ Probing cached session (${await sessionCount()} saved)…`);
          probeRan = true;
          const resp = await this.hsExchange(0x0610, hexToBytes(candidate.cloudPublicKey));
          const probedDevPub = bytesToHex(extractPubKey(resp));
          const hit = await findByDevicePublicKey(probedDevPub);
          if (hit && hit.did === did) {
            // Same lock public key → cached sessionKey still valid. If the matching session used a
            // different cloudPublicKey than the candidate, replay its own before pushing verifyData.
            if (!sameHex(hit.cloudPublicKey, candidate.cloudPublicKey)) {
              await this.hsExchange(0x0610, hexToBytes(hit.cloudPublicKey)).catch(() => void 0);
            }
            await this.hsExchange(0x0710, hexToBytes(hit.verifyData)).catch(() => void 0);
            await touchSession(hit.devicePublicKey);
            this.lastUsedCache = true;
            log(`♻️ Same lock public key → reusing session (${this.cacheAge(hit)}) — no cloud ✅`);
            return this.cachedKey(hit);
          }
          log("Lock returned a new public key → fresh cloud handshake…");
        } catch (e: any) {
          log(`Probe failed (${String(e?.message ?? e).slice(0, 50)}) → fresh handshake…`);
        }
      }
    }

    // Clean the handshake channel if a probe 0610 already ran (a mid-exchange channel makes the
    // lock drop the next 0610 — this was the "cache → can't connect" bug).
    if (probeRan) {
      await this.ble.disconnect().catch(() => void 0);
      await sleep(700);
      await this.ble.connectWithRetry(6, log);
    }

    // 2) Fresh cloud handshake on a clean channel.
    let pk: { cloudPublicKey: string; mac: string };
    try {
      log("☁️ Cloud: publickey…");
      pk = await this.cloudCall("cloud publickey", this.cloud.publickey(did));
    } catch (e) {
      if (!forceFresh && this.isCloudUnavailable(e)) {
        const fb = await this.reuseBestEffort(did, null, log);
        if (fb) return fb;
      }
      throw e;
    }

    log("BLE: send cloudPublicKey (0610), receive devicePublicKey…");
    const resp0610 = await this.hsExchange(0x0610, hexToBytes(pk.cloudPublicKey));
    const devicePublicKey = bytesToHex(extractPubKey(resp0610));

    let v: { sessionKey: string; nonce: string; verifyData: string; mac: string };
    try {
      log("☁️ Cloud: verify…");
      v = await this.cloudCall("cloud verify", this.cloud.verify(did, devicePublicKey));
    } catch (e) {
      if (!forceFresh && this.isCloudUnavailable(e)) {
        const fb = await this.reuseBestEffort(did, devicePublicKey, log);
        if (fb) return fb;
      }
      throw e;
    }

    log("BLE: send verifyData (0710)…");
    await this.hsExchange(0x0710, hexToBytes(v.verifyData)).catch(() => void 0); // status 'da'

    await saveSession({
      did,
      cloudPublicKey: pk.cloudPublicKey,
      devicePublicKey,
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
      log("⚠️ Sending unlock with a cached session (not cloud-verified)…");
    }
    log("BLE: sending unlock (01/74)…");
    try {
      await this.bleWriteWithTimeout("open lock", buildOpenLock(key), 2500); // byte-perfect verified frame
    } catch (e) {
      if (!this.isBleDisconnected(e)) throw e;
      log("BLE dropped → reconnecting and resending unlock…");
      await this.ble.connectWithRetry(6, log);
      await this.bleWriteWithTimeout("open lock retry", buildOpenLock(key), 2500);
    }
    await sleep(700);
    result.status = await this.readBleStatus(key, log).catch(() => null);
    if (!result.status && !this.lastUsedUnverifiedCache && !opts.skipCloudStatus) {
      result.status = await this.readCloudStatus(did, log);
    }
    if (result.status) log(`${result.status.opened === true ? "✅" : result.status.opened === false ? "⚠️" : "ℹ️"} ${result.status.label} (${result.status.source})`);
    else log("⚠️ Command sent but lock state could not be read");
    return result;
  }

  /** REMOTE UNLOCK via CLOUD (no BLE). Fallback when BLE isn't connected / fails.
   * Calls cloud.remoteUnlock (Zigbee-remote via hub) → re-reads lock_state to confirm. */
  async cloudUnlock(did: string, log: Progress = () => {}): Promise<UnlockResult> {
    log("☁️ Unlocking via cloud (no BLE)…");
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
        log(`BLE: sending validity (03/21) ${i + 1}/${validRangeHexList.length}…`);
        await this.ble.write(UUID.CMD_SVC, UUID.CMD_WRITE, buildSetValidity(key, hexToBytes(validRangeHexList[i])));
        await sleep(900); // chờ ack
      }
      await sleep(400);
    } finally {
      sub.remove();
    }
    // Session cache bị khoá từ chối (0 ack) → xoá cache, handshake mới 1 lần.
    if (usedCache && ack === 0 && validRangeHexList.length > 0 && !forceFresh) {
      log("Cached session rejected → fresh handshake and resend…");
      await clearSessionsForDid(did);
      return this.setValidity(did, validRangeHexList, log, true);
    }
    log(`✅ Lock acknowledged ${ack}/${validRangeHexList.length} (ack 00)`);
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
      log("BLE: programming password (02/13)…");
      await this.ble.write(UUID.CMD_SVC, UUID.CMD_WRITE, buildAddPassword(key, groupId, pwdDigits, userType));
      for (let i = 0; i < 45 && userId < 0; i++) await sleep(200); // wait for the lock to report userId
      if (userId >= 0) {
        log(`BLE: lock assigned userId ${userId} — setting validity…`);
        await this.ble.write(UUID.CMD_SVC, UUID.CMD_WRITE, buildSetValidity(key, hexToBytes(permanentValidRangeForUserId(userId))));
        await sleep(1000);
      }
    } finally { sub.remove(); await sleep(400); }
    // Session cache bị từ chối (khoá không báo userId) → xoá cache, handshake mới 1 lần.
    if (userId < 0 && usedCache && !forceFresh) {
      log("Cached session rejected → fresh handshake and retry…");
      await clearSessionsForDid(did);
      return this.createPassword(did, groupId, pwdDigits, userType, log, true);
    }
    if (userId < 0) throw new Error("lock did not report userId (02/15) — retry / move closer to the lock");
    return { userId, ackValidity };
  }

  /** DELETE USER (group) from firmware: 02/05. */
  async deleteUserGroup(did: string, groupId: number, log: Progress = () => {}): Promise<void> {
    const key = await this.ensureSession(did, log);
    log("BLE: deleting user (02/05)…");
    await this.ble.write(UUID.CMD_SVC, UUID.CMD_WRITE, buildDelUserGroup(key, groupId));
    await sleep(800);
  }
}
