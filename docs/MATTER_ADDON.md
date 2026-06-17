# Aqara Matter Addon — điều khiển & đọc D100 qua Matter, 100% tự động

Hướng **phần mềm thuần** (bỏ can thiệp BLE/Zigbee): dùng **Matter** làm mặt phẳng tích hợp
giữa Home Assistant và hub Aqara. Toàn bộ API dưới đây **reverse-engineered + verified live**
(MITM app Aqara Home 6.3.1, account SEA/rpc-au). Cấu hình thật trong phiên RE:
**D100** `aqara.lock.aqgl01` (Zigbee child của **G410** doorbell-hub), **M100** = hub làm Matter
controller/bridge, account SEA → `rpc-au.aqara.com`.

> Code: [`client/aqaraMatter.ts`](../client/aqaraMatter.ts) (cloud, mọi endpoint),
> [`client/commissionSwitch.ts`](../client/commissionSwitch.ts) (matter.js auto-commission),
> [`tools/virtual_switch_matter.ts`](../tools/virtual_switch_matter.ts) (công tắc ảo),
> [`tools/matter_addon_setup.ts`](../tools/matter_addon_setup.ts) (orchestrator).

---

## 1. Kiến trúc — 2 mặt phẳng Matter

```
        ┌──────────────────────── HA Addon (Docker, TS) ────────────────────────┐
        │  client/  ── Aqara cloud: login, discover, commission, automation,      │
        │                signal-export (mọi endpoint ở §3–6)                      │
        │  matter.js DEVICE ── công tắc ảo OnOff  ◄──commission── Hub M100         │
        │  matter.js CONTROLLER ── tự commission công tắc vào fabric Aqara (§4)    │
        │  MQTT discovery ──► HA: lock entity + sensor "ai mở"                     │
        └────────────────────────────────────────────────────────────────────────┘
  UNLOCK : HA lock.unlock → addon PULSE công tắc ảo ON → automation hub → G410 mở khóa (local)
  READ   : signal-export (§5) → hub bridge xuất tín hiệu khóa ra Matter → HA pair bridge (local push)
  AI MỞ  : mỗi vân tay/NFC/người = 1 occupancy sensor Matter riêng (§5) + cloud event-log (§6)
```

**Vì sao không điều khiển khóa trực tiếp qua Matter bridge?** D100 (`dp1a`,
`FeatureConfig.Matter.isMatterDevice=false`) KHÔNG được hub xuất thành Matter *DoorLock* —
chỉ xuất các *tín hiệu* (occupancy sensor). Nên **unlock đi qua cò công-tắc-ảo + automation hub**,
còn **read đi qua signal-export**.

---

## 2. Headers xác thực (QUAN TRỌNG)

App 6.3.1 gửi đủ bộ header dưới. `sign` (MD5) **KHÔNG ký** các header phụ → thêm an toàn,
nhưng **một số endpoint mới (matter-signal) gate theo `app-version`** → phải đúng 6.3.1.
`DEFAULT_HEADERS` trong [`AquaraMobileClient.ts`](../client/AquaraMobileClient.ts) đã khớp:

```
appid, userid, token, sign, nonce, time, area          ← bắt buộc (sign ký 4 cái đầu + body)
lang:vi, cuty:VN, app-version:6.3.1, phone-model:SM-M115F##Mobile, sys-type:1, sys-version:14
phoneid:<...>, clientid:<FCM token>                     ← per-thiết-bị, truyền qua extraHeaders
user-agent:okhttp/4.12.0, accept-encoding:gzip, content-type:application/json
```

`sign = md5("Appid=..&Nonce=..&Time=..&Token=.." + ("&"+body) + "&" + appKey)` — token rỗng thì
bỏ `&Token=`. GET ký lên query-string thô. (Chi tiết: [`crypto.ts`](../client/crypto.ts).)

---

## 3. Cloud API — commission công tắc ảo vào hub

Vòng đời: cloud cấp **vật liệu fabric** (ICAC cert+key) → matter.js commission local → cloud bind.

| Bước | Endpoint | Ghi chú |
|---|---|---|
| 1 | `GET /user/cert/matter/home/list?positionId=` | trả fabric account: `fabricId`, `ipk`, **ICAC cert + privateKey** (ký NOC local), **RCAC cert**, `rcacId/icacId/subjectKeyId/authorityKeyId`. 3-tier PKI → KHÔNG cần RCAC key. |
| 2 | `GET /user/cert/matter/home/gen-nodeid?positionId=&size=1` | `{nodeIds:["<hex>"]}` |
| 3 | *(local)* matter.js controller | PASE(passcode) → ký NOC bằng ICAC key → addNOC(nodeId,ipk,fabricId,adminVendorId=4447) → CASE → complete. Xem §4. |
| 4 | `POST /matter/dev/signup` | `{gatewayId:<hub DID>, nid:<nodeId DECIMAL>, positionId}` → bind node vào hub |
| 5 | `GET /matter/bind/result?nid=<dec>&positionId=` (poll) | → `{did:"matt.xxx", gatewayId, roomId}` = Aqara DID của switch |

