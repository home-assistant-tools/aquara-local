# D100 — Cloud API (remote, through the hub)

Everything the lock can do **through the Aqara private cloud** — no Bluetooth, no ESP32.
Commands go cloud → your hub → Zigbee → lock, exactly like the official app's remote buttons.

Reference implementation: [`app/src/cloud/AqaraCloud.ts`](../app/src/cloud/AqaraCloud.ts) and the
Python port [`custom_components/aqara_d100/cloud.py`](../custom_components/aqara_d100/cloud.py).

Auth: email/password login (RSA-wrapped, no OTP) → token; every request is `sign`-ed
(`Appid&Nonce&Time[&Token]&body&appkey`, MD5). No `x-aes128gcm`. Base URL per region
(SEA→`rpc-au`, CN→`rpc.aqara.cn`, US→`rpc-us`, EU→`rpc-ger`, KR→`rpc-kr`), prefix
`/app/v1.0/lumi`.

## 1. Control — Matter DoorLock trait writes  (`POST /matter/write`)

One endpoint drives **all** stateful commands. Body:
`{"data": {"<trait>": "<value>"}, "did": did, "pwd": "", "type": 0}`. The trait path is
`"<endpoint>.<function>.<command>.<instance>"`, decoded from the lock's RN bundle
(`buildCommandPath`, endpoint 2 / function 148). The native layer sends the *same* payload
over the local hub (UDP) when on-LAN, or the cloud otherwise.

| Function | Trait | Value | Status |
|----------|-------|-------|--------|
| **unlockDoor** | `2.148.35011.0` | `""` | ✅ **verified live** (lock physically opened) |
| **lockDoor** | `2.148.35010.0` | `""` | ✅ wired |
| **unbolt** | `2.148.40031.0` | `""` | trait from bundle |
| setUser | `2.148.40032.0` | struct `{0:op,1:userIndex,2:name,…}` | ⚠️ unverified (complex value) |
| getUser | `2.148.40033.0` | query | ⚠️ |
| clearUser | `2.148.40034.0` | `{0:userIndex}` | ⚠️ |
| setCredential | `2.148.40035.0` | struct (Matter SetCredential) | ⚠️ unverified — value encoding not captured |
| getCredentialStatus | `2.148.40036.0` | query | ⚠️ |
| setWeekDaySchedule | `2.148.40025.0` | struct | ⚠️ |
| getWeekDaySchedule | `2.148.40026.0` | query | ⚠️ |
| clearWeekDaySchedule | `2.148.40027.0` | struct | ⚠️ |
| setYearDaySchedule | `2.148.40028.0` | struct | ⚠️ |
| getYearDaySchedule | `2.148.40029.0` | query | ⚠️ |
| clearYearDaySchedule | `2.148.40030.0` | struct | ⚠️ |
| identify | `1.131.32918.0` | `""` | beeps/flashes the lock — safe test |

`lockState` trait value mapping: `'1'`=locked, `'2'`=unlocked, `'0'`=latch error.

> ✅ = captured/verified. ⚠️ = the trait id is known from the bundle but the **value
> structure is not captured**, so writing it blind is unsafe. Use the BLE path (which *is*
> verified) for credential programming until these are captured.

## 2. Read / status

| Function | Endpoint | Returns |
|----------|----------|---------|
| Lock resources | `POST /res/query` `{data:[{options:[…],subjectId:did}]}` | `lock_state`, `batt_0_remain_percentage`, `arm_state`, `device_offline_status`*, `low_battery_power` |
| Lock event history | `POST /app/lock/res/history/query` `{attrs:["lock_local_log"],startTime,endTime,size,subjectId}` | open/close events (`lock_local_log`) — **this is how you see manual opens** |
| Password state | `GET /devex/device/pwd/state/query` | per-credential password state |
| Password usage log | `GET /dev/lock/one/password/log/query` | which PIN was used when |

\* `device_offline_status` is **unreliable** — it reads `"1"` even when the lock is online
and responding (see the integration's `coordinator.py`). Use the device-list `state`
(1=online) if you need a true online flag.

## 3. Credential & user management (REST mirror)

These manage the cloud's view of credentials/users. Credential *programming* still happens
over BLE (`02/13`) on real hardware; these endpoints register/update/remove the metadata.

| Function | Endpoint | Status |
|----------|----------|--------|
| List credentials (fingerprint/PIN/NFC/face) | `GET /dev/lock/query?deviceId&types=[1..7]` | ✅ live |
| List user groups | `GET /dev/lock/user/group/info?did` | ✅ |
| Update credential (rename / validRange) | `POST /dev/lock/update/name` | ✅ |
| Delete credential | `POST /dev/lock/user/del` `{did,typeInfo:[{type,typeValues}]}` | ✅ |
| Disable/enable credential | `POST /dev/lock/update/name` (set `validRange`) | ✅ |
| Create user group | `POST /dev/lock/user/group/add` | ✅ |
| Add credential metadata | `POST /dev/lock/user/add` | ✅ |
| Delete user group | `POST /dev/lock/user/group/del` | ✅ |
| Rename user group | `POST /dev/lock/user/group/update` | ✅ |

Credential `type`: `1`=fingerprint `2`=password `3`=NFC `4`=eKey/BLE `5`=temp password
`6`=face `7`=NFC tag.

## 4. BLE session material (cloud half of the BLE handshake)

| Function | Endpoint | Returns |
|----------|----------|---------|
| publickey | `POST /dev/bluetooth/login/assure/publickey` `{deviceId}` | `cloudPublicKey`, `mac` |
| verify | `POST /dev/bluetooth/login/assure/verify` `{deviceId,devicePublicKey}` | `sessionKey`, `nonce`, `verifyData`, `mac` |

## Summary: cloud vs BLE

| Capability | Cloud | BLE |
|------------|:-----:|:---:|
| Unlock / lock / unbolt | ✅ | ✅ |
| Read state / battery | ✅ | ✅ |
| Read event history (manual opens) | ✅ | partial |
| List / delete / disable credentials | ✅ | ✅ |
| User-group management | ✅ | ✅ |
| **Program a new PIN into firmware** | ⚠️ not captured | ✅ verified |
| Fingerprint / NFC **enrolment** | ❌ physical | ❌ physical |
| Works with hub offline | ❌ | ✅ (after session mint) |
