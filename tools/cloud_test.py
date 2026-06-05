#!/usr/bin/env python3
"""Cloud-only smoke test — NO ESP32, NO Home Assistant, runnable today.

Validates the whole cloud half of the integration against your real account:
login (RSA password, no OTP) → discover D100 locks → fetch each lock's BLE MAC
and current status. This is exactly what the HACS integration does, so a green
run means unlock/lock from Home Assistant will work too.

To PROVE remote control end-to-end, set AQARA_TEST_ACTION=unlock (or lock) — the
test then fires that Matter command at your first lock through the cloud. ⚠️ This
physically opens/closes your real door, so it is OFF by default.

Usage:
  export AQARA_EMAIL=...  AQARA_PASSWORD=...  [AQARA_AREA=SEA]  [AQARA_DISTRICT=VN]
  python3 tools/cloud_test.py                      # read-only smoke test
  AQARA_TEST_ACTION=unlock python3 tools/cloud_test.py   # ⚠️ really opens the door

Requires: pip install aiohttp cryptography
"""

from __future__ import annotations

import asyncio
import importlib
import os
import pathlib
import sys
import types

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG_DIR = ROOT / "custom_components" / "aqara_d100"
_ns = types.ModuleType("aqd100")
_ns.__path__ = [str(PKG_DIR)]
sys.modules["aqd100"] = _ns
cloud = importlib.import_module("aqd100.cloud")

import aiohttp  # noqa: E402


async def main() -> int:
    try:
        email = os.environ["AQARA_EMAIL"]
        password = os.environ["AQARA_PASSWORD"]
    except KeyError:
        print("ERROR: set AQARA_EMAIL and AQARA_PASSWORD env vars.", file=sys.stderr)
        return 2
    area = os.environ.get("AQARA_AREA", "SEA")
    district = os.environ.get("AQARA_DISTRICT", "VN")

    async with aiohttp.ClientSession() as session:
        print(f"→ login {email} (area={area}, district={district}) …")
        auth = await cloud.login_with_password(session, email, password, area, district)
        print(f"  ✓ token ok, userId={auth['userId']} nick={auth.get('nickName')}")

        cl = cloud.AqaraCloud(session, area, auth["token"], auth["userId"])
        print("→ discovering locks …")
        locks = await cl.list_locks()
        if not locks:
            print("  ⚠️ no D100 found on this account")
            return 1
        for lk in locks:
            print(f"  • {lk['name']}  did={lk['did']}  model={lk['model']}")
            try:
                pk = await cl.publickey(lk["did"])
                print(f"      mac={pk.get('mac')}  cloudPublicKey={pk.get('cloudPublicKey','')[:18]}…")
            except Exception as err:  # noqa: BLE001
                print(f"      ⚠️ publickey failed: {err}")
            try:
                res = await cl.lock_resources(lk["did"])
                print(f"      lock_state={res.get('lock_state')}  battery={res.get('batt_0_remain_percentage')}%")
            except Exception as err:  # noqa: BLE001
                print(f"      ⚠️ status failed: {err}")

        action = os.environ.get("AQARA_TEST_ACTION", "").strip().lower()
        if action in ("unlock", "lock"):
            target = locks[0]
            print(f"\n⚠️  AQARA_TEST_ACTION={action} → firing Matter {action} at "
                  f"{target['name']} ({target['did']}) — this moves the real lock!")
            try:
                fn = cl.remote_unlock if action == "unlock" else cl.remote_lock
                await fn(target["did"])
                print(f"  ✅ cloud accepted the {action} (code 0) — "
                      "watch the lock / re-poll lock_state to confirm.")
            except Exception as err:  # noqa: BLE001
                print(f"  ❌ {action} failed: {err}")
                return 1
        elif action:
            print(f"\n⚠️ ignoring AQARA_TEST_ACTION={action!r} (use 'unlock' or 'lock')")

        print("\n✅ cloud half OK — this is the full path the HACS integration uses "
              "for unlock/lock. (Optional: tools/ble_esp32_test.py for the BLE fallback.)")
        return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
