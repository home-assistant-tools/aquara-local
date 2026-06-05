import "react-native-get-random-values"; // polyfill crypto.getRandomValues (cho randomNonce)
import { Buffer } from "buffer";
(global as any).Buffer = (global as any).Buffer ?? Buffer;
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
