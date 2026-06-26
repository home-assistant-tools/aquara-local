# Aqara D100 ↔ Home Assistant — Tổng kết addon

Điều khiển + đọc khoá **Aqara D100** từ Home Assistant **thuần phần mềm**, KHÔNG đụng BLE/Zigbee, KHÔNG root.
Repo public: **github.com/home-assistant-tools/aquara-local**. Addon LIVE: **http://192.168.2.4:7654**.

> Cập nhật: **2026-06-26**. Hầu hết đã chạy; còn 1 việc treo: "ai mở" (per-người) qua đường LOCAL — xem §8.

---

## 1. Kiến trúc CHỐT

D100 = Zigbee+BLE+HomeKey, **không nói Matter trực tiếp**. Có **2 đường tới HA, dùng SONG SONG**:

**(A) Addon "đèn-bridge" (control + state + away) — LOCAL + cloud fallback:**
1. Addon login Aqara (cloud, thuần JS) → scan hub Matter M100 + khoá bound.
2. Tạo **1 đèn ảo Matter dimmable** (matter.js) → commission vào fabric Aqara của hub.
3. Hub chạy **automation LOCAL**: `đèn ON → mở D100`; và `mỗi sự kiện khoá → SetBrightness(mức cố định)`.
4. Addon đọc `currentLevel` đèn (Matter, realtime LOCAL) → decode mức → trạng thái/sự kiện → **MQTT Discovery → HA**.
5. Mở khoá: HA → addon pulse đèn ON (local) **+** cloud `/matter/write` (song song, 2 đường).

**(B) Doorbell G410 bridge native (events per-người/hướng):** G410 (Matter node 49) tự bridge D100 sang HA
qua Matter → mỗi credential/hướng = 1 `binary_sensor` "có người". Chính xác nhưng **gần đây fire chập chờn**.
Xem memory `g410-bridges-d100-native-matter`.

→ Addon (A) lo **control + trạng thái khoá + chế độ vắng + chạy offline**. G410 (B) lo **events per-người** (khi nó fire).

---

## 2. Code addon (`addon/app/lib/`)

| File | Vai trò |
|---|---|
| `bootstrap.server.ts` | Headless 2 pha: **A=LOCAL** (từ cache /data, không cần net: đèn-bridge + MQTT) ; **B=CLOUD** nền (login → reconcile automation + refresh token 6h, retry khi mất mạng). `cleanStaleLocks()` dọn `matter.lock` cũ lúc boot (tránh "Storage is locked" do trùng pid). Reconcile chạy **mỗi login/reload**. |
| `lightBridge.server.ts` | matter.js ServerNode (đèn ảo) + commission vào hub (`commissionLight`). `EVENT_LEVELS` (map TD khoá → mức sáng). Keep-alive worker (tránh RuntimeService tự shutdown). `Logger.level=WARN` (tắt DEBUG spam). Decode: `decodeLevel`, `lockStateFromLevel`, `unlockDirectionFromLevel`, `awayModeFromLevel`. |
| `matterSetup.server.ts` | **RECONCILER 2 pha**: build TOÀN BỘ automation mong muốn → so với `[addon]` đang có → LỆCH thì xoá sạch + tạo lại đúng bộ, KHỚP thì bỏ qua. Diệt bug "scheme cũ chồng mới". Per-credential (mức 60+) `PD.lockUID=typeValue` + `delaySeconds:2` (xem §8). |
| `mqtt.server.ts` | MQTT Discovery → HA: **lock** (control), **battery**, **"Sự kiện gần nhất"** (enum, gồm generic "Mở từ bên ngoài"), **switch "Chế độ vắng nhà"**. Unlock 2 đường. Event **non-retain** (tránh reconnect bắn oan). Lock-state: realtime bridge + cloud authoritative + recheck [4,9,16,28,45]s sau mở (bắt auto-lock). Tổng hợp "Đã khóa" từ chuyển→LOCKED. |
| `runtime.server.ts` | online/offline holder + cache bridge-config (/data) cho offline. |
| `aqara.server.ts` | login + `cloudFor` + `lockView` + `decodeLog` (⚠️ decodeLog CŨ map SAI — xem §8). |

`client/aqaraMatter.ts` = cloud client (đã reverse, ký sign). `client/commissionLight.ts` = commission matter.js.

---

## 3. Cloud API (reverse, chạy thật) — bảng chính

Mọi request qua `client/AquaraMobileClient.ts` (tự ký `sign/token/nonce/time`). Hàm trong `client/aqaraMatter.ts`.

