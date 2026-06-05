import React, { useEffect, useState } from "react";
import { ActivityIndicator, PermissionsAndroid, Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import LoginScreen from "./src/screens/LoginScreen";
import LockListScreen from "./src/screens/LockListScreen";
import { Auth, loadAuth } from "./src/state/auth";
import { ThemeProvider, Screen, useTheme } from "./src/theme";

async function askBlePerms() {
  if (Platform.OS !== "android") return;
  const want = [
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  ].filter(Boolean) as any[];
  try { await PermissionsAndroid.requestMultiple(want); } catch { /**/ }
}

function Root() {
  const { dark } = useTheme();
  const [auth, setAuth] = useState<Auth | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    (async () => { await askBlePerms(); setAuth(await loadAuth()); setReady(true); })();
  }, []);
  return (
    <Screen>
      <StatusBar style={dark ? "light" : "dark"} />
      {!ready ? <ActivityIndicator style={{ flex: 1 }} /> :
        auth ? <LockListScreen auth={auth} onLogout={() => setAuth(null)} /> : <LoginScreen onDone={setAuth} />}
    </Screen>
  );
}

export default function App() {
  return <ThemeProvider><Root /></ThemeProvider>;
}
