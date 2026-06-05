import AsyncStorage from "@react-native-async-storage/async-storage";

export interface Auth {
  area: string;       // "SEA" cho VN
  token: string;
  userId: string;
  phoneid?: string;
  clientid?: string;
  fallbackDid?: string; // DID khoá biết trước (phòng khi endpoint list đổi)
}

const KEY = "d100.auth";
export async function saveAuth(a: Auth) { await AsyncStorage.setItem(KEY, JSON.stringify(a)); }
export async function loadAuth(): Promise<Auth | null> {
  const s = await AsyncStorage.getItem(KEY);
  return s ? JSON.parse(s) : null;
}
export async function clearAuth() { await AsyncStorage.removeItem(KEY); }
