# Aqara D100 — API Documentation (Cloud + BLE)

Complete technical documentation for controlling the **Aqara D100 (dp1a / aqara.lock.aqgl01)** lock without the original app.
Everything has been **reverse-engineered + verified for real** (tested on a real lock, firmware ack `00`). For use with devices **owned by the owner themselves** — legal interoperability; do NOT redistribute the Aqara APK/keys.

- Reference app: `app/` (React Native + Expo). TS client: `client/`. Verification tools: `tools/`.
- Original findings (reverse-engineering log): `captures/mitm/FINDINGS.md`.

---

## Part 1 — CLOUD API

### 1.1 Base + transport
- Base URL by `area`: `SEA → https://rpc-au.aqara.com`, `CN → rpc.aqara.cn`, `US → rpc-us.aqara.com`, `EU → rpc-ger.aqara.com`.
- Prefix: `/app/v1.0/lumi`. HTTP/2 (OkHttp). JSON body `content-type: application/json; charset=utf-8`.
- **Important:** the cloud is a **mirror**. Write commands for credentials/validity via the cloud are **NOT enforced on the lock** — they must be pushed over BLE (Part 2). The cloud is only for **reading** + syncing the display.

### 1.2 Auth header (per request)
```
appid   = <APPID — see const.py>        (fixed for app v6.1.6)
userid  = <session userId>
token   = <session token>                  (empty on login)
nonce   = <32 hex random per request>
time    = <epoch ms>
area    = SEA | CN | US | EU
sign    = MD5(...)                          (see 1.3)
lang app-version phone-model sys-type sys-version
```

### 1.3 `sign` algorithm  (`tools/aqara_sign.py`, `app/src/protocol/sign.ts`)
```
pre = "Appid={appid}&Nonce={nonce}&Time={time}"
    + ("&Token={token}"  if token is NOT empty)     ← if token is empty, OMIT this segment ENTIRELY
    + ("&{body}"         if there is a body)
    + "&{appKey}"
sign = md5(pre).hexdigest()                        (32 hex, lowercase)
```
- `appKey = <APPKEY — see const.py>` (constant SECRET, leaked via native hook `getSignHead`).
- **POST**: `body` = the JSON string sent (compact). **GET**: `body` = the **RAW query string** (values NOT yet url-encoded; encode only when sending). Signing an empty query → server returns `code 106 Invalid sign`.

### 1.4 Email/password login — PURE JS, no `.so` needed
`POST /user/guard-code/login` — send **PLAIN JSON** (the server does NOT require `x-aes128gcm`).
```jsonc
{ "account": "<email>", "district": "VN", "encryptType": 2, "guardCode": "", "password": "<b64>" }
```
- `password = base64( RSA/ECB/PKCS1Padding( ascii of MD5(password) , pubkey ) )`.
  - RSA input = **MD5(password) as hex-ascii** (NOT the raw password).
  - pubkey = constant RSA-1024, e=65537, n = `0x86e3ab25…d077107` (extracted from `getCert()`, full value in `app/src/cloud/login.ts`).
- sign: empty token (omit `&Token=`), sign over the PLAINTEXT body.
- `guardCode:""` ⇒ no OTP needed.
- Response (plain JSON): `{ result: { token, userId, userInfo } }`.

### 1.5 Cloud endpoints (complete)

