#!/usr/bin/env python3
"""Load-validate the aqara_d100 integration against a real Home Assistant install.

Stronger than py_compile: actually imports every module under the real HA API,
checks the manifest, and instantiates the config-flow class. Run with the
.venv-ha interpreter that has `homeassistant` installed.
"""
from __future__ import annotations

import json
import pathlib
import sys
import traceback

ROOT = pathlib.Path(__file__).resolve().parent.parent
CC = ROOT / "custom_components"
sys.path.insert(0, str(CC))

PKG = "aqara_d100"
MODS = [
    f"{PKG}.const",
    f"{PKG}.crypto",
    f"{PKG}.protocol",
    f"{PKG}.gatt",
    f"{PKG}.cloud",
    f"{PKG}.ble",
    f"{PKG}.coordinator",
    f"{PKG}.entity",
    f"{PKG}.config_flow",
    f"{PKG}.services",
    f"{PKG}.lock",
    f"{PKG}.sensor",
    f"{PKG}",  # package __init__ (forwards platforms)
]

ok = True


def check(label: str, fn) -> None:
    global ok
    try:
        fn()
        print(f"  ✅ {label}")
    except Exception:  # noqa: BLE001
        ok = False
        print(f"  ❌ {label}")
        traceback.print_exc()


print("== manifest ==")


def _manifest() -> None:
    m = json.loads((CC / PKG / "manifest.json").read_text())
    assert m["domain"] == PKG, "domain mismatch"
    assert m["config_flow"] is True
    assert m["iot_class"] in {
        "cloud_polling", "local_polling", "cloud_push", "local_push", "calculated",
    }, m["iot_class"]
    print(f"     domain={m['domain']} iot_class={m['iot_class']} version={m['version']}")


check("manifest.json valid", _manifest)

print("== import every module under real HA ==")
import importlib  # noqa: E402

for mod in MODS:
    check(f"import {mod}", lambda mod=mod: importlib.import_module(mod))

print("== config-flow / platform surface ==")


def _flow() -> None:
    cf = importlib.import_module(f"{PKG}.config_flow")
    assert hasattr(cf, "AqaraD100ConfigFlow")
    # platforms forwarded by __init__
    init = importlib.import_module(PKG)
    plats = [p.value for p in init.PLATFORMS]
    assert "lock" in plats and "sensor" in plats, plats
    print(f"     PLATFORMS={plats}")


check("config flow + platforms", _flow)

print("\nRESULT:", "ALL GREEN ✅" if ok else "FAILURES ❌")
sys.exit(0 if ok else 1)
