#!/usr/bin/env bun
// Virtual D100 — Matter Door Lock server (Phase 1: in-memory, KHÔNG wire BLE).
//
// Implements DoorLock cluster (0x0101) với features:
//   PinCredential | RfidCredential | FingerCredentials | FaceCredentials | User | Unbolting
//
// Commission qua QR code in ra terminal. HA → Settings → Add device → Matter → quét QR.
// Sau khi commission, HA (≥ 2026.3) sẽ expose:
//   - lock.lock / lock.unlock / lock.open    (UnlockDoor/LockDoor/UnlockWithTimeout)
//   - matter.set_lock_user / get_lock_users / clear_lock_user
//   - matter.set_lock_credential / get_lock_credential_status / clear_lock_credential
//   - matter.get_lock_info
//
// Storage: /tmp/d100-matter-storage (fabric keys + commissioning data)
//
// Phase 2 (sau): override DoorLockServer.lockDoor/unlockDoor → wire vào AquaraLock BLE.
//
// Usage:
//   bun run tools/virtual_d100_matter.ts
//   bun run tools/virtual_d100_matter.ts --reset   # xoá fabric, commission lại
import "@matter/nodejs"; // BẮT BUỘC: register Node.js platform shims (storage, crypto, net).

import { Endpoint, ServerNode, Environment } from "@matter/main";
import { DoorLockDevice } from "@matter/main/devices/door-lock";
import { DoorLockServer } from "@matter/main/behaviors/door-lock";
import { DoorLock } from "@matter/main/clusters/door-lock";
import { logEndpoint, EndpointServer } from "@matter/main";
import { existsSync, rmSync } from "node:fs";
import qrTerminal from "qrcode-terminal";

const STORAGE_DIR = "/tmp/d100-matter-storage";

if (process.argv.includes("--reset")) {
  if (existsSync(STORAGE_DIR)) {
    rmSync(STORAGE_DIR, { recursive: true, force: true });
    console.log(`✓ wiped ${STORAGE_DIR} (fabric & commissioning cleared)`);
  }
}

// ============================================================================
// Custom DoorLockServer — override lock/unlock/unbolt handlers.
// In Phase 1 chỉ flip LockState + emit event. Phase 2 wire AquaraLock BLE.
// ============================================================================
const D100DoorLockServer = DoorLockServer.with(
  "PinCredential",
  "RfidCredential",
  "FingerCredentials",
  "FaceCredentials",
  "User",
  "Unbolting",
  "WeekDayAccessSchedules",
  "YearDayAccessSchedules",
  "HolidaySchedules",
  "DoorPositionSensor",
  "Notification",
);

class D100DoorLock extends D100DoorLockServer {
  override async lockDoor({ pinCode }: DoorLock.LockDoorRequest = {}) {
    console.log(`🔒 LockDoor (pinCode=${pinCode ? "<provided>" : "none"})`);
    await this.events.lockOperation.emit(
      {
        lockOperationType: DoorLock.LockOperationType.Lock,
        operationSource: DoorLock.OperationSource.Remote,
        userIndex: null,
        fabricIndex: null,
        sourceNode: null,
        credentials: null,
      },
      this.context,
    );
    this.state.lockState = DoorLock.LockState.Locked;
  }

  override async unlockDoor({ pinCode }: DoorLock.UnlockDoorRequest = {}) {
    console.log(`🔓 UnlockDoor (pinCode=${pinCode ? "<provided>" : "none"})`);
    // TODO Phase 2: await AquaraLock.openLock(OPEN) → BLE handshake + 01/74
    await this.events.lockOperation.emit(
      {
        lockOperationType: DoorLock.LockOperationType.Unlock,
        operationSource: DoorLock.OperationSource.Remote,
        userIndex: null,
        fabricIndex: null,
        sourceNode: null,
        credentials: null,
      },
      this.context,
    );
    this.state.lockState = DoorLock.LockState.Unlocked;
  }

