import { type ActionFunctionArgs } from "@remix-run/node";
import { requireAuth } from "~/lib/session.server";
import { cloudFor } from "~/lib/aqara.server";
import { getMonitor } from "~/lib/monitor.server";

// POST /api/lock { did, op: "unlock"|"lock" } → điều khiển khóa qua cloud /matter/write.
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
    if (op === "unlock") await cloud.remoteUnlock(did);
    else await cloud.remoteLock(did);
    // đẩy refresh trạng thái cho UI ngay (qua SSE)
    getMonitor(auth).kick();
    return Response.json({ ok: true, op });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message?.slice(0, 160) || "lỗi" }, { status: 502 });
  }
}
