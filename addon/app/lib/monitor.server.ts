import { EventEmitter } from "node:events";
import type { AuthData } from "./session.server";
import { cloudFor, lockView, type LockView } from "./aqara.server";

// Poll cloud cho trạng thái khóa + event "ai mở", emit cho mọi client SSE của account.
// 1 monitor / token. Tự dừng khi không còn subscriber.
const STATE_MS = 30_000; // trạng thái + pin
const EVENT_MS = 12_000; // event log (ai mở) — nhanh hơn để gần realtime

class LockMonitor extends EventEmitter {
  private timerState?: ReturnType<typeof setInterval>;
  private timerEvent?: ReturnType<typeof setInterval>;
  private subs = 0;
  snapshot: LockView[] = [];
  private locks: Array<{ did: string; name: string; model: string; homePositionId: string; roomPositionId: string }> = [];
  private starting?: Promise<void>;

  constructor(private auth: AuthData) {
    super();
    this.setMaxListeners(0);
  }

  private async discover() {
    const cloud = cloudFor(this.auth);
    this.locks = await cloud.discoverLocks();
  }

  private async refresh() {
    if (!this.locks.length) await this.discover().catch(() => void 0);
    const cloud = cloudFor(this.auth);
    const views = await Promise.all(this.locks.map((l) => lockView(cloud, l).catch(() => null)));
    this.snapshot = views.filter(Boolean) as LockView[];
    this.emit("update", this.snapshot);
  }

  private async ensureStarted() {
    if (this.timerState) return;
    if (!this.starting) {
      this.starting = (async () => {
        await this.discover().catch(() => void 0);
        await this.refresh().catch(() => void 0);
        this.timerState = setInterval(() => this.refresh().catch(() => void 0), STATE_MS);
        this.timerEvent = setInterval(() => this.refresh().catch(() => void 0), EVENT_MS);
      })();
    }
    await this.starting;
  }

  async subscribe(cb: (v: LockView[]) => void): Promise<() => void> {
    this.subs++;
    await this.ensureStarted();
    this.on("update", cb);
    if (this.snapshot.length) cb(this.snapshot); // gửi ngay snapshot hiện có
    return () => {
      this.off("update", cb);
      if (--this.subs <= 0) this.stop();
    };
  }

  /** Refresh tức thì (sau khi unlock/lock) → đẩy state mới cho UI nhanh. */
  async kick() {
    await this.refresh().catch(() => void 0);
  }

  private stop() {
    if (this.timerState) clearInterval(this.timerState);
    if (this.timerEvent) clearInterval(this.timerEvent);
    this.timerState = this.timerEvent = undefined;
    this.starting = undefined;
    monitors.delete(this.auth.token);
  }
}

const monitors = new Map<string, LockMonitor>();

export function getMonitor(auth: AuthData): LockMonitor {
  let m = monitors.get(auth.token);
  if (!m) {
    m = new LockMonitor(auth);
    monitors.set(auth.token, m);
  }
  return m;
}
