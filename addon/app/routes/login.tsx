import { type ActionFunctionArgs, type LoaderFunctionArgs, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { getAuth, createUserSession } from "~/lib/session.server";
import { login } from "~/lib/aqara.server";
import { kickBootstrap } from "~/lib/bootstrap.server";
import { REGIONS } from "~/lib/regions";

export async function loader({ request }: LoaderFunctionArgs) {
  kickBootstrap(); // headless setup chạy nền khi addon được truy cập lần đầu (env creds)
  if (await getAuth(request)) throw redirect("/");
  return null;
}

export async function action({ request }: ActionFunctionArgs) {
  const fd = await request.formData();
  const email = String(fd.get("email") || "").trim();
  const password = String(fd.get("password") || "");
  const area = String(fd.get("area") || "SEA");
  if (!email || !password) return { error: "Nhập email và mật khẩu." };
  try {
    const auth = await login(email, password, area);
    return await createUserSession(auth, "/");
  } catch (e: any) {
    return { error: e?.message?.slice(0, 200) || "Đăng nhập thất bại." };
  }
}

export default function Login() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <div className="wrap center">
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div className="brand" style={{ justifyContent: "center", marginBottom: 18 }}>
          <span className="dot on" />
          <h1>Aquara Matter</h1>
        </div>
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Đăng nhập bằng tài khoản <b>Aqara Home</b> để điều khiển khóa cửa.
          </p>
          {data?.error && <div className="err">{data.error}</div>}
          <Form method="post">
            <label className="field">
              <span>Email Aqara</span>
              <input name="email" type="email" autoComplete="username" required placeholder="you@example.com" />
            </label>
            <label className="field">
              <span>Mật khẩu</span>
              <input name="password" type="password" autoComplete="current-password" required placeholder="••••••••" />
            </label>
            <label className="field">
              <span>Vùng máy chủ</span>
              <select name="area" defaultValue="SEA">
                {REGIONS.map((r) => (
                  <option key={r.id} value={r.id}>{r.label}</option>
                ))}
              </select>
            </label>
            <button className="pri" type="submit" disabled={busy} style={{ width: "100%" }}>
              {busy ? "Đang đăng nhập…" : "Đăng nhập"}
            </button>
          </Form>
        </div>
        <p className="muted" style={{ fontSize: 12, textAlign: "center" }}>
          Token lưu trong cookie phiên (httpOnly). Không gửi đi đâu ngoài máy chủ Aqara.
        </p>
      </div>
    </div>
  );
}
