import { useEffect, useRef } from "react";

// Fundo do menu: noite na forja, desenhado num canvas pequeno e ampliado (cada pixel = SCALE px de tela).
const SCALE = 4;

const SKY = ["#120a1f", "#180e29", "#211234", "#2e173e", "#421d45", "#5c2645", "#7a3343"];
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const C = {
  outline: "#120914",
  farHill: "#2a1736",
  nearHill: "#1d1029",
  pine: "#150b1f",
  ground: "#1a0f20",
  groundTop: "#2e1b34",
  stone: "#4b3a55",
  stoneDark: "#382a44",
  mortar: "#2a1e34",
  roof: "#8a3f2a",
  roofDark: "#64291d",
  roofLight: "#a85536",
  wood: "#6b4026",
  woodDark: "#4a2a1a",
  steel: "#b3abc6",
  steelLight: "#e9e3f2",
  steelDark: "#5a5172",
  moon: "#ffe9b8",
  moonDark: "#e8c98a",
};

type Particle = { x: number; y: number; vx: number; vy: number; life: number; max: number; kind: "ember" | "smoke" | "spark" };

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function rand(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function PixelBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    // "Menos movimento" no Windows: segue animando de leve (estrelas, fogo, fumaça), sem faíscas e brasas.
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let W = 0;
    let H = 0;
    let groundY = 0;
    let forge = { x: 0, door: { x: 0, y: 0, w: 0, h: 0 }, win: { x: 0, y: 0 }, chimney: { x: 0, y: 0 } };
    let anvil = { x: 0, y: 0 };
    let stars: { x: number; y: number; p: number; big: boolean }[] = [];
    let parts: Particle[] = [];
    let base: HTMLCanvasElement | null = null;
    let raf = 0;
    let last = 0;
    let sparkTimer = 1;

    const px = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) => {
      g.fillStyle = c;
      g.fillRect(Math.round(x), Math.round(y), w, h);
    };

    function drawStatic() {
      base = document.createElement("canvas");
      base.width = W;
      base.height = H;
      const g = base.getContext("2d")!;
      const horizon = Math.round(H * 0.78);

      // céu em faixas com dither
      const img = g.createImageData(W, H);
      const cols = SKY.map(hex);
      for (let y = 0; y < H; y++) {
        const t = Math.min(1, y / horizon) * (cols.length - 1);
        const i = Math.min(cols.length - 2, Math.floor(t));
        const f = t - i;
        for (let x = 0; x < W; x++) {
          const c = f * 16 > BAYER[y & 3][x & 3] ? cols[i + 1] : cols[i];
          const o = (y * W + x) * 4;
          img.data[o] = c[0];
          img.data[o + 1] = c[1];
          img.data[o + 2] = c[2];
          img.data[o + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);

      // lua
      const mx = Math.round(W * 0.84);
      const my = Math.round(H * 0.15);
      for (let y = -7; y <= 7; y++)
        for (let x = -7; x <= 7; x++) {
          const d = x * x + y * y;
          if (d <= 42) px(g, mx + x, my + y, 1, 1, x + y > 4 ? C.moonDark : C.moon);
          else if (d <= 72 && (x + y) % 2 === 0) px(g, mx + x, my + y, 1, 1, "#4a2a52");
        }
      px(g, mx - 3, my - 2, 2, 2, C.moonDark);
      px(g, mx + 2, my + 1, 3, 2, C.moonDark);
      px(g, mx - 1, my + 4, 2, 1, C.moonDark);

      // montanhas distantes
      const r = rand(7);
      const a1 = r() * 6;
      const a2 = r() * 6;
      for (let x = 0; x < W; x++) {
        const h = 26 + Math.sin(x / 23 + a1) * 9 + Math.sin(x / 9 + a2) * 3;
        px(g, x, horizon - h, 1, H, C.farHill);
      }
      // morros perto
      for (let x = 0; x < W; x++) {
        const h = 12 + Math.sin(x / 31 + a2) * 5 + Math.sin(x / 13) * 2;
        px(g, x, groundY - h, 1, H, C.nearHill);
      }
      // pinheiros
      const rp = rand(11);
      for (let x = 4; x < W; x += 6 + Math.floor(rp() * 10)) {
        const hh = 12 + Math.floor(rp() * 10);
        const hillTop = groundY - (12 + Math.sin(x / 31 + a2) * 5 + Math.sin(x / 13) * 2);
        const bottom = Math.round(hillTop) + 3;
        for (let i = 0; i < hh; i++) {
          const half = Math.floor((i % 5) / 1.6) + Math.floor(i / 5);
          px(g, x - half, bottom - hh + i, half * 2 + 1, 1, C.pine);
        }
        px(g, x, bottom, 1, 2, C.pine);
      }

      // chão
      px(g, 0, groundY, W, H - groundY, C.ground);
      px(g, 0, groundY, W, 1, C.groundTop);
      const rg = rand(3);
      for (let x = 0; x < W; x += 2 + Math.floor(rg() * 5)) px(g, x, groundY - 1, 1, 1, C.groundTop);

      drawForge(g);
      drawAnvil(g);
    }

    function drawForge(g: CanvasRenderingContext2D) {
      const x0 = forge.x;
      const ww = 30;
      const wh = 17;
      const top = groundY - wh;
      // paredes de pedra
      px(g, x0 - 1, top - 1, ww + 2, wh + 1, C.outline);
      px(g, x0, top, ww, wh, C.stone);
      for (let y = 0; y < wh; y += 3) {
        px(g, x0, top + y, ww, 1, C.mortar);
        for (let x = (y / 3) % 2 ? 2 : 5; x < ww; x += 7) px(g, x0 + x, top + y, 1, 3, C.mortar);
        px(g, x0, top + y + 1, ww, 1, C.stone);
        for (let x = (y / 3) % 2 ? 3 : 0; x < ww; x += 7) px(g, x0 + x, top + y + 2, 3, 1, C.stoneDark);
      }
      // chaminé
      const cx = x0 + 21;
      const ctop = top - 17;
      px(g, cx - 1, ctop - 1, 7, 18, C.outline);
      px(g, cx, ctop, 5, 17, C.stoneDark);
      px(g, cx - 1, ctop - 1, 7, 2, C.outline);
      px(g, cx, ctop, 5, 1, C.stone);
      for (let y = 2; y < 17; y += 3) px(g, cx, ctop + y, 5, 1, C.mortar);
      forge.chimney = { x: cx + 2, y: ctop - 2 };
      // telhado em degraus
      const rows = 11;
      for (let i = 0; i < rows; i++) {
        const y = top - 1 - i;
        const l = x0 - 4 + i;
        const w = ww + 8 - i * 2;
        if (w <= 0) break;
        px(g, l - 1, y, w + 2, 1, C.outline);
        px(g, l, y, w, 1, i % 3 === 0 ? C.roofDark : C.roof);
        px(g, l, y, 2, 1, C.roofLight);
      }
      px(g, x0 - 5, top - 1, ww + 10, 1, C.outline);
      // porta com fogo
      const d = { x: x0 + 4, y: groundY - 11, w: 8, h: 11 };
      px(g, d.x - 1, d.y - 1, d.w + 2, d.h + 1, C.woodDark);
      px(g, d.x, d.y, d.w, d.h, "#ff8a3a");
      px(g, d.x - 1, d.y - 1, 1, 1, C.stone);
      px(g, d.x + d.w, d.y - 1, 1, 1, C.stone);
      forge.door = d;
      // janela
      const wx = x0 + 17;
      const wy = top + 4;
      px(g, wx - 1, wy - 1, 9, 7, C.woodDark);
      px(g, wx, wy, 7, 5, "#ffb347");
      px(g, wx + 3, wy, 1, 5, C.woodDark);
      px(g, wx, wy + 2, 7, 1, C.woodDark);
      forge.win = { x: wx, y: wy };
      // lenha na porta
      px(g, x0 + ww + 2, groundY - 4, 6, 4, C.outline);
      px(g, x0 + ww + 3, groundY - 3, 4, 1, C.wood);
      px(g, x0 + ww + 3, groundY - 2, 4, 1, C.woodDark);
      px(g, x0 + ww + 3, groundY - 1, 4, 1, C.wood);
    }

    function drawAnvil(g: CanvasRenderingContext2D) {
      const { x, y } = anvil; // x = centro, y = chão
      // toco
      px(g, x - 6, y - 6, 13, 6, C.outline);
      px(g, x - 5, y - 5, 11, 5, C.wood);
      px(g, x - 5, y - 5, 11, 1, "#a06a42");
      px(g, x - 3, y - 3, 1, 3, C.woodDark);
      px(g, x + 2, y - 4, 1, 4, C.woodDark);
      // bigorna
      const t = y - 6;
      px(g, x - 4, t - 4, 9, 4, C.outline);
      px(g, x - 3, t - 3, 7, 3, C.steelDark);
      px(g, x - 2, t - 6, 5, 3, C.outline);
      px(g, x - 1, t - 6, 3, 2, C.steel);
      px(g, x - 8, t - 10, 17, 5, C.outline);
      px(g, x - 7, t - 9, 15, 3, C.steel);
      px(g, x - 7, t - 9, 15, 1, C.steelLight);
      px(g, x - 11, t - 9, 4, 2, C.outline);
      px(g, x - 10, t - 9, 3, 1, C.steel);
      // barra em brasa
      px(g, x - 2, t - 11, 6, 2, C.outline);
      px(g, x - 1, t - 11, 4, 1, "#ff7a2f");
    }

    function layout() {
      W = Math.ceil(window.innerWidth / SCALE);
      H = Math.ceil(window.innerHeight / SCALE);
      cv!.width = W;
      cv!.height = H;
      cv!.style.width = `${W * SCALE}px`;
      cv!.style.height = `${H * SCALE}px`;
      groundY = H - 10;
      forge = { ...forge, x: Math.max(6, Math.round(W * 0.06)) };
      anvil = { x: Math.min(W - 16, Math.round(W * 0.88)), y: groundY };
      const r = rand(42);
      const sky = Math.round(H * 0.6);
      stars = Array.from({ length: Math.round((W * H) / 220) }, () => ({
        x: Math.floor(r() * W),
        y: Math.floor(r() * sky),
        p: r() * Math.PI * 2,
        big: r() < 0.12,
      }));
      parts = [];
      drawStatic();
    }

    function spawn(dt: number) {
      // fumaça da chaminé
      if (Math.random() < dt * 3)
        parts.push({ x: forge.chimney.x + (Math.random() * 3 - 1), y: forge.chimney.y, vx: 1.5 + Math.random() * 2, vy: -5 - Math.random() * 3, life: 0, max: 4 + Math.random() * 2, kind: "smoke" });
      if (calm) return;
      // brasas subindo da chaminé
      if (Math.random() < dt * 2.2)
        parts.push({ x: forge.chimney.x + Math.random() * 3, y: forge.chimney.y, vx: (Math.random() - 0.3) * 6, vy: -10 - Math.random() * 8, life: 0, max: 2 + Math.random() * 2, kind: "ember" });
      // marteladas na bigorna
      sparkTimer -= dt;
      if (sparkTimer <= 0) {
        sparkTimer = 1.4 + Math.random() * 1.6;
        const n = 6 + Math.floor(Math.random() * 6);
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
          const s = 18 + Math.random() * 26;
          parts.push({ x: anvil.x + 1, y: anvil.y - 18, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, max: 0.6 + Math.random() * 0.6, kind: "spark" });
        }
      }
    }

    function frame(now: number) {
      const t = now / 1000;
      const dt = last ? Math.min(0.1, t - last) : 0;
      last = t;
      if (!base) return;
      ctx!.drawImage(base, 0, 0);

      // estrelas piscando
      for (const s of stars) {
        const b = Math.sin(t * 1.3 + s.p);
        if (b < -0.6) continue;
        const c = b > 0.6 ? "#fff4d6" : b > 0 ? "#cdb8e0" : "#7f6a99";
        px(ctx!, s.x, s.y, 1, 1, c);
        if (s.big && b > 0.7) {
          px(ctx!, s.x - 1, s.y, 1, 1, "#7f6a99");
          px(ctx!, s.x + 1, s.y, 1, 1, "#7f6a99");
          px(ctx!, s.x, s.y - 1, 1, 1, "#7f6a99");
          px(ctx!, s.x, s.y + 1, 1, 1, "#7f6a99");
        }
      }

      // fogo da porta e janela tremendo
      const d = forge.door;
      const flick = Math.sin(t * 9) + Math.sin(t * 23.7);
      px(ctx!, d.x, d.y, d.w, d.h, flick > 0.6 ? "#ff9a40" : "#ff8a3a");
      px(ctx!, d.x + 1, d.y + d.h - 5, d.w - 2, 5, "#ffb347");
      for (let i = 0; i < d.w - 2; i++) {
        const fh = 2 + Math.round((Math.sin(t * 11 + i * 1.9) + 1) * 1.5);
        px(ctx!, d.x + 1 + i, d.y + d.h - fh, 1, fh, "#ffe08a");
      }
      if (flick > 1.2) {
        px(ctx!, forge.win.x, forge.win.y, 3, 2, "#ffd27a");
        px(ctx!, forge.win.x + 4, forge.win.y + 3, 3, 2, "#ffd27a");
      }
      // luz da forja no chão
      for (let x = -6; x < d.w + 6; x++) if ((x + Math.floor(t * 4)) % 3 === 0) px(ctx!, d.x + x, groundY, 1, 1, "#5a3326");
      // barra em brasa pulsando
      px(ctx!, anvil.x - 1, anvil.y - 17, 4, 1, Math.sin(t * 3) > 0 ? "#ffb347" : "#ff7a2f");

      spawn(dt);
      parts = parts.filter((p) => {
        p.life += dt;
        if (p.life >= p.max) return false;
        if (p.kind === "spark") p.vy += 70 * dt;
        if (p.kind === "ember") p.vx += Math.sin(t * 3 + p.y) * 4 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        const k = p.life / p.max;
        if (p.kind === "smoke") {
          const sz = 1 + Math.floor(k * 3);
          px(ctx!, p.x, p.y, sz, sz, k < 0.4 ? "#625170" : k < 0.75 ? "#4a3b58" : "#352942");
        } else {
          px(ctx!, p.x, p.y, 1, 1, k < 0.3 ? "#fff1b0" : k < 0.65 ? "#ffb347" : "#e2562b");
        }
        return p.y > -4 && p.y < H + 4;
      });

      raf = requestAnimationFrame(frame);
    }

    const onResize = () => layout();
    layout();
    raf = requestAnimationFrame(frame);
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas ref={ref} className="pix-backdrop" aria-hidden />;
}
