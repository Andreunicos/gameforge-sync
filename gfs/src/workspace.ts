// A pasta local que espelha a sala. Em .gfs/ ficam o estado e a "base" de cada arquivo
// (a última versão da sala de onde o texto local partiu) — é ela que permite o merge de 3 vias.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { IGNORE_DIRS, TEXT_EXT } from "./config.ts";

export interface FileState {
  version: number;
  updateTime: string;
}

export interface State {
  roomId: string;
  roomName: string;
  /** readTime do servidor no último pull/clone (para buscar só o que mudou depois). */
  lastSync: string;
  files: Record<string, FileState>;
}

export class Workspace {
  constructor(
    readonly root: string,
    public state: State,
  ) {}

  /** Sobe a partir da pasta atual até achar .gfs/state.json. */
  static find(from = process.cwd()): Workspace {
    let dir = from;
    for (;;) {
      const f = join(dir, ".gfs", "state.json");
      if (existsSync(f)) return new Workspace(dir, JSON.parse(readFileSync(f, "utf8")) as State);
      const up = dirname(dir);
      if (up === dir) throw new Error("esta pasta não é uma sala. Rode: gfs clone <id-da-sala>");
      dir = up;
    }
  }

  static create(root: string, state: State): Workspace {
    mkdirSync(join(root, ".gfs", "base"), { recursive: true });
    const ws = new Workspace(root, state);
    ws.save();
    return ws;
  }

  save() {
    writeFileSync(join(this.root, ".gfs", "state.json"), JSON.stringify(this.state, null, 2));
  }

  private abs(path: string) {
    return join(this.root, ...path.split("/"));
  }

  private basePath(path: string) {
    return join(this.root, ".gfs", "base", ...path.split("/"));
  }

  /** Texto local com quebras de linha normalizadas (CRLF do Windows vira LF). */
  readLocal(path: string): string | null {
    try {
      return readFileSync(this.abs(path), "utf8").replace(/\r\n/g, "\n");
    } catch {
      return null;
    }
  }

  writeLocal(path: string, content: string) {
    mkdirSync(dirname(this.abs(path)), { recursive: true });
    writeFileSync(this.abs(path), content);
  }

  deleteLocal(path: string) {
    rmSync(this.abs(path), { force: true });
  }

  readBase(path: string): string {
    try {
      return readFileSync(this.basePath(path), "utf8");
    } catch {
      return "";
    }
  }

  /** Registra a versão da sala que o arquivo local acompanha. */
  setBase(path: string, content: string, fs: FileState) {
    mkdirSync(dirname(this.basePath(path)), { recursive: true });
    writeFileSync(this.basePath(path), content);
    this.state.files[path] = fs;
  }

  dropBase(path: string) {
    rmSync(this.basePath(path), { force: true });
    delete this.state.files[path];
  }

  /** Todos os arquivos de código da pasta (caminhos com "/"). */
  scan(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".") && name !== ".gfs") continue;
        if (IGNORE_DIRS.has(name)) continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walk(full);
        else if (TEXT_EXT.test(name)) out.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    walk(this.root);
    return out.sort();
  }

  /** Arquivos alterados, novos e apagados em relação à base. */
  changes() {
    const local = new Set(this.scan());
    const changed: string[] = [];
    const added: string[] = [];
    for (const p of local) {
      if (!this.state.files[p]) added.push(p);
      else if (this.readLocal(p) !== this.readBase(p)) changed.push(p);
    }
    const removed = Object.keys(this.state.files).filter((p) => !local.has(p));
    return { changed, added, removed };
  }
}
