"""MIoT command packing/unpacking for the Aqara D100 (ported from protocol/lock.ts).

packet = mainCmd ‖ AES-CCM(subCmd ‖ data ‖ CRC16-BE).  The openLock packet built
here matches the captured real packet byte-for-byte.
"""

from __future__ import annotations

from dataclasses import dataclass

from .crypto import aes_ccm_decrypt, aes_ccm_encrypt, mijia_crc16

# ---- opcodes --------------------------------------------------------------
MAIN_SYSTEM = 0x01
MAIN_USER = 0x02
MAIN_LOG = 0x03
MAIN_LONG = 0x3F

REPLY_SYSTEM = 0x81
REPLY_USER = 0x82
REPLY_LOG = 0x83

SYS_LOCK_STATUS = 0x07
SYS_TONGUE_STATUS = 0x08
SYS_GET_BATTERY_INFO = 0xDE
SYS_GET_DOOR_LOCK_STATUS = 0xE5
SYS_REPORT_DOOR_LOCK_STATUS = 0xE6
SYS_BLE_OPEN_LOCK = 0x74

LOG_SET_VISTOR_PWD_VALID_TIME = 0x21

USER_ADD_VISTOR_PWD = 0x13
USER_REPORT_USER_ID_NEW = 0x15
USER_DEL_USER = 0x03
USER_DEL_USER_GROUP = 0x05

# opType for BLE_OPEN_LOCK data byte
OPEN_CLOSE = 0x00
OPEN_OPEN = 0x01
OPEN_UNBOLT = 0x02
OPEN_TOGGLE = 0x03


@dataclass(frozen=True)
class LockKey:
    """Session material returned by the cloud handshake."""

    session_key: bytes  # 16B
    nonce: bytes  # 13B


@dataclass(frozen=True)
class LockFrame:
    main_cmd: int
    sub_cmd: int
    data: bytes


def pack_short(key: LockKey, main_cmd: int, sub_cmd: int, data: bytes = b"") -> bytes:
    """Short packet: mainCmd ‖ AES-CCM(subCmd ‖ data ‖ CRC16-BE). MIC=4."""
    crc = mijia_crc16(bytes((main_cmd, sub_cmd)) + data)  # [low, high]
    crc_be = bytes((crc[1], crc[0]))  # wire appends big-endian
    plain = bytes((sub_cmd,)) + data + crc_be
    cipher = aes_ccm_encrypt(key.session_key, key.nonce, plain)
    return bytes((main_cmd,)) + cipher


def unpack(key: LockKey, packet: bytes) -> LockFrame:
    """Decrypt a notify packet → (mainCmd, subCmd, data) with the trailing CRC removed."""
    main_cmd = packet[0]
    plain = aes_ccm_decrypt(key.session_key, key.nonce, packet[1:])
    sub_cmd = plain[0]
    data = plain[1 : max(1, len(plain) - 2)]
    return LockFrame(main_cmd=main_cmd, sub_cmd=sub_cmd, data=data)


def build_open_lock(key: LockKey, op_type: int = OPEN_OPEN, seq: int | None = None) -> bytes:
    """Unlock packet: 01/74 data=[opType]. open=01, close=00."""
    if seq is None:
        data = bytes((op_type,))
    else:
        data = bytes((op_type, seq & 0xFF, (seq >> 8) & 0xFF))
    return pack_short(key, MAIN_SYSTEM, SYS_BLE_OPEN_LOCK, data)


def build_door_status_query(key: LockKey) -> bytes:
    return pack_short(key, MAIN_SYSTEM, SYS_GET_DOOR_LOCK_STATUS)


def build_door_status_report_query(key: LockKey) -> bytes:
    return pack_short(key, MAIN_SYSTEM, SYS_REPORT_DOOR_LOCK_STATUS)


def parse_door_status(frame: LockFrame) -> int | None:
    """Return lockStatus (0 locked / 1 unlocked / 2 error) from a status notify, else None."""
    if frame.main_cmd != REPLY_SYSTEM:
        return None
    if frame.sub_cmd not in (
        SYS_REPORT_DOOR_LOCK_STATUS,
        SYS_GET_DOOR_LOCK_STATUS,
        SYS_LOCK_STATUS,
    ):
        return None
    if not frame.data:
        return None
    return frame.data[0]
