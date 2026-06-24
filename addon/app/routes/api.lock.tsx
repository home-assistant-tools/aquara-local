import { type ActionFunctionArgs } from "@remix-run/node";
import { requireAuth } from "~/lib/session.server";
import { cloudFor } from "~/lib/aqara.server";
import { getMonitor } from "~/lib/monitor.server";
import { pulseUnlock } from "~/lib/lightBridge.server";

// POST /api/lock { did, op: "unlock"|"lock" }.
// unlock: thử CẢ 2 đường — LOCAL (pulse đèn → automation hub) + CLOUD (/matter/write 35011) best-effort.
// lock: cloud (/matter/write 35010) — khóa không lộ action local; D100 cũng tự khóa lại.
export async function action({ request }: ActionFunctionArgs) {
  const auth = await requireAuth(request);
  const fd = await request.formData();
  const did = String(fd.get("did") || "");
  const op = String(fd.get("op") || "");
  if (!did || (op !== "unlock" && op !== "lock")) {
    return Response.json({ ok: false, error: "thiếu did/op" }, { status: 400 });
  }
  const cloud = cloudFor(auth);
  try {
    if (op === "unlock") {
      const r = await Promise.allSettled([pulseUnlock(did), cloud.remoteUnlock(did)]);
      if (r.every((x) => x.status === "rejected")) throw new Error("cả local lẫn cloud đều lỗi");
    } else {
      await cloud.remoteLock(did);
    }
    getMonitor(auth).kick();
    return Response.json({ ok: true, op });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message?.slice(0, 160) || "lỗi" }, { status: 502 });
  }
}
