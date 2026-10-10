import { useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { login } from "../auth";
import { Brand } from "./Brand";

export function LoginScreen() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await login();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("configuration-not-found") || msg.includes("operation-not-allowed"))
        setError("Esse tipo de login ainda não está ligado no Firebase (Authentication → Método de login).");
      else if (msg.includes("invalid-action-code") || msg.includes("expired-action-code"))
        setError("Esse link de e-mail já foi usado ou expirou. Clique em Entrar e peça um link novo.");
      else if (msg.includes("popup-closed-by-user") || msg.includes("cancelled-popup-request")) setError(null);
      else setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <div className="card">
        <Brand />
        <p className="muted">
          Entre com sua conta Google ou com seu e-mail (Hotmail, Outlook…). Cada pessoa da sala (e o Claude dela, pelo <code>gfs</code>) aparece com o próprio nome.
        </p>
        <button className="primary" style={{ width: "100%", padding: 12, marginTop: 8 }} onClick={go} disabled={busy}>
          {busy ? (isTauri() ? "Termine o login no navegador…" : "Entrando…") : isTauri() ? "Entrar (Google ou e-mail)" : "Entrar com Google"}
        </button>
        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}
