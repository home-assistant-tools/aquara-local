# D100 — BLE API (local, direct-to-lock)

Everything the lock can do **over a direct Bluetooth LE connection**, reverse-engineered
from the Aqara Home app and verified against real hardware. This is the *local* transport:
the phone (or an ESP32 proxy) talks straight to the lock's GATT, with no hub in the path.

Reference implementation: [`app/src/ble/LockController.ts`](../app/src/ble/LockController.ts),
packet builders in [`app/src/protocol/lock.ts`](../app/src/protocol/lock.ts), and the Python
port in [`custom_components/aqara_d100/`](../custom_components/aqara_d100/) (`ble.py`,
`protocol.py`, `gatt.py`).

> Cloud is still needed **once per session** to mint the BLE session key (ECDH is computed
> cloud-side). After that the commands are pure local BLE. A fully offline path is not solved.

## Transport & framing

| Layer | Detail |
|-------|--------|
| GATT handshake channel | `ffb1` write / `ffb2` notify — AIOT packets `0x0610` (send cloudPublicKey) / `0x0710` (send verifyData). Reassembled with CRC16-ARC. |
| GATT command channel | `CMD_WRITE` / `CMD_NOTIFY` (see `gatt.py`) |
| Command packet | `mainCmd ‖ AES-CCM(sessionKey, nonce, subCmd ‖ data ‖ CRC16-BE)`, MIC = 4 bytes |
| Session key | from cloud `publickey` → BLE `0610` → cloud `verify` → BLE `0710` (ECDH P-256) |

`mainCmd`: `0x01` SYSTEM · `0x02` USER · `0x03` LOG · `0x3f` LONG.
Replies: `0x81` / `0x82` / `0x83`.

## Session / handshake

| Operation | Code | Notes |
|-----------|------|-------|
| `connectSession` / `handshake` | `0610` + `0710` | ECDH with cloud-minted material; result cached for reuse within a screen |
| Reuse cached session | replay `0610` | compares returned devicePublicKey to detect a rotated session |

## Commands (verified)

| Function | mainCmd/sub | Payload | Reply | Status |
|----------|-------------|---------|-------|--------|
| **Open lock** | `01/74` `BLE_OPEN_LOCK` | `[opType]` — `01`=open `00`=close `02`=unbolt `03`=toggle | door-status notify | ✅ verified byte-for-byte (`01d3c6a27b865a849f`) |
| **Read lock status** | `01/e6` `REPORT_DOOR_LOCK_STATUS` | — | `data[0]`=lock (0 locked / 1 unlocked / 2 error), `data[1]`=door (0 closed / 1 open / 2 ajar) | ✅ |
| **Read lock status (alt)** | `01/e5` `GET_DOOR_LOCK_STATUS` | — | same | ✅ |
| **Battery info** | `01/de` `GET_BATTERY_INFO` | — | battery | decoded |
| **Set credential validity** | `03/21` `SET_VISTOR_PWD_VAILD_TIME` | `validRange` (19 B) — past deadline = disable, `ffffffff` = activate | ack `83/21/00` | ✅ verified ack |
| **Create password** | `02/13` `ADD_VISTOR_PWD` | `[groupId][userType][credType=02][len][pinLen][PIN as BCD]` | userId via `02/15` | ✅ verified (returns userId) |
| **Report new userId** | `02/15` `REPORT_USER_ID_NEW` (notify) | `[err][userType][credType][op][groupId][userId 2B LE]` | — | parse only |
| **Delete user group** | `02/05` `DEL_USER_GROUP` | `[groupId]` | — | ✅ |
| **Delete user** | `02/03` `DEL_USER` | `[userId]` | — | builder available |

### Credential creation flow (real)
1. `handshake` → session key.
2. `02/13` program the PIN into the lock firmware → lock answers `02/15` with the assigned `userId`.
3. `03/21` push a permanent validity range for that `userId`.
4. (then the cloud REST mirror registers metadata — see [CLOUD_API.md](CLOUD_API.md)).

This is why **PIN/NFC/fingerprint *programming* is inherently local**: the secure credential is
written into the lock's secure element over BLE. The cloud only mirrors metadata afterwards.

## What BLE can do that cloud cannot
- Operate with the hub offline / no internet (after the one-time session mint).
- Program a credential directly into firmware (`02/13` + `03/21`).
- Read the raw door-ajar sensor (`data[1]` of the status reply).

## What still requires physical presence at the lock (no transport helps)
- **Fingerprint enrolment** — finger must touch the lock sensor.
- **NFC card enrolment** — card must be tapped at the lock.
- (Deleting these, and PIN codes, are pure data and need no presence.)