| Purpose | Method · Path | Body / Query | Returns |
|---|---|---|---|
| **Login** | POST `/user/guard-code/login` | see 1.4 | `{result:{token,userId,userInfo}}` |
| **List home** | GET `/app/position/query/home/list` | `needDefaultRoom=false&size=300&startIndex=0` | `{homes:[{homeId,homeName,...}]}` |
| **List devices** | GET `/app/position/device/query` | `positionId=<homeId>&size=300&startIndex=0` | `{devices:[{did,model,deviceName}]}` (filter `model =~ /lock|aqgl|dp1a/`) |
| **Device detail** | GET `/app/dev/query/detail` | `area=SEA&dids=["<did>"]` | `{deviceName,mac,...}` |
| **List credentials** | GET `/dev/lock/query` | `deviceId=<did>&types=[1,2,3,4,5,6,7]` | `[{typeGroupId,typeGroupName,typeGroup,typeName,typeValue,type,userCode,validRange?}]` |
| **List users (groups)** | GET `/dev/lock/user/group/info` | `did=<did>` | `[{typeGroupId,typeGroupName,typeGroup}]` |
| **Resource (battery/state)** | POST `/res/query` | `{data:[{options:["batt_0_remain_percentage","lock_state","arm_state","device_offline_status"],subjectId}]}` | `[{attr,value,timeStamp,subjectId}]` |
| **Unlock history** | POST `/app/lock/res/history/query` | `{attrs:["lock_local_log"],startTime,endTime,startIndex:"0",size:"100",subjectId}` | `{count,resultList:[{timeStamp,value,source}]}` |
| **Rename / credential validity** | POST `/dev/lock/update/name` | `{deviceId,typeValue,typeName,typeGroupId,type,validRange?}` | `{code:0}` |
| **Add credential (metadata)** | POST `/dev/lock/user/add` | `{did,lockInfo:[{typeGroupId,typeName,typeLevel,validRange,typeValue,type,userCode}]}` | `{code:0}` |
| **Delete credential** | POST `/dev/lock/user/del` | `{did,typeInfo:[{type,typeValues:[<typeValue>]}]}` | `{code:0}` |
| **Create user (group)** | POST `/dev/lock/user/group/add` | `{did,typeGroup,typeGroupId,typeGroupName}` | `{code:0}` |
| **Delete user (group)** | POST `/dev/lock/user/group/del` | `{did,typeGroupIds:["<id>"]}` | `{code:0}` |
| **Rename user** | POST `/dev/lock/user/group/update` | `{did,typeGroupId,typeGroupName,typeGroup}` | `{code:0}` |
| **Handshake publickey** | POST `/dev/bluetooth/login/assure/publickey` | `{deviceId}` | `{cloudPublicKey(65B "04"+P256),mac}` |
| **Handshake verify** | POST `/dev/bluetooth/login/assure/verify` | `{deviceId,devicePublicKey}` | `{sessionKey(16B),nonce(13B),verifyData(8B),mac}` |

Errors: `code !== 0` (e.g. `106 Invalid sign`, `810 wrong password`, `818 account locked`).

### 1.6 Shared enums & encoding
- **type** (credential type): `1`=fingerprint · `2`=password · `3`=NFC · `4`=eKey/BLE · `5`=temporary password · `6`=face · `7`=NFC tag.
- **typeGroup** (user type): `4`=admin · `2`=normal · `3`=scheduled.
- **typeValue** = base(type) + userId:  `pwd 0x80020000`, `fingerprint 0x80010000`, `NFC 0x80050000`, `face 0x80070000`. ⇒ `userId = typeValue & 0xFFFF`.
- **validRange** (19 bytes hex):
  ```
  [0:2] userId (LE)   [2] repeatType(01=daily)   [3:7] startUTC (LE, time-of-day day window)
  [7:11] endUTC (LE)   [11:15] deadline (ffffffff = permanent, or unix LE)   [15:19] 00000000
  ```
  - **Disable** = set `deadline` to the PAST. **Activate** = `deadline` = `ffffffff`.

---

## Part 2 — BLE (down to firmware)

### 2.1 GATT
- The lock advertises the name **`DP1A`** (Xiaomi MIoT BLE).
- Command service `f2042ffd-87c6-7c9d-1e5b-332360ff0000`:
  - WRITE `0000ff61-2333-5b1e-9d7c-c687fd2f04f2`  · NOTIFY `0000ff62-2333-5b1e-9d7c-c687fd2f04f2`.
