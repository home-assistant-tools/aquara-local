// aqaraMatter.ts — Cloud orchestration cho addon "công tắc ảo Matter → mở D100".
//
// Encode TOÀN BỘ cloud API đã bắt sống qua MITM 2026-06-17 (xem memory
// matter-virtual-switch-unlock + captures/mitm/flows_matter.mitm). Tất cả request đi qua
// AquaraMobileClient (đã ký sign/token/nonce). KHÔNG đụng BLE/Zigbee.
//
// Vòng đời addon:
//   1. getFabric(positionId)          GET  /user/cert/matter/home/list
//   2. genNodeId(positionId)          GET  /user/cert/matter/home/gen-nodeid
//   3. <commission switch tại đây>     (matter.js controller — file commissionSwitch.ts)
//   4. signup(gatewayId,nodeId,pid)   POST /matter/dev/signup
//   5. waitBind(nodeId,pid)           GET  /matter/bind/result  (poll) → Aqara DID switch
//   6. createUnlockAutomation(...)    POST /ifttt/linkage/pro/wit/set
import type { AquaraMobileClient } from "./AquaraMobileClient";

/** Vật liệu fabric Matter của account (đủ để ký NOC LOCAL bằng ICAC key). */
export interface MatterFabric {
  fabricId: string; // hex, vd "13FE...C000"
  ipk: string; // hex 16B Identity Protection Key
  rcacPem: string; // Root CA cert (PEM)
  icacPem: string; // Intermediate CA cert (PEM) — issuer của device NOC
  icacKeyPem: string; // Intermediate CA private key (PEM) — KÝ device NOC
  rcacId: string;
  icacId: string;
  subjectKeyId: string; // ICAC subject key id (= icacKeyIdentifier)
  rootKeyId: string; // RCAC subject key id (= rootKeyIdentifier; = authorityKeyId của ICAC)
  positionId: string;
}

export interface BindResult {
  did: string; // Aqara DID của switch, vd "matt.xxxxxxxx"
  gatewayId: string;
  roomId: string;
  nid: string;
}

/** hex nodeId ("2CA494C56674136") → decimal string ("201053725587358006") cho nid. */
export function nodeIdHexToDecimal(hex: string): string {
  return BigInt("0x" + hex.replace(/^0x/i, "")).toString(10);
}

export class AqaraMatterCloud {
  constructor(private readonly cloud: AquaraMobileClient) {}

  // ---- discovery + điều khiển cloud (cho UI addon) -------------------------
  /** Liệt kê khóa của account (mọi home). did/name/model + room + home + hub cha. */
  async discoverLocks(): Promise<
    Array<{ did: string; name: string; model: string; roomPositionId: string; homePositionId: string; parentDeviceId: string }>
  > {
    const home = await this.cloud.get<any>("/app/position/query/home/list", { needDefaultRoom: "false", size: 300, startIndex: 0 });
    const homes = home?.homes ?? home?.result?.homes ?? [];
    const out: any[] = [];
    for (const h of homes) {
      const homePid = h.positionId ?? h.homeId;
      const dev = await this.cloud.get<any>("/app/position/device/query", { positionId: homePid, size: 300, startIndex: 0 });
      const list = dev?.devices ?? dev?.data ?? dev?.result?.devices ?? [];
      for (const d of list) {
        const model = String(d.model ?? "");
        if (["aqara.lock.aqgl01", "aqgl", "dp1a", ".lock."].some((m) => model.toLowerCase().includes(m)))
          out.push({
            did: d.did ?? d.subjectId,
            name: d.deviceName ?? d.name ?? "Door Lock",
            model,
            roomPositionId: d.positionId ?? homePid,
            homePositionId: homePid,
            parentDeviceId: d.parentDeviceId ?? "",
          });
      }
    }
    return out;
  }

