// Salas de Roblox: um `rojo serve` por local (pasta com default.project.json), cada um na sua porta.
// O app liga todos quando a pasta da sala liga e quando chega um local novo (criado por você ou por um amigo).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { exists, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { RoomSync } from "./sync/roomSync";
import { placeFolder, placeTemplates } from "./sync/templates";

export interface RojoInfo {
  version: string | null;
  plugin: boolean;
}

export interface RojoServer {
  place: string;
  state: "starting" | "on" | "error";
  port?: number;
  error?: string;
}

const FIRST_PORT = 34873; // 34872 é a padrão do Rojo; os locais seguem daí para cima
const PROJECT = /^([A-Za-z0-9_-]+)\/default\.project\.json$/;

async function readPorts(dir: string): Promise<Record<string, number>> {
  try {
    const f = await join(dir, ".gfs", "rojo-ports.json");
    return (await exists(f)) ? JSON.parse(await readTextFile(f)) : {};
  } catch {
    return {};
  }
}

async function writePorts(dir: string, ports: Record<string, number>) {
  await writeTextFile(await join(dir, ".gfs", "rojo-ports.json"), JSON.stringify(ports, null, 2)).catch(() => {});
}

/** Porta que o local já usava; senão a menor a partir da 34873 que nenhum outro local da sala usa. */
function wantedPort(ports: Record<string, number>, place: string): number {
  if (ports[place]) return ports[place];
  const used = new Set(Object.values(ports));
  let p = FIRST_PORT;
  while (used.has(p)) p++;
  return p;
}

export function useRojo(sync: RoomSync, enabled: boolean) {
  const [servers, setServers] = useState<RojoServer[]>([]);
  // null = ainda não sei (ou app antigo, sem o comando)
  const [info, setInfo] = useState<RojoInfo | null>(null);
  const [install, setInstall] = useState<{ busy: boolean; msg?: string; error?: string }>({ busy: false });
  const state = useRef(new Map<string, RojoServer>());
  const dirRef = useRef("");
  const stopped = useRef(false);
  const tries = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const ensureRef = useRef<() => void>(() => {});

  const publish = () => setServers([...state.current.values()]);
  const places = () => sync.remoteFiles().flatMap((f) => PROJECT.exec(f.path)?.[1] ?? []);

  const run = async () => {
    const dir = dirRef.current;
    if (!dir || stopped.current) return;
    const ports = await readPorts(dir);
    let retry = false;
    for (const place of places()) {
      if (state.current.get(place)?.state === "on") continue;
      state.current.set(place, { place, state: "starting" });
      publish();
      try {
        const port = await invoke<number>("rojo_start", { dir, place, port: wantedPort(ports, place) });
        if (ports[place] !== port) {
          ports[place] = port;
          await writePorts(dir, ports);
        }
        state.current.set(place, { place, state: "on", port });
      } catch (e) {
        const error = String(e);
        state.current.set(place, { place, state: "error", error });
        if (error.includes("ainda não chegou")) retry = true; // a pasta do local ainda está chegando da sala
      }
      publish();
    }
    if (retry && tries.current++ < 10) window.setTimeout(() => ensureRef.current(), 2000);
  };

  ensureRef.current = () => {
    chain.current = chain.current.then(run).catch((e) => console.warn("rojo:", e));
  };

  const refreshInfo = () => invoke<RojoInfo>("rojo_info").then(setInfo, () => setInfo(null));

  useEffect(() => {
    if (enabled) void refreshInfo();
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let t: number | undefined;
    const off = sync.onRemoteFile((path) => {
      if (!PROJECT.test(path)) return;
      window.clearTimeout(t);
      t = window.setTimeout(() => ensureRef.current(), 1500);
    });
    return () => {
      off();
      window.clearTimeout(t);
    };
  }, [sync, enabled]);

  const stop = async () => {
    stopped.current = true;
    state.current.clear();
    publish();
    if (dirRef.current) await invoke("rojo_stop", { dir: dirRef.current }).catch(() => {});
  };

  return {
    servers,
    info,
    install,
    /** Instala ou atualiza o Rojo e o plugin do Studio; depois religa os locais. */
    async installRojo() {
      setInstall({ busy: true });
      await stop(); // um rojo.exe aberto trava a atualização
      try {
        setInstall({ busy: false, msg: await invoke<string>("rojo_install") });
      } catch (e) {
        setInstall({ busy: false, error: String(e) });
      }
      await refreshInfo();
      if (dirRef.current) {
        stopped.current = false;
        tries.current = 0;
        ensureRef.current();
      }
    },
    /** Liga o Rojo de todos os locais da sala (a pasta da sala já tem que estar ligada). */
    start(dir: string) {
      dirRef.current = dir;
      stopped.current = false;
      tries.current = 0;
      ensureRef.current();
    },
    stop,
    /** Cria um local novo na sala (pasta + projeto Rojo); o Rojo dele liga assim que a pasta chegar. */
    async addPlace(name: string) {
      const folder = placeFolder(name);
      if (places().includes(folder)) throw new Error(`O local ${folder} já existe.`);
      for (const [path, text] of placeTemplates(folder)) await sync.appendToFile(path, "", text);
      tries.current = 0;
      window.setTimeout(() => ensureRef.current(), 2000);
    },
  };
}
