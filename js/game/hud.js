// Doom-style HUD: status bar, face widget, message line, palette flashes and crosshair.
// The bar is composed in a 640×64 "core" (the 1993 320×32 layout at 2×, so the face and keycards get double
// detail; everything else is drawn in 2×2 blocks) and blitted nearest-neighbour into a canvas whose pixels are
// device pixels, so it stays crisp at any window size and pixel ratio.
import { drawBig, drawSmall, drawTiny, drawText, textWidth, CH_W, CH_H, BIG_W } from './pixfont.js';

// ---------------------------------------------------------------- tuning ----
const TIC = 35;
const BAR_FRAC = 0.16;        // bar height / window height once the window is wide enough
const PIX_ASPECT = 1.2;       // Doom's tall pixels (320×200 shown at 4:3)
const MSG_TICS = 4 * TIC;     // HU_MSGTIMEOUT
const MSG_FIT = 44;           // characters that must fit on one message line (caps the scale on narrow windows)
// Palette flash, as overlay opacity. Doom's red palettes saturate at a damagecount of ~56 and even a 3-point
// hit reads clearly, so red follows a curve (RED_FULL = 100 with RED_CURVE = 1 is a plain linear ramp).
const RED_MAX = 0.55, RED_FULL = 60, RED_CURVE = 0.6;
const BONUS_ADD = 6, BONUS_ALPHA = 0.04, BONUS_MAX = 0.36;   // bonuscount per pickup; opacity per count; cap
const BERSERK_COUNT = 12, BERSERK_FADE = 20;   // berserk red: like a 12-point hit at pickup, gone after 20 s
const RED_RGB = [255, 0, 0], GOLD_RGB = [215, 186, 69];
const INVULN_BLINK = 4 * 32;  // tics: the inverted view starts blinking this long before invulnerability ends
const CROSS_RGBA = 'rgba(255,255,255,0.85)', CROSS_EDGE = 'rgba(0,0,0,0.55)';

// ------------------------------------------------------------ face widget ----
const FACE_URL = new URL('../../textures/face.png', import.meta.url).href;
const FACE_W = 48, FACE_H = 58;                   // sheet cell, drawn 1:1 into the core
const FACE_BOX = [286, 4, 70, 58];                // core px (143–178 × 2–31 in the 320×32 layout)
const FACE_X = FACE_BOX[0] + ((FACE_BOX[2] - FACE_W) >> 1), FACE_Y = FACE_BOX[1];
// sheet columns (rows 0–4 are the pain levels) and ST_updateFaceWidget's timings in tics
const TURN_L = 3, TURN_R = 4, OUCH = 5, GRIN = 6, RAMPAGE = 7, GOD_FACE = 40, DEAD_FACE = 41;
const TURN_TICS = 35, GRIN_TICS = 70, STRAIGHT_TICS = 17, RAMPAGE_DELAY = 70, MUCH_PAIN = 20;
const painRow = (h) => Math.min(4, Math.max(0, Math.floor((100 - Math.min(h, 100)) * 5 / 101))) * 8;

// ------------------------------------------------------------ bar layout ----
const DIVIDERS = [48, 104, 143, 178, 235, 249];
const KEY_Y = [3, 13, 23];                        // blue, yellow, red slots at x 237–247, 7 high
const KEY_RGB = [[46, 98, 255], [240, 192, 32], [224, 40, 26]];
const AMMO_ROWS = [['BULL', 'bull', 5], ['SHEL', 'shel', 11], ['RCKT', 'rckt', 17], ['CELL', 'cell', 23]];
const ARMS_ON = '#ffd24a', ARMS_OFF = '#6e6e6e', TABLE_INK = '#ffd24a', TAG_INK = '#bdb4a2', EDGE = '#141414';
const SLOT_TXT = ['2', '3', '4', '5', '6', '7'], DIGITS = '0123456789';
// 3×5 digits for the ammo table: the same size as its 3×5 labels, and with a 1 px shadow the rows (6 px apart)
// stay separate, as on the 1993 bar
const TABLE_FONT = {
  0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'], 2: ['###', '..#', '###', '#..', '###'],
  3: ['###', '..#', '.##', '..#', '###'], 4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '###', '..#', '###'],
  6: ['###', '#..', '###', '#.#', '###'], 7: ['###', '..#', '..#', '.#.', '.#.'], 8: ['###', '#.#', '###', '#.#', '###'],
  9: ['###', '#.#', '###', '..#', '###'], '/': ['..#', '..#', '.#.', '#..', '#..'],
};
const KEY_PAT = [
  '.kkkkkkkkkkkk.',
  'kLLLLLLLLLLLLk',
  'kLMMMMMMMMMMDk',
  'kLMhhMMwwwwMDk',
  'kLMhhMMwwwwMDk',
  'kLMMMMMMMMMMDk',
  'kLbbbbbbbbbbDk',
  'kLMMMMMMMMMMDk',
  'kDDDDDDDDDDDDk',
  '.kkkkkkkkkkkk.',
];

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
const box = (g, x, y, w, h, c) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
function tableGlyph(g, ch, x, y, ink, shadow) {
  const gl = TABLE_FONT[ch];
  for (let pass = 0; pass < 2; pass++) {
    g.fillStyle = pass ? ink : shadow;
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (gl[r][c] === '#') g.fillRect(x + c + 1 - pass, y + r + 1 - pass, 1, 1);
  }
}