  // Matter DoorLock trait (cloud → hub → Zigbee, KHÔNG cần BLE). ✅ verified.
  private async matterWrite(did: string, trait: string, value: any = ""): Promise<void> {
    await this.cloud.post("/matter/write", { data: { [trait]: value }, did, pwd: "", type: 0 });
  }
  /** Mở khóa từ xa (Matter unlockDoor 2.148.35011). */
  async remoteUnlock(lockDid: string): Promise<void> {
    await this.matterWrite(lockDid, "2.148.35011.0");
  }
  /** Khóa lại (Matter lockDoor 2.148.35010). */
  async remoteLock(lockDid: string): Promise<void> {
    await this.matterWrite(lockDid, "2.148.35010.0");
  }

  // ---- 1) Fabric của account (ICAC cert+key để ký NOC local) ----------------
  // GET /user/cert/matter/home/list?positionId=<home pid>
  // result[]: entry có privateKey+ipk+fabricId = ICAC; entry rcacId==authorityKeyId = RCAC.
  async getFabric(positionId: string): Promise<MatterFabric> {
    const res = await this.cloud.get<any[]>("/user/cert/matter/home/list", { positionId });
    const list = Array.isArray(res) ? res : (res as any).result ?? [];
    const icac = list.find((e: any) => e.privateKey && e.fabricId) ?? list[0];
    const rcac = list.find((e: any) => e.rcacId && e.rcacId === e.authorityKeyId) ?? list[1] ?? icac;
    if (!icac?.privateKey) throw new Error("getFabric: không thấy ICAC privateKey trong home/list");
    return {
      fabricId: icac.fabricId,
      ipk: icac.ipk,
      rcacPem: rcac.cert,
      icacPem: icac.cert,
      icacKeyPem: icac.privateKey,
      rcacId: icac.rcacId,
      icacId: icac.icacId,
      subjectKeyId: icac.subjectKeyId, // ICAC SKI
      // RCAC SKI = subjectKeyId của entry RCAC (= authorityKeyId của ICAC). Fallback authorityKeyId.
      rootKeyId: rcac.subjectKeyId ?? icac.authorityKeyId,
      positionId,
    };
  }

  // ---- 2) Cấp nodeId mới cho device ----------------------------------------
  // GET /user/cert/matter/home/gen-nodeid?positionId=&size=1 → {nodeIds:["<hex>"]}
  async genNodeId(positionId: string): Promise<string> {
    const res = await this.cloud.get<any>("/user/cert/matter/home/gen-nodeid", { positionId, size: 1 });
    const ids = res?.nodeIds ?? res?.result?.nodeIds ?? [];
    if (!ids.length) throw new Error("genNodeId: rỗng");
    return ids[0] as string; // hex
  }

  // ---- 4) Bind node đã commission vào hub ----------------------------------
  // POST /matter/dev/signup {gatewayId, nid(DECIMAL), positionId}
  async signup(gatewayId: string, nodeIdHex: string, positionId: string): Promise<void> {
    await this.cloud.post("/matter/dev/signup", {
      gatewayId,
      nid: nodeIdHexToDecimal(nodeIdHex),
      positionId,
    });
  }

  // ---- 5) Poll tới khi hub adopt device → trả Aqara DID --------------------
  // GET /matter/bind/result?nid=<DECIMAL>&positionId= → {} cho tới khi có {did,...}
  async waitBind(nodeIdHex: string, positionId: string, timeoutMs = 30000): Promise<BindResult> {
    const nid = nodeIdHexToDecimal(nodeIdHex);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await this.cloud.get<any>("/matter/bind/result", { nid, positionId });
      const v = r?.did ? r : r?.result?.did ? r.result : null;
      if (v?.did) return { did: v.did, gatewayId: v.gatewayId, roomId: v.roomId, nid };
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error(`waitBind: hub chưa adopt node ${nid} sau ${timeoutMs}ms`);
  }

