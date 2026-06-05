# Aqara Local

**Local & cloud control of Aqara smart-home devices from Home Assistant** — without the Aqara
Open-API developer key, without OTP, and (for the lock) without any extra hardware.

You sign in with your normal **Aqara Home email + password**; the integration talks to the
Aqara cloud the same way the official app does, and (where possible) directly to your hub on
the LAN. Everything here is reverse-engineered for **interoperability with devices you own**.

> Status: early but working. **Currently supports the Aqara Door Lock D100** (`dp1a` /
> `aqara.lock.aqgl01`). More Aqara devices may follow — the cloud/local plumbing is generic.

---

## Supported devices

| Device | Unlock / Lock | Status & battery | Users / credentials | Notes |
|--------|:---:|:---:|:---:|-------|
| **Door Lock D100** | ✅ cloud (BLE fallback) | ✅ | ✅ read; mgmt WIP | Zigbee + BLE + HomeKey lock |

## Features

- 🔓 **Remote unlock & lock** through the Aqara cloud → your hub → Zigbee — the same path the
  official app's remote button uses. **No Bluetooth or ESP32 required.**
- 🔋 **Lock state, battery, availability** polled from the cloud.
- 👥 Reads users / credentials and the open/close event log.
- 📡 Optional **BLE** path (via an ESP32 ESPHome `bluetooth_proxy`) and a documented **local LAN**
  path for the truly offline-minded — see the docs below.
- 🔑 Pure email/password login (no developer account, no OTP, no `.so`).

## Install (HACS)

1. **HACS → Integrations → ⋮ → Custom repositories** → add
   `https://github.com/duongvanba/aquara-local` as category **Integration**.
2. Install **Aqara Local**, then **restart Home Assistant**.
3. **Settings → Devices & Services → Add Integration → Aqara D100**.
4. Enter your **Aqara Home email + password**, pick the **server region** (Vietnam/SEA → `SEA`)
   and **district** (e.g. `VN`). Locks are discovered automatically.

Regions: `SEA` (rpc-au) · `CN` (rpc.aqara.cn) · `US` (rpc-us) · `EU` (rpc-ger) · `KR` (rpc-kr).

## Requirements

- An **Aqara Home account** that controls the device.
- For remote unlock: the lock's **remote operation enabled** and the **hub online** — the same
  condition the official app needs.

## How it works (three paths)

| Path | Transport | Needs |
|------|-----------|-------|
| **Cloud** | `POST /matter/write` (Aqara's Matter-shaped spec API) → hub → Zigbee | internet + hub |
| **BLE** | Mijia/MIoT BLE `01/74` AES-CCM, cloud-assisted handshake | ESP32 `bluetooth_proxy` |
| **Local (LAN)** | TUTK PPCS P2P tunnel to the hub, same command on-LAN | cloud-issued P2P creds |

> The D100 is **not** a native Matter device — `/matter/write` is Aqara's internal data model
> applied to a Zigbee lock. Details in the docs.

## Documentation

- **[docs/API.md](docs/API.md)** — full technical API reference (cloud + BLE).
- **[docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md)** — the complete reverse-engineering
  journey: every tool used, the SecNeo anti-frida bypass, BLE/cloud/local protocol breakdowns,
  and the gotchas.

## Repository layout

```
custom_components/aqara_d100/   The Home Assistant / HACS integration (cloud + ble + local APIs)
docs/                           API reference + reverse-engineering write-up
app/                            Research React-Native app (Expo) — optional
client/  tools/                 TypeScript client + RE / test tooling — optional
```

## Disclaimer

Unofficial, community project. Use only with **devices you own** (legal interoperability). It is
not affiliated with or endorsed by Aqara/Lumi. No warranty — a door lock is safety-critical;
test carefully. Do not redistribute the Aqara APK.

## License

MIT — see [LICENSE](LICENSE).
