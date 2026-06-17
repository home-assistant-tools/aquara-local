// commissionSwitch.ts — matter.js CONTROLLER: tự commission công tắc ảo vào FABRIC AQARA.
//
// Đây là mảnh "tự thêm công tắc" (không cần thao tác app). Dùng vật liệu fabric từ cloud
// (AqaraMatterCloud.getFabric → ICAC cert+key + RCAC + ipk + fabricId) để dựng một
// CertificateAuthority 3-tier (RCAC→ICAC→NOC) trong matter.js — KHÔNG cần RCAC private key
// (ICAC ký NOC). Rồi controller discover công tắc local (mDNS) + PASE(passcode) + addNOC
// (nodeId từ gen-nodeid) → switch vào fabric Aqara. Sau đó caller gọi cloud signup + bind.
//
// ✅ API đã xác nhận tồn tại trong @matter 0.17:
//   - Rcac.fromAsn1(der) / Icac.fromAsn1(der) → Matter cert; .asSignedTlv() → Matter-TLV bytes
//   - CertificateAuthority.create(crypto, ConfigurationWithIcac{rootCertBytes, icacCertBytes,
//       icacKeyPair, icacKeyIdentifier, rootKeyIdentifier, rootCertId, icacCertId, nextCertificateId})
//       — rootKeyPair OPTIONAL (3-tier: ICAC ký NOC, KHỚP đúng mô hình Aqara)
//   - FabricAuthority.defaultFabric({adminVendorId:4447, adminFabricId, adminNodeId}) → Fabric
//   - node.nodes (Peers).commission({passcode, nodeId, fabric, onAttestationFailure})
//
// ⚠️ Phần bootstrap controller node + inject CA vào Environment CẦN test live vài vòng
//    (decommission switch hiện tại trước). Struct dưới đây theo type-def 0.17.
import "@matter/nodejs";
import crypto from "node:crypto";
import { Crypto, Environment, ServerNode } from "@matter/main";
import { CertificateAuthority, Rcac, Icac, FabricAuthority } from "@matter/protocol";
import type { MatterFabric } from "./aqaraMatter";

const AQARA_VENDOR_ID = 4447; // 0x115F — admin vendor của fabric Aqara (từ addNoc capture)

/** PEM (PKCS8 EC P-256) → {publicKey:65B uncompressed, privateKey:32B} cho BinaryKeyPair. */
function ecKeyPairFromPem(pem: string): { publicKey: Uint8Array; privateKey: Uint8Array } {
  const key = crypto.createPrivateKey(pem);
  const jwk = key.export({ format: "jwk" }) as { d: string; x: string; y: string };
  const b64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
  const x = b64u(jwk.x), y = b64u(jwk.y), d = b64u(jwk.d);
  const pub = new Uint8Array(65);
  pub[0] = 0x04; pub.set(x, 1); pub.set(y, 33);
  return { publicKey: pub, privateKey: d };
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return new Uint8Array(Buffer.from(b64, "base64"));
}

const hexToBytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));

/**
 * Dựng CertificateAuthority dùng fabric Aqara (3-tier external ICAC).
 * Trả CA + các tham số fabric để FabricAuthority.defaultFabric dùng.
 */
export async function buildAqaraCa(env: Environment, fabric: MatterFabric): Promise<CertificateAuthority> {
  // Convert cert X.509(PEM cloud) → Matter cert → Matter-TLV
  const rcac = Rcac.fromAsn1(pemToDer(fabric.rcacPem));
  const icac = Icac.fromAsn1(pemToDer(fabric.icacPem));
  const icacKeyPair = ecKeyPairFromPem(fabric.icacKeyPem);

  const config = {
    // RCAC (root) — KHÔNG cần private key (ICAC ký NOC → 3-tier)
    rootCertId: BigInt("0x" + fabric.rcacId),
    rootKeyIdentifier: hexToBytes(fabric.rootKeyId), // SKI của RCAC (Bytes — bắt buộc đúng type)
    rootCertBytes: rcac.asSignedTlv(),
    nextCertificateId: BigInt("0x" + fabric.icacId) + 1n,
    // ICAC — ký device NOC
    icacCertId: BigInt("0x" + fabric.icacId),
    icacKeyPair,
    icacKeyIdentifier: hexToBytes(fabric.subjectKeyId),
    icacCertBytes: icac.asSignedTlv(),
  } as any;

  const cryptoSvc = env.get(Crypto);
  return await CertificateAuthority.create(cryptoSvc, config);
}

export interface CommissionResult {
  nodeIdHex: string;
  fabricIndex: number;
}

/**
 * Tự commission công tắc ảo (đang chạy local, advertise commissionable) vào fabric Aqara.
 * @param fabric   từ AqaraMatterCloud.getFabric()
 * @param nodeIdHex từ AqaraMatterCloud.genNodeId()
 * @param passcode  passcode PASE của switch (vd 20202022)
 * @param discriminator  discriminator của switch (vd 3841) để discover đúng thiết bị
 */
export async function commissionSwitchOntoAqaraFabric(opts: {
  fabric: MatterFabric;
  nodeIdHex: string;
  passcode: number;
  discriminator: number;
  storagePath?: string;
}): Promise<CommissionResult> {
  // Dùng Environment.default (đã được @matter/nodejs populate StorageManager/Crypto/Network).
  const env = Environment.default;
  env.vars.set("storage.path", opts.storagePath ?? "/tmp/aqara-controller-storage");

  // 1) CA từ fabric Aqara, inject vào environment TRƯỚC khi node/FabricAuthority khởi tạo
  const ca = await buildAqaraCa(env, opts.fabric);
  (env as any).set(CertificateAuthority, ca);

  // 2) Controller node (dùng Environment.default → có StorageManager)
  const controller = await ServerNode.create({ id: "aqara-addon-controller" } as any);
  await (controller as any).start?.();

  // 3) Fabric Aqara qua FabricAuthority — lấy từ ENV CỦA NODE (có StorageManager), KHÔNG global
  const nodeEnv = (controller as any).env ?? env;
  const fabricAuthority = nodeEnv.get(FabricAuthority) as FabricAuthority;
  const matterFabric = await fabricAuthority.defaultFabric({
    adminFabricLabel: "Nhà của tôi",
    adminVendorId: AQARA_VENDOR_ID as any,
    adminFabricId: BigInt("0x" + opts.fabric.fabricId) as any,
  });

  // 4) Discover switch (commissionable theo discriminator) + commission với nodeId Aqara cấp.
  //    peers.commission = InstanceOptions(discovery) & CommissioningOptions.
  const nodeId = BigInt("0x" + opts.nodeIdHex);
  await (controller as any).peers.commission({
    longDiscriminator: opts.discriminator, // lọc discovery đúng switch (3841)
    passcode: opts.passcode, // PASE
    discriminator: opts.discriminator,
    nodeId, // nodeId Aqara cấp
    fabric: matterFabric, // fabric Aqara
    // switch là test-vendor (0xFFF1) → bỏ qua lỗi attestation (giống app bấm "Tiếp tục")
    onAttestationFailure: () => {},
  });

  return { nodeIdHex: opts.nodeIdHex, fabricIndex: (matterFabric as any).fabricIndex ?? 1 };
}