- Handshake NOTIFY: `0000ffb2-0000-1000-8000-00805f9b34fb`.
- ⚠️ An unknown central is denied GATT discovery by the lock → use **react-native-ble-plx** (the same lib as the app) with **retry** (133 GATT_CONN_FAILED) or piggyback on the original app.

### 2.2 Handshake to obtain sessionKey  (ECDH computed by the CLOUD — the tool does NOT need to do ECDH)
Current status: **not fully local/offline yet**. The encrypted command transport is BLE-local, but
the production app still needs Aqara Cloud on each lock-detail entry to issue the session material
used by AES-CCM commands.

```
CLOUD publickey {deviceId} → cloudPublicKey(65B)
BLE   connect(mac) + notify ffb2; packCmd 0610 data=cloudPublicKey (channel ffb1, frag 18B) → devicePublicKey(65B)
CLOUD verify {deviceId, devicePublicKey} → sessionKey(16B), nonce(13B), verifyData(8B)   ← KEY IS HERE
BLE   packCmd 0710 data=verifyData → status 00 = LOGIN OK
```
The 0610/0710 framing = `getAiotLongPackageList` (CRC16-ARC). Reimpl: `app/src/protocol/gatt.ts`.

#### Current app session policy
The React Native app does **not** use cached session data when entering a lock detail screen. Each
detail entry forces a fresh cloud-backed session:

```
open detail
  → BLE connect
  → cloud publickey
  → BLE 0610
  → cloud verify
  → BLE 0710
  → keep {sessionKey, nonce} in memory for this detail screen only
leave detail
  → BLE disconnect
  → clear the in-memory session
```

All commands inside the detail screen reuse that active in-memory session key:
- unlock `01/74`;
- read status `01/e6` then `01/e5`;
- set validity `03/21`;
- create password `02/13` + `03/21`;
- delete group `02/05`.

After an unlock command, the app reads lock status over BLE first. If BLE status cannot be decoded
and the session was cloud-backed, it may query cloud `lock_state` as a fallback display signal.

#### Session cache (research/debug only)
The server response contains no explicit TTL field for `sessionKey`, `nonce`, or `verifyData`, and
the app can save the handshake result per `did` in `app/src/ble/sessionCache.ts`:
`{cloudPublicKey, devicePublicKey, sessionKey, nonce, verifyData}`.

The cache-replay idea was tested as:
```
connect → replay cached cloudPublicKey via 0610 → read devicePublicKey
  if devicePublicKey == cached  → reuse cached sessionKey/nonce + replay verifyData (0710)  → 0 CLOUD CALLS
  else (lock rotated its key)    → fall back to a full handshake (publickey + verify) and re-cache
```
In practice this was not reliable enough to be the default. The most likely model is still that the
cloud holds the private-side material needed to derive/issue the session, and the lock may reject
or rotate replayed material even though the cloud response itself has no TTL field. For the app,
cache is therefore treated only as a research/debug path, not as the production unlock path.

### 2.3 Command packaging  (`app/src/protocol/lock.ts`)
```
packet = mainCmd ‖ AES-CCM(sessionKey, nonce, [ subCmd ‖ data ‖ CRC16 ])
CRC16  = mijiaCrc16(mainCmd ‖ subCmd ‖ data)  → written BIG-ENDIAN on the wire
AES-CCM: 13B nonce used directly as IV, expandedIv='', MIC=4 bytes. (verified the openLock packet byte-for-byte)
Response (NOTIFY ff62) = replyMainCmd ‖ AES-CCM(...) ; decrypt with the same sessionKey/nonce.
```
- mainCmd: `01`=SYSTEM · `02`=USER · `03`=LOG · `3f`=LONG. replyMainCmd: `81`=SYSTEM · `82`=USER · `83`=LOG.

### 2.4 Reverse-engineered + verified commands