`/matter/remove` = gỡ switch (cloud, đối ứng native `unbindMatter`).
`adminVendorId 4447` = 0x115F = Aqara.

---

## 4. matter.js auto-commission (CA ngoài = ICAC Aqara)

matter.js 0.17 **hỗ trợ NATIVE** đúng mô hình Aqara (3-tier PKI, RCAC key optional). Import từ
**`@matter/protocol` root**: `CertificateAuthority, Rcac, Icac, FabricAuthority` (+ `Crypto,
Environment, ServerNode` từ `@matter/main`).

```
Rcac.fromAsn1(derFromPem(rcacPem)).asSignedTlv()   // X.509 cloud → Matter-TLV
Icac.fromAsn1(...).asSignedTlv()
CertificateAuthority.create(crypto, {              // ConfigurationWithIcac
  rootCertId, rootKeyIdentifier(=RCAC SKI, Bytes), rootCertBytes, nextCertificateId,
  icacCertId, icacKeyPair(từ PEM: jwk d/x/y → priv32B/pub65B 04|x|y), icacKeyIdentifier, icacCertBytes
})  // rootKeyPair OMIT → ICAC ký NOC
env.set(CertificateAuthority, ca)
ServerNode.create({environment: Environment.default})  // có StorageManager (từ @matter/nodejs)
fabricAuthority.defaultFabric({adminVendorId:4447, adminFabricId})
node.peers.commission({longDiscriminator, passcode, discriminator, nodeId, fabric, onAttestationFailure})
```

**Trạng thái:** chạy thật **tới PASE vào fabric Aqara** (CA load đúng cert, fabricId Aqara).
Blocker còn: `ServerNode` (device) gặp `synchronous-transaction-conflict` ở reactor
`CommissioningServer.handleFabricChange` khi thêm fabric của chính controller → read post-PASE
timeout. Hướng fix: controller node không có device-side CommissioningServer / thêm fabric async.

---

## 5. Cloud API — **signal-export 100% tự động** (read path, gồm "AI mở")

Hub xuất tín hiệu khóa ra Matter dưới dạng **occupancy sensor**. Mỗi "tín hiệu" = 1 lock-event
(có thể gắn credential cụ thể → **mỗi vân tay/NFC/người = 1 sensor riêng**).

| Bước | Endpoint | Payload |
|---|---|---|
| catalog | `GET /ifttt/subject/trigger/query?applicationSide=1&subjectId=<lock>` | → `TD.unlock_someone_{fing,nfc,password,indoor,away,emergency,...}` |
| **tạo** | `POST /ifttt/event/set` | `{content:[{subjectId:<lock>, subjectModel, triggerDefinitionId, group, triggerName, params:[{paramId:"PD.lockUID", value:<typeValue credential>, paramName}], state:1, status:1, ...}], name, positionId, enable:"1", relation:0}` → `{eventId:"CL.xxx"}` |
| list | `GET /dev/signals/list/query?positionId=` | → `{data:["CL.xxx",...]}` |
| bridge | `GET /dev/signals/bridge/query?positionId=` | → thiết bị bridge (vd G410) |
| **đẩy ra Matter** | `POST /dev/signals/add` | `{data:{"CL.xxx":"<tên>",...}, positionId}` → đồng bộ toàn bộ |
| gỡ | `POST /dev/signals/delete` | (param chưa chốt) |

