# D100 — Mac (CoreBluetooth) BLE path

The fourth control path. Mac mini with built-in BT (or USB BLE dongle) talks **directly**
to the D100 over CoreBluetooth via `bleak` — same protocol as the ESP32 path, but local
(no TCP round-trip) and using Apple's BLE stack instead of NimBLE/ESP-IDF.

Reference implementation: [`tools/ble_mac_test.py`](../tools/ble_mac_test.py).
Production status: **end-to-end verified** — cloud handshake → BLE 0610/0710 → sessionKey
→ `01/74` openLock → real door opens.

> This path was added because the ESP32 ESPHome `bluetooth_proxy` path consistently
> failed `GATT connect` (TCP latency loses the race against the lock's interleaved
> `ADV_IND` / `ADV_NONCONN_IND` cycle). CoreBluetooth wins the race because the
> controller's connect target watch is hardware-fast, no TCP in the loop.

---

## 0. TL;DR

```bash
cd /Users/baduongvan/dev/smarthome/d100-aquara-matter
export AQARA_EMAIL=…           AQARA_PASSWORD=…
export AQARA_AREA=SEA          AQARA_DISTRICT=VN
export LOCK_DID=lumi.…
export OP=open                 # or 'close' / 'unbolt' — leave empty to skip unlock
/opt/homebrew/opt/python@3.13/bin/python3.13 tools/ble_mac_test.py
```

Run **from Terminal.app directly** (not via Claude / a wrapped shell — see §3 TCC).
First run: ~40s (scan 34s + connect 6s). Subsequent runs: **~6s** thanks to UUID retrieve
+ session cache (§4, §5).

---

## 1. Architecture

```
                cloud REST                       BLE GATT (local)
   Mac mini  ─────────────►  Aqara cloud      Mac mini ─────────►  D100
   (Python +                  (publickey/      (bleak +              (FFA0
    bleak +                    verify)         CoreBluetooth)         FFB1 write
    aqd100.cloud)              ── ECDH P-256                          FFB2 notify
                               server-side                            FF61 cmd write
                                                                       FF62 cmd notify)
```

Two channels in lock-side:
- **Handshake** `FFB1` / `FFB2` — AIOT packets `0x0610` / `0x0710`.
- **Command** `FF61` / `FF62` — AES-CCM encrypted, `01/74` for openLock.

Identical to the ESP32 / RN-app path; only the BLE transport library differs.

---

## 2. Flow (cold start, no cache)

| Step | Where | What | Time |
|------|-------|------|------|
| 1 | Mac | `cloud.login_with_password` (RSA-PKCS1) → token | ~0.4 s |
| 2 | Mac | `cloud.publickey(did)` → `cloudPublicKey, mac` | ~0.1 s |
| 3 | Mac | `BleakScanner.discover` until adv UUID matches pinned | **~34 s** |
| 4 | Mac | `BleakClient(dev).connect(requestMTU=200)` | ~6 s |
| 5 | Mac | discover services → `ffb1`/`ffb2`/`ff61`/`ff62` (props auto-detected) | ~0.2 s |
| 6 | Mac | write `0x0610(cloudPK)` on `ffb1` → reassemble notify on `ffb2` → `devicePublicKey` | ~0.2 s |
| 7 | Mac | `cloud.verify(did, devicePK)` → `sessionKey, nonce, verifyData` (ECDH P-256) | ~0.2 s |
| 8 | Mac | write `0x0710(verifyData)` on `ffb1` | ~0.1 s |
| 9 | Mac | encrypt `01/74 [opType]` with `(sessionKey, nonce)` → write on `ff61` | ~0.05 s |
| 10 | Mac | listen `ff62` for `01/74` reply → parse `lockStatus` | ~0.5 s |

Total: ~41 s the first time. Step 3 dominates.

---

## 3. macOS quirks (the hard part — solved)

### 3.1. TCC (privacy sandbox) — `NSBluetoothAlwaysUsageDescription`

