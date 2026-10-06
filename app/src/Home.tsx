import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "./firebase";
import { go, useRoute } from "./App";
import { joinWithCode, saveProfile } from "./rooms";
import { LoginScreen } from "./components/LoginScreen";
import { RoomsScreen } from "./components/RoomsScreen";
import { RoomScreen } from "./components/RoomScreen";
import { Brand } from "./components/Brand";
import { PixelBackdrop } from "./components/PixelBackdrop";
import { ALLOWED_EMAILS } from "./config";
import { logout } from "./auth";

function NotAllowed({ email }: { email: string | null }) {
  return (
    <div className="center-screen">
      <div className="card">
        <Brand />
        <div className="error-box">
          A conta <b>{email ?? "sem e-mail"}</b> não tem acesso ao GameForge Sync. Peça ao dono para incluir seu e-mail.
        </div>
        <button style={{ marginTop: 14 }} onClick={() => void logout()}>
          Entrar com outra conta
        </button>
      </div>
    </div>
  );
}

export function Home() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const route = useRoute();
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  // Perfil para o dono de uma sala conseguir adicionar esta pessoa sem código.
  useEffect(() => {
    if (user && ALLOWED_EMAILS.includes(user.email ?? "")) void saveProfile(user).catch(() => {});
  }, [user]);

  // Link de convite: #/join/CODIGO
  useEffect(() => {
    if (!user || route.name !== "join") return;
    joinWithCode(user, route.code)
      .then((id) => go({ name: "room", id }))
      .catch((e: Error) => {
        setJoinError(e.message);
        go({ name: "rooms" });
      });
  }, [user, route]);

  const inRoom = !!user && ALLOWED_EMAILS.includes(user.email ?? "") && route.name === "room";
  return (
    <>
      {!inRoom && <PixelBackdrop />}
      {screen()}
    </>
  );

  function screen() {
    if (user === undefined) return <div className="center-screen muted">Carregando…</div>;
    if (!user) return <LoginScreen />;
    if (!ALLOWED_EMAILS.includes(user.email ?? "")) return <NotAllowed email={user.email} />;
    if (route.name === "room") return <RoomScreen key={route.id} user={user} roomId={route.id} />;
    if (route.name === "join") return <div className="center-screen muted">Entrando na sala…</div>;
    return <RoomsScreen user={user} initialError={joinError} />;
  }
}