// ----------------------------------------------------------------- stone ----
function hash(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, f, s) {
  const fx = x * f, fy = y * f, x0 = Math.floor(fx), y0 = Math.floor(fy);
  let tx = fx - x0, ty = fy - y0;
  tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
  const a = hash(x0, y0, s), b = hash(x0 + 1, y0, s), c = hash(x0, y0 + 1, s), d = hash(x0 + 1, y0 + 1, s);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}
// Mottled grey stone at Doom pixel (x, y), darkened by k (recesses, side borders); vein scales the dark veins.
// One continuous field, so the side borders carry on the core's pattern.
function stone(d, i, x, y, k, vein) {
  const yy = y * PIX_ASPECT;   // tall pixels: stretch the noise so blotches look round on screen
  let v = 56 + 122 * (0.42 * vnoise(x, yy, 1 / 13, 1) + 0.28 * vnoise(x, yy, 1 / 6, 2) + 0.17 * vnoise(x, yy, 1 / 3, 3) +
    0.13 * hash(x, y, 4));
  v *= 1 - 0.28 * vein * Math.max(0, 1 - Math.abs(vnoise(x, yy, 1 / 15, 5) - 0.5) / 0.035);   // sparse soft veins
  const p = hash(x, y, 7);
  if (p < 0.035) v *= 0.68; else if (p > 0.985) v *= 1.18;           // pits and glints
  const w = vnoise(x, yy, 1 / 24, 6) - 0.5;                         // faint warm / cool drift
  v *= k;
  d[i] = v * (1 + 0.09 * w); d[i + 1] = v * 0.99; d[i + 2] = v * (0.95 - 0.09 * w); d[i + 3] = 255;
}
function stoneCanvas(w, x0, k, kAt, veinAt) {
  const c = mk(w, 32), g = c.getContext('2d'), img = g.createImageData(w, 32), d = img.data;
  for (let y = 0; y < 32; y++) for (let x = 0; x < w; x++) {
    stone(d, (y * w + x) * 4, x0 + x, y, kAt ? kAt(x, y) : k, veinAt ? veinAt(x, y) : 1);
  }
  g.putImageData(img, 0, 0);
  return c;
}

// The static bar: stone, bevels, recesses, labels. Drawn at 320×32, returned doubled to 640×64.
function buildBar() {
  const t = stoneCanvas(320, 0, 1, (x, y) => {
    if (x > 143 && x < 178 && y > 1) return 0.46;                              // face box
    if (x >= 237 && x < 247) for (const ky of KEY_Y) if (y >= ky && y < ky + 7) return 0.4;   // key slots
    return 1;
  }, (x, y) => {
    // the grey (not owned) ARMS digits are about as dark as a vein, so a vein between two of them reads as a
    // dash ("6-7"): fade the veins out behind the digits, over a few pixels so none ends abruptly
    const out = Math.max(110 - x, x - 141, 3 - y, y - 21, 0);
    return Math.min(1, 0.15 + out * 0.3);
  });
  const g = t.getContext('2d');
  const LIT = 'rgba(255,255,255,0.3)', SHADE = 'rgba(0,0,0,0.5)';
  box(g, 0, 0, 320, 1, 'rgba(255,255,255,0.45)'); box(g, 0, 1, 320, 1, 'rgba(255,255,255,0.15)');
  box(g, 0, 31, 320, 1, 'rgba(0,0,0,0.4)');
  box(g, 0, 1, 1, 31, LIT); box(g, 319, 1, 1, 31, SHADE);
  for (const x of DIVIDERS) { if (x !== 178) box(g, x - 1, 1, 1, 31, SHADE); box(g, x, 1, 1, 31, LIT); }
  // face box: sunk into the stone, lit from the top left
  box(g, 144, 2, 34, 1, 'rgba(0,0,0,0.55)'); box(g, 144, 3, 1, 29, 'rgba(0,0,0,0.4)');
  box(g, 177, 3, 1, 29, 'rgba(255,255,255,0.1)');
  for (const ky of KEY_Y) {
    box(g, 237, ky, 10, 1, 'rgba(0,0,0,0.5)'); box(g, 237, ky + 1, 1, 6, 'rgba(0,0,0,0.35)');
    box(g, 237, ky + 7, 11, 1, 'rgba(255,255,255,0.22)'); box(g, 247, ky, 1, 7, 'rgba(255,255,255,0.22)');
  }
  const label = (s, cx) => drawText(g, s, Math.round(cx - textWidth(s) / 2), 23, 'grey', EDGE);
  label('AMMO', 24); label('HEALTH', 76); label('ARMS', 123.5); label('ARMOR', 206.5);
  for (const [tag, , y] of AMMO_ROWS) { drawTiny(g, tag, 252, y, TAG_INK, EDGE); tableGlyph(g, '/', 293, y, TAG_INK, EDGE); }
  const c = mk(640, 64), cg = c.getContext('2d');
  cg.imageSmoothingEnabled = false;
  cg.drawImage(t, 0, 0, 640, 64);
  return c;
}

