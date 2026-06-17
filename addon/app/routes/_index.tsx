import { type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { requireAuth } from "~/lib/session.server";
import { cloudFor, lockView, type LockView } from "~/lib/aqara.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await requireAuth(request);
  const cloud = cloudFor(auth);
  let locks: LockView[] = [];
  try {
    const found = await cloud.discoverLocks();
    locks = (await Promise.all(found.map((l) => lockView(cloud, l).catch(() => null)))).filter(Boolean) as LockView[];
  } catch {
    /* ignore — UI báo trống */
  }
  return { email: auth.email ?? "", locks };
}

function fmt(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}

function LockCard({ lock }: { lock: LockView }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const busy = fetcher.state !== "idle";
  const unlocked = lock.lockState === "unlocked";
  return (
    <div className="card">
      <div className="lockhead">
        <span className="nm">{lock.name}</span>
        <span className="live">
          <span className={"dot " + (lock.online ? "on" : "off")} />
          {lock.online ? "online" : "offline"}
        </span>
      </div>
      <div className="badges">
        <span className="badge">
          Trạng thái <b className={"state " + lock.lockState}>{unlocked ? "Đang mở" : lock.lockState === "locked" ? "Đã khóa" : lock.lockState}</b>
        </span>
        {lock.battery != null && (
          <span className="badge">
            Pin <b>{lock.battery}%</b>
          </span>
        )}
        <span className="badge muted">{lock.model}</span>
      </div>
      <div className="row">
        <fetcher.Form method="post" action="/api/lock" style={{ flex: 1 }}>
          <input type="hidden" name="did" value={lock.did} />
          <input type="hidden" name="op" value="unlock" />
          <button className="pri" type="submit" disabled={busy} style={{ width: "100%" }}>
            {busy && fetcher.formData?.get("op") === "unlock" ? "Đang mở…" : "🔓 Mở khóa"}
          </button>
        </fetcher.Form>
        <fetcher.Form method="post" action="/api/lock">
          <input type="hidden" name="did" value={lock.did} />
          <input type="hidden" name="op" value="lock" />
          <button type="submit" disabled={busy}>🔒 Khóa</button>
        </fetcher.Form>
      </div>
      {fetcher.data?.error && <div className="err" style={{ marginTop: 10 }}>{fetcher.data.error}</div>}
      {lock.events.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Ai mở cửa gần đây</div>
          {lock.events.map((e, i) => (
            <div className="ev" key={i}>
              <span>
                <span className="who">{e.action === "unlock" ? "Mở" : e.action === "lock" ? "Khóa" : "Sự kiện"}</span>{" "}
                <span className="how">{e.method}{e.user ? ` · ${e.user}` : ""}</span>
              </span>
              <span className="t">{fmt(e.ts)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const initial = useLoaderData<typeof loader>();
  const [locks, setLocks] = useState<LockView[]>(initial.locks);
  const [live, setLive] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/sse/events");
    esRef.current = es;
    es.addEventListener("locks", (ev) => {
      try {
        setLocks(JSON.parse((ev as MessageEvent).data));
        setLive(true);
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => setLive(false);
    return () => es.close();
  }, []);

  return (
    <div className="wrap">
      <div className="top">
        <div className="brand">
          <span className="dot on" />
          <h1>Aquara Matter</h1>
        </div>
        <span className="live">
          {live && <span className="spin" />} {live ? "realtime" : "đang nối…"}
          {" · "}
          <Form method="post" action="/logout" style={{ display: "inline" }}>
            <button type="submit" style={{ padding: "4px 10px", fontSize: 12 }}>Đăng xuất</button>
          </Form>
        </span>
      </div>

      {locks.length === 0 ? (
        <div className="card muted">
          Không tìm thấy khóa nào trong tài khoản (hoặc sai vùng máy chủ). Kiểm tra lại đăng nhập/region.
        </div>
      ) : (
        locks.map((l) => <LockCard key={l.did} lock={l} />)
      )}

      <p className="muted" style={{ fontSize: 12 }}>
        {initial.email} · Trạng thái cập nhật realtime qua SSE (poll cloud Aqara).
      </p>
    </div>
  );
}
