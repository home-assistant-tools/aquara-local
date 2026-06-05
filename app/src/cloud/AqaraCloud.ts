// Cloud client Aqara (private) — sign + token. Liệt kê khoá + handshake lấy sessionKey.
import { aqaraSign, randomNonce, APPID, APPKEY } from "../protocol/sign";
import { hexToBytes, bytesToHex } from "../protocol/hex";

const HOSTS: Record<string, string> = {
  SEA: "https://rpc-au.aqara.com",
  CN: "https://rpc.aqara.cn",
  US: "https://rpc-us.aqara.com",
  EU: "https://rpc-ger.aqara.com",
};
const PREFIX = "/app/v1.0/lumi";

export interface CloudCfg {
  area: string; token: string; userId: string;
  phoneid?: string; clientid?: string;
}
export interface DeviceItem { did: string; name: string; model: string; }
export interface LockSessionKey { sessionKey: Uint8Array; nonce: Uint8Array; mac: string; verifyData: Uint8Array; }

// type: 1=vân tay 2=mật khẩu 3=NFC 4=eKey/BLE 5=mật khẩu tạm 6=khuôn mặt 7=NFC tag
export interface Credential {
  type: number; typeName: string; typeValue: string;
  typeGroupId: string; typeGroupName: string; typeGroup?: string;
  userCode?: string; validRange?: string; typeLevel?: number; deviceId?: string;
}
export interface UserGroup { typeGroupId: string; typeGroupName: string; typeGroup: string; did?: string; }
export interface LockResource { attr: string; value: string; timeStamp: number; subjectId?: string; }
export interface LockLogEntry { timeStamp: number; value: string; source: string; attr?: string; }

const BASE_HEADERS: Record<string, string> = {
  lang: "en", "app-version": "6.1.6", "phone-model": "RN-D100", "sys-type": "1", "sys-version": "14",
  "content-type": "application/json; charset=utf-8",
};

export class AqaraCloud {
  private base: string;
  constructor(private cfg: CloudCfg) { this.base = (HOSTS[cfg.area] ?? cfg.area) + PREFIX; }

  private headers(body: string) {
    const nonce = randomNonce();
    const time = Date.now().toString();
    const sign = aqaraSign({ nonce, time, token: this.cfg.token, body, appid: APPID, appkey: APPKEY });
    const h: Record<string, string> = {
      ...BASE_HEADERS, appid: APPID, userid: this.cfg.userId, token: this.cfg.token,
      nonce, time, area: this.cfg.area, sign,
    };
    if (this.cfg.phoneid) h.phoneid = this.cfg.phoneid;
    if (this.cfg.clientid) h.clientid = this.cfg.clientid;
    return h;
  }

  async post<T = any>(path: string, body: Record<string, any> = {}): Promise<T> {
    const s = JSON.stringify(body);
    const r = await fetch(this.base + path, { method: "POST", headers: this.headers(s), body: s });
    return this.parse<T>(await r.text(), path);
  }
  async get<T = any>(path: string, query?: Record<string, string | number>): Promise<T> {
    const e = query ? Object.entries(query) : [];
    const signBody = e.map(([k, v]) => `${k}=${v}`).join("&"); // GET ký query THÔ
    const qs = e.length ? "?" + e.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&") : "";
    const r = await fetch(this.base + path + qs, { method: "GET", headers: this.headers(signBody) });
    return this.parse<T>(await r.text(), path);
  }
  private parse<T>(text: string, path: string): T {
    let j: any;
    try { j = JSON.parse(text); } catch { throw new Error(`[${path}] non-JSON: ${text.slice(0, 120)}`); }
    if (j.code !== undefined && j.code !== 0) throw new Error(`[${path}] code=${j.code} ${j.message ?? ""}`);
    return (j.result ?? j.data ?? j) as T;
  }

