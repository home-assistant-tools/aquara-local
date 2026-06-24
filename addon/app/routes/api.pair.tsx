import { type LoaderFunctionArgs } from "@remix-run/node";
import { allLightInfos, openPairingWindow } from "~/lib/lightBridge.server";

// GET /api/pair[?did=<lockDid>] → mở cửa sổ commissioning trên đèn-bridge để pair fabric thứ 2
// (vd Home Assistant). Trả manual/QR pairing code (GIỮ NGUYÊN mã gốc — default passcode).
// Không yêu cầu auth: chỉ mở cửa sổ Matter tạm thời (600s) trên thiết bị addon sở hữu (LAN-only).
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const did = url.searchParams.get("did");
  const seconds = Number(url.searchParams.get("seconds") || "600");
  const targets = did
    ? allLightInfos().filter((i) => i.lockDid === did || i.aqaraDid === did)
    : allLightInfos().filter((i) => i.aqaraDid);
  if (!targets.length) return Response.json({ ok: false, error: "không có light-bridge nào (chạy setup trước)" }, { status: 404 });

  const out: Array<{ lockDid: string; aqaraDid: string | null; manualPairingCode: string; qrPairingCode: string }> = [];
  for (const t of targets) {
    try {
      const codes = await openPairingWindow(t.lockDid, seconds);
      out.push({ lockDid: t.lockDid, aqaraDid: t.aqaraDid, ...codes });
    } catch (e: any) {
      out.push({ lockDid: t.lockDid, aqaraDid: t.aqaraDid, manualPairingCode: "", qrPairingCode: `lỗi: ${e?.message ?? e}` });
    }
  }
  return Response.json({ ok: true, windowSeconds: seconds, bridges: out });
}
