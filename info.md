# Aqara D100 Lock — Home Assistant

Home Assistant integration for the **Aqara Door Lock D100** (`dp1a` / model `aqara.lock.aqgl01`)
that signs in to the Aqara cloud with your **email + password** and auto-discovers every D100 on
the account. No OTP, no Open-API developer key, **no extra hardware**.

## What works today

- ✅ **Remote unlock & lock** — opens/closes the lock through the Aqara cloud → your hub → Zigbee,
  exactly like the official app (Matter DoorLock commands `unlockDoor`/`lockDoor`). **No Bluetooth,
  no ESP32 required.** Verified live: a remote unlock physically opened the lock.
- ✅ **Auto-discovery** — every D100 on the account is added as a device.
- ✅ **Lock state** — `locked` / `unlocked` / `unknown`, polled from the cloud (~60 s).
- ✅ **Battery sensor** — remaining battery %.
- ✅ **Last-event sensor** — timestamp of the most recent lock event from the cloud log, so HA
  notices opens done **outside** HA (PIN/NFC/manual). Near-real-time (~60 s poll), not instant.
- ✅ **Credentials sensor** — how many PIN/NFC/fingerprint/face credentials are registered.
- ✅ **Services** — `unbolt`, `identify`, `delete_credential`, `set_credential_validity`,
  user-group management, and a generic `matter_write` (all cloud, no BLE).
- ✅ **Availability** — the lock stays available as long as the cloud poll succeeds.

> ℹ️ The **D100 auto-relocks ~8 s after unlocking**, so right after `unlock` the entity briefly
> shows `unlocked` then returns to `locked` on its own — that's the lock's behaviour, not a bug.

## Requirements

- An **Aqara Home account** that controls the D100 (email/password login).
- **Remote operation enabled** on the lock and the **hub online** — the same condition the Aqara
  app needs for its remote-unlock button. (Aqara app → lock → settings → enable remote unlock.)

That's it. The unlock path is pure cloud and needs no Bluetooth hardware.

## Install

1. HACS → **Integrations** → ⋮ → **Custom repositories** → add this repo, category **Integration**.
2. Install **Aqara D100 Lock**, then restart Home Assistant.
3. **Settings → Devices & Services → Add Integration → Aqara D100**.
4. Enter your **Aqara Home email + password**, pick your **server region** (a Vietnam/SEA
   account uses `SEA`), and **district** (e.g. `VN`). Locks are discovered automatically.

## Verify it works (optional)

You can prove the cloud path before touching Home Assistant — `tools/cloud_test.py` runs the
exact login → discover → status flow the integration uses:

```bash
AQARA_EMAIL=you@example.com AQARA_PASSWORD='...' python3 tools/cloud_test.py
```

A green run means unlock/lock from HA will work. To prove the command end-to-end, set
`AQARA_TEST_ACTION=unlock` (or `lock`) — ⚠️ this **physically moves your real door**, so it's
off by default and requires *remote operation enabled* + hub online:

```bash
AQARA_TEST_ACTION=unlock AQARA_EMAIL=you@example.com AQARA_PASSWORD='...' python3 tools/cloud_test.py
```

## Regions

`SEA` (rpc-au) · `CN` (rpc.aqara.cn) · `US` (rpc-us) · `EU` (rpc-ger) · `KR` (rpc-kr)

## Optional: local BLE path

If your hub is offline or you want a phone-free local fallback for unlock **and** lock, the
integration can also drive the lock over **BLE** through an **ESP32 running ESPHome
`bluetooth_proxy` (active)** placed near the door — see
[`tools/esp32-d100-proxy.yaml`](tools/esp32-d100-proxy.yaml) and the integration README. The
BLE leg is reverse-engineered and the command-channel UUIDs are best-known guesses, so it's an
optional add-on; the cloud unlock works on its own.

## Notes

- Status and unlock both go through the Aqara cloud (`iot_class: cloud_polling`); the integration
  loads fine without any Bluetooth hardware.
- This is an unofficial, reverse-engineered integration. Use at your own risk; keep your real lock
  DID/MAC private.
