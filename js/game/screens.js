// Front end in the 1993 manner: title / pause / skill / options / help menus with a skull cursor and
// thermometer sliders, the end-of-level tally and the automap. Everything is drawn with the project's
// pixel fonts onto small "virtual" canvases that the browser scales up by whole or half device-pixel steps
// (image-rendering: pixelated), so the pixel art stays crisp at any window size. All art is original.
import { bigText, textCanvas, textWidth, drawText, drawBig, RAMPS, BIG_W } from './pixfont.js';

const TICRATE = 35;
const DES_W = 640, DES_H = 400;   // menu design size in virtual pixels (320×200 doubled): always fits the view
const MAP_ROWS = 300;             // the automap's virtual height: chunky aliased lines, like a 90s automap
// automap zoom: feet across the view height (across its width's 4:3 equivalent if that is less: portrait); limits
export const AUTOMAP = { ft: 48, min: 12, max: 240, step: 1.25 };
// Automap level filter. Only walls whose height range overlaps the player's body band [feet + 1, feet + 5] (by at
// least LEVEL_MIN ft: a slab edge's sliver doesn't count) are drawn. They are bright when a walkable surface beside
// them lies within NEAR ft of the player's feet and they stand LEVEL_FULL ft into that surface's band (this level's
// walls), dim otherwise (the storeys above and below, seen from a split-level landing or a stair). An opening is
// walked through when it is WALK_H tall and overlaps the band of the floor it serves by WALK_BAND.
const LEVEL_MIN = 0.5, LEVEL_FULL = 2, NEAR = 2.6, WALK_H = 5.5, WALK_BAND = 3;

// ------------------------------------------------------------ palettes ----
const RAMP = {
  ...RAMPS,
  fire: ['#fff4b8', '#ffdc68', '#ffb834', '#ff8c1c', '#f0600e', '#d0380a', '#a41e06'],
  dim: ['#aaa29a', '#9e968e', '#928a82', '#867e76', '#7a726a', '#6e665e', '#625a52'],
};
const LOGO_RAMP = ['#fffbe0', '#fff0a0', '#ffd860', '#ffbc38', '#ff9a22', '#ff7414', '#f24e0c', '#d8300a', '#b41c06',
  '#8c1004', '#640802'];
const LOGO_EXT = ['#6a1604', '#561004', '#440c02', '#340802', '#280602', '#200401'];
const BONE = ['#fff8e2', '#f0e0b6', '#dcc592', '#c4a672', '#a68656', '#846640', '#62482c', '#42301c', '#2c1e10'];
const HORN = ['#b07a52', '#8a5436', '#643624', '#442014', '#2a120a'];
const hex = s => { const n = parseInt(s.slice(1), 16); return (255 << 24 | (n & 255) << 16 | (n >> 8 & 255) << 8 | n >> 16) >>> 0; };
const rgba = (r, g, b, a = 255) => (a << 24 | b << 16 | g << 8 | r) >>> 0;   // ImageData word (little endian)
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const hash = (x, y) => { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function pixCanvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), img = g.createImageData(w, h);
  return { c, g, img, px: new Uint32Array(img.data.buffer) };
}

// --------------------------------------------------------------- text ----
// The pixel font is plain ASCII: fold typographic punctuation (the game's loading texts end in '…') and accents
// onto it, or they would print as '?'.
const plain = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\u2026/g, '...')
  .replace(/[\u2018\u2019\u201a\u2032]/g, "'").replace(/[\u201c\u201d\u201e\u2033]/g, '"').replace(/[\u2010-\u2015\u2212]/g, '-');
const texCache = new Map();
function cached(key, make) {   // rendered strings; bounded, since loading progress makes a new string each step
  let c = texCache.get(key);
  if (!c) { if (texCache.size > 400) texCache.clear(); texCache.set(key, c = make()); }
  return c;
}
const big = (s, k, style = 'red') => cached(k + '|' + style + '|' + s,
  () => bigText(plain(s), { k, ramp: RAMP[style], outline: style === 'red' || style === 'fire' ? '#2a0000' : '#141010', bevel: true }));
const small = (s, style = 'red') =>   // the 5×7 font at 1×; drawn at 2× in menus
  cached('s|' + style + '|' + s, () => textCanvas(plain(s), RAMP[style], style === 'red' ? '#1a0000' : '#000000'));

// ---------------------------------------------------------------- logo ----
// "OCEAN LANE" in chunky slanted block capitals, bevelled, extruded and set on fire. Letters on a 7×10
// grid (N is 8 wide); inside corners are chamfered so the joints read rounded.
const LOGO = {
  O: ['.#####.', '#######', '##...##', '##...##', '##...##', '##...##', '##...##', '##...##', '#######', '.#####.'],
  C: ['.######', '#######', '##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '#######', '.######'],
  E: ['#######', '#######', '##.....', '##.....', '######.', '######.', '##.....', '##.....', '#######', '#######'],
  A: ['.#####.', '#######', '##...##', '##...##', '#######', '#######', '##...##', '##...##', '##...##', '##...##'],
  L: ['##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '##.....', '#######', '#######'],
  N: Array.from({ length: 10 }, (_, r) => Array.from({ length: 8 }, (_, q) =>
    (q < 2 || q > 5 || Math.abs(q - 1.5 - r * 5 / 9) < 1 ? '#' : '.')).join('')),
};
const FIRE_MAX = 36;
const FIRE_PAL = (() => {   // heat → colour; the cool end fades out so flames lick into the background
  const stops = [[0, 0, 0, 0, 0], [5, 70, 8, 2, 90], [11, 170, 28, 6, 210], [18, 238, 86, 14, 255], [25, 255, 158, 36, 255],
    [31, 255, 222, 104, 255], [36, 255, 252, 214, 255]];
  const p = new Uint32Array(FIRE_MAX + 1);
  for (let i = 0; i <= FIRE_MAX; i++) {
    let k = 0; while (stops[k + 1][0] < i) k++;
    const a = stops[k], b = stops[k + 1], t = (i - a[0]) / (b[0] - a[0]);
    p[i] = rgba(...[1, 2, 3, 4].map(j => Math.round(a[j] + (b[j] - a[j]) * t)));
  }
  return p;
})();
function buildLogo(c) {
  const word = 'OCEAN LANE', gap = c, space = 3 * c, rows = 10, hL = rows * c, sk = 0.26;
  let w = -gap;
  for (const ch of word) w += ch === ' ' ? space : LOGO[ch][0].length * c + gap;
  const skew = Math.ceil(hL * sk), dep = Math.max(2, Math.round(c * 0.7)), pad = 3;
  const W = w + skew + dep + pad * 2 + 1, H = hL + dep + pad * 2;
  const face = new Uint8Array(W * H);
  let x0 = 0;
  for (const ch of word) {
    if (ch === ' ') { x0 += space; continue; }
    const gl = LOGO[ch], gw = gl[0].length;
    const at = (q, r) => q >= 0 && q < gw && r >= 0 && r < rows && gl[r][q] === '#';
    for (let r = 0; r < rows; r++) for (let q = 0; q < gw; q++) {
      const full = at(q, r), l = at(q - 1, r), rt = at(q + 1, r), up = at(q, r - 1), dn = at(q, r + 1);
      const corner = !full && l + rt + up + dn === 2 && (l || rt) && (up || dn);
      if (!full && !corner) continue;
      for (let yy = 0; yy < c; yy++) for (let xx = 0; xx < c; xx++) {
        if (corner) {   // 45° chamfer filling the half of the cell toward the two solid neighbours
          const ax = rt ? xx : c - 1 - xx, ay = dn ? yy : c - 1 - yy;
          if (ax + ay < c) continue;
        }
        const y = r * c + yy, sh = Math.round((hL - 1 - y) * sk);
        face[(y + pad) * W + pad + x0 + q * c + xx + sh] = 1;
      }
    }
    x0 += gw * c + gap;
  }
  // extrusion down and slightly right, then a black outline around everything
  const ext = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!face[y * W + x]) continue;
    for (let d = 1; d <= dep; d++) {
      const X = x + Math.round(d * 0.45), Y = y + d;
      if (X >= W || Y >= H) break;
      const i = Y * W + X;
      if (!face[i] && (!ext[i] || ext[i] > d)) ext[i] = d;
    }
  }
  const P = pixCanvas(W, H), px = P.px, black = rgba(8, 2, 0), halo = rgba(40, 6, 0, 200);
  const solid = i => face[i] || ext[i];
  const near = (i, r) => {   // any solid pixel within a (2r+1)² box
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (solid(i + dy * W + dx)) return true;
    return false;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (face[i]) {
      const f = (y - pad) / hL;
      let idx = f * (LOGO_RAMP.length - 1);
      if (!face[i - W]) idx -= 2.4; else if (!face[i - 2 * W]) idx -= 1.1;
      if (!face[i - 1]) idx -= 0.9;
      if (!face[i + W]) idx += 1.8;
      if (!face[i + 1]) idx += 0.8;
      idx += (hash(x, y) - 0.5) * 0.9;
      px[i] = hex(LOGO_RAMP[clamp(Math.round(idx), 0, LOGO_RAMP.length - 1)]);
    } else if (ext[i]) {
      px[i] = hex(LOGO_EXT[Math.min(LOGO_EXT.length - 1, Math.floor((ext[i] - 1) * LOGO_EXT.length / dep))]);
    } else if (x > 1 && y > 1 && x < W - 2 && y < H - 2) {
      if (near(i, 1)) px[i] = black; else if (near(i, 2)) px[i] = halo;   // outline, then a dark halo against the flames
    }
  }
  P.g.putImageData(P.img, 0, 0);
  // fire: the classic spreading-heat automaton, seeded along the letters' top silhouette and drawn behind them
  const FS = 2, up = c * 10, fw = Math.ceil(W / FS), fh = Math.ceil((H + up) / FS);
  const seeds = [], seedX = [];
  for (let fx = 0; fx < fw; fx++) {
    const x = fx * FS + 1;
    let y = 0;
    while (y < H && !(x < W && face[y * W + x])) y++;
    if (y >= H) continue;
    const fy = Math.floor((y + up) / FS) + 1;   // a row inside the letter, hidden under it
    for (const r of [fy, fy + 1]) if (r < fh) { seeds.push(r * fw + fx); seedX.push(fx); }
  }
  const F = pixCanvas(fw, fh);
  const logo = { c: P.c, W, H, up, FS, fw, fh, heat: new Uint8Array(fw * fh), seeds: Int32Array.from(seeds),
    seedX: Int32Array.from(seedX), tongue: new Float32Array(fw), t: 0, fire: F };
  for (let i = 0; i < 45; i++) fireTic(logo);   // (the flames reach full height in ~35 tics)
  return logo;
}
function fireTic(lg) {
  const { heat, fw, fh, seeds, seedX, tongue } = lg, t = ++lg.t;
  // flame strength along the word: two drifting waves plus flicker, so neighbouring columns rise together as
  // tongues a few letters' strokes wide that sway and swap places
  for (let i = 0; i < fw; i++) {
    tongue[i] = clamp(0.5 + 0.3 * Math.sin(i * 0.21 + t * 0.11) + 0.22 * Math.sin(i * 0.53 - t * 0.17 + 1.3) + (Math.random() - 0.5) * 0.3, 0, 1);
  }
  for (let i = 0; i < seeds.length; i++) heat[seeds[i]] = Math.min(FIRE_MAX, 12 + ((tongue[seedX[i]] ** 1.4) * 26 + Math.random() * 3) | 0);
  for (let y = 1; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const src = y * fw + x, p = heat[src];
      if (!p) { heat[src - fw] = 0; continue; }
      const r = (Math.random() * 4) | 0, dst = src - fw + clamp(x + r - 1, 0, fw - 1) - x;
      const nv = p - (r & 1) - (Math.random() < 0.55 ? 1 : 0);
      heat[dst] = nv > 0 ? nv : 0;
    }
  }
  // shown through a small blur: the raw automaton is salt-and-pepper noise frame by frame; smoothed, it reads as
  // licking tongues of flame
  const px = lg.fire.px, last = fw - 1;
  for (let y = 0; y < fh; y++) {
    const row = y * fw, up = y > 0 ? -fw : 0, dn = y < fh - 1 ? fw : 0;
    for (let x = 0; x < fw; x++) {
      const i = row + x;
      px[i] = FIRE_PAL[(heat[i] * 4 + heat[x > 0 ? i - 1 : i] + heat[x < last ? i + 1 : i] + heat[i + up] + heat[i + dn] + 4) >> 3];
    }
  }
  lg.fire.g.putImageData(lg.fire.img, 0, 0);
}