On macOS Sequoia/Tahoe (26.x), **any process touching CoreBluetooth crashes with
`SIGABRT (Namespace TCC)`** if its Info.plist lacks `NSBluetoothAlwaysUsageDescription`.

The crash chains up the **responsible process** (not the immediate parent), so spawning
Python from a shell inside Claude / a backgrounded subprocess still inherits the calling
app's TCC posture.

| What we tried | Result |
|---|---|
| `python3 …` from a Claude-tool shell | ❌ `SIGABRT TCC` — Claude Desktop has no BT entitlement |
| Wrap script in custom `.app` bundle with usage description + ad-hoc codesign | ❌ `exec`-ing Homebrew Python loses the bundle identity, TCC chains back to Claude |
| Patch Homebrew Python.app `Info.plist` + ad-hoc resign | ❌ `bin/python3.13` is a standalone Mach-O, not a bundle process |
| `open -a Python.app --args script.py` (Launch Services) | ❌ silent — Launch Services partially works, but child argv plumbing flaky |
| `osascript "tell Terminal to do script…"` | ❌ Terminal didn't have a front window; race-y |
| **`ssh localhost`** | ❌ Soft deny — `BleakBluetoothNotAvailableError`, sshd has no BT entitlement either |
| **Open Terminal.app directly + paste command** | ✅ macOS prompts "Terminal wants to use Bluetooth" → Allow → all child Python processes inherit |

**The only reliable path**: open `Terminal.app` from Spotlight, paste the command, click
**Allow** on the first BT prompt. Subsequent runs in Terminal don't re-prompt.

### 3.2. CoreBluetooth hides MACs

Apple's BLE stack does not expose peer MAC addresses to user-space. Each peripheral is
identified by a **per-host UUID** (e.g. `59E9553D-BCF3-B01A-9EB8-3288E4A9BE46`). The
cloud-issued `mac=5A58004D56ED` is unusable for connect; we pin the UUID instead.

### 3.3. Two peripherals advertise as "Aqara Smart Door Lock 8459"

The D100 broadcasts on **two BLE endpoints** in parallel:

| UUID | Adv name | Role |
|---|---|---|
| `59E9553D-BCF3-B01A-9EB8-3288E4A9BE46` | `DP1A` (or sometimes `Aqara Smart Door Lock 8459`) | **Aqara MiOT** — FFA0/FFB1/FFB2 handshake, the one we want |
| `B7C7245D-BEE3-F0E0-5563-E6B315800063` | `Aqara Smart Door Lock 8459` (mfg `4c00…` = Apple) | **HomeKit / HomeKey** — Apple stack, not for us |

Pin UUID via env `MAC_BLE_UUID` or hard-coded default in `tools/ble_mac_test.py`.

### 3.4. The lock advertises sparsely (pin-saving)

D100 runs on AA batteries. Idle, it interleaves `ADV_IND` (connectable) with many
`ADV_NONCONN_IND` (broadcast-only). Window of a single `ADV_IND` is short (~20 ms).
This is **why ESP32+TCP fails** (round-trip > one window) and why even Mac sometimes
needs to wait 30+ seconds to catch one.

**Wake mechanisms** that force the lock into a dense connectable burst (~30 s window):
- Tap the fingerprint reader / wave at the proximity sensor on the lock body.
- Open the Aqara app to the lock screen (cloud pushes wake — but app also opens its own
  BLE link, blocking our scan; kill the app before our script runs).