| Việc | Endpoint | Hàm |
|---|---|---|
| Login email/pw (thuần JS) | — | `loginWithPasswordPlain` |
| Scan hub/khoá | `/app/position/...` + `/res/query/by/resourceId`(13.202.85) | `discoverMatterHubs`, `discoverLocks`, `locksBoundToHub` |
| Fabric Matter | `/user/cert/matter/home/list` (+`gen-nodeid`) | `getFabric`, `genNodeId` |
| Bind node→hub | `/matter/dev/signup` + `/matter/bind/result` | `signup`, `waitBind` |
| Tạo/Xoá automation | `/ifttt/linkage/pro/wit/set` · `/ifttt/batch/delete` | `createAutomation` (có `action.delaySeconds`), `deleteLinkages` |
| List automation | `/app/position/linkage/query` | `listLinkages` |
| Trigger/Action catalog | `/ifttt/subject/{trigger,action}/query` | `getDeviceTriggers`, `getDeviceActions` |
| Đọc trạng thái | `/res/query` (lock_state, pin, arm_state…) | `getLockSignals` |
| **Chế độ vắng nhà** | `/res/query/by/resourceId` + `/res/write` resource **`13.54.85`** (1=bật/0=tắt) | `getAwayMode`, `setAwayMode` |
| Nhật ký "ai mở" | `/app/lock/res/history/query` (`lock_local_log`) | `getLockHistory` (decode §8) |
| Credential | `/dev/lock/query?types=[1..7]` | `getLockCredentials` (typeValue=0x8001xxxx) |
| Mở/khoá cloud | `/matter/write` (unlock 2.148.35011, lock 35010) | `remoteUnlock`, `remoteLock` |

---

## 4. Commission đèn vào hub — ĐÃ THÔNG (mắt xích khó nhất)

`client/commissionLight.ts` (matter.js `CommissioningController` shared-fabric). **M100 adopt được** nhờ override `ca.generateNoc`:
1. **NOC issuer DN = subject của ICAC Aqara** (gồm `fabricId`, không chỉ `icacId`) — nếu chỉ icacId thì M100 reject CASE `InvalidParam`.
2. **`caseAdminSubject` = nodeId của M100** (env `HUB_NODE_ID_HEX=141D68A8EA6CF000`) — để HUB có quyền adopt (không phải controller).
3. NOC `notBefore = now` (không lùi 1 năm).
- **BUN phá crypto**: matter.js dùng AES-CCM, Bun thiếu `aes-128-ccm` → **bắt buộc Node** (addon đã Node). Script test local dùng `bun` thì OK cho cloud (HTTP) nhưng KHÔNG cho commission.
- mDNS: env `MATTER_MDNS_NETWORKINTERFACE=eno1`. Storage: `LIGHT_STORAGE_ROOT=/data/aqara-light-bridges`, volume `./data:/data` (persist commission).

---

## 5. EVENT_LEVELS (map sự kiện khoá → mức sáng)

Tĩnh: 5=Đã khóa(`ch31_value1`), 11=Mở từ trong(`unlock_someone_indoor`), 12=Mở trong chế độ vắng(`ch49_value1`),
13=nút khẩn cấp, 20-22=mật khẩu1lần/chìa khẩn/chìa vắng, 30-33=chuông/cửa hở/can thiệp/sai nhiều, 40-41=bật/tắt vắng nhà(`ch54`),
50-51=bật/tắt khóa trẻ em(`switch20`). **Per-credential 60+**: `unlock_someone_{fing,password,nfc}` + `PD.lockUID=typeValue` → "Vân tay — <tên>".

---

## 6. Trạng thái khoá — REALTIME LOCAL (OK)

- **Mở cửa vật lý → khóa lại**: realtime 2 chiều qua automation (`unlock_someone_*` + `ch31_value1` "Đã khóa" → mức 5 → state). Verify thật: mở→UNLOCKED tức thì, khóa→LOCKED ~4-9s.
- **Mở REMOTE (nút HA, không mở cửa)**: D100 tự khóa **IM LẶNG** (không bắn `ch31_value1`) → fallback **cloud poll recheck** [4,9,16,28,45]s sau mở → về LOCKED ~4-45s.
- Cloud `lock_state` = nguồn ĐÚNG (4/2=khóa, 1/3=mở); bridge realtime khi có.

---

## 7. Chế độ Vắng nhà (away mode) — XONG

Resource `13.54.85` (1=bật/0=tắt). Switch HA "Chế độ vắng nhà" → `setAwayMode` (`/res/write`, cần cloud). State đồng bộ: realtime bridge (`ch54` mức 40/41) + cloud poll. **Lưu ý**: bật away → D100 báo unlock kiểu `ch49` (chế độ vắng) thay vì per-người.

