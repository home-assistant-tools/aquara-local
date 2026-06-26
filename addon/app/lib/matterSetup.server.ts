import type { AuthData } from "./session.server";
import { cloudFor } from "./aqara.server";
import { saveBridgeConfig, type CredLevel } from "./runtime.server";
import {
  ensureLightBridge,
  ensureVirtualLight,
  EVENT_LEVELS,
  registerDynamicLevels,
  type BridgeHub,
  type BridgeLock,
  type LightBridgeInfo,
} from "./lightBridge.server";

// credential type (từ getLockCredentials) → trigger per-người + nhãn cách mở.
const CRED_TYPE_TRIGGER: Record<number, { td: string; method: string }> = {
  1: { td: "TD.unlock_someone_fing", method: "Vân tay" },
  2: { td: "TD.unlock_someone_password", method: "Mật khẩu" },
  3: { td: "TD.unlock_someone_nfc", method: "NFC" },
};

export interface MatterSetupResult {
  homePositionId: string;
  hubDid: string;
  hubName: string;
  lockDid: string;
  lockName: string;
  light: LightBridgeInfo;
  automationsCreated: number;
  levelMap: Array<{ level: number; triggerName: string; linkageId: string }>;
  done: boolean;
  error?: string;
}

const cache = new Map<string, { at: number; res: MatterSetupResult[] }>();
const TTL = 5 * 60_000;

// Tên automation tất định — TÊN = mã hoá (trigger + mức). Đổi trigger/mức → đổi tên → reconcile sẽ thay.
const unlockAutomationName = (lockName: string) => `[addon] ${lockName}: đèn ON → mở khóa`;
const levelAutomationName = (lockName: string, label: string, level: number) =>
  `[addon] ${lockName}: ${label} → mức ${level}`;

/** action "đặt độ sáng" KHÔNG kèm on/off (giữ kênh onOff riêng cho control). */
function pickSetBrightness(actions: Awaited<ReturnType<ReturnType<typeof cloudFor>["getDeviceActions"]>>) {
  return (
    actions.find((a) => /SetBrightness_cmd/.test(a.actionDefinitionId) && !/WithOnOff/i.test(a.actionDefinitionId)) ??
    actions.find((a) => /(brightness|level|độ sáng)/i.test(`${a.actionDefinitionId} ${a.actionName}`) && a.params.length) ??
    null
  );
}

/** trigger "đèn bật lên" (OnOff changeTo On) — cạnh kích mở khóa. */
function pickOnTrigger(triggers: Awaited<ReturnType<ReturnType<typeof cloudFor>["getDeviceTriggers"]>>) {
  return (
    triggers.find((t) => /OnOff_changeTo_On\b/.test(t.triggerDefinitionId)) ??
    triggers.find((t) => /changeTo_On/i.test(t.triggerDefinitionId)) ??
    triggers[0] ??
    null
  );
}

/**
 * RECONCILE automation trên hub Aqara cho ĐÚNG bộ mong muốn (chạy mỗi lần login/reload):
 *  • PHA 1: build TOÀN BỘ automation mong muốn (tên + config) — KHÔNG ghi cloud.
 *  • PHA 2: so với automation [addon] đang có → nếu LỆCH (thừa/thiếu/trùng) thì XOÁ SẠCH [addon] cũ
 *    rồi TẠO LẠI đúng bộ; nếu khớp y hệt thì BỎ QUA (không churn).
 * → diệt tận gốc bug "automation scheme cũ + mới chồng mức" + đảm bảo mỗi restart là chính xác.
 */