// --------------------------------------------------------------- skull ----
// A horned bone skull, shaded procedurally at any pixel height (mirrored for symmetry). Frame 1 has
// the eyes lit; the cursor alternates frames every 8 tics.
function buildSkull(H, lit) {
  const W = Math.round(H * 0.9) | 1, G = W + 2, GH = H + 2;
  const code = new Uint8Array(G * GH), val = new Float32Array(G * GH);
  const ln = Math.hypot(-0.5, -0.6, 0.62), Lx = -0.5 / ln, Ly = -0.6 / ln, Lz = 0.62 / ln;
  const ca = Math.cos(0.45), sa = Math.sin(0.45);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const su = ((i + 0.5) / W) * 2 - 1, v = ((j + 0.5) / H) * 2 - 1, u = Math.abs(su);
    const ci = Math.abs(i - (W - 1) / 2), k = (j + 1) * G + i + 1;
    const cran = (u / 0.72) ** 2 + ((v + 0.16) / 0.6) ** 2;
    const cheek = v > -0.12 && v < 0.5 && u < 0.68 - Math.max(0, v - 0.12) * 0.62;
    const jaw = v >= 0.4 && v < 0.97 && u < 0.42 - Math.max(0, v - 0.78) * 1.4;
    if (cran > 1 && !cheek && !jaw) {
      for (let t = 0; t <= 1.0001; t += 0.04) {   // horns sweep out from the temples and hook upward
        const hx = 0.42 + 0.52 * t, hy = -0.42 - 0.2 * t - 0.42 * t * t * t, r = 0.19 * (1 - t) ** 0.8 + 0.03;
        const d = (u - hx) ** 2 + (v - hy) ** 2;
        if (d < r * r) { code[k] = 4; val[k] = t * 0.5 + (su < 0 ? 0 : 0.3) + (v - hy) / r * 0.25; break; }
      }
      continue;
    }
    // eye sockets, slanted for a scowl
    const ex = u - 0.28, ey = v - 0.07, ru = ex * ca + ey * sa, rv = -ex * sa + ey * ca;
    if ((ru / 0.24) ** 2 + (rv / 0.17) ** 2 < 1 && v > -0.2) { code[k] = 3; val[k] = Math.hypot((u - 0.3) * 1.1, v - 0.1) / 0.17; continue; }
    if (v > 0.22 && v < 0.43 && u < (v - 0.22) * 0.55 + 0.03) { code[k] = 2; continue; }   // nasal cavity
    if (v > 0.58 && v < 0.9 && (Math.abs(v - 0.73) < 0.045 || (ci % 3 > 1.5 && ci < W * 0.2))) { code[k] = 2; continue; }   // teeth
    let nx, ny, nz;
    if (cran <= 1 && v < 0.12) { nx = su / 0.72; ny = (v + 0.16) / 0.6; nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)); }
    else { nx = su * 1.1; ny = v > 0.55 ? 0.3 : 0.02; nz = 0.62; }
    const nl = Math.hypot(nx, ny, nz) || 1;
    let lv = Math.max(0, (nx * Lx + ny * Ly + nz * Lz) / nl);
    if (v > 0.28 && v < 0.56 && u > 0.3 && u < 0.58 && !jaw) lv -= 0.3;   // cheek hollows under the cheekbones
    code[k] = 1; val[k] = lv;
  }
  const P = pixCanvas(G, GH), px = P.px;
  for (let j = 0; j < GH; j++) for (let i = 0; i < G; i++) {
    const k = j * G + i, c = code[k];
    if (c === 1) {
      let idx = (1 - val[k]) * 8 - 0.6;
      if (code[k - G] === 2 || code[k - G] === 3) idx -= 1.2;   // lower rims of the cavities catch the light
      if (code[k + G] === 3) idx += 1.2;                        // brow shadow
      if (!code[k + 1] || !code[k + G]) idx += 1;               // turning away at the right / bottom edge
      px[k] = hex(BONE[clamp(Math.round(idx), 0, BONE.length - 1)]);
    } else if (c === 2) px[k] = rgba(22, 8, 4);
    else if (c === 3) {
      const d = val[k];
      px[k] = lit ? hex(d < 0.3 ? '#fff6b0' : d < 0.55 ? '#ffb030' : d < 0.8 ? '#e03008' : '#400600')
        : hex(d < 0.28 ? '#ff4a1a' : d < 0.5 ? '#9a1204' : '#1c0302');
    } else if (c === 4) px[k] = hex(HORN[clamp(Math.round(val[k] * 3.2), 0, HORN.length - 1)]);
    else if (i > 0 && j > 0 && i < G - 1 && j < GH - 1) {
      for (const n of [k - 1, k + 1, k - G, k + G, k - G - 1, k - G + 1, k + G - 1, k + G + 1]) {
        if (code[n]) { px[k] = rgba(12, 4, 2); break; }
      }
    }
  }
  P.g.putImageData(P.img, 0, 0);
  return P.c;
}
const skulls = new Map();
function skull(H, frame) {
  const key = H * 2 + frame;
  let c = skulls.get(key);
  if (!c) skulls.set(key, c = buildSkull(H, frame === 1));
  return c;
}

