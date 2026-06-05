"""Local-hub (LAN) control path for the Aqara D100 — reverse-engineered protocol.

The lock is Zigbee; it has no IP of its own. When the phone is on the same LAN as the
hub (G410), the official app does NOT hit the cloud — it sends the unlock command
*directly to the hub* over a **ThroughTek (TUTK) PPCS peer-to-peer tunnel**, and the hub
relays it to the lock over Zigbee. This module documents and (partially) implements that
path so a fully-local, internet-independent unlock is possible.

═══════════════════════════════════════════════════════════════════════════════════════
PROTOCOL STACK (top → bottom), all reverse-engineered 2026-06 — see docs/REVERSE_ENGINEERING.md
═══════════════════════════════════════════════════════════════════════════════════════

  ┌─ Layer 1 — Application command ────────────────────────────────────────────────────┐
  │  A Matter DoorLock trait write, identical to the cloud `/matter/write` body:        │
  │     {"2.148.35011.0": ""}   (unlock)   /   {"2.148.35010.0": ""}  (lock)            │
  │  (CommandSpec decoded from the lock's React Native plugin bundle.)                   │
  └─────────────────────────────────────────────────────────────────────────────────────┘
  ┌─ Layer 2 — "lumi" framing ─────────────────────────────────────────────────────────┐
  │     b"lumi"(6c756d69) ‖ type(4B LE) ‖ seq(4B LE) ‖ len(4B LE) ‖ payload             │
  │   • login : type=0x1000, payload = LOGIN_JSON (see below)                            │
  │   • keepalive : type=0x1024, len=0                                                   │
  │   • command : payload = the Matter trait JSON                                        │
  └─────────────────────────────────────────────────────────────────────────────────────┘
  ┌─ Layer 3 — TUTK PPCS P2P tunnel (libPPCS_API.so) ──────────────────────────────────┐
  │  `PPCS_Write(handle, channel, plaintext)` → cs2p2p__P2P_Proprietary_Encrypt(KEY, …) │
  │   → UDP datagrams (wire frames begin 0x28…) to the hub. On the LAN there is NO NAT,  │
  │   so no hole-punching / supernode / relay is involved — just direct UDP to hub:port. │
  │  KEY = the part after ':' in p2p_info().initStringApp  (e.g. "aqarakr19kn").         │
  └─────────────────────────────────────────────────────────────────────────────────────┘

LOGIN_JSON (Layer-2 payload, type 0x1000):
    {"app_public_key": <32B hex, ephemeral X25519 pub>,
     "app_sign":       <from cloud p2p_sign()>,
     "device_id":      <did>,
     "timestamp":      <unix-ms>}

SESSION SETUP (cloud-assisted, like the BLE handshake — cacheable):
    1. info = cloud.p2p_info(did)        # → ppcs key, TUTK DID (p2pId), hub pubkey
    2. (app_pub, app_priv) = x25519_keypair()
    3. sign = cloud.p2p_sign(did, app_pub).["sign"]   # cloud authorises the session
    4. open PPCS tunnel to the hub using info["p2pId"]
    5. PPCS_Write( lumi(0x1000, LOGIN_JSON) )          # authenticate
    6. PPCS_Write( lumi(cmd,    matter_json) )          # e.g. unlock

WHAT THIS MODULE PROVIDES
    • LocalSession dataclass + `prepare_local_session()` — does the cloud half (steps 1-3).
    • `build_lumi_frame()` / `parse_lumi_frame()` — Layer-2 framing (pure, testable).
    • `build_login_payload()` / `build_command_payload()` — the JSON payloads.
    • `ppcs_encrypt()` / `ppcs_decrypt()` — the TUTK `cs2p2p__P2P_Proprietary_*` cipher,
      reimplemented bit-exact in pure Python (verified 9/9 vs captured traffic). No `.so` needed.
WHAT IT DOES NOT (yet)
    • The PPPP/Kalay *session* state machine (Layer 3 transport): the UDP handshake that opens
      a P2P channel to the hub on the LAN (LanSearch/connect/ack, the `f1xx` control packets)
      before the lumi data frames flow. The cipher those packets use is now solved; what remains
      is the packet sequencing. A `PpcsTransport` Protocol is defined so a concrete UDP backend
      can be plugged in once the session handshake is replayed from `captures/hub/*.pcap`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import time
from dataclasses import dataclass
from typing import Any, Protocol

from .cloud import AqaraCloud

_LOGGER = logging.getLogger(__name__)

LUMI_MAGIC = b"lumi"  # 0x6c756d69

# lumi frame types observed on the wire
LUMI_TYPE_LOGIN = 0x1000  # login req (resp 0x1001)
LUMI_TYPE_KEEPALIVE = 0x1024  # keepalive (resp 0x1025)
LUMI_TYPE_COMMAND = 0x1020  # Matter command (a.k.a. /matter/write) — resp 0x1021 + {"state":"end"}
#   ^ found live: only 0x1020 ran the trait and returned the full RPC cycle
#     ({"code":0} + {"code":"0"} + {"state":"end"}); other types reply "unsupport cmd".


# --- Layer 3a: TUTK PPCS proprietary cipher (REIMPLEMENTED, bit-exact) ------------------
# `cs2p2p__P2P_Proprietary_Encrypt(key, in, out, len)` reversed from libPPCS_API.so
# (aarch64, fn @0x192ec). Verified 9/9 against captured plaintext↔ciphertext pairs
# (key="aqarakr19kn", lengths 4/8/20/24/40). It's a self-synchronising (CFB-style) stream
# cipher over a fixed 256-byte substitution table — the public TUTK "Kalay" constant.
#
#   seeds = [ sum(key), -sum(key), sum((b*0xAB)>>9 for b in key), xor(key) ]  (each &0xff)
#   out[0]   = TABLE[sum(key)&0xff] ^ in[0]
#   out[i>0] = TABLE[(seeds[fb & 3] + fb) & 0xff] ^ in[i]   where fb = ciphertext[i-1]
#
# (encrypt feeds back the *output* byte; decrypt feeds back the *input* byte.)
PPCS_TABLE = bytes.fromhex(
    "7c9ce84a13dedcb22f2123e4307b3d8cbc0b270c3cf79ae7087196009785efc1"
    "1fc4dba1c2ebd901faba3b05b81587832872d18b5ad6da9358feaacc6e1bf0a3"
    "88ab43c00db545384f502266207f075b14981d9ba72ab9a8cbf1fc4947063eb1"
    "0e043a945eee541134dd4df9ecc7c9e3781a6f706ba4bda95dd5f8e5bb26af42"
    "37d8e1020aae5f1cc573094e6924906d12b319ad748a2940f52dbea559e0f479"
    "d24bce8982488425c6912ba2fb8fe9a6b09e3f65f603312eac0f952c5ced39b7"
    "336c567eb4a0fd7a815351868d9f77ff6a80dfe2bf10d775645776f355cdd0c8"
    "18e6364162cf99f2324c67606192cad3ea637d16b68ed46835c3529d46441e17"
)


def _ppcs_seeds(key: bytes) -> tuple[int, int, int, int]:
    """The 4 key-derived feedback seeds (key is capped to 20 bytes, like strnlen)."""
    key = key[:20]
    total = sum(key)
    s_xor = 0
    for b in key:
        s_xor ^= b
    return (
        total & 0xFF,
        (-total) & 0xFF,
        sum((b * 0xAB) >> 9 for b in key) & 0xFF,
        s_xor & 0xFF,
    )


def ppcs_encrypt(key: bytes, data: bytes) -> bytes:
    """TUTK ``_P2P_Proprietary_Encrypt`` — pure Python, bit-exact. Empty key → passthrough."""
    if not key or not data:
        return data
    seeds = _ppcs_seeds(key)
    out = bytearray(len(data))
    out[0] = PPCS_TABLE[seeds[0]] ^ data[0]
    fb = out[0]
    for i in range(1, len(data)):
        out[i] = PPCS_TABLE[(seeds[fb & 3] + fb) & 0xFF] ^ data[i]
        fb = out[i]
    return bytes(out)


def ppcs_decrypt(key: bytes, data: bytes) -> bytes:
    """TUTK ``_P2P_Proprietary_Decrypt`` — inverse of :func:`ppcs_encrypt` (feedback = ciphertext)."""
    if not key or not data:
        return data
    seeds = _ppcs_seeds(key)
    out = bytearray(len(data))
    out[0] = PPCS_TABLE[seeds[0]] ^ data[0]
    fb = data[0]
    for i in range(1, len(data)):
        out[i] = PPCS_TABLE[(seeds[fb & 3] + fb) & 0xFF] ^ data[i]
        fb = data[i]
    return bytes(out)


# --- Layer 2: lumi framing -------------------------------------------------------------
def build_lumi_frame(frame_type: int, payload: bytes, seq: int = 1) -> bytes:
    """b"lumi" ‖ type(LE32) ‖ seq(LE32) ‖ len(LE32) ‖ payload."""
    return (
        LUMI_MAGIC
        + frame_type.to_bytes(4, "little")
        + seq.to_bytes(4, "little")
        + len(payload).to_bytes(4, "little")
        + payload
    )


def parse_lumi_frame(data: bytes) -> tuple[int, int, bytes]:
    """→ (type, seq, payload). Raises ValueError if the magic is wrong."""
    if data[:4] != LUMI_MAGIC:
        raise ValueError(f"not a lumi frame: {data[:8].hex()}")
    frame_type = int.from_bytes(data[4:8], "little")
    seq = int.from_bytes(data[8:12], "little")
    length = int.from_bytes(data[12:16], "little")
    return frame_type, seq, data[16 : 16 + length]


def build_login_payload(
    app_public_key_hex: str, app_sign: str, did: str, timestamp: str | None = None
) -> bytes:
    """The type-0x1000 login JSON (Layer-2 payload).

    ⚠️ ``timestamp`` MUST be the ``time`` value returned by the cloud ``p2p/sign`` call — the
    cloud's ``app_sign`` is computed over (app_public_key + that time), and the hub rejects the
    login (``{"code":-1}``) if the timestamp doesn't match what was signed. Only fall back to the
    local clock when no cloud time is available (will fail validation on a real hub).
    """
    return json.dumps(
        {
            "app_public_key": app_public_key_hex,
            "app_sign": app_sign,
            "device_id": did,
            "timestamp": timestamp or str(int(time.time() * 1000)),
        },
        separators=(",", ":"),
    ).encode()


def build_command_payload(trait: str, lock_did: str, value: Any = "") -> bytes:
    """The Matter command for the lumi data channel — same body as the cloud `/matter/write`.

    The cloud sends ``{"data":{trait:value},"did":lock_did,"pwd":"","type":0}`` and the app's
    native layer routes that *same* body over the local hub when on-LAN (see cloud.matter_write).
    ``lock_did`` is the **D100's** DID (the hub/G410 relays it over Zigbee); the PPPP session
    itself is opened to the **hub's** DID, not the lock's. Carry this in a lumi frame of type
    :data:`LUMI_TYPE_COMMAND` (0x1020). ✅ **Verified live**: unlock returned ``{"code":"0"}`` and
    the D100 physically opened.
    """
    return json.dumps(
        {"data": {trait: value}, "did": lock_did, "pwd": "", "type": 0},
        separators=(",", ":"),
    ).encode()


# --- Cloud-assisted session setup (the implementable half) -----------------------------
@dataclass
class LocalSession:
    """Everything (besides the live X25519 secret) needed to drive the PPCS tunnel."""

    did: str
    ppcs_key: str  # AES key for cs2p2p__P2P_Proprietary_Encrypt, from initStringApp
    init_string: str  # full TUTK init string (before the ':')
    p2p_id: str  # TUTK DID, e.g. "AQARAKR-XXXXXX-XXXXX"
    dev_public_key: str  # hub static X25519 public key
    app_public_key: str  # our ephemeral X25519 public key
    app_sign: str  # cloud-issued authorisation over (app_public_key + sign_time)
    sign_time: str  # the cloud's `time` for app_sign — MUST be the login `timestamp`


async def prepare_local_session(
    cloud: AqaraCloud, did: str, app_public_key_hex: str, dev_pwd: str = ""
) -> LocalSession:
    """Do the cloud half of the local handshake (p2p_info + p2p_sign).

    Caller supplies a freshly-generated ephemeral X25519 public key. The result holds the
    PPCS key, the TUTK DID, the cloud-issued `app_sign` and the `time` it was signed at (which
    becomes the login `timestamp`) — feed these to a PpcsTransport. ``did`` here is the **hub's**
    DID (the device that owns the P2P stream), not the Zigbee lock's.
    """
    info = await cloud.p2p_info(did)
    init_app = str(info.get("initStringApp", ""))
    init_string, _, ppcs_key = init_app.partition(":")
    signed = await cloud.p2p_sign(did, app_public_key_hex, dev_pwd)
    return LocalSession(
        did=did,
        ppcs_key=ppcs_key,
        init_string=init_string,
        p2p_id=str(info.get("p2pId", "")),
        dev_public_key=str(info.get("devP2pPublicKey", "")),
        app_public_key=app_public_key_hex,
        app_sign=str(signed.get("sign", "")),
        sign_time=str(signed.get("time", "")),
    )


# --- Layer 3 transport interface (pluggable; needs a TUTK PPCS backend) ----------------
class PpcsTransport(Protocol):
    """A backend that can open a TUTK PPCS tunnel and write/read lumi frames.

    Implement with the TUTK PPCS SDK (or a reimplementation of cs2p2p__P2P_Proprietary_*).
    `session.ppcs_key` is the cipher key; `session.p2p_id` is the DID to connect to.
    """

    async def connect(self, session: LocalSession) -> None: ...
    async def write(self, payload: bytes) -> None: ...  # raw lumi frame; backend encrypts
    async def read(self, timeout: float = 4.0) -> bytes: ...  # decrypted lumi frame
    async def close(self) -> None: ...


async def local_unlock(
    transport: PpcsTransport, session: LocalSession, trait: str, lock_did: str
) -> None:
    """Full local unlock once a PpcsTransport is connected: login, then the command.

    ``session.did`` is the **hub/G410** DID (the P2P endpoint); ``lock_did`` is the **D100** DID
    the command targets (the hub relays it over Zigbee).
    """
    await transport.connect(session)
    try:
        await transport.write(
            build_lumi_frame(
                LUMI_TYPE_LOGIN,
                build_login_payload(
                    session.app_public_key, session.app_sign, session.did, session.sign_time
                ),
            )
        )
        await transport.write(
            build_lumi_frame(LUMI_TYPE_COMMAND, build_command_payload(trait, lock_did), seq=2)
        )
    finally:
        await transport.close()


# ════════════════════════════════════════════════════════════════════════════════════════
# Layer 3 — TUTK PPPP / "Kalay" P2P transport over UDP (concrete backend, decoded from
# captures/hub/hub_local_udp_session.pcap). On the LAN this is a tiny reliable-UDP protocol:
# a PPPP packet is `F1 <type> <len:2 BE> <payload>`, and EVERY packet is wrapped by the TUTK
# cipher (`ppcs_encrypt`/`ppcs_decrypt`, key = LocalSession.ppcs_key, e.g. "aqarakr19kn").
#
# Handshake (LAN, no NAT/supernode/relay — those are only needed across the internet):
#   1. app → hub : MSG_PUNCH_PKT(0x41)  payload = encoded DID (e.g. AQARAKR-XXXXXX-XXXXX)
#   2. hub → app : MSG_P2P_RDY(0x42) / MSG_P2P_RDY_ACK(0x43)  → session is up
#   3. app → hub : MSG_DRW(0xd0) channel 0, index 0 = lumi LOGIN frame; retransmit until
#                  the hub replies MSG_DRW_ACK(0xd1) acking index 0 (and a lumi {"code":0}).
#   4. app → hub : MSG_DRW channel 0, index N = lumi command (the Matter unlock trait).
#   5. both keep the link warm with MSG_ALIVE(0xe0)/MSG_ALIVE_ACK(0xe1).
#
# MSG_DRW body      : D1 <channel:1> <index:2 BE> <lumi frame>   (D1 is a constant marker)
# MSG_DRW_ACK body  : D1 <channel:1> <count:2 BE> <index:2 BE>×count
# ════════════════════════════════════════════════════════════════════════════════════════

PPPP_MAGIC = 0xF1
MSG_LAN_SEARCH = 0x30  # broadcast discovery (to 255.255.255.255:32108)
MSG_PUNCH_PKT = 0x41  # app announces itself / connects to a DID
MSG_P2P_RDY = 0x42  # hub: session ready
MSG_P2P_RDY_ACK = 0x43  # hub: session ready (ack form, carries session info)
MSG_DRW = 0xD0  # data read/write (reliable, carries lumi frames)
MSG_DRW_ACK = 0xD1  # acknowledges received MSG_DRW indices
MSG_ALIVE = 0xE0  # keepalive ping
MSG_ALIVE_ACK = 0xE1  # keepalive pong
MSG_CLOSE = 0xF0  # tear down

PPPP_LAN_PORT = 32108  # standard TUTK LAN-discovery UDP port
DRW_MARKER = 0xD1  # constant first byte of every DRW / DRW_ACK body
CHAN_CMD = 0x00  # the lumi command/control channel (0x04 is the bulk-data channel)


def encode_p2p_did(p2p_id: str) -> bytes:
    """`"AQARAKR-XXXXXX-XXXXX"` → 20-byte TUTK DID struct used in PUNCH/RDY packets.

    Layout: prefix(8B, ascii + NUL pad) ‖ number(4B big-endian) ‖ suffix(8B, ascii + NUL pad).
    e.g. ``AQARAKR\\0`` ‖ ``00 01 76 bd`` (=95933) ‖ ``JENFK\\0\\0\\0``.
    """
    prefix, number, suffix = p2p_id.split("-")
    return (
        prefix.encode("ascii").ljust(8, b"\0")
        + int(number).to_bytes(4, "big")
        + suffix.encode("ascii").ljust(8, b"\0")
    )


def build_pppp(msg_type: int, payload: bytes = b"") -> bytes:
    """A raw (pre-cipher) PPPP packet: ``F1 <type> <len:2 BE> <payload>``."""
    return bytes([PPPP_MAGIC, msg_type]) + len(payload).to_bytes(2, "big") + payload


def parse_pppp(data: bytes) -> tuple[int, bytes]:
    """Decoded PPPP packet → (msg_type, payload). Raises ValueError on a bad magic/length."""
    if len(data) < 4 or data[0] != PPPP_MAGIC:
        raise ValueError(f"not a PPPP packet: {data[:8].hex()}")
    length = int.from_bytes(data[2:4], "big")
    return data[1], data[4 : 4 + length]


def build_drw(channel: int, index: int, lumi_frame: bytes) -> bytes:
    """MSG_DRW body for a reliable data frame: ``D1 <channel> <index:2 BE> <lumi frame>``."""
    return build_pppp(
        MSG_DRW, bytes([DRW_MARKER, channel]) + index.to_bytes(2, "big") + lumi_frame
    )


def build_drw_ack(channel: int, indices: list[int]) -> bytes:
    """MSG_DRW_ACK body acknowledging one or more received DRW indices on a channel."""
    body = bytes([DRW_MARKER, channel]) + len(indices).to_bytes(2, "big")
    for i in indices:
        body += i.to_bytes(2, "big")
    return build_pppp(MSG_DRW_ACK, body)


def parse_drw(payload: bytes) -> tuple[int, int, bytes]:
    """MSG_DRW payload → (channel, index, lumi_frame)."""
    return payload[1], int.from_bytes(payload[2:4], "big"), payload[4:]


class PpcsUdpTransport:
    """Concrete :class:`PpcsTransport` — TUTK PPPP over UDP on the LAN, pure Python.

    Every datagram is ``ppcs_encrypt(key, build_pppp(...))`` on the way out and
    ``parse_pppp(ppcs_decrypt(key, datagram))`` on the way in. Implements the reliable-DRW
    handshake decoded from the capture: send-with-retransmit until the hub ACKs, ACK the
    hub's frames, and keep the link warm with MSG_ALIVE.

    Construct with the hub's LAN IP (discover via mDNS/HA, or pass it in). If the port is
    unknown it falls back to a short unicast sweep around the captured range, then to a
    broadcast LAN search — see :meth:`connect`.
    """

    def __init__(self, hub_ip: str, hub_port: int | None = None) -> None:
        self._hub_ip = hub_ip
        self._hub_port = hub_port
        self._sock: socket.socket | None = None
        self._key = b""
        self._tx_index = 0  # next MSG_DRW index we will send on CHAN_CMD
        self._rx_indices: set[int] = set()  # hub DRW indices we've already ACKed
        self._rx_lumi: list[bytes] = []  # lumi reply frames buffered while waiting on an ACK
        self._loop = None

    # -- low-level send/recv (cipher applied here) -------------------------------------
    def _send(self, raw_pppp: bytes) -> None:
        assert self._sock is not None
        self._sock.sendto(ppcs_encrypt(self._key, raw_pppp), (self._hub_ip, self._hub_port))

    async def _recv(self, timeout: float) -> tuple[int, bytes] | None:
        """Receive one decoded PPPP packet (msg_type, payload), or None on timeout.

        Transparently answers MSG_ALIVE and re-ACKs hub MSG_DRW frames so the caller only
        sees the packet types it cares about.
        """
        assert self._sock is not None and self._loop is not None
        deadline = self._loop.time() + timeout
        while True:
            remaining = deadline - self._loop.time()
            if remaining <= 0:
                return None
            try:
                data = await asyncio.wait_for(
                    self._loop.sock_recv(self._sock, 2048), timeout=remaining
                )
            except (asyncio.TimeoutError, BlockingIOError):
                return None
            try:
                msg_type, payload = parse_pppp(ppcs_decrypt(self._key, data))
            except ValueError:
                continue
            if msg_type == MSG_ALIVE:  # answer keepalives transparently
                self._send(build_pppp(MSG_ALIVE_ACK))
                continue
            if msg_type == MSG_DRW:  # ACK every hub data frame so it stops retransmitting
                channel, index, _ = parse_drw(payload)
                self._send(build_drw_ack(channel, [index]))
                self._rx_indices.add(index)
            return msg_type, payload

    # -- PpcsTransport interface -------------------------------------------------------
    async def connect(self, session: LocalSession) -> None:
        """Open the UDP socket and complete the PPPP discovery + punch/ready handshake.

        Discovery (verified live against a G410): the hub's session UDP port is **dynamic**
        per session, but it listens on the well-known LAN port 32108. We PUNCH there; the hub
        replies *from* its current session port. We then PUNCH that port until it's ready.
        """
        self._key = session.ppcs_key.encode() if session.ppcs_key else b""
        self._loop = asyncio.get_running_loop()
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setblocking(False)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        self._sock.bind(("", 0))
        did = encode_p2p_did(session.p2p_id)
        punch = build_pppp(MSG_PUNCH_PKT, did)

        # Phase 1 — discovery: send a *ciphered* MSG_LAN_SEARCH to the well-known LAN port; the
        # hub replies (a PUNCH echo) *from* a freshly-allocated session port. (Verified live:
        # only the ciphered LAN_SEARCH triggers a reply — a bare PUNCH to 32108 is ignored — and
        # the session port differs every time, so we must use the port from the reply at once.)
        if self._hub_port is None:
            disco_port = PPPP_LAN_PORT
            lan_search = ppcs_encrypt(self._key, build_pppp(MSG_LAN_SEARCH))
            session_port: int | None = None
            for _ in range(8):
                self._sock.sendto(lan_search, (self._hub_ip, disco_port))
                reply = await self._recvfrom(0.4)
                if reply is not None:
                    (_mt, _pl), addr = reply
                    session_port = addr[1]
                    break
            if session_port is None:
                raise LocalTransportError(
                    f"hub {self._hub_ip}:{disco_port} did not answer LAN discovery"
                )
            self._hub_port = session_port
            _LOGGER.debug("hub session port discovered: %s", session_port)

        # Phase 2 — PUNCH the session port until the hub reports it's ready (RDY/RDY_ACK).
        # The hub's own PUNCH echo from that port also means the channel is open.
        for _ in range(12):
            self._send(punch)
            got = await self._recv(0.3)
            if got and got[0] in (MSG_P2P_RDY, MSG_P2P_RDY_ACK, MSG_PUNCH_PKT):
                _LOGGER.debug("PPPP session up with %s:%s", self._hub_ip, self._hub_port)
                return
        raise LocalTransportError(
            f"no PPPP ready from hub {self._hub_ip}:{self._hub_port}"
        )

    async def _recvfrom(self, timeout: float) -> tuple[tuple[int, bytes], tuple] | None:
        """Like :meth:`_recv` but also returns the source address (for port discovery)."""
        assert self._sock is not None and self._loop is not None
        try:
            data, addr = await asyncio.wait_for(
                self._loop.sock_recvfrom(self._sock, 2048), timeout=timeout
            )
        except (asyncio.TimeoutError, BlockingIOError):
            return None
        try:
            return parse_pppp(ppcs_decrypt(self._key, data)), addr
        except ValueError:
            return None

    async def write(self, lumi_frame: bytes) -> None:
        """Send a lumi frame as a reliable MSG_DRW, retransmitting until the hub ACKs it.

        The hub interleaves its own data frames (responses) with the DRW_ACK, so we drain
        *every* incoming packet looking for our ACK while resending periodically (~6 Hz),
        rather than one-packet-per-resend. Replies are buffered for :meth:`read`.
        """
        assert self._loop is not None
        index = self._tx_index
        self._tx_index += 1
        packet = build_drw(CHAN_CMD, index, lumi_frame)
        deadline = self._loop.time() + 3.0
        last_send = -1.0
        while self._loop.time() < deadline:
            now = self._loop.time()
            if now - last_send >= 0.15:
                self._send(packet)
                last_send = now
            got = await self._recv(0.1)
            if not got:
                continue
            if got[0] == MSG_DRW_ACK and self._ack_contains(got[1], index):
                return
            if got[0] == MSG_DRW:  # a lumi reply arrived first — buffer it for read()
                self._rx_lumi.append(parse_drw(got[1])[2])
        raise LocalTransportError(f"hub never ACKed DRW index {index}")

    @staticmethod
    def _ack_contains(payload: bytes, index: int) -> bool:
        """True if a MSG_DRW_ACK body lists ``index``."""
        count = int.from_bytes(payload[2:4], "big")
        acked = {
            int.from_bytes(payload[4 + 2 * i : 6 + 2 * i], "big") for i in range(count)
        }
        return index in acked

    async def read(self, timeout: float = 4.0) -> bytes:
        """Return the next lumi frame the hub sent (from the buffer, else wait for one)."""
        if self._rx_lumi:
            return self._rx_lumi.pop(0)
        got = await self._recv(timeout)
        if not got:
            raise LocalTransportError("timed out waiting for a hub lumi frame")
        if got[0] == MSG_DRW:
            return parse_drw(got[1])[2]
        return b""

    async def close(self) -> None:
        if self._sock is not None:
            try:
                self._send(build_pppp(MSG_CLOSE))
            except OSError:
                pass
            self._sock.close()
            self._sock = None


class LocalTransportError(Exception):
    """Raised when the PPPP/UDP transport can't reach or talk to the hub."""
