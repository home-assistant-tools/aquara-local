import React, { useEffect, useState, useCallback, useMemo } from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, RefreshControl } from "react-native";
import { useTheme, Palette } from "../theme";
import { Auth, clearAuth, saveAuth } from "../state/auth";
import { AqaraCloud, DeviceItem } from "../cloud/AqaraCloud";
import LockDetailScreen from "./LockDetailScreen";
import { listCachedSessionDids, sessionCount, clearAllSessions, MAX_SESSIONS } from "../ble/sessionCache";

export default function LockListScreen({ auth, onLogout }: { auth: Auth; onLogout: () => void }) {
  const { t, dark, toggle } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const cloud = useMemo(() => new AqaraCloud(auth), [auth]);
  const [fallbackDid, setFallbackDid] = useState(auth.fallbackDid);
  const [locks, setLocks] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<DeviceItem | null>(null);
  const [cacheCount, setCacheCount] = useState(0);

  const refreshCacheCount = useCallback(() => { sessionCount().then(setCacheCount).catch(() => {}); }, []);
  // làm mới số phiên cache khi quay lại danh sách (detail vừa đóng) / sau khi load
  useEffect(() => { refreshCacheCount(); }, [detail, loading, refreshCacheCount]);

  const clearCache = useCallback(() => {
    if (!cacheCount) { Alert.alert("Session cache", "No sessions saved yet."); return; }
    Alert.alert("Clear session cache?",
      `Delete all ${cacheCount} saved BLE sessions? The next unlock will handshake via cloud again.`,
      [{ text: "Cancel", style: "cancel" },
       { text: "Clear", style: "destructive", onPress: async () => { await clearAllSessions(); refreshCacheCount(); } }]);
  }, [cacheCount, refreshCacheCount]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let did = fallbackDid;
      if (!did) {
        did = (await listCachedSessionDids())[0];
        if (did) setFallbackDid(did);
      }
      const nextLocks = await cloud.listLocks(did);
      setLocks(nextLocks);
      const nextDid = nextLocks[0]?.did ?? did;
      if (nextDid && nextDid !== fallbackDid) {
        setFallbackDid(nextDid);
        await saveAuth({ ...auth, fallbackDid: nextDid });
      }
    }
    catch (e: any) { Alert.alert("Failed to list locks", String(e?.message ?? e)); }
    finally { setLoading(false); }
  }, [auth, cloud, fallbackDid]);
  useEffect(() => { load(); }, [load]);

  if (detail) return <LockDetailScreen auth={auth} lock={detail} onBack={() => setDetail(null)} />;

  return (
    <View style={s.c}>
      <View style={s.head}>
        <Text style={s.title}>My locks</Text>
        <TouchableOpacity onPress={toggle} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Text style={[s.themeIcon, { color: t.text }]}>{dark ? "☀︎" : "☾"}</Text></TouchableOpacity>
      </View>
      <View style={{ flex: 1 }}>
        {loading ? <ActivityIndicator style={{ marginTop: 40 }} /> : (
          <FlatList
            data={locks}
            keyExtractor={(d) => d.did}
            refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
            ListEmptyComponent={<Text style={s.empty}>No locks found. Pull to refresh or enter a DID on the sign-in screen.</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity style={s.card} onPress={() => setDetail(item)}>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{item.name}</Text>
                  <Text style={s.did}>{item.did}</Text>
                  <Text style={s.detailHint}>View details & manage ›</Text>
                </View>
              </TouchableOpacity>
            )}
          />
        )}
      </View>

      {/* Fixed bottom bar: cache info + clear cache, then a small sign-out button */}
      <View style={s.bottomBar}>
        <Text style={s.cacheInfo}>Saved BLE sessions: {cacheCount}/{MAX_SESSIONS}</Text>
        <TouchableOpacity style={s.cacheBtn} onPress={clearCache} disabled={!cacheCount}>
          <Text style={[s.cacheBtnT, !cacheCount && s.cacheBtnTOff]}>Clear session cache</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.logoutBtn} onPress={async () => { await clearAuth(); onLogout(); }} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={s.logoutIcon}>⏻</Text>
          <Text style={s.logoutText}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
const makeStyles = (t: Palette) => StyleSheet.create({
  c: { flex: 1, paddingTop: 60, paddingHorizontal: 16 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  title: { fontSize: 26, fontWeight: "800", color: t.text },
  themeIcon: { fontSize: 22 },
  card: { flexDirection: "row", alignItems: "center", backgroundColor: t.card, borderRadius: 14, padding: 16, marginBottom: 12 },
  name: { fontSize: 17, fontWeight: "700", color: t.text },
  did: { color: t.sub, fontSize: 12, marginTop: 2 },
  detailHint: { color: t.accent, fontSize: 12, marginTop: 6 },
  empty: { textAlign: "center", color: t.sub, marginTop: 40 },
  bottomBar: { alignItems: "center", gap: 8, paddingTop: 12, paddingBottom: 24, borderTopWidth: 1, borderTopColor: t.border },
  cacheInfo: { color: t.sub, fontSize: 12 },
  cacheBtn: { borderWidth: 1.5, borderColor: t.danger, borderRadius: 18, paddingHorizontal: 18, paddingVertical: 9 },
  cacheBtnT: { color: t.danger, fontSize: 13, fontWeight: "700" },
  cacheBtnTOff: { opacity: 0.4 },
  logoutBtn: { flexDirection: "row", alignItems: "center", alignSelf: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 4, marginTop: 2 },
  logoutIcon: { color: t.faint, fontSize: 12 },
  logoutText: { color: t.faint, fontSize: 12, fontWeight: "600" },
});
