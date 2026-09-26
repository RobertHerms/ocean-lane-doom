// World visual effects for the DOOM mode: projectiles, explosions, bullet puffs, sparks, telefog and embers, plus a
// fixed pool of four point lights shared by everything that glows.
// Every sprite goes through ONE instanced billboard mesh with premultiplied alpha (additive fire and alpha-blended
// smoke share the draw call, sorted back to front each frame); rockets are small pooled meshes. After creation
// nothing is allocated per effect or per frame: particles, projectiles, flashes and light requests live in fixed pools.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ------------------------------------------------------------------ tuning ----
// Light sources: colour (sRGB hex), intensity (cd, decay 2), radius (ft; the light's distance cutoff) and, for the
// one-shot ones, duration (s). Read live, so the lead can tune them in the house at runtime.
export const FX_LIGHTS = {
  muzzle:      { color: 0xffc47a, intensity: 60, radius: 25, duration: 0.11 },   // defaults for fx.flash()
  fireball:    { color: 0xff7a30, intensity: 25, radius: 14 },
  handFire:    { color: 0xff7a30, intensity: 14, radius: 10 },
  rocket:      { color: 0xffa04c, intensity: 30, radius: 16 },
  plasma:      { color: 0x6ea8ff, intensity: 20, radius: 12 },
  bfg:         { color: 0x6cff58, intensity: 150, radius: 28 },
  expRocket:   { color: 0xff8a3c, intensity: 250, radius: 30, duration: 0.75 },
  expFireball: { color: 0xff7a30, intensity: 45, radius: 15, duration: 0.45 },
  expPlasma:   { color: 0x78b0ff, intensity: 40, radius: 14, duration: 0.35 },
  expBfg:      { color: 0x78ff60, intensity: 320, radius: 36, duration: 1.3 },
  bfgSpray:    { color: 0x78ff60, intensity: 35, radius: 12, duration: 0.6 },
  telefog:     { color: 0x80ff90, intensity: 40, radius: 16, duration: 1.5 },
};
// Sprite brightness multipliers per family (1 = as designed: hot cores ~6–15 linear, above the house's bloom threshold
// of 3 / exposure; outer glows ~1–3).
export const FX_BRIGHT = { fire: 1, spark: 1, plasma: 1, bfg: 1, telefog: 1 };
// Smoke albedo relative to setAmbient()'s mid grey (1 = reads as a mid-grey surface of the room): bullet-hole dust,
// rocket trail, rocket / fireball explosion smoke.
export const FX_SMOKE = { dust: 2.4, trail: 1.35, rocket: 0.8, fireball: 0.9 };
// Exposure adaptation driven by fx.setAmbient(v), v = the scene luminance that reads as mid grey (the house's
// EXPOSURE_KEY / exposure). Glows and lights scale by (v / ref)^k: partial compensation, so effects still look brighter
// in a dark room but neither blow the whole frame out at night nor look dull in a sunlit room.
export const FX_ADAPT = { ref: 0.3, sprites: 0.75, lights: 0.6 };

const MAX_PARTICLES = 512;   // persistent particles; when full, the ones closest to death are recycled
const MAX_SPRITES = 1024;    // particles + the per-frame sprites of projectiles
const MAX_PROJ = 64, MAX_ROCKETS = 24, MAX_HANDS = 16, MAX_FLASH = 48, MAX_REQ = 160, LIGHT_COUNT = 4;
const NB = 256;              // depth buckets of the back-to-front counting sort
const ROCKET_HALF = 0.7;     // rocket mesh half length (ft); the exhaust sits at pos - dir * ROCKET_HALF
const TAU = Math.PI * 2;

// atlas cells (4×4 grid)
const C_GLOW = 0, C_SPARK = 1, C_STAR = 2, C_RING = 3, C_FIRE = 4, C_SMOKE = 8, C_PLASMA = 11, C_BOLT = 12, C_SWIRL = 14, C_FLAME = 15;
const M_AXIAL = 16, M_FLAT = 32;   // sprite orientation, added to the cell index

// deterministic, allocation-free PRNG (mulberry32)
let seed = 0x2545f491;
function rand() {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), seed | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const rr = (a, b) => a + (b - a) * rand();
let dX = 0, dY = 1, dZ = 0;   // randDir() output
function randDir() { const y = rand() * 2 - 1, a = rand() * TAU, s = Math.sqrt(1 - y * y); dX = s * Math.cos(a); dY = y; dZ = s * Math.sin(a); }

// ------------------------------------------------------------- sprite atlas ----
// 1024² two-channel atlas of 256² cells. R = density / opacity mask, G = brightness (tint mode) or temperature (fire
// ramp mode). Everything is generated from gradient noise at startup; cells fall to zero at their borders so mip
// levels don't bleed.
function perlin(rnd) {
  const p = new Uint8Array(512);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = (rnd() * (i + 1)) | 0, t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 256; i++) p[i + 256] = p[i];
  const gr = (h, x, y) => {
    switch (h & 7) {
      case 0: return x + y; case 1: return y - x; case 2: return x - y; case 3: return -x - y;
      case 4: return x; case 5: return -x; case 6: return y; default: return -y;
    }
  };
  return (x, y) => {
    const X = Math.floor(x), Y = Math.floor(y), xf = x - X, yf = y - Y, xi = X & 255, yi = Y & 255;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = gr(p[p[xi] + yi], xf, yf), b = gr(p[p[xi + 1] + yi], xf - 1, yf);
    const c = gr(p[p[xi] + yi + 1], xf, yf - 1), d = gr(p[p[xi + 1] + yi + 1], xf - 1, yf - 1);
    const ab = a + (b - a) * u, cd = c + (d - c) * u;
    return ab + (cd - ab) * v;
  };
}
const sstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

