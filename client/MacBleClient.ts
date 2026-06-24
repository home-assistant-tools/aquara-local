// Concrete BLE transport cho Mac (CoreBluetooth) qua @stoprocent/noble.
// Tương đương MacBleClient của ble_mac_test.py — scan/connect bằng UUID per-host,
// match name "DP1A" hoặc UUID pinned, support timeout.
//
// macOS quirks (xem docs/MAC_BLE.md):
//   - TCC: chạy từ Terminal.app đã grant Bluetooth (lần đầu macOS prompt → Allow).
//   - CoreBluetooth hide MAC; peripheral.uuid = NSUUID per-host (vd 59E9553D-…).
//   - D100 broadcast 2 endpoints: 59E9553D-… (Aqara MiOT, dùng cái này) và
//     B7C7245D-… (HomeKit, KHÔNG dùng).
//
// API noble: events 'stateChange', 'discover', 'data'. Peripheral.connectAsync /
// discoverAllServicesAndCharacteristicsAsync. Characteristic.subscribe + writeAsync.
import noble from "@stoprocent/noble";
import { BleClient, type NotifyCallback, type Unsubscribe } from "./BleClient";

const DEFAULT_TARGET_UUID = "59e9553dbcf3b01a9eb83288e4a9be46"; // normalized, no dashes
const SCAN_TIMEOUT_MS = 300_000;
const BT_BASE_SUFFIX = "00001000800000805f9b34fb"; // tail of Bluetooth Base UUID

function normUuid(u: string): string {
  return u.replace(/[{}-]/g, "").toLowerCase();
}

/** Trả về CẢ 2 form (16-bit short + 128-bit full) để lookup char không phụ thuộc noble normalize. */
function uuidForms(u: string): string[] {
  const norm = normUuid(u);
  const forms: string[] = [norm];
  // 32-hex = 128-bit. Nếu UUID dùng Bluetooth Base ("0000XXXX-0000-1000-8000-00805f9b34fb")
  // → thêm short form "XXXX". Ngược lại nếu là short 4 hex → thêm full form.
  if (norm.length === 32 && norm.endsWith(BT_BASE_SUFFIX) && norm.startsWith("0000")) {
    forms.push(norm.slice(4, 8));
  } else if (norm.length === 4) {
    forms.push("0000" + norm + BT_BASE_SUFFIX);
  }
  return forms;
}

export interface MacBleClientOpts {
  /** Override UUID đích (mặc định D100 Aqara MiOT endpoint). */
  targetUuid?: string;
  /** Thêm name khác để match (mặc định "dp1a"). */
  nameMatch?: string[];
  scanTimeoutMs?: number;
  /** Log function (default: console.log với prefix). */
  log?: (msg: string) => void;
}

export class MacBleClient extends BleClient {
  private peripheral: any = null;
  private chars = new Map<string, any>();
  private readonly target: string;
  private readonly nameMatch: Set<string>;
  private readonly scanTimeoutMs: number;
  private readonly log: (msg: string) => void;

  constructor(opts: MacBleClientOpts = {}) {
    super();
    this.target = normUuid(opts.targetUuid ?? DEFAULT_TARGET_UUID);
    this.nameMatch = new Set(
      (opts.nameMatch ?? ["dp1a"]).map((n) => n.trim().toLowerCase()),
    );
    this.scanTimeoutMs = opts.scanTimeoutMs ?? SCAN_TIMEOUT_MS;
    this.log = opts.log ?? ((m) => console.log(`[ble] ${m}`));
  }

  /** `_mac` từ cloud không dùng được trên macOS (CoreBluetooth hide MAC); ta scan + match UUID. */
  async connect(_mac: string): Promise<void> {
    await this.waitPoweredOn();
    const peri = await this.findPeripheral();
    this.log(`connecting to ${peri.uuid} (${peri.advertisement.localName ?? ""})…`);
    await peri.connectAsync();
    this.log("connected ✓ — discovering services…");
    const { characteristics } = await peri.discoverAllServicesAndCharacteristicsAsync();
    for (const c of characteristics) {
      for (const form of uuidForms(c.uuid)) this.chars.set(form, c);
    }
    this.peripheral = peri;
    this.log(`discovered ${characteristics.length} characteristics`);
  }

