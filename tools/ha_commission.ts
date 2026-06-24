#!/usr/bin/env tsx
// Commission đèn-bridge vào Home Assistant qua python-matter-server WebSocket API.
// ENV: MS_URL (mặc định ws://192.168.2.4:5580/ws), CODE (manual pairing code).
const MS_URL = process.env.MS_URL ?? "ws://192.168.2.4:5580/ws";
const CODE = (process.env.CODE ?? "").replace(/-/g, "");
if (!CODE) { console.error("thiếu CODE"); process.exit(1); }

const ws = new WebSocket(MS_URL);
let sentCmd = false;
const done = (ok: boolean) => { try { ws.close(); } catch {} process.exit(ok ? 0 : 1); };
const timer = setTimeout(() => { console.error("TIMEOUT 120s"); done(false); }, 120_000);

ws.onopen = () => console.log("ws open", MS_URL);
ws.onerror = (e: any) => { console.error("ws error", e?.message ?? e); };
ws.onmessage = (ev: any) => {
  let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
  // Bản tin đầu = ServerInfo (có sdk_version/fabric_id) → gửi lệnh commission.
  if (!sentCmd && (msg.fabric_id !== undefined || msg.sdk_version !== undefined || msg.schema_version !== undefined)) {
    sentCmd = true;
    console.log(`matter-server: schema=${msg.schema_version} sdk=${msg.sdk_version} fabric=${msg.fabric_id} compressed=${msg.compressed_fabric_id}`);
    const cmd = { message_id: "ha-commission-1", command: "commission_with_code", args: { code: CODE, network_only: true } };
    console.log("→ commission_with_code", CODE);
    ws.send(JSON.stringify(cmd));
    return;
  }
  if (msg.message_id === "ha-commission-1") {
    clearTimeout(timer);
    if (msg.error_code !== undefined || msg.details) {
      console.error("✗ commission FAIL:", JSON.stringify(msg).slice(0, 300));
      done(false);
    } else {
      const r = msg.result ?? {};
      console.log(`✓ commission OK: node_id=${r.node_id ?? "?"} available=${r.available} name=${r.attributes?.["0/40/3"] ?? ""}`);
      done(true);
    }
  }
};
