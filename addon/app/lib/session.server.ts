import { createCookieSessionStorage, redirect } from "@remix-run/node";

export interface AuthData {
  token: string;
  userId: string;
  area: string;
  email?: string;
}

const secret = process.env.SESSION_SECRET || "aquara-matter-dev-secret-change-me";

export const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__aquara",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secrets: [secret],
    secure: false, // HA Ingress thường http nội bộ
    maxAge: 60 * 60 * 24 * 14,
  },
});

export async function getAuth(request: Request): Promise<AuthData | null> {
  const s = await sessionStorage.getSession(request.headers.get("Cookie"));
  const token = s.get("token");
  const userId = s.get("userId");
  const area = s.get("area");
  if (!token || !userId || !area) return null;
  return { token, userId, area, email: s.get("email") };
}

/** Lấy auth hoặc redirect về /login. */
export async function requireAuth(request: Request): Promise<AuthData> {
  const auth = await getAuth(request);
  if (!auth) throw redirect("/login");
  return auth;
}

export async function createUserSession(data: AuthData, redirectTo = "/") {
  const s = await sessionStorage.getSession();
  s.set("token", data.token);
  s.set("userId", data.userId);
  s.set("area", data.area);
  if (data.email) s.set("email", data.email);
  return redirect(redirectTo, { headers: { "Set-Cookie": await sessionStorage.commitSession(s) } });
}

export async function logout(request: Request) {
  const s = await sessionStorage.getSession(request.headers.get("Cookie"));
  return redirect("/login", { headers: { "Set-Cookie": await sessionStorage.destroySession(s) } });
}