  /** Liệt kê thiết bị → lọc khoá (model dp1a/lock/aqgl). Fallback: DID đã biết nếu endpoint đổi. */
  // Luồng THẬT (đã verify): home/list → mỗi homeId → device/query?positionId=homeId.
  // GET ký trên query THÔ (get() lo phần encode). Lọc thiết bị model chứa lock/aqgl/dp1a.
  async listLocks(fallbackDid?: string): Promise<DeviceItem[]> {
    const locks: DeviceItem[] = [];
    try {
      const home = await this.get<any>("/app/position/query/home/list",
        { needDefaultRoom: "false", size: 300, startIndex: 0 });
      const homes: any[] = home?.homes ?? [];
      for (const h of homes) {
        const pid = h?.homeId;
        if (!pid) continue;
        const dev = await this.get<any>("/app/position/device/query",
          { positionId: pid, size: 300, startIndex: 0 });
        const devices: any[] = dev?.devices ?? dev?.data ?? [];
        for (const d of devices) {
          const model = d.model ?? "";
          const name = d.deviceName ?? d.name ?? "D100";
          if (/lock|aqgl|dp1a/i.test(model)) {        // model khoá Zigbee/BLE thật (loại matter-bridge)
            locks.push({ did: d.did ?? d.subjectId, name, model });
          }
        }
      }
    } catch (_) { /* rơi xuống fallback */ }
    if (locks.length) return locks;
    return fallbackDid ? [{ did: fallbackDid, name: "Aqara D100", model: "aqara.lock.aqgl01" }] : [];
  }

  // ---- Quản lý khóa (cloud, đã test live) ----
  /** Danh sách credential: vân tay/mật khẩu/NFC/khuôn mặt + nhóm + hiệu lực. */
  async lockCredentials(did: string): Promise<Credential[]> {
    return this.get<Credential[]>("/dev/lock/query", { deviceId: did, types: "[1,2,3,4,5,6,7]" });
  }
  /** Nhóm người dùng của khóa (Me/Vợ/Scheduled...). */
  async lockGroups(did: string): Promise<UserGroup[]> {
    return this.get<UserGroup[]>("/dev/lock/user/group/info", { did });
  }
  /** Đọc tài nguyên: pin, trạng thái khóa, báo động, online. */
  async lockResources(
    did: string,
    attrs: string[] = ["batt_0_remain_percentage", "lock_state", "arm_state", "device_offline_status", "low_battery_power"],
  ): Promise<LockResource[]> {
    return this.post<LockResource[]>("/res/query", { data: [{ options: attrs, subjectId: did }] });
  }
  /** Lịch sử mở/đóng khóa (lock_local_log). */
  async lockHistory(
    did: string,
    opts: { size?: number; startTime?: number; endTime?: number } = {},
  ): Promise<{ count: number; resultList: LockLogEntry[]; lastReportTime?: number }> {
    const now = Date.now();
    return this.post("/app/lock/res/history/query", {
      attrs: ["lock_local_log"],
      startTime: String(opts.startTime ?? now - 30 * 86400000),
      endTime: String(opts.endTime ?? now),
      startIndex: "0",
      size: String(opts.size ?? 100),
      subjectId: did,
    });
  }

  // ---- GHI credential (endpoint bắt thật từ app Aqara) ----
  /** Đổi tên / cập nhật hiệu lực credential. Giữ nguyên validRange nếu không truyền. */
  async updateCredential(
    did: string, cred: Credential, opts: { typeName?: string; validRange?: string } = {},
  ): Promise<any> {
    const body: Record<string, any> = {
      deviceId: did,
      typeValue: cred.typeValue,
      typeName: opts.typeName ?? cred.typeName,
      typeGroupId: cred.typeGroupId,
      type: String(cred.type),
    };
    const vr = opts.validRange ?? cred.validRange;
    if (vr) body.validRange = vr;
    return this.post("/dev/lock/update/name", body);
  }
  /** Xóa 1 credential (vân tay/mật khẩu/NFC...). */
  async deleteCredential(did: string, cred: Credential): Promise<any> {
    return this.post("/dev/lock/user/del", {
      did, typeInfo: [{ type: String(cred.type), typeValues: [cred.typeValue] }],
    });
  }
  /** Vô hiệu hoá / kích hoạt lại credential bằng cách đặt hiệu lực (validRange). */
  async setCredentialValidRange(did: string, cred: Credential, validRange: string): Promise<any> {
    return this.updateCredential(did, cred, { validRange });
  }