  // ---- 6) Tạo automation "switch ON → mở D100" -----------------------------
  // POST /ifttt/linkage/pro/wit/set  (model app.ifttt.v2, chạy LOCAL trên hub)
  // Payload khớp 1:1 capture; chỉ thay DID/model/positionId.
  async createUnlockAutomation(args: {
    homePositionId: string; // real1.xxx (home)
    name: string;
    switchDid: string; // matt.xxx
    switchVendorIdDec: number; // 65521 (0xFFF1)
    switchProductIdDec: number; // 53505 (0xD101)
    switchRoomPositionId: string; // real2.xxx (room của switch)
    lockDid: string; // lumi.54ef44...
    lockRoomPositionId: string; // real2.xxx (room của khóa)
    lockName?: string;
  }): Promise<string> {
    const switchModel = `aqara.matter.${args.switchVendorIdDec}_${args.switchProductIdDec}`;
    const body = {
      executeOnce: false,
      fenceDataList: null,
      iconInfo: `${switchModel}#matter_device_icon_11|aqara.lock.aqgl01`,
      ifConfig: { content: [], duration: 0, relation: 0 },
      linkageId: null,
      name: args.name,
      oldLinkageId: null,
      positionId: args.homePositionId,
      tags: null,
      thenConfig: {
        content: [
          {
            actionDefinitionId: "AD.unlock",
            actionName: "Mở khóa",
            appFilterRule: 2,
            appIdAssignType: 0,
            beginTimeBand: "",
            cateoryValue: [],
            conditionId: "",
            definitionIcon: null,
            delayTime: "0",
            delayTimeUnit: "0",
            delayType: "0",
            durationTime: "",
            endTimeBand: "",
            endpointId: "",
            endpointName: "",
            eventType: 0,
            fenceDataList: "",
            filterMonostable: 0,
            group: "",
            groupId: "",
            groupName: "",
            groupSort: "999",
            iconId: "",
            iconInfo: "",
            isGeoCurrentClientLocalInRange: false,
            isGeoNeedToShowActiveInfo: false,
            isMatchedDevice: false,
            lockState: 0,
            logicNot: 0,
            mutex: [],
            openLevel: 0,
            originParams: [],
            params: [],
            positionId: args.lockRoomPositionId,
            rids: ["4.17.85"], // resource id của lệnh unlock D100
            rules: [],
            serialNum: 0,
            showName: "${actionName} $mv{'default'} $mu{'default'}",
            sortNo: 0,
            status: 1,
            subSort: "999",
            subjectId: args.lockDid,
            subjectModel: "aqara.lock.aqgl01",
            subjectName: args.lockName ?? "D100",
            subjectType: "1",
            tagInfo: {},
            timeBandType: 0,
            triggerDefinitionId: null,
            triggerName: "",
            triggerType: 0,
            type: 1,
            usageType: 0,
            version: 0,
            xcode: "",
          },
        ],
        duration: 0,
        relation: 0,
      },
      whenConfig: {
        content: [
          {
            actionDefinitionId: null,
            actionName: "",
            appFilterRule: 0,
            appIdAssignType: 0,
            beginTimeBand: "",
            cateoryValue: [],
            conditionId: "",
            definitionIcon: "",
            delayTime: "0",
            delayTimeUnit: "0",
            delayType: "0",
            durationTime: "",
            endTimeBand: "",
            endpointId: "2",
            endpointName: "Outlet",
            eventType: 0,
            fenceDataList: "",
            filterMonostable: 0,
            group: "",
            groupId: "",
            groupName: "",
            groupSort: "999",
            iconId: "",
            iconInfo: "",
            isGeoCurrentClientLocalInRange: false,
            isGeoNeedToShowActiveInfo: false,
            isMatchedDevice: false,
            lockState: 0,
            logicNot: 0,
            mutex: [],
            openLevel: 1,
            originParams: [],
            params: [],
            positionId: args.switchRoomPositionId,
            rids: [],
            rules: [],
            serialNum: 0,
            showName: "${triggerName}",
            sortNo: 0,
            status: 1,
            subSort: "999",
            subjectId: args.switchDid,
            subjectModel: switchModel,
            subjectName: "D100 Unlock Switch",
            subjectType: "1",
            tagInfo: {},
            timeBandType: 0,
            triggerDefinitionId: "TD.2.132.32920.1-4-1-0-OnOff_changeTo_On",
            triggerName: "Bật lên",
            triggerType: 0,
            type: -1,
            usageType: 11,
            version: 0,
            xcode: "",
          },
        ],
        duration: 0,
        relation: 0,
      },
    };
    const res = await this.cloud.post<any>("/ifttt/linkage/pro/wit/set", body);
    return res?.linkageId ?? res?.result?.linkageId ?? "";
  }

