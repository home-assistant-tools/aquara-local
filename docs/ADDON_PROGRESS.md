# Aqara D100 ↔ Home Assistant qua Matter — Tổng kết addon

Tài liệu này ghi lại **những gì addon đã làm được**, kiến trúc, các phát hiện kỹ thuật quan trọng,
và phần còn dở. Mục tiêu: điều khiển + đọc trạng thái khoá cửa **Aqara D100** từ Home Assistant
**thuần phần mềm qua Matter** — KHÔNG can thiệp BLE/Zigbee, KHÔNG cần root thiết bị.

> Cập nhật: 2026-06-18. Bản addon đang chạy LIVE tại **http://192.168.2.4:7654**.

---

## 1. Mục tiêu & bối cảnh

D100 là khoá Zigbee + BLE + HomeKey, **không hỗ trợ Matter trực tiếp**. Hub Aqara M100 thì
**làm được Matter controller** (commission thiết bị Matter ngoài) và Matter bridge. Ý tưởng:

1. Người dùng đăng nhập tài khoản Aqara trong addon.
2. Addon quét hub Matter + khoá đã bind với hub.
3. Addon tạo **thiết bị ảo Matter** (công tắc/đèn) commission vào hub Aqara.
4. Tạo **automation local trên hub**: thiết bị ảo đổi trạng thái → mở/đọc khoá.
5. Home Assistant đọc thiết bị ảo (qua Matter) → biết trạng thái khoá realtime; điều khiển mở khoá.

Toàn bộ giao tiếp đi qua **cloud API riêng của Aqara** (đã ký sign) + **matter.js** (commission local).

---

## 2. Hai kiến trúc đã thử

### 2.1 Signal-export (bản đầu — đã loại)
Aqara cho "xuất tín hiệu" khoá thành **occupancy sensor** Matter. Mỗi sự kiện/credential = 1 sensor.
- ✅ Đọc được "ai mở cửa" (mỗi vân tay/NFC/người = 1 sensor riêng).
- ❌ **Trần cứng 15 tín hiệu** (`code=1246` khi sync >15), rác, occupancy sensor không mang user-identity gọn.
→ **Bỏ.**

### 2.2 Đèn dimmable làm "bridge" (hướng chốt)
Dùng **1 đèn ảo Matter dimmable** duy nhất. **Mỗi mức độ sáng (1–254) = 1 trạng thái/sự kiện khoá.**
- Hub Aqara commission đèn → tạo automation: "sự kiện khoá X → đặt đèn = mức N".
- HA đọc `currentLevel` của đèn → decode ra trạng thái. Mở khoá: HA đặt đèn = 99% → automation mở D100.
- Ưu: **1 thiết bị Matter, hết rác, sức chứa ~254 mã >> 15**.
→ Hướng đang theo. Phần automation + commission đã chứng minh chạy; còn vài bước tích hợp (mục 6).

---

## 3. Cloud API đã reverse-engineer (chạy thật)

Tất cả bắt sống qua MITM (frida unpin + CA-mount WebView) rồi encode lại trong
[`client/aqaraMatter.ts`](../client/aqaraMatter.ts). Mọi request đi qua
[`client/AquaraMobileClient.ts`](../client/AquaraMobileClient.ts) (tự ký `sign`/`token`/`nonce`/`time`,
header khớp app 6.3.1). **Không đụng BLE/Zigbee.**

