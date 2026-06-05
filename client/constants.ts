// Hằng số đã reverse cho Aqara D100 (dp1a / aqara.lock.aqgl01).
// Nguồn: rn_bundle/lock.bundle, captures/* , hook native getSignHead.

// ----- Cloud -----
export const APPID = "444c476ef7135e53330f46e7"; // cố định app Aqara Home v6.1.6
/** appKey SECRET — dùng cho `sign` (MD5) và `x-aes128gcm` (aesEncryptedContent). Lộ qua hook getSignHead arg6. */
export const APPKEY = "uOJy0qmKwXj6aHUB2KQEIJuXHMDVTAJi";

/** Base URL theo area (account này = SEA → rpc-au). HTTP/2. */
export const CLOUD_HOSTS: Record<string, string> = {
  SEA: "https://rpc-au.aqara.com",
  CN: "https://rpc.aqara.cn",
  US: "https://rpc-us.aqara.com",
  EU: "https://rpc-ger.aqara.com",
  KR: "https://rpc-kr.aqara.com",
};
export const API_PREFIX = "/app/v1.0/lumi";

// ----- GATT UUID (BLE) -----
export const UUID = {
  // Kênh handshake / RegLogin
  HANDSHAKE_WRITE: "0000ffb1-0000-1000-8000-00805f9b34fb", // app→lock (h.0x0010)
  HANDSHAKE_NOTIFY: "0000ffb2-0000-1000-8000-00805f9b34fb", // lock→app (h.0x0012)
  // Kênh lệnh chính (service f2042ffd-...; char quan sát trong crypto.log)
  CMD_WRITE: "0000ff61-2333-5b1e-9d7c-c687fd2f04f2", // app→lock (h.0x0016)
  // ⚠️ char NOTIFY của kênh lệnh chưa xác nhận chắc (h.0x0018). Cập nhật khi sniff được.
  CMD_NOTIFY: "0000ff62-2333-5b1e-9d7c-c687fd2f04f2",
} as const;

// ----- Framing handshake (kênh ffb1) -----
export const HS_MAGIC_APP = 0x5a; // app→lock
export const HS_MAGIC_LOCK = 0xda; // lock→app
export const HS_LAST_IDX = 0xff; // chunk_idx cuối

// ----- mainCmd (gửi) -----
export enum MainCmd {
  SYSTEM = 0x01,
  USER = 0x02,
  LOG = 0x03,
  ALARM = 0x04,
  DEVICELOG = 0x05,
  XXQ = 0x06,
  SYSTEM_EXT = 0x07,
  LONG = 0x3f,
}
// ----- mainCmd (reply) -----
export enum ReplyMainCmd {
  SYSTEM = 0x81,
  USER = 0x82,
  LOG = 0x83,
}

// ----- SystemSubCmd (mainCmd=01) -----
export enum SystemSub {
  DOUBLE_VERIFY = 0x04,
  LOCK_STATUS = 0x07,
  TONGUE_STATUS = 0x08,
  REPORT_TONGUE_STATUS = 0x09,
  REPORT_BATTERY = 0x0a,
  FIRMWARE_VERSION = 0x0d,
  REPORT_LOCK_STATUS = 0x15,
  UN_LOCK = 0x18, // ⚠️ KHÔNG phải mở khoá — chỉ setUnlockAlarmInfo
  REPORT_UN_LOCK = 0x1b,
  REPORT_LOCK_LOG = 0x1d,
  REPORT_DOOR_LOG = 0x1e,
  FINGER_COUNT = 0x20,
  HARDWARE_VERSION = 0x21,
  HEART_PCK = 0x2f,
  HANDLE_DIRECTION = 0x30,
  REPORT_BATTERY_POWER = 0x50,
  BLE_OPEN_LOCK = 0x74, // ✅ mở khoá
  GET_LITHIUM_BATTERY_STATUS = 0x78,
  SET_AUTO_LOCK_TIME = 0xad,
  GET_AUTO_LOCK_TIME = 0xae,
  ANTI_LOCK_MANAGER_STATUS = 0xcc,
  GET_BATTERY_INFO = 0xde,
  GET_DOOR_LOCK_STATUS = 0xe5,
  REPORT_DOOR_LOCK_STATUS = 0xe6,
  REPOFT_E2E_SECRECT_KEY = 0xf4,
}

// ----- UserSubCmd (mainCmd=02) -----
export enum UserSub {
  ADD_USER = 0x01,
  QUITE_ADD_USER = 0x02,
  DEL_USER = 0x03,
  DEL_USER_GROUP = 0x05,
  REPORT_USER_ID = 0x06,
  FINGER_REGISTER = 0x07,
  USER_GROUP_PERMISSION = 0x08,
  NFC_CID = 0x0d,
  USER_EFFECTIVE_PERIOD = 0x0e,
  MODIFY_PWD = 0x10,
  ADD_SUCCESS = 0x11,
  ADD_VISTOR_PWD = 0x13, // addMIOTUser
  ABORT_ADD_MIOT_USER = 0x14,
  REPORT_USER_ID_NEW = 0x15,
}

// ----- LogSubCmd (mainCmd=03) -----
export enum LogSub {
  SYNC_USER_ID = 0x01,
  READ_TEMP_PWD = 0x08,
  NFC_CPLC = 0x0b,
  SE_APDU = 0x11,
  SYNC_DOOR_LOCK_LOG = 0x12,
  SYNC_LOG = 0x13, // getLogList
  SET_VISTOR_PWD_VAILD_TIME = 0x21,
}

// ----- opType mở khoá (data của BLE_OPEN_LOCK) -----
export enum OpenLockType {
  CLOSE = 0x00,
  OPEN = 0x01,
  UNBOLT = 0x02,
  TOGGLE = 0x03,
}

// ----- Credential type bytes -----
export enum CredType {
  COMMON_FP = 0x81,
  ADMIN_FP = 0x41,
  COMMON_PWD = 0x82,
  ADMIN_PWD = 0x42,
  NFC = 0x83,
  ADMIN_NFC = 0x43,
  KEY = 0x84,
  ADMIN_KEY = 0x44,
}

// ----- RepeatType (period user/pwd) -----
export enum RepeatType {
  FOREVER = 0x00,
  EVERY_DAY = 0x01,
  EVERY_WEEK = 0x02,
  EVERY_MONTH = 0x03,
  SET_VALID = 0x04,
}
