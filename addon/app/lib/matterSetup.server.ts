import type { AuthData } from "./session.server";
import { cloudFor } from "./aqara.server";

export interface MatterSetupResult {
  homePositionId: string;
  signalsCreated: number;
  signalsSynced: number;
  signalNames: string[];
  bridgeName: string | null;
  pairingCode: string | null;
  onboardingPayload: string | null;
  done: boolean;
  error?: string;
}

// Cache kết quả per-token để KHÔNG chạy lại mỗi request (idempotent + nhẹ).
const cache = new Map<string, { at: number; res: MatterSetupResult[] }>();
const TTL = 5 * 60_000;

/**
 * 100% tự động: tạo tín hiệu cho mọi lock-event (nếu account chưa có) → đồng bộ TOÀN BỘ
 * tín hiệu ra Matter bridge → bật bridge + lấy mã pairing (cho HA đọc).
 * Idempotent: chỉ tạo khi trống; luôn sync lại; cache 5 phút.
 */
export async function runMatterSetup(auth: AuthData, opts: { createIfEmpty?: boolean; force?: boolean } = {}): Promise<MatterSetupResult[]> {
  if (!opts.force) {
    const c = cache.get(auth.token);
    if (c && Date.now() - c.at < TTL) return c.res;
  }
  const cloud = cloudFor(auth);
  const locks = await cloud.discoverLocks();
  const byHome = new Map<string, typeof locks>();
  for (const l of locks) {
    if (!byHome.has(l.homePositionId)) byHome.set(l.homePositionId, []);
    byHome.get(l.homePositionId)!.push(l);
  }

  const results: MatterSetupResult[] = [];
  for (const [homePid, homeLocks] of byHome) {
    const r: MatterSetupResult = {
      homePositionId: homePid, signalsCreated: 0, signalsSynced: 0, signalNames: [],
      bridgeName: null, pairingCode: null, onboardingPayload: null, done: false,
    };
    try {
      let details = await cloud.getSignalDetails(homePid).catch(() => [] as Array<{ id: string; name: string }>);

      // tạo tín hiệu cho mọi lock-event nếu account chưa có
      if (!details.length && opts.createIfEmpty !== false) {
        for (const lock of homeLocks) {
          const events = await cloud.getLockTriggerEvents(lock.did).catch(() => []);
          for (const ev of events) {
            try {
              await cloud.createSignal({
                homePositionId: homePid,
                name: `${lock.name} · ${ev.triggerName}`.slice(0, 40),
                lockDid: lock.did,
                lockModel: lock.model,
                triggerName: ev.triggerName,
                triggerDefinitionId: ev.triggerDefinitionId,
                group: ev.group,
              });
              r.signalsCreated++;
            } catch {
              /* event cần param credential riêng → bỏ qua (best-effort) */
            }
          }
        }
        details = await cloud.getSignalDetails(homePid).catch(() => details);
      }

      // đồng bộ TOÀN BỘ tín hiệu ra Matter bridge
      if (details.length) {
        const map: Record<string, string> = {};
        for (const d of details) map[d.id] = d.name;
        await cloud.syncSignalsToMatter(map, homePid);
        r.signalsSynced = details.length;
        r.signalNames = details.map((d) => d.name);
      }

      // bridge + mã pairing cho HA
      const bridge = await cloud.getSignalBridge(homePid).catch(() => null);
      r.bridgeName = bridge?.deviceName ?? null;
      const hub = await cloud.findMatterBridgeHub(homePid).catch(() => null);
      if (hub) {
        const code = await cloud.openMatterBridge(hub.did).catch(() => null);
        if (code) {
          r.pairingCode = code.manualPairingCode;
          r.onboardingPayload = code.onboardingPayload;
        }
      }
      r.done = true;
    } catch (e: any) {
      r.error = e?.message?.slice(0, 140) || "lỗi";
    }
    results.push(r);
  }
  cache.set(auth.token, { at: Date.now(), res: results });
  return results;
}

export function cachedMatterSetup(token: string): MatterSetupResult[] | null {
  return cache.get(token)?.res ?? null;
}