`params[].value` = **typeValue credential** (khớp [`getLockCredentials`](#6) — vd vân tay
"Ba-Trỏ phải" = `2147549186`). → Addon: liệt kê credential → tạo 1 signal/credential → sync all.

**Bật Matter bridge trên hub + lấy mã pairing cho HA** (nếu cần re-pair bridge):
- `POST /res/write {data:{"4.200.85":"1"}, subjectId:<hub>}` = mở Matter commissioning window
- `POST /res/query/by/resourceId {options:["4.200.700"], subjectId:<hub>}` → `{onboarding_payload(QR MT:...), manual_pairing_code}`
- `["13.201.700"]` = list fabric đã kết nối · `["13.202.85"]` = trạng thái window

---

## 6. Cloud API — đọc trạng thái + AI mở (cloud, fallback/bổ sung)

| Endpoint | Trả về |
|---|---|
| `POST /res/query {data:[{options:[attrs], subjectId:<lock>}]}` | `lock_state, arm_state, batt_0_remain_percentage, low_battery_power, device_offline_status, enable_remote_operation, lockout_event, user_guide` |
| `GET /dev/lock/query?deviceId=<lock>&types=[1,2,3,4,5,6,7]` | user/credential (vân tay/mật khẩu/NFC/face) + `typeValue` |
| `POST /app/lock/res/history/query {attrs:["lock_local_log"], subjectId, startTime, endTime, size, startIndex}` | event-log = **AI mở cửa** (value mã hoá, decode who+how) |

> Lưu ý: "ai mở" qua **Matter bridge** chỉ được nếu tạo signal per-credential (§5). Event-log cloud
> luôn là nguồn đầy đủ nhất (who + how + timestamp).

---

## 7. Cloud API — automation mở khóa (unlock path)

Addon PULSE công tắc ảo → automation hub mở khóa local.

| Endpoint | Payload |
|---|---|
| `POST /ifttt/linkage/pro/wit/set` | tạo automation (model `app.ifttt.v2`, chạy local): whenConfig = công-tắc-ảo `OnOff changeTo On` (`TD.2.132.32920.1-4-1-0-OnOff_changeTo_On`, endpointId "2"); thenConfig = `AD.unlock` trên lock DID, `rids:["4.17.85"]` |
| `GET /app/position/linkage/query?positionId=` | list automation (`ifttts[].linkageId`) |
| `GET /ifttt/linkage/pro/wit/detail?linkageId=` | chi tiết |
| `POST /ifttt/batch/delete {linkageIds:[...]}` | xoá |

Discovery: `GET /app/position/query/home/list` → homes; `GET /app/position/device/query?positionId=`
→ devices (field `parentDeviceId` = quan hệ khóa→hub). Account có thể **nhiều home** → chọn home
CHỨA khóa (đừng dùng homes[0]).

---

## 8. Kỹ thuật MITM app Aqara (RE reference)

App pin cert OkHttp ở **BoringSSL native** → CA vô dụng cho API native. Bypass:
- **API native (OkHttp):** frida **native** unpin (`mitm/ssl_unpin_native.js`, hook
  `SSL_*_set_custom_verify` ở `libjavacrypto.so`+`libssl.so`), **spawn** app (né SecNeo lớp Java).
  Route USB: `adb reverse tcp:8080` + proxy `127.0.0.1:8080` + `mitmdump`.
- **WebView (Chromium):** frida KHÔNG phủ BoringSSL tĩnh của Chromium + Shamiko cô lập namespace.
  CÁCH (đã chạy): mount CA mitmproxy vào cert store CỦA APP **sau khi app start** (Shamiko đã
  cleanup lúc fork nên mount thêm sống):
  ```
  nsenter --mount=/proc/$PID/ns/mnt -- mount -o bind /data/local/tmp/cacerts-copy \
          /apex/com.android.conscrypt/cacerts        # cho MỌI process app
  ```
  ⚠️ toybox `nsenter` KHÔNG nhận `-t pid`, PHẢI `--mount=/proc/PID/ns/mnt`. Chromium coi đây là
  locally-added root → không enforce CT → trust mitmproxy → reload trang web → bắt được.
  `cacerts-copy` = copy 135 system certs + `<hash>.0` (mitmproxy CA, hash `openssl x509 -subject_hash_old`).

---

## 9. Module reference (`client/aqaraMatter.ts`)

```ts
const m = new AqaraMatterCloud(new AquaraMobileClient({ area, token, userId, extraHeaders }));
// commission
await m.getFabric(homePid); await m.genNodeId(homePid);
await m.signup(gatewayId, nodeIdHex, homePid); await m.waitBind(nodeIdHex, homePid);
// automation
await m.createUnlockAutomation({ homePositionId, name, switchDid, switchVendorIdDec, switchProductIdDec, switchRoomPositionId, lockDid, lockRoomPositionId });
await m.listLinkages(pid); await m.deleteLinkages(ids);
// signal-export (read, gồm ai mở)
await m.getLockTriggerEvents(lockDid); await m.createSignal({...}); // → CL.xxx
await m.listSignals(pid); await m.getSignalBridge(pid);
await m.syncSignalsToMatter({ "CL.xxx": "tên", ... }, pid);
await m.openMatterBridge(hubDid); // → {onboardingPayload, manualPairingCode}
// đọc trạng thái cloud
await m.getLockSignals(lockDid); await m.getLockCredentials(lockDid); await m.getLockHistory(lockDid);
```

## 10. Trạng thái

| Phần | Trạng thái |
|---|---|
| Cloud commission / automation CRUD / signal-export / read | ✅ endpoint + payload bắt thật, phần lớn validate live |
| Công tắc ảo Matter (device) | ✅ commission thật vào M100, hub nhận OnOff |
| Auto-commission matter.js (controller) | 🔶 tới PASE vào fabric Aqara, kẹt reactor (§4) |
| Đóng gói Docker addon + MQTT discovery | ⏳ |
