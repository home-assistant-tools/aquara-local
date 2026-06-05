import { APPID, APPKEY, CLOUD_HOSTS, API_PREFIX, UUID } from "./constants";
import { aqaraSign, randomNonce, XAes128Gcm, type KeyIvDeriver } from "./crypto";
import { hexToBytes, bytesToHex, concatBytes } from "./hex";
import { fragment, Reassembler } from "./framing";
import type { BleClient } from "./BleClient";

export interface MobileClientConfig {
  area: keyof typeof CLOUD_HOSTS | string; // "SEA" cho account VN
  token: string;
  userId: string;
  appid?: string;
  appkey?: string;
  /** header phụ (lang, cuty, app-version, phone-model, sys-type, sys-version, phoneid, clientid…). */
  extraHeaders?: Record<string, string>;
  /** inject để test; mặc định global fetch (Bun/Node18+). */
  fetchImpl?: typeof fetch;
  /** codec x-aes128gcm cho login/refresh (cần keyIvDeriver khi đã reverse). */
  gcmKeyIvDeriver?: KeyIvDeriver;
}

export interface LockSessionKey {
  sessionKey: Uint8Array; // 16B
  nonce: Uint8Array; // 13B
  mac: string;
  verifyData: Uint8Array; // 8B
}

const DEFAULT_HEADERS: Record<string, string> = {
  lang: "en",
  cuty: "",
  "app-version": "6.1.6",
  "phone-model": "RN-D100",
  "sys-type": "1", // android
  "sys-version": "14",
  "content-type": "application/json; charset=utf-8",
};

export class AquaraMobileClient {
  private readonly base: string;
  private readonly appid: string;
  private readonly appkey: string;
  private token: string;
  private readonly userId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extra: Record<string, string>;
  private readonly gcm: XAes128Gcm;

  constructor(private readonly cfg: MobileClientConfig) {
    this.base = (CLOUD_HOSTS[cfg.area] ?? cfg.area) + API_PREFIX;
    this.appid = cfg.appid ?? APPID;
    this.appkey = cfg.appkey ?? APPKEY;
    this.token = cfg.token;
    this.userId = cfg.userId;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.extra = { ...DEFAULT_HEADERS, ...(cfg.extraHeaders ?? {}) };
    this.gcm = new XAes128Gcm(this.appkey, cfg.gcmKeyIvDeriver);
  }

  getToken(): string {
    return this.token;
  }

  // ---- ký + gửi request (✅ sign đã giải) --------------------------------
  private buildHeaders(bodyStr: string): Record<string, string> {
    const nonce = randomNonce();
    const time = Date.now().toString();
    const sign = aqaraSign({ nonce, time, token: this.token, body: bodyStr, appid: this.appid, appkey: this.appkey });
    return {
      ...this.extra,
      appid: this.appid,
      userid: this.userId,
      token: this.token,
      nonce,
      time,
      area: String(this.cfg.area),
      sign,
    };
  }

