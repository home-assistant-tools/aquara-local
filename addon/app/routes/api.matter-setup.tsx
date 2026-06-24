import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { requireAuth } from "~/lib/session.server";
import { runMatterSetup, cachedMatterSetup } from "~/lib/matterSetup.server";

// GET /api/matter-setup → trạng thái đã cache (null nếu chưa chạy).
export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await requireAuth(request);
  return Response.json({ result: cachedMatterSetup(auth.token) });
}

// POST /api/matter-setup → chạy auto-setup (tạo+sync tín hiệu ra Matter + pairing code).
//   body force=1 → ép chạy lại (bỏ cache).
export async function action({ request }: ActionFunctionArgs) {
  const auth = await requireAuth(request);
  const fd = await request.formData().catch(() => null);
  const force = fd?.get("force") === "1";
  try {
    const result = await runMatterSetup(auth, { force });
    return Response.json({ ok: true, result });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message?.slice(0, 160) || "lỗi" }, { status: 502 });
  }
}