export async function runMatterSetup(
  auth: AuthData,
  opts: { force?: boolean } = {},
): Promise<MatterSetupResult[]> {
  if (!opts.force) {
    const c = cache.get(auth.token);
    if (c && Date.now() - c.at < TTL) return c.res;
  }

  const cloud = cloudFor(auth);
  type AutoConfig = Parameters<typeof cloud.createAutomation>[0];
  const hubs = (await cloud.discoverMatterHubs()) as BridgeHub[];
  const results: MatterSetupResult[] = [];
  const cfgHubs: BridgeHub[] = [];
  const cfgLocks: BridgeLock[] = [];
  const lockHub: Record<string, string> = {};
  const cfgCredLevels: CredLevel[] = [];

  for (const hub of hubs) {
    const locks = (await cloud.locksBoundToHub(hub)) as BridgeLock[];
    if (!locks.length) continue;
    cfgHubs.push(hub);
    for (const l of locks) {
      cfgLocks.push(l);
      lockHub[l.did] = hub.did;
    }
    const fabric = await cloud.getFabric(hub.homePositionId);
    // [addon] automation đang có trong home (để so + dọn)
    const existing = (await cloud.listLinkages(hub.homePositionId).catch(() => [])).filter((l) =>
      l.name?.startsWith("[addon]"),
    );

    // ── PHA 1: build DESIRED (KHÔNG ghi cloud — chỉ ensureVirtualLight/Bridge là cần thiết) ──
    const desired: Array<{ name: string; config: AutoConfig }> = [];
    const hubResults: MatterSetupResult[] = [];
    for (const lock of locks) {
      const light = await ensureVirtualLight(lock, hub);
      const r: MatterSetupResult = {
        homePositionId: hub.homePositionId,
        hubDid: hub.did,
        hubName: hub.name,
        lockDid: lock.did,
        lockName: lock.name,
        light,
        automationsCreated: 0,
        levelMap: [],
        done: false,
      };
      try {
        await ensureLightBridge({ cloud, fabric, hub, lock });
        if (!light.aqaraDid) throw new Error(light.error || "đèn đã chạy nhưng chưa bind được vào Aqara hub");

        const [lightActions, lightTriggers, lockTriggers] = await Promise.all([
          cloud.getDeviceActions(light.aqaraDid),
          cloud.getDeviceTriggers(light.aqaraDid),
          cloud.getDeviceTriggers(lock.did),
        ]);
        const setBright = pickSetBrightness(lightActions);
        const onTrig = pickOnTrigger(lightTriggers);
        if (!setBright) throw new Error("đèn Matter không lộ action SetBrightness");
        if (!onTrig) throw new Error("đèn Matter không lộ trigger OnOff");

        // (1) CONTROL: đèn ON → mở D100 (local trên hub)
        desired.push({
          name: unlockAutomationName(lock.name),
          config: {
            homePositionId: hub.homePositionId,
            name: unlockAutomationName(lock.name),
            iconInfo: `${light.model}#matter_device_icon_11|${lock.model}`,
            trigger: {
              subjectId: light.aqaraDid,
              subjectModel: light.model,
              subjectName: light.lockName,
              roomPositionId: light.roomPositionId,
              triggerDefinitionId: onTrig.triggerDefinitionId,
              triggerName: onTrig.triggerName,
              endpointId: "2",
              endpointName: "Light",
              usageType: 11,
              type: -1,
            },
            action: {
              subjectId: lock.did,
              subjectModel: lock.model,
              subjectName: lock.name,
              roomPositionId: lock.roomPositionId,
              actionDefinitionId: "AD.unlock",
              actionName: "Mở khóa",
              rids: ["4.17.85"],
            },
          },
        });

        // (2) STATUS: mỗi sự kiện khóa (lock hỗ trợ) → SetBrightness(mức cố định)
        const lockTds = new Set(lockTriggers.map((t) => t.triggerDefinitionId));
        for (const ev of EVENT_LEVELS) {
          if (!lockTds.has(ev.td)) continue; // khóa không hỗ trợ sự kiện này
          const name = levelAutomationName(lock.name, ev.label, ev.level);
          desired.push({
            name,
            config: {
              homePositionId: hub.homePositionId,
              name,
              iconInfo: `${lock.model}|${light.model}#matter_device_icon_11`,
              trigger: {
                subjectId: lock.did,
                subjectModel: lock.model,
                subjectName: lock.name,
                roomPositionId: lock.roomPositionId,
                triggerDefinitionId: ev.td,
                triggerName: ev.label,
              },
              action: {
                subjectId: light.aqaraDid,
                subjectModel: light.model,
                subjectName: light.lockName,
                roomPositionId: light.roomPositionId,
                actionDefinitionId: setBright.actionDefinitionId,
                actionName: setBright.actionName,
                rids: setBright.rids,
                endpointId: "2",
                group: setBright.group,
                param: setBright.params?.[0],
                value: String(ev.level),
              },
            },
          });
          r.levelMap.push({ level: ev.level, triggerName: ev.label, linkageId: "" });
        }

        // (3) PER-NGƯỜI: mở từ NGOÀI bởi người cụ thể (vân tay/NFC/mật khẩu) — mức 60+.
        const creds = await cloud.getLockCredentials(lock.did).catch(() => [] as any[]);
        const seenTv = new Set<string>();
        const credList = creds
          .filter((c) => CRED_TYPE_TRIGGER[Number(c.type)] && c.typeValue && !seenTv.has(String(c.typeValue)) && seenTv.add(String(c.typeValue)))
          .sort((a, b) => String(a.typeValue).localeCompare(String(b.typeValue))); // sort → mức ổn định
        let credLevel = 60;
        for (const c of credList) {
          if (credLevel > 99) break;
          const map = CRED_TYPE_TRIGGER[Number(c.type)];
          const trig = lockTriggers.find((t) => t.triggerDefinitionId === map.td);
          if (!trig) {
            credLevel++;
            continue;
          }
          const person = c.typeGroupName || c.typeName || "?";
          const detail = c.typeName && c.typeName !== person ? ` (${c.typeName})` : "";
          const label = `${map.method} — ${person}${detail}`;
          const tv = String(c.typeValue);
          const name = `[addon] ${lock.name}: ${label} → mức ${credLevel}`;
          desired.push({
            name,
            config: {
              homePositionId: hub.homePositionId,
              name,
              iconInfo: `${lock.model}|${light.model}#matter_device_icon_11`,
              trigger: {
                subjectId: lock.did,
                subjectModel: lock.model,
                subjectName: lock.name,
                roomPositionId: lock.roomPositionId,
                triggerDefinitionId: map.td,
                triggerName: label,
                group: trig.group,
                params: [{ ...(trig.params?.[0] ?? {}), value: tv, originValue: tv }],
              },
              action: {
                subjectId: light.aqaraDid,
                subjectModel: light.model,
                subjectName: light.lockName,
                roomPositionId: light.roomPositionId,
                actionDefinitionId: setBright.actionDefinitionId,
                actionName: setBright.actionName,
                rids: setBright.rids,
                endpointId: "2",
                group: setBright.group,
                param: setBright.params?.[0],
                value: String(credLevel),
                delaySeconds: 2, // set mức per-người SAU ~2s → thắng các trigger generic (ch49…) bắn cùng lúc
              },
            },
          });
          r.levelMap.push({ level: credLevel, triggerName: label, linkageId: "" });
          cfgCredLevels.push({ level: credLevel, label, state: "unlocked-out", typeValue: tv });
          credLevel++;
        }
        r.done = true;
      } catch (e: any) {
        r.error = e?.message?.slice(0, 220) || "lỗi setup light bridge";
      }
      hubResults.push(r);
      results.push(r);
    }

    // ── PHA 2: RECONCILE — so desired vs existing ([addon]) ──
    const desiredNames = new Set(desired.map((d) => d.name));
    const existingNames = new Set(existing.map((e) => e.name));
    const stale = existing.filter((e) => !desiredNames.has(e.name)); // rác / scheme cũ
    const missing = desired.filter((d) => !existingNames.has(d.name)); // thiếu
    const dup = existing.length !== existingNames.size; // trùng tên
    // CHỈ reconcile khi đã build được desired (tránh xoá nhầm khi setup lỗi giữa chừng).
    if (desired.length && (stale.length || missing.length || dup)) {
      if (existing.length) await cloud.deleteLinkages(existing.map((e) => e.linkageId)).catch(() => {});
      let created = 0;
      for (const d of desired) {
        const id = await cloud.createAutomation(d.config).catch(() => "");
        if (id) created++;
      }
      console.log(
        `[matterSetup] reconcile: xoá ${existing.length} ([addon] cũ, rác=${stale.length}), tạo lại ${created}/${desired.length} đúng bộ`,
      );
      for (const r of hubResults) r.automationsCreated = created;
    } else {
      console.log(`[matterSetup] automation đã ĐÚNG (${existing.length} cái khớp) — bỏ qua, không đụng.`);
    }
  }

  // Cache hub+khóa+per-người xuống /data → lần sau dựng lại + decode offline KHÔNG cần internet.
  if (cfgLocks.length) saveBridgeConfig({ hubs: cfgHubs, locks: cfgLocks, lockHub, credLevels: cfgCredLevels });
  registerDynamicLevels(cfgCredLevels); // để addon decode mức 60+ → "Vân tay — Ba"…

  cache.set(auth.token, { at: Date.now(), res: results });
  return results;
}

export function cachedMatterSetup(token: string): MatterSetupResult[] | null {
  return cache.get(token)?.res ?? null;
}
