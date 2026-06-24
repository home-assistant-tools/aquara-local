// commissionLight.ts — auto-commission đèn ảo Matter vào FABRIC AQARA bằng CommissioningController.
//
// Thay cho commissionSwitch.ts (ServerNode → kẹt synchronous-transaction-conflict sau PASE).
// CommissioningController (@project-chip/matter.js) là controller-ONLY (KHÔNG có device-side
// CommissioningServer) → không xung đột. Theo đúng mẫu official `controller-shared-fabric`:
//   CA(ICAC ngoài) → FabricBuilder(rootFabric) → CommissioningController(rootFabric+CA) → commissionNode.
//
// Sau commissionNode (device đã vào fabric Aqara + CASE xong), caller gọi cloud signup+waitBind
// để hub Aqara adopt node → trả Aqara DID.
import "@matter/nodejs"; // Node.js platform shims (storage/crypto/net/mdns)
import { Crypto, Environment } from "@matter/main";
import { FabricBuilder } from "@matter/main/protocol";
import { FabricId, NodeId, VendorId, FabricIndex } from "@matter/main/types";
import { GeneralCommissioning } from "@matter/main/clusters";
import { CommissioningController } from "@project-chip/matter.js";
import { buildAqaraCa, AQARA_VENDOR_ID } from "./commissionSwitch";
import type { MatterFabric } from "./aqaraMatter";

const hexToBytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));

export interface CommissionLightResult {
  deviceNodeIdHex: string;
  controllerNodeIdHex: string;
}

/**
 * Commission đèn ảo (đang chạy local, commissionable) vào fabric Aqara — KHÔNG cần app.
 * @param fabric             AqaraMatterCloud.getFabric()
 * @param deviceNodeIdHex    genNodeId() — nodeId mà hub sẽ bind (signup dùng decimal của nó)
 * @param controllerNodeIdHex nodeId admin của controller. Mặc định dùng genNodeId() lần 2.
 *                            Khi debug M100 adopt, có thể truyền nodeId của hub M100 để
 *                            caseAdminSubject hardcode trong matter.js trỏ về hub.
 * @param passcode/discriminator  PASE của đèn (vd 20202023 / 3842)
 * @param onAfterCase        gọi NGAY sau khi device vào fabric (signup+waitBind) — tuỳ chọn
 */
export async function commissionLightOntoAqaraFabric(opts: {
  fabric: MatterFabric;
  deviceNodeIdHex: string;
  controllerNodeIdHex: string;
  passcode: number;
  discriminator: number;
  storagePath?: string;
  onAfterCase?: () => Promise<void>;
}): Promise<CommissionLightResult> {
  const env = Environment.default;
  env.vars.set("storage.path", opts.storagePath ?? "/tmp/aqara-cc-storage");
  const crypto = env.get(Crypto);

  // 1) CertificateAuthority từ ICAC ngoài (fabric Aqara). 3-tier RCAC→ICAC→NOC.
  const ca = await buildAqaraCa(env, opts.fabric);

  // 2) rootFabric của controller (addon) — ký NOC cho chính controller bằng ICAC Aqara.
  const fabricId = FabricId(BigInt("0x" + opts.fabric.fabricId));
  const controllerNodeId = NodeId(BigInt("0x" + opts.controllerNodeIdHex));
  const fb = await FabricBuilder.create(crypto);
  await fb.setRootCert((ca as any).rootCert);
  fb.setRootNodeId(controllerNodeId)
    .setIdentityProtectionKey(hexToBytes(opts.fabric.ipk))
    .setRootVendorId(VendorId(AQARA_VENDOR_ID))
    .setLabel("Aqara");
  const noc = await (ca as any).generateNoc((fb as any).publicKey, fabricId, controllerNodeId);
  await fb.setOperationalCert(noc, (ca as any).icacCert);
  const fabric = await fb.build(FabricIndex(1));

  // 3) CommissioningController dùng CA + rootFabric Aqara (controller-only, không device server).
  const controller = new CommissioningController({
    environment: { environment: env, id: "aqara-addon-cc" },
    autoConnect: false,
    adminFabricLabel: "Aqara",
    adminFabricId: fabricId,
    rootNodeId: controllerNodeId,
    adminVendorId: VendorId(AQARA_VENDOR_ID),
    rootCertificateAuthority: ca,
    rootFabric: fabric,
  } as any);
  await controller.start();

  // 4) Commission đèn với deviceNodeId Aqara cấp. KHÔNG connect lại sau (chỉ cần vào fabric).
  const deviceNodeId = NodeId(BigInt("0x" + opts.deviceNodeIdHex));
  await controller.commissionNode(
    {
      commissioning: {
        nodeId: deviceNodeId,
        regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor,
        regulatoryCountryCode: "XX",
        onAttestationFailure: () => true, // đèn = test vendor 0xFFF1 → bỏ qua attestation
      },
      discovery: {
        identifierData: { longDiscriminator: opts.discriminator },
        discoveryCapabilities: { ble: false, onIpNetwork: true },
      },
      passcode: opts.passcode,
    } as any,
    { connectNodeAfterCommissioning: false },
  );

  if (opts.onAfterCase) await opts.onAfterCase();
  return { deviceNodeIdHex: opts.deviceNodeIdHex, controllerNodeIdHex: opts.controllerNodeIdHex };
}
