# Aqara Door Lock D100 — Reverse-Engineering Journey

How the **Aqara D100** (`dp1a` / model `aqara.lock.aqgl01`) was reverse-engineered to control
it from Home Assistant over **three independent paths** — Cloud, BLE, and Local (LAN). This is
the engineering log: what was tried, the dead ends, every tool used, and the gotchas.

> Device facts: D100 = **Zigbee + BLE + Apple HomeKey**. It is **NOT** a native Matter device
> (`isMatterDevice: false` in the app). It reaches HomeKit through an **Aqara G410** hub over
> Zigbee. Lock DID used below: `lumi.<LOCK_ID>`.

---

## 0. The three control paths (TL;DR)

| Path | How it works | Needs | Status |
|------|--------------|-------|--------|
| **Cloud** | `POST /matter/write {data:{"2.148.35011.0":""},did,…}` → Aqara cloud → hub → Zigbee | internet + hub online + "remote operation" enabled | ✅ **works, shipped** |
| **BLE** | MIoT/Mijia BLE: cloud handshake → `01/74` AES-CCM openLock over GATT | an ESP32 ESPHome `bluetooth_proxy` near the door | 🟡 protocol solved; **standalone GATT connect is blocked by the lock** (it only accepts a central already bonded to the phone — see §3) |
| **Local** | TUTK PPPP/Kalay P2P tunnel to the hub on the LAN, carrying the same Matter command | cloud-issued P2P creds (cacheable) + LAN reachability to the hub | ✅ **WORKS — verified live**: pure-Python (cipher + PPPP transport), no `.so`/frida/phone; the D100 physically unlocked (`{"code":"0"}`) |

All three ultimately deliver the **same command**: Matter DoorLock trait `2.148.35011.0 = ""`.

---

## 1. Toolbox (everything used)

| Tool | Used for |
|------|----------|
| **mitmproxy / mitmdump** | HTTPS capture of the Aqara cloud API (login, sign, matter/write, p2p creds) |
| **Frida** (client `16.4.8`) | Native + Java hooking of the packed app |
| **hluda-server** | **Stealth frida-server** that evades the app's SecNeo anti-frida (key trick!) |
| **frida-dexdump** | Dump the runtime-decrypted DEX (app is SecNeo-packed; static jadx is useless) |
| **adb** | Drive the phone: launch app, taps, screencaps, `tcpdump`, `iptables`, proxy settings |
| **tcpdump** (on phone) | Capture the local hub UDP traffic |
| **tshark / Wireshark** | Analyse the hub pcaps (conversations, protocol hierarchy, payloads) |
| **aioesphomeapi** | Talk to the ESP32 BLE proxy from a laptop (ESPHome native API) |
| **bleak / bleak-retry-connector** | BLE GATT (via the proxy / HA bluetooth stack) |
| **pynacl / pysodium** | Offline libsodium experiments (X25519 / secretbox decrypt attempts) |
| **nm / strings / file** | Inspect native libs (`libPPCS_API.so`, `libsodiumjni.so`, `libaqara_ed.so`) |
| **HomeAssistant (venv)** | `tools/validate_ha_integration.py` — load-validate the integration |
| Python `hashlib`, RSA by hand | Reimplement login password encryption + the `sign` header |

Repo layout of the RE assets: `frida/` (hooks), `mitm/` (proxy + SSL-unpin), `captures/`
(pcaps, MITM flows, findings), `tools/` (test scripts, `esp32-d100-proxy.yaml`, frida-servers).

---

## 2. Cloud API

### 2.1 Login (email/password) — pure JS, no `.so`
- `POST /app/v1.0/lumi/user/guard-code/login` with body
  `{account, district, encryptType:2, guardCode:"", password:<enc>}`.
- **password** = `base64( RSA/ECB/PKCS1( ascii_of( MD5(password).hexdigest() ) ) )` using a
  **constant RSA-1024 public key** baked into the app (`getCert()`).
- No OTP, server does **not** require the `x-aes128gcm` body encryption → plain JSON works.
- Returns `{token, userId, nickName}`.

### 2.2 The `sign` request header
Every call carries `sign = MD5( "Appid=…&Nonce=…&Time=…[&Token=…][&<body>]&<APPKEY>" )`.
- **Drop the `&Token=` segment entirely when the token is empty** (login). This was the one
  non-obvious detail (found by hooking the native Rust `getSignHead`).