  /** POST JSON. `body` được serialize đúng-1-lần và dùng cho cả request lẫn sign. */
  async post<T = any>(path: string, body: Record<string, any> = {}): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const res = await this.fetchImpl(this.base + path, {
      method: "POST",
      headers: this.buildHeaders(bodyStr),
      body: bodyStr,
    });
    return this.parse<T>(res, path);
  }

  /**
   * GET. ⚠️ `sign` của GET ký lên **query string THÔ** (giá trị chưa url-encode), không phải body rỗng.
   * (xác nhận qua hook: getSignHead in4 = "deviceId=...&types=[7]"). URL thì vẫn encode bình thường.
   */
  async get<T = any>(path: string, query?: Record<string, string | number>): Promise<T> {
    const entries = query ? Object.entries(query) : [];
    const signBody = entries.map(([k, v]) => `${k}=${v}`).join("&"); // THÔ — để ký
    const urlQs = entries.length
      ? "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")
      : "";
    const res = await this.fetchImpl(this.base + path + urlQs, { method: "GET", headers: this.buildHeaders(signBody) });
    return this.parse<T>(res, path);
  }

  private async parse<T>(res: Response, path: string): Promise<T> {
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`[${path}] non-JSON (${res.status}): ${text.slice(0, 120)}`);
    }
    if (json.code !== undefined && json.code !== 0) {
      throw new Error(`[${path}] cloud error code=${json.code} msg=${json.message ?? json.msgDetails}`);
    }
    return (json.result ?? json.data ?? json) as T;
  }

  // ---- login / logout ----------------------------------------------------
  /**
   * Đăng nhập bằng email + password.
   * ⚠️ CHƯA chạy standalone hoàn chỉnh: cần (1) gcmKeyIvDeriver (KDF x-aes128gcm) và
   *    (2) `encryptedPassword` = RSA(password, encryptType 2). Có thể tái dùng blob RSA đã bắt
   *    hoặc inject passwordEncryptor sau khi reverse RSA pubkey. guardCode='' (KHÔNG cần OTP).
   * Body plaintext: {"account","district","encryptType":2,"guardCode":"","password":<rsa>}
   */
  async loginWithPassword(args: {
    account: string;
    district?: string;
    encryptedPassword: string; // RSA(base64) — encryptType 2
    ivRaw: Uint8Array; // IV ngẫu nhiên 16B cho x-aes128gcm
  }): Promise<{ token: string; userId: string }> {
    const plain = JSON.stringify({
      account: args.account,
      district: args.district ?? "VN",
      encryptType: 2,
      guardCode: "",
      password: args.encryptedPassword,
    });
    const wireBody = this.gcm.encrypt(plain, args.ivRaw); // throw nếu chưa có KDF
    const res = await this.fetchImpl(this.base + "/user/guard-code/login", {
      method: "POST",
      headers: { ...this.buildHeaders(wireBody), "content-encoding": "x-aes128gcm", "accept-encoding": "x-aes128gcm" },
      body: wireBody,
    });
    const wireResp = await res.text();
    const decoded = JSON.parse(this.gcm.decrypt(wireResp));
    const result = decoded.result ?? decoded;
    this.token = result.token;
    return { token: result.token, userId: result.userId };
  }

  /** Đăng xuất — plaintext. */
  async logout(clientId: string): Promise<void> {
    await this.post("/user/logout", { clientId, userId: this.userId });
  }

  // ---- lấy sessionKey cho khoá (handshake cloud → BLE) -------------------
  /**
   * LOGIN handshake: publickey (cloud) → 0610 (BLE) → verify (cloud) → 0710 (BLE).
   * sessionKey/nonce do CLOUD tính & trả (ECDH P-256 ở cloud) — tool chỉ relay.
   * @param deviceId DID khoá (vd "<LOCK_DID>")
   * @param ble      transport đã sẵn sàng (sẽ tự connect theo mac)
   *
   * ⚠️ Phần BLE relay (inner framing của gói 0610/0710) mới RE một phần — sessionKey/nonce
   *    lấy từ response cloud nên vẫn đúng; các write BLE là best-effort để khoá chấp nhận.
   */
  async getLockKey(deviceId: string, ble: BleClient): Promise<LockSessionKey> {
    // 1) publickey
    const pk = await this.post<{ cloudPublicKey: string; mac: string }>(
      "/dev/bluetooth/login/assure/publickey",
      { deviceId },
    );
    // 2) BLE: connect + gửi cloudPublicKey qua packCmd 0610, đọc devicePublicKey
    await ble.connect(pk.mac);
    const devicePublicKey = await this.bleHandshakeExchange(ble, 0x0610, hexToBytes(pk.cloudPublicKey));
    // 3) verify → sessionKey/nonce/verifyData
    const v = await this.post<{ sessionKey: string; nonce: string; verifyData: string; mac: string }>(
      "/dev/bluetooth/login/assure/verify",
      { deviceId, devicePublicKey: bytesToHex(devicePublicKey) },
    );
    // 4) BLE: gửi verifyData qua 0710 (kỳ vọng status 00 = login OK)
    await this.bleHandshakeExchange(ble, 0x0710, hexToBytes(v.verifyData)).catch(() => void 0);
    return {
      sessionKey: hexToBytes(v.sessionKey),
      nonce: hexToBytes(v.nonce),
      verifyData: hexToBytes(v.verifyData),
      mac: v.mac,
    };
  }

  /** Gửi 1 packCmd + data trên kênh handshake ffb1, ghép notify trả về (da…ff). */
  private async bleHandshakeExchange(ble: BleClient, packCmd: number, data: Uint8Array): Promise<Uint8Array> {
    const payload = concatBytes((packCmd >> 8) & 0xff, packCmd & 0xff, data); // [packCmd 2B][data]
    const reasm = new Reassembler();
    return new Promise<Uint8Array>(async (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("handshake timeout")), 8000);
      const unsub = await ble.listen(UUID.HANDSHAKE_NOTIFY, (pkt) => {
        const full = reasm.push(pkt);
        if (full) {
          clearTimeout(timer);
          unsub();
          // TODO(RE): bóc status/echo packCmd; tạm trả nguyên payload đã ghép.
          resolve(full);
        }
      });
      for (const chunk of fragment(payload)) await ble.send(UUID.HANDSHAKE_WRITE, chunk);
    });
  }
}
