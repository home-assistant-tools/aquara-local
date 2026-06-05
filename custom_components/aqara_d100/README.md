# Aqara D100 Lock — Home Assistant integration

Control the **Aqara Door Lock D100** (`dp1a` / `aqara.lock.aqgl01`) from
Home Assistant. You sign in once with your **Aqara Home email + password**; the
integration **auto-discovers every D100** on the account and adds a `lock` entity
(plus a battery sensor) to your dashboard.

**Unlocking and locking go through the Aqara cloud → your hub → Zigbee** — exactly
like the official app (Matter DoorLock `unlockDoor`/`lockDoor`). No phone, no
Bluetooth, no ESP32 required, and **Apple HomeKey stays intact** (the lock keeps its
Zigbee/G410 pairing). An optional local BLE path (via an ESP32 proxy) is also wired
up as a fallback for offline use — see below.

> Reverse-engineering background and protocol details live in the repo root
> [`README.md`](../../README.md). This integration is a faithful Python port of the
> verified TypeScript client (`client/`, `app/src/`).

## How it works

```
                 ┌─ unlock: POST /matter/write ─► Aqara Cloud ─► hub ─► Zigbee ─► D100
HA integration ──┤
                 └─ status/discovery: cloud poll (lock_state, battery)
```

* **Remote unlock / lock** is a single signed cloud call: `POST /app/v1.0/lumi/matter/write`
  writing a Matter DoorLock command trait — `2.148.35011.0` (unlockDoor, verified live
  3/3) or `2.148.35010.0` (lockDoor). The trait paths come from the Aqara app's own RN
  bundle (`buildCommandPath`), so they're what the app sends, not guesses. The cloud
  relays the command to the lock through your hub. Condition: *remote operation enabled*
  on the lock + hub online — the same requirement as the app's remote-unlock button.
* **Cloud** also handles login, lock discovery, and status polling (`lock_state`,
  battery, offline status).
* **Optional BLE** (automatic fallback if a cloud command fails):
  carries the `01/74` (`BLE_OPEN_LOCK`) command AES-CCM encrypted with a session key
  minted via a cloud ECDH handshake. Built identically to the captured real packet
  (`01d3c6a27b865a849f`). Needs an ESP32 proxy — see "Optional local BLE path".

## Requirements

1. **An Aqara Home account** that controls the D100 (email/password login).
2. **Remote operation enabled** on the lock and the **hub online** (Aqara app → lock
   → settings → enable remote unlock). This is what makes cloud unlock work.
3. Home Assistant **2024.8+**.

That's all for unlocking. Bluetooth hardware is only needed for the optional local
path below.

## Installation

**HACS (custom repository):** add this repo as an *Integration*, install
"Aqara D100 Lock", restart HA.

**Manual:** copy `custom_components/aqara_d100/` into your HA `config/custom_components/`
and restart.

Then **Settings → Devices & Services → Add Integration → "Aqara D100 Lock"**,
enter your email/password, pick the server region (VN accounts → **SEA**), and the
locks are added automatically.

## Verify before installing

`tools/cloud_test.py` exercises the exact cloud path the integration uses (login →
discover → status) against your real account — no HA, no hardware:

```bash
AQARA_EMAIL=you@example.com AQARA_PASSWORD='...' python3 tools/cloud_test.py
```

To prove unlock/lock end-to-end, set `AQARA_TEST_ACTION=unlock` (or `lock`). ⚠️ This
**physically moves the real door**, so it's off by default and needs *remote operation
enabled* on the lock + the hub online. A green run is a guarantee that the HA `lock`
entity will work the same way.

## Entities

| Entity | Notes |
|--------|-------|
| `lock.<lock_name>` | `unlock` → cloud unlockDoor · `lock` → cloud lockDoor (both fall back to BLE if the cloud call fails). State from cloud `lock_state`. |
| `sensor.<lock_name>_battery` | Battery % from the cloud poll (diagnostic). |
| `sensor.<lock_name>_last_event` | Timestamp of the most recent lock event (from the cloud event log) — **this is how HA sees opens done outside HA** (PIN/NFC/manual). Near-real-time (~60 s poll), not instant. |
| `sensor.<lock_name>_credentials` | Number of registered credentials (PIN/NFC/fingerprint/face). |

## Services (cloud-only)