- `cloud.publickey(did)` is **NOT** a wake (it's a REST cache read, no MQTT push).

---

## 4. Quick wins (cold 41s → warm 6s)

### 4.1. Skip scan — `retrievePeripheralsWithIdentifiers`

CoreBluetooth keeps an internal cache of every peripheral the central has ever seen,
keyed by UUID. `BleakClient("uuid-string").connect()` calls
`centralManager.retrievePeripheralsWithIdentifiers_([NSUUID])` first, then asks the
controller to *watch for ADV_IND of that one peripheral* and CONNECT_IND immediately
(hardware-fast, no userland callback per advert).

Trade-off: **only works after the first scan** (peripheral has to be in the cache). The
script falls back to scan on a fresh boot.

### 4.2. Skip cloud verify — cached `sessionKey`

ECDH P-256 is deterministic: identical `(cloudPublicKey, devicePublicKey)` pair →
identical `sessionKey`. The lock keeps `devicePublicKey` stable across sessions (rotates
only on reboot / multi-hour timer).

`/tmp/d100_session.json` stores `(did, ts, cloudPK, devicePK, sessionKey, nonce, verifyData)`.

On next run: replay the cached `cloudPublicKey` via `0610`; if the lock replies with the
SAME `devicePublicKey` we cached, the sessionKey we cached is still valid → reuse it,
skip cloud `verify()` entirely. Lock side: indistinguishable from a fresh handshake.

If lock returns a NEW `devicePublicKey` → cache stale → fall back to fresh cloud handshake
and overwrite the cache.

Same pattern as the RN app — `app/src/ble/LockController.ts:267-302`.

### 4.3. Combined effect

| Run | Scan | Connect | Cloud verify | BLE handshake | Total |
|---|---|---|---|---|---|
| Cold (1st) | 34 s | 6 s | 0.2 s | 0.7 s | **~41 s** |
| Warm (cached) | 0 s | ~6 s | 0 s | ~0.3 s | **~6 s** |

Cache invalidation triggers a single cold run, then warm again.

---

## 5. File layout

```
tools/ble_mac_test.py                  # the actual script
custom_components/aquara_local/cloud.py        # AqaraCloud, login_with_password, publickey, verify
custom_components/aquara_local/gatt.py         # UUIDs, build_aiot_frames, HsReassembler, extract_pubkey
custom_components/aquara_local/protocol.py     # pack_short, unpack, build_open_lock (AES-CCM)
/tmp/d100_session.json                 # session cache (sessionKey + ECDH metadata)
/tmp/macble_*.log                      # run logs
```

---

## 6. Open items

- **Persisted Terminal grant**: TCC remembers Terminal's permission across reboots, so
  the one-time prompt is a non-issue for production. But: **any HA Container / Docker /
  Home Assistant Supervisor running on the same Mac will need its OWN grant** (different
  responsible process). HA macOS install requires a separate "Allow Bluetooth" click.
- **HA integration wiring**: the existing `custom_components/aquara_local/` uses
  `bleak-retry-connector` via `bluetooth_adapters` (HA's BT layer). If HA runs on the
  same Mac mini, it will use the same CoreBluetooth — just needs Bluetooth permission
  for HA's process. If HA runs elsewhere, the Mac mini must expose a small HTTP bridge
  (`POST /unlock`) and HA `rest_command` calls it. Not yet wired.
- **Auto-relaunch**: if the lock reboots or cache hits the 6 h TTL, current script does
  one cold handshake then warm again. A daemon variant could keep the BLE link live
  and re-handshake transparently.
- **Multiple-locks**: cache file is keyed by `did` already, but only one entry at a
  time. Change to a dict if the account has multiple D100s.

---

## 7. Related docs

- [`BLE_API.md`](BLE_API.md) — full BLE protocol (commands, AES-CCM framing, CRC16).
- [`REVERSE_ENGINEERING.md`](REVERSE_ENGINEERING.md) — how the BLE / Cloud / Local paths
  were uncovered.
- [`CLOUD_API.md`](CLOUD_API.md) — the cloud half (login, `publickey`, `verify`, `/matter/write`).
- App reference: [`app/src/ble/LockController.ts`](../app/src/ble/LockController.ts),
  [`app/src/ble/BlePlxClient.ts`](../app/src/ble/BlePlxClient.ts).