| Nhóm | Endpoint | Hàm | Trạng thái |
|---|---|---|---|
| **Đăng nhập** | login email/password (thuần JS, không cần `.so`) | `loginWithPasswordPlain` | ✅ verify live |
| **Scan hub** | `/app/position/query/home/list` + `/app/position/device/query` + `/res/query/by/resourceId`(13.202.85) | `discoverMatterHubs`, `scanAllDevices` | ✅ |
| **Scan khoá** | (lọc model `.lock.`) + `parentDeviceId` | `discoverLocks`, `locksBoundToHub` | ✅ |
| **Fabric Matter** | `/user/cert/matter/home/list` → RCAC+ICAC cert+key, IPK, fabricId | `getFabric` | ✅ |
| **Cấp nodeId** | `/user/cert/matter/home/gen-nodeid` | `genNodeId` | ✅ |
| **Bind node→hub** | `/matter/dev/signup` + `/matter/bind/result` (poll) | `signup`, `waitBind` | ✅ (chờ hub adopt, mục 6) |
| **Gỡ Matter device** | `/matter/remove {did,fullValue:true}` | `removeMatterDevice` | ✅ |
| **Tạo automation** | `/ifttt/linkage/pro/wit/set` (chạy LOCAL trên hub) | `createUnlockAutomation`, `createAutomation` | ✅ test live (tạo 400 cái OK) |
| **Catalog trigger** | `/ifttt/subject/trigger/query` | `getLockTriggerEvents` | ✅ |
| **Catalog action (+param)** | `/ifttt/subject/action/query` | `getDeviceActions` | ✅ — xác nhận action truyền được **giá trị số** |
| **List/Delete automation** | `/app/position/linkage/query` (phân trang), `/ifttt/batch/delete` | `listLinkages`, `deleteLinkages` | ✅ |
| **Đọc trạng thái khoá** | `/res/query` (lock_state, pin, arm, offline…) | `getLockSignals` | ✅ |
| **Đọc "ai mở cửa"** | `/app/lock/res/history/query` (lock_local_log mã hoá) | `getLockHistory` | ✅ |
| **Credential** | `/dev/lock/query?types=[1..7]` | `getLockCredentials` | ✅ |
| **Mở/khoá cloud** | `/matter/write` (unlock 2.148.35011, lock 35010) | `remoteUnlock`, `remoteLock` | ✅ verify 3/3 |

**Phát hiện về automation:** không có trần thực tế — đã tạo **400 automation** liên tục, server nhận hết
(test trong [`tools/test_automation_limit.ts`](../tools/test_automation_limit.ts)); cần ~15–40 cho hướng đèn → thừa.
Action **truyền được giá trị số** (vd camera `AD.customize_music` param `PD.vol` 0–100) → đủ cơ chế "đặt độ sáng=N".

---

## 4. Addon (Remix v2) — ĐÃ DEPLOY & CHẠY

[`addon/`](../addon) là web app **Remix v2** (Vite) + **SSE realtime**, build bằng `node:20` (`remix-serve`).

- **Màn hình:** `login.tsx` (email/password/region) → `_index.tsx` (dashboard: trạng thái khoá, pin, "ai mở gần đây", nút mở/khoá, thẻ Matter).
- **Realtime:** `sse.events.ts` (SSE qua `remix-utils`) + `monitor.server.ts` (poll cloud state 30s / events 12s).
- **Token:** lưu cookie phiên httpOnly (`session.server.ts`), tự sinh từ email/password — không cần token thủ công.
- **Điều khiển:** `api.lock.tsx` (mở/khoá cloud), `api.matter-setup.tsx` (tự setup Matter khi mở dashboard).

**Trạng thái:** ✅ Đã đóng gói Docker, **deploy lên TrueNAS `192.168.2.4` (Dockge stack `aqara-matter`),
chạy LIVE tại `http://192.168.2.4:7654`** — trang login render OK, đăng nhập ra trạng thái khoá thật.
(Hiện UI đọc trạng thái qua **cloud**; bản light-bridge sẽ đọc qua độ sáng đèn — mục 6.)

---

## 5. Auto-commission đèn vào fabric Aqara — ĐÃ THÔNG (Node)

Đây là mắt xích khó nhất: cho addon tự commission thiết bị ảo vào hub **không cần thao tác app**.
Code: [`client/commissionLight.ts`](../client/commissionLight.ts) (dựa trên `CommissioningController`
shared-fabric của matter.js).

**Luồng:** `getFabric` → `genNodeId` ×2 → dựng `CertificateAuthority`(ICAC ngoài) + `FabricBuilder`(rootFabric Aqara)
→ `commissionNode` (PASE → attestation → CASE → `commissioningComplete`).

✅ **Đã chạy thật trên box Linux: `commissioningComplete errorCode:0`** — đèn matter.js vào đúng
fabric Aqara `1440724929092173824` (compressed-id `CF230A0E9631FC65`).

### Hai phát hiện then chốt
1. **BUN phá crypto Matter.** matter.js dùng **AES-CCM**; Bun (1.2/1.3/latest) **không có `aes-128-ccm`**
   trong `node:crypto`, nhánh JS `Ccm.js` thì sai MIC → mọi gói secured sau PASE `invalid signature`.
   `MATTER_NODEJS_CRYPTO=0` **không cứu** (đã test). → **matter.js bắt buộc chạy Node.js, KHÔNG Bun.**
   (Addon vốn đã Node nên không ảnh hưởng — chỉ các script test local dùng `bun` mới dính.)