All go through the cloud (no BLE). Find your lock's `did` (e.g. `lumi.54ef…`) on the
device page. The credential/user ones were verified live; the Matter credential/user/
schedule *writes* are not captured yet, so they're only reachable via `matter_write`.

| Service | What it does |
|---------|--------------|
| `aqara_d100.unbolt` | Fully retract the bolt (Matter unbolt). |
| `aqara_d100.identify` | Beep/flash the lock to locate it (safe test). |
| `aqara_d100.delete_credential` | Remove a PIN/NFC/fingerprint by type + value. |
| `aqara_d100.set_credential_validity` | Disable / re-enable a credential. |
| `aqara_d100.create_user_group` / `delete_user_group` / `rename_user_group` | Manage user groups. |
| `aqara_d100.matter_write` | Advanced escape hatch: write any Matter trait (see [CLOUD_API.md](../../docs/CLOUD_API.md)). |

See [docs/CLOUD_API.md](../../docs/CLOUD_API.md) and [docs/BLE_API.md](../../docs/BLE_API.md)
for the full API surface.

## Status & known limitations

✅ **Cloud unlock/lock works without any extra hardware** — login (RSA-wrapped
password, no OTP), request `sign`, and the `/matter/write` commands all match real app
captures. Verified live end-to-end against a real account: a remote unlock physically
opened the lock (`lock_state` 4→6→4) with no Bluetooth involved. This is the primary,
recommended path.

🔁 **The D100 auto-relocks ~8 s after unlocking.** So right after `unlock` the entity
briefly shows `unlocked`, then returns to `locked` on its own — this is the lock's
behaviour, not a bug. The door really did open during those seconds.

📍 **Lock state** is whatever the cloud reports (`lock_state`), polled ~60 s; after a
command the integration reflects the new state optimistically and re-polls.

## Troubleshooting

- **Lock shows `unavailable` / the unlock button does nothing** — update to **≥ 0.1.2**.
  Earlier versions gated availability on the cloud `device_offline_status` field, which
  is unreliable (it reads `"1"` even while the lock is online and accepting commands), so
  the entity got stuck unavailable.
- **`unlock` seems to do nothing in the UI** — remember the auto-relock above; the entity
  may already be back to `locked` by the time the poll runs. Watch the lock itself, or the
  logbook, right after pressing.
- **See the real reason a command failed** — enable debug logging, press the button, then
  read **Settings → System → Logs**. From 0.1.1 the integration logs the raw `/matter/write`
  result and, on failure, surfaces the actual cloud error (hub offline, remote-op disabled,
  auth) instead of a misleading Bluetooth message:
  ```yaml
  logger:
    logs:
      custom_components.aqara_d100: debug
  ```
- **Verify the cloud path outside HA** — `AQARA_TEST_ACTION=unlock python3 tools/cloud_test.py`
  fires the exact command the integration uses (⚠️ opens the real door).

## Optional local BLE path

A phone-free **local** fallback (used automatically if a cloud command fails — e.g.
hub offline) drives the lock over BLE through an **ESP32 running ESPHome
`bluetooth_proxy` (active)** near the door:

```yaml
esp32_ble_tracker:
  scan_parameters:
    active: true
bluetooth_proxy:
  active: true        # active mode = HA can make outbound GATT connections
```

Add it to HA via the ESPHome integration. The D100 advertises faintly (RSSI ~−84
from across a room), so put the ESP32 **right by the lock**. A ready config lives in
[`tools/esp32-d100-proxy.yaml`](../../tools/esp32-d100-proxy.yaml).

⚠️ **This BLE leg is unproven on hardware.** Prior research unlocked by *piggybacking*
the Aqara app's own BLE connection; a standalone central (Mac/`bleak`) was refused at
GATT discovery. An ESP32 active proxy is a different central stack and may behave
differently, but this is **not yet confirmed**. Two unknowns: whether the lock accepts
a handshake from a non-Aqara central, and the exact command-channel UUIDs (`CMD_WRITE`
/ `CMD_NOTIFY` in [`gatt.py`](gatt.py) are best-known guesses). Enable debug logging to
dump the discovered GATT layout on connect, and fix the UUIDs in `gatt.py` if they differ:

```yaml
logger:
  logs:
    custom_components.aqara_d100: debug
```

## Security note

Your Aqara password is stored in the HA config entry (needed to refresh the
session token automatically). This is a self-hosted, owner-operated integration
for a lock you own. Do not share your HA config or this token.
