import { type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import { requireAuth } from "~/lib/session.server";
import { cloudFor, lockView, type LockView } from "~/lib/aqara.server";
import type { MatterSetupResult } from "~/lib/matterSetup.server";

function MatterCard() {
  const fx = useFetcher<{ ok?: boolean; result?: MatterSetupResult[]; error?: string }>();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    fx.submit({ force: "0" }, { method: "post", action: "/api/matter-setup" }); // tự động khi mở
  }, []);
  const busy = fx.state !== "idle";
  const res = fx.data?.result;
  const totalAutomations = res?.reduce((a, r) => a + r.automationsCreated, 0) ?? 0;
  const code = res?.find((r) => r.light?.manualPairingCode)?.light.manualPairingCode;
  return (
    <div className="card" style={{ borderColor: "#2d3a55" }}>
      <div className="lockhead">
        <span className="nm">🔗 Kết nối Matter</span>
        <span className="live">{busy ? <span className="spin" /> : null} {busy ? "đang đồng bộ…" : res ? "đã đồng bộ" : "—"}</span>
      </div>
      {!res && busy && <p className="muted" style={{ marginBottom: 0 }}>Đang tạo đèn Matter, commission vào hub và dựng automation local…</p>}
      {fx.data?.error && <div className="err" style={{ marginTop: 10 }}>{fx.data.error}</div>}
      {res && (
        <>
          <div className="badges">
            <span className="badge">Automation <b>{totalAutomations}</b></span>
            <span className="badge">Đèn <b>{res.filter((r) => r.light?.aqaraDid).length}/{res.length}</b></span>
            {res[0]?.hubName && <span className="badge muted">hub: {res[0].hubName}</span>}
          </div>
          {res.map((r) => (
            <div className="ev" key={r.lockDid} style={{ marginTop: 8 }}>
              <span>
                <span className="who">{r.lockName}</span>{" "}
                <span className="how">{r.light.status} · level {r.light.currentLevel}{r.light.aqaraDid ? ` · ${r.light.aqaraDid}` : ""}</span>
              </span>
              <span className="t">{r.automationsCreated} auto</span>
            </div>
          ))}
          {code && (
            <div style={{ marginTop: 8 }}>
              <div className="muted" style={{ fontSize: 12 }}>Mã pairing đèn bridge đầu tiên:</div>
              <code style={{ fontSize: 18, letterSpacing: 1, color: "var(--ac)" }}>{code.replace(/(\d{4})(\d{3})(\d{4})/, "$1-$2-$3")}</code>
            </div>
          )}
          {res.some((r) => r.error) && <div className="err" style={{ marginTop: 8 }}>{res.find((r) => r.error)?.error}</div>}
        </>
      )}
      <div className="row">
        <button type="button" disabled={busy} onClick={() => fx.submit({ force: "1" }, { method: "post", action: "/api/matter-setup" })}>
          {busy ? "Đang chạy…" : "↻ Đồng bộ lại toàn bộ tín hiệu"}
        </button>
      </div>
    </div>
  );
}

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
        {lock.bridge?.aqaraDid && (
          <span className="badge" title={`đèn bridge ${lock.bridge.aqaraDid} · mức ${lock.bridge.currentLevel}`}>
            Bridge <b>{lock.bridgeEvent ?? `mức ${lock.bridge.currentLevel}`}</b>
          </span>
        )}
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

      <MatterCard />

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
