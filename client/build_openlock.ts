import { AquaraLock } from "./AquaraLock";
import { hexToBytes, bytesToHex } from "./hex";
const [key, nonce, subHex="74", dataHex="01"] = process.argv.slice(2);
const lock = new AquaraLock({ sessionKey: hexToBytes(key), nonce: hexToBytes(nonce) }, {} as any);
console.log(bytesToHex(lock.packShort(0x01, parseInt(subHex,16), hexToBytes(dataHex))));
