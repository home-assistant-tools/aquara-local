import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "@remix-run/react";
import type { LinksFunction } from "@remix-run/node";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
];

const css = `
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--bd:#2a2f3a;--fg:#e7e9ee;--mut:#9aa3b2;--ac:#4f8cff;--ok:#36c275;--warn:#f0a020;--err:#ff5d5d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,Segoe UI,Roboto,Inter,system-ui,sans-serif}
a{color:var(--ac);text-decoration:none}
.wrap{max-width:760px;margin:0 auto;padding:20px 16px 60px}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.top h1{font-size:18px;margin:0;font-weight:700}
.brand{display:flex;align-items:center;gap:9px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--mut)}
.dot.on{background:var(--ok)} .dot.off{background:var(--err)}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:14px;padding:16px;margin-bottom:14px}
.lockhead{display:flex;align-items:center;justify-content:space-between;gap:10px}
.lockhead .nm{font-weight:600;font-size:16px}
.badges{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0 4px}
.badge{font-size:12px;color:var(--mut);background:var(--panel2);border:1px solid var(--bd);border-radius:999px;padding:4px 10px}
.badge b{color:var(--fg);font-weight:600}
.state{font-weight:700}.state.locked{color:var(--ac)}.state.unlocked{color:var(--warn)}
.row{display:flex;gap:10px;margin-top:12px}
button,.btn{font:inherit;font-weight:600;border-radius:10px;border:1px solid var(--bd);background:var(--panel2);color:var(--fg);padding:11px 16px;cursor:pointer;transition:.12s}
button:hover{border-color:var(--ac)}
button.pri{background:var(--ac);border-color:var(--ac);color:#fff}
button.pri:hover{filter:brightness(1.08)}
button:disabled{opacity:.5;cursor:not-allowed}
.ev{display:flex;justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid var(--bd);font-size:14px}
.ev:first-child{border-top:0}
.ev .who{font-weight:600}.ev .how{color:var(--mut)}.ev .t{color:var(--mut);font-size:12px;white-space:nowrap}
.muted{color:var(--mut)}
.field{display:block;margin-bottom:12px}
.field span{display:block;font-size:13px;color:var(--mut);margin-bottom:6px}
.field input,.field select{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--bd);background:var(--panel2);color:var(--fg);font:inherit}
.err{background:#3a1d1d;border:1px solid #6b2b2b;color:#ffb3b3;border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:14px}
.center{min-height:80vh;display:flex;align-items:center;justify-content:center}
.live{font-size:12px;display:flex;align-items:center;gap:6px;color:var(--mut)}
.spin{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(54,194,117,.6);animation:p 1.6s infinite}
@keyframes p{0%{box-shadow:0 0 0 0 rgba(54,194,117,.5)}70%{box-shadow:0 0 0 7px rgba(54,194,117,0)}100%{box-shadow:0 0 0 0 rgba(54,194,117,0)}}
`;

export default function App() {
  return (
    <html lang="vi">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="dark" />
        <title>Aquara Matter</title>
        <Meta />
        <Links />
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