// --------------------------------------------------------------- stone ----
// Dark mottled stone blocks (tileable) for the intermission and dialog panels.
let stoneTile = null;
function stone() {
  if (stoneTile) return stoneTile;
  const N = 128, P = pixCanvas(N, N), px = P.px;
  const grid = (n, seed) => { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = hash(i, seed); return a; };
  const g1 = grid(8, 3), g2 = grid(32, 11);
  const noise = (gr, n, x, y) => {
    const fx = x * n / N, fy = y * n / N, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (a, b) => gr[((b + n) % n) * n + ((a + n) % n)];
    const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx, bot = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return top + (bot - top) * ty;
  };
  const rowOff = [0, 22, 10, 36], widths = [44, 42, 42];
  for (let y = 0; y < N; y++) {
    const row = y >> 5, yy = y & 31;
    for (let x = 0; x < N; x++) {
      let xr = (x + rowOff[row]) % N, b = 0, bx = 0;
      while (xr >= widths[b] && b < 2) { xr -= widths[b]; b++; }
      bx = xr;
      const tint = hash(row * 7 + b, 91) * 0.22 - 0.11;
      let v = 0.55 * noise(g1, 8, x, y) + 0.35 * noise(g2, 32, x, y) + 0.2 * hash(x, y) + tint;
      if (yy < 2 || bx < 2) v = 0.05;                        // mortar
      else if (yy === 2 || bx === 2) v += 0.25;              // lit top / left edges
      else if (yy === 31 || bx === widths[b] - 1) v -= 0.3;   // shaded bottom / right edges
      v = clamp(v, 0, 1.2);
      px[y * N + x] = rgba(Math.round(24 + v * 44), Math.round(20 + v * 36), Math.round(18 + v * 30));
    }
  }
  P.g.putImageData(P.img, 0, 0);
  return (stoneTile = P.c);
}

// ---------------------------------------------------------------- menus ----
const act = (label, run) => ({ type: 'act', label, run });
const slider = (label, key, min, max, step, fmt) => ({ type: 'slider', label, key, min, max, step, fmt });
const toggle = (label, key) => ({ type: 'toggle', label, key });
const choice = (label, key, values) => ({ type: 'choice', label, key, values });
const pct = v => Math.round(v * 100) + '%';
const num = v => String(+v.toFixed(2));
const SKILLS = ["I'm too young to babysit", 'Hey, not too rowdy', 'Sugar rush', 'Ultra-Tantrum', 'Bedtime Nightmare!'];
const HELP = [
  ['KEYBOARD & MOUSE'],
  ['WASD / ARROWS', 'MOVE & TURN'],
  ['MOUSE', 'LOOK (CLICK TO CAPTURE)'],
  ['LEFT CLICK / CTRL', 'FIRE'],
  ['SPACE / E', 'USE, OPEN DOORS'],
  ['1 - 7', 'WEAPONS (1: FIST / CHAINSAW,'],
  ['', '3: SHOTGUN / SUPER SHOTGUN)'],
  ['MOUSE WHEEL', 'NEXT / PREVIOUS WEAPON'],
  ['SHIFT', 'RUN / WALK'],
  ['TAB', 'AUTOMAP (+ / - ZOOM)'],
  ['J / X', 'JUMP / CROUCH'],
  ['ESC', 'MENU'],
  ['TOUCH'],
  ['LEFT STICK', 'MOVE'],
  ['RIGHT STICK', 'LOOK'],
  ['BUTTONS', 'FIRE, USE, WEAPONS'],
];
const MENU_NAMES = ['title', 'main', 'pause', 'skill', 'options', 'help'];