  // ---- list / delete automation (cleanup + idempotency) --------------------
  // GET /app/position/linkage/query → {ifttts:[{linkageId,name,iconInfo,...}]}
  async listLinkages(positionId: string): Promise<Array<{ linkageId: string; name: string; iconInfo: string }>> {
    const r = await this.cloud.get<any>("/app/position/linkage/query", { positionId, size: 150, startIndex: 0 });
    const arr = r?.ifttts ?? r?.result?.ifttts ?? [];
    return arr.map((x: any) => ({ linkageId: x.linkageId, name: x.name, iconInfo: x.iconInfo ?? "" }));
  }

  // POST /ifttt/batch/delete {linkageIds:[...]}
  async deleteLinkages(linkageIds: string[]): Promise<void> {
    if (!linkageIds.length) return;
    await this.cloud.post("/ifttt/batch/delete", { linkageIds });
  }

  // ======================================================================
  // #3 — ĐỌC TOÀN BỘ TÍN HIỆU KHÓA (state + battery + ai mở cửa)
  // ======================================================================
  /** Toàn bộ attr trạng thái khóa D100 (res/query). */
  static readonly LOCK_ATTRS = [
    "lock_state",
    "arm_state",
    "batt_0_remain_percentage",
    "low_battery_power",
    "device_offline_status",
    "enable_remote_operation",
    "lockout_event",
    "user_guide",
  ];

  /** POST /res/query → {attr: value} cho toàn bộ tín hiệu trạng thái khóa. */
  async getLockSignals(lockDid: string, attrs: string[] = AqaraMatterCloud.LOCK_ATTRS): Promise<Record<string, string>> {
    const res = await this.cloud.post<any[]>("/res/query", { data: [{ options: attrs, subjectId: lockDid }] });
    const out: Record<string, string> = {};
    for (const r of Array.isArray(res) ? res : []) if (r?.attr) out[r.attr] = r.value;
    return out;
  }

  /** GET /dev/lock/query → user/credential (vân tay/mật khẩu/NFC/face). types 1..7. */
  async getLockCredentials(lockDid: string, types = "[1,2,3,4,5,6,7]"): Promise<any[]> {
    const res = await this.cloud.get<any>("/dev/lock/query", { deviceId: lockDid, types });
    return Array.isArray(res) ? res : res?.data ?? [];
  }

  /**
   * POST /app/lock/res/history/query attr `lock_local_log` → AI MỞ CỬA.
   * value là log mã hoá (decode who+how như README/coordinator cũ). Trả raw entries.
   */
  async getLockHistory(lockDid: string, size = 200, startTime?: number, endTime?: number): Promise<any[]> {
    const now = Date.now();
    const res = await this.cloud.post<any>("/app/lock/res/history/query", {
      attrs: ["lock_local_log"],
      startTime: String(startTime ?? now - 7 * 86400000),
      endTime: String(endTime ?? now),
      startIndex: "0",
      size: String(size),
      subjectId: lockDid,
    });
    return res?.resultList ?? res?.result?.resultList ?? [];
  }

