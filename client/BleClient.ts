// Lớp BLE transport trừu tượng — chỉ định nghĩa `listen` và `send` (+ connect/disconnect).
// Cài đặt cụ thể phụ thuộc nền tảng (noble / react-native-ble-plx / bleak qua bridge…).
// Kế thừa và hiện thực 4 abstract method; phần protocol (framing/crypto) nằm ở lớp trên.

export type NotifyCallback = (data: Uint8Array) => void;
export type Unsubscribe = () => void;

export abstract class BleClient {
  /** Kết nối tới khoá theo MAC (vd "<LOCK_MAC>"). */
  abstract connect(mac: string): Promise<void>;
  abstract disconnect(): Promise<void>;

  /** Ghi raw bytes vào 1 characteristic (write-without-response hoặc write). */
  abstract send(charUuid: string, data: Uint8Array): Promise<void>;

  /** Đăng ký nhận notify từ 1 characteristic. Trả hàm huỷ đăng ký. */
  abstract listen(charUuid: string, cb: NotifyCallback): Promise<Unsubscribe>;

  /**
   * Helper: bật listen trên notifyChar, ghi data vào writeChar, chờ notify đầu tiên
   * (hoặc tới khi `accept` trả true). Tự huỷ đăng ký + timeout.
   */
  async request(
    writeChar: string,
    notifyChar: string,
    data: Uint8Array,
    opts: { timeoutMs?: number; accept?: (d: Uint8Array) => boolean } = {},
  ): Promise<Uint8Array> {
    const { timeoutMs = 5000, accept } = opts;
    return new Promise<Uint8Array>(async (resolve, reject) => {
      let unsub: Unsubscribe = () => {};
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`BLE request timeout ${timeoutMs}ms (write=${writeChar})`));
      }, timeoutMs);
      try {
        unsub = await this.listen(notifyChar, (d) => {
          if (accept && !accept(d)) return;
          clearTimeout(timer);
          unsub();
          resolve(d);
        });
        await this.send(writeChar, data);
      } catch (e) {
        clearTimeout(timer);
        unsub();
        reject(e);
      }
    });
  }
}