- `APPID=<APPID — see const.py>`, `APPKEY=<APPKEY — see const.py>`.
- Verified byte-for-byte against the app (`tools/aqara_sign.py`), 5/5 samples.

### 2.3 Control = a "Matter" trait write (but it's NOT real Matter)
Decoded from the lock's **React Native plugin bundle** (`CommandSpec`). Aqara uses a
Matter-*shaped* internal data model (`matterFabrics`, `MatterDomain`, `/matter/write`) for all
devices, even Zigbee ones — the numbers are **Aqara-proprietary spec IDs**, not standard Matter.

`POST /matter/write {"data":{"<ep.fn.cmd.0>":<value>},"did":did,"pwd":"","type":0}`

| Command | trait | | Command | trait |
|---|---|---|---|---|
| unlock | `2.148.35011.0` ✅ | | setUser | `2.148.40032.0` |
| lock | `2.148.35010.0` ✅ | | clearUser | `2.148.40034.0` |
| unbolt | `2.148.40031.0` | | setCredential | `2.148.40035.0` |
| identify | `1.131.32918.0` | | set/get/clear week/year schedule | `2.148.40025‑40030` |

lockState trait value: `1`=locked, `2`=unlocked, `0`=latch-error. Unlock value `""` (empty).
Verified live 3/3 (`{"result":"","code":0,"message":"Success"}`).

### 2.4 Other endpoints captured
`/res/query` (status), `/res/subscribe`, `/app/lock/res/history/query` (open log),
`/dev/lock/query` (credentials), `/dev/lock/user/group/*`, `/dev/lock/user/del`,
`/dev/lock/update/name`, and the two P2P-credential calls (see §4.5).

### 2.5 Note: `enable_remote_operation`
Remote control only works if `enable_remote_operation == "1"` on the lock **and** the hub is
online. The dashboard quick-toggle prefers cloud; the lock-detail "hold to unlock" prefers BLE.

---

## 3. BLE API

The app uses **Xiaomi MIoT / Mijia BLE + AES-CCM**. Decoded 100% (`frida/hook_crypto.js`
hooking `EncryptModule.encryptAESCCM`) — the self-built openLock packet matched the real one.

- **Handshake channel** `0xffb1`(write)/`0xffb2`(notify): AIOT RegLogin frames `5a …`.
  The cloud computes the ECDH: `publickey`(0610) → device pubkey → `verify`(0710) →
  `{sessionKey, nonce, verifyData}`.
- **Command channel** `f2042ffd-…` (`ff61` write / `ff62` notify): `mainCmd ‖ AES-CCM(subCmd ‖
  data ‖ CRC16-BE)`, MIC=4, expandedIv="", nonce-direct.
- **Unlock = `01`(SYSTEM)/`74`(BLE_OPEN_LOCK)** data `[opType]` (open=`01`, close=`00`,
  unbolt=`02`). ⚠️ NOT `18`(UN_LOCK) — that's just `setUnlockAlarmInfo`.
- CRC is appended **byte-swapped** (openLock plaintext = `7401`**`f404`**).

**Gotcha (confirmed by live test 2026-06):** a *standalone* central (ESP32 proxy/laptop) **cannot
even open the GATT connection** to the lock. Via a working ESP32 `bluetooth_proxy` we could scan
and see the lock's advert clearly (addr `…` RSSI −60), but `bluetooth_device_connect` **times out
at the link layer** — the lock never answers the CONNECT — *even with the phone's Bluetooth fully
off*. So it is **not** "the phone holds the link"; the lock **filters connections to centrals it
has bonded** (the phone that paired at setup, holding the SMP **LTK/IRK**). Connection happens
*before* pairing, so an unbonded ESP32 is dropped before any handshake. The proven unlock therefore
used **piggyback injection** into the app's *already-open* GATT link (`frida/ble_inject.js`).
Bottom line: BLE-direct control needs the phone's bond material; **use Cloud or Local instead.**
Two more findings from that test, folded into the code:
- The cloud reports the lock MAC **byte-reversed** vs the BLE advert address (cloud `5A58004D56ED`
  ↔ advert `ED:56:4D:00:58:5A`). `tools/ble_esp32_test.py` now matches both orders.
- esphome 2026.x dropped *parsed* adverts → use `subscribe_bluetooth_le_raw_advertisements`; and
  `bluetooth_device_connect` requires passing the proxy's `feature_flags` (REMOTE_CACHING).