  // ======================================================================
  // #4 — XUẤT TÍN HIỆU RA MATTER (hub thành Matter bridge cho HA đọc)
  // Resource trên HUB (lumi3.xxx): 4.200.85=bật pairing, 4.200.700=mã code,
  // 13.202.85=trạng thái window, 13.201.700=list fabric đã kết nối.
  // ======================================================================
  /** POST /res/write 4.200.85=1 → mở Matter commissioning window trên hub (bật export). */
  async enableMatterExport(hubDid: string): Promise<void> {
    await this.cloud.post("/res/write", { data: { "4.200.85": "1" }, subjectId: hubDid });
  }

  /** POST /res/query/by/resourceId 4.200.700 → {onboardingPayload(QR), manualPairingCode} cho HA pair bridge. */
  async getMatterPairingCode(hubDid: string): Promise<{ onboardingPayload: string; manualPairingCode: string }> {
    const res = await this.cloud.post<any[]>("/res/query/by/resourceId", {
      data: [{ options: ["4.200.700"], subjectId: hubDid }],
    });
    const raw = (Array.isArray(res) ? res : [])[0]?.value ?? "{}";
    const v = JSON.parse(raw);
    return { onboardingPayload: v.onboarding_payload, manualPairingCode: v.manual_pairing_code };
  }

  /** Bật export + lấy mã pairing trong 1 call. */
  async openMatterBridge(hubDid: string): Promise<{ onboardingPayload: string; manualPairingCode: string }> {
    await this.enableMatterExport(hubDid);
    await new Promise((r) => setTimeout(r, 800));
    return this.getMatterPairingCode(hubDid);
  }

  /** POST /res/query/by/resourceId 13.201.700 → list fabric Matter đã kết nối hub (#1 phụ). */
  async getMatterFabrics(hubDid: string): Promise<Array<{ vendorId: number; fabric: string; nodeId: string; manufacturer: string }>> {
    const res = await this.cloud.post<any[]>("/res/query/by/resourceId", {
      data: [{ options: ["13.201.700"], subjectId: hubDid }],
    });
    const raw = (Array.isArray(res) ? res : [])[0]?.value ?? '{"list":[]}';
    return (JSON.parse(raw).list ?? []).map((x: any) => ({
      vendorId: x.vendor_id, fabric: x.fabric, nodeId: x.node_id, manufacturer: x.manufacturer,
    }));
  }

  // ======================================================================
  // #1 — HUB hỗ trợ Matter bridge: dò bằng cách thử đọc resource 13.202.85
  //       (chỉ hub Matter-capable mới có). Trả các hub + có bridge hay không.
  // ======================================================================
  // ======================================================================
  // SIGNAL-EXPORT 100% TỰ ĐỘNG (bắt qua MITM WebView 2026-06-17, CA-mount nsenter)
  // Luồng: getLockTriggerEvents → createSignal(mỗi event/credential) → syncSignalsToMatter.
  // → xuất MỌI tín hiệu khóa (gồm AI mở: mỗi vân tay/NFC/người = 1 occupancy sensor Matter).
  // ======================================================================
  /** GET /ifttt/subject/trigger/query → catalog event khóa (TD.unlock_someone_{fing,nfc,password,indoor,away,emergency,...}). */
  async getLockTriggerEvents(lockDid: string): Promise<any[]> {
    const r = await this.cloud.get<any>("/ifttt/subject/trigger/query", { applicationSide: 1, subjectId: lockDid });
    return Array.isArray(r) ? r : r?.data ?? r?.triggers ?? [];
  }

