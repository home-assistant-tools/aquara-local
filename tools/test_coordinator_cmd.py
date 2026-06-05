"""Local logic test for the refactored coordinator._command (no creds, no HW).

Verifies the debug-improvement: on cloud failure with no BLE, the *cloud* error
must reach the UI (HomeAssistantError), not a misleading Bluetooth-only message.
"""
import asyncio, pathlib, sys, types

CC = pathlib.Path("/Users/baduongvan/dev/smarthome/d100-aquara-matter/custom_components")
sys.path.insert(0, str(CC))

from homeassistant.exceptions import HomeAssistantError
from aqara_d100.coordinator import AqaraD100Coordinator, LockInfo, LockState
from aqara_d100.cloud import AqaraCloudError
from aqara_d100.protocol import OPEN_OPEN

LOCK = LockInfo(did="lumi.test", name="Test D100", mac="AA:BB:CC:DD:EE:FF")


class Fake:
    """Minimal stand-in exposing exactly what _command touches."""
    def __init__(self, ble_fails: bool):
        self.data = {LOCK.did: LockState()}
        self._ble_fails = ble_fails
        self.updated = False
        self.refreshed = False

    async def _with_auth_retry(self, factory):
        return await factory()

    async def _ble_op(self, lock, op):
        if self._ble_fails:
            raise HomeAssistantError("Could not reach Test D100 over Bluetooth: no proxy")
        # pretend BLE succeeded
        self.data[lock.did].lock_state = "6"

    def async_set_updated_data(self, data):
        self.updated = True

    async def async_request_refresh(self):
        self.refreshed = True


cmd = AqaraD100Coordinator._command  # unbound; call with Fake as self
results = []


async def case(name, *, cloud, ble_fails, expect_raise, expect_contains=None, expect_state=None):
    fake = Fake(ble_fails=ble_fails)
    raised = None
    try:
        await cmd(fake, LOCK, "unlock", cloud, OPEN_OPEN, "6")
    except Exception as e:  # noqa: BLE001
        raised = e
    ok = True
    if expect_raise:
        ok &= isinstance(raised, HomeAssistantError)
        if expect_contains:
            ok &= all(s in str(raised) for s in expect_contains)
    else:
        ok &= raised is None
        if expect_state is not None:
            ok &= fake.data[LOCK.did].lock_state == expect_state
    results.append(ok)
    print(f"  {'✅' if ok else '❌'} {name}"
          + (f"  (raised: {raised})" if raised else "")
          + (f"  state={fake.data[LOCK.did].lock_state}" if not expect_raise else ""))


async def main():
    async def cloud_ok(did):
        return {"code": 0, "result": "queued"}

    async def cloud_hub_offline(did):
        raise AqaraCloudError("[matter/write] code=108 hub offline")

    print("== coordinator._command logic ==")
    # 1. cloud success → optimistic unlocked state, no raise, refresh requested
    await case("cloud success sets optimistic state '6'",
               cloud=cloud_ok, ble_fails=True, expect_raise=False, expect_state="6")
    # 2. cloud fails, BLE unavailable → must surface the CLOUD error (the key fix)
    await case("cloud fail + no BLE surfaces the CLOUD cause",
               cloud=cloud_hub_offline, ble_fails=True, expect_raise=True,
               expect_contains=["Cloud:", "hub offline", "BLE fallback:"])
    # 3. cloud fails, BLE works → no raise (fallback covered it)
    await case("cloud fail + BLE ok → no error",
               cloud=cloud_hub_offline, ble_fails=False, expect_raise=False, expect_state="6")

    print("\nRESULT:", "ALL PASS ✅" if all(results) else "FAIL ❌")
    return 0 if all(results) else 1


sys.exit(asyncio.run(main()))
