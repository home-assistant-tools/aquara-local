#!/usr/bin/env tsx
// Decode + validate light NOC/ICAC/RCAC chain — mô phỏng cái M100 làm khi nhận Sigma2.
// Mục tiêu: tìm vì sao M100 trả InvalidParam (NOC subject? CAT? chain signature? key usage?).
import "@matter/nodejs";
import { Environment, Crypto } from "@matter/main";
import { Rcac, Icac, Noc, Certificate } from "@matter/protocol";
import { AquaraMobileClient } from "../client/AquaraMobileClient";
import { AqaraMatterCloud } from "../client/aqaraMatter";
import { loginWithPasswordPlain } from "../client/loginPlain";

const hex = (h: string) => new Uint8Array(Buffer.from(h.replace(/\s/g, ""), "hex"));
const pemToDer = (pem: string) => new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"));

// NOC bắt được từ commission log (addNoc nocValue) — Matter-TLV của LIGHT.
const LIGHT_NOC_TLV = process.env.NOC_HEX ?? "";

const env = Environment.default;
const crypto = env.get(Crypto);

if (LIGHT_NOC_TLV) {
  console.log("=== LIGHT NOC (decoded) ===");
  const noc = Noc.fromTlv(hex(LIGHT_NOC_TLV));
  console.dir((noc as any).cert ?? noc, { depth: 6 });
}

// Lấy fabric thật để so RCAC/ICAC
const area = process.env.AREA ?? "SEA";
const a = await loginWithPasswordPlain({ email: process.env.E!, password: process.env.P!, area });
const cloud = new AquaraMobileClient({ area, token: a.token, userId: a.userId });
const m = new AqaraMatterCloud(cloud);
const hubs = await m.discoverMatterHubs();
const hub = hubs.find((h) => /gateway/i.test(h.model)) ?? hubs[0];
const fabric = await m.getFabric(hub.homePositionId);

console.log("\n=== RCAC (fabric root) ===");
const rcac = Rcac.fromAsn1(pemToDer(fabric.rcacPem));
console.dir((rcac as any).cert ?? rcac, { depth: 5 });
console.log("\n=== ICAC (fabric intermediate) ===");
const icac = Icac.fromAsn1(pemToDer(fabric.icacPem));
console.dir((icac as any).cert ?? icac, { depth: 5 });

process.exit(0);
