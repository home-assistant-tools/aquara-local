#!/usr/bin/env python3
import os, sys, time, subprocess, frida
HOST=os.environ.get("FRIDA_HOST","127.0.0.1:47777"); PKG="com.lumiunited.aqarahome.play"; DEV=os.environ.get("ADB_SERIAL","")
if not DEV: raise SystemExit("Set ADB_SERIAL=<device serial> before running this tool.")
ROOT=os.path.join(os.path.dirname(__file__),"..")
AGENT=os.path.join(ROOT,"frida","ble_cmd.js")
SUB=sys.argv[1] if len(sys.argv)>1 else "de"   # subCmd hex (de=battery, e6=status)
DATA=sys.argv[2] if len(sys.argv)>2 else ""     # data hex
def adb(*a): subprocess.run(["adb","-s",DEV,*a],capture_output=True)
notifies=[]; sess={}
def on_message(msg,data):
    if msg.get("type")=="send":
        p=msg["payload"]; t=p.get("tag")
        if t=="notify": notifies.append(p["val"]); print("[notify]",p["val"])
        elif t=="sess": sess.update(p); 
        elif t in("ready","info","FOUND","inject","err"): print(f"[{t}]",{k:v for k,v in p.items() if k!='tag'})
    elif msg.get("type")=="error": print("[ERR]",msg.get("stack",msg))
def main():
    dev=frida.get_device_manager().add_remote_device(HOST)
    pid=dev.spawn(PKG); s=dev.attach(pid); sc=s.create_script(open(AGENT).read())
    sc.on("message",on_message); sc.load(); dev.resume(pid)
    exp=sc.exports_sync if hasattr(sc,"exports_sync") else sc.exports
    time.sleep(9); adb("shell","monkey","-p",PKG,"1"); time.sleep(5)
    print("[*] mở trang khoá"); adb("shell","input","tap","160","825")
    st=None
    for i in range(45):
        time.sleep(1)
        try: st=exp.state()
        except: continue
        if st.get("hasGatt") and st.get("chr") and st.get("key") and st.get("nonce"):
            print(f"[*] SẴN SÀNG sau {i}s: key={st['key']} nonce={st['nonce']}"); break
    else: print("[!] thiếu state:",st); return
    pkt=subprocess.run(["bun","run","client/build_openlock.ts",st["key"],st["nonce"],SUB,DATA],
                       cwd=ROOT,capture_output=True,text=True).stdout.strip()
    print(f"[*] gói lệnh 01/{SUB} data={DATA!r} = {pkt}")
    notifies.clear()
    print(f"[*] >>> INJECT lệnh 01/{SUB} <<<")
    try: print("[*] inject ->",exp.inject(pkt))
    except Exception as e: print("[!] inject lỗi:",e)
    time.sleep(6)
    print("\n=== KEY/NONCE để giải mã ===")
    print("KEY",st["key"]); print("NONCE",st["nonce"])
    print("=== NOTIFY thu được (response khóa) ===")
    for h in notifies: print(" ",h)
    if not notifies: print("  (không có notify trên ff62)")
if __name__=="__main__": main()