// Darker stone for the bar's extension beyond the 320×32 core on wide windows (w Doom px starting at x0).
function buildSide(w, x0) {
  const t = stoneCanvas(w, x0, 0.62), g = t.getContext('2d');
  box(g, 0, 0, w, 1, 'rgba(255,255,255,0.32)'); box(g, 0, 1, w, 1, 'rgba(255,255,255,0.1)');
  box(g, 0, 31, w, 1, 'rgba(0,0,0,0.4)');
  if (x0 < 0) box(g, w - 1, 1, 1, 31, 'rgba(0,0,0,0.5)'); else box(g, 0, 1, 1, 31, 'rgba(255,255,255,0.22)');
  return t;
}

// 7×5 keycard at 2× detail (14×10 core px).
function keyIcon([r, g, b]) {
  const c = mk(14, 10), cg = c.getContext('2d');
  const mix = (t, v) => `rgb(${Math.round(r + (v - r) * t)},${Math.round(g + (v - g) * t)},${Math.round(b + (v - b) * t)})`;
  const pal = { k: mix(0.75, 0), L: mix(0.45, 255), M: mix(0, 0), D: mix(0.4, 0), b: mix(0.55, 0), h: '#080808', w: '#ecebe2' };
  KEY_PAT.forEach((row, y) => { for (let x = 0; x < 14; x++) if (pal[row[x]]) box(cg, x, y, 1, 1, pal[row[x]]); });
  return c;
}

