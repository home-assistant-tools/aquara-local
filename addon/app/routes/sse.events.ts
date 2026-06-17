import type { LoaderFunctionArgs } from "@remix-run/node";
import { eventStream } from "remix-utils/sse/server";
import { getAuth } from "~/lib/session.server";
import { getMonitor } from "~/lib/monitor.server";

// SSE: /sse/events — đẩy realtime mảng LockView mỗi lần monitor poll cloud (state/pin/ai-mở).
export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await getAuth(request);
  if (!auth) return new Response("unauthorized", { status: 401 });

  return eventStream(request.signal, (send) => {
    const monitor = getMonitor(auth);
    let unsub: () => void = () => {};
    let alive = true;
    monitor
      .subscribe((views) => {
        try {
          send({ event: "locks", data: JSON.stringify(views) });
        } catch {
          /* client đã đóng */
        }
      })
      .then((u) => {
        if (alive) unsub = u;
        else u();
      });
    // heartbeat giữ kết nối qua proxy/ingress
    const hb = setInterval(() => {
      try {
        send({ event: "ping", data: String(Date.now()) });
      } catch {
        /* ignore */
      }
    }, 25_000);
    return () => {
      alive = false;
      clearInterval(hb);
      unsub();
    };
  });
}
