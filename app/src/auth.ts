import { GoogleAuthProvider, signInWithCredential, signInWithPopup, signOut, type User } from "firebase/auth";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { auth } from "./firebase";

export async function login(): Promise<void> {
  if (isTauri()) {
    // Dentro do app o Google não deixa logar na WebView: o Rust abre a página de login
    // no navegador do sistema e devolve o id_token do Google.
    const idToken = await invoke<string>("google_login");
    await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
  } else {
    await signInWithPopup(auth, new GoogleAuthProvider());
  }
}

export const logout = () => signOut(auth);

export function displayName(user: User): string {
  return user.displayName || user.email?.split("@")[0] || "Anônimo";
}

const COLORS = ["#ff7a59", "#ffc145", "#5ad1a4", "#5fa8ff", "#c38bff", "#ff6fae", "#7bdcff", "#b5e655"];

export function colorFor(uid: string): string {
  let h = 0;
  for (const ch of uid) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}
