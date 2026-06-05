"""GATT UUIDs + AIOT RegLogin handshake framing (ported from protocol/gatt.ts).

Decoded 100% from getAiotLongPackageList and verified against the real lock.
"""

from __future__ import annotations

from .crypto import crc16_arc

# Handshake channel (0xffa0 service): cloud<->lock public-key exchange.
HANDSHAKE_WRITE = "0000ffb1-0000-1000-8000-00805f9b34fb"  # app→lock
HANDSHAKE_NOTIFY = "0000ffb2-0000-1000-8000-00805f9b34fb"  # lock→app
# Main command channel (service f2042ffd-...): encrypted commands + status.
CMD_WRITE = "0000ff61-2333-5b1e-9d7c-c687fd2f04f2"
CMD_NOTIFY = "0000ff62-2333-5b1e-9d7c-c687fd2f04f2"

HS_HEAD = 0x5A  # app→lock magic
HS_LAST = 0xFF  # final fragment index


def build_aiot_frames(
    pack_cmd: int, data: bytes, frag_max: int = 18, need_encrypt: bool = False
) -> list[bytes]:
    """Build AIOT RegLogin frames.

    header frag = 5a 00 [enc] [cmdHi cmdLo] [0100|ffff] [len 00] [CRC16-ARC LE] + pad(9x00)
    data frags  = 5a [idx>=01] [<=frag_max bytes], last idx = ff
    pack_cmd e.g. 0x0610 (publickey) / 0x0710 (verify).
    """
    out: list[bytes] = []
    crc = crc16_arc(data)  # 2B LE
    enc = 0x01 if need_encrypt else 0x00
    cmd_hi, cmd_lo = (pack_cmd >> 8) & 0xFF, pack_cmd & 0xFF
    pad9 = bytes(9)
    if not data:
        out.append(
            bytes((HS_HEAD, HS_LAST, enc, cmd_hi, cmd_lo, 0xFF, 0xFF, 0x00, 0x00)) + crc + pad9
        )
    else:
        out.append(
            bytes((HS_HEAD, 0x00, enc, cmd_hi, cmd_lo, 0x01, 0x00, len(data) & 0xFF, 0x00))
            + crc
            + pad9
        )
        n = -(-len(data) // frag_max)  # ceil
        for i in range(n):
            idx = HS_LAST if i == n - 1 else i + 1
            chunk = data[i * frag_max : (i + 1) * frag_max]
            out.append(bytes((HS_HEAD, idx)) + chunk)
    return out


class HsReassembler:
    """Reassemble 'da' notify fragments: skip header frag (idx 00), join until idx ff."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def push(self, pkt: bytes) -> bytes | None:
        if len(pkt) < 2:
            return None
        idx = pkt[1]
        if idx != 0x00:
            self._buf.extend(pkt[2:])
        if idx == HS_LAST:
            out = bytes(self._buf)
            self._buf.clear()
            return out
        return None


def extract_pubkey(blob: bytes) -> bytes:
    """Pull the 65-byte device public key (starts with 0x04) out of a reassembled blob."""
    for i in range(len(blob) - 65 + 1):
        if blob[i] == 0x04:
            return blob[i : i + 65]
    return blob  # fallback