// mapContainer (optional): where the automap canvas goes, e.g. a layer under the HUD's message line (Doom shows
// messages over the map); by default it sits in container, under the menus.
export function createScreens({ container, audio = null, getOptions = () => ({}), setOption = () => {}, onAction = () => {}, L = null,
  mapContainer = null } = {}) {
  const O = () => (getOptions && getOptions()) || {};
  const sfx = name => { try { if (audio && audio.play) audio.play(name); } catch (e) { /* audio is optional */ } };
  const unlock = () => { try { if (audio && audio.unlock) audio.unlock(); } catch (e) { /* ignore */ } };

  Object.assign(container.style, { position: 'fixed', left: '0', top: '0', width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none' });
  if (getComputedStyle(container).zIndex === 'auto') container.style.zIndex = '30';   // (a stylesheet's stacking wins)
  const mapCv = document.createElement('canvas'), cv = document.createElement('canvas');
  for (const c of [mapCv, cv]) Object.assign(c.style, { left: '0', top: '0', display: 'none', imageRendering: 'pixelated' });
  Object.assign(mapCv.style, { position: 'fixed', pointerEvents: 'none' });
  Object.assign(cv.style, { position: 'absolute', pointerEvents: 'auto', touchAction: 'none', userSelect: 'none' });
  (mapContainer || container).appendChild(mapCv);
  container.appendChild(cv);
  const g = cv.getContext('2d'), mg = mapCv.getContext('2d');

  // ------------------------------------------------------------ layout ----
  let winW = window.innerWidth, winH = window.innerHeight, viewH = winH;
  let u = 1, VW = DES_W, VH = DES_H, VVH = DES_H;   // device px per virtual px; virtual window / view size
  let mapImg = null, mapPx = null, backGrad = null, vignette = null, shade = null, lastDpr = 0;
  function layout() {
    const dpr = lastDpr = window.devicePixelRatio || 1;
    const dw = Math.max(1, Math.round(winW * dpr)), dh = Math.max(1, Math.round(winH * dpr)), dvh = Math.max(1, Math.round(viewH * dpr));
    // scale in whole or half steps: the art is mostly built of 2×2 blocks (320×200 doubled), which stay even at
    // 1.5× and 2.5× with nearest-neighbour upscaling, and a 900-px view then gets a 1.5× menu instead of 1×
    const s = Math.min(dvh / DES_H, dw / DES_W);
    if (s >= 1) u = Math.floor(s * 2) / 2;
    else u = s;   // very small screens: shrink (smoothly) rather than crop
    VW = Math.ceil(dw / u); VH = Math.ceil(dh / u); VVH = Math.min(VH, Math.floor(dvh / u));
    cv.width = VW; cv.height = VH;
    cv.style.width = VW * u / dpr + 'px'; cv.style.height = VH * u / dpr + 'px';
    cv.style.imageRendering = u >= 1 ? 'pixelated' : 'auto';
    g.imageSmoothingEnabled = false;
    // map pixel size from the smaller side (4:3 terms), so a portrait phone gets a finer map, not 150 px across
    const um = Math.max(1, Math.round(Math.min(dvh, dw * 0.75) / MAP_ROWS));
    mapCv.width = Math.ceil(dw / um); mapCv.height = Math.ceil(dvh / um);
    mapCv.style.width = mapCv.width * um / dpr + 'px'; mapCv.style.height = mapCv.height * um / dpr + 'px';
    mapImg = mg.createImageData(mapCv.width, mapCv.height); mapPx = new Uint32Array(mapImg.data.buffer);
    backGrad = g.createRadialGradient(VW / 2, VH * 0.3, 8, VW / 2, VH * 0.3, Math.max(VW, VH) * 0.75);
    backGrad.addColorStop(0, 'rgba(110,22,4,0.32)'); backGrad.addColorStop(1, 'rgba(0,0,0,0)');
    vignette = g.createRadialGradient(VW / 2, VH / 2, Math.min(VW, VH) * 0.3, VW / 2, VH / 2, Math.hypot(VW, VH) * 0.6);
    vignette.addColorStop(0, 'rgba(0,0,0,0)'); vignette.addColorStop(1, 'rgba(0,0,0,0.7)');
    // in-game menus: the view is dimmed, and darker still behind the menu block so red lettering reads over a
    // bright room
    shade = g.createRadialGradient(VW / 2, VVH / 2, DES_H * 0.3, VW / 2, VVH / 2, Math.max(DES_W * 0.62, Math.hypot(VW, VVH) * 0.5));
    shade.addColorStop(0, 'rgba(0,0,0,0.42)'); shade.addColorStop(1, 'rgba(0,0,0,0)');
    redraw();
    if (AM.visible && AM.last) drawMap(AM.last);
  }

  // ------------------------------------------------------------- state ----
  let menuOpen = false, cur = { name: 'title', cursor: 0 }, stack = [], confirm = null, loading = null;
  let inter = null, tics = 0, acc = 0, skullFrame = 0, lastSkill = 3, drag = null, press = null;
  const hits = []; let nHits = 0;
  function hit(kind, i, x, y, w, h, a = 0, b = 0) {
    const o = hits[nHits] || (hits[nHits] = {});
    o.kind = kind; o.i = i; o.x = x; o.y = y; o.w = w; o.h = h; o.a = a; o.b = b; nHits++;
  }
  function hitAt(x, y) {
    for (let n = nHits - 1; n >= 0; n--) { const o = hits[n]; if (x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) return o; }
    return null;
  }
  const show = () => { cv.style.display = 'block'; };
  const hideIfIdle = () => { if (!menuOpen && !inter) { cv.style.display = 'none'; cv.style.cursor = 'default'; } };

  // --------------------------------------------------------- menu data ----
  const resume = () => { closeMenu(); onAction('resume'); };
  const MAIN = [act('New Game', () => push('skill')), act('Options', () => push('options')), act('Read This!', () => push('help'))];
  const MAIN_IN = [...MAIN, act('Resume Game', resume)];
  const PAUSE = [
    act('Resume', resume),
    act('Options', () => push('options')),
    act('Read This!', () => push('help')),
    act('Restart Level', () => ask(['RESTART THIS LEVEL FROM', 'THE BEGINNING?', '', 'PRESS Y OR N.'], () => { closeMenu(); onAction('restart'); })),
    act('Quit to Title', () => ask(['QUIT TO THE TITLE SCREEN?', 'THE GAME IN PROGRESS IS LOST.', '', 'PRESS Y OR N.'], () => {
      closeMenu(); onAction('quitToTitle');
      if (!menuOpen) openMenu('title');
    })),
  ];
  const startGame = skill => { lastSkill = skill; closeMenu(); onAction('newGame', skill); };
  const SKILL = SKILLS.map((label, i) => act(label, () => {
    if (i === 4) ask(['ARE YOU SURE? THIS SKILL LEVEL', "ISN'T EVEN REMOTELY FAIR.", '', 'PRESS Y OR N.'], () => startGame(5));
    else startGame(i + 1);
  }));
  const OPTIONS = [
    slider('Mouse sensitivity', 'sens', 0.25, 3, 0.25, v => v.toFixed(2)),
    slider('Music volume', 'music', 0, 1, 0.05, pct),
    slider('Sound volume', 'sfx', 0, 1, 0.05, pct),
    slider('Brightness', 'brightness', -2, 2, 0.25, v => (v > 0 ? '+' : '') + num(v)),
    slider('Field of view', 'fov', 60, 110, 5, v => String(Math.round(v))),
    slider('Bloom', 'bloom', 0, 1, 0.05, pct),
    slider('House lights', 'lights', 0, 1.5, 0.1, pct),
    choice('Time of day', 'tod', ['day', 'dusk', 'night']),
    toggle('Always run', 'alwaysRun'),
    toggle('Autoaim', 'autoaim'),
    toggle('View bob', 'viewBob'),
    toggle('Retro pixels', 'retro'),
    toggle('Messages', 'messages'),
  ];
  function items() {
    switch (cur.name) {
      case 'title': return loading ? [] : (O().inGame ? MAIN_IN : MAIN);
      case 'main': return O().inGame ? MAIN_IN : MAIN;
      case 'pause': return PAUSE;
      case 'skill': return SKILL;
      case 'options': return OPTIONS;
      default: return [];
    }
  }
  function defaultCursor(name) {
    if (name === 'skill') return lastSkill - 1;
    if ((name === 'title' || name === 'main') && O().inGame) return MAIN_IN.length - 1;
    return 0;
  }

  // ------------------------------------------------------- navigation ----
  function openMenu(name) {
    if (!MENU_NAMES.includes(name)) { console.warn('screens: unknown menu', name); return; }
    if (name === 'pause' && !menuOpen) sfx('menuSelect');   // (not when a sub-menu backs out into it: that clicked already)
    endDrag();
    menuOpen = true; stack = []; confirm = null;
    cur = { name, cursor: defaultCursor(name) };
    show(); redraw();
  }
  function closeMenu() {
    endDrag();
    menuOpen = false; stack = []; confirm = null;
    hideIfIdle();
    if (inter) redraw();
  }
  function push(name) { endDrag(); stack.push(cur); cur = { name, cursor: defaultCursor(name) }; redraw(); }
  function back() {
    if (confirm) { answer(false); return; }
    endDrag();
    if (stack.length) { cur = stack.pop(); sfx('menuBack'); redraw(); return; }
    const inGame = !!O().inGame;
    if (cur.name === 'pause' || ((cur.name === 'title' || cur.name === 'main') && inGame)) { sfx('menuBack'); resume(); return; }
    if (cur.name === 'title' || cur.name === 'main') return;   // nothing to go back to
    sfx('menuBack');
    openMenu(inGame ? 'pause' : 'title');   // a sub-menu opened directly by the game
  }
  function ask(lines, yes) { confirm = { lines, yes, sel: 1 }; redraw(); }
  function answer(yes) {
    const c = confirm; confirm = null;
    sfx(yes ? 'menuSelect' : 'menuBack');
    if (yes && c) c.yes(); else redraw();
  }
  function move(d) {
    const list = items(), n = list.length;
    if (!n) return;
    cur.cursor = (cur.cursor + d + n) % n;
    sfx('menuMove'); redraw();
  }
  function setCursor(i, sound) {
    if (i === cur.cursor) return;
    cur.cursor = i; if (sound) sfx('menuMove'); redraw();
  }
  function optValue(it) {
    const v = O()[it.key];
    if (it.type === 'slider') { const n = Number(v); return isFinite(n) ? clamp(n, it.min, it.max) : it.min; }
    if (it.type === 'choice') return it.values.includes(v) ? v : it.values[0];
    return !!v;
  }
  // setOption's third argument says whether the value is final: false while a slider is being dragged (a last
  // call with true follows on release), so the game can defer expensive work such as relighting the house
  function setSliderIndex(it, i, done = true) {
    const n = Math.round((it.max - it.min) / it.step);
    const nv = +(it.min + clamp(i, 0, n) * it.step).toFixed(4);
    if (nv === optValue(it)) return false;
    setOption(it.key, nv, done); sfx('menuSlider'); redraw();
    return true;
  }
  function adjust(d) {
    const it = items()[cur.cursor];
    if (!it) return;
    if (it.type === 'slider') setSliderIndex(it, Math.round((optValue(it) - it.min) / it.step) + d);
    else if (it.type === 'toggle') { setOption(it.key, !optValue(it), true); sfx('menuSlider'); redraw(); }
    else if (it.type === 'choice') {
      const vs = it.values, i = vs.indexOf(optValue(it));
      setOption(it.key, vs[(i + d + vs.length) % vs.length], true); sfx('menuSlider'); redraw();
    }
  }
  function activate() {
    if (cur.name === 'help') { back(); return; }
    const it = items()[cur.cursor];
    if (!it) return;
    if (it.type === 'act') { sfx('menuSelect'); it.run(); }
    else if (it.type !== 'slider') adjust(1);
  }

  // ------------------------------------------------------------ input ----
  const MODS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'ContextMenu', 'OS'];
  function handleKey(e) {
    if (!menuOpen && !inter) return false;
    // modifiers, Ctrl / Alt / Meta shortcuts and F-keys are the browser's: not consumed (false), so the caller
    // doesn't preventDefault them (it still shouldn't treat them as game input while a menu is up)
    if (MODS.includes(e.key) || e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) return false;
    unlock();
    e.preventDefault();
    if (menuOpen) menuKey(e); else interPress(e.code === 'Space' || e.key === 'Enter' || e.code === 'KeyE', e.repeat);
    return true;
  }
  function menuKey(e) {
    const k = e.key, c = e.code;
    if (confirm) {
      if (e.repeat) return;
      // Y / N by the letter typed (Y sits elsewhere on QWERTZ / Dvorak); by position on non-Latin layouts
      const ch = k && k.length === 1 ? k.toLowerCase() : '', latin = ch >= 'a' && ch <= 'z';
      if (latin ? ch === 'y' : c === 'KeyY') answer(true);
      else if ((latin ? ch === 'n' : c === 'KeyN') || k === 'Escape' || k === 'Backspace') answer(false);
      else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown' || c === 'KeyA' || c === 'KeyD') {
        confirm.sel ^= 1; sfx('menuMove'); redraw();
      } else if (k === 'Enter' || c === 'Space') answer(confirm.sel === 0);
      return;
    }
    if (k === 'Escape') { if (!e.repeat) back(); return; }
    if (k === 'Backspace') { if (!e.repeat && (stack.length || !['title', 'main', 'pause'].includes(cur.name))) back(); return; }
    if (cur.name === 'help') { if (!e.repeat && (k === 'Enter' || c === 'Space')) back(); return; }
    if (k === 'ArrowUp' || c === 'KeyW') move(-1);
    else if (k === 'ArrowDown' || c === 'KeyS') move(1);
    else if (k === 'ArrowLeft' || c === 'KeyA') adjust(-1);
    else if (k === 'ArrowRight' || c === 'KeyD') adjust(1);
    else if (k === 'Home') setCursor(0, true);
    else if (k === 'End') setCursor(Math.max(0, items().length - 1), true);
    else if ((k === 'Enter' || c === 'Space') && !e.repeat) activate();
  }
  function toVirt(e) {
    const r = cv.getBoundingClientRect();
    return [(e.clientX - r.left) * cv.width / r.width, (e.clientY - r.top) * cv.height / r.height];
  }
  function dragTo(d, x) {   // d: { i, a: bar start, b: bar length } in virtual px
    const it = items()[d.i];
    if (!it || it.type !== 'slider') return;
    const n = Math.round((it.max - it.min) / it.step);
    if (setSliderIndex(it, Math.round(clamp((x - d.a) / d.b, 0, 1) * n), false)) d.dirty = true;
  }
  function endDrag() {
    const d = drag, it = d && items()[d.i];
    drag = null;
    if (d && d.dirty && it && it.type === 'slider') setOption(it.key, optValue(it), true);
  }
  cv.addEventListener('pointerdown', e => {
    unlock();
    if (drag && e.pointerId === drag.id) endDrag();   // (its release was missed)
    if (e.button > 0 || drag) return;   // (a second finger while a slider is held is ignored)
    const [x, y] = toVirt(e);
    if (!menuOpen) { if (inter) interPress(true, false); return; }
    e.preventDefault();
    const h = hitAt(x, y);   // (hit records are pooled and rewritten on every redraw: copy what is kept)
    press = h ? { kind: h.kind, i: h.i } : null;
    if (!h) return;
    if (h.kind === 'item' || h.kind === 'bar') setCursor(h.i, e.pointerType === 'mouse');
    if (h.kind === 'bar') {
      drag = { id: e.pointerId, i: h.i, a: h.a, b: h.b, dirty: false };
      try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      dragTo(drag, x);
    }
    if (confirm && (h.kind === 'yes' || h.kind === 'no')) { confirm.sel = h.kind === 'yes' ? 0 : 1; redraw(); }
  });
  cv.addEventListener('pointermove', e => {
    if (!menuOpen) return;
    const [x, y] = toVirt(e);
    if (drag) { if (e.pointerId === drag.id) dragTo(drag, x); return; }
    if (e.pointerType !== 'mouse') return;
    const h = hitAt(x, y);
    cv.style.cursor = h && h.kind !== 'any' ? 'pointer' : 'default';
    if (!h) return;
    if (confirm && (h.kind === 'yes' || h.kind === 'no')) {
      const sel = h.kind === 'yes' ? 0 : 1;
      if (sel !== confirm.sel) { confirm.sel = sel; sfx('menuMove'); redraw(); }
    } else if (!confirm && (h.kind === 'item' || h.kind === 'bar')) setCursor(h.i, true);
  });
  const endPress = e => {
    if (drag) { if (e.pointerId === drag.id) { endDrag(); press = null; } return; }
    if (!menuOpen || !press || e.type === 'pointercancel') { press = null; return; }
    const [x, y] = toVirt(e), h = hitAt(x, y), p = press;
    press = null;
    if (!h || h.kind !== p.kind || h.i !== p.i) return;
    if (h.kind === 'yes' || h.kind === 'no') answer(h.kind === 'yes');
    else if (h.kind === 'back' || h.kind === 'any') back();
    else if (h.kind === 'item') { setCursor(h.i, false); activate(); }
  };
  cv.addEventListener('pointerup', endPress);
  cv.addEventListener('pointercancel', endPress);
  cv.addEventListener('lostpointercapture', e => { if (drag && e.pointerId === drag.id) { endDrag(); press = null; } });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  // the wheel over a slider steps it: one step per notch; a touchpad's stream of small deltas is summed so it
  // steps once per ~50 px rather than once per event
  let wheelAcc = 0, wheelT = 0;
  cv.addEventListener('wheel', e => {
    e.preventDefault();
    if (!menuOpen || confirm || !e.deltaY) return;
    const [x, y] = toVirt(e), h = hitAt(x, y);
    if (!h || (h.kind !== 'item' && h.kind !== 'bar') || !items()[h.i] || items()[h.i].type !== 'slider') return;
    const now = performance.now(), fresh = now - wheelT > 250;
    wheelT = now;
    wheelAcc = (fresh ? 0 : wheelAcc) + e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1);
    if (!fresh && Math.abs(wheelAcc) < 50) return;
    const d = wheelAcc < 0 ? 1 : -1;
    wheelAcc = 0;
    setCursor(h.i, false); adjust(d);
  }, { passive: false });

  // ------------------------------------------------------------ drawing ----
  const logos = {};
  const getLogo = c => logos[c] || (logos[c] = buildLogo(c));
  function redraw() {
    if (inter) drawInter();   // (a menu opened over the tally is drawn on top of it)
    if (menuOpen) drawMenu();
  }
  function blit(c, x, y, k = 1) { g.drawImage(c, Math.round(x), Math.round(y), c.width * k, c.height * k); }
  const centre = (c, y, k = 1) => blit(c, (VW - (c.width - 1) * k) / 2, y, k);
  function drawSkull(rightX, cy, H) {
    const c = skull(H, skullFrame);
    blit(c, rightX - c.width, cy - c.height / 2);
  }
  let stonePat = null;
  const stoneFill = () => stonePat || (stonePat = g.createPattern(stone(), 'repeat'));
  function panel(x, y, w, h) {
    g.fillStyle = stoneFill(); g.fillRect(x, y, w, h);
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x, y, w, h);
    g.fillStyle = '#000'; g.fillRect(x - 1, y - 1, w + 2, 1); g.fillRect(x - 1, y + h, w + 2, 1); g.fillRect(x - 1, y, 1, h); g.fillRect(x + w, y, 1, h);
    g.fillStyle = '#7a6a60'; g.fillRect(x, y, w, 2); g.fillRect(x, y, 2, h);
    g.fillStyle = '#2a201c'; g.fillRect(x, y + h - 2, w, 2); g.fillRect(x + w - 2, y, 2, h);
    g.fillStyle = '#5a1008'; g.fillRect(x + 4, y + 4, w - 8, 1); g.fillRect(x + 4, y + h - 5, w - 8, 1);
  }
  function drawMenu() {
    const inGame = !!O().inGame;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (!inter) g.clearRect(0, 0, VW, VH);
    nHits = 0;
    const aH = inGame ? VVH : VH;
    if (inGame || inter) {   // dim the view (not the status bar), darkest behind the menu
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, 0, VW, aH);
      g.fillStyle = shade; g.fillRect(0, 0, VW, aH);
    } else {   // title backdrop: opaque while loading, see-through once a scene can run behind it
      g.fillStyle = loading ? '#070302' : 'rgba(7,3,2,0.8)'; g.fillRect(0, 0, VW, VH);
      g.fillStyle = backGrad; g.fillRect(0, 0, VW, VH);
    }
    const n = cur.name;
    if (n === 'title' || n === 'main') drawMain(aH, n === 'title');
    else if (n === 'pause') drawList(aH, 'PAUSED', null, PAUSE, 4, 37);
    else if (n === 'skill') drawList(aH, 'NEW GAME', 'CHOOSE SKILL LEVEL:', SKILL, 3, 31);
    else if (n === 'options') drawOptions(aH);
    else if (n === 'help') drawHelp(aH);
    if (stack.length || !['title', 'main', 'pause'].includes(n)) {
      const c = small('< BACK', 'dim');
      blit(c, 10, 8, 2);
      hit('back', -1, 4, 2, c.width * 2 + 12, 26);
    }
    if (confirm) drawConfirm(aH);
  }
  function drawItems(list, x, y, pitch, k) {
    const th = 7 * k + 2;
    for (let i = 0; i < list.length; i++) {
      const c = big(list[i].label, k, 'red'), yy = y + i * pitch;
      blit(c, x, yy);
      hit('item', i, x - 44, yy - ((pitch - th) >> 1), c.width + 56, pitch);
    }
    if (!confirm && list.length) drawSkull(x - 8, y + clamp(cur.cursor, 0, list.length - 1) * pitch + th / 2, k >= 4 ? 34 : 26);
  }
  function listWidth(list, k) { let w = 0; for (const it of list) w = Math.max(w, big(it.label, k).width); return w; }
  function drawMain(aH, title) {
    const lg = getLogo(title ? 6 : 4), list = items();
    const sub = small('A HOUSE FULL OF IMPS', 'gold');
    const body = title && loading ? 40 : list.length * 37;
    const h = lg.up * 0.6 + lg.H + (title ? 44 : 26) + body;
    let y = Math.max(4 + lg.up * 0.6, Math.round((aH - h) / 2 + lg.up * 0.6));
    const lx = Math.round((VW - lg.W) / 2);
    blit(lg.fire.c, lx, y - lg.up, lg.FS);
    blit(lg.c, lx, y);
    y += lg.H + 8;
    if (title) { centre(sub, y, 2); y += 36; } else y += 18;
    if (title && loading) {
      const c = small(String(loading), 'white');
      centre(c, y + 8, 2);
      return;
    }
    const x = Math.round((VW - listWidth(list, 4)) / 2) + 20;
    drawItems(list, x, y, 37, 4);
  }
  function drawList(aH, header, sub, list, k, pitch) {
    const hc = big(header, 4, 'fire'), sc = sub ? big(sub, 2, 'red') : null;
    const h = hc.height + 14 + (sc ? sc.height + 14 : 0) + list.length * pitch;
    let y = Math.max(30, Math.round((aH - h) / 2));
    centre(hc, y); y += hc.height + 14;
    if (sc) { centre(sc, y); y += sc.height + 14; }
    drawItems(list, Math.round((VW - listWidth(list, k)) / 2) + 18, y, pitch, k);
  }
  function drawThermo(x, y, w, frac, steps) {
    // a thermometer: bevelled glass tube with a red bulb, graduations, mercury and a steel slider cap
    const inner = w - 6, mw = Math.round(clamp(frac, 0, 1) * inner);
    g.fillStyle = '#000'; g.fillRect(x, y, w, 12);
    g.fillStyle = '#6e645c'; g.fillRect(x + 1, y + 1, w - 2, 10);
    g.fillStyle = '#a89e94'; g.fillRect(x + 1, y + 1, w - 2, 1);
    g.fillStyle = '#3a322c'; g.fillRect(x + 1, y + 10, w - 2, 1);
    g.fillStyle = '#100a08'; g.fillRect(x + 3, y + 3, inner, 6);
    g.fillStyle = '#4a3c34';
    if (inner / steps >= 3) for (let i = 1; i < steps; i++) {
      const tx = x + 3 + Math.round(i * inner / steps);
      g.fillRect(tx, y + 3, 1, 2); g.fillRect(tx, y + 7, 1, 2);
    }
    const merc = ['#ff8a6a', '#f03a1c', '#c01c08', '#7e0c02'];
    for (let r = 0; r < 4; r++) { g.fillStyle = merc[r]; g.fillRect(x + 1, y + 4 + r, mw + 2, 1); }
    // bulb
    const bx = x - 3, by = y + 6, R = 8;
    for (let yy = -R - 1; yy <= R + 1; yy++) for (let xx = -R - 1; xx <= R + 1; xx++) {
      const d = Math.hypot(xx + 0.5, yy + 0.5);
      if (d > R + 1) continue;
      g.fillStyle = d > R ? '#000' : d > R - 1.6 ? (yy < 0 ? '#a89e94' : '#4a4038') : (xx + yy < -5 && d < 4.5 ? '#ffb89c' : yy > 3 ? '#9a1406' : '#e0321a');
      g.fillRect(bx + xx, by + yy, 1, 1);
    }
    // slider cap
    const kx = x + 3 + mw - 3;
    g.fillStyle = '#000'; g.fillRect(kx - 1, y - 4, 8, 20);
    g.fillStyle = '#c8c0b4'; g.fillRect(kx, y - 3, 6, 18);
    g.fillStyle = '#f4efe6'; g.fillRect(kx, y - 3, 6, 1); g.fillRect(kx, y - 3, 1, 18);
    g.fillStyle = '#5a524a'; g.fillRect(kx, y + 14, 6, 1); g.fillRect(kx + 5, y - 2, 1, 17);
    g.fillStyle = '#b01808'; g.fillRect(kx + 2, y + 1, 2, 10);
  }
  function drawOptions(aH) {
    const hc = big('OPTIONS', 4, 'fire'), k = 3, n = OPTIONS.length;
    const pitch = clamp(Math.floor((aH - hc.height - 40) / n), 23, 28);
    let y = Math.max(28, Math.round((aH - (hc.height + 12 + n * pitch)) / 2));
    centre(hc, y); y += hc.height + 12;
    const lw = listWidth(OPTIONS, k), TW = 150;
    const x = Math.round((VW - (lw + 30 + TW + 60)) / 2) + 18, cx = x + lw + 30;
    const th = 7 * k + 2;
    for (let i = 0; i < n; i++) {
      const it = OPTIONS[i], yy = y + i * pitch;
      blit(big(it.label, k, 'red'), x, yy);
      hit('item', i, x - 36, yy - ((pitch - th) >> 1), cx - x + TW + 110, pitch);
      if (it.type === 'slider') {
        const v = optValue(it), steps = Math.round((it.max - it.min) / it.step);
        drawThermo(cx, yy + 5, TW, (v - it.min) / (it.max - it.min), steps);
        blit(small(it.fmt(v), 'gold'), cx + TW + 10, yy + 4, 2);
        hit('bar', i, cx - 12, yy - 2, TW + 18, th + 4, cx + 3, TW - 6);
      } else {
        const v = it.type === 'toggle' ? (optValue(it) ? 'ON' : 'OFF') : optValue(it);
        blit(big(v, k, 'gold'), cx, yy);
      }
    }
    if (!confirm) drawSkull(x - 8, y + cur.cursor * pitch + th / 2, 26);
  }
  function drawHelp(aH) {
    hit('any', -1, 0, 0, VW, aH);
    // a controls card: section heads in red, keys in gold right-aligned against the white actions
    const hc = big('READ THIS!', 4, 'fire'), lh = 19, gap = 7, pad = 20, gut = 22;
    let kw = 0, aw = 0, heads = 0;
    for (const r of HELP) {
      if (r.length > 1) { kw = Math.max(kw, textWidth(r[0]) * 2); aw = Math.max(aw, textWidth(r[1]) * 2); } else heads++;
    }
    const pw = kw + gut + aw + pad * 2, ph = HELP.length * lh + (heads - 1) * gap + 28;
    let y = Math.max(8, Math.round((aH - (hc.height + 10 + ph)) / 2));
    centre(hc, y); y += hc.height + 10;
    const px = Math.round((VW - pw) / 2);
    panel(px, y, pw, ph);
    let yy = y + 15;
    HELP.forEach((r, i) => {
      if (r.length === 1) { if (i) yy += gap; blit(small(r[0], 'red'), px + pad, yy, 2); }
      else {
        if (r[0]) blit(small(r[0], 'gold'), px + pad + kw - textWidth(r[0]) * 2, yy, 2);
        blit(small(r[1], 'white'), px + pad + kw + gut, yy, 2);
      }
      yy += lh;
    });
  }
  function drawConfirm(aH) {
    nHits = 0;   // only the dialog is clickable
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(0, 0, VW, aH);
    const lines = confirm.lines, lh = 18;
    let w = 0; for (const s of lines) w = Math.max(w, textWidth(s) * 2);
    const yes = big('YES', 3, 'red'), no = big('NO', 3, 'red');
    const bw = Math.max(w, 240) + 64, bh = 22 + lines.length * lh + 12 + yes.height + 20;
    const bx = Math.round((VW - bw) / 2), by = Math.round((aH - bh) / 2);
    panel(bx, by, bw, bh);
    let y = by + 22;
    for (const s of lines) { if (s) centre(small(s, 'red'), y, 2); y += lh; }
    y += 12;
    const yx = Math.round(VW / 2 - 60 - yes.width / 2), nx = Math.round(VW / 2 + 60 - no.width / 2);
    blit(yes, yx, y); blit(no, nx, y);
    hit('yes', 0, yx - 34, y - 6, yes.width + 44, yes.height + 12);
    hit('no', 1, nx - 34, y - 6, no.width + 44, no.height + 12);
    drawSkull((confirm.sel === 0 ? yx : nx) - 6, y + yes.height / 2 - 1, 26);
  }

  // ------------------------------------------------------ intermission ----
  // (a NaN / Infinity in the stats would otherwise stall the count: it never reaches its target)
  const fin = v => (v != null && Number.isFinite(+v) ? +v : NaN);
  const TALLY = ['KILLS', 'ITEMS', 'SECRET'];
  const pctOf = (n, t) => (fin(t) > 0 ? Math.floor(Math.max(0, fin(n) || 0) * 100 / fin(t)) : 100);
  function intermission(stats, onDone) {
    if (menuOpen) closeMenu();
    const s = stats || {}, par = fin(s.par);
    inter = {
      s, onDone, name: plain(s.levelName || 'Ocean Lane'), st: 0, wait: 10, tics: 0, bcnt: 0, cnt: [-1, -1, -1], time: -1, par: -1,
      tgt: [pctOf(s.kills, s.killsTotal), pctOf(s.items, s.itemsTotal), pctOf(s.secrets, s.secretsTotal)],
      tTime: Math.max(0, Math.floor(fin(s.time) || 0)), tPar: Number.isNaN(par) ? -1 : Math.max(0, Math.floor(par)),
    };
    show(); redraw();
  }
  function interTic() {
    const I = inter;
    I.tics++;
    if (I.wait > 0) { I.wait--; return; }
    I.bcnt++;
    if (I.st === 0 || I.st === 2 || I.st === 4) {   // count a percentage up, 2 per tic
      const k = I.st >> 1;
      I.cnt[k] = Math.max(0, I.cnt[k]) + 2;
      if (!(I.bcnt & 3)) sfx('tally');
      if (I.cnt[k] >= I.tgt[k]) { I.cnt[k] = I.tgt[k]; sfx('tallyDone'); I.st++; I.pause = TICRATE; }
    } else if (I.st === 1 || I.st === 3 || I.st === 5) {
      if (--I.pause <= 0) I.st++;
    } else if (I.st === 6) {   // time and par together, at least 3 s per tic, never longer than ~3 s in total
      const step = Math.max(3, Math.ceil(Math.max(I.tTime, I.tPar) / 105));
      I.time = Math.min(I.tTime, Math.max(0, I.time) + step);
      if (I.tPar >= 0) I.par = Math.min(I.tPar, Math.max(0, I.par) + step);
      if (!(I.bcnt & 3)) sfx('tally');
      if (I.time >= I.tTime && (I.tPar < 0 || I.par >= I.tPar)) { sfx('tallyDone'); I.st = 7; I.tics = 0; }
    }
  }
  function interPress(isContinue, repeat) {
    const I = inter;
    if (!I || repeat || (I.st < 7 && I.tics < 12)) return;
    if (I.st < 7) {   // skip the count
      I.cnt = I.tgt.slice(); I.time = I.tTime; I.par = I.tPar; I.st = 7; I.tics = 0;
      sfx('tallyDone'); redraw();
    } else if (isContinue && I.tics >= 6) {
      const done = I.onDone;
      inter = null; sfx('menuSelect');
      hideIfIdle();
      if (menuOpen) redraw();
      if (done) done();
    }
  }
  function bigNum(str, rightX, y) {   // status-bar numerals at 2×
    g.setTransform(2, 0, 0, 2, 0, 0);
    drawBig(g, str, rightX >> 1, y >> 1);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  function bigTime(sec, rightX, y) {
    const m = Math.floor(sec / 60), s = sec % 60;
    const rx = rightX >> 1, yy = y >> 1;
    g.setTransform(2, 0, 0, 2, 0, 0);
    drawBig(g, String(s).padStart(2, '0'), rx, yy);
    const cx = rx - 2 * BIG_W - 6;
    for (const r of [4, 10]) for (let d = 0; d < 3; d++) {   // colon in the numerals' red ramp
      g.fillStyle = 'rgba(10,0,0,0.85)'; g.fillRect(cx + 2, yy + r + d + 1, 3, 1);
      g.fillStyle = RAMPS.bigRed[r + d]; g.fillRect(cx + 1, yy + r + d, 3, 1);
    }
    drawBig(g, String(m).padStart(2, '0'), cx, yy);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  function drawInter() {
    const I = inter, name = I.name;
    g.setTransform(1, 0, 0, 1, 0, 0);
    nHits = 0;
    g.fillStyle = stoneFill(); g.fillRect(0, 0, VW, VH);
    g.fillStyle = vignette; g.fillRect(0, 0, VW, VH);
    const tk = clamp(Math.floor((VW - 40) / (name.length * 6)), 2, 5);   // the level name as big as fits
    const tc = big(name, tk, 'red'), fc = big('FINISHED', 4, 'red');
    const rows = I.tPar >= 0 ? 5 : 4, pitch = 44;
    const h = tc.height + 8 + fc.height + 30 + rows * pitch + 16 + 44;
    let y = Math.max(10, Math.round((VH - h) / 2));
    centre(tc, y); y += tc.height + 8;
    centre(fc, y); y += fc.height + 30;
    const lx = Math.round(VW / 2 - 210), rx = Math.round(VW / 2 + 210) & ~1;
    for (let i = 0; i < 3; i++) {
      blit(big(TALLY[i], 4, 'red'), lx, y + 1);
      if (I.cnt[i] >= 0) bigNum(I.cnt[i] + '%', rx, y & ~1);
      y += pitch;
    }
    y += 16;
    blit(big('TIME', 4, 'red'), lx, y + 1);
    if (I.time >= 0) bigTime(I.time, rx, y & ~1);
    if (I.tPar >= 0) {
      y += pitch;
      blit(big('PAR', 4, 'red'), lx, y + 1);
      if (I.par >= 0) bigTime(I.par, rx, y & ~1);
    }
    y += pitch + 6;
    if (I.st === 7 && ((I.tics >> 4) & 1) === 0) centre(small('PRESS SPACE TO CONTINUE', 'gold'), y, 2);
  }

  // ---------------------------------------------------------- automap ----
  const AM = { visible: false, ft: AUTOMAP.ft, last: null };
  const C = { bg: rgba(0, 0, 0), wall: rgba(236, 36, 24), wallDim: rgba(118, 24, 16), door: rgba(255, 222, 60),
    stair: rgba(176, 118, 60), ledge: rgba(140, 92, 48), player: rgba(255, 255, 255), imp: rgba(255, 70, 50),
    impDim: rgba(120, 30, 22), dead: rgba(110, 36, 24), item: rgba(255, 236, 90), itemDim: rgba(120, 110, 44) };
  const PASSES = [C.wallDim, C.wall];   // the neighbouring storeys first, this level's walls over them
  // Map geometry, prepared once: the axis-aligned walls with their door / open-plan openings, and the other solid
  // edges as plain segments with a height range: the bow window's facets (its wall only has a plain opening
  // there), the full-height parts of the knee walls beside stairs and the closed-off masses inside the house.
  // Each also keeps the heights of the walkable surfaces found beside it (surf), for the level filter.
  const hasFloors = !!(L && L.FLOORS);
  const surfSet = new Set();
  function surfacesBeside(x0, z0, x1, z1) {   // sampled every ~1.5 ft, 0.6 ft out on both sides
    if (!hasFloors) return null;
    surfSet.clear(); surfSet.add(0);   // the ground: lower-level floors, the drive and the yard
    const len = Math.hypot(x1 - x0, z1 - z0) || 1, nx = -(z1 - z0) / len * 0.6, nz = (x1 - x0) / len * 0.6;
    const n = Math.max(2, Math.ceil(len / 1.5));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      for (let sd = -1; sd <= 1; sd += 2) {
        const px = x + nx * sd, pz = z + nz * sd, inR = r => px > r[0] && px < r[1] && pz > r[2] && pz < r[3];
        for (const f of L.FLOORS) if (inR(f.r)) surfSet.add(f.h);
        if (L.FLIGHTS) for (const f of L.FLIGHTS) {
          if (inR(f.r)) surfSet.add(Math.round((f.h0 + (f.h1 - f.h0) * (pz - f.r[2]) / (f.r[3] - f.r[2])) * 20) / 20);
        }
      }
    }
    return Float32Array.from(surfSet);
  }
  const walls = [], segs = [];
  const seg = (x0, z0, x1, z1, y0, y1) => segs.push({ x0, z0, x1, z1, y0, y1, surf: surfacesBeside(x0, z0, x1, z1) });
  if (L && L.WALLS) for (const w of L.WALLS) {
    const alongX = Math.abs(w.x1 - w.x0) >= Math.abs(w.z1 - w.z0);
    const a0 = alongX ? Math.min(w.x0, w.x1) : Math.min(w.z0, w.z1), a1 = alongX ? Math.max(w.x0, w.x1) : Math.max(w.z0, w.z1);
    // (the patio slider is a 'window' in the layout, but you walk through it like a door)
    const ops = (w.ops || []).filter(o => o.kind === 'door' || o.kind === 'open' || o.slider)
      .map(o => ({ a0: Math.max(a0, Math.min(o.a0, o.a1)), a1: Math.min(a1, Math.max(o.a0, o.a1)), b0: o.b0, b1: o.b1 }))
      .filter(o => o.a1 > o.a0).sort((p, q) => p.a0 - q.a0);
    walls.push({ alongX, c: alongX ? w.z0 : w.x0, a0, a1, y0: w.y[0], y1: w.y[1], ops, surf: surfacesBeside(w.x0, w.z0, w.x1, w.z1) });
  }
  if (L && L.BOW) {   // five facets on an arc bulging out past the wall line (as house.js builds them)
    const { x0, x1, z, sag, n } = L.BOW, half = (x1 - x0) / 2, R = (half * half + sag * sag) / (2 * sag);
    const ox = (x0 + x1) / 2, oz = z + sag - R, span = Math.asin(half / R), top = L.MAIN_CEIL || L.BOW.ceil;
    const at = k => { const a = -span + 2 * span * k / n; return [ox + R * Math.sin(a), oz + R * Math.cos(a)]; };
    for (let k = 0; k < n; k++) { const p = at(k), q = at(k + 1); seg(p[0], p[1], q[0], q[1], L.BOW.base, top); }
  }
  if (L && L.KNEEWALLS && L.FLIGHTS) for (const k of L.KNEEWALLS) {
    const f = L.FLIGHTS.find(fl => fl.id === k.flight), z1 = k.hole ? Math.min(k.z1, k.hole.z0) : k.z1;
    if (f && z1 > k.z0) seg(k.x, k.z0, k.x, z1, 0, Math.max(f.h0, f.h1));
  }
  if (L && L.SOLIDS) for (const s of L.SOLIDS) {
    if (s.ext) continue;   // (the stoop's blocks are outside, under its treads)
    const [x0, x1, y0, y1, z0, z1] = s.b;
    seg(x0, z0, x1, z0, y0, y1); seg(x1, z0, x1, z1, y0, y1); seg(x1, z1, x0, z1, y0, y1); seg(x0, z1, x0, z0, y0, y1);
  }
  const band = (y0, y1, feet) => Math.min(y1, feet + 5) - Math.max(y0, feet + 1);   // overlap with the body band
  const walkable = (b0, b1, floor) => b1 - b0 >= WALK_H && band(b0, b1, floor) >= WALK_BAND;
  let lvFloor = 0;   // levelOf's result for a bright wall: the floor beside it that the player's level matched
  function levelOf(o, feet) {   // → C.wall (this level), C.wallDim (a storey above / below) or 0 (not drawn)
    if (band(o.y0, o.y1, feet) < LEVEL_MIN) return 0;
    if (!o.surf) { lvFloor = feet; return band(o.y0, o.y1, feet) >= LEVEL_FULL ? C.wall : C.wallDim; }
    let best = NaN, bd = NEAR + 1e-6;
    for (let i = 0; i < o.surf.length; i++) {
      const s = o.surf[i], d = Math.abs(s - feet);
      if (d <= bd && band(o.y0, o.y1, s) >= LEVEL_FULL) { bd = d; best = s; }
    }
    if (Number.isNaN(best)) return C.wallDim;
    lvFloor = best;
    return C.wall;
  }
  let mW = 1, mH = 1, mS = 1, mCx = 0, mCy = 0, mPx = 0, mPz = 0;
  let t0 = 0, t1 = 1;
  function clipT(p, q) {   // one Liang–Barsky edge test
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  }
  function plot(x0, y0, x1, y1, col) {   // clip to the canvas, then Bresenham (aliased, 1 virtual px)
    const dx = x1 - x0, dy = y1 - y0, xm = mW - 1, ym = mH - 1;
    t0 = 0; t1 = 1;
    if (!clipT(-dx, x0) || !clipT(dx, xm - x0) || !clipT(-dy, y0) || !clipT(dy, ym - y0)) return;
    let ax = Math.round(x0 + t0 * dx), ay = Math.round(y0 + t0 * dy);
    const bx = Math.round(x0 + t1 * dx), by = Math.round(y0 + t1 * dy);
    const ddx = Math.abs(bx - ax), stx = ax < bx ? 1 : -1, ddy = -Math.abs(by - ay), sty = ay < by ? 1 : -1;
    let err = ddx + ddy;
    for (;;) {
      if (ax >= 0 && ay >= 0 && ax <= xm && ay <= ym) mapPx[ay * mW + ax] = col;
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= ddy) { err += ddy; ax += stx; }
      if (e2 <= ddx) { err += ddx; ay += sty; }
    }
  }
  const sx = x => mCx + (x - mPx) * mS, sy = z => mCy + (z - mPz) * mS;
  const wline = (x0, z0, x1, z1, col) => plot(sx(x0), sy(z0), sx(x1), sy(z1), col);
  function wallSeg(W, a, b, col) {
    if (W.alongX) wline(a, W.c, b, W.c, col); else wline(W.c, a, W.c, b, col);
  }
  function glyph(x, z, fx, fz, size, pts, col) {   // a line shape in local coords (forward, right), closed
    const rx = -fz, rz = fx;   // screen right of the heading (north-up, z down)
    let px0 = 0, py0 = 0;
    for (let i = 0; i <= pts.length; i += 2) {
      const j = i % pts.length, f = pts[j] * size, r = pts[j + 1] * size;
      const X = sx(x) + (fx * f + rx * r), Y = sy(z) + (fz * f + rz * r);
      if (i) plot(px0, py0, X, Y, col);
      px0 = X; py0 = Y;
    }
  }
  const ARROW = [1, 0, -0.7, 0.62, -0.32, 0, -0.7, -0.62];
  const TRI = [1, 0, -0.7, 0.7, -0.7, -0.7];
  const caps = new Map();
  function caption(s) {   // the red 5×7 font with a black outline, so it reads over map lines
    let c = caps.get(s);
    if (!c) {
      if (caps.size > 32) caps.clear();
      const t = plain(s);
      c = document.createElement('canvas'); c.width = textWidth(t) + 3; c.height = 9;
      const cg = c.getContext('2d'), ink = Array(7).fill('#000');
      for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) if (dx !== 1 || dy !== 1) drawText(cg, t, dx, dy, ink, null);
      drawText(cg, t, 1, 1, 'red', null);
      caps.set(s, c);
    }
    return c;
  }
  function drawMap(st) {
    AM.last = st;
    if (!AM.visible || !mapPx || !st || !st.player) return;
    mW = mapCv.width; mH = mapCv.height;
    mapPx.fill(C.bg);
    const p = st.player, feet = p.feet || 0;
    mS = Math.min(mH, mW * 0.75) / AM.ft; mCx = Math.floor(mW / 2); mCy = Math.floor(mH / 2); mPx = p.x; mPz = p.z;
    // stairs: a brown line per riser (the first at the flight's low end), and railings near the player's level
    if (L && L.FLIGHTS) for (const f of L.FLIGHTS) {
      const fl = Math.min(f.h0, f.h1), fh = Math.max(f.h0, f.h1);
      if (fh < feet - 2 || fl > feet + 2) continue;
      const r = f.r, n = Math.max(1, f.risers | 0), dz = (r[3] - r[2]) / n;
      for (let i = 0; i < n; i++) {
        const z = f.h0 <= f.h1 ? r[2] + dz * i : r[3] - dz * i;
        wline(r[0], z, r[1], z, C.stair);
      }
    }
    if (L && L.RAILINGS) for (const r of L.RAILINGS) {
      const b = typeof r.base === 'function' ? r.base(0.5) : r.base;
      if (Math.abs(b - feet) < 3.2) wline(r.x0, r.z0, r.x1, r.z1, C.ledge);
    }
    // walls: the neighbouring storeys dim, then this level's on top. This level's walls open where you can walk
    // through from the floor beside them; the dim ones at any doorway-sized opening, as their own floor's map
    // shows them.
    for (const pass of PASSES) {
      for (const W of walls) {
        if (levelOf(W, feet) !== pass) continue;
        const fl = lvFloor;
        let a = W.a0;
        for (const o of W.ops) {
          if (pass === C.wall ? !walkable(o.b0, o.b1, fl) : o.b1 - o.b0 < WALK_H) continue;
          if (o.a0 > a) wallSeg(W, a, o.a0, pass);
          if (o.a1 > a) a = o.a1;
        }
        if (a < W.a1) wallSeg(W, a, W.a1, pass);
      }
      for (const s of segs) if (levelOf(s, feet) === pass) wline(s.x0, s.z0, s.x1, s.z1, pass);
    }
    // doors on this level: a yellow line along the leaf while it is shut (or swinging shut)
    if (st.doors) for (const d of st.doors) {
      if (d.isOpen || Math.abs((d.base || 0) - feet) > NEAR) continue;
      if (d.hx !== undefined) wline(d.hx, d.hz, d.hx + d.dx * d.w, d.hz + d.dz * d.w, C.door);
      else if (d.x0 !== undefined) wline(d.x0, d.z, d.x1, d.z, C.door);   // a straight run {x0, x1, z} (garage doors)
      else if (d.a0 !== undefined && d.c !== undefined) {   // across a wall opening {alongX, c, a0, a1} (the patio slider)
        if (d.alongX === false) wline(d.c, d.a0, d.c, d.a1, C.door); else wline(d.a0, d.c, d.a1, d.c, C.door);
      }
    }
    const ps = Math.max(3.5 / mS, 1.1);   // marker half-size in feet, never below ~3.5 px
    if (st.revealAll) {
      if (st.items) for (const it of st.items) {
        const col = Math.abs((it.feet || 0) - feet) < 4 ? C.item : C.itemDim, q = ps * 0.55;
        wline(it.x - q, it.z, it.x + q, it.z, col); wline(it.x, it.z - q, it.x, it.z + q, col);
      }
      if (st.imps) for (const m of st.imps) {
        const h = m.heading || 0, col = m.dead ? C.dead : Math.abs((m.feet || 0) - feet) < 4 ? C.imp : C.impDim;
        glyph(m.x, m.z, -Math.sin(h), -Math.cos(h), ps * mS * (m.dead ? 0.6 : 1), TRI, col);
      }
    }
    glyph(p.x, p.z, -Math.sin(p.yaw || 0), -Math.cos(p.yaw || 0), Math.max(6, 1.4 * mS), ARROW, C.player);
    mg.putImageData(mapImg, 0, 0);
    let y = mH - 10;   // captions bottom-left: the level name, the room above it
    if (st.levelName) { mg.drawImage(caption(String(st.levelName)), 1, y); y -= 9; }
    if (st.roomName) mg.drawImage(caption(String(st.roomName)), 1, y);
  }
  const automap = {
    get visible() { return AM.visible; },
    show(on) {
      AM.visible = !!on;
      mapCv.style.display = AM.visible ? 'block' : 'none';
      if (AM.visible && AM.last) drawMap(AM.last);
    },
    toggle() { automap.show(!AM.visible); return AM.visible; },
    zoom(delta) {   // +1 in, −1 out (a NaN would stick: clamp passes it through)
      AM.ft = clamp(AM.ft * Math.pow(AUTOMAP.step, -(+delta || 0)), AUTOMAP.min, AUTOMAP.max);
      if (AM.visible && AM.last) drawMap(AM.last);
    },
    draw: drawMap,
  };

  // ------------------------------------------------------------- update ----
  function update(dt) {
    if (!menuOpen && !inter) { acc = 0; return; }
    acc += Math.min(0.25, Math.max(0, dt || 0));
    let dirty = false;   // (a still menu only changes when the skull blinks)
    while (acc >= 1 / TICRATE) {
      acc -= 1 / TICRATE; tics++;
      if (tics % 8 === 0) { skullFrame ^= 1; dirty = true; }
      if (menuOpen && (cur.name === 'title' || cur.name === 'main')) { fireTic(getLogo(cur.name === 'title' ? 6 : 4)); dirty = true; }
      else if (inter && !menuOpen) { interTic(); dirty = true; }
    }
    if (dirty) redraw();
  }

  layout();
  return {
    openMenu, closeMenu, handleKey, update, intermission, automap,
    get menuOpen() { return menuOpen; },
    get current() { return menuOpen ? cur.name : null; },
    get intermissionActive() { return !!inter; },
    resize(w, h, vh) {   // (cheap when nothing changed: layout() rebuilds the canvases)
      vh = vh == null ? h : Math.min(h, vh);
      if (w === winW && h === winH && vh === viewH && (window.devicePixelRatio || 1) === lastDpr) return;
      winW = w; winH = h; viewH = vh; layout();
    },
    setLoading(text) { loading = text == null ? null : String(text); if (menuOpen) redraw(); },
  };
}