Implementation: `custom_components/aquara_local/{ble,gatt,protocol,crypto}.py` +
`tools/ble_esp32_test.py` + `tools/esp32-d100-proxy.yaml`.

---

## 4. Local (LAN) path — the long hunt

This was the hard one. Chronological:

1. **WARP blocked the LAN.** Cloudflare WARP split-tunnel `!`-rejects the `/24`; the ESP/hub were
   unreachable until `warp-cli disconnect` (or pin a `/32` via en0).
2. **ESP32 proxy worked for scanning** but esphome 2026.x dropped the *parsed* advert API — must
   use `subscribe_bluetooth_le_raw_advertisements`. Found the lock advertises **two** BLE
   addresses: `EB:87…` "Aqara Smart Door Lock 8459" (HomeKit) and `ED:56…` "DP1A" (Mijia).
3. **aioesphomeapi gotcha:** `bluetooth_device_connect` needs `feature_flags=` passed explicitly
   (newer lib), else `REMOTE_CACHING` error. After that, GATT connect to the lock still timed out
   (lock rejects standalone central — see §3).
4. **Discovery it isn't TCP.** Sniffing the hub showed the local control is **UDP**, not TCP — so
   `netstat -tn` saw "nothing". Same framing as expected: `28 [handle] [seq] [cipher]`.
5. **Anti-frida wall (SecNeo).** The app is packed with SecNeo/Bangcle (`libDexHelper.so`). A
   normal `frida` attach → the app kills frida-server. **Solution: `hluda` stealth server +
   SPAWN mode** (hook before anti-frida initialises). Also: client frida must match hluda (16.4.8).
   Critically, with a *detectable* frida-server the app behaves defensively and **won't even open
   the local hub connection** — with hluda it runs normally.
6. **libsodium handshake.** Hooking `org.libsodium.jni.SodiumJNI` caught
   `crypto_box_keypair` + `crypto_box_beforenm` → an **X25519 shared key** + the **hub's static
   public key** (`8b82b4a6…`). But the per-message encrypt never called any libsodium export →
   it was a red herring / a different layer.
7. **It's TUTK PPCS.** Hooking libc `sendto` with a backtrace showed **all** local hub traffic
   goes through **`libPPCS_API.so`** — ThroughTek's **Kalay P2P** SDK (the doorbell-camera P2P
   stack, reused for the hub's local channel). Hooking the JNI `PPCS_Write` exposed the
   **plaintext** before encryption.

### 4.5 The full local stack (SOLVED — reimplemented in pure Python)

```
Layer 1  Matter command   {"2.148.35011.0":""}                          (from RN bundle)
Layer 2  "lumi" frame      b"lumi" + type(4 LE) + seq(4 LE) + len(4 LE) + payload
Layer 3a TUTK cipher       ppcs_encrypt(key="aqarakr19kn", plaintext) → "28…" bytes
Layer 3b TUTK PPPP/UDP     F1 <type> <len:2 BE> <payload>  →  UDP datagram to hub:port
```

Everything below is implemented and unit-verified byte-for-byte against the real capture in
`custom_components/aquara_local/local.py` (no `.so`, no frida, no phone needed at run time).

**Layer 3a — the cipher (`cs2p2p__P2P_Proprietary_Encrypt`)**, reversed from `libPPCS_API.so`
(aarch64, fn @`0x192ec`). It's a self-synchronising (CFB-style) stream cipher over a fixed
256-byte table at file offset `0x10838` (the public "Kalay" constant — embedded as `PPCS_TABLE`):

```
seeds = [ sum(key)&0xff, (-sum(key))&0xff, (Σ (b*0xAB)>>9)&0xff, (xor key)&0xff ]
out[0]   = TABLE[ sum(key)&0xff ] ^ in[0]
out[i>0] = TABLE[ (seeds[fb & 3] + fb) & 0xff ] ^ in[i]      # fb = ciphertext byte i-1
```
(decrypt is identical but feeds back the *input* byte.) Key = the part after `:` in
`p2p_info().initStringApp`, here **`aqarakr19kn`**. The TUTK session-layer base key
**`SSD@cs2-network.`** (CVE-2021-28372 Kalay default) is a public constant. **Verified 9/9** vs
captured plaintext↔ciphertext pairs (lengths 4/8/20/24/40), incl. the 252-byte login → exact
`28d77f766e8d11…` wire frame.

