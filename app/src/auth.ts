import { GoogleAuthProvider, signInWithCredential, signInWithEmailLink, signInWithPopup, signOut, type User } from "firebase/auth";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { auth } from "./firebase";

const EMAIL_LINK = "emaillink:";

export async function login(): Promise<void> {
  if (isTauri()) {
    // Dentro do app o Google não deixa logar na WebView: o Rust abre a página de login
    // no navegador do sistema e devolve o id_token do Google, ou (login por e-mail,
    // ex.: Hotmail) "emaillink:" + {email, link} com o link que chegou no e-mail.
    const token = await invoke<string>("google_login");
    if (token.startsWith(EMAIL_LINK)) {
      const { email, link } = JSON.parse(token.slice(EMAIL_LINK.length)) as { email: string; link: string };
      await signInWithEmailLink(auth, email, link);
    } else {
      await signInWithCredential(auth, GoogleAuthProvider.credential(token));
    }
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
