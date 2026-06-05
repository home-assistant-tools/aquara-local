import { aesCcmDecrypt } from "../client/crypto";
import { hexToBytes, bytesToHex } from "../client/hex";
const key=hexToBytes(process.argv[2]); const nonce=hexToBytes(process.argv[3]);
for(const r of process.argv.slice(4)){
  const b=hexToBytes(r); const main=b[0]; const ct=b.slice(1);
  try{ const pt=aesCcmDecrypt(key,nonce,ct,4);
    console.log(`main=0x${main.toString(16)}  plain=${bytesToHex(pt)}  subCmd=0x${pt[0].toString(16)} data=${bytesToHex(pt.slice(1,Math.max(1,pt.length-2)))}`);
  }catch(e){ console.log(`main=0x${main.toString(16)}  ${r}  DECRYPT FAIL (MIC) — nonce response khác nonce TX`); }
}