function buildAtlas() {
  const CS = 256, W = CS * 4;
  const data = new Uint8Array(W * W * 2);
  let s = 12345;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const nz = perlin(rnd);
  const fbm = (x, y, oct) => { let a = 0, amp = 1, f = 1, n = 0; for (let i = 0; i < oct; i++) { a += nz(x * f, y * f) * amp; n += amp; amp *= 0.5; f *= 2.03; } return a / n * 1.6; };
  const ridge = (x, y, oct) => { let a = 0, amp = 1, f = 1, n = 0; for (let i = 0; i < oct; i++) { a += (1 - Math.abs(nz(x * f, y * f) * 1.4)) * amp; n += amp; amp *= 0.55; f *= 2.1; } return Math.max(0, a / n); };
  const out = [0, 0];
  const cell = (ci, fn) => {
    const cx = (ci % 4) * CS, cy = Math.floor(ci / 4) * CS;
    for (let j = 0; j < CS; j++) for (let i = 0; i < CS; i++) {
      const u = (i + 0.5) / CS * 2 - 1, v = (j + 0.5) / CS * 2 - 1;   // v grows downward (flipY off)
      fn(u, v, Math.hypot(u, v), out);
      const k = ((cy + j) * W + cx + i) * 2;
      data[k] = Math.max(0, Math.min(255, out[0] * 255 + 0.5));
      data[k + 1] = Math.max(0, Math.min(255, out[1] * 255 + 0.5));
    }
  };
  const edge = r => 1 - sstep(0.82, 0.99, r);
  // soft glow: tight bright centre with a long bloom-like tail
  cell(C_GLOW, (u, v, r, o) => { o[0] = o[1] = (Math.exp(-r * r * 9) * 0.62 + Math.exp(-r * 3.6) * 0.38) * edge(r) / 1.0; });
  // spark: small hot dot with a faint halo (stretched along the velocity for streaks)
  cell(C_SPARK, (u, v, r, o) => { o[0] = o[1] = (Math.exp(-r * r * 26) * 0.85 + Math.exp(-r * r * 5) * 0.2) * edge(r); });
  // star burst: a few long rays, many short ones, hot centre
  const rays = [];
  for (let k = 0; k < 14; k++) rays.push({ a: k < 5 ? k / 5 * TAU + rnd() * 0.3 : rnd() * TAU, l: k < 5 ? 0.85 + rnd() * 0.12 : 0.35 + rnd() * 0.4, w: k < 5 ? 0.035 : 0.025 });
  cell(C_STAR, (u, v, r, o) => {
    const th = Math.atan2(v, u);
    let f = Math.exp(-r * r * 40) + Math.exp(-r * r * 7) * 0.3;
    for (const ry of rays) {
      let d = Math.abs(th - ry.a) % TAU; if (d > Math.PI) d = TAU - d;
      const x = d * r / (ry.w * (1 - r / ry.l * 0.6));
      if (r < ry.l) f += Math.exp(-x * x) * Math.pow(1 - r / ry.l, 1.4) * 0.9;
    }
    o[0] = o[1] = Math.min(1, f) * edge(r);
  });
  // ring (shockwaves, telefog floor ring)
  cell(C_RING, (u, v, r, o) => {
    const n = fbm(u * 3 + 7, v * 3 + 1, 3);
    const f = Math.exp(-Math.pow((r - 0.74) / 0.075, 2)) * (0.8 + 0.25 * n) + Math.exp(-Math.pow((r - 0.62) / 0.22, 2)) * 0.22;
    o[0] = o[1] = Math.max(0, f) * edge(r);
  });
  // fire puffs: billowy noisy blobs; G = temperature, hottest at the centre
  for (let k = 0; k < 4; k++) {
    const ox = rnd() * 50, oy = rnd() * 50, ox2 = rnd() * 50, oy2 = rnd() * 50;
    cell(C_FIRE + k, (u, v, r, o) => {
      const n1 = fbm(u * 1.9 + ox, v * 1.9 + oy, 5), n2 = fbm(u * 4.6 + ox2, v * 4.6 + oy2, 4);
      const e = r + n1 * 0.36;
      let dens = 1 - sstep(0.3, 0.88, e);
      dens *= Math.min(1, Math.max(0, 0.78 + 0.35 * n2));
      const temp = (1 - sstep(0.0, 0.82, r + n1 * 0.42 - n2 * 0.22)) * Math.sqrt(dens);
      o[0] = dens * edge(r); o[1] = Math.min(1, temp * 1.05) * edge(r);
    });
  }
  // smoke puffs: softer, lumpier; G = shading (a little lighter on top)
  for (let k = 0; k < 3; k++) {
    const ox = rnd() * 50, oy = rnd() * 50, ox2 = rnd() * 50, oy2 = rnd() * 50;
    cell(C_SMOKE + k, (u, v, r, o) => {
      const n1 = fbm(u * 1.6 + ox, v * 1.6 + oy, 5), n2 = fbm(u * 3.8 + ox2, v * 3.8 + oy2, 4);
      const e = r + n1 * 0.42;
      const dens = (1 - sstep(0.18, 0.92, e)) * Math.min(1, Math.max(0, 0.62 + 0.4 * n2));
      const sh = 0.72 + 0.2 * (-v) + 0.18 * n2;
      o[0] = dens * edge(r); o[1] = dens * Math.min(1, Math.max(0.3, sh)) * edge(r);
    });
  }
  // plasma: white-hot core inside a web of electric filaments
  cell(C_PLASMA, (u, v, r, o) => {
    const f = Math.pow(ridge(u * 2.1 + 3.3, v * 2.1 + 9.1, 4), 7) * Math.exp(-r * r * 3.2) * 1.3;
    o[0] = o[1] = Math.min(1, Math.exp(-r * r * 16) + f + Math.exp(-r * r * 4) * 0.18) * edge(r);
  });
  // lightning crackle, two variants
  for (let k = 0; k < 2; k++) {
    const ox = rnd() * 40, oy = rnd() * 40;
    cell(C_BOLT + k, (u, v, r, o) => {
      const f = Math.pow(ridge(u * 1.7 + ox, v * 1.7 + oy, 3), 16) * 1.6 * (1 - sstep(0.45, 0.95, r));
      o[0] = o[1] = Math.min(1, f) * edge(r);
    });
  }
  // swirl: spiral arms around a bright core (BFG ball, telefog mist)
  cell(C_SWIRL, (u, v, r, o) => {
    const th = Math.atan2(v, u), n = fbm(u * 2.5 + 11, v * 2.5 + 5, 4);
    const arm = Math.pow(0.5 + 0.5 * Math.sin(3 * th + r * 9 + n * 1.6), 3);
    const f = arm * (1 - sstep(0.1, 0.92, r)) * (0.7 + 0.3 * n) + Math.exp(-r * r * 10) * 0.55;
    o[0] = o[1] = Math.min(1, Math.max(0, f)) * edge(r);
  });
  // flame lick: teardrop lying along +u (base at u ≈ 0.55, tip toward −u); axial sprites put the base at the head
  cell(C_FLAME, (u, v, r, o) => {
    const a = 0.55 - u;                 // distance from the base toward the tip
    const n = fbm(u * 3.2 + 2.2, v * 3.2 + 8.4, 4);
    const vv = v + n * 0.12 * Math.max(0, a);
    let d;
    if (a < 0) d = Math.hypot(a, vv) / 0.36;
    else d = Math.abs(vv) / Math.max(0.01, 0.36 * Math.pow(Math.max(0, 1 - a / 1.5), 0.85));
    const dens = (1 - sstep(0.35, 1.0, d)) * (1 - sstep(1.2, 1.5, a));
    const temp = dens * Math.pow(Math.max(0, 1 - Math.max(0, a) / 1.5), 0.8) * (0.85 + 0.2 * n);
    const w = 1 - sstep(0.9, 0.99, Math.max(Math.abs(u), Math.abs(v)));
    o[0] = dens * w; o[1] = Math.min(1, temp * 1.1) * w;
  });
  const tex = new THREE.DataTexture(data, W, W, THREE.RGFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

// ------------------------------------------------------------ sprite shader ----
const VS = /* glsl */`
attribute vec4 iPos;   // centre xyz, half size
attribute vec4 iCol;   // linear rgb, opacity
attribute vec4 iPar;   // rotation, cell + 16 * mode, additive 0..1, heat (0 = tint mode)
attribute vec4 iStr;   // axis (axial mode, the quad runs from pos - axis to pos), depth pull (× size)
varying vec2 vUv;
varying vec4 vCol;
varying vec2 vMix;
void main() {
  float mode = floor(iPar.y / 16.0 + 0.01);
  float cell = iPar.y - mode * 16.0;
  vec2 c = position.xy;
  float s = iPos.w;
  float cr = cos(iPar.x), sr = sin(iPar.x);
  vec3 ctr = (modelViewMatrix * vec4(iPos.xyz, 1.0)).xyz;
  vec3 ax, ay;
  float nf = 1.0;
  if (mode > 1.5) {            // flat on the floor, facing up
    ax = (modelViewMatrix * vec4(cr * s, 0.0, sr * s, 0.0)).xyz;
    ay = (modelViewMatrix * vec4(sr * s, 0.0, -cr * s, 0.0)).xyz;
  } else {
    if (mode > 0.5) {          // axial billboard: streaks, exhaust flames, columns
      vec3 A = (modelViewMatrix * vec4(iStr.xyz, 0.0)).xyz;
      float L = length(A);
      ctr -= A * 0.5;
      vec3 d = L > 1e-5 ? A / L : vec3(1.0, 0.0, 0.0);
      vec3 w = cross(d, normalize(ctr));
      float wl = length(w);
      w = wl > 1e-5 ? w / wl : vec3(0.0, 1.0, 0.0);
      ax = d * (L * 0.5 + s); ay = w * s;
    } else {
      ax = vec3(cr, sr, 0.0) * s; ay = vec3(-sr, cr, 0.0) * s;
    }
    float dist = length(ctr);
    // near fade: nothing pops into the eye, and smoke (alpha-blended) thins out as the eye gets into it instead
    // of filling the view
    nf = smoothstep(0.25, 1.0, dist) * mix(smoothstep(0.5, 3.0, dist - s * 0.5), 1.0, iPar.z);
    // slide big sprites toward the eye along the view ray (same apparent size) so walls and floors don't slice them
    float pull = min(iStr.w * s, max(dist - 0.6, 0.0));
    float f = (dist - pull) / max(dist, 1e-4);
    ctr *= f; ax *= f; ay *= f;
  }
  gl_Position = projectionMatrix * vec4(ctr + ax * c.x + ay * c.y, 1.0);
  vUv = (vec2(mod(cell, 4.0), floor(cell / 4.0 + 0.01)) + vec2(0.5 + c.x * 0.5, 0.5 - c.y * 0.5)) * 0.25;
  vCol = vec4(iCol.rgb, iCol.a * nf);
  vMix = iPar.zw;
}`;
const FS = /* glsl */`
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vCol;
varying vec2 vMix;
void main() {
  vec4 t = texture2D(map, vUv);
  // fire ramp: temperature → dark red → orange → yellow → white, brighter as it gets hotter
  float T = t.g * vMix.y;
  vec3 fire = vec3(smoothstep(0.0, 0.4, T), smoothstep(0.22, 0.8, T), smoothstep(0.6, 1.3, T)) * (0.25 + T) * t.r;
  vec3 rgb = (vMix.y > 0.0 ? fire : vec3(t.g)) * vCol.rgb * vCol.a;
  // premultiplied: alpha 0 adds light (fire), alpha 1 covers (smoke)
  gl_FragColor = vec4(rgb, t.r * vCol.a * (1.0 - vMix.x));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------- rocket mesh ----
function rocketGeometry() {
  const paint = (g, hex) => {
    const c = new THREE.Color(hex), n = g.attributes.position.count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const lathe = (pts, hex) => paint(new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p[0], p[1])), 14), hex);
  const R = 0.12, parts = [];
  // built along +y (tail at −0.7, tip at +0.7), then turned to +z
  parts.push(lathe([[0.055, -0.66], [0.07, -0.72], [0.1, -0.72], [0.108, -0.64], [R, -0.6]], 0x2c2d2e));            // nozzle
  parts.push(lathe([[R, -0.6], [R, -0.1], [R + 0.006, -0.08], [R + 0.006, 0.02], [R, 0.04], [R, 0.2]], 0x5d6242));  // olive body + seam
  parts.push(lathe([[R, 0.2], [R + 0.004, 0.2], [R + 0.004, 0.27], [R, 0.27]], 0xc9a227));                          // yellow band
  const nose = [];
  for (let i = 0; i <= 8; i++) { const t = i / 8; nose.push([R * Math.pow(1 - t, 0.62) * (1 - t * 0.04), 0.27 + t * 0.45]); }
  nose[8][0] = 0;
  parts.push(lathe(nose, 0x3a3d33));                                                                                 // warhead
  for (let k = 0; k < 4; k++) {
    const fin = new THREE.BoxGeometry(0.016, 0.3, 0.13);
    fin.translate(0, -0.46, R + 0.06);
    fin.rotateY(k * Math.PI / 2 + Math.PI / 4);
    parts.push(paint(fin, 0x46483f));
  }
  const merged = mergeGeometries(parts, false);
  merged.rotateX(Math.PI / 2);
  merged.computeBoundingSphere();
  return merged;
}

// ------------------------------------------------------------------ fx ----
export function createFx({ scene, camera }) {
  const root = new THREE.Group();
  root.name = 'fx';
  scene.add(root);

  // ---- sprite mesh
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const gAttr = [];
  for (const name of ['iPos', 'iCol', 'iPar', 'iStr']) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPRITES * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    a.fxRange = { start: 0, count: 0 };
    geo.setAttribute(name, a);
    gAttr.push(a);
  }
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: buildAtlas() } }, vertexShader: VS, fragmentShader: FS,
    transparent: true, depthWrite: false, premultipliedAlpha: true, blending: THREE.NormalBlending,
    side: THREE.DoubleSide,   // floor decals seen from below, mirrored views
  });
  const mesh = new THREE.Mesh(geo, mat);
  const noPick = () => {};   // its base quad sits at the world origin: never a hit for a scene-wide raycast
  mesh.raycast = noPick;
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;
  root.add(mesh);

  // staging (unsorted) sprite data
  const sPos = new Float32Array(MAX_SPRITES * 4), sCol = new Float32Array(MAX_SPRITES * 4);
  const sPar = new Float32Array(MAX_SPRITES * 4), sStr = new Float32Array(MAX_SPRITES * 4);
  const sDep = new Float32Array(MAX_SPRITES), sKey = new Uint16Array(MAX_SPRITES), order = new Uint16Array(MAX_SPRITES);
  const bucket = new Uint32Array(NB + 1);
  let nSpr = 0;
  let camX = 0, camY = 0, camZ = 0, fwX = 0, fwY = 0, fwZ = -1;

  // ---- light pool: fixed count so every lit shader compiles once
  const lights = [];
  for (let i = 0; i < LIGHT_COUNT; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 10, 2);
    l.name = `fxLight${i}`;
    scene.add(l);
    lights.push(l);
  }
  const rq = new Float32Array(MAX_REQ * 8), rqId = new Int32Array(MAX_REQ);
  let nReq = 0;
  const selQ = new Int32Array(LIGHT_COUNT), selS = new Float32Array(LIGHT_COUNT), prevId = new Int32Array(LIGHT_COUNT).fill(-1);
  const lightI = new Float32Array(LIGHT_COUNT);
  const tmpC = new THREE.Color();

  // ---- rocket meshes
  const rocketMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.42, envMapIntensity: 1 });
  const rocketGeo = rocketGeometry();
  const rocketPool = [];
  for (let i = 0; i < MAX_ROCKETS; i++) {
    const m = new THREE.Mesh(rocketGeo, rocketMat);
    m.visible = false;
    m.raycast = noPick;   // raycasters ignore visibility; pooled rockets wait at their last position
    m.name = 'fxRocket';
    root.add(m);
    rocketPool.push(m);
  }
  const Z_AXIS = new THREE.Vector3(0, 0, 1), tmpV = new THREE.Vector3();

  let time = 0, frame = 0, visible = true;
  const ambient = { r: 0.3, g: 0.3, b: 0.3 };
  let adaptS = 1, adaptL = 1, kS = 1;   // glow and light scale from setAmbient; kS applies adaptS to direct sprites
  const warned = new Set();
  const warnOnce = msg => { if (!warned.has(msg)) { warned.add(msg); console.warn(msg); } };

  // ---------------------------------------------------------- particles ----
  // one float record per particle
  const PX = 0, PY = 1, PZ = 2, VX = 3, VY = 4, VZ = 5, AGE = 6, LIFE = 7, DRAG = 8, GRAV = 9, S0 = 10, S1 = 11, SPOW = 12,
    ROT = 13, RV = 14, CELL = 15, FRAMES = 16, FPS = 17, FPH = 18, CR = 19, CG = 20, CB = 21, ER = 22, EG = 23, EB = 24,
    CRATE = 25, LIT = 26, ALPHA = 27, FIN = 28, FOUT = 29, H0 = 30, H1 = 31, ADD0 = 32, ADD1 = 33, STRETCH = 34, PULL = 35,
    FLICK = 36, MODE = 37, AX = 38, AY = 39, AZ = 40, OX = 41, OZ = 42, ORB = 43, ORBV = 44, ANG = 45, ANGV = 46, WOB = 47,
    WOBF = 48, WPH = 49, GRP = 50, NF = 51;
  const pd = new Float32Array(MAX_PARTICLES * NF);
  const pOn = new Uint8Array(MAX_PARTICLES);
  const freeP = new Int32Array(MAX_PARTICLES);
  let nFree = 0, nLive = 0;
  for (let i = MAX_PARTICLES - 1; i >= 0; i--) freeP[nFree++] = i;

  // ---------------------------------------------------------- occlusion ----
  // Particles don't collide and big sprites slide toward the eye, so an explosion on the far side of a partition (an
  // imp's fireball hitting the wall the player ducked behind) would show through it. Given a line-of-sight test
  // (fx.setSight), each explosion / BFG spray / telefog is a group whose origin is re-tested from the camera ~10×/s:
  // a group the camera can't see fades out and its light dims. Groups are reference counted by their particles and
  // flash, so they free themselves when the effect ends. 1-based ids in the records, 0 = no group.
  const MAX_GRP = 48;
  const gPos = new Float32Array(MAX_GRP * 4), gVis = new Float32Array(MAX_GRP).fill(1), gTgt = new Float32Array(MAX_GRP);
  const gNext = new Float32Array(MAX_GRP), gRef = new Int32Array(MAX_GRP);
  let sightFn = null, curGrp = 0, nextGrp = 0;
  // r: rough visible radius of the effect (see seen())
  function group(x, y, z, r) {
    if (!sightFn) return 0;
    for (let n = 0; n < MAX_GRP; n++) {
      const g = (nextGrp + n) % MAX_GRP;
      if (gRef[g] > 0) continue;
      nextGrp = (g + 1) % MAX_GRP;
      gPos[g * 4] = x; gPos[g * 4 + 1] = y; gPos[g * 4 + 2] = z; gPos[g * 4 + 3] = r;
      gVis[g] = -1; gNext[g] = -1;   // tested on the next update, then shown or hidden outright
      return g + 1;
    }
    return 0;   // all busy: this effect just isn't occlusion tested
  }
  // the origin, or else a point half the radius to either side or the radius above it (as the camera sees it), so an
  // explosion just around a corner or behind a sofa still shows
  function seen(g) {
    const e = camera.matrixWorld.elements, o = g * 4, x = gPos[o], y = gPos[o + 1], z = gPos[o + 2], h = gPos[o + 3] * 0.5;
    return !!(sightFn(camX, camY, camZ, x, y, z)
      || sightFn(camX, camY, camZ, x + e[0] * h, y + e[1] * h, z + e[2] * h)
      || sightFn(camX, camY, camZ, x - e[0] * h, y - e[1] * h, z - e[2] * h)
      || sightFn(camX, camY, camZ, x + e[4] * h * 2, y + e[5] * h * 2, z + e[6] * h * 2));
  }
  function stepGroups(dt) {
    if (!sightFn) return;
    const k = Math.min(1, dt * 12);
    for (let g = 0; g < MAX_GRP; g++) {
      if (gRef[g] <= 0) continue;
      if (time >= gNext[g]) {
        gNext[g] = time + 0.1;
        gTgt[g] = seen(g) ? 1 : 0;
        if (gVis[g] < 0) { gVis[g] = gTgt[g]; continue; }
      }
      gVis[g] += (gTgt[g] - gVis[g]) * k;
    }
  }
  const grpVis = g => (g > 0 && sightFn && gVis[g - 1] >= 0 ? gVis[g - 1] : 1);
  function unref(g) { if (g > 0) gRef[g - 1]--; }

  // spawn description, filled by the effect functions then copied by emit()
  // mode: 0 billboard, 1 streak along the velocity (× stretch s), 2 fixed axis (ax, ay, az), 3 flat on the floor
  // lit: 1 → end colour × ambient (smoke turning grey), 2 → both colours × ambient
  const P = {};
  function pReset() {
    P.x = 0; P.y = 0; P.z = 0; P.vx = 0; P.vy = 0; P.vz = 0; P.life = 1; P.delay = 0; P.drag = 0; P.grav = 0;
    P.s0 = 0.5; P.s1 = 0.5; P.sPow = 2; P.rot = 0; P.rv = 0; P.cell = C_GLOW; P.frames = 1; P.fps = 0;
    P.r = 1; P.g = 1; P.b = 1; P.r1 = 1; P.g1 = 1; P.b1 = 1; P.cRate = 1; P.lit = 0;
    P.a = 1; P.fin = 0; P.fout = 0.5; P.h0 = 0; P.h1 = 0; P.add0 = 1; P.add1 = 1; P.stretch = 0; P.pull = 0; P.flick = 0;
    P.mode = 0; P.ax = 0; P.ay = 0; P.az = 0; P.ox = 0; P.oz = 0; P.orb = 0; P.orbV = 0; P.ang = 0; P.angV = 0;
    P.wob = 0; P.wobF = 0;
  }
  const at = (x, y, z) => { P.x = x; P.y = y; P.z = z; };
  const vel = (x, y, z) => { P.vx = x; P.vy = y; P.vz = z; };
  const col = (r, g, b) => { P.r = P.r1 = r; P.g = P.g1 = g; P.b = P.b1 = b; };
  const col1 = (r, g, b) => { P.r1 = r; P.g1 = g; P.b1 = b; };

  function emit() {
    let i;
    if (nFree > 0) i = freeP[--nFree];
    else {   // pool full: recycle the sampled particle nearest the end of its life
      let best = 0, left = Infinity;
      for (let k = 0; k < 24; k++) {
        const j = (rand() * MAX_PARTICLES) | 0, o = j * NF, l = pd[o + LIFE] - pd[o + AGE];
        if (l < left) { left = l; best = j; }
      }
      i = best; nLive--;
      unref(pd[i * NF + GRP]);
    }
    pOn[i] = 1; nLive++;
    const o = i * NF;
    pd[o + GRP] = curGrp;
    if (curGrp) gRef[curGrp - 1]++;
    pd[o + PX] = P.x; pd[o + PY] = P.y; pd[o + PZ] = P.z; pd[o + VX] = P.vx; pd[o + VY] = P.vy; pd[o + VZ] = P.vz;
    pd[o + AGE] = -P.delay; pd[o + LIFE] = P.life; pd[o + DRAG] = P.drag; pd[o + GRAV] = P.grav;
    pd[o + S0] = P.s0; pd[o + S1] = P.s1; pd[o + SPOW] = P.sPow; pd[o + ROT] = P.rot; pd[o + RV] = P.rv;
    pd[o + CELL] = P.cell; pd[o + FRAMES] = P.frames; pd[o + FPS] = P.fps; pd[o + FPH] = rand() * 8;
    pd[o + CR] = P.r; pd[o + CG] = P.g; pd[o + CB] = P.b; pd[o + ER] = P.r1; pd[o + EG] = P.g1; pd[o + EB] = P.b1;
    pd[o + CRATE] = P.cRate; pd[o + LIT] = P.lit; pd[o + ALPHA] = P.a; pd[o + FIN] = P.fin; pd[o + FOUT] = P.fout;
    pd[o + H0] = P.h0; pd[o + H1] = P.h1; pd[o + ADD0] = P.add0; pd[o + ADD1] = P.add1; pd[o + STRETCH] = P.stretch;
    pd[o + PULL] = P.pull; pd[o + FLICK] = P.flick; pd[o + MODE] = P.mode; pd[o + AX] = P.ax; pd[o + AY] = P.ay; pd[o + AZ] = P.az;
    pd[o + OX] = P.ox; pd[o + OZ] = P.oz; pd[o + ORB] = P.orb; pd[o + ORBV] = P.orbV; pd[o + ANG] = P.ang; pd[o + ANGV] = P.angV;
    pd[o + WOB] = P.wob; pd[o + WOBF] = P.wobF; pd[o + WPH] = rand() * TAU;
  }
  function kill(i) { pOn[i] = 0; freeP[nFree++] = i; nLive--; unref(pd[i * NF + GRP]); }

  // ------------------------------------------------------------- sprites ----
  function spr(x, y, z, s, rot, cm, r, g, b, a, add, heat, ax, ay, az, pull) {
    if (nSpr >= MAX_SPRITES || a <= 0.003 || s <= 0) return;
    const k = nSpr * 4;
    sPos[k] = x; sPos[k + 1] = y; sPos[k + 2] = z; sPos[k + 3] = s;
    sCol[k] = r * kS; sCol[k + 1] = g * kS; sCol[k + 2] = b * kS; sCol[k + 3] = a;
    sPar[k] = rot; sPar[k + 1] = cm; sPar[k + 2] = add; sPar[k + 3] = heat;
    sStr[k] = ax; sStr[k + 1] = ay; sStr[k + 2] = az; sStr[k + 3] = pull;
    sDep[nSpr++] = (x - camX) * fwX + (y - camY) * fwY + (z - camZ) * fwZ;
  }
  const bb = (x, y, z, s, rot, cell, r, g, b, heat, pull) => spr(x, y, z, s, rot, cell, r, g, b, 1, 1, heat, 0, 0, 0, pull);

  function stepParticles(dt) {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (!pOn[i]) continue;
      const o = i * NF;
      const age = pd[o + AGE] + dt;
      pd[o + AGE] = age;
      if (age < 0) continue;                       // delayed start
      const life = pd[o + LIFE];
      if (age >= life) { kill(i); continue; }
      const tdt = Math.min(dt, age);              // a particle that just started only moves for its own age
      // motion: exponential drag, gravity (negative = buoyant), wobble, optional orbit around a vertical axis
      const dr = pd[o + DRAG] > 0 ? Math.exp(-pd[o + DRAG] * tdt) : 1;
      const vx = pd[o + VX] * dr, vy = pd[o + VY] * dr - pd[o + GRAV] * tdt, vz = pd[o + VZ] * dr;
      pd[o + VX] = vx; pd[o + VY] = vy; pd[o + VZ] = vz;
      let x = pd[o + PX], y = pd[o + PY] + vy * tdt, z = pd[o + PZ], svx = vx, svz = vz;
      if (pd[o + ORB] > 0) {
        const a = pd[o + ANG] + pd[o + ANGV] * tdt, r = Math.max(0.03, pd[o + ORB] + pd[o + ORBV] * tdt);
        pd[o + ANG] = a; pd[o + ORB] = r;
        x = pd[o + OX] + Math.cos(a) * r; z = pd[o + OZ] + Math.sin(a) * r;
        svx = -Math.sin(a) * r * pd[o + ANGV]; svz = Math.cos(a) * r * pd[o + ANGV];
      } else { x += vx * tdt; z += vz * tdt; }
      if (pd[o + WOB] > 0) {
        const ph = pd[o + WPH] + age * pd[o + WOBF], w = pd[o + WOB] * tdt;
        x += Math.sin(ph) * w; z += Math.cos(ph * 1.37) * w;
        if (pd[o + ORB] > 0) { pd[o + OX] += Math.sin(ph) * w; pd[o + OZ] += Math.cos(ph * 1.37) * w; }
      }
      pd[o + PX] = x; pd[o + PY] = y; pd[o + PZ] = z;
      const rot = pd[o + ROT] + pd[o + RV] * tdt;
      pd[o + ROT] = rot;

      // look over life
      const u = age / life;
      const s0 = pd[o + S0], sz = s0 + (pd[o + S1] - s0) * (1 - Math.pow(1 - u, pd[o + SPOW]));
      let a = pd[o + ALPHA];
      const fin = pd[o + FIN], fout = pd[o + FOUT];
      if (u < fin) { const k = u / fin; a *= k * k * (3 - 2 * k); }
      if (u > fout) { const k = (u - fout) / (1 - fout); a *= 1 - k * k * (3 - 2 * k); }
      a *= grpVis(pd[o + GRP]);
      const tc = Math.min(1, u * pd[o + CRATE]), lit = pd[o + LIT];
      let r0 = pd[o + CR], g0 = pd[o + CG], b0 = pd[o + CB], r1 = pd[o + ER], g1 = pd[o + EG], b1 = pd[o + EB];
      if (lit > 0) {
        r1 *= ambient.r; g1 *= ambient.g; b1 *= ambient.b;
        if (lit > 1) { r0 *= ambient.r; g0 *= ambient.g; b0 *= ambient.b; } else { r0 *= adaptS; g0 *= adaptS; b0 *= adaptS; }
      } else { r0 *= adaptS; g0 *= adaptS; b0 *= adaptS; r1 *= adaptS; g1 *= adaptS; b1 *= adaptS; }
      let r = r0 + (r1 - r0) * tc, g = g0 + (g1 - g0) * tc, b = b0 + (b1 - b0) * tc;
      const fl = pd[o + FLICK];
      if (fl > 0) { const m = 1 + fl * (rand() * 2 - 1); r *= m; g *= m; b *= m; }
      let cell = pd[o + CELL];
      const frames = pd[o + FRAMES];
      if (frames > 1) cell += Math.floor(age * pd[o + FPS] + pd[o + FPH]) % frames;
      const mode = pd[o + MODE];
      let ax = 0, ay = 0, az = 0;
      if (mode === 1) { const k = pd[o + STRETCH]; ax = svx * k; ay = vy * k; az = svz * k; }
      else if (mode === 2) { ax = pd[o + AX]; ay = pd[o + AY]; az = pd[o + AZ]; }
      const h0 = pd[o + H0];
      const heat = h0 > 0 ? Math.max(0.002, h0 + (pd[o + H1] - h0) * u) : 0;
      const add = pd[o + ADD0] + (pd[o + ADD1] - pd[o + ADD0]) * u;
      spr(x, y, z, sz, rot, cell + (mode === 3 ? M_FLAT : mode ? M_AXIAL : 0), r, g, b, a, add, heat, ax, ay, az, pd[o + PULL]);
    }
  }

  // ------------------------------------------------------------ lights ----
  function req(id, x, y, z, r, g, b, I, rad) {
    if (nReq >= MAX_REQ || I <= 0.01) return;
    const o = nReq * 8;
    rq[o] = x; rq[o + 1] = y; rq[o + 2] = z; rq[o + 3] = r; rq[o + 4] = g; rq[o + 5] = b; rq[o + 6] = I; rq[o + 7] = rad;
    rqId[nReq++] = id;
  }
  function reqDef(id, def, x, y, z, k) {
    tmpC.setHex(def.color);
    req(id, x, y, z, tmpC.r, tmpC.g, tmpC.b, def.intensity * k, def.radius);
  }
  function assignLights() {
    for (let k = 0; k < LIGHT_COUNT; k++) { selQ[k] = -1; selS[k] = 0; }
    for (let q = 0; q < nReq; q++) {
      const o = q * 8, dx = rq[o] - camX, dy = rq[o + 1] - camY, dz = rq[o + 2] - camZ, r2 = rq[o + 7] * rq[o + 7];
      // roughly how much of the view the light brightens; a small bonus for last frame's picks avoids flicker
      let s = rq[o + 6] * r2 / (r2 + dx * dx + dy * dy + dz * dz);
      const id = rqId[q];
      for (let k = 0; k < LIGHT_COUNT; k++) if (prevId[k] === id) { s *= 1.3; break; }
      if (selQ[LIGHT_COUNT - 1] >= 0 && s <= selS[LIGHT_COUNT - 1]) continue;
      let k = LIGHT_COUNT - 1;
      while (k > 0 && (selQ[k - 1] < 0 || s > selS[k - 1])) { selS[k] = selS[k - 1]; selQ[k] = selQ[k - 1]; k--; }
      selS[k] = s; selQ[k] = q;
    }
    for (let k = 0; k < LIGHT_COUNT; k++) {
      const L = lights[k], q = selQ[k];
      if (q < 0) { lightI[k] = 0; L.intensity = 0; prevId[k] = -1; continue; }
      const o = q * 8;
      L.position.set(rq[o], rq[o + 1], rq[o + 2]);
      L.color.setRGB(rq[o + 3], rq[o + 4], rq[o + 5]);
      L.distance = rq[o + 7];
      lightI[k] = rq[o + 6];
      lightI[k] *= adaptL;
      L.intensity = visible ? lightI[k] : 0;
      prevId[k] = rqId[q];
    }
  }

  // one-shot light flashes: x y z r g b I rad dur age flicker shape group
  const FLN = 13;
  const fla = new Float32Array(MAX_FLASH * FLN), flOn = new Uint8Array(MAX_FLASH);
  function addFlash(x, y, z, r, g, b, I, rad, dur, flick, shape) {
    let i = -1, worst = Infinity;
    for (let k = 0; k < MAX_FLASH; k++) {
      if (!flOn[k]) { i = k; break; }
      const o = k * FLN, left = fla[o + 6] * (1 - fla[o + 9] / fla[o + 8]);
      if (left < worst) { worst = left; i = k; }
    }
    const o = i * FLN;
    if (flOn[i]) unref(fla[o + 12]);
    flOn[i] = 1;
    fla[o] = x; fla[o + 1] = y; fla[o + 2] = z; fla[o + 3] = r; fla[o + 4] = g; fla[o + 5] = b;
    // a zero or negative radius would mean "no cutoff" to three.js: the light would reach the whole house
    fla[o + 6] = I; fla[o + 7] = Math.max(0.5, rad); fla[o + 8] = Math.max(0.01, dur); fla[o + 9] = 0; fla[o + 10] = flick; fla[o + 11] = shape;
    fla[o + 12] = curGrp;
    if (curGrp) gRef[curGrp - 1]++;
  }
  function flashDef(def, x, y, z, flick, k = 1) {
    tmpC.setHex(def.color);
    addFlash(x, y, z, tmpC.r, tmpC.g, tmpC.b, def.intensity * k, def.radius, def.duration, flick, 1);
  }
  function stepFlashes(dt) {
    for (let i = 0; i < MAX_FLASH; i++) {
      if (!flOn[i]) continue;
      const o = i * FLN, age = fla[o + 9] + dt;
      if (age >= fla[o + 8]) { flOn[i] = 0; unref(fla[o + 12]); continue; }
      fla[o + 9] = age;
      const u = age / fla[o + 8];
      // shape 0: holds then drops (muzzle flash); shape 1: fast attack, long fade (explosions)
      let e = fla[o + 11] < 0.5 ? 1 - u * u * (3 - 2 * u) : (1 - u) * (1 - u) * Math.min(1, age * 40);
      if (fla[o + 10] > 0) e *= 1 - fla[o + 10] * rand();
      // an unseen explosion still lights its surroundings (the lights have no shadows), just less
      e *= 0.4 + 0.6 * grpVis(fla[o + 12]);
      req(i, fla[o], fla[o + 1], fla[o + 2], fla[o + 3], fla[o + 4], fla[o + 5], fla[o + 6] * e, fla[o + 7]);
    }
  }

  // --------------------------------------------------------- projectiles ----
  // Handles are pooled too. Each slot owns two handle objects and alternates them on every reuse, and slots are
  // taken round-robin, so a stale handle (kept after remove() or after fx.clear()) goes inert instead of steering
  // whichever effect reuses its slot next.
  const KINDS = { fireball: 0, rocket: 1, plasma: 2, bfg: 3 };
  const NULL_HANDLE = { setPos() {}, setDir() {}, setScale() {}, remove() {} };
  const projs = [];
  function projHandle(p) {
    const h = {
      setPos(x, y, z) {
        if (p.handle !== h || !p.on) return;
        if (!p.placed) { p.placed = true; p.px = p.ex = x; p.py = p.ey = y; p.pz = p.ez = z; }
        p.x = x; p.y = y; p.z = z;
      },
      setDir(x, y, z) {
        const l = Math.hypot(x, y, z);
        if (p.handle !== h || !p.on || l < 1e-6) return;
        p.dx = x / l; p.dy = y / l; p.dz = z / l; p.dirSet = true;
      },
      setScale() {},
      remove() { if (p.handle === h) releaseProj(p); },
    };
    return h;
  }
  for (let i = 0; i < MAX_PROJ; i++) {
    const p = { i, on: false, kind: 0, placed: false, x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, ex: 0, ey: 0, ez: 0,
      dx: 0, dy: 0, dz: -1, dirSet: false, age: 0, ph: 0, trav: 0, mesh: null, handle: null, hs: null, hi: 0 };
    p.hs = [projHandle(p), projHandle(p)];
    p.handle = p.hs[0];
    projs.push(p);
  }
  let nextProj = 0;
  function releaseProj(p) {
    if (!p.on) return;
    p.on = false;
    if (p.mesh) { p.mesh.visible = false; rocketPool.push(p.mesh); p.mesh = null; }
  }
  function projectile(kind) {
    const k = KINDS[kind];
    if (k === undefined) { warnOnce(`fx.projectile: unknown kind '${kind}'`); return NULL_HANDLE; }
    let p = null;
    for (let n = 0; n < MAX_PROJ; n++) {
      const c = projs[(nextProj + n) % MAX_PROJ];
      if (!c.on) { p = c; break; }
    }
    if (!p) { warnOnce('fx.projectile: pool exhausted'); return NULL_HANDLE; }
    nextProj = (p.i + 1) % MAX_PROJ;
    p.on = true; p.kind = k; p.placed = false; p.dirSet = false; p.age = 0; p.ph = rand() * 100; p.trav = 0;
    p.dx = 0; p.dy = 0; p.dz = -1;
    p.hi ^= 1; p.handle = p.hs[p.hi];
    if (k === 1 && rocketPool.length) p.mesh = rocketPool.pop();
    return p.handle;
  }

  const hands = [];
  function handHandle(h) {
    const o = {
      setPos(x, y, z) { if (h.handle === o && h.on) { h.x = x; h.y = y; h.z = z; h.placed = true; } },
      setScale(s) { if (h.handle === o && h.on) h.s = Math.max(0, Math.min(1.5, s || 0)); },
      setDir() {},
      remove() { if (h.handle === o) h.on = false; },
    };
    return o;
  }
  for (let i = 0; i < MAX_HANDS; i++) {
    const h = { i, on: false, placed: false, x: 0, y: 0, z: 0, s: 0, ph: 0, acc: 0, handle: null, hs: null, hi: 0 };
    h.hs = [handHandle(h), handHandle(h)];
    h.handle = h.hs[0];
    hands.push(h);
  }
  let nextHand = 0;
  function handFireball() {
    for (let n = 0; n < MAX_HANDS; n++) {
      const h = hands[(nextHand + n) % MAX_HANDS];
      if (h.on) continue;
      nextHand = (h.i + 1) % MAX_HANDS;
      h.on = true; h.placed = false; h.s = 0; h.ph = rand() * 100; h.acc = 0;
      h.hi ^= 1; h.handle = h.hs[h.hi];
      return h.handle;
    }
    warnOnce('fx.handFireball: pool exhausted');
    return NULL_HANDLE;
  }

  // flying fireball / forming fireball body: two counter-rotating layers of churning flame (partly opaque, so they
  // stay orange instead of summing to white) around a yellow heart, inside a red-orange glow
  function fireballBody(x, y, z, sc, ph) {
    const t = time + ph, B = FX_BRIGHT.fire, f = 0.88 + 0.24 * rand(), fr = Math.floor(t * 15), F = 3.6 * B;
    bb(x, y, z, 1.3 * sc, 0, C_GLOW, 1.45 * f * B, 0.34 * f * B, 0.05 * f * B, 0, 0.5);
    spr(x, y, z, 0.62 * sc, t * 2.3, C_FIRE + (fr & 3), F, F, F, 1, 0.45, 0.8, 0, 0, 0, 0.5);
    spr(x, y, z, 0.47 * sc, 1.7 - t * 3.1, C_FIRE + ((fr + 2) & 3), F, F, F, 1, 0.6, 1.02, 0, 0, 0, 0.5);
    bb(x, y, z, 0.17 * sc, 0, C_GLOW, 4.4 * f * B, 2.7 * f * B, 0.9 * f * B, 0, 0.5);
  }

  function stepProjectiles(dt) {
    for (let i = 0; i < MAX_PROJ; i++) {
      const p = projs[i];
      if (!p.on) continue;
      if (!p.placed) { if (p.mesh) p.mesh.visible = false; continue; }
      p.age += dt;
      if (!p.dirSet) {   // no explicit direction: follow the motion
        const mx = p.x - p.px, my = p.y - p.py, mz = p.z - p.pz, l = Math.hypot(mx, my, mz);
        if (l > 1e-4) { p.dx = mx / l; p.dy = my / l; p.dz = mz / l; }
      }
      trail(p, dt);
      const x = p.x, y = p.y, z = p.z, dx = p.dx, dy = p.dy, dz = p.dz, t = time + p.ph;
      if (p.kind === 0) {
        const F = 3.4 * FX_BRIGHT.fire, len = 1.05 + 0.25 * rand();
        spr(x, y, z, 0.34, 0, C_FLAME + M_AXIAL, F, F, F, 1, 0.7, 0.85, dx * len, dy * len, dz * len, 0.3);
        fireballBody(x, y, z, 1, p.ph);
        reqDef(100 + i, FX_LIGHTS.fireball, x, y, z, 0.8 + 0.3 * rand());
      } else if (p.kind === 1) {
        const m = p.mesh;
        if (m) {
          m.visible = true;
          m.position.set(x, y, z);
          tmpV.set(dx, dy, dz);
          m.quaternion.setFromUnitVectors(Z_AXIS, tmpV);
          m.rotateZ(p.age * 5);
        }
        // exhaust: an orange flame with a shorter white-hot one inside, a hot spot at the nozzle and a soft glow
        const tx = x - dx * ROCKET_HALF, ty = y - dy * ROCKET_HALF, tz = z - dz * ROCKET_HALF;
        const F = 4.2 * FX_BRIGHT.fire, f = 0.85 + 0.3 * rand(), len = 1.1 + 0.5 * rand(), l2 = len * 0.45;
        spr(tx, ty, tz, 0.22, 0, C_FLAME + M_AXIAL, F, F, F, 1, 1, 0.9, dx * len, dy * len, dz * len, 0);
        spr(tx, ty, tz, 0.12, 0, C_FLAME + M_AXIAL, F, F, F, 1, 1, 1.35, dx * l2, dy * l2, dz * l2, 0);
        bb(tx - dx * 0.05, ty - dy * 0.05, tz - dz * 0.05, 0.17, 0, C_GLOW, 9 * f, 7 * f, 4.5 * f, 0, 0);
        bb(tx, ty, tz, 1.0, 0, C_GLOW, 1.3 * f, 0.55 * f, 0.13 * f, 0, 0.3);
        reqDef(100 + i, FX_LIGHTS.rocket, tx - dx * 0.4, ty - dy * 0.4, tz - dz * 0.4, f);
      } else if (p.kind === 2) {
        const B = FX_BRIGHT.plasma, f = 0.8 + 0.4 * rand();
        bb(x, y, z, 0.85, 0, C_GLOW, 0.3 * B * f, 0.62 * B * f, 2.2 * B * f, 0, 0.3);
        bb(x, y, z, 0.42, rand() * TAU, C_PLASMA, 1.3 * B, 2.8 * B, 8 * B, 0, 0.3);
        bb(x, y, z, 0.3, rand() * TAU, C_PLASMA, 2 * B, 3.8 * B, 9 * B, 0, 0.3);
        bb(x, y, z, 0.14, 0, C_GLOW, 6 * B, 8 * B, 12 * B, 0, 0.3);
        spr(x, y, z, 0.12, 0, C_GLOW + M_AXIAL, 0.5 * B, 1.1 * B, 3.2 * B, 0.8, 1, 0, dx * 0.9, dy * 0.9, dz * 0.9, 0.2);
        reqDef(100 + i, FX_LIGHTS.plasma, x, y, z, f);
      } else {
        const B = FX_BRIGHT.bfg, f = 0.85 + 0.3 * rand();
        bb(x, y, z, 2.6, 0, C_GLOW, 0.22 * B * f, 1.2 * B * f, 0.22 * B * f, 0, 0.5);
        bb(x, y, z, 1.05, t * 4.5, C_SWIRL, 0.7 * B, 3.8 * B, 0.6 * B, 0, 0.5);
        bb(x, y, z, 0.92, 1 - t * 6.3, C_SWIRL, 0.9 * B, 4.2 * B, 0.8 * B, 0, 0.5);
        bb(x, y, z, 0.74, rand() * TAU, C_PLASMA, 1.3 * B, 5 * B, 1.3 * B, 0, 0.5);
        if (rand() < 0.7) bb(x, y, z, 1.35, rand() * TAU, C_BOLT + (rand() < 0.5 ? 1 : 0), 2 * B, 7 * B, 2 * B, 0, 0.5);
        bb(x, y, z, 0.42, 0, C_GLOW, 6 * B, 14 * B, 6 * B, 0, 0.5);
        reqDef(100 + i, FX_LIGHTS.bfg, x, y, z, f);
      }
      p.px = x; p.py = y; p.pz = z;
    }
  }

  // Trail particles are laid along the path travelled since the last emission, pre-aged by how long ago the
  // projectile passed each point, so fast projectiles leave an even trail.
  const SPACING = [0.2, 0.3, 0.45, 0.5];
  function trail(p, dt) {
    const mx = p.x - p.ex, my = p.y - p.ey, mz = p.z - p.ez, len = Math.hypot(mx, my, mz), sp = SPACING[p.kind];
    if (len < sp) return;
    if (len > 12) { p.ex = p.x; p.ey = p.y; p.ez = p.z; return; }   // teleported
    const n = Math.floor(len / sp);
    const ux = mx / len, uy = my / len, uz = mz / len;
    for (let k = 1; k <= n; k++) {
      const d = k * sp, x = p.ex + ux * d, y = p.ey + uy * d, z = p.ez + uz * d;
      const pre = dt * (1 - d / len);   // how long ago the projectile was here
      p.trav += sp;
      trailPart(p, x, y, z, pre);
    }
    p.ex += ux * n * sp; p.ey += uy * n * sp; p.ez += uz * n * sp;
  }
  function trailPart(p, x, y, z, pre) {
    const dx = p.dx, dy = p.dy, dz = p.dz;
    if (p.kind === 0) {           // fireball: overlapping flame puffs cooling from orange to deep red, now and then a spark
      const F = 3.3 * FX_BRIGHT.fire;
      pReset(); at(x + rr(-0.06, 0.06), y + rr(-0.06, 0.06), z + rr(-0.06, 0.06)); P.delay = -pre;
      vel(-dx * 1.5 + rr(-0.4, 0.4), 0.9 + rr(0, 0.8), -dz * 1.5 + rr(-0.4, 0.4)); P.drag = 3;
      P.life = rr(0.13, 0.2); P.cell = C_FIRE + ((rand() * 4) | 0); P.s0 = rr(0.3, 0.36); P.s1 = 0.06; P.sPow = 1;
      P.rot = rand() * TAU; P.rv = rr(-5, 5); col(F, F, F);
      P.h0 = 0.85; P.h1 = 0.22; P.add0 = 0.75; P.add1 = 0.5; P.fout = 0.35; P.pull = 0.3;
      emit();
      if (rand() < 0.14) {
        pReset(); at(x, y, z); P.delay = -pre; randDir();
        vel(dX * 2.5 - dx * 3, dY * 2.5 + 1, dZ * 2.5 - dz * 3); P.grav = 6; P.drag = 1.5;
        P.life = rr(0.25, 0.5); P.cell = C_SPARK; P.s0 = 0.05; P.s1 = 0.03; P.mode = 1; P.stretch = 0.04;
        const S = FX_BRIGHT.spark; col(8 * S, 3.5 * S, 0.9 * S); col1(2.5 * S, 0.5 * S, 0.08 * S); P.fout = 0.5;
        emit();
      }
    } else if (p.kind === 1) {    // rocket: a light grey smoke trail (lit by the exhaust at first) and a few sparks
      pReset(); at(x - dx * ROCKET_HALF + rr(-0.04, 0.04), y - dy * ROCKET_HALF + rr(-0.04, 0.04), z - dz * ROCKET_HALF + rr(-0.04, 0.04));
      P.delay = -pre;
      vel(-dx * 2.5 + rr(-0.35, 0.35), rr(0.2, 0.6), -dz * 2.5 + rr(-0.35, 0.35)); P.drag = 1.6; P.grav = -0.5;
      P.life = rr(1.0, 1.5); P.cell = C_SMOKE + ((rand() * 3) | 0); P.s0 = 0.2; P.s1 = rr(0.7, 0.95); P.sPow = 2.5;
      P.rot = rand() * TAU; P.rv = rr(-1.2, 1.2); col(1.7, 0.8, 0.3);
      const S = FX_SMOKE.trail; col1(S, S * 0.98, S * 0.95); P.lit = 1; P.cRate = 7;
      // the motor builds up its plume over the first few feet, so a rocket doesn't smoke up the shooter's view
      P.a = 0.5 * Math.min(1, 0.08 + Math.max(0, p.trav - 1.5) / 4.5);
      P.fin = 0.04; P.fout = 0.4; P.add0 = 0.7; P.add1 = 0; P.pull = 0.3;
      emit();
      if (rand() < 0.18) {
        pReset(); at(x - dx * ROCKET_HALF, y - dy * ROCKET_HALF, z - dz * ROCKET_HALF); P.delay = -pre; randDir();
        vel(dX * 3 - dx * 6, dY * 3, dZ * 3 - dz * 6); P.grav = 8; P.drag = 1.5;
        P.life = rr(0.2, 0.4); P.cell = C_SPARK; P.s0 = 0.045; P.s1 = 0.03; P.mode = 1; P.stretch = 0.035;
        const Sp = FX_BRIGHT.spark; col(9 * Sp, 6 * Sp, 2.5 * Sp); col1(3 * Sp, 0.8 * Sp, 0.1 * Sp); P.fout = 0.5;
        emit();
      }
    } else if (p.kind === 2) {    // plasma: a scatter of blue sparkles thrown off the ball (random, so no dotted line)
      if (rand() < 0.45) return;
      const B = FX_BRIGHT.plasma;
      randDir();
      pReset(); at(x + dX * 0.12, y + dY * 0.12, z + dZ * 0.12); P.delay = -pre;
      const sp = rr(1.5, 3.5); vel(dX * sp, dY * sp, dZ * sp); P.drag = 3;
      P.life = rr(0.1, 0.2); P.cell = C_SPARK; P.s0 = rr(0.05, 0.075); P.s1 = 0.012; P.sPow = 1;
      col(2.2 * B, 4 * B, 11 * B); col1(0.3 * B, 0.7 * B, 3.5 * B); P.fout = 0.25;
      emit();
    } else {                       // BFG: a short tail of green wisps and sparkles
      const B = FX_BRIGHT.bfg;
      pReset(); at(x + rr(-0.22, 0.22), y + rr(-0.22, 0.22), z + rr(-0.22, 0.22)); P.delay = -pre;
      vel(-dx * 1.5 + rr(-0.5, 0.5), rr(-0.3, 0.6), -dz * 1.5 + rr(-0.5, 0.5)); P.drag = 2;
      P.life = rr(0.16, 0.26); P.cell = C_PLASMA; P.s0 = rr(0.45, 0.58); P.s1 = 0.1; P.sPow = 1;
      P.rot = rand() * TAU; P.rv = rr(-6, 6); col(0.5 * B, 2.4 * B, 0.5 * B); col1(0.06 * B, 0.5 * B, 0.06 * B); P.fout = 0.25;
      emit();
      pReset(); at(x, y, z); P.delay = -pre; randDir();
      vel(dX * 4, dY * 4, dZ * 4); P.drag = 2.5;
      P.life = rr(0.25, 0.45); P.cell = C_SPARK; P.s0 = 0.08; P.s1 = 0.025; P.mode = 1; P.stretch = 0.05;
      col(3 * B, 10 * B, 3 * B); col1(0.4 * B, 2.5 * B, 0.4 * B); P.fout = 0.4;
      emit();
    }
  }

  function stepHands(dt) {
    for (let i = 0; i < MAX_HANDS; i++) {
      const h = hands[i];
      if (!h.on || !h.placed || h.s <= 0.01) continue;
      const s = h.s;
      fireballBody(h.x, h.y, h.z, s, h.ph);
      // flame licks and sparks rising off the forming ball
      h.acc += dt * 22 * s;
      while (h.acc >= 1) {
        h.acc -= 1;
        pReset(); at(h.x + rr(-0.12, 0.12) * s, h.y + 0.1 * s, h.z + rr(-0.12, 0.12) * s);
        vel(rr(-0.4, 0.4), rr(2, 3.2), rr(-0.4, 0.4)); P.drag = 1;
        P.life = rr(0.2, 0.32); P.cell = C_FLAME; P.rot = -Math.PI / 2 + rr(-0.3, 0.3);
        P.s0 = rr(0.2, 0.3) * s; P.s1 = 0.06; P.sPow = 1;
        const F = 4.2 * FX_BRIGHT.fire; col(F, F, F); P.h0 = 1.1; P.h1 = 0.35; P.fout = 0.4;
        emit();
        if (rand() < 0.3) {
          pReset(); at(h.x, h.y, h.z); randDir();
          vel(dX * 1.5, 2 + rand() * 2, dZ * 1.5); P.grav = -1; P.drag = 1;
          P.life = rr(0.3, 0.6); P.cell = C_SPARK; P.s0 = 0.045; P.s1 = 0.02; P.mode = 1; P.stretch = 0.05;
          const S = FX_BRIGHT.spark; col(8 * S, 3.5 * S, 0.9 * S); col1(2 * S, 0.4 * S, 0.05 * S); P.fout = 0.5;
          emit();
        }
      }
      reqDef(200 + i, FX_LIGHTS.handFire, h.x, h.y, h.z, s * s * (0.8 + 0.3 * rand()));
    }
  }

  // ------------------------------------------------------------ effects ----
  const px = p => p.x, py = p => p.y, pz = p => p.z;

  function sparks(x, y, z, n, spMin, spMax, grav, lifeMin, lifeMax, size, stretch, r, g, b, r1, g1, b1, nx, ny, nz, cone) {
    const S = FX_BRIGHT.spark;
    for (let i = 0; i < n; i++) {
      pReset(); randDir();
      let vx = dX, vy = dY, vz = dZ;
      if (cone > 0) {   // bias toward a normal: cone 1 = hemisphere-ish, larger = tighter
        vx = nx * cone + dX; vy = ny * cone + dY; vz = nz * cone + dZ;
        const l = Math.hypot(vx, vy, vz) || 1; vx /= l; vy /= l; vz /= l;
      }
      const sp = rr(spMin, spMax);
      at(x, y, z); vel(vx * sp, vy * sp, vz * sp); P.grav = grav; P.drag = 1.2;
      P.life = rr(lifeMin, lifeMax); P.cell = C_SPARK; P.s0 = size; P.s1 = size * 0.6; P.sPow = 1;
      P.mode = 1; P.stretch = stretch; col(r * S, g * S, b * S); col1(r1 * S, g1 * S, b1 * S); P.fout = 0.55;
      emit();
    }
  }

  function smoke(x, y, z, n, spread, sMin, sMax, s1Min, s1Max, lifeMin, lifeMax, delay, alpha, rise, er, eg, eb, albedo) {
    const S = albedo;
    for (let i = 0; i < n; i++) {
      pReset(); randDir();
      const sp = rr(0.3, 1) * spread;
      at(x + dX * 0.2, y + dY * 0.2, z + dZ * 0.2); vel(dX * sp, dY * sp * 0.6 + rise, dZ * sp); P.drag = 2; P.grav = -rise * 0.6;
      P.life = rr(lifeMin, lifeMax); P.delay = delay * rr(0.6, 1.4); P.cell = C_SMOKE + ((rand() * 3) | 0);
      P.s0 = rr(sMin, sMax); P.s1 = rr(s1Min, s1Max); P.sPow = 2.2; P.rot = rand() * TAU; P.rv = rr(-0.8, 0.8);
      col(er, eg, eb); col1(S, S * 0.97, S * 0.93); P.lit = 1;   // starts lit by the fire, turns room-lit grey
      P.cRate = 3; P.a = alpha; P.fin = 0.12; P.fout = 0.45; P.add0 = 0.4; P.add1 = 0; P.pull = 0.5;
      emit();
    }
  }

  // add0 / add1: additive share at birth / death (below 1 the puffs occlude each other instead of summing to white,
  // and turn into dark soot as they cool)
  function firePuffs(x, y, z, n, spMin, spMax, sMin, sMax, s1Min, s1Max, lifeMin, lifeMax, heat, intensity, add0, add1) {
    const F = intensity * FX_BRIGHT.fire;
    for (let i = 0; i < n; i++) {
      pReset(); randDir();
      const sp = rr(spMin, spMax);
      at(x + dX * 0.25, y + dY * 0.25, z + dZ * 0.25); vel(dX * sp, dY * sp + 1, dZ * sp); P.drag = 5; P.grav = -3;
      P.life = rr(lifeMin, lifeMax); P.cell = C_FIRE + (i & 3); P.s0 = rr(sMin, sMax); P.s1 = rr(s1Min, s1Max); P.sPow = 3;
      P.rot = rand() * TAU; P.rv = rr(-2.5, 2.5); col(F, F, F); P.h0 = heat * rr(0.9, 1.1); P.h1 = 0.08;
      P.fin = 0.03; P.fout = 0.5; P.add0 = add0; P.add1 = add1; P.pull = 0.6; P.flick = 0.06;
      emit();
    }
  }

  function glow(x, y, z, s0, s1, life, r, g, b, cell = C_GLOW, fout = 0, pull = 1) {
    pReset(); at(x, y, z); P.cell = cell; P.life = life; P.s0 = s0; P.s1 = s1; P.rot = rand() * TAU;
    col(r, g, b); P.fout = fout; P.pull = pull;
    emit();
  }

  function explosion(pos, kind = 'rocket') {
    const x = px(pos), y = py(pos), z = pz(pos);
    curGrp = group(x, y, z, EXP_R[kind] || 1);
    explode(pos, x, y, z, kind);
    curGrp = 0;
  }
  const EXP_R = { rocket: 2.5, fireball: 1.3, plasma: 1, bfg: 4 };   // visible radius (ft), for the occlusion test
  function explode(pos, x, y, z, kind) {
    const F = FX_BRIGHT.fire;
    if (kind === 'rocket') {
      flashDef(FX_LIGHTS.expRocket, x, y, z, 0.25);
      glow(x, y, z, 1.6, 3.2, 0.1, 7 * F, 5 * F, 3 * F, C_STAR);
      glow(x, y, z, 2.6, 5.5, 0.45, 1.6 * F, 0.62 * F, 0.16 * F);
      glow(x, y, z, 0.6, 6.5, 0.16, 0.4 * F, 0.24 * F, 0.1 * F, C_RING);   // shock ring
      firePuffs(x, y, z, 16, 5, 13, 0.7, 1.2, 2.1, 3.1, 0.6, 1.05, 1.45, 4, 0.55, 0.15);
      firePuffs(x, y, z, 4, 0.5, 2, 0.9, 1.3, 1.6, 2.1, 0.3, 0.45, 1.7, 4.5, 0.6, 0.6);   // white-hot heart
      smoke(x, y, z, 12, 4, 1.2, 1.6, 3.2, 4.2, 2.2, 3.2, 0.12, 0.62, 1.5, 1.2, 0.45, 0.12, FX_SMOKE.rocket);
      sparks(x, y, z, 24, 14, 34, 26, 0.3, 0.85, 0.055, 0.035, 10, 6.5, 2.5, 4, 1.1, 0.12, 0, 0, 0, 0);
      embers(pos, 10, 1.2, 0);
    } else if (kind === 'fireball') {
      flashDef(FX_LIGHTS.expFireball, x, y, z, 0.2);
      glow(x, y, z, 1.0, 1.8, 0.1, 8 * F, 5 * F, 2.4 * F, C_STAR);
      glow(x, y, z, 1.5, 2.9, 0.32, 2.4 * F, 0.9 * F, 0.2 * F);
      firePuffs(x, y, z, 10, 1.5, 3.8, 0.4, 0.55, 1.1, 1.5, 0.35, 0.6, 1.35, 4.5, 0.7, 0.4);
      sparks(x, y, z, 12, 6, 16, 22, 0.2, 0.5, 0.045, 0.03, 9, 4, 1.1, 3, 0.6, 0.08, 0, 0, 0, 0);
      smoke(x, y, z, 3, 1.5, 0.45, 0.6, 1.3, 1.7, 0.9, 1.3, 0.14, 0.35, 1.2, 1.6, 0.6, 0.18, FX_SMOKE.fireball);
    } else if (kind === 'plasma') {
      const B = FX_BRIGHT.plasma;
      flashDef(FX_LIGHTS.expPlasma, x, y, z, 0.3);
      glow(x, y, z, 0.8, 1.5, 0.12, 4 * B, 6 * B, 13 * B, C_STAR);
      glow(x, y, z, 1.3, 2.3, 0.35, 0.35 * B, 0.9 * B, 3 * B);
      glow(x, y, z, 0.25, 1.7, 0.26, 1.1 * B, 2.1 * B, 6 * B, C_RING);
      for (let i = 0; i < 6; i++) {
        pReset(); randDir(); at(x, y, z); const sp = rr(1, 3); vel(dX * sp, dY * sp, dZ * sp); P.drag = 4;
        P.life = rr(0.25, 0.45); P.cell = C_PLASMA; P.s0 = rr(0.25, 0.35); P.s1 = rr(0.7, 0.95); P.rot = rand() * TAU; P.rv = rr(-9, 9);
        col(1.5 * B, 3 * B, 8 * B); col1(0.25 * B, 0.7 * B, 3 * B); P.fout = 0.3; P.pull = 0.4;
        emit();
      }
      for (let i = 0; i < 3; i++) {   // electric crackle
        pReset(); at(x, y, z); P.life = 0.1; P.delay = i * 0.055; P.cell = C_BOLT + (i & 1); P.s0 = 0.9; P.s1 = 1.2; P.rot = rand() * TAU;
        col(2.2 * B, 4.4 * B, 11 * B); P.fout = 0.3; P.pull = 0.4;
        emit();
      }
      sparks(x, y, z, 18, 7, 20, 10, 0.18, 0.45, 0.05, 0.03, 4 * B, 7 * B, 14 * B, 0.8 * B, 1.6 * B, 5 * B, 0, 0, 0, 0);
    } else if (kind === 'bfg') {
      const B = FX_BRIGHT.bfg;
      flashDef(FX_LIGHTS.expBfg, x, y, z, 0.2);
      glow(x, y, z, 4, 7.5, 0.22, 5 * B, 14 * B, 5 * B, C_STAR);
      glow(x, y, z, 4, 7.5, 1.05, 0.3 * B, 1.7 * B, 0.3 * B, C_GLOW, 0.15);
      glow(x, y, z, 0.8, 10, 0.4, 0.8 * B, 3.2 * B, 0.8 * B, C_RING);
      glow(x, y, z, 0.5, 7, 0.6, 0.4 * B, 1.8 * B, 0.4 * B, C_RING, 0.3);
      for (let i = 0; i < 22; i++) {
        pReset(); randDir(); const sp = rr(5, 13); at(x + dX * 0.3, y + dY * 0.3, z + dZ * 0.3);
        vel(dX * sp, dY * sp, dZ * sp); P.drag = 3.5; P.grav = -1;
        P.life = rr(0.85, 1.35); P.cell = i & 1 ? C_SWIRL : C_PLASMA; P.s0 = rr(1.0, 1.4); P.s1 = rr(2.6, 3.6); P.sPow = 2.5;
        P.rot = rand() * TAU; P.rv = rr(-2, 2); col(1.1 * B, 5 * B, 1.1 * B); col1(0.08 * B, 0.8 * B, 0.08 * B);
        P.fin = 0.02; P.fout = 0.35; P.pull = 0.6; P.flick = 0.1;
        emit();
      }
      for (let i = 0; i < 6; i++) {
        pReset(); randDir(); at(x + dX * 0.4, y + dY * 0.4, z + dZ * 0.4); vel(dX * 2, dY * 2, dZ * 2); P.drag = 3;
        P.life = rr(0.4, 0.55); P.cell = C_PLASMA; P.s0 = 1.6; P.s1 = 2.9; P.rot = rand() * TAU; P.rv = rr(-4, 4);
        col(3.5 * B, 9 * B, 3.5 * B); col1(0.4 * B, 2 * B, 0.4 * B); P.fout = 0.2; P.pull = 0.6;
        emit();
      }
      for (let i = 0; i < 7; i++) {
        pReset(); randDir(); at(x + dX * 1.2, y + dY * 1.2, z + dZ * 1.2); P.life = rr(0.08, 0.14); P.delay = rr(0, 0.65);
        P.cell = C_BOLT + (i & 1); P.s0 = P.s1 = rr(2, 3.4); P.rot = rand() * TAU; col(2.5 * B, 8 * B, 2.5 * B); P.fout = 0.3; P.pull = 0.6;
        emit();
      }
      sparks(x, y, z, 42, 15, 40, 12, 0.4, 1.0, 0.07, 0.04, 4 * B, 12 * B, 4 * B, 0.5 * B, 3 * B, 0.5 * B, 0, 0, 0, 0);
      greenEmbers(x, y, z, 16, 2.5);
    } else warnOnce(`fx.explosion: unknown kind '${kind}'`);
  }

  function greenEmbers(x, y, z, n, rad) {
    const B = FX_BRIGHT.bfg;
    for (let i = 0; i < n; i++) {
      pReset(); randDir(); at(x + dX * rad, y + dY * rad * 0.6, z + dZ * rad);
      vel(dX * 0.8, rr(0.8, 2.2), dZ * 0.8); P.drag = 0.6; P.grav = -0.6; P.wob = 1.5; P.wobF = rr(4, 8);
      P.life = rr(1.1, 2.1); P.delay = rr(0, 0.3); P.cell = C_SPARK; P.s0 = rr(0.07, 0.11); P.s1 = 0.03; P.sPow = 1;
      col(3 * B, 10 * B, 3 * B); col1(0.3 * B, 2 * B, 0.3 * B); P.fin = 0.05; P.fout = 0.4; P.flick = 0.35;
      emit();
    }
  }

  // bullet hitting a wall: tiny flash, a few sparks off the surface, a grey puff that rises and a little grit
  function puff(pos, normal) {
    let nx = 0, ny = 1, nz = 0;
    if (normal) { const l = Math.hypot(normal.x, normal.y, normal.z); if (l > 1e-6) { nx = normal.x / l; ny = normal.y / l; nz = normal.z / l; } }
    const x = px(pos) + nx * 0.05, y = py(pos) + ny * 0.05, z = pz(pos) + nz * 0.05;
    const Sp = FX_BRIGHT.spark;
    pReset(); at(x, y, z); P.cell = C_STAR; P.life = 0.06; P.s0 = 0.3; P.s1 = 0.36; P.rot = rand() * TAU; col(7 * Sp, 5.5 * Sp, 3.5 * Sp); P.fout = 0; P.pull = 1;
    emit();
    sparks(x, y, z, 3 + ((rand() * 3) | 0), 9, 22, 30, 0.1, 0.28, 0.03, 0.025, 10, 7, 3.5, 4, 1.4, 0.3, nx, ny, nz, 1.3);
    // dust: light grey (plaster / wood dust catching the light), lighter than a mid-grey wall so it reads on most
    // surfaces; the texture's own shading keeps darker lumps that read on white walls
    const S = FX_SMOKE.dust;
    for (let i = 0; i < 3; i++) {
      pReset(); at(x + nx * 0.1 + rr(-0.05, 0.05), y + ny * 0.1 + rr(-0.05, 0.05), z + nz * 0.1 + rr(-0.05, 0.05));
      const out = i ? rr(0.6, 1.4) : rr(1.4, 2.2);
      vel(nx * out + rr(-0.3, 0.3), ny * out * 0.6 + rr(0.9, 1.6), nz * out + rr(-0.3, 0.3)); P.drag = 2.6; P.grav = -1.2;
      P.life = rr(0.45, 0.65); P.cell = C_SMOKE + ((rand() * 3) | 0); P.s0 = rr(0.12, 0.16); P.s1 = i ? rr(0.45, 0.56) : rr(0.62, 0.75); P.sPow = 2.2;
      P.rot = rand() * TAU; P.rv = rr(-1.5, 1.5); col(S, S, S * 0.96); P.lit = 2; P.a = 0.9; P.fin = 0.06; P.fout = 0.35;
      P.add0 = P.add1 = 0; P.pull = 0.8;
      emit();
    }
    for (let i = 0; i < 3; i++) {
      pReset(); randDir(); at(x, y, z);
      const sp = rr(2.5, 5);
      vel((nx + dX * 0.8) * sp, (ny + dY * 0.8) * sp + 1, (nz + dZ * 0.8) * sp); P.grav = 26; P.drag = 1;
      P.life = rr(0.3, 0.5); P.cell = C_SPARK; P.s0 = P.s1 = 0.028; P.mode = 1; P.stretch = 0.012;
      col(0.4, 0.38, 0.35); P.lit = 2; P.a = 1; P.fout = 0.7; P.add0 = P.add1 = 0;
      emit();
    }
  }

  // bullet / pellet / claw hitting an imp: a red-orange burst of embers (no blood)
  function hitSpark(pos) {
    const x = px(pos), y = py(pos), z = pz(pos), F = FX_BRIGHT.fire;
    glow(x, y, z, 0.5, 0.85, 0.12, 6 * F, 2.2 * F, 0.6 * F, C_GLOW, 0, 0.8);
    glow(x, y, z, 0.32, 0.62, 0.06, 7 * F, 3 * F, 1.1 * F, C_STAR, 0, 0.8);
    pReset(); at(x, y, z); P.cell = C_FIRE + ((rand() * 4) | 0); P.life = 0.22; P.s0 = 0.3; P.s1 = 0.7; P.rot = rand() * TAU; P.rv = rr(-4, 4);
    col(4 * F, 4 * F, 4 * F); P.h0 = 1.0; P.h1 = 0.2; P.add0 = 0.8; P.add1 = 0.5; P.fout = 0.3; P.pull = 0.8;
    emit();
    sparks(x, y, z, 14, 6, 16, 20, 0.2, 0.5, 0.05, 0.03, 8, 2.6, 0.55, 3, 0.4, 0.03, 0, 0, 0, 0);
    for (let i = 0; i < 5; i++) {
      pReset(); randDir(); at(x, y, z); vel(dX * 2, dY * 2 + 1, dZ * 2); P.grav = 5; P.drag = 1.5;
      P.life = rr(0.35, 0.6); P.cell = C_SPARK; P.s0 = rr(0.07, 0.1); P.s1 = 0.03; P.sPow = 1;
      col(6 * F, 1.8 * F, 0.35 * F); col1(1.5 * F, 0.2 * F, 0.02 * F); P.fout = 0.4; P.flick = 0.3;
      emit();
    }
  }

  // green burst on a monster hit by a BFG tracer. Combat sprays once per tracer that connects, so a close imp takes a
  // dozen in the same frame: the first one bursts, the repeats (within 1.5 ft, before the next update) only add
  // sparks, instead of stacking a dozen additive bursts and lights into a white blob.
  const sprayAt = new Float32Array(16 * 4);   // x y z group of this frame's bursts
  let nSpray = 0, sprayFrame = -1;
  function bfgSpray(pos) {
    const x = px(pos), y = py(pos), z = pz(pos), B = FX_BRIGHT.bfg;
    if (sprayFrame !== frame) { sprayFrame = frame; nSpray = 0; }
    for (let k = 0; k < nSpray; k++) {
      const o = k * 4;
      if (Math.abs(sprayAt[o] - x) + Math.abs(sprayAt[o + 1] - y) + Math.abs(sprayAt[o + 2] - z) > 1.5) continue;
      curGrp = sprayAt[o + 3];
      sparks(x, y, z, 3, 5, 12, 6, 0.3, 0.6, 0.06, 0.04, 3 * B, 10 * B, 3 * B, 0.5 * B, 3 * B, 0.5 * B, 0, 0, 0, 0);
      curGrp = 0;
      return;
    }
    curGrp = group(x, y, z, 1.2);
    if (nSpray < 16) { const o = nSpray++ * 4; sprayAt[o] = x; sprayAt[o + 1] = y; sprayAt[o + 2] = z; sprayAt[o + 3] = curGrp; }
    spray(x, y, z, B);
    curGrp = 0;
  }
  function spray(x, y, z, B) {
    flashDef(FX_LIGHTS.bfgSpray, x, y, z, 0.25);
    glow(x, y, z, 1.2, 2.4, 0.5, 0.45 * B, 2.6 * B, 0.5 * B, C_GLOW, 0.2);
    glow(x, y, z, 0.6, 1.3, 0.12, 3 * B, 9 * B, 3 * B, C_STAR);
    for (let i = 0; i < 7; i++) {
      pReset(); randDir(); at(x + dX * 0.3, y + dY * 0.3, z + dZ * 0.3); vel(dX * 1.8, dY * 1.2 + 1.6, dZ * 1.8); P.drag = 2;
      P.life = rr(0.6, 0.9); P.cell = i & 1 ? C_SWIRL : C_PLASMA; P.s0 = rr(0.45, 0.6); P.s1 = rr(1.3, 1.8); P.rot = rand() * TAU; P.rv = rr(-3, 3);
      col(0.9 * B, 4.5 * B, 0.9 * B); col1(0.1 * B, 1 * B, 0.1 * B); P.fout = 0.3; P.pull = 0.5;
      emit();
    }
    sparks(x, y, z, 12, 5, 12, 6, 0.3, 0.6, 0.06, 0.04, 3 * B, 10 * B, 3 * B, 0.5 * B, 3 * B, 0.5 * B, 0, 0, 0, 0);
  }

  // teleport fog at a floor point: a shimmering green column, sparks spiralling up, a ring on the floor
  function telefog(pos) {
    const x = px(pos), y = py(pos), z = pz(pos);
    curGrp = group(x, y + 3, z, 2);   // tested from mid column up: furniture in front of its foot doesn't hide it
    fog(x, y, z, FX_BRIGHT.telefog);
    curGrp = 0;
  }
  function fog(x, y, z, T) {
    flashDef(FX_LIGHTS.telefog, x, y + 3, z, 0.35);
    glow(x, y + 3.2, z, 1.8, 3.6, 0.35, 1.2 * T, 4 * T, 1.4 * T);
    // columns: axial glows, a wide soft one and a bright narrow core
    for (let i = 0; i < 2; i++) {
      pReset(); at(x, y + 6.8, z); P.mode = 2; P.ax = 0; P.ay = 6.4; P.az = 0; P.cell = C_GLOW; P.life = 1.5;
      P.s0 = i ? 0.55 : 1.9; P.s1 = i ? 0.2 : 1.3; P.sPow = 1;
      if (i) col(1.1 * T, 4.2 * T, 1.3 * T); else col(0.3 * T, 1.6 * T, 0.45 * T);
      P.fin = 0.1; P.fout = 0.45; P.flick = 0.25; P.pull = 0.3;
      emit();
    }
    // spiralling sparks, filling the column from the floor to head height and beyond
    for (let i = 0; i < 56; i++) {
      pReset(); P.ox = x; P.oz = z; P.orb = rr(1.0, 1.9); P.orbV = -rr(0.3, 0.8); P.ang = rand() * TAU;
      P.angV = (i & 1 ? 1 : -1) * rr(3, 6); at(x, y + rr(0, 3.5), z); P.vy = rr(3.5, 7); P.drag = 0.5;
      P.life = rr(0.8, 1.3); P.delay = rr(0, 0.55); P.cell = C_SPARK; P.s0 = rr(0.08, 0.11); P.s1 = 0.03; P.sPow = 1;
      P.mode = 1; P.stretch = 0.06; col(2.5 * T, 8 * T, 3 * T); col1(0.5 * T, 2.8 * T, 0.8 * T); P.fin = 0.08; P.fout = 0.5; P.flick = 0.3;
      emit();
    }
    // green mist swirling up the column
    for (let i = 0; i < 16; i++) {
      pReset(); const a = rand() * TAU, r = rr(0.2, 0.9);
      at(x + Math.cos(a) * r, y + rr(0.3, 4.5), z + Math.sin(a) * r); vel(0, rr(1.2, 2.6), 0); P.drag = 0.5;
      P.life = rr(0.9, 1.4); P.delay = rr(0, 0.45); P.cell = i & 1 ? C_SWIRL : C_SMOKE + (i % 3);
      P.s0 = rr(0.8, 1.0); P.s1 = rr(1.4, 2.0); P.rot = rand() * TAU; P.rv = rr(-3, 3);
      col(0.45 * T, 2.2 * T, 0.6 * T); col1(0.06 * T, 0.6 * T, 0.14 * T); P.fin = 0.2; P.fout = 0.4; P.pull = 0.5;
      emit();
    }
    // twinkles
    for (let i = 0; i < 12; i++) {
      pReset(); const a = rand() * TAU, r = rr(0.2, 1.2);
      at(x + Math.cos(a) * r, y + rr(0.5, 6.2), z + Math.sin(a) * r); P.life = rr(0.2, 0.35); P.delay = rr(0, 1.1);
      P.cell = C_STAR; P.s0 = 0.08; P.s1 = rr(0.35, 0.55); P.rot = rand() * TAU; P.rv = rr(-3, 3);
      col(3 * T, 9 * T, 4 * T); P.fout = 0.35;
      emit();
    }
    // floor rings
    for (let i = 0; i < 2; i++) {
      pReset(); at(x, y + 0.04, z); P.mode = 3; P.cell = C_RING; P.life = 0.75; P.delay = i * 0.38;
      P.s0 = 0.5; P.s1 = 2.8; P.rot = rand() * TAU; col(0.45 * T, 2.4 * T, 0.7 * T); P.fout = 0.3;
      emit();
    }
  }

  // Rising embers in a column of radius `radius` and height `height` above `pos` (imps dissolving in fire).
  function embers(pos, count = 12, radius = 0.9, height = 5) {
    const x0 = px(pos), y0 = py(pos), z0 = pz(pos), S = FX_BRIGHT.spark, F = FX_BRIGHT.fire;
    const n = Math.min(200, count | 0);
    for (let i = 0; i < n; i++) {
      const a = rand() * TAU, r = Math.sqrt(rand()) * radius, x = x0 + Math.cos(a) * r, y = y0 + rand() * height, z = z0 + Math.sin(a) * r;
      pReset(); at(x, y, z); vel(rr(-0.4, 0.4), rr(1.8, 4.5), rr(-0.4, 0.4)); P.drag = 0.8; P.grav = -1.8;
      P.wob = rr(1.5, 3); P.wobF = rr(5, 10); P.life = rr(0.8, 1.8); P.cell = C_SPARK;
      P.s0 = rr(0.07, 0.12); P.s1 = 0.025; P.sPow = 1; P.mode = 1; P.stretch = 0.045;
      col(9 * S, 4.2 * S, 1.1 * S); col1(2.2 * S, 0.3 * S, 0.04 * S); P.fin = 0.05; P.fout = 0.45; P.flick = 0.35;
      emit();
      if (i % 3 === 0) {
        pReset(); at(x, y, z); vel(0, rr(2.2, 3.4), 0); P.drag = 1;
        P.life = rr(0.3, 0.5); P.cell = C_FLAME; P.rot = -Math.PI / 2 + rr(-0.25, 0.25);
        P.s0 = rr(0.26, 0.4); P.s1 = 0.08; P.sPow = 1; col(4.2 * F, 4.2 * F, 4.2 * F); P.h0 = 1.1; P.h1 = 0.2; P.fout = 0.35;
        emit();
      }
    }
  }

  // transient light only (muzzle flash in the world, scripted flashes)
  function flash(pos, color, intensity, radius, duration) {
    const d = FX_LIGHTS.muzzle, I = intensity ?? d.intensity;
    if (!(I > 0)) return;   // zero, negative or NaN: nothing to light
    if (color === undefined || color === null) tmpC.setHex(d.color); else tmpC.set(color);
    addFlash(px(pos), py(pos), pz(pos), tmpC.r, tmpC.g, tmpC.b, I, radius > 0 ? radius : d.radius, duration > 0 ? duration : d.duration, 0, 0);
  }

  // ------------------------------------------------------------- upload ----
  function upload() {
    const n = nSpr;
    geo.instanceCount = n;
    mesh.visible = n > 0;
    if (!n) return;
    // counting sort, far → near (additive sprites don't care; smoke needs it)
    let dmin = Infinity, dmax = -Infinity;
    for (let i = 0; i < n; i++) { const d = sDep[i]; if (d < dmin) dmin = d; if (d > dmax) dmax = d; }
    const ks = dmax - dmin > 1e-4 ? (NB - 1) / (dmax - dmin) : 0;
    bucket.fill(0);
    for (let i = 0; i < n; i++) { const k = ((dmax - sDep[i]) * ks) | 0; sKey[i] = k; bucket[k + 1]++; }
    for (let k = 1; k <= NB; k++) bucket[k] += bucket[k - 1];
    for (let i = 0; i < n; i++) order[bucket[sKey[i]]++] = i;
    const a0 = gAttr[0].array, a1 = gAttr[1].array, a2 = gAttr[2].array, a3 = gAttr[3].array;
    for (let j = 0; j < n; j++) {
      const s = order[j] * 4, d = j * 4;
      a0[d] = sPos[s]; a0[d + 1] = sPos[s + 1]; a0[d + 2] = sPos[s + 2]; a0[d + 3] = sPos[s + 3];
      a1[d] = sCol[s]; a1[d + 1] = sCol[s + 1]; a1[d + 2] = sCol[s + 2]; a1[d + 3] = sCol[s + 3];
      a2[d] = sPar[s]; a2[d + 1] = sPar[s + 1]; a2[d + 2] = sPar[s + 2]; a2[d + 3] = sPar[s + 3];
      a3[d] = sStr[s]; a3[d + 1] = sStr[s + 1]; a3[d + 2] = sStr[s + 2]; a3[d + 3] = sStr[s + 3];
    }
    for (let k = 0; k < 4; k++) {
      const a = gAttr[k];
      a.fxRange.count = n * 4;
      a.updateRanges.length = 0;
      a.updateRanges.push(a.fxRange);   // reused range object: no per-frame garbage
      a.needsUpdate = true;
    }
  }

  // --------------------------------------------------------------- api ----
  const stats = { particles: 0, sprites: 0, lights: 0, requests: 0 };
  function update(dt) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    time += dt; frame++;
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    camX = e[12]; camY = e[13]; camZ = e[14]; fwX = -e[8]; fwY = -e[9]; fwZ = -e[10];
    stepGroups(dt);
    nSpr = 0; nReq = 0;
    kS = adaptS;
    stepProjectiles(dt);   // first, so their fresh trail particles are advanced and drawn this frame
    stepHands(dt);
    kS = 1;                // particles apply the adaptation themselves (smoke follows the ambient instead)
    stepParticles(dt);
    stepFlashes(dt);
    upload();
    assignLights();
    stats.particles = nLive; stats.sprites = nSpr; stats.requests = nReq;
    let nl = 0; for (let k = 0; k < LIGHT_COUNT; k++) if (lightI[k] > 0) nl++;
    stats.lights = nl;
  }

  function setVisible(v) {
    visible = !!v;
    root.visible = visible;
    // lights stay in the scene (so the light count never changes); only their intensity follows
    for (let k = 0; k < LIGHT_COUNT; k++) lights[k].intensity = visible ? lightI[k] : 0;
  }

  // drop every effect, flying projectile and forming hand fireball (level restart); outstanding handles go inert
  function clear() {
    for (let i = 0; i < MAX_PARTICLES; i++) if (pOn[i]) kill(i);
    for (let i = 0; i < MAX_PROJ; i++) releaseProj(projs[i]);
    for (let i = 0; i < MAX_HANDS; i++) hands[i].on = false;
    flOn.fill(0);
    gRef.fill(0); nSpray = 0;
    geo.instanceCount = 0; mesh.visible = false;
    for (let k = 0; k < LIGHT_COUNT; k++) { lightI[k] = 0; lights[k].intensity = 0; prevId[k] = -1; }
    stats.particles = stats.sprites = stats.lights = stats.requests = 0;
  }

  // optional line-of-sight test fn(ax, ay, az, bx, by, bz) → true when nothing blocks the segment (combat's sight()
  // fits); null turns occlusion off
  function setSight(fn) { sightFn = typeof fn === 'function' ? fn : null; }

  // room IBL for the rocket bodies (the only lit meshes here); switching between env and none recompiles once
  function setEnv(env) {
    const e = env || null;
    if (rocketMat.envMap === e) return;
    if ((rocketMat.envMap === null) !== (e === null)) rocketMat.needsUpdate = true;
    rocketMat.envMap = e;
  }

  function setAmbient(r, g = r, b = r) {
    if (!Number.isFinite(r + g + b)) return;   // a NaN would turn every sprite black
    ambient.r = r; ambient.g = g; ambient.b = b;
    const k = Math.max(1e-4, (r + g + b) / 3) / FX_ADAPT.ref;
    adaptS = Math.min(3, Math.max(0.15, Math.pow(k, FX_ADAPT.sprites)));
    adaptL = Math.min(3, Math.max(0.15, Math.pow(k, FX_ADAPT.lights)));
  }

  return {
    update, lights, flash, puff, hitSpark, explosion, bfgSpray, telefog, embers, projectile, handFireball, setVisible,
    setEnv, setAmbient, setSight, clear, stats, root,
    reseed(n) { seed = n | 0; },   // deterministic replays (tests)
  };
}
