import { AquaraLock } from "./AquaraLock";
import { hexToBytes, bytesToHex } from "./hex";
const [key, nonce, mainHex, subHex, dataHex=""] = process.argv.slice(2);
const lock = new AquaraLock({ sessionKey: hexToBytes(key), nonce: hexToBytes(nonce) }, {} as any);
console.log(bytesToHex(lock.packShort(parseInt(mainHex,16), parseInt(subHex,16), hexToBytes(dataHex))));
