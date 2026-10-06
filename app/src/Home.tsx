import { useEffect, useState } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "./firebase";
import { go, useRoute } from "./App";
import { joinWithCode } from "./rooms";
import { LoginScreen } from "./components/LoginScreen";
import { RoomsScreen } from "./components/RoomsScreen";
import { RoomScreen } from "./components/RoomScreen";

export function Home() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const route = useRoute();
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

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

  if (user === undefined) return <div className="center-screen muted">Carregando…</div>;
  if (!user) return <LoginScreen />;
  if (route.name === "room") return <RoomScreen key={route.id} user={user} roomId={route.id} />;
  if (route.name === "join") return <div className="center-screen muted">Entrando na sala…</div>;
  return <RoomsScreen user={user} initialError={joinError} />;
}