  // ---- TẠO / XOÁ user + credential (mirror cloud; firmware đi BLE) ----
  /** Tạo nhóm user. typeGroup: "3"=scheduled, "2"=normal. */
  async createUserGroup(did: string, typeGroupId: string, typeGroupName: string, typeGroup = "3"): Promise<any> {
    return this.post("/dev/lock/user/group/add", { did, typeGroup, typeGroupId, typeGroupName });
  }
  /** Đăng ký metadata credential mới (sau khi BLE đã lập trình + có userId). */
  async addCredentialMeta(did: string, info: {
    typeGroupId: string; typeName: string; typeLevel: string; validRange: string; typeValue: string; type: string; userCode?: string;
  }): Promise<any> {
    return this.post("/dev/lock/user/add", { did, lockInfo: [{ userCode: "0", ...info }] });
  }
  /** Xoá nhóm user khỏi cloud mirror. */
  async deleteUserGroupCloud(did: string, typeGroupId: string): Promise<any> {
    return this.post("/dev/lock/user/group/del", { did, typeGroupIds: [String(typeGroupId)] });
  }
  /** Đổi tên user (nhóm). */
  async renameUserGroup(did: string, typeGroupId: string, typeGroupName: string, typeGroup: string): Promise<any> {
    return this.post("/dev/lock/user/group/update", { did, typeGroupId, typeGroupName, typeGroup });
  }
  /** groupId nhỏ nhất chưa dùng (>=1). */
  static nextFreeGroupId(used: string[]): string {
    const set = new Set(used.map((x) => parseInt(x, 10)));
    for (let i = 1; i < 200; i++) if (!set.has(i)) return String(i);
    return "1";
  }

  // ---- ĐIỀU KHIỂN TỪ XA qua cloud (không cần BLE) ----
  // Matter DoorLock trait "endpoint.function.command.instance" — giải mã từ bundle RN
  // plugin khoá (CommandSpec, endpoint 2 / function 148).
  static readonly MATTER_UNLOCK = "2.148.35011.0"; // unlockDoor
  static readonly MATTER_LOCK = "2.148.35010.0";   // lockDoor
  static readonly MATTER_UNBOLT = "2.148.40031.0"; // unbolt

  /** Ghi 1 Matter trait xuống khoá qua cloud → hub. KHÔNG cần BLE.
   * Đúng việc app làm (`writeMatterTrait`): POST /matter/write {data:{trait:value},did,pwd:"",type:0}.
   * Native tự chọn transport: local hub (UDP, libsodium) khi cùng LAN, hoặc cloud — cùng 1 lệnh. */
  async matterWrite(did: string, trait: string, value = ""): Promise<any> {
    return this.post("/matter/write", { data: { [trait]: value }, did, pwd: "", type: 0 });
  }
  /** Mở khoá (Matter unlockDoor 2.148.35011). */
  async remoteUnlock(did: string): Promise<any> {
    return this.matterWrite(did, AqaraCloud.MATTER_UNLOCK);
  }
  /** Khoá (Matter lockDoor 2.148.35010). */
  async remoteLock(did: string): Promise<any> {
    return this.matterWrite(did, AqaraCloud.MATTER_LOCK);
  }

  // ---- handshake lấy sessionKey ----
  async publickey(deviceId: string): Promise<{ cloudPublicKey: string; mac: string }> {
    return this.post("/dev/bluetooth/login/assure/publickey", { deviceId });
  }
  async verify(deviceId: string, devicePublicKeyHex: string): Promise<{ sessionKey: string; nonce: string; verifyData: string; mac: string }> {
    return this.post("/dev/bluetooth/login/assure/verify", { deviceId, devicePublicKey: devicePublicKeyHex });
  }
}

export { hexToBytes, bytesToHex };