2. **Attestation:** đèn là test-vendor `0xFFF1` → phải `onAttestationFailure: () => true` (return **true** mới qua).

### Thư viện Matter
Toàn bộ là **matter.js** (`matter-js/matter.js`), bản `0.17.1`:
`@matter/main` (device/ServerNode/clusters), `@matter/nodejs` (shim Node: storage/crypto/mDNS),
`@project-chip/matter.js` (meta — cấp `CommissioningController`).

---

## 6. Phần còn dở (blocker hiện tại)

### 6.1 M100 chưa "adopt" node (đang xử)
Đèn đã vào fabric (`commissioningComplete:0`) nhưng `/matter/bind/result` timeout — **M100 không adopt**.
Chẩn đoán: M100 **không hề kết nối tới đèn** (log đèn chỉ có session từ commissioner). Nguyên nhân =
**`caseAdminSubject`**: matter.js `addNoc` đặt admin = `fabric.rootNodeId` (controller của mình), còn app
điện thoại đặt admin = **hub** → hub mới có quyền adopt. (addNOC là gói Matter LOCAL nên không có trong MITM.)
- Hướng fix (auto 100%): sau commission, controller (đang là admin) **ghi ACL device thêm quyền admin cho M100**,
  hoặc set `caseAdminSubject` = nodeId M100. (`ControllerCommissioningFlow.js` hardcode `caseAdminSubject: this.fabric.rootNodeId`.)
- Đường lùi: quét QR app **1 lần** cho riêng bước adopt (app set admin đúng) → phần còn lại tự động.

### 6.2 mDNS interface (đã có cách)
Container `--network host` trên TrueNAS quảng bá nhầm IP docker/incus (172.16.x). **Đã sửa bằng macvlan**
(`docker network create -d macvlan --subnet 192.168.2.0/24 --gateway 192.168.2.1 -o parent eno1 matnet`)
→ đèn có IP LAN thật `192.168.2.220`.

### 6.3 Step 5–7 light-bridge (chưa build)
- Automation `đèn 99% → mở khoá D100` + mỗi sự kiện khoá → `setLevel(k)` (builder `createAutomation` đã sẵn).
- Verify catalog đèn sau khi commissioned: action MoveToLevel + trigger "brightness reaches 99%".
- UI addon: đọc độ sáng đèn → decode trạng thái realtime; pin từ cloud; mở khoá local.
- Đổi `virtual_dimmable_matter` + matter.js trong addon chạy **Node**.

---

## 7. Hạ tầng deploy

- **Host:** TrueNAS SCALE `192.168.2.4` (Docker; chạy HA `:8123`, `ix-matter-server`, zigbee2mqtt, Dockge…).
- **Truy cập:** `ssh -i ~/.ssh/id_rsa truenas_admin@192.168.2.4` (key đã authorize) + **sudo passwordless** docker.
- **Dockge stacks:** `/mnt/d2/dockge/data/` — stack addon = `aqara-matter/` (compose build từ `./src`, port 7654).

**Redeploy (từ máy dev, repo root):**
```bash
rsync -az --delete --exclude=node_modules --exclude=build --exclude='*.mitm' \
  -e "ssh -i ~/.ssh/id_rsa" client addon \
  truenas_admin@192.168.2.4:/mnt/d2/dockge/data/aqara-matter/src/
ssh -i ~/.ssh/id_rsa truenas_admin@192.168.2.4 \
  'cd /mnt/d2/dockge/data/aqara-matter && sudo docker compose up -d --build'
```

---

## 8. Tóm tắt trạng thái

| Hạng mục | Trạng thái |
|---|---|
| Reverse cloud API (login, scan, fabric, automation, đọc khoá, mở/khoá) | ✅ Xong, verify live |
| Addon Remix (login + dashboard + SSE + mở khoá cloud) | ✅ Deploy LIVE `192.168.2.4:7654` |
| Auto-commission đèn vào fabric Aqara | ✅ `commissioningComplete:0` (Node) |
| Bun crypto / matter.js runtime | ✅ Chốt: dùng Node |
| mDNS / macvlan | ✅ Có cách (IP LAN thật) |
| M100 adopt node (caseAdminSubject) | 🔶 Đang mò (auto 100%) |
| Light-bridge step 5–7 (automation + UI brightness) | ⏳ Chưa build |
| Đường lùi mở khoá cloud-first (HACS cũ) | ✅ Có sẵn, hoạt động |
