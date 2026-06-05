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
| **BLE** | MIoT/Mijia BLE: cloud handshake → `01/74` AES-CCM openLock over GATT | an ESP32 ESPHome `bluetooth_proxy` near the door | 🟡 protocol solved; standalone GATT connect is blocked by the lock (piggyback works) |
| **Local** | TUTK PPCS P2P tunnel to the hub on the LAN, carrying the same Matter command | cloud-issued P2P creds (cacheable) + a TUTK PPCS backend | 🔬 fully mapped; transport needs the TUTK cipher |

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

**Gotcha:** a *standalone* central (ESP32/laptop) connecting to the lock is **rejected** by the
lock — the proven unlock used **piggyback injection** into the app's existing GATT link
(`frida/ble_inject.js`). The ESP32 proxy path also needs the lock to accept a fresh connection
(blocked when the phone holds the link). Implementation: `custom_components/aqara_d100/{ble,
gatt,protocol,crypto}.py` + `tools/ble_esp32_test.py` + `tools/esp32-d100-proxy.yaml`.

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

### 4.5 The full local stack (solved)

```
Layer 1  Matter command   {"2.148.35011.0":""}                         (from RN bundle)
Layer 2  "lumi" frame      b"lumi" + type(4) + seq(4) + len(4) + payload (login type 0x1000)
Layer 3  TUTK PPCS         cs2p2p__P2P_Proprietary_Encrypt(KEY, plaintext) → UDP "28…" to hub
```

- **PPCS cipher key** = the part after `:` in `p2p_info().initStringApp`, e.g. `<ppcs-key>`
  (a second TUTK base key `<tutk-base-key>` is used for the session layer — the CVE-2021-28372
  Kalay key). Confirmed by hooking `cs2p2p__P2P_Proprietary_Encrypt` (key + plaintext↔ciphertext
  pairs; the 252-byte login plaintext encrypts to the exact `28d77f…` wire frame).
- **Login JSON** (`{app_public_key, app_sign, device_id, timestamp}`) — `app_sign` is **issued by
  the cloud**, NOT computed locally (a Java stacktrace put the builder right after a Retrofit
  call). Two cloud calls supply everything:
  - `GET /devex/camera/p2p/info?did=…` → `initStringApp` (=`<init>:<ppcs-key>`), `p2pId`
    (TUTK DID e.g. `AQARAKR-XXXXXX-XXXXX`), `devP2pPublicKey`.
  - `POST /devex/camera/p2p/sign {did, p2pAppPublicKey, devPwd:""}` → `{sign}` = `app_sign`.
- **On the LAN there is no NAT** → none of PPCS's hole-punching / supernode / relay machinery is
  needed; it's direct UDP to `hub:port`.

So a fully-local unlock = 3 cloud calls (cacheable) for the session creds + a PPCS tunnel that
encrypts the lumi-framed Matter command with key `<ppcs-key>`. Implemented as far as possible
in `custom_components/aqara_d100/local.py`; the remaining piece is a `PpcsTransport` backend
(the TUTK cipher — callable via frida `NativeFunction`, or reimplemented from the Kalay research).

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
- PPCS keys: `<ppcs-key>` (device channel) + `<tutk-base-key>` (TUTK base / Kalay).
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
