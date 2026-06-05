# Aqara D100 — TypeScript client

Encodes the entire reversed API (see `../README.md`, `../captures/mitm/FINDINGS.md`). Runs on Bun & Node (≥18). No external dependencies (only `node:crypto`).

```
client/
  constants.ts            opcode/enum/UUID/endpoint (✅ reversed)
  hex.ts crc16.ts         utilities + Mijia CRC16 (✅)
  crypto.ts               aqaraSign (✅) · pure AES-CCM (⚠️ MIC=4 hypothesis) · x-aes128gcm (⚠️ KDF pending)
  framing.ts              MIoT fragmentation (handshake/long pack)
  BleClient.ts            abstract BLE transport — `send` + `listen`
  AquaraMobileClient.ts   cloud: sign request · login/logout · getLockKey
  AquaraLock.ts           lock commands per the reversed API
```

## 3 main classes

### `AquaraMobileClient` — cloud (login/logout/fetch key)
```ts
const cloud = new AquaraMobileClient({
  area: "SEA",                                   // VN account → rpc-au
  token: "<TOKEN from login>",                   // obtained from loginWithPassword(...)
  userId: "<USER_ID from login>",
});

// call a signed API (✅ works immediately):
const lockInfo = await cloud.get("/dev/lock/query", { deviceId: "<LOCK_DID>", types: "[1,2,3,6]" });

// fetch the sessionKey for the lock (cloud↔BLE handshake):
const key = await cloud.getLockKey("<LOCK_DID>", ble); // {sessionKey, nonce, mac}

await cloud.logout("<clientId>");
```
`sign` (✅ solved) is attached automatically to each request: `md5("Appid=..&Nonce=..&Time=..&Token=.."+("&"+body if present)+"&"+appKey)`.

### `BleClient` — transport (abstract: `send` + `listen`)
Implement it yourself per platform (noble / react-native-ble-plx / bleak-bridge):
```ts
class MyBle extends BleClient {
  async connect(mac){ /* ... */ }
  async disconnect(){ /* ... */ }
  async send(charUuid, data){ /* GATT write */ }
  async listen(charUuid, cb){ /* subscribe notify; return unsubscribe */ }
}
```
`request(writeChar, notifyChar, data)` (provided) = write then wait for one notify.

### `AquaraLock` — lock (initialized with key + BleClient)
```ts
const lock = new AquaraLock(key, ble);   // key = {sessionKey 16B, nonce 13B}

await lock.openLock();                    // 01/74 — UNLOCK
await lock.close();  await lock.unbolt(); await lock.toggle();
const st  = await lock.getDoorLockStatus();   // {lockStatus, doorStatus}
const bat = await lock.getBatteryInfo();      // BatterySlot[]
await lock.deleteUser(userId);
await lock.addFingerprint(slot, /*admin*/ false);
await lock.addNfcCard(groupId);               // then tap the card within 15s
await lock.addVisitorPassword({ groupId:1, userId:1, pin:"1234" });
const log = await lock.getLogList(0, 50);
const unsub = await lock.listen(f => console.log(f.mainCmd, f.subCmd, f.data));

// time-based (LONG pack): build data (✅ encode) then send
const data = lock.buildUserValidPeriodData({ userGroupId:3, weekMask:getDaysMask([true,false,false,false,true,false,false]), start:bcdStamp(new Date()), end:bcdStamp(new Date(Date.now()+3600e3)) });
await lock.sendUserValidPeriod(data);
```

## Confidence status
| Part | Status |
|------|-----------|
| `aqaraSign`, opcode, payload encode, Mijia CRC16, handshake framing | ✅ reversed, tested against real samples |
| command packaging `mainCmd ‖ AES-CCM(subCmd‖data‖CRC)` | ✅ **LOCKED & verified 5/5 on real lock** — MIC=4, nonce-direct, **CRC big-endian**. `packShort(01,74,[01])` = real openLock packet `01d3c6a27b865a849f`. |
| `getLockKey` handshake | ✅ sessionKey/nonce obtained from cloud; ⚠️ inner-framing of the 0610/0710 packets partially RE'd |
| `loginWithPassword` (x-aes128gcm) | ⚠️ needs `gcmKeyIvDeriver` (KDF not yet reversed) + RSA password. Not needed while the token is still valid. |
| real `BleClient` | ⏳ standalone central is blocked at discovery by the lock → use **piggyback** (`frida/ble_capture.js`, real unlock already achieved). |
| command-channel NOTIFY char (`CMD_NOTIFY`) | ⚠️ UUID is a guess (0xff62) — confirm when sniffing |

## Test
```bash
bun run smoke.test.ts      # sign matches real samples + pack/unpack + helpers
bun x tsc --noEmit         # typecheck (strict)
```