  /**
   * POST /ifttt/event/set — tạo 1 tín hiệu (trigger lock-event) → trả eventId `CL.xxx`.
   * `credential` (tuỳ chọn): {value=typeValue từ getLockCredentials, name} để gắn "ai" (vân tay/NFC cụ thể).
   */
  async createSignal(args: {
    homePositionId: string;
    name: string;
    lockDid: string;
    lockModel?: string;
    triggerName: string;
    triggerDefinitionId: string; // vd "TD.unlock_someone_fing"
    group: string; // vd "coerce_fingerprint_event"
    credential?: { value: string; name: string }; // PD.lockUID
  }): Promise<string> {
    const content: any = {
      timeBandType: 0,
      triggerName: args.triggerName,
      mutex: [],
      isOnline: 1,
      rules: [],
      subjectType: 1,
      subjectId: args.lockDid,
      positionName: "",
      isRemoved: 0,
      subjectModel: args.lockModel ?? "aqara.lock.aqgl01",
      delayType: 0,
      recommendAutomation: false,
      useless: false,
      endTimeBand: "",
      state: 1,
      group: args.group,
      subjectName: "",
      usageType: 0,
      iconId: "",
      delayTimeUnit: 0,
      beginTimeBand: "",
      serialNum: 0,
      showName: "${triggerName} $mn{'default'}",
      triggerDefinitionId: args.triggerDefinitionId,
      prdName: "",
      endpointId: -1,
      appIdAssignType: 0,
      eventType: 0,
      params: args.credential
        ? [{
            ext: "", serialNum: 0, defaultValue: "", maxValue: "", paramUnit: "", multiple: 1,
            expands: { dynamic: 1 }, paramName: args.credential.name, paramType: "2", paramDesc: "",
            minValue: "", name: "", uiType: 10, step: "1.0", state: 1, bid: "", businessType: "",
            paramId: "PD.lockUID", value: args.credential.value, originValue: args.credential.value, paramEnum: {},
          }]
        : [],
      isNotExist: 0, hide: false, isOpen: 0, paramsUseless: false, positionId: "", removed: false,
      subjectNameWithEndPoint: "", online: true, delayTime: 0, appFilterRule: 0, isUseless: 0, status: 1,
    };
    const res = await this.cloud.post<any>("/ifttt/event/set", {
      content: [content], enable: "1", name: args.name, positionId: args.homePositionId, relation: 0,
    });
    return res?.eventId ?? res?.result?.eventId ?? "";
  }

  /** GET /dev/signals/list/query → danh sách signal ID đã tạo (`CL.xxx`). */
  async listSignals(positionId: string): Promise<string[]> {
    const r = await this.cloud.get<any>("/dev/signals/list/query", { positionId });
    return r?.data ?? r?.result?.data ?? [];
  }

  /** GET /dev/signals/bridge/query → thiết bị bridge (vd G410) cho position. */
  async getSignalBridge(positionId: string): Promise<{ deviceId: string; deviceModel: string; deviceName: string } | null> {
    const r = await this.cloud.get<any>("/dev/signals/bridge/query", { positionId });
    return r?.deviceId ? { deviceId: r.deviceId, deviceModel: r.deviceModel, deviceName: r.deviceName } : null;
  }

  /** POST /dev/signals/add {data:{signalId:name}, positionId} — ĐẨY toàn bộ signal ra Matter bridge. */
  async syncSignalsToMatter(signals: Record<string, string>, positionId: string): Promise<void> {
    await this.cloud.post("/dev/signals/add", { data: signals, positionId });
  }

  /** POST /dev/signals/delete — gỡ signal khỏi Matter. */
  async deleteSignals(signalIds: string[], positionId: string): Promise<void> {
    if (!signalIds.length) return;
    await this.cloud.post("/dev/signals/delete", { data: signalIds, positionId });
  }

  async isMatterBridgeHub(hubDid: string): Promise<boolean> {
    try {
      const res = await this.cloud.post<any[]>("/res/query/by/resourceId", {
        data: [{ options: ["13.202.85"], subjectId: hubDid }],
      });
      return Array.isArray(res) && res.length > 0 && res[0]?.resourceId === "13.202.85";
    } catch {
      return false;
    }
  }
}
