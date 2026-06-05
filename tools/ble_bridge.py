#!/usr/bin/env python3
# Driver điều khiển BLE-bridge (frida/ble_bridge.js) trên điện thoại để nói chuyện BLE với khoá D100.
# Spawn app Aqara qua hluda → bridge tạo GATT riêng tới khoá → ta gọi RPC connect/write/notify.
import os, sys, time, threading, frida

HOST = os.environ.get("FRIDA_HOST", "127.0.0.1:47777")
PKG = "com.lumiunited.aqarahome.play"
AGENT = os.path.join(os.path.dirname(__file__), "..", "frida", "ble_bridge.js")
LOCK_MAC_RAW = os.environ.get("LOCK_MAC", "")
if not LOCK_MAC_RAW:
    raise SystemExit("Set LOCK_MAC=<lock BLE MAC hex> before running this tool.")
LOCK_MAC = ":".join(LOCK_MAC_RAW[i:i+2] for i in range(0, 12, 2))

scan_results = {}
_boot = threading.Event()

def on_message(msg, data):
    if msg.get("type") == "send":
        p = msg["payload"]
        tag = p.get("tag")
        if tag == "boot":
            print("[bridge] READY"); _boot.set()
        elif tag == "scan":
            scan_results[p["addr"]] = p
        elif tag == "notify":
            print(f"[NOTIFY] {p['uuid'][:8]}  {p['hex']}")
        elif tag == "services":
            print(f"[services] {len(p['svcs'])} service:")
            for s in p["svcs"]:
                print(f"  svc {s['uuid']}")
                for c in s["chars"]:
                    print(f"     char {c['uuid']}  props=0x{c['props']:02x}")
        else:
            print(f"[{tag}] " + " ".join(f"{k}={v}" for k, v in p.items() if k != "tag"))
    elif msg.get("type") == "error":
        print("[JS-ERROR]", msg.get("stack", msg))

def main():
    dev = frida.get_device_manager().add_remote_device(HOST)
    pid = dev.spawn(PKG)
    print(f"[*] spawned {PKG} pid={pid}")
    session = dev.attach(pid)
    script = session.create_script(open(AGENT).read())
    script.on("message", on_message)
    script.load()
    dev.resume(pid)
    # KHÔNG foreground: tránh app tự nối BLE tới khoá (chiếm kết nối → 133 cho ta)

    if not _boot.wait(25):
        print("[!] bridge không ready sau 20s"); return
    exp = script.exports_sync if hasattr(script, "exports_sync") else script.exports

    # 1) SCAN tìm khoá
    print("[*] scan BLE 8s ...")
    exp.scan(8)
    mac_fwd = LOCK_MAC_RAW.lower()
    mac_rev = "".join(reversed([mac_fwd[i:i+2] for i in range(0, 12, 2)]))  # LE
    mac_rev_addr = ":".join(mac_rev[i:i+2] for i in range(0, 12, 2)).upper()
    print(f"[*] thấy {len(scan_results)} thiết bị (mac={mac_fwd} / addr MiOT={mac_rev_addr}):")
    # Rank: DP1A (MiOT) > addr đảo = MiOT > tên aqara/lock (HAP, kém ưu tiên)
    def rank(addr, p):
        name = (p.get("name") or "").lower()
        if name == "dp1a":
            return 0
        if addr.upper() == mac_rev_addr or addr.replace(":", "").lower() == mac_fwd:
            return 1
        if any(k in name for k in ("lumi", "aqara", "lock", "aqgl")):
            return 3
        return 9
    cands = sorted(((rank(a, p), a, p) for a, p in scan_results.items()), key=lambda x: x[0])
    for r, addr, p in cands:
        if r < 9:
            print(f"    [{r}] {addr}  rssi={p.get('rssi')}  name={p.get('name')!r}")
    targets = [a for r, a, p in cands if r < 9]
    if not targets:
        print("[!] KHÔNG thấy khoá trong scan")
    # chỉ nhắm DP1A (MiOT). EB:87 là HAP → khoá đá ra.
    dp1a = next((a for r, a, p in cands if (p.get("name") or "").lower() == "dp1a"), None)
    targets = [dp1a] if dp1a else targets
    print(f"[*] target = {targets}")

    try:
        con = exp.connected()
        print(f"[*] GATT đang kết nối sẵn (app giữ?): {con}")
    except Exception as e:
        print("[!] connected() err:", e)

    addr = targets[0] if targets else LOCK_MAC
    # 1b) thử BOND trước (giả thuyết khoá đòi pairing mới phục vụ discovery)
    try:
        st = exp.bondState(addr)
        print(f"[*] bondState({addr}) = {st} (10=none 12=bonded)")
        if st != 12:
            print("[*] createBond ...")
            exp.createBond(addr)
            for _ in range(10):
                time.sleep(1)
                st = exp.bondState(addr)
                if st == 12:
                    break
            print(f"[*] bondState sau = {st}")
    except Exception as e:
        print("[!] bond err:", e)

    time.sleep(1.0)
    # 2) CONNECT (resolve khi connected) → POLL services() trực tiếp
    svcs = None
    for attempt in range(1, 6):
        print(f"[*] connect {addr} (lần {attempt}) ...")
        try:
            exp.connect(addr, False)  # resolve khi newState=2
            print(f"[*] CONNECTED — poll services()...")
            for k in range(12):
                time.sleep(0.6)
                svcs = exp.services()
                if svcs:
                    break
            if svcs:
                print(f"[*] SERVICES ✅ {len(svcs)}:")
                for s in svcs:
                    print(f"  svc {s['uuid']}")
                    for c in s["chars"]:
                        print(f"     char {c['uuid']}  props=0x{c['props']:02x}")
                break
            else:
                print("[!] connected nhưng services rỗng (discovery không xong)")
        except Exception as e:
            print(f"[!] connect FAIL lần {attempt}:", e)
        time.sleep(1.2)
    # giữ phiên để nhận notify / cho lệnh tiếp theo
    secs = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    print(f"[*] giữ phiên {secs}s ...")
    time.sleep(secs)
    try: exp.disconnect()
    except Exception: pass

if __name__ == "__main__":
    main()
