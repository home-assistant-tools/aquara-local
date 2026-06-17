# Aqara Local

**Local & cloud control of Aqara smart-home devices from Home Assistant** — without the Aqara
Open-API developer key, without OTP, and (for the lock) without any extra hardware.

You sign in with your normal **Aqara Home email + password**; the integration talks to the
Aqara cloud the same way the official app does, and (where possible) directly to your hub on
the LAN. Everything here is reverse-engineered for **interoperability with devices you own**.

> Status: early but working. **Door Lock D100** (`aqara.lock.aqgl01`) has full cloud control;
> other Aqara locks such as the **Smart Lock A100 Pro** (`aqara.lock.acn001`) are discovered and
> fully manageable from the cloud (status, users, credentials, history) — see the table for the
> per-model unlock path. The cloud/local plumbing is generic across Aqara locks and regions.

---

## Supported devices

| Device | Model | Unlock / Lock | Status & battery | Users / credentials | Notes |
|--------|-------|:---:|:---:|:---:|-------|
| **Door Lock D100** | `aqara.lock.aqgl01` | ✅ cloud (`/matter/write`) | ✅ | ✅ read; mgmt WIP | Zigbee + BLE + HomeKey lock |
| **Smart Lock A100 Pro** | `aqara.lock.acn001` | ⚠️ BLE-only (no cloud unlock) | ✅ | ✅ | Zigbee child of an E1 hub; remote unlock is BLE end-to-end, so cloud `/matter/write` is a no-op |

> Any Aqara lock whose model contains `lock`/`aqgl`/`dp1a` is auto-discovered and its cloud
> read/management features work. **Unlock differs per model**: the D100 exposes a cloud command
> (`/matter/write`); the A100 Pro only unlocks over its BLE end-to-end channel, so a remote
> cloud unlock isn't possible — the integration reports the real `lock_state` instead of a false
> success.

## Features

- 🔓 **Remote unlock & lock** through the Aqara cloud → your hub → Zigbee — the same path the
  official app's remote button uses. **No Bluetooth or ESP32 required.**
- 🔋 **Lock state, battery, availability** polled from the cloud.
- 👥 Reads users / credentials and the open/close event log.
- 🧑‍🤝‍🧑 **"Who opened the door" events** — each unlock/lock is decoded into *who* (user name)
  and *how* (fingerprint / password / NFC / key / remote / auto) and fired on the HA bus as
  `aquara_local_event`, so you can trigger automations. See [Automations](#automations--who-opened-the-door).
- 🔑 Pure email/password login (no developer account, no OTP, no `.so`).
- 🔬 **BLE** and **local-LAN (TUTK PPPP)** paths are reverse-engineered and documented, but **not
  used for control** — the lock rejects standalone BLE centrals, and the app never sends the unlock
  over the local hub channel (so its command format is unknown). **Cloud is the control path.**
  See [docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md) §3–4 for the full findings.

## Install (HACS)

1. **HACS → Integrations → ⋮ → Custom repositories** → add
   `https://github.com/duongvanba/aquara-local` as category **Integration**.
2. Install **Aqara Local**, then **restart Home Assistant**.
3. **Settings → Devices & Services → Add Integration → Aqara Local**.
4. Enter your **Aqara Home email + password** and pick the **server region** your account is
   registered in. Aqara federates login but binds your devices to one data centre, so you must
   pick the right region to see your locks (China-mainland accounts → `CN`). Locks are then
   discovered automatically.

Regions: `SEA` (rpc-au) · `CN` (**aiot-rpc.ankasa.cn** — China mainland) · `US` (rpc-us) ·
`EU` (rpc-ger) · `KR` (rpc-kr).

## Requirements

- An **Aqara Home account** that controls the device.
- For remote unlock: the lock's **remote operation enabled** and the **hub online** — the same
  condition the official app needs.

## How it works (three paths, one used)

| Path | Transport | Status |
|------|-----------|--------|
| **Cloud** ✅ | `POST /matter/write` (Aqara's Matter-shaped spec API) → hub → Zigbee | **used for control** (verified) |
| **BLE** 🔬 | Mijia/MIoT BLE `01/74` AES-CCM, cloud-assisted handshake | protocol solved; standalone GATT connect **blocked** by the lock |
| **Local (LAN)** 🔬 | TUTK PPPP/Kalay P2P tunnel to the hub | cipher + transport + login solved; **the unlock command isn't sent locally by the app** → format unknown |

> The D100 is **not** a native Matter device — `/matter/write` is Aqara's internal data model
> applied to a Zigbee lock. Details in the docs.

### Command path: cloud-only

Control is **cloud-only** by default — the reliable, verified path. BLE-direct is disabled
(`BLE_CONTROL_ENABLED=False` in `const.py`): the D100 refuses a standalone central's GATT
connection, so a BLE attempt would just hang before falling back. The local-LAN path's transport
and login are solved (pure Python, see `local.py`), but the lock *command* over the hub is
unresolved — the official app routes unlock via cloud/BLE, never the local hub channel, so there's
no command frame to reproduce. The full reverse-engineering record is in the docs.

## Automations — "who opened the door"

The integration watches the lock's event log and, for every new open/close, fires the
`aquara_local_event` event on the Home Assistant bus. It also exposes a **Last event** sensor
whose attributes carry the decoded `action` / `method` / `user` / `user_id`.

Event payload (`event_data`):

| field | example | meaning |
|-------|---------|---------|
| `did` | `lumi.xxxx` | lock device id |
| `name` | `Front Door` | lock name |
| `action` | `unlock` / `lock` | what happened |
| `method` | `fingerprint`, `password`, `nfc`, `key`, `remote`, `auto` | how it was triggered |
| `user` | `Alice` | registered user/credential name (null if unknown) |
| `user_id` | `5` | lock credential slot |
| `timestamp` | `1733400000000` | event time (ms epoch) |

Example automation — notify when a specific person unlocks with a fingerprint:

```yaml
automation:
  - alias: "Notify when Alice unlocks the front door"
    trigger:
      - platform: event
        event_type: aquara_local_event
        event_data:
          action: unlock
    condition:
      - "{{ trigger.event.data.user == 'Alice' }}"
    action:
      - service: notify.mobile_app_phone
        data:
          message: >
            {{ trigger.event.data.user }} opened {{ trigger.event.data.name }}
            via {{ trigger.event.data.method }}.
```

> **How "realtime" is it?** Events are detected by polling the lock's event log fast (~12 s,
> `EVENT_POLL_SECONDS`). True push-based BLE realtime would require holding a *persistent*
> BLE connection to the lock — which the D100 refuses to standalone centrals (it only allows the
> phone/hub to hold the link), so it isn't available via an ESP32 proxy today. The log-poll path
> works regardless of whether the open was via fingerprint, PIN, NFC, key, remote, or auto-lock.

## Documentation

- **[docs/MATTER_ADDON.md](docs/MATTER_ADDON.md)** — **software-only Matter path** (no BLE/Zigbee
  intervention): unlock via a virtual Matter switch + hub automation, and **100%-automatic
  signal-export** (every lock event/credential → a Matter sensor, incl. "who opened"). Full cloud
  API reference (commission, automation, signal-export), matter.js auto-commission, and the
  WebView-MITM technique.
- **[docs/API.md](docs/API.md)** — full technical API reference (cloud + BLE).
- **[docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md)** — the complete reverse-engineering
  journey: every tool used, the SecNeo anti-frida bypass, BLE/cloud/local protocol breakdowns,
  and the gotchas.

## Repository layout

```
custom_components/aquara_local/   The Home Assistant / HACS integration (cloud + ble + local APIs)
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