// Stand-in face sheet (a grey oval, clearly a placeholder) if textures/face.png cannot be loaded: same 8×6 grid,
// with eyes / mouth varied per column and bruising per pain row so the face logic can still be followed.
function placeholderFaces() {
  const c = mk(FACE_W * 8, FACE_H * 6), g = c.getContext('2d'), img = g.createImageData(c.width, c.height), d = img.data;
  for (let row = 0; row < 6; row++) for (let col = 0; col < (row < 5 ? 8 : 2); col++) {
    const k = row < 5 ? col : col ? 8 : 9, pain = row < 5 ? row : 4 * col;   // 8 dead, 9 god
    const turn = k === TURN_L ? -1 : k === TURN_R ? 1 : 0, look = k === 1 ? -1 : k === 2 ? 1 : turn;
    const hx = 24 + turn * 2, hy = 27, fx = hx + turn * 4;
    for (let y = 0; y < FACE_H; y++) for (let x = 0; x < FACE_W; x++) {
      const px = x + 0.5, py = y + 0.5, nx = (px - hx) / 15.5, ny = (py - hy) / 21, r2 = nx * nx + ny * ny;
      const u = px - fx, v = py - hy;
      let s;
      if (r2 <= 1) {
        s = (k === 8 ? 120 : 176 - pain * 10) * (0.5 + 0.55 * Math.max(0, -0.4 * nx - 0.35 * ny + 0.85 * Math.sqrt(1 - r2)));
        if (r2 > 0.86 || ny < -0.55) s *= 0.5;                                          // outline, hair
        if (pain && (u + 8) ** 2 + (v - 6) ** 2 < pain * 3.5) s *= 0.6;                   // bruises
        if (pain > 2 && (u - 7) ** 2 + (v + 9) ** 2 < pain * 2.5) s *= 0.6;
        const au = Math.abs(u) - 6.5, ev = v + 2;
        const eyeH = k === GRIN ? 1.3 : k === OUCH ? 2.7 : 1.9;
        if (k === 8) { if (Math.abs(au) < 2.6 && Math.abs(Math.abs(au) - Math.abs(ev)) < 0.8) s = 30; }  // X eyes
        else if ((au / 3.2) ** 2 + (ev / eyeH) ** 2 <= 1) {
          s = Math.abs(u - Math.sign(u) * 6.5 - look * 1.4) < 1.1 && Math.abs(ev) < 1.1 ? (k === 9 ? 250 : 30) : 225;
        }
        const brow = (k === RAMPAGE || turn ? 0.45 : k === OUCH ? -0.35 : 0) * -au;   // angry / worried brows
        if (Math.abs(au) < 3.6 && Math.abs(v + 6.5 - brow) < 0.75) s = 45;
        const smile = 10 - (u / 7) ** 2 * 3;
        const mouth = k === OUCH || k === 8 ? (u / 2.6) ** 2 + ((v - 10.5) / 3) ** 2 <= 1
          : k === GRIN ? Math.abs(u) < 7 && Math.abs(v - smile) < 1.4
            : k === RAMPAGE ? Math.abs(u) < 5 && Math.abs(v - 10.5) < 2.6
              : Math.abs(u) < 4.5 && Math.abs(v - (k === 9 ? smile : 10)) < 0.7;
        if (mouth) s = (k === GRIN && Math.abs(v - smile) < 0.8) || (k === RAMPAGE && Math.abs(v - 10.5) > 1.2) ? 230 : 28;
      } else if (py > 46 && Math.abs(px - 24) < 9 + (py - 46) * 1.7) s = 70;               // shoulders
      else continue;
      const i = ((row * FACE_H + y) * c.width + col * FACE_W + x) * 4;
      d[i] = s; d[i + 1] = s; d[i + 2] = s * 1.03; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

// Pre-rendered glyphs (w×h Doom px, stored at the core's 2×), so a changed number costs a few drawImage calls
// instead of hundreds of per-pixel fillRects. Each glyph carries its own shadow, which never reaches the next
// glyph's ink, so the result is the same as drawing the string with pixfont.
function glyphs(chars, w, h, draw) {
  const set = {};
  for (const ch of chars) {
    const c = mk(w * 2, h * 2), g = c.getContext('2d');
    g.setTransform(2, 0, 0, 2, 0, 0); draw(g, ch); set[ch] = c;
  }
  return set;
}
// 5×7 message characters with their shadow, at Doom scale, made on first use.
const charSprites = new Map();
function charSprite(ch) {
  let c = charSprites.get(ch);
  if (!c) { c = mk(CH_W, CH_H + 1); drawText(c.getContext('2d'), ch, 0, 0, 'red'); charSprites.set(ch, c); }
  return c;
}

// Split a message into lines of at most max characters, breaking at spaces (and inside over-long words).
function wrap(text, max, out) {
  out.length = 0;
  let line = '';
  for (let w of text.split(' ')) {
    while (w.length > max) {
      if (line) { out.push(line); line = ''; }
      out.push(w.slice(0, max)); w = w.slice(max);
    }
    if (!line) line = w;
    else if (line.length + 1 + w.length <= max) line += ' ' + w;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out;
}

// ------------------------------------------------------------------- HUD ----
// faceSrc: face sheet URL (null → placeholder); invulnFx: show Doom's inverted grey view while st.invuln > 0.
export function createHud({ stbar, msg, flashEl, crosshair, faceSrc = FACE_URL, invulnFx = true }) {
  const sg = stbar.getContext('2d'), mg = msg.getContext('2d');
  const bar = buildBar();
  const core = mk(640, 64), cg = core.getContext('2d');
  cg.drawImage(bar, 0, 0);
  const keys = KEY_RGB.map(keyIcon);
  // big glyphs sit 1 px into their 14 px cell (ink 1–12, shadow 13): the cell still ends at the spec's x, but a
  // 3-digit HEALTH (cells from x 48) no longer paints over the divider's lit edge at x 48
  const BIGS = glyphs('0123456789%', BIG_W, 17, (g, ch) => drawBig(g, ch, BIG_W + 1, 0));
  const small = (ink) => glyphs(DIGITS, 5, 7, (g, ch) => drawSmall(g, ch, 4, 0, ink, EDGE));
  const ARM_ON = small(ARMS_ON), ARM_OFF = small(ARMS_OFF);
  const TAB = glyphs(DIGITS, 4, 6, (g, ch) => tableGlyph(g, ch, 0, 0, TABLE_INK, EDGE));
  let sheet = null, cellW = FACE_W, cellH = FACE_H;
  const useSheet = (s) => { sheet = s; cellW = s.width / 8; cellH = s.height / 6; drawFace(); blit(); };
  if (faceSrc) {
    const img = new Image();
    img.onload = () => useSheet(img);
    img.onerror = () => { console.warn('hud: no face sheet at ' + faceSrc + ', using a placeholder'); useSheet(placeholderFaces()); };
    img.src = faceSrc;
  } else sheet = placeholderFaces();

  // DOM: everything is position: fixed; the crosshair div gets a canvas child. The invulnerability view gets its
  // own backdrop-filter layer over the 3D view only, inserted before the first HUD element so the bar, message
  // and crosshair are not inverted (the palette flash above it still tints everything, as in Doom).
  Object.assign(stbar.style, { position: 'fixed', left: '0', top: 'auto', bottom: '0', margin: '0', imageRendering: 'pixelated',
    touchAction: 'none', userSelect: 'none' });
  Object.assign(msg.style, { position: 'fixed', left: '0', top: '0', margin: '0', imageRendering: 'pixelated', pointerEvents: 'none' });
  Object.assign(flashEl.style, { position: 'fixed', left: '0', top: '0', margin: '0', pointerEvents: 'none', background: 'none' });
  Object.assign(crosshair.style, { position: 'fixed', margin: '0', padding: '0', border: '0', borderRadius: '0',
    background: 'none', boxShadow: 'none', pointerEvents: 'none', lineHeight: '0', transform: 'none' });
  const xc = mk(1, 1);
  xc.style.display = 'block'; xc.style.imageRendering = 'pixelated';
  crosshair.textContent = ''; crosshair.appendChild(xc);
  let inv = null;
  if (invulnFx && flashEl.parentNode) {
    inv = document.createElement('div');
    Object.assign(inv.style, { position: 'fixed', left: '0', top: '0', pointerEvents: 'none', display: 'none',
      backdropFilter: 'grayscale(1) invert(1)', webkitBackdropFilter: 'grayscale(1) invert(1)' });
    let first = flashEl;
    for (const el of [stbar, msg, crosshair]) {
      if (el.parentNode === flashEl.parentNode && first.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) first = el;
    }
    flashEl.parentNode.insertBefore(inv, first);
  }

  let visible = true, crossOn = true, winW = window.innerWidth, winH = window.innerHeight;
  let dpr = 1, W = 1, barDev = 0, coreX = 0, coreW = 0, barH = 0, viewH = winH, sx = 2, sy = 2;
  let acc = 0;
  // Doom's player / status-bar counters, in tics
  let damageCount = 0, bonusCount = 0, tickDmg = 0, attacker = null, grin = false;
  let priority = 0, faceIdx = 0, faceCount = 0, lastAttack = -1, oldHealth = -1;
  let bzTics = 0, bzLeft = 0, invTics = 0, invOn = false;
  let msgText = '', msgTics = 0, messagesOn = true;
  const msgLines = [];
  let flashR = -1, flashY = -1;
  const last = { ammo: NaN, health: NaN, armor: NaN, arms: NaN, keys: NaN, face: NaN, tab: new Float64Array(8).fill(NaN) };
  const invalidate = () => { last.ammo = last.health = last.armor = last.arms = last.keys = last.face = last.tab[0] = NaN; };

  // ---------------------------------------------------------- drawing ----
  const restore = (x, y, w, h) => cg.drawImage(bar, x, y, w, h, x, y, w, h);   // core px
  const put = (set, ch, x, y) => cg.drawImage(set[ch], x * 2, y * 2);          // glyph at Doom px (x, y)
  const num = (v) => Math.max(0, Math.min(999, Math.round(v) || 0));
  // Right-aligned number whose last digit sits at Doom x, drawn right to left without building a string (big
  // numbers advance BIG_W like drawBig, the ammo table's 3×5 digits 4).
  const number = (set, v, x, y, adv) => {
    for (; ; x -= adv) { put(set, DIGITS[v % 10], x, y); v = Math.floor(v / 10); if (!v) break; }
  };

  function drawFace() {
    restore(...FACE_BOX);
    last.face = faceIdx;
    if (!sheet) return;   // still loading: onload draws it
    cg.save();
    cg.beginPath(); cg.rect(...FACE_BOX); cg.clip();
    cg.imageSmoothingEnabled = cellW !== FACE_W || cellH !== FACE_H;
    cg.drawImage(sheet, (faceIdx & 7) * cellW, (faceIdx >> 3) * cellH, cellW, cellH, FACE_X, FACE_Y, FACE_W, FACE_H);
    cg.restore();
  }

  function drawWidgets(st) {
    let dirty = false;
    const ammo = st.cur && st.ammo ? num(st.ammo[st.cur]) : -1;
    if (ammo !== last.ammo) {
      last.ammo = ammo; restore(0, 4, 96, 38);
      if (ammo >= 0) number(BIGS, ammo, 44 - BIG_W, 3, BIG_W);   // AMMO ends at x 44; blank for fist / chainsaw
      dirty = true;
    }
    const health = num(st.health);
    if (health !== last.health) {
      last.health = health; restore(96, 4, 112, 38);
      number(BIGS, health, 90 - BIG_W, 3, BIG_W); put(BIGS, '%', 90, 3);
      dirty = true;
    }
    const armor = num(st.armor);
    if (armor !== last.armor) {
      last.armor = armor; restore(356, 4, 114, 38);
      number(BIGS, armor, 221 - BIG_W, 3, BIG_W); put(BIGS, '%', 221, 3);
      dirty = true;
    }
    let arms = 0;
    if (st.arms) for (let i = 2; i <= 7; i++) if (st.arms[i]) arms |= 1 << i;
    if (arms !== last.arms) {
      last.arms = arms; restore(208, 6, 78, 38);
      for (let i = 0; i < 6; i++) put(arms & (4 << i) ? ARM_ON : ARM_OFF, SLOT_TXT[i], 111 + 12 * (i % 3), i < 3 ? 4 : 14);
      dirty = true;
    }
    const k = st.keys, keyMask = k ? (k.blue ? 1 : 0) | (k.yellow ? 2 : 0) | (k.red ? 4 : 0) : 0;
    if (keyMask !== last.keys) {
      last.keys = keyMask;
      for (let i = 0; i < 3; i++) { restore(474, KEY_Y[i] * 2, 20, 14); if (keyMask & (1 << i)) cg.drawImage(keys[i], 477, KEY_Y[i] * 2 + 2); }
      dirty = true;
    }
    let tabChanged = false;
    for (let i = 0; i < 4; i++) {
      const id = AMMO_ROWS[i][1], a = num(st.ammo && st.ammo[id]), m = num(st.max && st.max[id]);
      if (a !== last.tab[i * 2] || m !== last.tab[i * 2 + 1]) { last.tab[i * 2] = a; last.tab[i * 2 + 1] = m; tabChanged = true; }
    }
    if (tabChanged) {
      restore(540, 10, 92, 50);
      for (let i = 0; i < 4; i++) {   // current ends at x 288, max at 314
        const y = AMMO_ROWS[i][2];
        number(TAB, last.tab[i * 2], 284, y, 4); number(TAB, last.tab[i * 2 + 1], 310, y, 4);
      }
      dirty = true;
    }
    if (faceIdx !== last.face) { drawFace(); dirty = true; }
    if (dirty) blit();
  }

  function blit() {
    if (!visible || !barDev) return;
    sg.imageSmoothingEnabled = false;
    sg.drawImage(core, 0, 0, 640, 64, coreX, 0, coreW, barDev);
  }

  function drawSides() {
    // same device scale as the core, so the border's Doom pixels line up with it; widths in Doom px. Each side
    // separately: when W − coreW is odd the right one is a pixel wider (and the only one when coreX is 0).
    const px = coreW / 320, rest = W - coreX - coreW;
    sg.imageSmoothingEnabled = false;
    if (coreX > 0) { const wl = Math.ceil(coreX / px); sg.drawImage(buildSide(wl, -wl), coreX - wl * px, 0, wl * px, barDev); }
    if (rest > 0) { const wr = Math.ceil(rest / px); sg.drawImage(buildSide(wr, 320), coreX + coreW, 0, wr * px, barDev); }
  }

  // Message line(s): Doom pixels of sx × sy device px, 1 px margins; the canvas is as tall as the lines need.
  function drawMsg() {
    const n = msgTics && messagesOn ? msgLines.length : 0;
    const h = (1 + Math.max(1, n) * (CH_H + 1)) * sy;
    if (msg.width !== W || msg.height !== h) {
      msg.width = W; msg.height = h;   // resizing clears it
      msg.style.width = W / dpr + 'px'; msg.style.height = h / dpr + 'px';
    } else mg.clearRect(0, 0, W, h);
    if (!n) return;
    mg.imageSmoothingEnabled = false;
    for (let l = 0; l < n; l++) {
      const s = msgLines[l], y = (1 + l * (CH_H + 1)) * sy;
      for (let i = 0; i < s.length; i++) if (s[i] !== ' ') mg.drawImage(charSprite(s[i]), (1 + i * CH_W) * sx, y, CH_W * sx, (CH_H + 1) * sy);
    }
  }
  const wrapMsg = () => wrap(msgText, Math.max(1, Math.floor((Math.floor(W / sx) - 1) / CH_W)), msgLines);

  function drawCrosshair() {
    const u = Math.max(1, Math.round(sx / 3)), a = 3 * u, n = 2 * a + u + 2, m = a + 1;
    xc.width = xc.height = n;
    const g = xc.getContext('2d');
    box(g, m - 1, 0, u + 2, n, CROSS_EDGE); box(g, 0, m - 1, n, u + 2, CROSS_EDGE);
    g.clearRect(m, 1, u, n - 2); g.clearRect(1, m, n - 2, u);
    box(g, m, 1, u, n - 2, CROSS_RGBA); box(g, 1, m, n - 2, u, CROSS_RGBA);
    return n;
  }

  // Palette flash (Doom's ST_doPaletteStuff as an overlay): red from the damagecount or the berserk fade, gold
  // from the bonuscount, composited gold-under-red into one rgba. Invulnerability inverts the view instead.
  function updateFlash() {
    let cnt = damageCount;
    if (bzLeft > 0) cnt = Math.max(cnt, BERSERK_COUNT * Math.min(1 - bzTics / (BERSERK_FADE * TIC), bzLeft / BERSERK_FADE));
    const r = cnt > 0 ? Math.round(255 * RED_MAX * Math.min(1, cnt / RED_FULL) ** RED_CURVE) / 255 : 0;
    const y = Math.round(255 * Math.min(BONUS_MAX, bonusCount * BONUS_ALPHA)) / 255;
    if (r !== flashR || y !== flashY) {
      flashR = r; flashY = y;
      const a = 1 - (1 - r) * (1 - y), wy = y * (1 - r);
      const c = (i) => Math.round((RED_RGB[i] * r + GOLD_RGB[i] * wy) / (a || 1));
      flashEl.style.backgroundColor = a ? `rgba(${c(0)},${c(1)},${c(2)},${a.toFixed(3)})` : 'transparent';
    }
    const on = invTics > INVULN_BLINK || (invTics & 8) !== 0;
    if (inv && on !== invOn) { invOn = on; inv.style.display = visible && on ? 'block' : 'none'; }
  }

  function applyVisibility() {
    const show = (el, on) => { el.style.display = on ? 'block' : 'none'; };
    show(stbar, visible); show(msg, visible); show(flashEl, visible); show(crosshair, visible && crossOn);
    if (inv) show(inv, visible && invOn);
  }

  // ----------------------------------------------------------- layout ----
  function layout() {
    dpr = window.devicePixelRatio || 1;
    W = Math.max(1, Math.round(winW * dpr));
    if (visible) {
      coreW = Math.max(1, Math.min(W, Math.round(winH * BAR_FRAC * 320 / (32 * PIX_ASPECT) * dpr)));
      barDev = Math.max(1, Math.round(coreW * 32 * PIX_ASPECT / 320));
      coreX = (W - coreW) >> 1;
      stbar.width = W; stbar.height = barDev;
      Object.assign(stbar.style, { width: W / dpr + 'px', height: barDev / dpr + 'px' });
      drawSides(); blit();
    } else barDev = 0;
    barH = barDev / dpr;
    viewH = Math.max(0, winH - barH);
    const viewDev = Math.max(0, Math.round(winH * dpr) - barDev);
    // message scale max(2, round(viewH / 200)) CSS px per Doom pixel, in device px, capped so MSG_FIT characters
    // fit the width (the cap in device px, so rounding a fractional pixel ratio up cannot push the line into a
    // wrap); only below 2 CSS px does it wrap instead. Doom pixels are 1.2× as tall: sy from the snapped sx.
    const fit = Math.floor(W / (MSG_FIT * CH_W + 1));
    sx = Math.max(1, Math.round(2 * dpr), Math.min(Math.round(Math.max(2, Math.round(viewH / 200)) * dpr), fit));
    sy = Math.max(1, Math.round(sx * PIX_ASPECT));
    wrapMsg(); drawMsg();
    const n = drawCrosshair();
    Object.assign(crosshair.style, { width: n / dpr + 'px', height: n / dpr + 'px',
      left: ((W - n) >> 1) / dpr + 'px', top: ((viewDev - n) >> 1) / dpr + 'px' });
    xc.style.width = xc.style.height = n / dpr + 'px';
    // the palette tints the whole screen, bar included (as in Doom); the invulnerability view only the 3D view
    flashEl.style.width = winW + 'px'; flashEl.style.height = winH + 'px';
    if (inv) { inv.style.width = winW + 'px'; inv.style.height = viewH + 'px'; }
    applyVisibility();
    return { barH };
  }

  // ------------------------------------------------------------ ticker ----
  // One 35 Hz tic: Doom's ST_updateFaceWidget, then the P_PlayerThink counter decay.
  function tic(st) {
    const hp = Math.max(0, Math.round(st.health) || 0), pain = painRow(hp);
    const hurt = Math.max(tickDmg, oldHealth >= 0 ? oldHealth - hp : 0) > MUCH_PAIN;   // ST_MUCHPAIN (sign bug fixed)
    tickDmg = 0;
    if (priority < 10 && (st.dead || hp <= 0)) { priority = 9; faceIdx = DEAD_FACE; faceCount = 1; }
    if (priority < 9 && grin) { priority = 8; faceCount = GRIN_TICS; faceIdx = pain + GRIN; }
    grin = false;
    if (priority < 8 && damageCount > 0 && attacker !== null) {
      // being attacked. The ouch face takes priority 8 so the per-tic re-check below it cannot replace it
      // before its 35 tics are up (vanilla overwrote it the next tic).
      faceCount = TURN_TICS;
      if (hurt) { priority = 8; faceIdx = pain + OUCH; }
      else {
        priority = 7;
        faceIdx = pain + (Math.abs(attacker) < Math.PI / 4 ? RAMPAGE : attacker > 0 ? TURN_L : TURN_R);
      }
    }
    if (priority < 7 && damageCount > 0) {   // self / environment damage
      faceCount = TURN_TICS;
      if (hurt) { priority = 7; faceIdx = pain + OUCH; } else { priority = 6; faceIdx = pain + RAMPAGE; }
    }
    if (priority < 6) {   // fire held for 2 s
      if (st.attackDown) {
        if (lastAttack === -1) lastAttack = RAMPAGE_DELAY;
        else if (!--lastAttack) { priority = 5; faceIdx = pain + RAMPAGE; faceCount = 1; lastAttack = 1; }
      } else lastAttack = -1;
    }
    if (priority < 5 && (st.god || st.invuln > 0)) { priority = 4; faceIdx = GOD_FACE; faceCount = 1; }
    if (!faceCount) { faceIdx = pain + Math.floor(Math.random() * 3); faceCount = STRAIGHT_TICS; priority = 0; }
    faceCount--;
    oldHealth = hp;

    damageCount = Math.max(0, damageCount - 1);
    if (bonusCount > 0) bonusCount--;
    const bz = +st.berserk || 0;   // seconds left; a jump up is a fresh pickup, which restarts the fade
    if (bz > 0) bzTics = bzLeft > 0 && bz <= bzLeft + 0.5 ? bzTics + 1 : 0; else bzTics = 0;
    bzLeft = bz;
    invTics = st.invuln > 0 ? Math.round(st.invuln * TIC) : 0;
    if (msgTics && !--msgTics) drawMsg();
  }

  // --------------------------------------------------------------- API ----
  const hud = {
    get visible() { return visible; },
    get barH() { return barH; },
    get viewH() { return viewH; },
    resize(w, h) {
      if (w === winW && h === winH && dpr === (window.devicePixelRatio || 1)) return { barH };   // nothing to lay out
      winW = w; winH = h; return layout();
    },
    setVisible(v) { visible = !!v; return layout(); },
    setCrosshair(on) { crossOn = !!on; crosshair.style.display = visible && crossOn ? 'block' : 'none'; },
    update(dt, st) {
      if (messagesOn !== (st.messages !== false)) { messagesOn = !messagesOn; if (!messagesOn && msgTics) { msgTics = 0; drawMsg(); } }
      if (dt > 0) acc += Math.min(dt, 1) * TIC;   // (a NaN dt would otherwise stop the tics for good)
      for (let n = 0; acc >= 1 && n < TIC; n++) { tic(st); acc -= 1; }
      if (acc >= 1) acc = 0;   // long stall: drop the backlog instead of replaying it
      drawWidgets(st);
      updateFlash();
    },
    message(text) {
      const s = messagesOn && text != null ? String(text).replace(/\s+/g, ' ').trim() : '';   // one line: no \n
      if (!s) return;
      msgText = s.toUpperCase(); msgTics = MSG_TICS;
      wrapMsg(); drawMsg();
    },
    onDamage(amount, angle) {
      if (!(amount > 0)) return;
      damageCount = Math.min(100, damageCount + amount);
      tickDmg += amount;
      attacker = Number.isFinite(angle) ? Math.atan2(Math.sin(angle), Math.cos(angle)) : null;   // wrapped to ±π
      updateFlash();
    },
    onWeaponPickup() { grin = true; },
    onBonus() { bonusCount += BONUS_ADD; updateFlash(); },
    reset() {
      damageCount = bonusCount = tickDmg = bzTics = bzLeft = invTics = msgTics = acc = 0;
      attacker = null; grin = false; priority = 0; faceIdx = 0; faceCount = 0; lastAttack = -1; oldHealth = -1;
      drawMsg(); updateFlash(); invalidate(); drawFace(); blit();
    },
    get debug() {
      return { priority, face: faceIdx, faceCount, damageCount, bonusCount, bzTics, red: flashR, gold: flashY,
        flash: flashEl.style.backgroundColor, invert: invOn, msg: msgTics ? msgLines.join('|') : '', core, coreX, coreW, barDev,
        sx, sy, dpr };
    },
  };
  layout();
  return hud;
}