| Function | mainCmd/subCmd | data | Notes |
|---|---|---|---|
| **Unlock** | `01/74` BLE_OPEN_LOCK | `[opType]` (open=`01`) | verify packet byte-perfect, lock opens physically |
| **Read state** | `01/e6` / `01/07` | — | lock_state, tongue |
| **Read battery** | `01/de` GET_BATTERY_INFO | — | reply `81 …` |
| **Set VALIDITY** | `03/21` SET_VISTOR_PWD_VAILD_TIME | `validRange` (19B, section 1.6) | ✅ firmware ack `83/21/00`. **This is the REAL time-based locking path** (past deadline=disabled, ffffffff=activated) |
| **Create password** | `02/13` ADD_VISTOR_PWD | `[groupId][userType][credType=02][totalLen=bcdBytes+1][pwdLen=digits][pwd BCD]` | the lock SELF-assigns userId → reports back via RX `02/15` |
| **Report new userId** (RX) | `02/15` REPORT_USER_ID_NEW | `[err][userType][credType][op][groupId][userId 2B LE][ts 4B]` | read userId at `data[5:7]` LE |
| **Delete user (group)** | `02/05` DEL_USER_GROUP | `[groupId]` | delete from firmware |
| **Delete 1 credential** | `02/03` DEL_USER | `[userId 2B]` | |
| **Add fingerprint / NFC** | `02/01` (enroll) | interactive | ⚠️ enroll flow: activate → swipe/tap at the lock multiple times → `ADD_SUCCESS=11`. **NOT yet integrated** |

### 2.5 Complete "create password" flow (app `LockController.createPassword`)
```
1. (if new user) CLOUD user/group/add
2. BLE handshake → sessionKey
3. BLE 02/13  (program pwd BCD)            → lock assigns userId
4. read RX 02/15 → new userId
5. BLE 03/21  (set validity for userId)    → ack 83/21/00
6. CLOUD user/add (metadata: typeValue=base(2)+userId, validRange, …)
```
Pwd 6–10 digits, encoded as **BCD** (2 digits/byte; pad odd with nibble F).

### 2.6 Disable / Activate USER (quick) — `doGroupToggle`
Affects **all credentials** of one user, without entering a time:
```
disable: each credential → 03/21 validRange, deadline = PAST (now-1 day)  → lock refuses immediately
enable : each credential → 03/21 validRange, deadline = ffffffff (permanent)   → reopens immediately
```
- App: buttons **"⛔ Disable user (lock now)"** / **"✅ Activate user (unlock now)"** in the user sheet
  (`LockDetailScreen.doGroupToggle(items, disable)` → `disabledValidRange/enabledValidRange` → `LockController.setValidity`).
- The displayed state comes from `userValidityText(items)` (reads the deadline byte of each validRange).
- **Physically verified:** a disabled fingerprint → swiping does NOT open the lock; re-activate → opens normally.

---

## Part 3 — Code map
```
app/src/cloud/login.ts          email/password login (RSA BigInt + sign)
app/src/cloud/AqaraCloud.ts     all cloud endpoints (1.5)
app/src/cloud/lockmeta.ts       decode/encode validRange, typeValue, log, validity
app/src/protocol/sign.ts        sign (1.3)
app/src/protocol/lock.ts        BLE command packaging (2.3) + builder (2.4)
app/src/protocol/gatt.ts        handshake framing 0610/0710
app/src/protocol/aesccm.ts      AES-CCM (CTR + CBC-MAC) pure JS
app/src/protocol/crc16.ts       mijiaCrc16 + crc16Arc
app/src/ble/LockController.ts   handshake + unlock + setValidity + createPassword + delete
app/src/ble/BlePlxClient.ts     ble-plx connect retry + write/monitor
tools/aqara_sign.py             sign reimpl (self-test 5/5)
tools/ble_validity.py / ble_delgroup.py / ble_cmd.py   inject BLE commands via piggyback
```
