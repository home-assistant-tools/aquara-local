// Theme sáng/tối + nền gradient dùng chung mọi màn.
import React, { createContext, useContext, useEffect, useState } from "react";
import { useColorScheme, ViewStyle } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";

export interface Palette {
  dark: boolean;
  grad: [string, string, string];
  card: string; text: string; sub: string; faint: string; border: string;
  accent: string; chip: string; chipText: string; danger: string; ok: string;
  inputBg: string; overlay: string;
}
const LIGHT: Palette = {
  dark: false, grad: ["#e8f0ff", "#eef1f8", "#f5f6f8"],
  card: "#ffffff", text: "#16181d", sub: "#7d828c", faint: "#b7bcc6", border: "#eef0f3",
  accent: "#3b5bff", chip: "#eef1f8", chipText: "#444", danger: "#e0563b", ok: "#1a8f4c",
  inputBg: "#fafbfc", overlay: "#00000088",
};
const DARK: Palette = {
  dark: true, grad: ["#141a33", "#0f1322", "#0a0c14"],
  card: "#1a1d2a", text: "#eceef5", sub: "#9298a8", faint: "#5a6072", border: "#2a2e3d",
  accent: "#7d97ff", chip: "#262b3a", chipText: "#cfd3df", danger: "#ff7a5e", ok: "#3ecf78",
  inputBg: "#222636", overlay: "#000000aa",
};

const Ctx = createContext<{ t: Palette; dark: boolean; toggle: () => void }>({ t: LIGHT, dark: false, toggle: () => {} });
export const useTheme = () => useContext(Ctx);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const sys = useColorScheme();
  const [pref, setPref] = useState<string | null>(null);
  useEffect(() => { AsyncStorage.getItem("theme.dark").then((v) => setPref(v)); }, []);
  const dark = pref == null ? sys === "dark" : pref === "1";
  const toggle = () => { const nv = !dark; setPref(nv ? "1" : "0"); AsyncStorage.setItem("theme.dark", nv ? "1" : "0"); };
  return <Ctx.Provider value={{ t: dark ? DARK : LIGHT, dark, toggle }}>{children}</Ctx.Provider>;
}

/** Nền gradient cho 1 màn hình. */
export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { t } = useTheme();
  return <LinearGradient colors={t.grad} style={[{ flex: 1 }, style]}>{children}</LinearGradient>;
}