**Layer 3b — the PPPP/Kalay transport** (`PpcsUdpTransport`), decoded from
`captures/hub/hub_local_udp_session.pcap`. Packet = `F1 <type> <len:2 BE> <payload>`, and **every
datagram is wrapped by the Layer-3a cipher**. Message types observed/used:

| type | name | direction | notes |
|------|------|-----------|-------|
| `0x41` | `MSG_PUNCH_PKT` | app→hub | LAN connect/announce; payload = encoded DID |
| `0x42`/`0x43` | `MSG_P2P_RDY`/`_ACK` | hub→app | session is up |
| `0xd0` | `MSG_DRW` | both | reliable data; body `D1 <chan> <index:2 BE> <lumi>` |
| `0xd1` | `MSG_DRW_ACK` | both | body `D1 <chan> <count:2> <index:2>×count` |
| `0xe0`/`0xe1` | `MSG_ALIVE`/`_ACK` | both | keepalive |
| `0xf0` | `MSG_CLOSE` | app→hub | teardown |

- **DID encoding** (`encode_p2p_did`): `AQARAKR-XXXXXX-XXXXX` → `prefix(8B ascii+NUL) ‖ number(4B
  BE) ‖ suffix(8B ascii+NUL)` = `41514152414b5200 000176bd 4a454e464b000000` (`0x000176bd` = 95933).
- **Channels**: `0x00` = lumi command/control; `0x04` = bulk data (1032-B frames, e.g. device list).
- **Handshake**: PUNCH → RDY → `MSG_DRW(chan0, idx0)` = lumi LOGIN (retransmit until DRW_ACK; hub
  replies lumi `{"code":0,"message":"success"}`) → `MSG_DRW(chan0, idxN)` = lumi Matter command.
- **Login JSON** `{app_public_key, app_sign, device_id, timestamp}` — `app_sign` is **cloud-issued**
  (stacktrace put the builder right after a Retrofit call). Two cacheable cloud calls supply it:
  - `GET /devex/camera/p2p/info?did=…` → `initStringApp` (=`<init>:aqarakr19kn`), `p2pId`
    (TUTK DID `AQARAKR-XXXXXX-XXXXX`), `devP2pPublicKey` (hub static X25519 pubkey).
  - `POST /devex/camera/p2p/sign {did, p2pAppPublicKey, devPwd:""}` → `{sign}` = `app_sign`.
- **On the LAN there is no NAT** → none of PPPP's hole-punching / supernode / relay machinery is
  needed; direct UDP to `hub:port`.

**So a fully-local unlock** = 2 cloud calls (cacheable) for the session creds + the pure-Python
`PpcsUdpTransport` driving the cipher'd PPPP handshake and the lumi Matter command. Code:
`local.py` (`ppcs_encrypt`, `build_drw`, `encode_p2p_did`, `PpcsUdpTransport`, `prepare_local_session`).

✅ **VERIFIED LIVE (2026-06)** — the D100 physically unlocked over this pure-Python path. The full
recipe, all confirmed against the real hub:
1. `did_hub` = the device that owns the P2P stream (here the **G410 doorbell** `lumi.camera.agl006`,
   not the Zigbee lock — the lock answers `p2p/info` with `code=1730`). Find it by probing `p2p/info`.
2. `GET /devex/camera/p2p/info?did=did_hub` → `initStringApp` (=`<init>:aqarakr19kn`), `p2pId`.
3. ephemeral X25519 keypair → `POST /devex/camera/p2p/sign {did_hub, p2pAppPublicKey, devPwd:""}`
   → `{sign, time}`. **The login `timestamp` MUST equal that `time`** (app_sign covers pubkey+time;
   a local clock value gets `{"code":-1}`).
4. **LAN discovery**: send a *ciphered* `MSG_LAN_SEARCH` (`enc(F1 30 0000)`) to `hub:32108`; the hub
   replies from a **fresh, per-session UDP port** — use that port (a bare PUNCH to 32108 is ignored).
5. PUNCH that port → ready; `MSG_DRW(chan0, idx0)` = lumi **LOGIN** type 0x1000 → `{"code":0}`.
6. `MSG_DRW(chan0, idx1)` = lumi **type 0x1020** carrying the cloud `/matter/write` body
   `{"data":{"2.148.35011.0":""},"did":lock_did,"pwd":"","type":0}` → `{"code":"0"}` and the lock opens.
   (Only lumi type **0x1020** runs the trait + returns the full RPC `{"state":"end"}`; other types
   reply `"unsupport cmd"`.)

