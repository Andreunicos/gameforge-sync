// `gfs map`: gera .gfs/MAPA.md (o app gera sozinho; este comando serve com o app fechado).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMap } from "./mapa.ts";
import { Workspace } from "./workspace.ts";

export function mapCommand() {
  const ws = Workspace.find();
  const files = ws.scan().map((p): [string, string] => [p, ws.readLocal(p) ?? ""]);
  const text = buildMap(files, ws.state.roomName);
  writeFileSync(join(ws.root, ".gfs", "MAPA.md"), text);
  console.log(`✓ .gfs/MAPA.md: ${text.length} bytes (~${Math.round(text.length / 4)} tokens) para ${files.length} arquivos.`);
}
