# D100 Unlock — React Native app

App to manage and unlock the Aqara D100: log in -> list locks -> open lock detail -> build a fresh
cloud-backed BLE session -> reuse that session for commands until leaving the detail screen. Uses
**react-native-ble-plx** (the same BLE library family the Aqara app uses) so it connects to the lock
like the original app.

## Architecture
```
App.tsx                 root: Login <-> LockList based on auth
src/protocol/           hex · crc16 · aesccm (aes-js, MIC=4) · sign (js-md5) · lock (packShort/openLock) · gatt
src/cloud/AqaraCloud.ts sign header + token; listLocks + handshake publickey/verify
src/cloud/login.ts      login password (x-aes128gcm) — ⚠️ TODO crypto
src/ble/BlePlxClient.ts BLE: scan DP1A → connect MTU200 → discover → notify/write
src/ble/LockController.ts cloud-backed handshake + active session reuse + unlock/status/user commands
src/screens/            LoginScreen · LockListScreen · LockDetailScreen
```

## Current unlock/session flow

This app is **not fully local/offline yet**. It is cloud-assisted BLE: cloud is still required on
lock-detail entry to issue `sessionKey`, `nonce`, and `verifyData`; after that, commands in the same
detail screen are sent locally over BLE.

The app intentionally does **not** use cached session data when entering a lock detail screen.

1. Enter detail screen.
2. Connect BLE to the D100.
3. Call cloud `publickey`.
4. Send `0610` over BLE and read `devicePublicKey`.
5. Call cloud `verify` to get `sessionKey`, `nonce`, and `verifyData`.
6. Send `0710` over BLE.
7. Keep that session in memory and reuse it for all commands in the detail screen.
8. On leaving the detail screen, disconnect BLE and clear the in-memory session.

`sessionCache.ts` is kept only for research/debug paths. The tested app path always requests a new
cloud session on detail entry because replaying cached session data was not reliable enough.

## Status (honest)
| Part | Status |
|------|-----------|
| Crypto/protocol (sign, AES-CCM, CRC, packShort) | ✅ **VERIFIED**: `openLock = 01d3c6a27b865a849f` = the REAL packet that unlocked the lock; `sign` matches the sample. |
| BLE (ble-plx) | ✅ uses the exact lib the Aqara app uses → connects to the lock (DP1A). |
| Lock listing + cloud handshake | ✅ `sign`+token run for real (tested outside the app). |
| **Handshake frame `0610`/`0710`** | ✅ **DECODED 100% & verified byte-perfect** (`getAiotLongPackageList`, CRC16-ARC). `buildAiotFrames` builds the 0610 frame **byte-identical** to the real lock. |
| **Login password** (`x-aes128gcm`+RSA) | ⏳ recipe validated (embed the `.so` `liblumidevsdk` — see memory); for now use **"Advanced: token"**. |
| **ble-plx connect/discover lock** | ✅ tested through the React Native app build. Detail entry now requires a live cloud handshake before commands are enabled. |

## How to build & run (Android)
ble-plx needs native code → requires a **dev build** (won't run in Expo Go).
```bash
cd app
npm install            # or: bun install
npx expo prebuild --platform android
npx expo run:android   # build + install on the plugged-in device (adb)
```
Open the app -> log in or use **"Advanced: token"** -> lock list -> tap a lock -> wait for
`Cloud + BLE` session ready -> long-press the unlock button.

> Getting token/userId: from `captures/mitm/FINDINGS.md` (the token changes on every login). Once `x-aes128gcm`+RSA is fully reversed, you'll log in with email/password directly.

## Remaining work to make "password login" work
1. The KDF key/iv of `x-aes128gcm` (`aesEncryptedContent`) — reverse the native code.
2. The RSA public key (encryptType 2) for the password.
→ fill these into `src/cloud/login.ts`.
