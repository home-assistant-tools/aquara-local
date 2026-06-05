#!/usr/bin/env python3
"""Standalone FULL-LOCAL D100 unlock test — through the Aqara hub on the LAN, no Home Assistant.

This validates the pure-Python local path end-to-end:
  1. Cloud login (email/password) → token  (the only internet step; results are cacheable).
  2. Resolve the lock DID.
  3. GET /devex/camera/p2p/info   → PPCS key (e.g. "aqarakr19kn"), p2pId (TUTK DID), hub pubkey.
  4. Generate an ephemeral X25519 keypair; POST /devex/camera/p2p/sign → app_sign.
  5. Open the TUTK PPPP/UDP tunnel to the hub on the LAN (PpcsUdpTransport):
        PUNCH → P2P_RDY → MSG_DRW(lumi LOGIN) → MSG_DRW(lumi Matter unlock).
  6. Read back the hub's lumi response ({"code":0,...} on success).

Everything (cipher + transport) is the SAME code the HA integration uses
(custom_components/aquara_local/local.py), so a success here means the integration's local leg works.

Usage:
  export AQARA_EMAIL=...        AQARA_PASSWORD=...
  export AQARA_AREA=SEA         AQARA_DISTRICT=VN          # optional (defaults)
  export HUB_IP=192.168.1.50                              # the Aqara hub's LAN IP
  export HUB_PORT=24423                                    # optional; omit to auto-discover
  export P2P_DID=lumi3.xxxx     # the HUB/doorbell DID that owns the P2P stream (e.g. G410).
                                # The lock is Zigbee and has NO P2P stream of its own — the hub
                                # relays. Omit to auto-pick the device that answers p2p/info.
  export LOCK_DID=lumi....                                 # optional; else auto-pick first lock
  python3 tools/local_hub_test.py            # full local unlock
  python3 tools/local_hub_test.py --op close # lock instead of unlock
  python3 tools/local_hub_test.py --dry      # do the cloud bootstrap + connect, no command

Requires: pip install aiohttp cryptography
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import logging
import os
import pathlib
import sys
import types

# --- import the ported modules WITHOUT running the HA-coupled package __init__ ---
ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG_DIR = ROOT / "custom_components" / "aquara_local"
_ns = types.ModuleType("aqd100")
_ns.__path__ = [str(PKG_DIR)]
sys.modules["aqd100"] = _ns
cloud = importlib.import_module("aqd100.cloud")
local = importlib.import_module("aqd100.local")

import aiohttp  # noqa: E402
from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey  # noqa: E402

_LOG = logging.getLogger("d100.localtest")

# Matter DoorLock traits (same as the cloud /matter/write spec)
TRAITS = {"open": "2.148.35011.0", "close": "2.148.35010.0"}


async def _discover_p2p_did(cl) -> str | None:
    """Find the account device that owns a P2P stream (the G410/doorbell hub)."""
    try:
        home = await cl.get(
            "/app/position/query/home/list",
            {"needDefaultRoom": "false", "size": 300, "startIndex": 0},
        )
    except Exception:  # noqa: BLE001
        return None
    for h in home.get("homes", []) if isinstance(home, dict) else []:
        pid = h.get("homeId")
        if not pid:
            continue
        dev = await cl.get(
            "/app/position/device/query", {"positionId": pid, "size": 300, "startIndex": 0}
        )
        for d in dev.get("devices") or dev.get("data") or []:
            did = d.get("did") or d.get("subjectId")
            if not did:
                continue
            try:
                await cl.p2p_info(did)
                return did  # first device that answers p2p/info wins
            except Exception:  # noqa: BLE001
                continue
    return None


def _ephemeral_x25519_pubkey_hex() -> str:
    """A fresh X25519 keypair; return the 32-byte raw public key as hex (what p2p/sign signs)."""
    priv = X25519PrivateKey.generate()
    pub = priv.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return pub.hex()


async def main() -> int:
    parser = argparse.ArgumentParser(description="D100 FULL-LOCAL unlock test via the hub")
    parser.add_argument("--op", choices=list(TRAITS), default="open")
    parser.add_argument("--dry", action="store_true", help="bootstrap + connect, no command")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    hub_ip = os.environ.get("HUB_IP")
    if not hub_ip:
        print("ERROR: set HUB_IP (the Aqara hub's LAN IP).", file=sys.stderr)
        return 2
    hub_port = int(os.environ["HUB_PORT"]) if os.environ.get("HUB_PORT") else None

    async with aiohttp.ClientSession() as session:
        email = os.environ["AQARA_EMAIL"]
        password = os.environ["AQARA_PASSWORD"]
        area = os.environ.get("AQARA_AREA", "SEA")
        district = os.environ.get("AQARA_DISTRICT", "VN")
        _LOG.info("Cloud login as %s (area=%s)…", email, area)
        auth = await cloud.login_with_password(session, email, password, area, district)
        cl = cloud.AqaraCloud(session, area, auth["token"], auth["userId"])
        _LOG.info("Login ✓ userId=%s", auth["userId"])

        lock_did = os.environ.get("LOCK_DID")
        if not lock_did:
            locks = await cl.list_locks()
            if not locks:
                _LOG.error("No lock found on the account — set LOCK_DID.")
                return 1
            lock_did = locks[0]["did"]
            _LOG.info("Lock: %s (%s)", locks[0]["name"], lock_did)

        # The P2P stream belongs to the HUB/doorbell, not the (Zigbee) lock. Use P2P_DID, or
        # probe the account for the device that answers p2p/info.
        p2p_did = os.environ.get("P2P_DID")
        if not p2p_did:
            p2p_did = await _discover_p2p_did(cl)
            if not p2p_did:
                _LOG.error("No P2P-capable hub found — set P2P_DID (the G410/doorbell DID).")
                return 1
            _LOG.info("Hub (P2P): %s", p2p_did)

        # --- cloud half: p2p/info + p2p/sign on the HUB DID → LocalSession (cacheable) ---
        app_pub_hex = _ephemeral_x25519_pubkey_hex()
        sess = await local.prepare_local_session(cl, p2p_did, app_pub_hex)
        _LOG.info(
            "Session creds ✓ p2pId=%s ppcs_key=%s app_sign=%s…",
            sess.p2p_id, sess.ppcs_key, sess.app_sign[:12],
        )

        # --- local half: open the PPPP/UDP tunnel to the hub ---
        transport = local.PpcsUdpTransport(hub_ip, hub_port)
        _LOG.info("Connecting PPPP tunnel to hub %s:%s…", hub_ip, hub_port or "(auto)")
        await transport.connect(sess)
        _LOG.info("PPPP session up ✓")
        try:
            # login (DRW idx 0)
            await transport.write(
                local.build_lumi_frame(
                    local.LUMI_TYPE_LOGIN,
                    local.build_login_payload(
                        sess.app_public_key, sess.app_sign, sess.did, sess.sign_time
                    ),
                )
            )
            _LOG.info("LOGIN sent + ACKed ✓")
            try:
                resp = await transport.read(timeout=4.0)
                _LOG.info("login response: %s", resp[16:].decode("utf-8", "replace"))
            except local.LocalTransportError:
                _LOG.warning("no login response frame (continuing)")

            if args.dry:
                _LOG.info("--dry: connected + logged in, skipping command.")
                return 0

            # command (DRW idx 1) — targets the LOCK did; relayed by the hub over Zigbee
            trait = TRAITS[args.op]
            await transport.write(
                local.build_lumi_frame(
                    local.LUMI_TYPE_COMMAND, local.build_command_payload(trait, lock_did), seq=2
                )
            )
            _LOG.info("%s command (%s) sent + ACKed ✓", args.op.upper(), trait)
            try:
                resp = await transport.read(timeout=4.0)
                _LOG.info("RESULT: %s", resp[16:].decode("utf-8", "replace"))
            except local.LocalTransportError:
                _LOG.info("command ACKed (no extra response frame)")
        finally:
            await transport.close()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(130)
