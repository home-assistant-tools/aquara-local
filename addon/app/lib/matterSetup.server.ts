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

// Tên automation tất định (cho idempotency: mở lại dashboard KHÔNG tạo trùng).
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

export async function runMatterSetup(
  auth: AuthData,
  opts: { force?: boolean } = {},
): Promise<MatterSetupResult[]> {
  if (!opts.force) {
    const c = cache.get(auth.token);
    if (c && Date.now() - c.at < TTL) return c.res;
  }

  const cloud = cloudFor(auth);
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
    // existing [addon] automations trong home → name→linkageId (idempotency)
    const existing = new Map<string, string>();
    for (const l of await cloud.listLinkages(hub.homePositionId).catch(() => []))
      if (l.name?.startsWith("[addon]")) existing.set(l.name, l.linkageId);

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

        // (1) CONTROL: đèn ON → mở D100 (local trên hub) — idempotent
        const unlockName = unlockAutomationName(lock.name);
        let unlockId = existing.get(unlockName);
        if (!unlockId) {
          unlockId = await cloud.createAutomation({
            homePositionId: hub.homePositionId,
            name: unlockName,
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
          });
          if (unlockId) r.automationsCreated++;
        }

        // (2) STATUS: mỗi sự kiện khóa (có trong catalog) → SetBrightness(mức cố định) — idempotent
        const lockTds = new Set(lockTriggers.map((t) => t.triggerDefinitionId));
        for (const ev of EVENT_LEVELS) {
          if (!lockTds.has(ev.td)) continue; // khóa không hỗ trợ sự kiện này
          const name = levelAutomationName(lock.name, ev.label, ev.level);
          let lid = existing.get(name);
          if (!lid) {
            lid = await cloud.createAutomation({
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
            });
            if (lid) r.automationsCreated++;
          }
          if (lid) r.levelMap.push({ level: ev.level, triggerName: ev.label, linkageId: lid });
        }

        // (3) PER-NGƯỜI: mở từ NGOÀI bởi người cụ thể (vân tay/NFC/mật khẩu đã đăng ký) — mức 60+.
        // Mỗi credential (typeValue) → 1 automation "unlock_someone_<cách>[PD.lockUID=tv] → SetBrightness".
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
          if (!trig) { credLevel++; continue; }
          const person = c.typeGroupName || c.typeName || "?";
          const detail = c.typeName && c.typeName !== person ? ` (${c.typeName})` : "";
          const label = `${map.method} — ${person}${detail}`;
          const tv = String(c.typeValue);
          const name = `[addon] ${lock.name}: ${label} → mức ${credLevel}`;
          let lid = existing.get(name);
          if (!lid) {
            lid = await cloud.createAutomation({
              homePositionId: hub.homePositionId,
              name,
              iconInfo: `${lock.model}|${light.model}#matter_device_icon_11`,
              trigger: {
                subjectId: lock.did, subjectModel: lock.model, subjectName: lock.name, roomPositionId: lock.roomPositionId,
                triggerDefinitionId: map.td, triggerName: label, group: trig.group,
                params: [{ ...(trig.params?.[0] ?? {}), value: tv, originValue: tv }],
              },
              action: {
                subjectId: light.aqaraDid, subjectModel: light.model, subjectName: light.lockName, roomPositionId: light.roomPositionId,
                actionDefinitionId: setBright.actionDefinitionId, actionName: setBright.actionName, rids: setBright.rids,
                endpointId: "2", group: setBright.group, param: setBright.params?.[0], value: String(credLevel),
              },
            });
            if (lid) r.automationsCreated++;
          }
          if (lid) {
            r.levelMap.push({ level: credLevel, triggerName: label, linkageId: lid });
            cfgCredLevels.push({ level: credLevel, label, state: "unlocked-out", typeValue: tv });
          }
          credLevel++;
        }
        r.done = true;
      } catch (e: any) {
        r.error = e?.message?.slice(0, 220) || "lỗi setup light bridge";
      }
      results.push(r);
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