---

## 8. ⏳ TREO: "ai mở" (per-người) đường LOCAL

**Vấn đề:** mở vân tay Ba → D100 fire NHIỀU trigger gần đồng thời (`unlock_someone_fing[Ba]`→mức 60 **+** `ch49`→mức 12 + ch18…). Kênh mức-sáng 1 giá-trị → **ch49 đè mức 60** (last-wins; Matter subscription chỉ báo giá trị cuối) → addon hiện "Mở từ bên trong (chế độ vắng)" SAI. (Lạ: `ch49` fire cả khi mở-vân-tay-từ-NGOÀI dù away off.)

**Đang thử (ĐÃ DEPLOY, CHƯA VERIFY):** delay 2s trên automation per-người (`action.delaySeconds:2` → `delayTime:"2", delayTimeUnit:"1"`) để set mức 60 **SAU** ch49 → thắng. **CẦN user mở vân tay Ba từ ngoài** → xem "Sự kiện gần nhất":
- Ra "Vân tay — Ba" → THÀNH CÔNG (commit code delay).
- Vẫn "Mở từ bên trong (chế độ vắng)" → delay chưa ăn → kiểm `delayTimeUnit` (1=giây? hay phút?) hoặc `unlock_someone_fing` KHÔNG fire.
- Cách test unit: watch `aqara_d100/<uid>/event` qua `docker exec ix-mosquitto-mosquitto-1 mosquitto_sub` lúc mở.

**Nguồn CHÍNH XÁC nhất (nhưng CLOUD):** cloud `lock_local_log` đã CRACK decode (xem memory `d100-cloud-log-who-unlocked`):
`0b 0009 [method:1B] [typeValue:4B LE]` → method **`0x20`=vân tay**, `bytes[4..7]` little-endian = typeValue → tên (verify "Ba" `0x80010002`). `0x07`=Auto-Lock. **decodeLog CŨ trong `aqara.server.ts` map SAI** (tưởng byte0 là method) — cần sửa nếu chuyển sang nguồn cloud-log. User muốn LOCAL nên đây chỉ là fallback khi online.

---

## 9. Hạ tầng deploy

- Host TrueNAS `192.168.2.4`: `ssh -i ~/.ssh/id_rsa truenas_admin@…` (sudo passwordless). Stack Dockge `/mnt/d2/dockge/data/aqara-matter/` (build từ `./src`, port 7654).
- **Build phải qua `systemd-run`** (box thiếu `setsid`; `sudo …&` bị SIGKILL; `/tmp` noexec):
  `sudo systemd-run --unit=aqara-build --collect bash -c 'cd …/aqara-matter && docker compose build; docker compose up -d > /tmp/aqara-build.log 2>&1'` → poll log. Cold-start node D-state ~1-2 phút (đọc bundle từ HDD d2). `mosquitto_sub/pub` chỉ có trong container `ix-mosquitto-mosquitto-1`.
- Redeploy từ dev: rsync `addon/` + `client/` → `…/src/`, rồi systemd-run build. Reconcile tự chạy lúc boot.
- Box d2 = 1 HDD đơn (đã tinh chỉnh `sync=disabled` docker+frigate-cache, `primarycache=metadata` video → iowait 69%→3%). Xem memory `deploy-truenas-box`.
- Secret KHÔNG commit (repo public): `router-backup/`, `mac-media-agent/config.json` (đã gitignore). Creds Aqara trong `stack.env` trên box.

---

## 10. Tóm tắt trạng thái

| Hạng mục | Trạng thái |
|---|---|
| Cloud API (login/scan/fabric/automation/đọc khoá/mở-khoá/away) | ✅ verify live |
| Commission đèn vào hub + M100 adopt | ✅ (NOC issuer=ICAC subject + caseAdminSubject=hub) |
| Đèn-bridge + MQTT Discovery → HA (lock/pin/event/switch away) | ✅ LIVE |
| Trạng thái khoá realtime (mở/khóa vật lý) + recheck (remote) | ✅ |
| Reconciler automation (mỗi restart tự đúng) | ✅ |
| Switch Chế độ Vắng nhà | ✅ |
| Offline-resilient (mất mạng vẫn chạy LOCAL) | ✅ |
| Native G410 per-người/hướng (binary_sensor) | ✅ có, nhưng fire chập chờn |
| **"Ai mở" (Vân tay — Ba) đường LOCAL** | ⏳ **delay 2s deployed, CHỜ verify** (§8) |
| Cloud-log decode "ai mở" | ✅ đã crack (fallback online) |
