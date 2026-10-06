import { useEffect, useState } from "react";
import { firebaseReady } from "./config";
import { SetupScreen } from "./components/SetupScreen";
import { UpdateBanner } from "./components/UpdateBanner";
import { Home } from "./Home";

export default function App() {
  return (
    <div className="app-shell">
      <UpdateBanner />
      <div className="app-main">{firebaseReady ? <Home /> : <SetupScreen />}</div>
    </div>
  );
}

/** Rotas por hash: #/  ·  #/room/<id>  ·  #/join/<código> */
export type Route = { name: "rooms" } | { name: "room"; id: string } | { name: "join"; code: string };

function parse(hash: string): Route {
  const [, kind, arg] = hash.replace(/^#/, "").split("/");
  if (kind === "room" && arg) return { name: "room", id: arg };
  if (kind === "join" && arg) return { name: "join", code: decodeURIComponent(arg) };
  return { name: "rooms" };
}

export function go(route: Route) {
  location.hash = route.name === "rooms" ? "#/" : route.name === "room" ? `#/room/${route.id}` : `#/join/${route.code}`;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