  override async unboltDoor({ pinCode }: DoorLock.UnboltDoorRequest = {}) {
    console.log(`🔓 UnboltDoor (pinCode=${pinCode ? "<provided>" : "none"})`);
    // TODO Phase 2: await AquaraLock.openLock(UNBOLT)
    await this.events.lockOperation.emit(
      {
        lockOperationType: DoorLock.LockOperationType.Unlatch,
        operationSource: DoorLock.OperationSource.Remote,
        userIndex: null,
        fabricIndex: null,
        sourceNode: null,
        credentials: null,
      },
      this.context,
    );
    this.state.lockState = DoorLock.LockState.Unlatched;
  }
}

// ============================================================================
// Compose endpoint with our custom server.
// ============================================================================
const D100Device = DoorLockDevice.with(D100DoorLock);

// ============================================================================
// Bootstrap ServerNode
// ============================================================================
async function main(): Promise<void> {
  // Configure storage path via environment
  Environment.default.vars.set("storage.path", STORAGE_DIR);

  const server = await ServerNode.create({
    id: "virtual-d100",
    network: { port: 5540 },
    productDescription: { name: "Virtual D100", deviceType: DoorLockDevice.deviceType },
    commissioning: {
      passcode: 20202021, // standard test passcode (CSA SVE)
      discriminator: 3840, // standard test discriminator
    },
    basicInformation: {
      vendorId: 0xfff1, // Matter test vendor
      vendorName: "Aqara-DIY",
      productId: 0xd100,
      productName: "Virtual D100",
      productLabel: "D100 BLE→Matter Bridge",
      hardwareVersion: 1,
      hardwareVersionString: "1.0",
      softwareVersion: 1,
      softwareVersionString: "0.1.0-phase1",
      serialNumber: `VD100-${Math.floor(Date.now() / 1000)}`,
      nodeLabel: "Virtual D100",
      location: "DK",
      uniqueId: "virtual-d100-uniq-001",
    },
  });

  const lockEndpoint = new Endpoint(D100Device, {
    id: "lock-1",
    doorLock: {
      lockType: DoorLock.LockType.DeadBolt,
      lockState: DoorLock.LockState.Locked,
      actuatorEnabled: true,
      operatingMode: DoorLock.OperatingMode.Normal,
      // User feature limits
      numberOfTotalUsersSupported: 100,
      numberOfCredentialsSupportedPerUser: 5,
      // PIN feature limits
      numberOfPinUsersSupported: 100,
      maxPinCodeLength: 8,
      minPinCodeLength: 4,
      // RFID feature limits
      numberOfRfidUsersSupported: 100,
      maxRfidCodeLength: 20,
      minRfidCodeLength: 4,
      // Misc (lock-out after wrong-code attempts)
      wrongCodeEntryLimit: 5,
      userCodeTemporaryDisableTime: 60,
      // DPS — initial door state (closed)
      doorState: DoorLock.DoorState.DoorClosed,
      // Schedule slot capacity (WDSCH/YDSCH/HDSCH)
      numberOfWeekDaySchedulesSupportedPerUser: 10,
      numberOfYearDaySchedulesSupportedPerUser: 10,
      numberOfHolidaySchedulesSupported: 10,
      // supportedOperatingModes auto-filled by DoorLockServer (bits inverted; alwaysSet=2047).
      // users/credentials/schedules arrays auto-init to [].
    },
  });
  await server.add(lockEndpoint);

  await server.start();

  // ----- Print commissioning info -----
  const { qrPairingCode, manualPairingCode } = server.state.commissioning.pairingCodes;
  console.log("");
  console.log("─".repeat(70));
  console.log(" Virtual D100 — Matter Door Lock");
  console.log("─".repeat(70));
  console.log(`  vendor   = Aqara-DIY (0xfff1)`);
  console.log(`  product  = Virtual D100 (0xd100)`);
  console.log(`  features = PIN | RFID | Fingerprint | Face | User | Unbolting`);
  console.log(`  storage  = ${STORAGE_DIR}`);
  console.log(`  port     = 5540`);
  console.log("");
  console.log(`  Manual pairing code: ${manualPairingCode}`);
  console.log(`  QR pairing code:     ${qrPairingCode}`);
  console.log("");
  qrTerminal.generate(qrPairingCode, { small: true });
  console.log("");
  console.log("→ Mở HA: Settings → Devices & Services → Add Integration → Matter → quét QR.");
  console.log("→ Sau commission, refresh trang HA — sẽ thấy entity `lock.virtual_d100`.");
  console.log("→ Test: HA Developer Tools → Services → matter.set_lock_user / set_lock_credential …");
  console.log("");
  console.log("Press Ctrl+C để dừng (state persist tại /tmp/d100-matter-storage).");

  // Log every lock state change
  lockEndpoint.events.doorLock.lockState$Changed.on((newState) => {
    const label =
      newState === DoorLock.LockState.Locked
        ? "🔒 LOCKED"
        : newState === DoorLock.LockState.Unlocked
          ? "🔓 UNLOCKED"
          : newState === DoorLock.LockState.NotFullyLocked
            ? "⚠ NotFullyLocked"
            : newState === DoorLock.LockState.Unlatched
              ? "🔓 UNLATCHED"
              : "unknown";
    console.log(`[state] lockState → ${label}`);
  });

  // ============================================================================
  // HTTP simulator: trigger LockOperation / DoorState / Alarm events from curl.
  // Useful to test HA `changed_by` mapping + automations before wiring D100 BLE.
  // ============================================================================
  const sourceMap: Record<string, DoorLock.OperationSource> = {
    manual: DoorLock.OperationSource.Manual,
    keypad: DoorLock.OperationSource.Keypad,
    remote: DoorLock.OperationSource.Remote,
    rfid: DoorLock.OperationSource.Rfid,
    biometric: DoorLock.OperationSource.Biometric,
    auto: DoorLock.OperationSource.Auto,
    button: DoorLock.OperationSource.Button,
  };
  const opTypeMap: Record<string, DoorLock.LockOperationType> = {
    lock: DoorLock.LockOperationType.Lock,
    unlock: DoorLock.LockOperationType.Unlock,
    unlatch: DoorLock.LockOperationType.Unlatch,
  };
  const alarmMap: Record<string, DoorLock.AlarmCode> = {
    lock_jammed: DoorLock.AlarmCode.LockJammed,
    lock_factory_reset: DoorLock.AlarmCode.LockFactoryReset,
    lock_radio_power_cycled: DoorLock.AlarmCode.LockRadioPowerCycled,
    wrong_code_entry_limit: DoorLock.AlarmCode.WrongCodeEntryLimit,
    front_esceutcheon_removed: DoorLock.AlarmCode.FrontEsceutcheonRemoved,
    door_forced_open: DoorLock.AlarmCode.DoorForcedOpen,
  };
  const doorStateMap: Record<string, DoorLock.DoorState> = {
    open: DoorLock.DoorState.DoorOpen,
    closed: DoorLock.DoorState.DoorClosed,
    jammed: DoorLock.DoorState.DoorJammed,
    forced: DoorLock.DoorState.DoorForcedOpen,
    unspecified: DoorLock.DoorState.Unspecified,
  };

  const httpPort = parseInt(process.env.SIM_HTTP_PORT ?? "8088", 10);
  const httpServer = Bun.serve({
    port: httpPort,
    fetch: async (req) => {
      const url = new URL(req.url);
      const json = (data: unknown, status = 200) =>
        Response.json(data, { status, headers: { "cache-control": "no-store" } });
      try {
        if (url.pathname === "/" || url.pathname === "/help") {
          return json({
            endpoints: {
              "GET /status": "lockState / doorState / users / credentials counts",
              "POST /simulate/operation?type=unlock|lock|unlatch&source=manual|keypad|remote|rfid|biometric&user=<idx>":
                "Fire LockOperation event + flip lockState. user=null nếu remote/manual không có user.",
              "POST /simulate/door?state=open|closed|jammed|forced|unspecified": "Set DPS doorState attribute",
              "POST /simulate/alarm?code=lock_jammed|wrong_code_entry_limit|...": "Emit DoorLockAlarm event",
              "POST /enroll?type=fingerprint|finger_vein|face|rfid&user=<idx>&name=<str>&wait_ms=5000":
                "Mô phỏng enrollment: trả ngay, sau wait_ms tự add credential + emit LockUserChange.",
            },
          });
        }

        if (url.pathname === "/status") {
          const state = lockEndpoint.state.doorLock;
          return json({
            lockState: DoorLock.LockState[state.lockState ?? -1] ?? state.lockState,
            doorState: DoorLock.DoorState[state.doorState ?? -1] ?? state.doorState,
            operatingMode: DoorLock.OperatingMode[state.operatingMode ?? -1] ?? state.operatingMode,
            usersCount: (state.users ?? []).filter((u: any) => u?.userStatus).length,
            credentialsCount: (state.credentials ?? []).length,
          });
        }

        if (req.method === "POST" && url.pathname === "/simulate/operation") {
          const type = (url.searchParams.get("type") ?? "unlock").toLowerCase();
          const source = (url.searchParams.get("source") ?? "manual").toLowerCase();
          const userParam = url.searchParams.get("user");
          const userIndex = userParam ? parseInt(userParam, 10) : null;
          const opType = opTypeMap[type];
          const opSource = sourceMap[source];
          if (opType == null || opSource == null) {
            return json({ error: `bad type/source. valid type=${Object.keys(opTypeMap)} source=${Object.keys(sourceMap)}` }, 400);
          }
          await lockEndpoint.act(async (agent) => {
            const dl = agent.doorLock as any;
            await dl.events.lockOperation.emit(
              {
                lockOperationType: opType,
                operationSource: opSource,
                userIndex: userIndex,
                fabricIndex: null,
                sourceNode: null,
                credentials: null,
              },
              agent.context,
            );
            dl.state.lockState =
              opType === DoorLock.LockOperationType.Lock
                ? DoorLock.LockState.Locked
                : opType === DoorLock.LockOperationType.Unlatch
                  ? DoorLock.LockState.Unlatched
                  : DoorLock.LockState.Unlocked;
          });
          console.log(`[sim] ${type} via ${source} user=${userIndex}`);
          return json({ ok: true, type, source, userIndex });
        }

        if (req.method === "POST" && url.pathname === "/simulate/door") {
          const stateParam = (url.searchParams.get("state") ?? "closed").toLowerCase();
          const ds = doorStateMap[stateParam];
          if (ds == null) return json({ error: `bad state. valid=${Object.keys(doorStateMap)}` }, 400);
          await lockEndpoint.set({ doorLock: { doorState: ds } });
          console.log(`[sim] doorState → ${stateParam}`);
          return json({ ok: true, doorState: stateParam });
        }

        if (req.method === "POST" && url.pathname === "/enroll") {
          // POST /enroll?type=fingerprint|finger_vein|face|rfid&user=<idx>&name=<str>&wait_ms=<ms>
          //
          // Mô phỏng UX khoá thật cho enrollment:
          //   1. Trả response ngay với `enrolling=true` + slot dự kiến
          //   2. Sleep wait_ms (default 5000) — giả lập "đang đợi user chạm cảm biến"
          //   3. Sinh fake template, thêm credential vào state
          //   4. Emit LockUserChange event
          //
          // Phase 2 với D100 thật: thay bước 2-3 bằng BLE 02/13 (start enroll) + listen 02/15 (success).
          const credTypeMap: Record<string, DoorLock.CredentialType> = {
            fingerprint: DoorLock.CredentialType.Fingerprint,
            finger_vein: DoorLock.CredentialType.FingerVein,
            face: DoorLock.CredentialType.Face,
            rfid: DoorLock.CredentialType.Rfid,
            pin: DoorLock.CredentialType.Pin,
          };
          const type = (url.searchParams.get("type") ?? "fingerprint").toLowerCase();
          const ct = credTypeMap[type];
          if (ct == null) return json({ error: `bad type. valid=${Object.keys(credTypeMap)}` }, 400);
          const userIndex = parseInt(url.searchParams.get("user") ?? "1", 10);
          const userName = url.searchParams.get("name") ?? "";
          const waitMs = parseInt(url.searchParams.get("wait_ms") ?? "5000", 10);

          // Find next slot index for this credential type
          const existing = (lockEndpoint.state.doorLock as any).credentials ?? [];
          const sameTypeSlots = existing
            .filter((c: any) => c?.credentialType === ct)
            .map((c: any) => c.credentialIndex);
          const credIndex = (sameTypeSlots.length ? Math.max(...sameTypeSlots) : 0) + 1;

          console.log(`[enroll] start ${type} → user=${userIndex} slot=${credIndex}, đợi ${waitMs}ms (giả lập user chạm cảm biến)…`);
          // Respond immediately so HA UI doesn't block — enrollment is async.
          setTimeout(async () => {
            try {
              // Generate a deterministic fake template
              const fakeData = new Uint8Array(8);
              crypto.getRandomValues(fakeData);
              const dataHex = [...fakeData].map((b) => b.toString(16).padStart(2, "0")).join("");

              await lockEndpoint.act(async (agent) => {
                const dl = agent.doorLock as any;
                // Push credential + user into state
                const credentials = [...((dl.state.credentials as any[]) ?? [])];
                credentials.push({
                  credentialType: ct,
                  credentialIndex: credIndex,
                  credentialData: fakeData,
                  creatorFabricIndex: 1,
                  lastModifiedFabricIndex: 1,
                });
                dl.state.credentials = credentials;

                const users = [...((dl.state.users as any[]) ?? [])];
                const existingUser = users.find((u: any) => u?.userIndex === userIndex);
                if (existingUser) {
                  existingUser.credentials = [
                    ...(existingUser.credentials ?? []),
                    { credentialType: ct, credentialIndex: credIndex },
                  ];
                  if (userName) existingUser.userName = userName;
                } else {
                  users.push({
                    userIndex,
                    userName: userName || `User${userIndex}`,
                    userUniqueId: null,
                    userStatus: DoorLock.UserStatus.OccupiedEnabled,
                    userType: DoorLock.UserType.UnrestrictedUser,
                    credentialRule: DoorLock.CredentialRule.Single,
                    credentials: [{ credentialType: ct, credentialIndex: credIndex }],
                    creatorFabricIndex: 1,
                    lastModifiedFabricIndex: 1,
                  });
                }
                dl.state.users = users;

                // Emit LockUserChange event (cluster event for user/credential changes)
                if (dl.events.lockUserChange?.emit) {
                  await dl.events.lockUserChange.emit(
                    {
                      lockDataType: DoorLock.LockDataType.CredentialFingerprint,
                      dataOperationType: DoorLock.DataOperationType.Add,
                      operationSource: DoorLock.OperationSource.Manual,
                      userIndex: userIndex,
                      fabricIndex: 1,
                      sourceNode: null,
                      dataIndex: credIndex,
                    },
                    agent.context,
                  );
                }
              });
              console.log(`[enroll] ✓ ${type} added: user=${userIndex} slot=${credIndex} data=${dataHex}`);
            } catch (e: any) {
              console.error(`[enroll] FAIL ${type}:`, e?.message ?? e);
            }
          }, waitMs);

          return json({
            enrolling: true,
            type,
            user_index: userIndex,
            credential_index: credIndex,
            wait_ms: waitMs,
            message: `Khoá đang vào enrollment mode. Trong ${waitMs}ms, user phải chạm cảm biến. Sau đó tự thêm credential.`,
          });
        }

        if (req.method === "POST" && url.pathname === "/simulate/alarm") {
          const code = (url.searchParams.get("code") ?? "").toLowerCase();
          const ac = alarmMap[code];
          if (ac == null) return json({ error: `bad code. valid=${Object.keys(alarmMap)}` }, 400);
          await lockEndpoint.act(async (agent) => {
            const dl = agent.doorLock as any;
            await dl.events.doorLockAlarm.emit({ alarmCode: ac }, agent.context);
          });
          console.log(`[sim] alarm → ${code}`);
          return json({ ok: true, alarm: code });
        }

        return json({ error: "not found" }, 404);
      } catch (e: any) {
        console.error("[sim] error:", e?.stack ?? e);
        return json({ error: String(e?.message ?? e) }, 500);
      }
    },
  });
  console.log(`→ HTTP simulator listening on http://0.0.0.0:${httpServer.port}/help`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n→ shutting down…");
    httpServer.stop();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function dumpErr(e: any, indent = ""): void {
  console.error(`${indent}↪ ${e?.message ?? e}`);
  if (e?.cause) dumpErr(e.cause, indent + "  ");
  if (Array.isArray(e?.errors)) {
    for (const sub of e.errors) dumpErr(sub, indent + "  ");
  }
}
main().catch((e) => {
  console.error("FATAL:", e?.stack ?? e);
  dumpErr(e);
  process.exit(1);
});
