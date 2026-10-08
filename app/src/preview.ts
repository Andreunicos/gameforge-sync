/**
 * Monta o HTML do preview a partir dos arquivos da sala.
 *
 * O jogo roda num iframe em sandbox SEM allow-same-origin: não enxerga o login,
 * o Firebase nem nada do app. Por isso tudo é embutido no próprio HTML:
 * - <script src> e <link rel=stylesheet> que apontam para arquivos da sala viram inline;
 * - módulos ES viram data: URLs (os imports relativos são reescritos);
 * - imagens/sons resolvem pelo <base href> = URL dos assets da sala (GitHub Pages);
 * - localStorage vira memória (o sandbox bloqueia o de verdade);
 * - console e erros são enviados ao app por postMessage.
 */

export interface PreviewInput {
  paths: string[];
  contentOf(path: string): string | undefined;
  assetsBase: string;
  /** Página escolhida no preview; sem ela (ou se sumiu da sala), vale o index.html. */
  entry?: string | null;
  /** localStorage da sala, o mesmo em todas as páginas enquanto o preview está aberto. */
  storage?: Record<string, string>;
  /** Build "Web .html": um arquivo só que roda sozinho (sem o console/localStorage do preview). */
  standalone?: boolean;
}

export function findEntry(paths: string[]): string | null {
  return paths.find((p) => p === "index.html") ?? paths.find((p) => p.endsWith("/index.html")) ?? paths.find((p) => /\.html?$/i.test(p)) ?? null;
}

