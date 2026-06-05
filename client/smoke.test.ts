import { aqaraSign } from "./crypto";
import { mijiaCrc16 } from "./crc16";
import { AquaraLock, packPin, getDaysMask } from "./AquaraLock";
import { bytesToHex, hexToBytes } from "./hex";
import type { BleClient, Unsubscribe } from "./BleClient";

// 1) sign khớp test vector (token = placeholder, KHÔNG phải token thật)
const s = aqaraSign({ nonce: "0B0187075D766E314F84651064EAA9F5", time: "1780500326614", token: "EXAMPLE_TOKEN_NOT_REAL" });
console.log("sign:", s, s === "dc78a059a00cb04b40f3bb94f5165c96" ? "OK ✅" : "FAIL ❌");

// 2) CRC16 chạy
console.log("crc16(010774):", bytesToHex(mijiaCrc16(hexToBytes("010774"))));

// 3) pack/unpack round-trip với sessionKey/nonce giả
const ble = {
  connect: async () => {}, disconnect: async () => {},
  send: async () => {}, listen: async (): Promise<Unsubscribe> => () => {},
  request: async () => new Uint8Array(),
} as unknown as BleClient;
const lock = new AquaraLock({ sessionKey: hexToBytes("00112233445566778899aabbccddeeff"), nonce: hexToBytes("0102030405060708090a0b0c0d") }, ble);
const pkt = lock.packShort(0x01, 0x74, Uint8Array.of(0x01)); // mở khoá
const back = lock.unpack(pkt);
console.log("pack openLock:", bytesToHex(pkt));
console.log("unpack:", "main", back.mainCmd.toString(16), "sub", back.subCmd.toString(16), "data", bytesToHex(back.data),
  back.subCmd === 0x74 && bytesToHex(back.data) === "01" ? "OK ✅" : "FAIL ❌");

// 4) helpers
console.log("packPin(1234):", bytesToHex(packPin("1234").bytes), "digits", packPin("1234").digits);
console.log("getDaysMask T2+T6 (Mon,Fri):", "0x" + getDaysMask([true,false,false,false,true,false,false]).toString(16));