Test tool: `tools/local_hub_test.py` (`--dry` = login only; `--op open/close`).

---

## 5. Defeating SecNeo anti-frida (reusable recipe)

```bash
# 1. push + run the STEALTH server (NOT plain frida-server — it gets detected & killed)
adb push tools/hluda-server /data/local/tmp/.sysmon2579
adb shell "su -c '/data/local/tmp/.sysmon2579 -l 0.0.0.0:47777'"     # keep this alive
adb forward tcp:47777 tcp:47777
pip install "frida==16.4.8"           # client MUST match hluda's version

# 2. SPAWN (never attach) so hooks land before anti-frida runs; seconds>0 keeps the session
FRIDA_HOST=127.0.0.1:47777 FRIDA_SPAWN=com.lumiunited.aqarahome.play \
  python frida/run.py frida/<hook>.js 600
adb shell monkey -p com.lumiunited.aqarahome.play 1   # foreground to load classes
```
- Native hooks (`Interceptor.attach`) and `Java.perform` both work under spawn+hluda.
- For functions that are tiny export thunks (TUTK `PPCS_*`), hook the **JNI** entry
  (`Java_com_p2p_pppp_1api_PPCS_1APIs_PPCS_1Write`) instead.

---

## 6. Frida hooks written (in `frida/`)

| Hook | Purpose |
|------|---------|
| `hook_crypto.js` | BLE LumiDevSDK AES-CCM (sessionKey, plaintext↔ciphertext) |
| `hook_sendto.js` | libc `sendto`/`recvfrom` + backtrace → found PPCS as the transport |
| `hook_ppcs.js` | TUTK `PPCS_Write/Read` JNI → **plaintext** lumi frames (login JSON, commands) |
| `hook_ppcs_crypto.js` | `cs2p2p__P2P_Proprietary_Encrypt` → **the PPCS key + cipher pairs** |
| `hook_sign.js` / `hook_sign2.js` | libsodium MAC + Java `Mac`/`MessageDigest` (app_sign hunt — negative) |
| `hook_sign3.js` | Java stacktrace at `PPCS_Write` → located the login builder (`P2pCameraApiV2`) |
| `hook_sodium*.js`, `hook_local_*.js` | libsodium handshake capture (X25519 shared key, hub pubkey) |
| `ssl_unpin_native.js` (in `mitm/`) | Native BoringSSL/Conscrypt unpin to MITM the cloud (evades SecNeo) |

---

## 7. Key facts & secrets (for this account/device)

- Lock DID `lumi.<LOCK_ID>`; doorbell/P2P DID `lumi3.<P2P_DID>`,
  TUTK `p2pId` `AQARAKR-XXXXXX-XXXXX`.
- Hub G410 static X25519 pubkey `<hub-x25519-pubkey>`.
- PPCS keys: `aqarakr19kn` (device channel) + `SSD@cs2-network.` (TUTK base / Kalay).
- App creds: `APPID <APPID — see const.py>`, `APPKEY <APPKEY — see const.py>`.

> ⚠️ Keep real DIDs / keys / account out of any public commit; the values above are this test
> rig's and are documented here only as a worked example.

---

## 8. Gotchas / lessons learned

- **Read the RN bundle first.** The app is React Native; the lock plugin bundle
  (`/data/data/.../files/lumi/reactnative/bundle/aqara.lock.aqgl01/…main.bundle`) is plain
  (minified) JS and revealed the entire command set in minutes — *after* days of native RE.
- **"Matter" is a naming red herring** — it's Aqara's internal data model, not real Matter.
- **Local hub is UDP** (check `netstat -u` / tcpdump, not `-tn`).
- **A detectable frida-server changes app behaviour** (it stops opening the local connection) —
  always use hluda for behavioural fidelity, not just to avoid crashes.
- **The lock rejects standalone BLE centrals** — only piggyback injection or the proxy-with-the-
  phone-away works.
- **`app_sign` and the PPCS key are cloud-issued**, mirroring the BLE pattern: the "local" path
  is really *cloud-assisted-then-local*. Cache the creds to minimise cloud dependence.
- **Phone hygiene during capture:** `svc power stayon true` (Samsung secure keyguard blocks
  `input` PIN entry, so don't let it lock); `settings put global http_proxy :0` to restore.
