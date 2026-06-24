#!/usr/bin/env tsx
// Probe: login → liệt kê hub Matter (did/model/home) + fabricId + compressed-fabric-id.
// Dùng để biết: (a) hub.did cho signup, (b) compressed fabric id để lọc mDNS operational,
// từ đó suy ra node id của hub trên fabric Aqara (cho ACL grant).
import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";
import { Crypto, Environment } from "@matter/main";
import "@matter/nodejs";

const area = process.env.AREA ?? "SEA";
const a = await loginWithPasswordPlain({ email: process.env.E!, password: process.env.P!, area });
const cloud = new AquaraMobileClient({ area, token: a.token, userId: a.userId });
const m = new AqaraMatterCloud(cloud);

console.log("user:", a.userId, a.nickName ?? "");
const hubs = await m.discoverMatterHubs();
console.log(`\n${hubs.length} Matter hub(s):`);
for (const h of hubs) console.log(`  did=${h.did}  model=${h.model}  home=${h.homePositionId}  name=${h.name}`);

if (!hubs.length) { console.log("KHÔNG thấy hub Matter"); process.exit(1); }
const hub = hubs.find((h) => /gateway/i.test(h.model)) ?? hubs[0];
const fabric = await m.getFabric(hub.homePositionId);
console.log(`\nfabric (home ${hub.homePositionId}):`);
console.log(`  fabricId = ${fabric.fabricId}`);
console.log(`  rcacId=${fabric.rcacId} icacId=${fabric.icacId} ipk=${fabric.ipk}`);

// compressed fabric id = Crypto.hkdf(rootPublicKey[1..], fabricId(8B BE), "CompressedFabric") → 8B
// matter.js Fabric tự tính; nhưng ta tính thủ công từ rcac public key.
try {
  const env = Environment.default;
  const crypto = env.get(Crypto);
  // lấy public key từ RCAC PEM
  const nodeCrypto = await import("node:crypto");
  const pub = nodeCrypto.createPublicKey(fabric.rcacPem);
  const jwk = pub.export({ format: "jwk" }) as any;
  const b64u = (s: string) => Buffer.from(s, "base64url");
  const rootPub = Buffer.concat([Buffer.from([0x04]), b64u(jwk.x), b64u(jwk.y)]); // 65B
  const fabricIdBE = Buffer.alloc(8);
  fabricIdBE.writeBigUInt64BE(BigInt("0x" + fabric.fabricId));
  const info = Buffer.from("CompressedFabric", "utf8");
  const compressed = await crypto.createHkdfKey(rootPub.subarray(1), fabricIdBE, info, 8);
  console.log(`  compressedFabricId = ${Buffer.from(compressed).toString("hex").toUpperCase()}`);
} catch (e: any) {
  console.log("  (compressed fabric id calc lỗi:", e?.message ?? e, ")");
}
process.exit(0);