  async disconnect(): Promise<void> {
    if (this.peripheral) {
      try {
        await this.peripheral.disconnectAsync();
      } catch {
        /* ignore */
      }
    }
    this.peripheral = null;
    this.chars.clear();
  }

  async send(charUuid: string, data: Uint8Array): Promise<void> {
    const c = this.getChar(charUuid);
    const props: string[] = c.properties ?? [];
    // noble's writeAsync(withoutResponse=true) trả ngay, controller có thể drop chunks
    // → ép withResponse nếu char hỗ trợ "write" property; fallback writeWithoutResponse.
    const supportsWithResp = props.includes("write");
    const withoutResponse = !supportsWithResp;
    if (process.env.BLE_TRACE) {
      const hex = [...data].map((b) => b.toString(16).padStart(2, "0")).join("");
      this.log(`→ ${charUuid.slice(0, 8)}: ${hex} (wnr=${withoutResponse})`);
    }
    await c.writeAsync(Buffer.from(data), withoutResponse);
    // Throttle giữa các fragment (mimic bleak's canSendWriteWithoutResponse drain on macOS).
    if (withoutResponse) await new Promise((r) => setTimeout(r, 30));
  }

  async listen(charUuid: string, cb: NotifyCallback): Promise<Unsubscribe> {
    const c = this.getChar(charUuid);
    const traced: NotifyCallback = (d) => {
      if (process.env.BLE_TRACE) {
        const hex = [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
        this.log(`← ${charUuid.slice(0, 8)}: ${hex}`);
      }
      cb(d);
    };
    const listener = (data: Buffer) => traced(new Uint8Array(data));
    c.on("data", listener);
    await c.subscribeAsync();
    return async () => {
      try {
        c.removeListener("data", listener);
        await c.unsubscribeAsync().catch(() => void 0);
      } catch {
        /* ignore */
      }
    };
  }

  private getChar(uuid: string): any {
    for (const form of uuidForms(uuid)) {
      const c = this.chars.get(form);
      if (c) return c;
    }
    throw new Error(`characteristic not found: ${uuid}`);
  }

  private waitPoweredOn(): Promise<void> {
    return new Promise((resolve, reject) => {
      const state = (noble as any).state ?? (noble as any)._state;
      if (state === "poweredOn") return resolve();
      const onState = (s: string) => {
        if (s === "poweredOn") {
          (noble as any).removeListener("stateChange", onState);
          resolve();
        } else if (s === "unauthorized" || s === "unsupported") {
          (noble as any).removeListener("stateChange", onState);
          reject(
            new Error(
              `Bluetooth state=${s}. macOS TCC chưa cấp BT cho process này — chạy từ Terminal.app trực tiếp.`,
            ),
          );
        } else {
          this.log(`bluetooth state: ${s}…`);
        }
      };
      (noble as any).on("stateChange", onState);
    });
  }

  private findPeripheral(): Promise<any> {
    return new Promise(async (resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        (noble as any).removeListener("discover", onDiscover);
        noble.stopScanningAsync().catch(() => void 0);
        reject(new Error(`scan timeout (${this.scanTimeoutMs}ms) — DP1A chưa thấy. Chạm khoá để wake.`));
      }, this.scanTimeoutMs);

      const onDiscover = (p: any) => {
        if (done) return;
        const uuid = normUuid(p.uuid);
        const name = (p.advertisement?.localName ?? "").trim().toLowerCase();
        if (uuid === this.target || this.nameMatch.has(name)) {
          done = true;
          clearTimeout(timer);
          (noble as any).removeListener("discover", onDiscover);
          noble.stopScanningAsync().catch(() => void 0);
          this.log(`lock found: ${p.uuid} rssi=${p.rssi} name=${JSON.stringify(name)}`);
          resolve(p);
        }
      };

      (noble as any).on("discover", onDiscover);
      this.log(`scanning… (target=${this.target}, names=${[...this.nameMatch].join("|")})`);
      try {
        await noble.startScanningAsync([], false);
      } catch (e) {
        done = true;
        clearTimeout(timer);
        (noble as any).removeListener("discover", onDiscover);
        reject(e);
      }
    });
  }
}
