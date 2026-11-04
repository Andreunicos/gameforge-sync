// Pastas visuais da lista de salas (src/roomFolders.ts).
import { describe, expect, it } from "vitest";
import { addFolder, folderOf, groupRooms, moveRoom, removeFolder, renameFolder, toggleFolder, type RoomFolders } from "../src/roomFolders";

const empty: RoomFolders = { folders: [], of: {} };
const rooms = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("pastas visuais de salas", () => {
  it("cria, renomeia e ignora nome vazio", () => {
    expect(addFolder(empty, "   ")).toBe(empty);
    const f = addFolder(empty, "  Unreal  ");
    expect(f.folders).toHaveLength(1);
    expect(f.folders[0].name).toBe("Unreal");
    expect(renameFolder(f, f.folders[0].id, "Roblox").folders[0].name).toBe("Roblox");
    expect(renameFolder(f, f.folders[0].id, " ")).toBe(f);
  });

  it("move salas, agrupa e mantém as soltas", () => {
    let f = addFolder(empty, "Unreal");
    const id = f.folders[0].id;
    f = moveRoom(f, "a", id);
    f = moveRoom(f, "c", id);
    const g = groupRooms(f, rooms);
    expect(g.folders[0].rooms.map((r) => r.id)).toEqual(["a", "c"]);
    expect(g.loose.map((r) => r.id)).toEqual(["b"]);
    expect(folderOf(moveRoom(f, "a", null), "a")).toBeNull();
  });

  it("pasta inexistente não prende a sala", () => {
    expect(moveRoom(empty, "a", "fantasma").of).toEqual({});
    expect(groupRooms({ folders: [], of: { a: "sumiu" } }, rooms).loose).toHaveLength(3);
  });

  it("apagar a pasta solta as salas e não toca nas outras", () => {
    let f = addFolder(addFolder(empty, "A"), "B");
    const [a, b] = f.folders.map((x) => x.id);
    f = moveRoom(moveRoom(f, "a", a), "b", b);
    const r = removeFolder(f, a);
    expect(r.folders.map((x) => x.id)).toEqual([b]);
    expect(r.of).toEqual({ b });
  });

  it("recolher e abrir", () => {
    const f = addFolder(empty, "A");
    expect(toggleFolder(f, f.folders[0].id).folders[0].open).toBe(false);
  });
});
