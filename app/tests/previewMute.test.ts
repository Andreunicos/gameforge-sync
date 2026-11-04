// O botão 🔇 do preview: o shim silencia AudioContext e <audio>/<video> dentro do iframe (roda o shim num window falso).
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { shim } from "../src/preview";

function run(initial: boolean) {
  const listeners: Record<string, (e: unknown) => void> = {};
  class Ctx {
    private d = {};
    get destination() {
      return this.d;
    }
    createGain() {
      const g: { gain: { value: number }; connect(t: unknown): void; to?: unknown } = { gain: { value: 1 }, connect: (t) => (g.to = t) };
      return g;
    }
  }
  function Media() {}
  const audio = { muted: false } as { muted: boolean };
  Media.prototype.play = () => "ok";
  const parent = { postMessage() {} };
  const win: Record<string, unknown> = {
    AudioContext: Ctx,
    HTMLMediaElement: Media,
    addEventListener: (n: string, f: (e: unknown) => void) => (listeners[n] = f),
    console,
    parent,
    document: { baseURI: "https://x.invalid/", addEventListener() {}, querySelectorAll: () => [audio] },
    location: {},
  };
  win.window = win;
  const ctx = vm.createContext({ ...win, URL, WeakMap, Object, Array, JSON, String, Error, decodeURIComponent });
  vm.runInContext(shim({}, "https://x.invalid/", initial), ctx);
  const send = (v: boolean) => listeners.message({ source: parent, data: { __gfsMute: v } });
  return { Ctx, Media, audio, send };
}

describe("mute do preview", () => {
  it("começa mudo e liga o som de volta", () => {
    const { Ctx, send } = run(true);
    const d = new Ctx().destination as unknown as { gain: { value: number } };
    expect(d.gain.value).toBe(0);
    send(false);
    expect(d.gain.value).toBe(1);
  });

  it("desliga o som no meio do jogo e devolve o mesmo nó", () => {
    const { Ctx, send } = run(false);
    const c = new Ctx();
    const d = c.destination as unknown as { gain: { value: number } };
    expect(d.gain.value).toBe(1);
    send(true);
    expect(d.gain.value).toBe(0);
    expect(c.destination).toBe(d);
  });

  it("silencia <audio> ao tocar e restaura o que o jogo tinha", () => {
    const { Media, send } = run(false);
    const el = Object.create(Media.prototype) as { muted: boolean; play(): string };
    el.muted = false;
    send(true);
    el.play();
    expect(el.muted).toBe(true);
    send(false);
    expect(el.muted).toBe(false);
  });
});
