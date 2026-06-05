"""Low-level crypto for the D100 BLE protocol (ported from the TS client).

* Mijia CRC16  — appended to every command payload (verified 5/5 on the wire).
* CRC16/ARC    — used by the AIOT handshake framing.
* AES-CCM      — MIC = 4 bytes, the 13-byte nonce is used directly as the IV
                 (expandedIv = ''), no AAD. Verified byte-for-byte against the
                 real openLock packet `01d3c6a27b865a849f`.
"""

from __future__ import annotations

from cryptography.hazmat.primitives.ciphers.aead import AESCCM

CCM_MIC_LEN = 4


def mijia_crc16(data: bytes) -> bytes:
    """getCrc16Arr: init=0, poly=0x8005, MSB-first, no reflection. Returns [low, high]."""
    if not data:
        return b"\x00\x00"
    u = 0
    for byte in data:
        for v in range(8):
            n = u >> 15
            u = (u << 1) & 0xFFFF
            u |= (byte >> (7 - v)) & 1
            if n & 1:
                u ^= 0x8005
    u &= 0xFFFF
    return bytes((u & 0xFF, (u >> 8) & 0xFF))


def crc16_arc(data: bytes) -> bytes:
    """CRC16/ARC (poly 0x8005, init 0, reflected in/out). Used by handshake frames.

    Returns little-endian 2 bytes. Verified: ARC(cloudPublicKey)=8837.
    """

    def refl(b: int, n: int) -> int:
        r = 0
        for _ in range(n):
            r = (r << 1) | (b & 1)
            b >>= 1
        return r

    crc = 0
    for byte in data:
        crc ^= refl(byte, 8) << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x8005) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    crc = refl(crc & 0xFFFF, 16)
    return bytes((crc & 0xFF, (crc >> 8) & 0xFF))


def aes_ccm_encrypt(session_key: bytes, nonce: bytes, plaintext: bytes) -> bytes:
    """Encrypt and append a 4-byte MIC. nonce (13B) is the CCM IV directly."""
    if len(session_key) != 16:
        raise ValueError(f"sessionKey must be 16 bytes, got {len(session_key)}")
    return AESCCM(session_key, tag_length=CCM_MIC_LEN).encrypt(nonce, plaintext, None)


def aes_ccm_decrypt(session_key: bytes, nonce: bytes, cipher_with_tag: bytes) -> bytes:
    """Decrypt ct||tag(4). Raises InvalidTag on MIC mismatch (wrong key/nonce)."""
    return AESCCM(session_key, tag_length=CCM_MIC_LEN).decrypt(nonce, cipher_with_tag, None)
