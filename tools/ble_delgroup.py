#!/usr/bin/env python3
import os,sys,time,subprocess,frida
HOST=os.environ.get("FRIDA_HOST","127.0.0.1:47777"); PKG="com.lumiunited.aqarahome.play"; DEV=os.environ.get("ADB_SERIAL","")
if not DEV: raise SystemExit("Set ADB_SERIAL=<device serial> before running this tool.")
ROOT=os.path.join(os.path.dirname(__file__),"..")
AGENT=os.path.join(ROOT,"frida","ble_cmd.js")
GROUP=sys.argv[1] if len(sys.argv)>1 else "04"  # groupId hex 1 byte
def adb(*a): subprocess.run(["adb","-s",DEV,*a],capture_output=True)
notifies=[]
def on_message(m,d):
    if m.get("type")=="send":
        p=m["payload"];t=p.get("tag")
        if t=="notify": notifies.append(p["val"]); print("[notify]",p["val"])
        elif t in("ready","FOUND","inject","err"): print(f"[{t}]",{k:v for k,v in p.items() if k!='tag'})
def main():
    dev=frida.get_device_manager().add_remote_device(HOST)
    pid=dev.spawn(PKG); s=dev.attach(pid); sc=s.create_script(open(AGENT).read())
    sc.on("message",on_message); sc.load(); dev.resume(pid)
    exp=sc.exports_sync if hasattr(sc,"exports_sync") else sc.exports
    time.sleep(9); adb("shell","monkey","-p",PKG,"1"); time.sleep(5)
    adb("shell","input","tap","160","825"); print("[*] mở plugin")
    st=None
    for i in range(45):
        time.sleep(1)
        try: st=exp.state()
        except: continue
        if st.get("hasGatt") and st.get("chr") and st.get("key") and st.get("nonce"):
            print(f"[*] SẴN SÀNG key={st['key']} nonce={st['nonce']}"); break
    else: print("[!] thiếu state",st); return
    pkt=subprocess.run(["bun","run","client/build_cmd.ts",st["key"],st["nonce"],"02","05",GROUP],
                       cwd=ROOT,capture_output=True,text=True).stdout.strip()
    print(f"[*] gói 02/05 DEL_USER_GROUP [{GROUP}] = {pkt}")
    print("[*] >>> INJECT xoá group <<<")
    try: print("[*] inject ->",exp.inject(pkt))
    except Exception as e: print("[!]",e)
    time.sleep(6)
    print("KEY",st["key"]);print("NONCE",st["nonce"])
    print("=== notify ==="); [print(" ",h) for h in notifies]
if __name__=="__main__": main()
