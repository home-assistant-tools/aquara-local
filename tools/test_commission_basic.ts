// Vanilla controller (own fabric) commissioning the light — isolate shared-fabric as the cause.
import "@matter/nodejs";
import { Environment } from "@matter/main";
import { GeneralCommissioning } from "@matter/main/clusters";
import { CommissioningController } from "@project-chip/matter.js";

const env = Environment.default;
env.vars.set("storage.path", "/tmp/aqara-basic-storage");
const controller = new CommissioningController({
  environment: { environment: env, id: "basic-cc" },
  autoConnect: false,
  adminFabricLabel: "TestCtl",
});
await controller.start();
console.log("commissioning light (vanilla)…");
const nodeId = await controller.commissionNode({
  commissioning: { regulatoryLocation: GeneralCommissioning.RegulatoryLocationType.IndoorOutdoor, regulatoryCountryCode: "XX", onAttestationFailure: () => {} },
  discovery: { identifierData: { longDiscriminator: 3842 }, discoveryCapabilities: { ble: false, onIpNetwork: true } },
  passcode: 20202023,
} as any, { connectNodeAfterCommissioning: false });
console.log("✅ VANILLA COMMISSION OK nodeId=", nodeId);
process.exit(0);
