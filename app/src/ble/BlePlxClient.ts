// BLE qua react-native-ble-plx — CHÍNH thư viện app Aqara dùng (BleClientManager),
// nên kết nối được D100 (vượt rào "central lạ bị chặn" mà raw connectGatt/bleak gặp).
import { BleManager, Device, Subscription, ScanMode } from "react-native-ble-plx";
import { Buffer } from "buffer";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

export class BlePlxClient {
  private mgr = new BleManager();
  private dev: Device | null = null;

  /** Quét tìm khoá MiOT (advertise name "DP1A"). Trả Device. */
  scanLock(timeoutMs = 8000, nameMatch = /^dp1a$/i): Promise<Device> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.mgr.stopDeviceScan(); reject(new Error("scan timeout — khoá có quảng bá?")); }, timeoutMs);
      this.mgr.startDeviceScan(null, { scanMode: ScanMode.LowLatency }, (err, d) => {
        if (err) { clearTimeout(timer); this.mgr.stopDeviceScan(); reject(err); return; }
        if (d && (nameMatch.test(d.name ?? "") || nameMatch.test(d.localName ?? ""))) {
          clearTimeout(timer); this.mgr.stopDeviceScan(); resolve(d);
        }
      });
    });
  }

  /** Connect (MTU 200 như app) + discover. */
  async connect(device: Device): Promise<void> {
    this.dev = await device.connect({ requestMTU: 200 });
    await this.dev.discoverAllServicesAndCharacteristics();
  }

  /** Scan + connect có RETRY (133 GATT_CONN_FAILED_ESTABLISHMENT hay chập chờn). */
  async connectWithRetry(maxTries = 6, log?: (m: string) => void): Promise<void> {
    let lastErr: any;
    for (let i = 1; i <= maxTries; i++) {
      try {
        const dev = await this.scanLock(6000);
        log?.(`connect lần ${i}/${maxTries} (${dev.id})…`);
        this.dev = await dev.connect({ requestMTU: 200 });
        await this.dev.discoverAllServicesAndCharacteristics();
        log?.(`connected ✓`);
        return;
      } catch (e: any) {
        lastErr = e;
        log?.(`lần ${i} fail (${String(e?.message ?? e).slice(0, 40)}) — thử lại…`);
        try { await this.disconnect(); } catch { /**/ }
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw new Error("connect khoá thất bại sau " + maxTries + " lần (133): " + String(lastErr?.message ?? lastErr));
  }

  /** Tìm Characteristic theo UUID char trong MỌI service (khỏi cần đúng UUID service). */
  private async findChar(chr: string) {
    if (!this.dev) throw new Error("chưa connect");
    const services = await this.dev.services();
    for (const s of services) {
      const chars = await s.characteristics();
      const c = chars.find((x) => x.uuid.toLowerCase() === chr.toLowerCase());
      if (c) return c;
    }
    throw new Error("char không thấy: " + chr);
  }

  async write(_svc: string, chr: string, data: Uint8Array, withResponse = true): Promise<void> {
    const c = await this.findChar(chr);
    if (withResponse) await c.writeWithResponse(b64(data));
    else await c.writeWithoutResponse(b64(data));
  }

  /** Lắng nghe notify; cb(bytes). Trả Subscription để remove. */
  async monitor(_svc: string, chr: string, cb: (b: Uint8Array) => void): Promise<Subscription> {
    const c = await this.findChar(chr);
    return c.monitor((err, ch) => {
      if (err) return;
      if (ch?.value) cb(unb64(ch.value));
    });
  }

  async disconnect(): Promise<void> {
    try { if (this.dev) await this.dev.cancelConnection(); } catch { /**/ }
    this.dev = null;
  }
  async isConnected(): Promise<boolean> {
    try { return !!this.dev && await this.dev.isConnected(); } catch { return false; }
  }
  destroy() { this.mgr.destroy(); }
  /** chờ Bluetooth bật + quyền (gọi trước khi scan). */
  async waitReady(): Promise<void> {
    const st = await this.mgr.state();
    if (st !== "PoweredOn") {
      await new Promise<void>((res) => {
        const sub = this.mgr.onStateChange((s) => { if (s === "PoweredOn") { sub.remove(); res(); } }, true);
      });
    }
  }
}
