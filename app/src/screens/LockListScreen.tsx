import React, { useEffect, useState, useCallback, useMemo } from "react";
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, RefreshControl } from "react-native";
import { useTheme, Palette } from "../theme";
import { Auth, clearAuth, saveAuth } from "../state/auth";
import { AqaraCloud, DeviceItem } from "../cloud/AqaraCloud";
import LockDetailScreen from "./LockDetailScreen";
import { listCachedSessionDids } from "../ble/sessionCache";

export default function LockListScreen({ auth, onLogout }: { auth: Auth; onLogout: () => void }) {
  const { t, dark, toggle } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const cloud = useMemo(() => new AqaraCloud(auth), [auth]);
  const [fallbackDid, setFallbackDid] = useState(auth.fallbackDid);
  const [locks, setLocks] = useState<DeviceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<DeviceItem | null>(null);

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
    catch (e: any) { Alert.alert("Lỗi liệt kê khoá", String(e?.message ?? e)); }
    finally { setLoading(false); }
  }, [auth, cloud, fallbackDid]);
  useEffect(() => { load(); }, [load]);

  if (detail) return <LockDetailScreen auth={auth} lock={detail} onBack={() => setDetail(null)} />;

  return (
    <View style={s.c}>
      <View style={s.head}>
        <Text style={s.title}>Khoá của tôi</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <TouchableOpacity onPress={toggle} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}><Text style={{ fontSize: 22 }}>{dark ? "☀️" : "🌙"}</Text></TouchableOpacity>
          <TouchableOpacity onPress={async () => { await clearAuth(); onLogout(); }}><Text style={s.logout}>Đăng xuất</Text></TouchableOpacity>
        </View>
      </View>
      {loading ? <ActivityIndicator style={{ marginTop: 40 }} /> : (
        <FlatList
          data={locks}
          keyExtractor={(d) => d.did}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
          ListEmptyComponent={<Text style={s.empty}>Không thấy khoá. Thử kéo làm mới hoặc nhập DID ở màn đăng nhập.</Text>}
          renderItem={({ item }) => (
            <TouchableOpacity style={s.card} onPress={() => setDetail(item)}>
              <View style={{ flex: 1 }}>
                <Text style={s.name}>{item.name}</Text>
                <Text style={s.did}>{item.did}</Text>
                <Text style={s.detailHint}>Xem chi tiết & quản lý ›</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}
const makeStyles = (t: Palette) => StyleSheet.create({
  c: { flex: 1, paddingTop: 60, paddingHorizontal: 16 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  title: { fontSize: 26, fontWeight: "800", color: t.text },
  logout: { color: t.danger },
  card: { flexDirection: "row", alignItems: "center", backgroundColor: t.card, borderRadius: 14, padding: 16, marginBottom: 12 },
  name: { fontSize: 17, fontWeight: "700", color: t.text },
  did: { color: t.sub, fontSize: 12, marginTop: 2 },
  detailHint: { color: t.accent, fontSize: 12, marginTop: 6 },
  empty: { textAlign: "center", color: t.sub, marginTop: 40 },
});
