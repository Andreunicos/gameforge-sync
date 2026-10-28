// A pasta local que espelha a sala. Em .gfs/ ficam o estado e a "base" de cada arquivo
// (a última versão da sala de onde o texto local partiu) — é ela que permite o merge de 3 vias.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { IGNORE_PATH, UE_PROJECT_SKIP, UNREAL_IGNORE_PATH, isCodePath } from "./fileKinds.ts";

/** Tem .uproject na pasta ou em subpasta até 2 níveis (sem entrar em pasta com ponto, gerada ou link). */
function hasUproject(dir: string, depth = 0): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) =>
      e.isFile()
        ? /\.uproject$/i.test(e.name)
        : e.isDirectory() && depth < 2 && !e.name.startsWith(".") && !UE_PROJECT_SKIP.test(e.name) && hasUproject(join(dir, e.name), depth + 1),
    );
  } catch {
    return false;
  }
}

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

  /**
   * Todos os arquivos de código da pasta (caminhos com "/"), com as mesmas regras da pasta do Claude no app
   * (fileKinds.ts). Pasta com .uproject (na raiz ou numa subpasta, como acha o app) = sala Unreal: Content/, Binaries/,
   * Intermediate/, Saved/... ficam de fora em qualquer nível.
   */
  scan(): string[] {
    const unreal = hasUproject(this.root);
    const ignored = (rel: string) => IGNORE_PATH.test(rel) || (unreal && UNREAL_IGNORE_PATH.test(rel));
    const out: string[] = [];
    const walk = (rel: string) => {
      for (const name of readdirSync(rel ? this.abs(rel) : this.root)) {
        const p = rel ? `${rel}/${name}` : name;
        if (name.startsWith(".") || ignored(p)) continue;
        const st = statSync(this.abs(p));
        if (st.isDirectory()) walk(p);
        else if (st.isFile() && isCodePath(p)) out.push(p);
      }
    };
    walk("");
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
    // Só o que sumiu mesmo do disco (um arquivo que as regras de hoje não varrem não conta como apagado).
    const removed = Object.keys(this.state.files).filter((p) => !local.has(p) && this.readLocal(p) === null);
    return { changed, added, removed };
  }
}
