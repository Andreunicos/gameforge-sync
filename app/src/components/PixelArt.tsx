// Sprites pixel a pixel do menu (logo e ícone de sala). Cada letra da grade é uma cor; "." é vazio.
import type { ReactNode } from "react";

type Palette = Record<string, string>;

function Sprite({ rows, pal, scale, className }: { rows: string[]; pal: Palette; scale: number; className?: string }) {
  const w = rows[0].length;
  const h = rows.length;
  const rects: ReactNode[] = [];
  rows.forEach((row, y) => {
    // junta pixels iguais vizinhos na mesma linha (menos <rect>)
    let x = 0;
    while (x < w) {
      const c = row[x];
      let n = 1;
      while (x + n < w && row[x + n] === c) n++;
      if (c !== "." && pal[c]) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={n} height={1} fill={pal[c]} />);
      x += n;
    }
  });
  return (
    <svg
      className={className}
      width={w * scale}
      height={h * scale}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      aria-hidden
    >
      {rects}
    </svg>
  );
}

// Bigorna com uma barra em brasa e faíscas.
const ANVIL = [
  "................",
  "..........y.....",
  "......y.....y...",
  ".........y......",
  "......KKKKKK....",
  "......KOOOYK....",
  "KKKKKKKKKKKKKKKK",
  "KHHHHHHHHHHHHHHK",
  ".KKGGGGGGGGGGGGK",
  "...KKKgggggggKKK",
  ".....KdgggggdK..",
  ".....KdgggggdK..",
  "....KddgggggddK.",
  "...KddddddddddK.",
  "...KKKKKKKKKKKK.",
  "................",
];
const ANVIL_PAL: Palette = {
  K: "#1a0f1c",
  H: "#e9e3f2",
  G: "#b3abc6",
  g: "#857c9c",
  d: "#5a5172",
  O: "#ff7a2f",
  Y: "#ffd166",
  y: "#ffb347",
};

export function LogoAnvil() {
  return (
    <div className="pix-logo">
      <Sprite rows={ANVIL} pal={ANVIL_PAL} scale={3} />
    </div>
  );
}

// Cartucho de jogo; a cor muda conforme o nome da sala.
const CART = [
  ".KKKKKKKKKK.",
  "KBBBBBBBBBBK",
  "KBLLLLLLLLBK",
  "KBLWWWWWWLBK",
  "KBLWwwwwWLBK",
  "KBLWWWWWWLBK",
  "KBLLLLLLLLBK",
  "KBBBBBBBBBBK",
  "KbBBBBBBBBbK",
  "KbbbbbbbbbbK",
  ".KYKYKYKYKK.",
  "..K.K.K.K...",
];
const HUES = [
  ["#ff9d4d", "#c8622a"],
  ["#5ad1a4", "#2f8c6c"],
  ["#7fb6ff", "#4a6fc0"],
  ["#ff7aa2", "#b8456a"],
  ["#ffd166", "#c99a2e"],
  ["#b58cff", "#7653c2"],
];

export function CartIcon({ seed }: { seed: string }) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [body, dark] = HUES[h % HUES.length];
  const pal: Palette = { K: "#1a0f1c", B: body, b: dark, L: "#f6ecd8", W: "#3a2a44", w: body, Y: "#ffd166" };
  return <Sprite rows={CART} pal={pal} scale={2} className="cart" />;
}

// Lixeira; o corpo usa a cor do texto do botão (fica vermelha no hover).
const TRASH = [
  "...KKKK...",
  "..KLLLLK..",
  "KKKKKKKKKK",
  "KLLLLLLLLK",
  "KKKKKKKKKK",
  ".KGdGdGdK.",
  ".KGdGdGdK.",
  ".KGdGdGdK.",
  ".KGdGdGdK.",
  ".KKKKKKKK.",
];

export function TrashIcon() {
  return <Sprite rows={TRASH} pal={{ K: "#1a0f1c", L: "currentColor", G: "currentColor", d: "#5a5172" }} scale={2} />;
}
