import React, { useMemo, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, ActivityIndicator } from "react-native";
import { useTheme, Palette } from "../theme";
import { saveAuth, Auth } from "../state/auth";
import { loginWithPassword } from "../cloud/login";

export default function LoginScreen({ onDone }: { onDone: (a: Auth) => void }) {
  const { t, dark, toggle } = useTheme();
  const s = useMemo(() => makeStyles(t), [t]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);

  async function doPasswordLogin() {
    setBusy(true);
    try {
      const a = await loginWithPassword(email.trim(), password, "SEA");
      await saveAuth(a); onDone(a);
    } catch (e: any) {
      Alert.alert("Đăng nhập thất bại", String(e?.message ?? e));
    } finally { setBusy(false); }
  }

  return (
    <ScrollView contentContainerStyle={s.c} keyboardShouldPersistTaps="handled">
      <View style={s.topRow}>
        <Text style={s.title}>D100 Unlock</Text>
        <TouchableOpacity onPress={toggle} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Text style={{ fontSize: 24 }}>{dark ? "☀️" : "🌙"}</Text>
        </TouchableOpacity>
      </View>

      <Text style={s.label}>Email</Text>
      <TextInput style={s.input} placeholderTextColor={t.faint} autoCapitalize="none" keyboardType="email-address"
        value={email} onChangeText={setEmail} placeholder="email@gmail.com" />

      <Text style={s.label}>Mật khẩu</Text>
      <View style={s.pwdWrap}>
        <TextInput style={s.pwdInput} placeholderTextColor={t.faint} secureTextEntry={!showPwd}
          value={password} onChangeText={setPassword} placeholder="••••••••" />
        <TouchableOpacity style={s.eyeBtn} onPress={() => setShowPwd((v) => !v)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={s.eye}>{showPwd ? "🙈" : "👁️"}</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={[s.btn, busy && { opacity: 0.6 }]} disabled={busy} onPress={doPasswordLogin}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.btnT}>Đăng nhập</Text>}
      </TouchableOpacity>

      <Text style={s.note}>Đăng nhập bằng email/mật khẩu Aqara (RSA + sign thuần JS, không cần app gốc).</Text>
    </ScrollView>
  );
}
const makeStyles = (t: Palette) => StyleSheet.create({
  c: { padding: 24, paddingTop: 70, flexGrow: 1 },
  topRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 28 },
  title: { fontSize: 30, fontWeight: "800", color: t.text },
  label: { fontSize: 13, color: t.sub, marginTop: 14, marginBottom: 6, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 13, fontSize: 16, backgroundColor: t.inputBg, color: t.text },
  pwdWrap: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: t.border, borderRadius: 10, backgroundColor: t.inputBg },
  pwdInput: { flex: 1, padding: 13, fontSize: 16, color: t.text },
  eyeBtn: { paddingHorizontal: 14 },
  eye: { fontSize: 20 },
  btn: { backgroundColor: t.accent, borderRadius: 12, padding: 16, alignItems: "center", marginTop: 26 },
  btnT: { color: "#fff", fontSize: 16, fontWeight: "800" },
  note: { color: t.faint, fontSize: 12, marginTop: 24, lineHeight: 18 },
});