function dirOf(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

/** Resolve "../js/a.js" relativo a "src/game.js" → "js/a.js". Devolve null para URLs absolutas. */
export function resolvePath(from: string, spec: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith("//")) return null;
  const clean = spec.split(/[?#]/)[0];
  const parts = (clean.startsWith("/") ? clean.slice(1) : dirOf(from) + clean).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

// Raiz falsa quando a sala não tem assets publicados: só serve para os links entre páginas resolverem.
const FAKE_ROOT = "https://sala.gameforge.invalid/";

/** Roda antes do jogo: console → app, localStorage único da sala, navegação entre páginas → app. */
function shim(storage: Record<string, string>, root: string) {
  return `(function(S,ROOT){
var post=function(m){m.__gfs=1;try{parent.postMessage(m,'*')}catch(e){}};
var P=function(level,args){post({level:level,text:Array.prototype.map.call(args,function(a){try{return a instanceof Error?(a.stack||a.message):(typeof a==='object'?JSON.stringify(a):String(a))}catch(e){return String(a)}}).join(' ')})};
['log','info','warn','error'].forEach(function(l){var o=console[l];console[l]=function(){P(l,arguments);return o.apply(console,arguments)}});
addEventListener('error',function(e){if(e.message)P('error',[e.message+(e.lineno?' (linha '+e.lineno+')':'')])},true);
addEventListener('unhandledrejection',function(e){var r=e.reason;P('error',['Promise rejeitada: '+(r&&r.message||r)])});
function M(d,sync){var tell=function(k,v){if(sync)post({store:[k,v]})};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v);tell(String(k),String(v))},removeItem:function(k){delete d[k];tell(String(k),null)},clear:function(){Object.keys(d).forEach(function(k){tell(k,null)});d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}}
try{window.localStorage.length}catch(e){try{Object.defineProperty(window,'localStorage',{value:M(S,true)});Object.defineProperty(window,'sessionStorage',{value:M({},false)})}catch(_){}}
function page(u){try{var x=new URL(u,document.baseURI),h=x.origin+x.pathname;if(h.indexOf(ROOT)!==0)return null;var p=decodeURIComponent(h.slice(ROOT.length));if(p===''||p.slice(-1)==='/')p+='index.html';return /[.]html?$/i.test(p)?p:null}catch(e){return null}}
function go(u){var p=page(u);if(p)post({nav:p});else location.href=u}
window.__gfsLoc={get href(){return location.href},set href(u){go(String(u))},assign:function(u){go(String(u))},replace:function(u){go(String(u))}};
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a||(a.target&&a.target!=='_self'))return;var p=page(a.href);if(p){e.preventDefault();post({nav:p})}},true);
if(window.navigation)navigation.addEventListener('navigate',function(e){if(e.hashChange||e.navigationType==='reload'||e.navigationType==='traverse')return;var p=page(e.destination.url);if(p&&e.cancelable){e.preventDefault();post({nav:p})}});
})(${JSON.stringify(storage).replace(/</g, "\u003c")},${JSON.stringify(root)});`;
}

// O iframe não tem origem própria, então o navegador não avisa quando o jogo troca de página.
// Por isso "location.href = x", "location = x", "location.assign(x)" e "location.replace(x)" passam por __gfsLoc.
const LOC_SET_RE = /(?<![\w$.])(?:(?:window|document|self|globalThis)\s*\.\s*)?location(?:\s*\.\s*href)?\s*=(?!=)/g;
const LOC_CALL_RE = /(?<![\w$.])(?:(?:window|document|self|globalThis)\s*\.\s*)?location\s*\.\s*(assign|replace)\s*\(/g;
export const rewriteNav = (code: string) => code.replace(LOC_SET_RE, "__gfsLoc.href=").replace(LOC_CALL_RE, "__gfsLoc.$1(");

const IMPORT_RE =
  /(\bimport\s*(?:[\w*${}\s,]+?\s*from\s*)?|\bexport\s*[\w*${}\s,]+?\s*from\s*|\bimport\s*\(\s*)(['"])([^'"\n]+)\2/g;

export function buildPreview(input: PreviewInput): { html: string; warnings: string[] } {
  const warnings: string[] = [];
  const entry = (input.entry && input.paths.includes(input.entry) ? input.entry : null) ?? findEntry(input.paths);
  if (!entry) {
    return {
      html: `<!doctype html><body style="font-family:system-ui;color:#9a8fb0;background:#120f19;display:grid;place-items:center;height:100vh;margin:0"><p style="text-align:center;padding:20px">O jogo aparece aqui quando a sala tiver um <b style="color:#ffb26b">index.html</b>.</p></body>`,
      warnings,
    };
  }

  const moduleCache = new Map<string, string>();
  const moduleUrl = (path: string, stack: string[]): string | null => {
    const cached = moduleCache.get(path);
    if (cached) return cached;
    const code = input.contentOf(path);
    if (code === undefined) return null;
    if (stack.includes(path)) {
      warnings.push(`Import circular em ${path}: o preview não resolve ciclos entre módulos.`);
      return null;
    }
    const rewritten = rewriteNav(code).replace(IMPORT_RE, (all, head: string, q: string, spec: string) => {
      const target = resolvePath(path, spec);
      if (target === null) return all;
      const url = moduleUrl(target, [...stack, path]);
      if (!url) {
        warnings.push(`${path}: não achei "${spec}" na sala.`);
        return all;
      }
      return `${head}${q}${url}${q}`;
    });
    const url = "data:text/javascript;charset=utf-8," + encodeURIComponent(rewritten + `\n//# sourceURL=${path}`);
    moduleCache.set(path, url);
    return url;
  };

  const doc = new DOMParser().parseFromString(input.contentOf(entry) ?? "", "text/html");

  for (const s of Array.from(doc.querySelectorAll("script[src]"))) {
    const target = resolvePath(entry, s.getAttribute("src")!);
    if (target === null) continue; // CDN etc.: deixa como está
    const isModule = s.getAttribute("type") === "module";
    if (isModule) {
      const url = moduleUrl(target, []);
      if (url) s.setAttribute("src", url);
      else warnings.push(`index: não achei ${target} na sala.`);
      continue;
    }
    const code = input.contentOf(target);
    if (code === undefined) {
      if (!input.assetsBase) warnings.push(`Script ${target} não está na sala.`);
      continue;
    }
    s.removeAttribute("src");
    s.textContent = code.replace(/<\/script/gi, "<\\/script") + `\n//# sourceURL=${target}`;
  }

  // Módulos inline com imports relativos
  for (const s of Array.from(doc.querySelectorAll('script[type="module"]:not([src])'))) {
    s.textContent = rewriteNav(s.textContent ?? "").replace(IMPORT_RE, (all, head: string, q: string, spec: string) => {
      const target = resolvePath(entry, spec);
      const url = target === null ? null : moduleUrl(target, []);
      return url ? `${head}${q}${url}${q}` : all;
    });
  }

  for (const s of Array.from(doc.querySelectorAll("script:not([src])"))) {
    if (s.getAttribute("type") !== "module") s.textContent = rewriteNav(s.textContent ?? "");
  }
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const at of Array.from(el.attributes)) if (/^on/i.test(at.name)) at.value = rewriteNav(at.value);
  }

  for (const l of Array.from(doc.querySelectorAll('link[rel="stylesheet"][href]'))) {
    const target = resolvePath(entry, l.getAttribute("href")!);
    if (target === null) continue;
    const code = input.contentOf(target);
    if (code === undefined) continue;
    const style = doc.createElement("style");
    style.textContent = code + `\n/*# sourceURL=${target} */`;
    l.replaceWith(style);
  }

  const head = doc.head;
  if (input.standalone) {
    if (input.assetsBase) {
      const base = doc.createElement("base");
      base.href = input.assetsBase.replace(/\/?$/, "/") + dirOf(entry);
      head.prepend(base);
    }
    return { html: "<!doctype html>\n" + doc.documentElement.outerHTML, warnings };
  }
  const root = input.assetsBase ? input.assetsBase.replace(/\/?$/, "/") : FAKE_ROOT;
  const base = doc.createElement("base");
  base.href = root + dirOf(entry);
  head.prepend(base);
  const pre = doc.createElement("script");
  pre.textContent = shim(input.storage ?? {}, root);
  head.prepend(pre);

  return { html: "<!doctype html>\n" + doc.documentElement.outerHTML, warnings };
}
