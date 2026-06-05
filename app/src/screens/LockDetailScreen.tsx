import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, RefreshControl,
  Modal, TextInput, BackHandler, Switch,
} from "react-native";
import DateTimePicker from "@react-native-community/datetimepicker";
import { useTheme, Palette } from "../theme";
import { Auth } from "../state/auth";
import { AqaraCloud, DeviceItem, Credential, UserGroup, LockResource, LockLogEntry } from "../cloud/AqaraCloud";
import {
  credTypeIcon, credTypeLabel,
  resourceMap, lockStateLabel, fmtTime,
  disabledValidRange, enabledValidRange,
  permanentValidRangeForUserId, typeValueFor, buildUidMap, decodeUnlockLog,
  buildUserValidRange, userValidityText, credUserId, readUserValidity,
} from "../cloud/lockmeta";
import { BlePlxClient } from "../ble/BlePlxClient";
import { LockController, unlockResultMessage, UnlockResult } from "../ble/LockController";

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: any = null;
  return Promise.race([
    p,
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

export default function LockDetailScreen({
  auth, lock, onBack,
}: { auth: Auth; lock: DeviceItem; onBack: () => void }) {
  const { t, dark, toggle } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const cloud = useMemo(() => new AqaraCloud(auth), [auth]);
  const ctrlRef = useRef<LockController | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState("");
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const [res, setRes] = useState<Record<string, string>>({});
  const [creds, setCreds] = useState<Credential[]>([]);
  const [groups, setGroups] = useState<UserGroup[]>([]);
  const [logs, setLogs] = useState<LockLogEntry[]>([]);
  const [unlocking, setUnlocking] = useState(false);
  const [holding, setHolding] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [credSheet, setCredSheet] = useState<Credential | null>(null);
  const [groupSheet, setGroupSheet] = useState<{ groupId: string; groupName: string; items: Credential[]; typeGroup: string } | null>(null);
  const [renameTarget, setRenameTarget] = useState<Credential | null>(null);
  const [renameText, setRenameText] = useState("");
  // create password: with groupId → add to existing user; null fields → create a new user
  const [pwdModal, setPwdModal] = useState<{ groupId?: string; groupName?: string; typeGroup?: string } | null>(null);
  const [pwdDigits, setPwdDigits] = useState("");
  const [pwdName, setPwdName] = useState("");
  const [userModal, setUserModal] = useState(false);
  const [userName, setUserName] = useState("");
  // set validity per user
  const [validityModal, setValidityModal] = useState<{ groupId: string; groupName: string; items: Credential[] } | null>(null);
  const [vDeadline, setVDeadline] = useState<"forever" | "past" | "1" | "7" | "30" | "custom">("forever");
  const [vCustomDays, setVCustomDays] = useState("3");
  const [vAllDay, setVAllDay] = useState(true);
  const [vStartMin, setVStartMin] = useState(0);        // minute of day 0..1439
  const [vEndMin, setVEndMin] = useState(23 * 60 + 59);
  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showEndPicker, setShowEndPicker] = useState(false);
  const [renameUserTarget, setRenameUserTarget] = useState<{ groupId: string; groupName: string; typeGroup: string } | null>(null);
  const [renameUserText, setRenameUserText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const settle = async <T,>(p: Promise<T>, def: T): Promise<T> => withTimeout(p, 4500, def).catch(() => def);
    const [r, c, g, h] = await Promise.all([
      settle(cloud.lockResources(lock.did), [] as LockResource[]),
      settle(cloud.lockCredentials(lock.did), [] as Credential[]),
      settle(cloud.lockGroups(lock.did), [] as UserGroup[]),
      settle(cloud.lockHistory(lock.did, { size: 40 }), { count: 0, resultList: [] as LockLogEntry[] }),
    ]);
    setRes(resourceMap(r)); setCreds(c); setGroups(g); setLogs(h.resultList ?? []);
    setLoading(false);
  }, [cloud, lock.did]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let alive = true;
    const ble = new BlePlxClient();
    const ctrl = new LockController(cloud, ble);
    ctrlRef.current = ctrl;
    setSessionLoading(true);
    setSessionReady(false);
    setSessionError("");
    setStatus("Cloud + BLE: preparing session…");
    // forceFresh=false → reuse a cached session if the lock returns the same public key (no cloud call).
    ctrl.connectSession(lock.did, (m) => { if (alive) setStatus(m); }, false)
      .then(() => {
        if (!alive) return;
        setSessionReady(true);
        setStatus("BLE session ready");
      })
      .catch((e: any) => {
        if (!alive) return;
        setSessionError(String(e?.message ?? e));
        setStatus("");
      })
      .finally(() => { if (alive) setSessionLoading(false); });
    return () => {
      alive = false;
      ctrlRef.current = null;
      ctrl.disconnect().finally(() => ble.destroy());
    };
  }, [cloud, lock.did, sessionAttempt]);

  function controller(): LockController {
    const ctrl = ctrlRef.current;
    if (!ctrl || !sessionReady) throw new Error("BLE session not ready");
    return ctrl;
  }

  // Hardware back: close any open modal/sheet first, otherwise go back to the lock list.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (renameTarget) { setRenameTarget(null); return true; }
      if (renameUserTarget) { setRenameUserTarget(null); return true; }
      if (validityModal) { setValidityModal(null); return true; }
      if (pwdModal) { setPwdModal(null); return true; }
      if (userModal) { setUserModal(false); return true; }
      if (credSheet) { setCredSheet(null); return true; }
      if (groupSheet) { setGroupSheet(null); return true; }
      onBack(); return true;
    });
    return () => sub.remove();
  }, [renameTarget, renameUserTarget, validityModal, pwdModal, userModal, credSheet, groupSheet, onBack]);

  // UNLOCK — prefer BLE (if session ready), fall back to CLOUD when BLE isn't connected / fails.
  async function unlock() {
    const ctrl = ctrlRef.current;
    if (!ctrl) { Alert.alert("Unlock", "Controller not initialized."); return; }
    setUnlocking(true); setStatus("");
    try {
      let result: UnlockResult;
      if (sessionReady) {
        try {
          result = await ctrl.unlock(lock.did, (m) => setStatus(m));
        } catch (bleErr: any) {
          setStatus("BLE error → unlocking via cloud…");
          result = await ctrl.cloudUnlock(lock.did, (m) => setStatus(m));
        }
      } else {
        // BLE not connected yet → unlock straight via cloud
        result = await ctrl.cloudUnlock(lock.did, (m) => setStatus(m));
      }
      if (result.status?.opened != null) {
        setRes((prev) => ({ ...prev, lock_state: result.status!.lockState ?? (result.status!.opened ? "0" : "4") }));
      }
      Alert.alert("Unlock", unlockResultMessage(result));
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("CLOUD_UNLOCK_NOT_CAPTURED")) {
        Alert.alert("Cloud unlock not ready",
          "Remote cloud unlock is still being finalized (capture pending). Move closer to unlock via Bluetooth.");
      } else {
        Alert.alert("Unlock failed", msg);
      }
    } finally { setUnlocking(false); }
  }

  async function runWrite(label: string, fn: () => Promise<any>) {
    setBusy(true);
    try { await fn(); await load(); }
    catch (e: any) { Alert.alert(label + " failed", String(e?.message ?? e)); }
    finally { setBusy(false); }
  }
  function openCredActions(c: Credential) { setCredSheet(c); }
  // Set validity. With BLE ready → firmware 03/21 (the real path) + cloud mirror. Without BLE →
  // cloud-only (applies when the hub syncs to the lock).
  async function runValidity(label: string, items: { cred: Credential; vrHex: string }[]) {
    setBusy(true); setStatus("");
    try {
      if (bleReady) {
        const r = await controller().setValidity(lock.did, items.map((i) => i.vrHex), (m) => setStatus(m));
        for (const it of items) { try { await cloud.setCredentialValidRange(lock.did, it.cred, it.vrHex); } catch { /* mirror best-effort */ } }
        await load();
        Alert.alert(label, r.ack > 0
          ? `Lock acknowledged ${r.ack}/${r.total} (firmware ack 00) ✅`
          : "Command sent but no ack from the lock — retry / check at the door.");
      } else {
        let ok = 0;
        for (const it of items) { try { await cloud.setCredentialValidRange(lock.did, it.cred, it.vrHex); ok++; } catch { /* ignore */ } }
        await load();
        Alert.alert(label, ok > 0
          ? `Updated ${ok}/${items.length} via cloud (no BLE). Applies once the hub syncs to the lock.`
          : "Cloud update failed.");
      }
    } catch (e: any) {
      Alert.alert(label + " failed", String(e?.message ?? e));
    } finally { setBusy(false); setStatus(""); }
  }
  function doDelete(c: Credential) {
    setCredSheet(null);
    Alert.alert("Delete credential?",
      `Delete "${c.typeName}"? This cannot be undone (fingerprint/password must be re-enrolled at the lock).`,
      [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => runWrite("Delete", () => cloud.deleteCredential(lock.did, c)) }]);
  }
  async function submitRename() {
    const c = renameTarget; const name = renameText.trim();
    setRenameTarget(null);
    if (!c || !name || name === c.typeName) return;
    await runWrite("Rename", () => cloud.updateCredential(lock.did, c, { typeName: name }));
  }
  // CREATE PASSWORD (firmware BLE 02/13 + cloud). Creates a new user if pwdModal has no groupId.
  async function submitCreatePassword() {
    const m = pwdModal; const digits = pwdDigits.trim(); const name = pwdName.trim() || "Password";
    if (!m) return;
    if (!/^\d{6,10}$/.test(digits)) { Alert.alert("Invalid password", "Enter 6–10 digits."); return; }
    setPwdModal(null); setBusy(true); setStatus("");
    try {
      let groupId = m.groupId; const typeGroup = m.typeGroup ?? "3";
      if (!groupId) {
        groupId = AqaraCloud.nextFreeGroupId(groups.map((g) => g.typeGroupId));
        setStatus("Cloud: creating new user…");
        await cloud.createUserGroup(lock.did, groupId, `User ${groupId}`, "3");
      }
      const r = await controller().createPassword(lock.did, parseInt(groupId, 10), digits, parseInt(typeGroup, 10), (st) => setStatus(st));
      setStatus("Cloud: saving metadata…");
      await cloud.addCredentialMeta(lock.did, {
        typeGroupId: groupId, typeName: name, typeLevel: typeGroup,
        validRange: permanentValidRangeForUserId(r.userId), typeValue: typeValueFor(2, r.userId), type: "2",
      });
      await load();
      Alert.alert("Create password", `✅ Created "${name}" (slot ${r.userId})${r.ackValidity ? " — lock acknowledged" : ""}.\nCode: ${digits}`);
    } catch (e: any) { Alert.alert("Create password failed", String(e?.message ?? e)); }
    finally { setBusy(false); setStatus(""); }
  }
  // CREATE EMPTY USER (cloud group/add).
  async function submitCreateUser() {
    const name = userName.trim(); setUserModal(false);
    if (!name) return;
    setBusy(true);
    try {
      const gid = AqaraCloud.nextFreeGroupId(groups.map((g) => g.typeGroupId));
      await cloud.createUserGroup(lock.did, gid, name, "2");
      await load();
      Alert.alert("Create user", `✅ Created user "${name}". Add a fingerprint/password later.`);
    } catch (e: any) { Alert.alert("Create user failed", String(e?.message ?? e)); }
    finally { setBusy(false); }
  }
  // Disable / enable ALL credentials of one user (group) — sequentially.
  function doGroupToggle(items: Credential[], disable: boolean) {
    setGroupSheet(null);
    const list = items.map((c) => ({ cred: c, vrHex: disable ? disabledValidRange(c) : enabledValidRange(c) }));
    runValidity(disable ? "Disable whole user" : "Enable whole user", list);
  }
  // SET VALIDITY per USER → apply the same validRange to every credential.
  async function submitUserValidity() {
    const m = validityModal; if (!m) return;
    const nowS = Math.floor(Date.now() / 1000);
    let deadline: number | null;
    if (vDeadline === "forever") deadline = null;
    else if (vDeadline === "past") deadline = nowS - 86400;
    else if (vDeadline === "custom") {
      const days = parseInt(vCustomDays, 10);
      if (!Number.isFinite(days) || days < 1) { Alert.alert("Invalid number of days", "Enter days ≥ 1."); return; }
      deadline = nowS + days * 86400;
    } else deadline = nowS + parseInt(vDeadline, 10) * 86400;
    const sMin = vAllDay ? 0 : vStartMin;
    const eMin = vAllDay ? 23 * 60 + 59 : vEndMin;
    if (!vAllDay && eMin <= sMin) { Alert.alert("Invalid time window", "End time must be after start time."); return; }
    const items = m.items.filter((c) => c.typeValue);
    setValidityModal(null);
    if (!items.length) { Alert.alert("User has no method", "Add a password/fingerprint before setting validity."); return; }
    const list = items.map((c) => ({ cred: c, vrHex: buildUserValidRange(credUserId(c), { deadline, startMin: sMin, endMin: eMin }) }));
    await runValidity("Set user validity", list);
  }
  function doDeleteUser(group: { groupId: string; groupName: string }) {
    setGroupSheet(null);
    Alert.alert("Delete user?", `Delete "${group.groupName}" with ALL its fingerprints/passwords/cards? This cannot be undone.`,
      [{ text: "Cancel", style: "cancel" }, { text: "Delete", style: "destructive", onPress: async () => {
        setBusy(true); setStatus("");
        try {
          if (bleReady) {
            await controller().deleteUserGroup(lock.did, parseInt(group.groupId, 10), (st) => setStatus(st));
            try { await cloud.deleteUserGroupCloud(lock.did, group.groupId); } catch { /* mirror */ }
          } else {
            await cloud.deleteUserGroupCloud(lock.did, group.groupId);
          }
          await load();
          Alert.alert("Delete user", "Deleted ✅");
        } catch (e: any) { Alert.alert("Delete user failed", String(e?.message ?? e)); }
        finally { setBusy(false); setStatus(""); }
      } }]);
  }
  async function submitRenameUser() {
    const tg = renameUserTarget; const name = renameUserText.trim();
    setRenameUserTarget(null);
    if (!tg || !name || name === tg.groupName) return;
    await runWrite("Rename user", () => cloud.renameUserGroup(lock.did, tg.groupId, name, tg.typeGroup));
  }
  function doEnrollPlaceholder(kind: string) {
    setGroupSheet(null);
    Alert.alert(`Add ${kind}`, `Needs an INTERACTIVE enroll flow (activate → ${kind === "fingerprint" ? "swipe finger" : "tap card"} at the lock several times). Protocol capture in progress — will enable when done.`);
  }

  const batt = res.batt_0_remain_percentage;
  // BLE connection to the lock: offline while connecting / on error, online when session ready.
  const connState: "connecting" | "online" | "error" = sessionReady ? "online" : sessionLoading ? "connecting" : "error";
  const connLabel = connState === "online" ? "Online" : connState === "connecting" ? "~" : "Offline";
  // Cloud edits are always available (signed in). BLE-only actions (add password / enroll) need a session.
  const editEnabled = true;
  const bleReady = sessionReady;
  const uidMap = buildUidMap(creds);
  // merge duplicate records (lock log src 10 + 46 with same value/ts)
  const dedupedLogs = logs.filter((e, i) => i === 0 || !(logs[i - 1].value === e.value && Math.abs(logs[i - 1].timeStamp - e.timeStamp) < 3000));

  const header = (
    <View style={s.head}>
      <TouchableOpacity onPress={onBack} style={s.backBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Text style={[s.back, { color: t.accent }]}>‹</Text>
      </TouchableOpacity>
      <Text style={[s.title, { color: t.text }]} numberOfLines={2}>{lock.name}</Text>
      <TouchableOpacity onPress={toggle} style={s.themeBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
        <Text style={[s.themeIcon, { color: t.text }]}>{dark ? "☀︎" : "☾"}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={s.c}>
      {header}

      <ScrollView refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
        {/* BLE connection banner — cloud data still shows, BLE-only edits wait for online */}
        {connState !== "online" && (
          <View style={[s.connBanner, connState === "error" && s.connBannerErr]}>
            {connState === "connecting" ? (
              <>
                <ActivityIndicator size="small" color={t.accent} />
                <Text style={s.connBannerTxt} numberOfLines={2}>{status || "Connecting to the lock… BLE-only edits enable when online"}</Text>
              </>
            ) : (
              <>
                <Text style={s.connBannerTxt} numberOfLines={2}>⚠️ Not connected to the lock — cloud actions still work. {sessionError ? `(${sessionError.slice(0, 60)})` : ""}</Text>
                <TouchableOpacity style={s.connRetry} onPress={() => setSessionAttempt((x) => x + 1)}>
                  <Text style={s.connRetryT}>Retry</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {/* Status */}
        <View style={s.statusRow}>
          <Stat st={s} label="Battery" value={batt ? `${batt}%` : "—"} warn={!!batt && Number(batt) <= 20} />
          <Stat st={s} label="Lock" value={lockStateLabel(res.lock_state)} />
          <Stat st={s} label="Connection" value={connLabel} warn={connState === "error"} ok={connState === "online"} />
        </View>

        {/* Unlock — round button, HOLD to open */}
        <View style={s.unlockWrap}>
          <TouchableOpacity
            style={[s.unlockCircle, holding && s.unlockCircleHold, unlocking && { opacity: 0.7 }]}
            activeOpacity={1} disabled={unlocking || busy}
            onPressIn={() => setHolding(true)} onPressOut={() => setHolding(false)}
            onLongPress={unlock} delayLongPress={1000}
          >
            {unlocking ? <ActivityIndicator color="#fff" size="large" /> : (
              <>
                <Text style={s.unlockLockIcon}>{holding ? "🔓" : "🔒"}</Text>
                <Text style={s.unlockHoldT}>{holding ? "Keep holding…" : "HOLD TO OPEN"}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
        {!!status && <Text style={s.statusMsg}>{status}</Text>}

        {/* Users — one card per user */}
        <View style={s.section}>
          <View style={s.sectionHeadRow}>
            <Text style={[s.sectionT, { marginBottom: 0 }]}>Users ({groups.length})</Text>
            <TouchableOpacity style={[s.createOutline, !editEnabled && s.disabledCtl]} disabled={busy || !editEnabled} onPress={() => { setUserName(""); setUserModal(true); }}>
              <Text style={s.createOutlineT}>＋ Add user</Text>
            </TouchableOpacity>
          </View>
          {loading && !groups.length ? <ActivityIndicator style={{ margin: 16 }} /> :
            groups.length === 0 ? <View style={s.sectionBody}><Empty st={s} t="No users yet." /></View> :
              groups.map((grp) => {
                const items = creds.filter((c) => c.typeGroupId === grp.typeGroupId);
                const uv = userValidityText(items);
                return (
                <View key={grp.typeGroupId} style={s.userCard}>
                  <TouchableOpacity style={s.userHead} disabled={busy}
                    onPress={() => setGroupSheet({ groupId: grp.typeGroupId, groupName: grp.typeGroupName, items, typeGroup: grp.typeGroup })}>
                    <Text style={[s.userNameBig, { flex: 1 }]} numberOfLines={1}>{grp.typeGroupName}</Text>
                    <Text style={s.userMenu}>⋯</Text>
                  </TouchableOpacity>
                  <Text style={[s.userValidity, uv.disabled && { color: t.danger }]}>{uv.text}</Text>
                  {items.length === 0 ? <Text style={s.emptyGroup}>No method yet — tap to add</Text> :
                    items.map((c, i) => (
                      <TouchableOpacity key={i} style={s.credRow} onPress={() => openCredActions(c)} disabled={busy}>
                        <Text style={[s.credIcon, uv.disabled && { opacity: 0.35 }]}>{credTypeIcon(c.type)}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={[s.credName, uv.disabled && s.credDisabled]}>{c.typeName || credTypeLabel(c.type)}</Text>
                          <Text style={s.credSub}>{credTypeLabel(c.type)}</Text>
                        </View>
                        <Text style={s.chev}>⋯</Text>
                      </TouchableOpacity>
                    ))}
                </View>
                );
              })}
          <Text style={s.hintRow}>Tap a user to manage (validity · add password/fingerprint/card · delete · rename)</Text>
        </View>

        {/* Unlock history — icon + method + who + time */}
        <Section st={s} title={`Unlock history (${dedupedLogs.length})`}>
          {loading && !logs.length ? <ActivityIndicator style={{ margin: 16 }} /> :
            dedupedLogs.length === 0 ? <Empty st={s} t="No history yet." /> :
              dedupedLogs.slice(0, 50).map((e, i) => {
                const d = decodeUnlockLog(e, uidMap);
                return (
                  <View key={i} style={s.logRow}>
                    <Text style={s.logIcon}>{d.icon}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.logMethod}>{d.method}</Text>
                      {!!d.who && <Text style={s.logWho}>{d.who}</Text>}
                    </View>
                    <Text style={s.logTime}>{fmtTime(e.timeStamp)}</Text>
                  </View>
                );
              })}
        </Section>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Bottom-sheet: credential details */}
      <Modal visible={!!credSheet} transparent animationType="slide" onRequestClose={() => setCredSheet(null)}>
        <TouchableOpacity style={s.sheetBg} activeOpacity={1} onPress={() => setCredSheet(null)}>
          <TouchableOpacity style={s.sheet} activeOpacity={1} onPress={() => {}}>
            {credSheet && (() => {
              const c = credSheet;
              return (
                <>
                  <View style={s.sheetHead}>
                    <Text style={s.sheetIcon}>{credTypeIcon(c.type)}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.sheetTitle}>{c.typeName || credTypeLabel(c.type)}</Text>
                      <Text style={s.sheetSub}>{credTypeLabel(c.type)} · {c.typeGroupName}</Text>
                    </View>
                  </View>
                  <Text style={s.sheetHint}>Validity is set per USER (tap the user name). Here you can only rename / delete this method.</Text>
                  <TouchableOpacity style={[s.sheetAct, !editEnabled && s.disabledCtl]} disabled={!editEnabled} onPress={() => { setRenameText(c.typeName ?? ""); setCredSheet(null); setRenameTarget(c); }}>
                    <Text style={s.sheetActT}>✏️  Rename</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.sheetAct, !editEnabled && s.disabledCtl]} disabled={!editEnabled} onPress={() => doDelete(c)}>
                    <Text style={[s.sheetActT, { color: "#e0563b" }]}>🗑️  Delete</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.sheetClose} onPress={() => setCredSheet(null)}>
                    <Text style={s.sheetCloseT}>Close</Text>
                  </TouchableOpacity>
                </>
              );
            })()}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Bottom-sheet: manage whole USER (group) */}
      <Modal visible={!!groupSheet} transparent animationType="slide" onRequestClose={() => setGroupSheet(null)}>
        <TouchableOpacity style={s.sheetBg} activeOpacity={1} onPress={() => setGroupSheet(null)}>
          <TouchableOpacity style={s.sheet} activeOpacity={1} onPress={() => {}}>
            {groupSheet && (() => {
              const g = groupSheet;
              const total = g.items.length;
              const uv = userValidityText(g.items);
              return (
                <>
                  <View style={s.sheetHead}>
                    <Text style={s.sheetIcon}>👤</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={s.sheetTitle}>{g.groupName}</Text>
                      <Text style={[s.sheetSub, uv.disabled && { color: "#e0563b" }]}>{total} method{total === 1 ? "" : "s"} · {uv.text}</Text>
                    </View>
                  </View>
                  {!bleReady && <Text style={s.sheetGateNote}>⏳ Adding a password / fingerprint / card needs a BLE connection (waiting for online).</Text>}
                  <TouchableOpacity style={s.sheetAct} onPress={() => {
                    const cur = readUserValidity(g.items);
                    if (cur.deadline == null) setVDeadline("forever");
                    else if (cur.deadline * 1000 < Date.now()) setVDeadline("past");
                    else { setVDeadline("custom"); setVCustomDays(String(Math.max(1, Math.round((cur.deadline * 1000 - Date.now()) / 86400000)))); }
                    setVAllDay(cur.allDay); setVStartMin(cur.startMin); setVEndMin(cur.endMin);
                    setGroupSheet(null); setValidityModal({ groupId: g.groupId, groupName: g.groupName, items: g.items });
                  }}>
                    <Text style={[s.sheetActT, { color: "#7a4ed8" }]}>⏱️  Set validity</Text>
                  </TouchableOpacity>
                  {total > 0 && (uv.disabled ? (
                    <TouchableOpacity style={s.sheetAct} onPress={() => doGroupToggle(g.items, false)}>
                      <Text style={[s.sheetActT, { color: t.ok }]}>✅  Enable user (unlock now)</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity style={s.sheetAct} onPress={() => doGroupToggle(g.items, true)}>
                      <Text style={[s.sheetActT, { color: t.danger }]}>⛔  Disable user (lock now)</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity style={[s.sheetAct, !bleReady && s.disabledCtl]} disabled={!bleReady} onPress={() => {
                    setPwdDigits(""); setPwdName(""); setGroupSheet(null);
                    setPwdModal({ groupId: g.groupId, groupName: g.groupName, typeGroup: g.typeGroup });
                  }}>
                    <Text style={[s.sheetActT, { color: "#3b5bff" }]}>🔢  Add password</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.sheetAct, !bleReady && s.disabledCtl]} disabled={!bleReady} onPress={() => doEnrollPlaceholder("fingerprint")}>
                    <Text style={s.sheetActT}>🫆  Add fingerprint</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[s.sheetAct, !bleReady && s.disabledCtl]} disabled={!bleReady} onPress={() => doEnrollPlaceholder("NFC card")}>
                    <Text style={s.sheetActT}>💳  Add NFC card</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.sheetAct} onPress={() => {
                    setRenameUserText(g.groupName); setGroupSheet(null);
                    setRenameUserTarget({ groupId: g.groupId, groupName: g.groupName, typeGroup: g.typeGroup });
                  }}>
                    <Text style={s.sheetActT}>✏️  Rename user</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.sheetAct} onPress={() => doDeleteUser({ groupId: g.groupId, groupName: g.groupName })}>
                    <Text style={[s.sheetActT, { color: "#e0563b" }]}>🗑️  Delete user</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={s.sheetClose} onPress={() => setGroupSheet(null)}>
                    <Text style={s.sheetCloseT}>Close</Text>
                  </TouchableOpacity>
                </>
              );
            })()}
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      {/* Rename modal */}
      <Modal visible={!!renameTarget} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}>
        <View style={s.modalBg}>
          <View style={s.modalBox}>
            <Text style={s.modalT}>Rename</Text>
            <TextInput placeholderTextColor={t.faint} style={s.modalInput} value={renameText} onChangeText={setRenameText} autoFocus placeholder="New name" />
            <View style={s.modalRow}>
              <TouchableOpacity onPress={() => setRenameTarget(null)}><Text style={s.modalCancel}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={submitRename}><Text style={s.modalOk}>Save</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Create PASSWORD modal */}
      <Modal visible={!!pwdModal} transparent animationType="fade" onRequestClose={() => setPwdModal(null)}>
        <View style={s.modalBg}>
          <View style={s.modalBox}>
            <Text style={s.modalT}>Create password{pwdModal?.groupName ? ` · ${pwdModal.groupName}` : " (new user)"}</Text>
            <TextInput placeholderTextColor={t.faint} style={s.modalInput} value={pwdDigits} onChangeText={(x) => setPwdDigits(x.replace(/\D/g, "").slice(0, 10))}
              keyboardType="number-pad" autoFocus placeholder="6–10 digit password" maxLength={10} />
            <TextInput placeholderTextColor={t.faint} style={[s.modalInput, { marginTop: 10 }]} value={pwdName} onChangeText={setPwdName} placeholder="Name (e.g. Guest code)" />
            <Text style={s.modalHint}>Programmed straight into the lock over BLE (must be near the lock).</Text>
            <View style={s.modalRow}>
              <TouchableOpacity onPress={() => setPwdModal(null)}><Text style={s.modalCancel}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={submitCreatePassword}><Text style={s.modalOk}>Create</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Rename USER modal */}
      <Modal visible={!!renameUserTarget} transparent animationType="fade" onRequestClose={() => setRenameUserTarget(null)}>
        <View style={s.modalBg}>
          <View style={s.modalBox}>
            <Text style={s.modalT}>Rename user</Text>
            <TextInput placeholderTextColor={t.faint} style={s.modalInput} value={renameUserText} onChangeText={setRenameUserText} autoFocus placeholder="New user name" />
            <View style={s.modalRow}>
              <TouchableOpacity onPress={() => setRenameUserTarget(null)}><Text style={s.modalCancel}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={submitRenameUser}><Text style={s.modalOk}>Save</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Create empty USER modal */}
      <Modal visible={userModal} transparent animationType="fade" onRequestClose={() => setUserModal(false)}>
        <View style={s.modalBg}>
          <View style={s.modalBox}>
            <Text style={s.modalT}>New user</Text>
            <TextInput placeholderTextColor={t.faint} style={s.modalInput} value={userName} onChangeText={setUserName} autoFocus placeholder="User name (e.g. Guest)" />
            <Text style={s.modalHint}>Creates a user group (cloud). Add a fingerprint/password for this user later.</Text>
            <View style={s.modalRow}>
              <TouchableOpacity onPress={() => setUserModal(false)}><Text style={s.modalCancel}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={submitCreateUser}><Text style={s.modalOk}>Create</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* SET VALIDITY per user modal */}
      <Modal visible={!!validityModal} transparent animationType="fade" onRequestClose={() => setValidityModal(null)}>
        <View style={s.modalBg}>
          <View style={s.modalBox}>
            <Text style={s.modalT}>Validity · {validityModal?.groupName}</Text>
            <Text style={s.modalLabel}>Valid until</Text>
            <View style={s.chipRow}>
              {([["forever", "Forever"], ["1", "1 day"], ["7", "7 days"], ["30", "30 days"], ["custom", "Days…"], ["past", "Disable now"]] as const).map(([k, lbl]) => (
                <TouchableOpacity key={k} style={[s.chip, vDeadline === k && s.chipOn]} onPress={() => setVDeadline(k)}>
                  <Text style={[s.chipT, vDeadline === k && s.chipTOn]}>{lbl}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {vDeadline === "custom" && (
              <View style={s.daysRow}>
                <TextInput placeholderTextColor={t.faint} style={s.daysInput} value={vCustomDays}
                  onChangeText={(x) => setVCustomDays(x.replace(/\D/g, "").slice(0, 4))}
                  keyboardType="number-pad" placeholder="3" maxLength={4} />
                <Text style={s.daysSuffix}>days from today</Text>
              </View>
            )}
            <View style={s.allDayRow}>
              <Text style={s.modalLabel}>Daily time window</Text>
              <View style={s.allDayToggle}>
                <Text style={s.allDayTxt}>All day</Text>
                <Switch value={vAllDay} onValueChange={setVAllDay}
                  trackColor={{ true: "#7a4ed8", false: t.border }} thumbColor="#fff" />
              </View>
            </View>
            {!vAllDay && (
              <View style={s.timeRow}>
                <TouchableOpacity style={s.timeInput} onPress={() => setShowStartPicker(true)}>
                  <Text style={s.timeInputT}>{minToLabel(vStartMin)}</Text>
                </TouchableOpacity>
                <Text style={{ marginHorizontal: 10, color: "#888" }}>–</Text>
                <TouchableOpacity style={s.timeInput} onPress={() => setShowEndPicker(true)}>
                  <Text style={s.timeInputT}>{minToLabel(vEndMin)}</Text>
                </TouchableOpacity>
              </View>
            )}
            {showStartPicker && (
              <DateTimePicker mode="time" is24Hour value={minToDate(vStartMin)} display="clock"
                onChange={(_e, d) => { setShowStartPicker(false); if (d) setVStartMin(d.getHours() * 60 + d.getMinutes()); }} />
            )}
            {showEndPicker && (
              <DateTimePicker mode="time" is24Hour value={minToDate(vEndMin)} display="clock"
                onChange={(_e, d) => { setShowEndPicker(false); if (d) setVEndMin(d.getHours() * 60 + d.getMinutes()); }} />
            )}
            <Text style={s.modalHint}>{bleReady ? "Applied to EVERY method of this user over BLE (must be near the lock)." : "No BLE — applied via cloud; takes effect when the hub syncs to the lock."}</Text>
            <View style={s.modalRow}>
              <TouchableOpacity onPress={() => setValidityModal(null)}><Text style={s.modalCancel}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity onPress={submitUserValidity}><Text style={s.modalOk}>Save</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {busy && <View style={s.busyOverlay}><ActivityIndicator color="#fff" size="large" />{!!status && <Text style={s.busyTxt}>{status}</Text>}</View>}
    </View>
  );
}

function Stat({ label, value, warn, ok, st }: { label: string; value: string; warn?: boolean; ok?: boolean; st: any }) {
  return (
    <View style={st.stat}>
      <Text style={[st.statVal, warn && { color: "#e0563b" }, ok && { color: "#2faf6b" }]}>{value}</Text>
      <Text style={st.statLbl}>{label}</Text>
    </View>
  );
}
function Section({ title, children, st }: { title: string; children: React.ReactNode; st: any }) {
  return (
    <View style={st.section}>
      <Text style={st.sectionT}>{title}</Text>
      <View style={st.sectionBody}>{children}</View>
    </View>
  );
}
function Empty({ t: txt, st }: { t: string; st: any }) { return <Text style={st.empty}>{txt}</Text>; }
function minToLabel(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function minToDate(min: number): Date {
  const d = new Date();
  d.setHours(Math.floor(min / 60), min % 60, 0, 0);
  return d;
}

const makeStyles = (t: Palette) => StyleSheet.create({
  c: { flex: 1, paddingTop: 52 },
  head: { flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 10, marginBottom: 10 },
  backBtn: { paddingHorizontal: 6, paddingTop: 2 },
  back: { color: t.accent, fontSize: 34, lineHeight: 34, fontWeight: "400" },
  themeBtn: { paddingHorizontal: 8, paddingTop: 4 },
  themeIcon: { fontSize: 22 },
  title: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "800", color: t.text, paddingTop: 4 },
  sessionBox: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingBottom: 80 },
  sessionTxt: { color: t.accent, textAlign: "center", marginTop: 16, fontSize: 13 },
  sessionTitle: { color: t.text, fontSize: 18, fontWeight: "800", textAlign: "center" },
  sessionErr: { color: t.sub, textAlign: "center", marginTop: 10, fontSize: 13 },
  retryBtn: { backgroundColor: t.accent, borderRadius: 18, paddingHorizontal: 22, paddingVertical: 10, marginTop: 18 },
  retryT: { color: "#fff", fontWeight: "800" },
  statusRow: { flexDirection: "row", marginHorizontal: 16, backgroundColor: t.card, borderRadius: 14, paddingVertical: 16 },
  stat: { flex: 1, alignItems: "center" },
  statVal: { fontSize: 18, fontWeight: "800", color: t.text },
  statLbl: { fontSize: 12, color: t.sub, marginTop: 4 },
  unlockWrap: { alignItems: "center", marginVertical: 34 },
  unlockCircle: { width: 168, height: 168, borderRadius: 84, backgroundColor: t.accent, alignItems: "center", justifyContent: "center", shadowColor: t.accent, shadowOpacity: 0.4, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  unlockCircleHold: { backgroundColor: t.ok, transform: [{ scale: 1.06 }] },
  unlockLockIcon: { fontSize: 52 },
  unlockHoldT: { color: "#fff", fontWeight: "800", fontSize: 13, marginTop: 6, letterSpacing: 1 },
  createOutline: { borderWidth: 1.5, borderColor: t.accent, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 6 },
  createOutlineT: { fontSize: 13, fontWeight: "700", color: t.accent },
  userMenu: { fontSize: 22, color: t.faint, marginLeft: 8, paddingHorizontal: 4 },
  statusMsg: { color: t.accent, textAlign: "center", marginBottom: 8, marginHorizontal: 16, fontSize: 12 },
  section: { marginTop: 18, marginHorizontal: 16 },
  sectionT: { fontSize: 13, fontWeight: "700", color: t.sub, marginBottom: 8, textTransform: "uppercase" },
  sectionHeadRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  sectionBody: { backgroundColor: t.card, borderRadius: 14, overflow: "hidden" },
  userCard: { backgroundColor: t.card, borderRadius: 16, marginBottom: 12, paddingBottom: 6, overflow: "hidden" },
  userHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12 },
  userNameBig: { fontSize: 19, fontWeight: "800", color: t.text },
  credRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 11 },
  credIcon: { fontSize: 20, marginRight: 12 },
  credName: { fontSize: 15, fontWeight: "600", color: t.text },
  credDisabled: { textDecorationLine: "line-through", color: t.faint },
  credSub: { fontSize: 12, color: t.sub, marginTop: 1 },
  chev: { color: t.faint, fontSize: 20, paddingHorizontal: 4 },
  hintRow: { fontSize: 11, color: t.faint, textAlign: "center", paddingVertical: 10 },
  modalHint: { fontSize: 12, color: t.sub, marginTop: 10 },
  modalLabel: { fontSize: 13, color: t.sub, marginTop: 14, marginBottom: 6, fontWeight: "600" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { backgroundColor: t.chip, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7 },
  chipOn: { backgroundColor: "#7a4ed8" },
  chipT: { fontSize: 13, color: t.chipText },
  chipTOn: { color: "#fff", fontWeight: "700" },
  timeRow: { flexDirection: "row", alignItems: "center", marginTop: 4 },
  timeInput: { borderWidth: 1, borderColor: t.border, backgroundColor: t.inputBg, borderRadius: 10, paddingVertical: 12, width: 110, alignItems: "center", justifyContent: "center" },
  timeInputT: { color: t.text, fontSize: 20, fontWeight: "700", letterSpacing: 1 },
  daysRow: { flexDirection: "row", alignItems: "center", marginTop: 10 },
  daysInput: { borderWidth: 1, borderColor: t.border, backgroundColor: t.inputBg, color: t.text, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 12, fontSize: 16, width: 70, textAlign: "center" },
  daysSuffix: { color: t.sub, fontSize: 13, marginLeft: 10 },
  allDayRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 22 },
  allDayToggle: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  allDayTxt: { color: t.sub, fontSize: 13, fontWeight: "600" },
  connBanner: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginBottom: 10, backgroundColor: t.chip, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 14 },
  connBannerErr: { backgroundColor: "#e0563b22" },
  connBannerTxt: { flex: 1, color: t.sub, fontSize: 12.5 },
  connRetry: { backgroundColor: t.accent, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 6 },
  connRetryT: { color: "#fff", fontWeight: "700", fontSize: 12 },
  disabledCtl: { opacity: 0.4 },
  sheetGateNote: { color: "#c98a2e", fontSize: 12.5, paddingHorizontal: 8, paddingBottom: 6 },
  userValidity: { fontSize: 12.5, color: "#9a73e6", marginTop: 8, marginHorizontal: 14, marginBottom: 2 },
  sheetBg: { flex: 1, backgroundColor: t.overlay, justifyContent: "flex-end" },
  sheet: { backgroundColor: t.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, paddingBottom: 30 },
  sheetHead: { flexDirection: "row", alignItems: "center", paddingHorizontal: 6, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.border, marginBottom: 8 },
  sheetIcon: { fontSize: 26, marginRight: 12 },
  sheetTitle: { fontSize: 18, fontWeight: "800", color: t.text },
  sheetSub: { fontSize: 13, color: t.sub, marginTop: 2 },
  sheetHint: { fontSize: 12, color: t.sub, paddingHorizontal: 8, paddingBottom: 4 },
  sheetAct: { paddingVertical: 15, paddingHorizontal: 8 },
  sheetActT: { fontSize: 16, fontWeight: "600", color: t.text },
  sheetNote: { fontSize: 12, color: t.sub, paddingHorizontal: 8, paddingTop: 4, paddingBottom: 8 },
  sheetClose: { marginTop: 8, backgroundColor: t.chip, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  sheetCloseT: { fontSize: 16, fontWeight: "700", color: t.text },
  modalBg: { flex: 1, backgroundColor: t.overlay, justifyContent: "center", paddingHorizontal: 30 },
  modalBox: { backgroundColor: t.card, borderRadius: 16, padding: 20 },
  modalT: { fontSize: 17, fontWeight: "800", marginBottom: 14, color: t.text },
  modalInput: { borderWidth: 1, borderColor: t.border, backgroundColor: t.inputBg, color: t.text, borderRadius: 10, padding: 12, fontSize: 16 },
  modalRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 18, gap: 26 },
  modalCancel: { color: t.sub, fontSize: 16, fontWeight: "600" },
  modalOk: { color: t.accent, fontSize: 16, fontWeight: "800" },
  busyOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "#000b", justifyContent: "center", alignItems: "center", paddingHorizontal: 30 },
  busyTxt: { color: "#fff", marginTop: 14, textAlign: "center", fontSize: 13 },
  emptyGroup: { fontSize: 12, color: t.faint, paddingHorizontal: 14, paddingVertical: 12 },
  logRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: t.border },
  logIcon: { fontSize: 20, marginRight: 12 },
  logMethod: { fontSize: 14, fontWeight: "600", color: t.text },
  logWho: { fontSize: 12, color: t.sub, marginTop: 1 },
  logTime: { fontSize: 13, color: t.sub },
  empty: { color: t.faint, textAlign: "center", padding: 16 },
});
