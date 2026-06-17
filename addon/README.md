# Aquara Matter — Addon (Remix v2 + SSE)

Giao diện web để **đăng nhập tài khoản Aqara Home** → xem & điều khiển **khóa cửa** realtime.

- **Login**: email + mật khẩu Aqara + vùng máy chủ (SEA/CN/US/EU/KR).
- **Dashboard**: mỗi khóa hiển thị **trạng thái** (đang khóa/mở), **pin %**, **online**, và
  **"ai mở cửa gần đây"** (decode `lock_local_log`).
- **Điều khiển**: 🔓 Mở khóa / 🔒 Khóa (cloud `/matter/write` → hub → Zigbee, không cần BLE).
- **Realtime**: server poll cloud Aqara (trạng thái 30s, event ai-mở 12s) và đẩy về UI qua
  **SSE** (`/sse/events`) — không cần refresh.

Stack: **Remix v2** (Vite), server-side dùng [`../client/aqaraMatter.ts`](../client/aqaraMatter.ts).

## Chạy thử (dev)

```bash
cd addon
npm install
npm run dev            # http://localhost:7654
```

## Docker (build từ REPO ROOT — cần cả addon/ lẫn client/)

```bash
# từ thư mục gốc repo
docker build -f addon/Dockerfile -t aquara-matter-addon .
docker run --rm -p 7654:7654 -e SESSION_SECRET=$(openssl rand -hex 16) aquara-matter-addon
# → http://localhost:7654
```

## Cài làm Home Assistant addon

Addon mở cổng `7654`. Sau khi cài + start, mở **Web UI** từ trang addon (HA tự link tới
`http://<host>:7654`). Login bằng tài khoản Aqara.

> ⚠️ Build context của addon là **repo root** (Dockerfile `COPY client/`). Khi thêm vào HA dưới
> dạng addon repository, dùng cấu trúc repo này (Dockerfile đã trỏ `client/` đúng).

## Biến môi trường

| Env | Mô tả |
|-----|-------|
| `SESSION_SECRET` | khóa ký cookie phiên (đặt 1 chuỗi ngẫu nhiên cho production) |
| `PORT` | cổng web (mặc định 7654) |

## Bảo mật

Token Aqara lưu trong **cookie phiên httpOnly** (ký bằng `SESSION_SECRET`). Server chỉ gọi tới
máy chủ Aqara của vùng đã chọn. Không log/gửi credential đi nơi khác.

## Lộ trình

- [ ] Unlock **local** qua công tắc ảo Matter + automation hub (thay cloud `/matter/write`).
- [ ] Tự commission công tắc ảo + tạo automation + signal-export (xem [`../docs/MATTER_ADDON.md`](../docs/MATTER_ADDON.md)).
- [ ] HA Ingress (sidebar) thay cho cổng cố định.
- [ ] Decode đầy đủ "ai mở" (ánh xạ slot → tên credential qua `getLockCredentials`).
