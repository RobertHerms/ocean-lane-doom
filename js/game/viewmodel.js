// First-person weapons (view models) and weapon pickups.
// Nine procedural weapons held in the player's hands, posed every frame from the weapon logic's state (clip name +
// tics at 35 Hz, following Doom's state tables), with additive star-burst muzzle flashes and a flash light.
// Every rigid part is ONE mesh: colour, metalness, roughness and a surface pattern (walnut grain, checkering, skin)
// are per-vertex attributes read by a patched MeshStandardMaterial, so a weapon with both hands and its moving
// parts stays within a few draw calls. Fingers close around each grip with a small solver (every joint bends until
// the next knuckle touches the grip), so the hands follow the gun's geometry instead of hand-tuned angles.
// Framing follows Doom's sprites: each gun is stylised chunkier than life (x/y `chunk`) and placed so a chosen point
// of it sits on the bottom edge of the view, pitched so we look down along it; bob, lowering and the narrow-view
// shrink are 2D shifts of the projection, so the weapon stays anchored to the bottom-centre at any aspect.
import * as THREE from 'three';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const WEAPON_IDS = ['fist', 'chainsaw', 'pistol', 'shotgun', 'ssg', 'chaingun', 'rocket', 'plasma', 'bfg'];

// ------------------------------------------------------------- tuning ----
let VFOV = 60;                   // view model camera, vertical: weapons keep their size relative to the view height
const MIN_ASPECT = 4 / 3;        // narrower views shrink the weapon about the bottom-centre instead of cropping it
const BOB = 0.06;                // bob amplitude: fraction of the view height (and of a 4:3 width for x)
const FLASH = {                  // muzzle flash per kind: sprite tint, core / halo HDR gain, halo size (× core), light colour
  bullet: { tint: [1, 1, 1], core: 8, halo: 0.55, haloSize: 1.7, light: [1, 0.62, 0.3] },
  rocket: { tint: [1, 0.85, 0.65], core: 7, halo: 0.7, haloSize: 1.9, light: [1, 0.55, 0.22] },
  plasma: { tint: [1, 1, 1], core: 7, halo: 0.6, haloSize: 1.6, light: [0.45, 0.7, 1] },
  bfg: { tint: [1, 1, 1], core: 7, halo: 0.45, haloSize: 1.6, light: [0.4, 1, 0.35] },
};
const SKIN_BERSERK = [1.25, 0.62, 0.55];   // fist skin multiplier + red glow while berserk
const SKIN_GLOW = 0.35;
const FALLBACK_ENV = 0.7;        // intensity of the neutral stand-in IBL used until the room's env is set
const D2R = Math.PI / 180;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const ramp = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const smooth = x => x * x * (3 - 2 * x);
const eout = x => 1 - (1 - x) * (1 - x);
const hash = n => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
// Recoil impulse: 0 before t0, snaps to 1 over `up` tics, eases back to 0 over the next `down` tics.
const kick = (t, t0, up, down) => (t < t0 ? 0 : t < t0 + up ? eout((t - t0) / up) : 1 - smooth(ramp(t, t0 + up, t0 + up + down)));
const V = a => new THREE.Vector3(a[0], a[1], a[2]);

// ----------------------------------------------------------- material ----
// Per-vertex attributes: colour (linear) and pbr = (metalness, roughness, pattern, emissive gain).
// Patterns: 1 walnut grain along the part's z, 2 checkered grip, 3 skin (tinted/glowing when berserk).
const FRAG_HEAD = `
varying vec4 vPbr;
varying vec3 vObj;
uniform vec3 uSkin;
uniform float uSkinGlow;
float vmHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vmNoise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(vmHash(i), vmHash(i + vec3(1, 0, 0)), f.x), mix(vmHash(i + vec3(0, 1, 0)), vmHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(vmHash(i + vec3(0, 0, 1)), vmHash(i + vec3(1, 0, 1)), f.x), mix(vmHash(i + vec3(0, 1, 1)), vmHash(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
`;
const FRAG_PATTERN = `
float vmKind = floor(vPbr.z + 0.5);
float vmN = vmNoise(vObj * 53.0) * 0.55 + vmNoise(vObj * 11.0) * 0.45;
float vmRough = vPbr.y * (0.78 + 0.44 * vmN);
if (vmKind == 1.0) {
  float w = vmNoise(vObj * vec3(6.0, 6.0, 0.7)) * 2.0 + vmNoise(vObj * vec3(17.0, 17.0, 2.2));
  float g = 0.5 + 0.5 * sin((vObj.x * 0.6 + vObj.y) * 210.0 + w * 8.0);
  float fleck = vmNoise(vObj * vec3(95.0, 95.0, 9.0));
  diffuseColor.rgb *= (1.12 - 0.5 * g * g) * (0.86 + 0.28 * fleck);
  vmRough = vPbr.y * (0.8 + 0.35 * g);
} else if (vmKind == 2.0) {
  vec3 q = vObj * 120.0;
  float c = abs(sin(q.y + q.z + q.x) * sin(q.y - q.z - q.x));
  diffuseColor.rgb *= 0.6 + 0.65 * c;
  vmRough = 0.95 - 0.35 * c;
} else if (vmKind == 3.0) {
  diffuseColor.rgb *= uSkin * (0.9 + 0.2 * vmNoise(vObj * 21.0));
  vmRough = vPbr.y * (0.85 + 0.3 * vmNoise(vObj * 60.0));
}
vec3 vmEmit = diffuseColor.rgb * vPbr.w + (vmKind == 3.0 ? uSkinGlow * vec3(1.0, 0.12, 0.05) * diffuseColor.rgb : vec3(0.0));
`;
const VIEW_UNIFORMS = { uSkin: { value: new THREE.Color(1, 1, 1) }, uSkinGlow: { value: 0 } };
const PICKUP_UNIFORMS = { uSkin: { value: new THREE.Color(1, 1, 1) }, uSkinGlow: { value: 0 } };

function stdMaterial(uniforms) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 1 });
  m.onBeforeCompile = sh => {
    sh.uniforms.uSkin = uniforms.uSkin;
    sh.uniforms.uSkinGlow = uniforms.uSkinGlow;
    sh.vertexShader = 'attribute vec4 pbr;\nvarying vec4 vPbr;\nvarying vec3 vObj;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vPbr = pbr; vObj = position;');
    sh.fragmentShader = FRAG_HEAD + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_PATTERN)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(vmRough, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.x;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vmEmit;');
  };
  m.customProgramCacheKey = () => 'vmpbr1';
  return m;
}

// Surface specs: linear colour, metalness, roughness, pattern, emissive gain.
const spec = (hex, m, r, k = 0, e = 0) => ({ c: new THREE.Color(hex), m, r, k, e });
const glow = (hex, g = 1) => ({ c: new THREE.Color(hex).multiplyScalar(g), m: 0, r: 1, k: 0, e: 0, glow: true });
const S = {
  steel: spec('#3a3f48', 0.85, 0.38),       // blued gunmetal
  blued: spec('#262c38', 0.88, 0.32),
  steelLt: spec('#9a9fa8', 0.9, 0.28),      // machined / bright steel
  steelDk: spec('#17191d', 0.8, 0.5),
  case: spec('#8f8b86', 0.92, 0.3),         // case-hardened action
  bore: spec('#030303', 0.2, 0.9),
  wood: spec('#6b3519', 0, 0.42, 1),        // walnut
  woodLt: spec('#7a3f1c', 0, 0.45, 1),
  grip: spec('#1c1c1e', 0.02, 0.75, 2),     // checkered rubber
  plastic: spec('#222326', 0, 0.5),
  brass: spec('#c09343', 1, 0.28),
  hull: spec('#a3150f', 0, 0.38),           // shotgun shell plastic
  skin: spec('#d99b78', 0, 0.46, 3),
  nail: spec('#dca08c', 0, 0.25, 3),
  knuckle: spec('#d8957a', 0, 0.5, 3),
  sleeve: spec('#3b4425', 0.12, 0.62),      // dark olive armour
  sleeveDk: spec('#1f2414', 0.35, 0.5),
  red: spec('#a8170d', 0.35, 0.32),         // chainsaw paint
  olive: spec('#55622b', 0.3, 0.5),         // launcher paint
  oliveDk: spec('#303819', 0.35, 0.5),
  yellow: spec('#c9a21b', 0.3, 0.45),
  plasma: spec('#56627a', 0.8, 0.34),
  plasmaDk: spec('#262d3a', 0.8, 0.4),
  bfg: spec('#44533f', 0.75, 0.4),
  bfgDk: spec('#20291f', 0.75, 0.45),
  screen: spec('#2f8cff', 0, 0.3, 0, 0.9),
  lamp: spec('#ff3020', 0, 0.3, 0, 3),
  sight: spec('#f2f2e8', 0, 0.4, 0, 0.15),
};

// ----------------------------------------------------- geometry kit ----
// Parts are built in "gun space" (feet, barrel along −z, up +y) through a matrix stack, then merged. The stack's
// base holds the weapon's `chunk` (a stylised x/y fattening, like Doom's chunky sprites); hands are placed through
// the inverse of the stack so they keep natural proportions (with their own scale, HK).
let PARTS = null, OUT = null, HK = 1;
const STACK = [new THREE.Matrix4()];
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _sc = new THREE.Vector3();
function xf(pos, rot, scl) {
  _e.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
  if (scl === undefined || scl === null) _sc.set(1, 1, 1); else if (typeof scl === 'number') _sc.setScalar(scl); else _sc.fromArray(scl);
  return new THREE.Matrix4().compose(_p.set(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0), _q.setFromEuler(_e), _sc);
}
const top = () => STACK[STACK.length - 1];
const push = m => { STACK.push(top().clone().multiply(m)); };
const pop = () => { STACK.pop(); };
function part(name, o = {}) {
  const pivot = o.pivot ? V(o.pivot).applyMatrix4(STACK[0]).toArray() : [0, 0, 0];
  OUT = PARTS[name] || (PARTS[name] = { std: [], glow: [], pivot, parent: o.parent || null, pickup: o.pickup !== false });
}
// add(geometry, spec, pos, rot, scale) — or add(geometry, spec, matrix)
function add(geo, sp, pos, rot, scl) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.clearGroups();
  const m = pos && pos.isMatrix4 ? pos : xf(pos, rot, scl);
  g.applyMatrix4(top().clone().multiply(m));
  const n = g.attributes.position.count, col = new Float32Array(n * 3), pbr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = sp.c.r; col[i * 3 + 1] = sp.c.g; col[i * 3 + 2] = sp.c.b;
    pbr[i * 4] = sp.m; pbr[i * 4 + 1] = sp.r; pbr[i * 4 + 2] = sp.k; pbr[i * 4 + 3] = sp.e;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('pbr', new THREE.BufferAttribute(pbr, 4));
  (sp.glow ? OUT.glow : OUT.std).push(g);
}
const G = {
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
  rbox: (w, h, d, r, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4)),
  // cylinder along z: rb = radius at the back (+z end), rf at the front (−z end)
  cyl: (rb, rf, len, seg = 16) => new THREE.CylinderGeometry(rf, rb, len, seg).rotateX(-Math.PI / 2),
  cylX: (r, len, seg = 12) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2),
  cylY: (r, len, seg = 12) => new THREE.CylinderGeometry(r, r, len, seg),
  // lathe: points [radius, distance forward]; ascending distance faces outward; revolved about the z axis
  lathe: (pts, seg = 20) => new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p[0], p[1])), seg).rotateX(-Math.PI / 2),
  latheY: (pts, seg = 16) => new THREE.LatheGeometry(pts.map(p => new THREE.Vector2(p[0], p[1])), seg),
  sph: (r, ws = 14, hs = 10) => new THREE.SphereGeometry(r, ws, hs),
  tor: (R, r, arc = Math.PI * 2, ts = 20, rs = 7) => new THREE.TorusGeometry(R, r, rs, ts, arc),
  cap: (r, len, cs = 2, rs = 10) => new THREE.CapsuleGeometry(r, len, cs, rs),
  // side profile [z, y] extruded across x (centred), bevelled, with creased normals
  prof(pts, w, bev = 0.01, cs = 6) {
    const sh = new THREE.Shape(pts.map(p => new THREE.Vector2(p[0], p[1])));
    const d = Math.max(w - 2 * bev, 0.002);
    const g = new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: bev > 0, bevelThickness: bev, bevelSize: bev * 0.8, bevelSegments: 2, curveSegments: cs });
    g.translate(0, 0, -d / 2).rotateY(-Math.PI / 2);
    return toCreasedNormals(g, 0.6);
  },
};
const arc = (cz, cy, r, a0, a1, n) => Array.from({ length: n + 1 }, (_, i) => { const a = a0 + (a1 - a0) * i / n; return [cz + Math.cos(a) * r, cy + Math.sin(a) * r]; });

// -------------------------------------------------------------- hands ----
// A hand in its own frame: wrist at the origin, fingers along +y, palm facing +z; thumb and index on +x for a right
// hand (side 1), on −x for a left one (side −1). Digits bend about their local x toward the palm.
const FINGERS = [
  { x: 0.094, y: 0.298, sp: -0.06, L: [0.128, 0.08, 0.064], r: 0.036 },   // index
  { x: 0.031, y: 0.31, sp: 0.0, L: [0.138, 0.087, 0.067], r: 0.037 },     // middle
  { x: -0.031, y: 0.3, sp: 0.05, L: [0.13, 0.082, 0.064], r: 0.035 },     // ring
  { x: -0.09, y: 0.274, sp: 0.11, L: [0.1, 0.064, 0.056], r: 0.031 },     // little
];
const PALM_Z = 0.052;   // palm surface on the grip side
function digit(m0, L, r, curl) {
  const m = m0.clone(), t = new THREE.Matrix4();
  for (let j = 0; j < 3; j++) {
    m.multiply(t.makeRotationX(curl[j]));
    const rr = r * (1 - 0.08 * j);
    add(G.cap(rr, L[j], 2, 10).scale(1.06, 1, 0.92).translate(0, L[j] / 2, 0), S.skin, m.clone());
    if (j === 2) add(G.sph(rr * 0.62, 8, 5), S.nail, m.clone().multiply(xf([0, L[j] * 0.62, -rr * 0.78], [0.12, 0, 0], [1.05, 1.35, 0.3])));   // nail
    m.multiply(t.makeTranslation(0, L[j], 0));
  }
}
// o: { side, curl: 4 × [3 joint bends], thumb: { dir, bend, curl } (right-hand frame), arm (hand frame), armLen, spread }
function hand(o) {
  const s = o.side, sp = o.spread ?? 1;
  // palm: a rounded slab narrowing toward the wrist, with a slightly domed back
  const palm = G.rbox(0.27, 0.31, 0.1, 0.042, 2), pa = palm.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i), t = (y + 0.155) / 0.31;
    pa.setXYZ(i, x * (0.8 + 0.2 * t), y, z < 0 ? z - 0.018 * Math.max(0, 1 - (x / 0.135) ** 2) : z);
  }
  add(palm, S.skin, [0, 0.155, 0]);
  add(G.sph(0.066, 12, 8), S.skin, [0.07 * s, 0.1, 0.026], null, [1, 1.5, 0.8]);      // ball of the thumb
  add(G.sph(0.058, 12, 8), S.skin, [-0.08 * s, 0.09, 0.02], null, [0.9, 1.6, 0.75]);   // heel of the hand
  FINGERS.forEach((f, i) => {
    add(G.sph(0.03, 8, 6), S.knuckle, [f.x * s, f.y - 0.012, -0.03], null, [1, 0.8, 0.85]);   // knuckle
    digit(xf([f.x * s, f.y, -0.004], [0, 0, f.sp * s * sp]), f.L, f.r, o.curl[i]);
  });
  const th = o.thumb;
  const td = new THREE.Vector3(th.dir[0] * s, th.dir[1], th.dir[2]).normalize();
  const bd = new THREE.Vector3(th.bend[0] * s, th.bend[1], th.bend[2]);
  const tx = new THREE.Vector3().crossVectors(td, bd).normalize(), tz = new THREE.Vector3().crossVectors(tx, td);
  digit(new THREE.Matrix4().makeBasis(tx, td, tz).setPosition(0.088 * s, 0.065, 0.03), [0.12, 0.088, 0.07], 0.044, th.curl);
  // wrist and armoured sleeve, running from the wrist toward the elbow (o.arm, hand frame)
  const arm = V(o.arm || [0, -1, 0]).normalize();
  push(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), arm)));
  add(G.cap(0.082, 0.12, 2, 12), S.skin, [0, -0.045, 0], null, [1.15, 1, 0.78]);
  const L = o.armLen || 1.1;
  add(G.latheY([[0.168, -L], [0.163, -0.55], [0.156, -0.3], [0.15, -0.17], [0.158, -0.16], [0.158, -0.105], [0.122, -0.09], [0.1, -0.095]], 14), S.sleeve, null, null, [1.1, 1, 0.9]);
  add(G.tor(0.157, 0.016, Math.PI * 2, 16, 5), S.sleeveDk, [0, -0.135, 0], [Math.PI / 2, 0, 0], [1.1, 0.9, 1]);
  pop();
}
// Joint bends that wrap a finger around a grip: a cylinder along the hand's x axis through (cy, cz) in the hand's
// y–z plane, R = grip radius + finger radius. Each joint bends until the next joint touches the grip.
function hug(y0, L, cy, cz, R) {
  const b = [0, 0, 0];
  let py = y0, pz = -0.004, a = 0;
  for (let j = 0; j < 3; j++) {
    let bj = 1.7;
    for (let k = 0; k <= 68; k++) {
      const t = k * 0.025, qy = py + L[j] * Math.cos(a + t), qz = pz + L[j] * Math.sin(a + t);
      if ((qy - cy) ** 2 + (qz - cz) ** 2 <= R * R) { bj = t; break; }
    }
    b[j] = bj; a += bj; py += L[j] * Math.cos(a); pz += L[j] * Math.sin(a);
  }
  return b;
}
// Hand frame (X, Y, Z, wrist W: unscaled space) → geometry through the inverse of the current stack.
function placeHand(side, X, Y, Z, W, curl, thumb, arm, armLen, spread) {
  const a = arm.normalize();
  const H = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(W).multiply(new THREE.Matrix4().makeScale(HK, HK, HK));
  push(top().clone().invert().multiply(H));
  hand({ side, curl, thumb, arm: [a.dot(X), a.dot(Y), a.dot(Z)], armLen, spread });
  pop();
}
const stackMats = () => { const M = top(); return [M, new THREE.Matrix3().setFromMatrix4(M), new THREE.Matrix3().getNormalMatrix(M)]; };
// Close a hand around a grip: a cylinder of radius r through `at` along `axis` (pointing to the index finger's
// side), held from the `from` side (where the palm sits). cy: where the grip crosses the palm (distance from the
// wrist); cx: slide the hand along the grip; curl: per-finger overrides (a trigger finger). Gun space throughout.
function grip(side, o) {
  const [M, L3, N3] = stackMats();
  // the grip's radius after the stack's (chunky) scale, in hand units
  const a0 = V(o.axis).normalize(), p1 = new THREE.Vector3().crossVectors(a0, Math.abs(a0.y) < 0.9 ? V([0, 1, 0]) : V([1, 0, 0])).normalize();
  const p2 = new THREE.Vector3().crossVectors(a0, p1), r = o.r * (p1.applyMatrix3(L3).length() + p2.applyMatrix3(L3).length()) / 2 / HK;
  const X = V(o.axis).applyMatrix3(L3).normalize().multiplyScalar(side);
  const Z = V(o.from).applyMatrix3(N3).negate(); Z.addScaledVector(X, -Z.dot(X)).normalize();
  const Y = new THREE.Vector3().crossVectors(Z, X);
  const cy = o.cy ?? 0.24, cz = PALM_Z + r + (o.gap || 0), cx = o.cx || 0;
  const curl = FINGERS.map((f, i) => (o.curl && o.curl[i]) || hug(f.y, f.L, cy, cz, r + f.r));
  const W = V(o.at).applyMatrix4(M).addScaledVector(X, -cx * HK).addScaledVector(Y, -cy * HK).addScaledVector(Z, -cz * HK);
  placeHand(side, X, Y, Z, W, curl, o.thumb || THUMB.wrap, V(o.arm).applyMatrix3(L3), o.armLen, 0.4);
}
// A hand with explicit joint curls: wrist position, finger direction and palm-facing direction (gun space).
function freeHand(side, pose, at, fingers, facing, arm, armLen) {
  const [M, L3, N3] = stackMats();
  const Y = V(fingers).applyMatrix3(L3).normalize();
  const Z = V(facing).applyMatrix3(N3); Z.addScaledVector(Y, -Z.dot(Y)).normalize();
  const X = new THREE.Vector3().crossVectors(Y, Z);
  placeHand(side, X, Y, Z, V(at).applyMatrix4(M), pose.curl, pose.thumb, V(arm).applyMatrix3(L3), armLen, 1);
}
// Thumb set-ups in the right hand's frame: direction, bend direction, joint bends.
const THUMB = {
  wrap: { dir: [0.1, 0.55, 0.85], bend: [-1, 0.1, 0.25], curl: [0.3, 0.45, 0.35] },   // round a grip, over the fingers
  side: { dir: [0.75, 0.3, 0.6], bend: [-0.2, 0, 1], curl: [0.12, 0.18, 0.12] },     // along the grip's side
  pistol: { dir: [0.05, 0.42, 0.9], bend: [0, 1, -0.15], curl: [0.3, 0.3, 0.15] },   // round the backstrap, forward below the slide
};
const POSE = {
  fist: { curl: [[1.5, 1.85, 1.0], [1.55, 1.9, 1.0], [1.55, 1.9, 1.0], [1.5, 1.85, 1.0]],
    thumb: { dir: [-0.3, 0.55, 0.78], bend: [-1, 0.2, 0.1], curl: [0.25, 0.55, 0.45] } },
  pinch: { curl: [[0.55, 0.8, 0.4], [0.6, 0.85, 0.45], [0.95, 1.2, 0.6], [1.1, 1.3, 0.6]],
    thumb: { dir: [-0.1, 0.8, 0.75], bend: [-0.5, 0, 1], curl: [0.2, 0.25, 0.2] } },
};

// --------------------------------------------------------- shared bits ----
function shell(z0, len, x, y, rot) {   // shotgun shell lying along z from z0 forward (brass head at the back)
  push(xf([x, y, z0], rot));
  add(G.cyl(0.031, 0.031, 0.05, 14), S.brass, [0, 0, -0.025]);
  add(G.cyl(0.034, 0.034, 0.008, 14), S.brass, [0, 0, 0.004]);
  add(G.cyl(0.029, 0.029, len - 0.05, 12), S.hull, [0, 0, -0.05 - (len - 0.05) / 2]);
  pop();
}
function bolts(list, r, sp) { for (const b of list) add(G.cyl(r, r, 0.012, 8), sp, b.slice(0, 3), b[3] ? [0, b[3], 0] : null); }
const trigger = (y, z, w = 0.066) => {   // trigger guard (half ring under the frame) + trigger blade
  add(G.tor(w, 0.013, Math.PI, 14, 5), S.steel, [0, y, z], [0, Math.PI / 2, Math.PI], [1.3, 1, 1]);
  add(G.rbox(0.018, 0.056, 0.022, 0.006), S.steelLt, [0, y - 0.028, z + 0.012], [0.3, 0, 0]);
};

// ------------------------------------------------------------ weapons ----
// build(hands): parts in gun space. view: gun-space point `at` sits on the bottom edge of the view (or `edge` of the
// view height above it) at distance d feet, offset x feet, the gun pitched down `pitch`° (yaw/roll°, scale).
// flash: muzzle point + sprite size (gun space); lightAt: where the flash light sits (gun space).
// animate(w, s, clip, t, F): pose parts from the state; F collects this frame's flash (size, frame, gains).
const DEFS = {};

// ---- fist: posed directly in view space, between a guard at the bottom right and a straight punch at the centre
DEFS.fist = {
  view: null, hands: 1.35,
  guard: { pos: [0.31, -0.43, -0.57], rot: [0.7, 0.35, -1.3] },     // vertical fist, thumb up, knuckles up-forward
  strike: { pos: [0.03, -0.27, -0.85], rot: [0.25, 0.08, -0.7] },
  flash: null,
  build(h) {
    part('hand');
    if (h) freeHand(1, POSE.fist, [0, 0, 0], [0, 0, -1], [0, -1, 0], [0.12, -0.3, 1], 1.3);
  },
  pickup: null,
  animate(w, s, clip, t) {
    const g = w.gun, A = this.guard, B = this.strike;
    // 0–4 drive forward, *4 impact (fully out by ~8), 8–13 held, 13–17 back to the guard
    let e = 0;
    if (clip === 'punch') e = t < 4 ? 0.8 * Math.pow(t / 4, 1.6) : t < 8 ? 0.8 + 0.2 * eout((t - 4) / 4) : t < 13 ? 1 : 1 - smooth(ramp(t, 13, 17));
    g.position.set(lerp(A.pos[0], B.pos[0], e), lerp(A.pos[1], B.pos[1], e), lerp(A.pos[2], B.pos[2], e));
    g.rotation.set(lerp(A.rot[0], B.rot[0], e), lerp(A.rot[1], B.rot[1], e), lerp(A.rot[2], B.rot[2], e));
    if (clip === 'punch' && t >= 4 && t < 9) { const j = (1 - ramp(t, 4, 9)) * 0.012; g.position.x += (hash(t | 0) - 0.5) * j; g.position.y += (hash((t | 0) + 7) - 0.5) * j; }
  },
};

// ---- chainsaw
DEFS.chainsaw = {
  view: { at: [0, 0.26, -0.12], d: 1.0, pitch: -14, x: 0.22, yaw: 26, roll: -20, edge: 0.24, scale: 1.3 }, chunk: [1.5, 1.4], hands: 0.95,
  flash: null,
  build(h) {
    part('body');
    add(G.rbox(0.3, 0.27, 0.6, 0.06, 3), S.red, [0, 0, 0]);                            // engine housing
    add(G.rbox(0.25, 0.07, 0.36, 0.03), S.red, [0, 0.15, 0.04]);                        // top cover
    for (let i = 0; i < 5; i++) add(G.box(0.2, 0.012, 0.05), S.steelDk, [0, 0.19, -0.06 + i * 0.045]);   // cooling fins
    add(G.cylX(0.1, 0.035, 24), S.plastic, [-0.16, -0.01, 0.02]);                       // starter cover
    add(G.rbox(0.03, 0.09, 0.03, 0.01), S.plastic, [-0.185, 0.03, 0.02]);               // starter handle
    add(G.rbox(0.05, 0.12, 0.2, 0.02), S.steelLt, [0.17, -0.03, -0.14]);                // muffler
    for (let i = 0; i < 3; i++) add(G.box(0.006, 0.018, 0.12), S.bore, [0.197, -0.06 + i * 0.03, -0.14]);
    add(G.rbox(0.07, 0.16, 0.3, 0.02), S.red, [0.13, -0.03, -0.3]);                     // clutch cover
    add(G.rbox(0.04, 0.05, 0.06, 0.01), S.steelLt, [0.17, -0.02, -0.34]);               // bar nuts
    // rear handle loop: the grip bar plus a strut down to the base
    add(G.cyl(0.036, 0.036, 0.3, 12), S.grip, [0, 0.1, 0.45]);
    add(G.rbox(0.07, 0.24, 0.07, 0.03), S.plastic, [0, -0.02, 0.62], [-0.2, 0, 0]);
    add(G.rbox(0.08, 0.06, 0.12, 0.02), S.plastic, [0, 0.08, 0.3]);
    add(G.rbox(0.12, 0.05, 0.4, 0.02), S.plastic, [0, -0.13, 0.45]);                   // base plate
    add(G.rbox(0.02, 0.05, 0.03, 0.008), S.steelLt, [0, 0.045, 0.4]);                  // throttle
    // front handle: a tube arching over the housing
    add(G.tor(0.19, 0.026, Math.PI, 24, 8), S.plastic, [0.0, 0.02, -0.12], [0, 0, 0], [1, 1.25, 1]);
    add(G.rbox(0.2, 0.11, 0.016, 0.008), S.red, [0, 0.12, -0.3], [-0.3, 0, 0]);         // hand guard
    // guide bar with a rounded nose, and the nose sprocket
    const bar = [[-0.22, -0.075], [-1.32, -0.055], ...arc(-1.32, 0, 0.055, -Math.PI / 2, -Math.PI * 1.5, 10), [-0.22, 0.075]];
    add(G.prof(bar, 0.028, 0.004), S.steelLt, [0, -0.04, 0]);
    add(G.cylX(0.03, 0.034, 16), S.steelDk, [0, -0.04, -1.32]);
    add(G.box(0.03, 0.02, 0.95), S.steelDk, [0, -0.04, -0.75]);                         // bar groove shadow
    // chain round the nose and along the bottom (static)
    for (let i = 0; i <= 8; i++) { const a = -Math.PI / 2 + Math.PI * i / 8; add(G.box(0.036, 0.022, 0.03), S.steelDk, [0, -0.04 + Math.sin(a) * 0.068, -1.32 - Math.cos(a) * 0.068], [-a, 0, 0]); }
    for (let z = -0.26; z > -1.3; z -= 0.05) add(G.box(0.036, 0.02, 0.032), S.steelDk, [0, -0.04 - 0.085 + (z + 0.22) * -0.018, z]);
    if (h) {
      // right hand over the rear grip, left hand over the top of the front handle
      grip(1, { at: [0, 0.1, 0.46], axis: [0, 0, -1], from: [0.25, 1, 0], r: 0.036, arm: [0.45, -0.5, 1], armLen: 1.3 });
      grip(-1, { at: [-0.02, 0.26, -0.12], axis: [1, 0, 0], from: [0, 0.55, 0.85], r: 0.03, cx: 0.02, arm: [-0.6, -0.5, 1], armLen: 1.3 });
    }
    part('chain');   // top run of the chain; slides forward by one link pitch per cycle while cutting
    for (let z = -0.26; z > -1.34; z -= 0.05) {
      const y = -0.04 + 0.085 + (z + 0.22) * 0.018;
      add(G.box(0.036, 0.02, 0.032), S.steelDk, [0, y, z]);
      add(G.box(0.016, 0.022, 0.024), S.steelLt, [((Math.round(z * 20) & 1) ? 0.012 : -0.012), y + 0.014, z + 0.004], [0.35, 0, 0]);
    }
  },
  pickup: { scale: 1.15, rot: [0, 0.6, Math.PI / 2] },
  animate(w, s, clip, t) {
    const g = w.gun, time = s.time || 0;
    if (clip === 'saw') {
      // bucking under load: hard jitter, blade pushed forward, chain racing
      const n = Math.floor(time * 70), tt = t % 8;
      g.position.set((hash(n) - 0.5) * 0.016, (hash(n + 3) - 0.5) * 0.016 + 0.012, -0.05 - 0.025 * Math.sin(tt / 8 * Math.PI * 2));
      g.rotation.set(0.03 + (hash(n + 5) - 0.5) * 0.025, (hash(n + 9) - 0.5) * 0.016, (hash(n + 11) - 0.5) * 0.025);
      // ~12 links/s: a real chain's speed aliases at display rates (at 144 Hz it would crawl backwards)
      w.parts.chain.position.z -= (time * 0.6) % 0.05;
    } else {
      const p = time * Math.PI * 2 * 7;   // idling two-stroke: ~7 Hz shake
      g.position.set(Math.sin(p * 1.3) * 0.0025, Math.sin(p) * 0.003, 0);
      g.rotation.set(Math.sin(p + 1) * 0.004, 0, Math.sin(p * 0.7) * 0.003);
    }
  },
};

// ---- pistol
DEFS.pistol = {
  view: { at: [0, 0.125, 0.02], d: 0.8, pitch: -3, x: 0.1, yaw: 7, roll: -4, edge: 0.34 }, chunk: [1.3, 1.1], hands: 1.2,
  flash: { kind: 'bullet', at: [0, 0.062, -0.74], size: 0.7 },
  lightAt: [0, 0.3, -0.4], lightI: 2.2,
  build(h) {
    part('body');
    add(G.rbox(0.1, 0.07, 0.58, 0.016), S.steel, [0, -0.03, -0.29]);                    // frame + dust cover
    add(G.box(0.032, 0.012, 0.2), S.steelDk, [0, -0.066, -0.47]);                        // rail slot
    trigger(-0.062, -0.13, 0.06);
    push(xf([0, -0.04, 0.035], [-0.3, 0, 0]));                                          // raked grip
    add(G.rbox(0.1, 0.3, 0.155, 0.032), S.steel, [0, -0.14, 0]);
    add(G.rbox(0.114, 0.23, 0.13, 0.03), S.grip, [0, -0.15, 0.004]);
    add(G.rbox(0.104, 0.03, 0.165, 0.01), S.steelDk, [0, -0.295, 0]);                   // magazine base
    pop();
    add(G.rbox(0.075, 0.035, 0.085, 0.014), S.steel, [0, -0.02, 0.07]);                  // beavertail
    add(G.rbox(0.03, 0.055, 0.03, 0.008), S.steelDk, [0, 0.02, 0.05], [0.55, 0, 0]);     // hammer
    add(G.rbox(0.012, 0.02, 0.1, 0.005), S.steelDk, [-0.053, 0.0, -0.12]);               // slide stop
    add(G.cyl(0.034, 0.034, 0.03, 16), S.steelLt, [0, 0.062, -0.635]);                   // barrel crown
    add(G.cyl(0.02, 0.02, 0.005, 12), S.bore, [0, 0.062, -0.651]);
    add(G.cyl(0.016, 0.016, 0.02, 10), S.steelLt, [0, -0.012, -0.585]);                  // guide rod
    if (h) grip(1, { at: [0, -0.175, 0.076], axis: [0, 0.955, -0.296], from: [1, 0, 0.1], r: 0.062, cy: 0.23, curl: [[0.55, 1.0, 0.5]],
      thumb: THUMB.pistol, arm: [0.15, -0.8, 0.5], armLen: 1.1 });
    part('slide');
    add(G.rbox(0.112, 0.12, 0.64, 0.022), S.steel, [0, 0.06, -0.3]);
    add(G.box(0.05, 0.006, 0.52), S.steelDk, [0, 0.121, -0.3]);                          // flat top
    for (let i = 0; i < 8; i++) for (const sx of [-1, 1]) add(G.box(0.006, 0.08, 0.008), S.steelDk, [sx * 0.056, 0.06, -i * 0.014]);
    add(G.box(0.006, 0.05, 0.15), S.bore, [0.056, 0.072, -0.15]);                        // ejection port
    add(G.rbox(0.03, 0.035, 0.035, 0.007), S.steelDk, [0.028, 0.135, -0.005]);           // rear sight (notched)
    add(G.rbox(0.03, 0.035, 0.035, 0.007), S.steelDk, [-0.028, 0.135, -0.005]);
    add(G.rbox(0.018, 0.032, 0.05, 0.006), S.steelDk, [0, 0.133, -0.575]);               // front sight
    add(G.sph(0.006, 6, 4), S.sight, [0.028, 0.142, 0.013]); add(G.sph(0.006, 6, 4), S.sight, [-0.028, 0.142, 0.013]);
    add(G.sph(0.006, 6, 4), S.sight, [0, 0.142, -0.55]);
  },
  pickup: { scale: 2.1, rot: [0, 0.5, Math.PI / 2] },
  animate(w, s, clip, t, F) {
    if (clip !== 'fire') return;
    const g = w.gun, k = kick(t, 4, 1.2, 9);
    const sl = t < 4 ? 0 : t < 5 ? t - 4 : 1 - smooth(ramp(t, 5, 8.5));   // slide cycles in ~4 tics
    w.parts.slide.position.z += 0.12 * sl;
    g.rotation.x += 0.19 * k; g.position.z += 0.06 * k; g.position.y += 0.02 * k;
    g.rotation.x -= 0.015 * Math.sin(ramp(t, 14, 19) * Math.PI);   // settle
    if (F.kind) F.size *= 1 - 0.45 * ramp(t, 4, 11);
  },
};

// ---- shotgun
DEFS.shotgun = {
  view: { at: [0, 0.056, 0], d: 0.55, pitch: 5, edge: 0.08 }, chunk: [1.7, 1.5], hands: 1.25,
  blend: 3,   // re-fired at 37 while still settling: ease into the next shot (at 3)
  flash: { kind: 'bullet', at: [0, 0, -2.32], size: 1.5 },
  lightAt: [0, 0.35, -1.3], lightI: 5,
  build(h) {
    part('body');
    add(G.rbox(0.17, 0.22, 0.56, 0.035), S.steel, [0, -0.06, -0.28]);                  // receiver, top flush with the barrel
    add(G.box(0.04, 0.012, 0.52), S.steelDk, [0, 0.056, -0.28]);                        // top rib
    for (const sx of [-1, 1]) add(G.box(0.004, 0.012, 0.46), S.steelLt, [sx * 0.086, 0.015, -0.3]);   // machined flats
    add(G.box(0.006, 0.065, 0.2), S.bore, [0.086, -0.03, -0.3]);                        // ejection port
    add(G.box(0.09, 0.006, 0.26), S.bore, [0, -0.172, -0.33]);                          // loading port
    add(G.rbox(0.02, 0.02, 0.04, 0.006), S.steelLt, [-0.088, -0.06, -0.1]);             // slide release
    add(G.cyl(0.05, 0.046, 1.66, 20), S.blued, [0, 0, -1.39]);                          // barrel
    add(G.cyl(0.029, 0.029, 0.006, 14), S.bore, [0, 0, -2.221]);
    add(G.box(0.03, 0.008, 1.58), S.steelDk, [0, 0.062, -1.4]);                         // vent rib
    for (let z = -0.7; z > -2.15; z -= 0.14) add(G.box(0.01, 0.012, 0.018), S.steelDk, [0, 0.053, z]);
    add(G.sph(0.013, 10, 8), S.brass, [0, 0.074, -2.18]);                               // bead
    add(G.cyl(0.04, 0.04, 1.3, 16), S.steel, [0, -0.095, -1.21]);                       // magazine tube
    add(G.cyl(0.044, 0.044, 0.07, 16), S.steelLt, [0, -0.095, -1.89]);
    add(G.rbox(0.1, 0.17, 0.06, 0.025), S.steel, [0, -0.045, -1.83]);                   // barrel band
    trigger(-0.17, -0.13);
    add(G.prof([[0.02, -0.005], [0.3, -0.03], [1.22, -0.1], [1.24, -0.54], [0.56, -0.33], [0.3, -0.25], [0.1, -0.18], [0.02, -0.18]], 0.13, 0.022), S.wood);
    add(G.rbox(0.135, 0.46, 0.045, 0.016), S.plastic, [0, -0.32, 1.255], [0.12, 0, 0]);   // butt pad
    if (h) grip(1, { at: [0, -0.11, 0.27], axis: [0, 0.5, -0.87], from: [1, -0.3, 0], r: 0.075, thumb: THUMB.wrap, arm: [0.3, -0.5, 1], armLen: 1.2 });
    part('pump');   // ribbed wooden fore-end wrapped up round the barrel's flanks, so it reads over the receiver
    add(G.rbox(0.185, 0.2, 0.6, 0.05, 2), S.wood, [0, -0.068, -1.0]);
    for (let i = 0; i < 8; i++) add(G.rbox(0.205, 0.218, 0.054, 0.014, 1), S.woodLt, [0, -0.068, -0.742 - i * 0.074]);
    for (const sx of [-1, 1]) add(G.box(0.012, 0.02, 0.2), S.steelLt, [sx * 0.05, -0.07, -0.63]);   // action bars
    if (h) grip(-1, { at: [0, -0.068, -1.0], axis: [0, 0, -1], from: [-0.35, -0.94, 0], r: 0.105, thumb: THUMB.side, arm: [-0.55, -0.45, 0.7], armLen: 1.3 });
  },
  pickup: { scale: 0.75, rot: [0, 0.45, Math.PI / 2] },
  animate(w, s, clip, t) {
    if (clip !== 'fire') return;
    const g = w.gun, k = kick(t, 3, 1.3, 7);
    g.rotation.x += 0.22 * k; g.position.z += 0.09 * k; g.position.y += 0.02 * k;
    // pump: back 10–20, held 20–24, forward 24–34; the gun cants and dips while racking, settles 34–44
    const pb = smooth(ramp(t, 10, 20)) * (1 - smooth(ramp(t, 24, 34)));
    w.parts.pump.position.z += 0.3 * pb;
    const rk = smooth(ramp(t, 8, 16)) * (1 - smooth(ramp(t, 30, 42)));
    g.rotation.z += 0.2 * rk; g.position.y -= 0.035 * rk; g.position.x -= 0.025 * rk; g.rotation.x += 0.06 * rk;
    const j = kick(t, 20, 0.6, 4) * 0.01 + kick(t, 34, 0.6, 5) * 0.014;   // clacks at the ends of the stroke
    g.position.z += j; g.rotation.x += j;
  },
};

// ---- super shotgun (side-by-side, break action)
const SSG_HINGE = [0, -0.078, -0.03];
DEFS.ssg = {
  view: { at: [0, 0.052, 0.02], d: 0.55, pitch: 5, edge: 0.08 }, chunk: [1.8, 1.6], hands: 1.1,
  blend: 3,   // re-fired at 51 (the close) while still lowered: swing back up before the next shot (at 3)
  flash: { kind: 'bullet', at: [0, 0, -1.84], size: 1.55 },
  lightAt: [0, 0.35, -1.1], lightI: 7,
  build(h) {
    part('body');
    add(G.rbox(0.2, 0.17, 0.34, 0.035), S.case, [0, -0.035, 0.17]);                    // action
    add(G.rbox(0.19, 0.05, 0.1, 0.018), S.case, [0, -0.1, -0.02]);                     // action flats under the hinge
    add(G.cylX(0.032, 0.21, 14), S.steelLt, SSG_HINGE);                                 // hinge pin
    add(G.rbox(0.045, 0.026, 0.15, 0.01), S.steel, [0.035, 0.062, 0.2], [0, -0.35, 0]);   // top lever
    add(G.rbox(0.022, 0.018, 0.05, 0.006), S.steelLt, [0, 0.058, 0.3]);                 // safety
    add(G.tor(0.062, 0.012, Math.PI, 14, 5), S.steel, [0, -0.12, 0.17], [0, Math.PI / 2, Math.PI], [1.4, 1, 1]);
    add(G.rbox(0.015, 0.05, 0.02, 0.005), S.steelLt, [0, -0.14, 0.14], [0.3, 0, 0]);
    add(G.rbox(0.015, 0.05, 0.02, 0.005), S.steelLt, [0, -0.14, 0.2], [0.3, 0, 0]);
    add(G.prof([[0.33, 0.04], [0.55, 0.01], [1.3, -0.04], [1.32, -0.46], [0.66, -0.26], [0.45, -0.19], [0.33, -0.13]], 0.13, 0.022), S.wood);
    add(G.rbox(0.135, 0.44, 0.045, 0.016), S.plastic, [0, -0.25, 1.335], [0.12, 0, 0]);
    if (h) grip(1, { at: [0, -0.08, 0.5], axis: [0, 0.5, -0.87], from: [1, -0.3, 0], r: 0.075, thumb: THUMB.wrap, arm: [0.3, -0.5, 1], armLen: 1.2 });
    part('barrels', { pivot: SSG_HINGE });
    for (const sx of [-1, 1]) {
      add(G.cyl(0.052, 0.047, 1.72, 20), S.blued, [sx * 0.054, 0, -0.86]);
      add(G.cyl(0.031, 0.031, 0.006, 14), S.bore, [sx * 0.054, 0, -1.722]);
      add(G.cyl(0.033, 0.033, 0.006, 14), S.bore, [sx * 0.054, 0, 0.0005]);             // chamber mouths (seen when open)
    }
    add(G.box(0.05, 0.02, 1.68), S.steelDk, [0, 0.046, -0.86]);                         // top rib
    add(G.sph(0.013, 10, 8), S.brass, [0, 0.062, -1.69]);
    add(G.box(0.05, 0.02, 1.3), S.steelDk, [0, -0.046, -1.05]);                          // bottom rib
    add(G.rbox(0.19, 0.085, 0.18, 0.025), S.steel, [0, -0.065, -0.09]);                  // lumps over the hinge
    add(G.prof([[-0.22, -0.035], [-0.9, -0.035], [-0.95, -0.07], [-0.88, -0.13], [-0.3, -0.14], [-0.22, -0.1]], 0.22, 0.03), S.wood);   // beavertail fore-end
    add(G.rbox(0.05, 0.025, 0.08, 0.01), S.steelLt, [0, -0.15, -0.5]);                  // fore-end latch
    part('eject', { pivot: [0, 0, 0.0], parent: 'barrels', pickup: false });            // spent shells
    for (const sx of [-1, 1]) shell(0.004, 0.23, sx * 0.054, 0, null);
    part('load', { pivot: [0, 0, 0.0], parent: 'barrels', pickup: false });             // fresh shells
    for (const sx of [-1, 1]) shell(0.004, 0.23, sx * 0.054, 0, null);
    part('lhand', { pivot: [0, -0.1, -0.6], parent: 'barrels', pickup: false });        // left hand on the fore-end
    if (h) grip(-1, { at: [0, -0.07, -0.6], axis: [0, 0, -1], from: [-0.3, -0.95, 0], r: 0.1, thumb: THUMB.side, arm: [-0.55, -0.45, 0.7], armLen: 1.3 });
    part('lhandP', { parent: 'barrels', pickup: false });                              // left hand carrying two shells by their rims
    // built in the barrels' closed frame; its forearm is given in view space for the moment of loading and taken
    // back through the root, reload-pose and break-open rotations (and the chunk) so it hangs down-left off screen
    if (h) {
      const v = this.view, R = this.reload.rot, q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-v.pitch * D2R, 0, 0))
        .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(R[0], R[1], R[2]))).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.62, 0, 0))).invert();
      const arm = new THREE.Vector3(-0.35, -0.93, -0.1).applyQuaternion(q).divide(new THREE.Vector3(this.chunk[0], this.chunk[1], 1));
      freeHand(-1, POSE.pinch, [-0.07, 0.07, 0.34], [0.1, -0.1, -1], [0.2, -1, 0], arm.toArray(), 1.1);
    }
  },
  // reload choreography (view-space offset in feet, rotation in radians): the gun comes up and away, turned to present
  // the open breech; two fresh shells arrive on the left hand from the lower left
  reload: { pos: [-0.12, 0.22, -0.45], rot: [0.35, 0.35, 0.35] },
  shellFrom: [-0.32, -0.3, 0.2],
  pickup: { scale: 0.8, rot: [0, 0.45, Math.PI / 2] },
  animate(w, s, clip, t) {
    const g = w.gun, P = w.parts, R = this.reload, A = this.shellFrom;
    P.lhandP.visible = false;
    if (clip !== 'fire') { P.eject.visible = false; P.load.visible = true; return; }
    const k = kick(t, 3, 1.5, 11);
    g.rotation.x += 0.38 * k; g.position.z += 0.12 * k; g.position.y += 0.03 * k;
    // 17–24 swing the breech into view; 24–31 break open and eject; 31–38 fresh shells arrive; 38–45 insert;
    // 45–51 hand away; 51–57 the barrels snap shut and the gun swings back up
    const low = smooth(ramp(t, 16, 24)) * (1 - smooth(ramp(t, 51, 57)));
    g.position.x += R.pos[0] * low; g.position.y += R.pos[1] * low; g.position.z += R.pos[2] * low;
    g.rotation.x += R.rot[0] * low; g.rotation.y += R.rot[1] * low; g.rotation.z += R.rot[2] * low;
    const open = t < 24 ? 0 : t < 29 ? eout(ramp(t, 24, 29)) : t < 51 ? 1 : 1 - smooth(ramp(t, 51, 55));
    P.barrels.rotation.x = -0.62 * open + (t >= 29 && t < 31 ? -0.04 * Math.sin(ramp(t, 29, 31) * Math.PI) : 0);
    if (t >= 55 && t < 57) g.position.y += 0.012 * Math.sin(ramp(t, 55, 57) * Math.PI);   // snap
    // spent shells: slide out 25–27, then flip up and away to the right
    P.eject.visible = t >= 24 && t < 31;
    if (t >= 25) {
      const a = ramp(t, 25, 27), b = ramp(t, 27, 31);
      P.eject.position.z += 0.2 * eout(a) + 0.35 * b;
      P.eject.position.y += 0.45 * b - 0.35 * b * b;
      P.eject.position.x += 0.75 * b;
      P.eject.rotation.x = 2.5 * b; P.eject.rotation.y = 0.8 * b;
    }
    // fresh shells ride in on the left hand, are pushed home, and stay in the chambers
    P.load.visible = t < 24 || t >= 31;
    const come = smooth(ramp(t, 31, 38)), ins = smooth(ramp(t, 38, 45)), away = smooth(ramp(t, 45, 50));
    if (t >= 31 && t < 45) {
      const u = 1 - come;
      P.load.position.x += A[0] * u; P.load.position.y += A[1] * u; P.load.position.z += 0.24 * (1 - ins) + A[2] * u;
      P.load.rotation.set(0.4 * u, 0, -0.6 * u);
    }
    P.lhandP.visible = t >= 31 && t < 50;
    if (P.lhandP.visible) {
      P.lhandP.position.copy(P.load.position); P.lhandP.rotation.copy(P.load.rotation);
      if (t >= 45) { P.lhandP.position.copy(P.lhandP.userData.p0); P.lhandP.position.x += A[0] * away; P.lhandP.position.y += A[1] * away; P.lhandP.position.z += (A[2] + 0.05) * away; }
    }
    // fore-end hand: lets go 17–24, back under the fore-end by 51 (where a held trigger re-fires)
    const gone = smooth(ramp(t, 17, 23)) * (1 - smooth(ramp(t, 46, 51)));
    P.lhand.visible = gone < 0.999;
    P.lhand.position.x -= 0.15 * gone; P.lhand.position.y -= 0.5 * gone; P.lhand.position.z += 0.05 * gone;
  },
};

// ---- chaingun: six barrels on a spinning rotor riding on top of the receiver, spade grips on both sides
DEFS.chaingun = {
  view: { at: [0, 0.135, 0.02], d: 0.65, pitch: 8, edge: 0.2 }, chunk: [1.2, 1.2], hands: 1.0,
  flash: { kind: 'bullet', at: [0, 0, -2.04], size: 1.05 },
  lightAt: [0, 0.3, -1.1], lightI: 4,
  build(h) {
    part('rotor');   // barrels round a spindle behind a bolted collar, all turned by s.spin
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3, bx = Math.cos(a) * 0.08, by = Math.sin(a) * 0.08;
      add(G.cyl(0.034, 0.031, 1.76, 12), S.blued, [bx, by, -1.07]);
      add(G.cyl(0.019, 0.019, 0.006, 10), S.bore, [bx, by, -1.951]);
    }
    add(G.cyl(0.04, 0.04, 1.7, 12), S.steelDk, [0, 0, -1.05]);                          // spindle
    for (const z of [-0.95, -1.55]) add(G.cyl(0.124, 0.124, 0.05, 24), S.steel, [0, 0, z]);   // barrel clamps
    add(G.lathe([[0.04, 0], [0.12, 0.006], [0.127, 0.035], [0.12, 0.075], [0.04, 0.08]], 24), S.steelLt, [0, 0, -1.87]);   // muzzle clamp
    add(G.lathe([[0.09, -0.02], [0.125, -0.012], [0.137, 0.015], [0.137, 0.2], [0.12, 0.22]], 28), S.steel);   // rear collar
    add(G.cyl(0.092, 0.092, 0.008, 28), S.steelDk, [0, 0, 0.018]);
    bolts(Array.from({ length: 6 }, (_, i) => [Math.cos(i * Math.PI / 3) * 0.062, Math.sin(i * Math.PI / 3) * 0.062, 0.024]), 0.014, S.steelLt);
    add(G.cyl(0.03, 0.026, 0.02, 12), S.steelLt, [0, 0, 0.028]);                         // hub
    part('body');
    add(G.rbox(0.3, 0.26, 0.62, 0.04, 3), S.steel, [0, -0.2, -0.28]);                     // receiver under the rotor
    add(G.cyl(0.128, 0.128, 0.1, 28), S.steelDk, [0, 0, -0.27]);                         // bearing ring
    add(G.rbox(0.24, 0.02, 0.5, 0.008), S.steelDk, [0, -0.065, -0.3]);
    for (let i = 0; i < 4; i++) for (const sx of [-1, 1]) add(G.box(0.006, 0.12, 0.03), S.bore, [sx * 0.151, -0.2, -0.1 - i * 0.1]);   // vents
    add(G.cyl(0.05, 0.05, 0.32, 16), S.steelDk, [0.16, -0.14, -0.3]);                    // drive motor
    add(G.rbox(0.07, 0.07, 0.1, 0.02), S.steel, [0.16, -0.14, -0.1]);
    // ammo box on the left and a belt of brass rounds climbing into the receiver
    add(G.rbox(0.16, 0.22, 0.3, 0.02), S.olive, [-0.26, -0.3, -0.3]);
    add(G.rbox(0.17, 0.03, 0.31, 0.01), S.oliveDk, [-0.26, -0.18, -0.3]);
    for (let i = 0; i < 6; i++) {
      const u = i / 5, y = -0.17 + u * 0.06, x = -0.22 + u * 0.07;
      add(G.cyl(0.016, 0.011, 0.12, 8), S.brass, [x, y, -0.3]);
      add(G.box(0.028, 0.01, 0.09), S.steelDk, [x, y + 0.018, -0.3]);
    }
    // spade grips either side of the rotor
    for (const sx of [-1, 1]) {
      add(G.rbox(0.13, 0.05, 0.08, 0.018), S.steel, [sx * 0.2, -0.13, -0.24]);
      add(G.rbox(0.13, 0.05, 0.08, 0.018), S.steel, [sx * 0.2, 0.09, -0.24]);
      add(G.cylY(0.042, 0.28, 14), S.grip, [sx * 0.265, -0.02, -0.24]);
      add(G.cylY(0.047, 0.03, 14), S.steel, [sx * 0.265, 0.13, -0.24]);
    }
    if (h) {
      grip(1, { at: [0.265, -0.03, -0.24], axis: [0, 1, 0], from: [0.75, 0, 0.66], r: 0.042, arm: [0.3, -0.6, 0.75], armLen: 1.3 });
      grip(-1, { at: [-0.265, -0.03, -0.24], axis: [0, 1, 0], from: [-0.75, 0, 0.66], r: 0.042, arm: [-0.3, -0.6, 0.75], armLen: 1.3 });
    }
  },
  pickup: { scale: 1.1, rot: [0, 0.5, Math.PI / 2] },
  animate(w, s, clip, t) {
    w.parts.rotor.rotation.z = s.spin || 0;
    if (clip !== 'fire') return;
    const g = w.gun, tt = t % 4, k = kick(tt, 0, 0.7, 2.6), n = Math.floor(t / 4) + 13 * Math.floor((s.time || 0) * 3);
    g.position.z += 0.03 * k; g.rotation.x += 0.025 * k;
    g.position.x += (hash(n) - 0.5) * 0.008 * k; g.position.y += (hash(n + 1) - 0.5) * 0.007 * k;
  },
};

// ---- rocket launcher
DEFS.rocket = {
  view: { at: [0, 0.2, 0], d: 0.7, pitch: 4, edge: 0.14 }, chunk: [1.2, 1.2], hands: 1.2,
  flash: { kind: 'rocket', at: [0, 0, -2.52], size: 1.6 },
  lightAt: [0, 0.45, -1.6], lightI: 6,
  build(h) {
    part('body');
    // thick-walled tube: olive skin with flared ends, dark bore
    add(G.lathe([[0.17, -0.15], [0.21, -0.14], [0.222, -0.1], [0.208, -0.04], [0.198, 0], [0.198, 2.1], [0.228, 2.16], [0.238, 2.3], [0.224, 2.38], [0.178, 2.4]], 28), S.olive);
    add(G.lathe([[0.178, 2.4], [0.165, 2.37], [0.165, -0.12], [0.17, -0.15]], 28), S.oliveDk);
    for (const d of [0.35, 1.0, 1.65]) add(G.tor(0.2, 0.014, Math.PI * 2, 28, 5), S.oliveDk, [0, 0, -d]);
    add(G.cyl(0.201, 0.201, 0.08, 28), S.yellow, [0, 0, -1.95]);                          // warning band
    // sight box, rail, trigger housing with pistol grip, front grip
    add(G.rbox(0.075, 0.09, 0.34, 0.02), S.oliveDk, [-0.15, 0.2, -0.45]);
    add(G.cyl(0.028, 0.028, 0.02, 12), S.bore, [-0.15, 0.21, -0.28]);
    add(G.cyl(0.028, 0.028, 0.02, 12), S.screen, [-0.15, 0.21, -0.625]);
    add(G.box(0.07, 0.02, 1.0), S.steelDk, [0, 0.205, -0.75]);
    for (let z = -0.3; z > -1.25; z -= 0.1) add(G.box(0.08, 0.012, 0.03), S.steelDk, [0, 0.219, z]);
    add(G.rbox(0.1, 0.12, 0.4, 0.03), S.oliveDk, [0, -0.23, -0.3]);
    trigger(-0.29, -0.42, 0.055);
    push(xf([0, -0.42, -0.25], [-0.25, 0, 0]));
    add(G.rbox(0.095, 0.3, 0.14, 0.03), S.grip, [0, 0, 0]);
    pop();
    add(G.rbox(0.08, 0.1, 0.12, 0.02), S.oliveDk, [0, -0.22, -1.15]);
    add(G.cylY(0.045, 0.26, 14), S.grip, [0, -0.38, -1.17], [-0.12, 0, 0]);
    add(G.sph(0.014, 8, 6), S.lamp, [0.14, 0.14, 0.05]);                                   // armed lamp
    if (h) {
      grip(1, { at: [0, -0.42, -0.24], axis: [0, 0.97, -0.25], from: [1, 0, 0.3], r: 0.06, curl: [[0.4, 0.8, 0.4]], thumb: THUMB.pistol, arm: [0.35, -0.5, 1], armLen: 1.2 });
      grip(-1, { at: [0, 0, -0.95], axis: [0, 0, -1], from: [-0.75, -0.66, 0], r: 0.2, thumb: THUMB.side, arm: [-0.4, -0.8, 0.45], armLen: 1.0 });
    }
    part('round', { pickup: false });   // the loaded rocket, its nozzle and fins seen through the open back of the tube
    add(G.lathe([[0.07, 0], [0.09, 0.08], [0.1, 0.1], [0.1, 0.9], [0.05, 1.05], [0.01, 1.1]], 16), S.steel, [0, 0, -0.32]);
    add(G.cyl(0.05, 0.065, 0.12, 14), S.steelDk, [0, 0, -0.26]);
    add(G.cyl(0.036, 0.036, 0.01, 12), S.bore, [0, 0, -0.198]);
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; add(G.box(0.006, 0.07, 0.12), S.yellow, [Math.cos(a) * 0.12, Math.sin(a) * 0.12, -0.36], [0, 0, a - Math.PI / 2]); }
    part('glow', { pickup: false });   // hot lip of the muzzle while firing
    add(G.lathe([[0.164, 0], [0.175, 0.03], [0.226, 0.05]], 28), glow('#ff9a40'), [0, 0, -2.36]);
    add(G.lathe([[0.16, 0], [0.16, 0.2]], 28), glow('#ff6a20', 0.7), [0, 0, -2.16]);
  },
  pickup: { scale: 1.0, rot: [0, 0.5, Math.PI / 2] },
  animate(w, s, clip, t) {
    const g = w.gun, P = w.parts;
    let gl = 0;
    if (clip === 'fire') {
      // ignition rumble 0–8, launch at 8 with a heavy shove back, recover by 20
      if (t < 8) { const n = Math.floor(t * 2); g.position.x += (hash(n) - 0.5) * 0.005 * t / 8; g.position.y += (hash(n + 4) - 0.5) * 0.005 * t / 8; }
      const k = kick(t, 8, 1.5, 10);
      g.position.z += 0.16 * k; g.rotation.x += 0.12 * k; g.position.y += 0.02 * k;
      P.round.visible = t < 8 || t >= 12;   // the next round slides in from the back 12–19
      if (t >= 12) P.round.position.z += 0.55 * (1 - smooth(ramp(t, 12, 19)));
      gl = t < 8 ? 0.4 + t / 8 : 1.4 * (1 - ramp(t, 8, 18));
    }
    w.glowMat.color.setScalar(gl * 4);
    P.glow.visible = gl > 0.01;
  },
};

// ---- plasma rifle: the emitter's coils ride above the housing and heat slots run along the top, so the glow reads
DEFS.plasma = {
  view: { at: [0, 0.0, 0], d: 0.65, pitch: 4, edge: 0.14 }, chunk: [1.3, 1.25], hands: 1.2,
  flash: { kind: 'plasma', at: [0, -0.02, -1.76], size: 0.9 },
  lightAt: [0, 0.25, -1.1], lightI: 3,
  build(h) {
    part('body');
    add(G.rbox(0.28, 0.26, 0.96, 0.05, 3), S.plasma, [0, -0.13, -0.48]);                  // main housing
    add(G.rbox(0.14, 0.06, 0.8, 0.02), S.plasmaDk, [0, 0.01, -0.46]);                    // top spine
    for (let i = 0; i < 6; i++) add(G.box(0.108, 0.006, 0.042), S.bore, [0, 0.039, -0.19 - i * 0.1]);   // heat slots
    for (const sx of [-1, 1]) {
      add(G.rbox(0.02, 0.14, 0.72, 0.008), S.plasmaDk, [sx * 0.145, -0.13, -0.5]);        // side panels
      for (let i = 0; i < 5; i++) add(G.box(0.006, 0.08, 0.025), S.bore, [sx * 0.156, -0.13, -0.28 - i * 0.07]);
    }
    add(G.rbox(0.13, 0.05, 0.1, 0.01), S.plasmaDk, [0, 0.005, -0.06], [-0.35, 0, 0]);    // readout housing
    add(G.box(0.09, 0.004, 0.06), S.screen, [0, 0.03, -0.058], [-0.35, 0, 0]);
    add(G.rbox(0.24, 0.24, 0.12, 0.04), S.plasmaDk, [0, -0.1, -1.0]);                     // front block
    add(G.cyl(0.058, 0.054, 0.62, 16), S.steelDk, [0, -0.02, -1.35]);                    // emitter
    for (const sy of [-1, 1]) add(G.rbox(0.05, 0.03, 0.62, 0.01), S.plasma, [0, -0.02 + sy * 0.125, -1.35]);   // coil guards
    for (const sx of [-1, 1]) add(G.rbox(0.03, 0.05, 0.62, 0.01), S.plasma, [sx * 0.125, -0.02, -1.35]);
    add(G.tor(0.1, 0.028, Math.PI * 2, 28, 8), S.steelLt, [0, -0.02, -1.67]);              // muzzle ring
    add(G.rbox(0.1, 0.1, 0.16, 0.03), S.plasmaDk, [0, -0.28, -0.15]);                     // grip mount
    push(xf([0, -0.44, -0.08], [-0.22, 0, 0]));
    add(G.rbox(0.09, 0.3, 0.14, 0.03), S.grip, [0, 0, 0]);
    pop();
    trigger(-0.26, -0.26, 0.055);
    add(G.cylY(0.042, 0.24, 14), S.grip, [0, -0.37, -0.76], [-0.1, 0, 0]);               // fore grip
    add(G.rbox(0.09, 0.08, 0.14, 0.02), S.plasmaDk, [0, -0.26, -0.76]);
    add(G.rbox(0.07, 0.1, 0.2, 0.02), S.plasmaDk, [-0.17, -0.12, -0.36]);                 // cell housing
    if (h) {
      grip(1, { at: [0, -0.44, -0.08], axis: [0, 0.975, -0.22], from: [1, 0, 0.3], r: 0.06, curl: [[0.4, 0.8, 0.4]], thumb: THUMB.pistol, arm: [0.35, -0.5, 1], armLen: 1.2 });
      grip(-1, { at: [0, -0.13, -0.62], axis: [0, 0, -1], from: [-0.7, -0.7, 0], r: 0.14, thumb: THUMB.side, arm: [-0.4, -0.8, 0.45], armLen: 1.0 });
    }
    part('coils');   // everything that glows with the gun's heat (s.charge)
    for (let i = 0; i < 4; i++) add(G.tor(0.088, 0.024, Math.PI * 2, 24, 8), glow('#6fd3ff'), [0, -0.02, -1.1 - i * 0.12]);
    add(G.sph(0.045, 14, 10), glow('#bfefff', 1.2), [0, -0.02, -1.67], null, [1, 1, 0.5]);
    for (let i = 0; i < 6; i++) add(G.box(0.096, 0.004, 0.03), glow('#4fb8ff', 0.8), [0, 0.0425, -0.19 - i * 0.1]);
    for (const sx of [-1, 1]) add(G.box(0.004, 0.012, 0.6), glow('#4fb8ff', 0.7), [sx * 0.157, -0.06, -0.5]);
    add(G.box(0.03, 0.03, 0.004), glow('#4fb8ff', 0.8), [-0.206, -0.12, -0.36]);
  },
  pickup: { scale: 1.3, rot: [0, 0.5, Math.PI / 2] },
  animate(w, s, clip, t) {
    const g = w.gun, heat = clamp(s.charge || 0, 0, 1);
    let flick = 1;
    if (clip === 'fire') {
      const tt = t % 3, k = kick(tt, 0, 0.5, 2.2), n = Math.floor((s.time || 0) * 35);
      g.position.z += 0.025 * k; g.rotation.x += 0.015 * k;
      g.position.x += (hash(n) - 0.5) * 0.005; g.position.y += (hash(n + 2) - 0.5) * 0.005;
      flick = 0.8 + 0.4 * hash(n + 5);
    } else if (clip === 'cool') {
      const c = 1 - smooth(ramp(t, 0, 20));
      g.position.z += 0.01 * c; g.rotation.x += 0.007 * c * Math.cos(t * 0.8);
    }
    w.glowMat.color.setScalar((1.1 + heat * 9) * flick);
  },
};

// ---- BFG
DEFS.bfg = {
  view: { at: [0, 0.02, 0], d: 0.8, pitch: 4, edge: 0.18 }, chunk: [1.2, 1.15], hands: 1.2,
  flash: { kind: 'bfg', at: [0, -0.22, -1.3], size: 2.4 },
  lightAt: [0, 0.2, -0.9], lightI: 14,
  build(h) {
    part('body');
    add(G.rbox(0.68, 0.44, 1.06, 0.07, 3), S.bfg, [0, -0.22, -0.53]);                     // main block
    add(G.rbox(0.48, 0.07, 0.86, 0.025), S.bfgDk, [0, 0.01, -0.5]);                      // top armour
    for (const sx of [-1, 1]) {
      add(G.cyl(0.11, 0.11, 0.9, 20), S.bfgDk, [sx * 0.35, -0.3, -0.55]);                 // capacitor tubes
      for (let i = 0; i < 4; i++) add(G.cyl(0.118, 0.118, 0.035, 20), S.steel, [sx * 0.35, -0.3, -0.22 - i * 0.2]);
      add(G.rbox(0.05, 0.2, 0.5, 0.015), S.bfgDk, [sx * 0.345, -0.1, -0.6]);              // side armour
      bolts([[sx * 0.372, -0.05, -0.45, Math.PI / 2], [sx * 0.372, -0.05, -0.75, Math.PI / 2]], 0.014, S.steelLt);
    }
    add(G.rbox(0.58, 0.42, 0.14, 0.05), S.bfgDk, [0, -0.22, -1.1]);                       // front bezel
    add(G.tor(0.2, 0.05, Math.PI * 2, 32, 10), S.steelLt, [0, -0.22, -1.18]);             // emitter ring
    for (let i = 0; i < 3; i++) { const a = Math.PI / 2 + i * Math.PI * 2 / 3; add(G.rbox(0.06, 0.06, 0.22, 0.015), S.steel, [Math.cos(a) * 0.25, -0.22 + Math.sin(a) * 0.25, -1.28], [0, 0, a]); }
    add(G.lathe([[0.2, 0], [0.16, 0.06], [0.1, 0.1]], 28), S.bore, [0, -0.22, -1.06]);   // throat behind the core
    add(G.rbox(0.52, 0.32, 0.04, 0.02), S.bfgDk, [0, -0.21, 0.01]);                        // rear panel
    add(G.rbox(0.36, 0.08, 0.03, 0.012), S.steelDk, [0, -0.1, 0.03]);                      // charge meter housing
    for (let i = 0; i < 4; i++) add(G.box(0.3, 0.014, 0.012), S.bore, [0, -0.2 - i * 0.04, 0.032]);   // vents
    bolts([[-0.22, -0.08, 0.035], [0.22, -0.08, 0.035], [-0.22, -0.34, 0.035], [0.22, -0.34, 0.035]], 0.016, S.steelLt);
    for (const sx of [-1, 1]) {                                                             // handles
      add(G.rbox(0.12, 0.08, 0.16, 0.02), S.steel, [sx * 0.38, -0.3, -0.12]);
      add(G.cylY(0.045, 0.3, 14), S.grip, [sx * 0.45, -0.44, -0.1], [-0.25, 0, 0]);
    }
    if (h) {
      grip(1, { at: [0.45, -0.45, -0.1], axis: [0, 0.97, -0.25], from: [0.75, 0, 0.66], r: 0.045, arm: [0.35, -0.55, 1], armLen: 1.3 });
      grip(-1, { at: [-0.45, -0.45, -0.1], axis: [0, 0.97, -0.25], from: [-0.75, 0, 0.66], r: 0.045, arm: [-0.35, -0.55, 1], armLen: 1.3 });
    }
    part('core');
    add(G.sph(0.15, 20, 14), glow('#8dff6a', 1.2), [0, -0.22, -1.16]);
    for (let i = 0; i < 3; i++) add(G.box(0.3, 0.012, 0.04), glow('#5cff40', 0.8), [0, 0.046, -0.3 - i * 0.16]);
    for (const sx of [-1, 1]) add(G.box(0.004, 0.04, 0.4), glow('#5cff40', 0.6), [sx * 0.342, -0.2, -0.6]);
    part('meter', { pivot: [-0.15, -0.1, 0.048], pickup: false });   // charge bar on the rear panel, fills with s.charge
    add(G.box(0.3, 0.036, 0.006), glow('#6cff50', 0.9), [0, -0.1, 0.048]);
  },
  pickup: { scale: 1.55, rot: [0, 0.5, 0] },
  animate(w, s, clip, t, F) {
    const g = w.gun, ch = clamp(s.charge || 0, 0, 1), n = Math.floor((s.time || 0) * 35);
    let gl = 1 + 0.15 * Math.sin((s.time || 0) * 3);
    F.kind = null; F.size = 0;   // the BFG's flash follows the charge, not the logic's flash frames
    if (clip === 'fire') {
      if (t < 30) {
        const a = 0.003 + 0.01 * ch;   // shakes harder as it charges
        g.position.x += (hash(n) - 0.5) * a; g.position.y += (hash(n + 1) - 0.5) * a; g.rotation.z += (hash(n + 2) - 0.5) * a;
        gl = 1 + ch * 14 * (0.85 + 0.3 * hash(n + 3));
        if (ch > 0.05) {   // crackle at the emitter, swelling toward the shot
          F.kind = 'bfg'; F.frame = 1 + (n & 1); F.size = 0.25 + 0.55 * ch * (0.7 + 0.5 * hash(n + 4)); F.gain = 0.25 + 0.4 * ch; F.light = 0.3 * ch;
        }
      } else {
        const k = kick(t, 30, 1.5, 9), f = 1 - ramp(t, 30, 37);
        g.position.z += 0.18 * k; g.rotation.x += 0.16 * k; g.position.y += 0.03 * k;
        gl = 1 + 14 * (1 - ramp(t, 30, 40));
        if (f > 0) { F.kind = 'bfg'; F.frame = 1 + (n & 1); F.size = 1.7 * (0.55 + 0.45 * f); F.gain = 0.4 + 0.7 * f; F.light = f; }
      }
    }
    w.glowMat.color.setScalar(gl);
    w.parts.meter.scale.x = clip === 'fire' ? Math.max(0.02, t < 30 ? ch : 1 - ramp(t, 30, 34)) : 1;
  },
};

// ------------------------------------------------------ flash sprites ----
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function starTexture(seed, rays, pal) {
  const N = 128, c = N / 2, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const x = cv.getContext('2d'), r = rng(seed);
  x.globalCompositeOperation = 'lighter';
  // jagged rays of flame from the centre
  for (let i = 0; i < rays; i++) {
    const a = (i + r() * 0.6) / rays * Math.PI * 2, len = c * (0.45 + 0.55 * r()), w = 0.07 + 0.12 * r();
    const gr = x.createLinearGradient(c, c, c + Math.cos(a) * len, c + Math.sin(a) * len);
    gr.addColorStop(0, pal[1]); gr.addColorStop(0.45, pal[2]); gr.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = gr; x.beginPath();
    x.moveTo(c + Math.cos(a + Math.PI / 2) * len * w * 0.5, c + Math.sin(a + Math.PI / 2) * len * w * 0.5);
    x.lineTo(c + Math.cos(a) * len, c + Math.sin(a) * len);
    x.lineTo(c + Math.cos(a - Math.PI / 2) * len * w * 0.5, c + Math.sin(a - Math.PI / 2) * len * w * 0.5);
    x.closePath(); x.fill();
  }
  // lumpy fireball body and a white-hot core
  for (let i = 0; i < 9; i++) {
    const a = r() * Math.PI * 2, d = c * 0.22 * r(), rr = c * (0.22 + 0.2 * r()), px = c + Math.cos(a) * d, py = c + Math.sin(a) * d;
    const g = x.createRadialGradient(px, py, 0, px, py, rr);
    g.addColorStop(0, pal[2]); g.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = g; x.fillRect(0, 0, N, N);
  }
  const g = x.createRadialGradient(c, c, 0, c, c, c * 0.42);
  g.addColorStop(0, pal[0]); g.addColorStop(0.35, pal[1]); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function haloTexture() {
  const N = 64, c = N / 2, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const x = cv.getContext('2d'), g = x.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,0.45)'); g.addColorStop(0.6, 'rgba(255,255,255,0.1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, N, N);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
let TEX = null;
function flashTextures() {
  if (TEX) return TEX;
  const fire = ['#ffffff', '#fff0b0', '#ffa030', '#ff5010'], blue = ['#ffffff', '#d8f4ff', '#58b4ff'], green = ['#ffffff', '#dcffd0', '#58ff48'];
  TEX = {
    bullet: [starTexture(11, 11, fire), starTexture(23, 9, fire)],
    rocket: [starTexture(37, 13, fire), starTexture(41, 10, fire)],
    plasma: [starTexture(53, 14, blue), starTexture(67, 12, blue)],
    bfg: [starTexture(71, 16, green), starTexture(83, 13, green)],
    halo: haloTexture(),
    tint: { bullet: new THREE.Color(1, 0.7, 0.4), rocket: new THREE.Color(1, 0.55, 0.25), plasma: new THREE.Color(0.45, 0.7, 1), bfg: new THREE.Color(0.4, 1, 0.35) },
  };
  return TEX;
}

// ------------------------------------------------------------ assembly ----
const chunkOf = def => new THREE.Matrix4().makeScale(def.chunk ? def.chunk[0] : 1, def.chunk ? def.chunk[1] : 1, 1);
function buildParts(def, hands) {
  PARTS = {}; STACK.length = 1; STACK[0] = chunkOf(def); HK = def.hands || 1;
  def.build(hands);
  const p = PARTS; PARTS = OUT = null; STACK[0] = new THREE.Matrix4(); HK = 1;
  return p;
}
// Root placement from the view spec: gun-space point `at` lands on the bottom edge (or `edge` of the view height
// above it) at distance d, offset x, with the gun pitched down by `pitch` degrees.
function placeRoot(root, v, C) {
  if (!v) return;
  const sc = v.scale || 1;
  root.rotation.set(-(v.pitch || 0) * D2R, (v.yaw || 0) * D2R, (v.roll || 0) * D2R);
  root.scale.setScalar(sc);
  const a = V(v.at).applyMatrix4(C).multiplyScalar(sc).applyEuler(root.rotation);
  root.position.set(v.x || 0, -v.d * Math.tan(VFOV / 2 * D2R) * (1 - 2 * (v.edge || 0)), -v.d).sub(a);
}
function makeWeapon(id, mat) {
  const def = DEFS[id], parts = buildParts(def, true), C = chunkOf(def);
  const root = new THREE.Group(), gun = new THREE.Group();
  root.name = 'vm:' + id; root.add(gun);
  placeRoot(root, def.view, C);
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const P = {};
  let tris = 0, draws = 0;
  for (const [name, p] of Object.entries(parts)) {
    const o = new THREE.Group(), pv = V(p.pivot);
    o.name = name; o.position.copy(pv);
    if (p.parent) o.position.sub(V(parts[p.parent].pivot));
    o.userData.p0 = o.position.clone();
    for (const [list, m] of [[p.std, mat], [p.glow, glowMat]]) {
      if (!list.length) continue;
      const geo = mergeGeometries(list).translate(-pv.x, -pv.y, -pv.z);
      geo.computeBoundingSphere();
      o.add(new THREE.Mesh(geo, m));
      tris += geo.attributes.position.count / 3; draws++;
    }
    P[name] = o;
  }
  for (const [name, p] of Object.entries(parts)) (p.parent ? P[p.parent] : gun).add(P[name]);
  return { id, def, root, gun, parts: P, list: Object.values(P), glowMat, tris, draws,
    flashAt: V((def.flash && def.flash.at) || [0, 0, 0]).applyMatrix4(C), lightAt: V(def.lightAt || [0, 0, 0]).applyMatrix4(C) };
}

// ------------------------------------------------------ the view model ----
export function createViewModel({ renderer } = {}) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(VFOV, 16 / 9, 0.01, 10);
  const mat = stdMaterial(VIEW_UNIFORMS);
  // Neutral stand-in IBL until the room's arrives, at the house probes' 128 px cube size so switching to a room env
  // needs no shader recompile (metals are black without reflections); without a renderer a hemisphere light fills in.
  let fallback = null;
  if (renderer) {
    const pm = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
    fallback = pm.fromScene(room, 0.04, 0.1, 100, { size: 128 }).texture;
    pm.dispose(); room.dispose();
  }
  scene.add(new THREE.HemisphereLight(0xe8ecff, 0x40362c, fallback ? 0 : 1.4));
  const light = new THREE.PointLight(0xffffff, 0, 0, 2);            // muzzle flash light (always present: fixed shader)
  scene.add(light);
  const tex = flashTextures();
  // drawn over the weapon like Doom's flash sprites (the muzzle is always the far end of the gun)
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.bullet[0], blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }));
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex.halo, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true }));
  core.renderOrder = 10; halo.renderOrder = 11;
  core.visible = halo.visible = false;
  scene.add(core, halo);

  const weapons = {};
  for (const id of WEAPON_IDS) { const w = weapons[id] = makeWeapon(id, mat); w.root.visible = false; scene.add(w.root); }
  let cur = null;

  // Projection: base perspective, then a 2D affine in NDC — shrink about the bottom-centre for narrow views,
  // bob and lowering as pure screen translations (Doom moves its weapon sprite in 2D).
  const proj0 = new THREE.Matrix4(), shift = new THREE.Matrix4();
  let aspect = 16 / 9, shrink = 1, bobX = 0, bobY = 0, drop = 0, lowerDist = 1.3;
  function project() {
    const dx = bobX * BOB * 2 * (MIN_ASPECT / aspect) * shrink;
    const dy = -bobY * BOB * 2 * shrink - drop * lowerDist * shrink;
    shift.set(shrink, 0, 0, dx, 0, shrink, 0, shrink - 1 + dy, 0, 0, 1, 0, 0, 0, 0, 1);
    camera.projectionMatrix.multiplyMatrices(shift, proj0);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  function setAspect(a) {
    aspect = a > 0 ? a : 16 / 9;
    camera.aspect = aspect; camera.fov = VFOV;
    camera.updateProjectionMatrix();
    proj0.copy(camera.projectionMatrix);
    shrink = Math.min(1, aspect / MIN_ASPECT);
    project();   // keep the current bob / lowering: a resize between update() and the render must not pop the weapon up
  }
  setAspect(16 / 9);
  // how far (NDC) the weapons must drop to leave the view: highest rest-pose vertex over all weapons
  {
    const v = new THREE.Vector3(), s0 = { weapon: '', clip: 'idle', tics: 0, time: 0 };
    let top = -1;
    for (const w of Object.values(weapons)) {
      s0.weapon = w.id; w.def.animate(w, s0, 'idle', 0, F0);
      w.root.updateMatrixWorld(true);
      w.root.visible = true;
      w.root.traverseVisible(o => {
        if (!o.isMesh) return;
        const pa = o.geometry.attributes.position;
        for (let i = 0; i < pa.count; i += 3) {
          v.fromBufferAttribute(pa, i).applyMatrix4(o.matrixWorld);
          if (v.z < -0.05) { v.applyMatrix4(proj0); top = Math.max(top, v.y); }   // Vector3.applyMatrix4 divides by w
        }
      });
      w.root.visible = false;
    }
    lowerDist = top + 1 + 0.08;
  }

  function setEnv(e) {
    e = e || fallback;
    if (!!e !== !!mat.envMap) mat.needsUpdate = true;
    mat.envMap = e; mat.envMapIntensity = e === fallback ? FALLBACK_ENV : 1;
  }
  setEnv(null);
  // Optional: the world camera's rotation, so the room lighting on the weapon turns with the view.
  const _qi = new THREE.Quaternion();
  function setViewRotation(q) { mat.envMapRotation.setFromQuaternion(_qi.copy(q).invert()); }

  const F = { kind: null, frame: 1, size: 0, gain: 1, light: 1 };
  const _v = new THREE.Vector3(), _bp = new THREE.Vector3(), _bq = new THREE.Quaternion();
  const ROCKET_SIZE = [0.5, 0.8, 1.05, 0.7], ROCKET_GAIN = [0.6, 0.9, 1.1, 0.7];
  let lastW = null, lastClip = '', lastT = 0, blending = false;
  function update(dt, s) {
    const w = weapons[s.weapon] || weapons.pistol;
    if (w !== cur) { if (cur) cur.root.visible = false; cur = w; }
    const lower = clamp(s.lower || 0, 0, 1), clip = s.clip || 'idle', t = Math.max(0, s.tics || 0), time = s.time || 0;
    w.root.visible = lower < 1;
    // Doom's A_ReFire restarts a clip before its end when the trigger is held (the shotgun still settling at 37,
    // the super shotgun still lowered with the breech open at 51): carry the gun's last pose into the new cycle and
    // ease out of it before the next shot instead of popping to the rest pose in one frame
    if (w.def.blend && w === lastW && clip === lastClip && clip !== 'idle' && t < lastT - 0.5) {
      _bp.copy(w.gun.position); _bq.copy(w.gun.quaternion); blending = true;
    } else if (w !== lastW || clip !== lastClip) blending = false;
    lastW = w; lastClip = clip; lastT = t;
    // reset to the rest pose, then let the weapon pose itself
    w.gun.position.set(0, 0, 0); w.gun.rotation.set(0, 0, 0);
    for (const p of w.list) { p.position.copy(p.userData.p0); p.rotation.set(0, 0, 0); p.visible = true; }
    F.kind = null; F.size = 0; F.gain = 1; F.light = 1;
    if (w.def.flash && s.flash > 0) {
      const fr = s.flash | 0, kind = w.def.flash.kind;
      F.kind = kind; F.frame = fr;
      F.size = w.def.flash.size * (kind === 'rocket' ? ROCKET_SIZE[clamp(fr, 1, 4) - 1] : fr > 1 ? 0.8 : 1);
      if (kind === 'rocket') F.gain = F.light = ROCKET_GAIN[clamp(fr, 1, 4) - 1];
    }
    w.def.animate(w, s, clip, t, F);
    // breathing: barely-there sway so an idle weapon isn't frozen
    w.gun.position.y += Math.sin(time * 1.7) * 0.003;
    w.gun.rotation.x += Math.sin(time * 1.7 + 0.8) * 0.003;
    w.gun.rotation.z += Math.sin(time * 1.1) * 0.002;
    if (blending) {
      const k = 1 - smooth(ramp(t, 0, w.def.blend));
      if (k > 0) { w.gun.position.lerp(_bp, k); w.gun.quaternion.slerp(_bq, k); } else blending = false;
    }
    // berserk fist
    const bz = s.berserk && w.id === 'fist';
    if (bz) VIEW_UNIFORMS.uSkin.value.setRGB(SKIN_BERSERK[0], SKIN_BERSERK[1], SKIN_BERSERK[2]); else VIEW_UNIFORMS.uSkin.value.setRGB(1, 1, 1);
    VIEW_UNIFORMS.uSkinGlow.value = bz ? SKIN_GLOW : 0;
    // screen-space bob + lowering + narrow-view shrink
    bobX = s.bobX || 0; bobY = s.bobY || 0; drop = lower;
    project();
    // muzzle flash sprites and light
    w.root.updateMatrixWorld(true);
    if (F.kind && F.size > 0 && w.root.visible) {
      const fx = FLASH[F.kind], tx = tex[F.kind];
      _v.copy(w.flashAt).applyMatrix4(w.gun.matrixWorld);
      const sc = F.size * ((w.def.view && w.def.view.scale) || 1);
      core.visible = halo.visible = true;
      core.position.copy(_v); halo.position.copy(_v);
      core.material.map = tx[(F.frame - 1) & 1];
      core.material.rotation = hash(Math.floor(time * 35) + F.frame) * Math.PI * 2;
      core.material.color.setRGB(fx.tint[0], fx.tint[1], fx.tint[2]).multiplyScalar(fx.core * F.gain);
      halo.material.color.copy(tex.tint[F.kind]).multiplyScalar(fx.halo * F.gain);
      core.scale.set(sc, sc, 1); halo.scale.set(sc * fx.haloSize, sc * fx.haloSize, 1);
      _v.copy(w.lightAt).applyMatrix4(w.gun.matrixWorld);
      light.position.copy(_v);
      light.color.setRGB(fx.light[0], fx.light[1], fx.light[2]);
      light.intensity = (w.def.lightI || 3) * F.light;
    } else {
      core.visible = halo.visible = false;
      light.intensity = 0;
    }
  }

  // Compile every program now (all materials, visible or not) so the first frame and the first switch don't hitch.
  // The composer draws the weapon into a float target (tone mapping and sRGB come later in the chain), so compile
  // under one: compiled for the canvas, the programs would be tone-mapped variants that are never used.
  function compile() {
    if (!renderer) return;
    const prev = renderer.getRenderTarget(), rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    renderer.setRenderTarget(rt);
    renderer.compile(scene, camera);
    renderer.setRenderTarget(prev);
    rt.dispose();
  }
  compile();

  const stats = () => Object.fromEntries(WEAPON_IDS.map(id => [id, { tris: weapons[id].tris, draws: weapons[id].draws }]));
  // Dev/tuning hook: patch a weapon's definition (view, chunk, hands…) and rebuild it in place.
  function rebuild(id, patch) {
    if (patch.fov) { VFOV = patch.fov; setAspect(aspect); }
    Object.assign(DEFS[id], patch);
    const old = weapons[id];
    scene.remove(old.root); old.root.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    const w = weapons[id] = makeWeapon(id, mat);
    w.root.visible = false; scene.add(w.root);
    if (cur === old) cur = null;
    delete PICK_CACHE[id];
    return { tris: w.tris, draws: w.draws };
  }
  return { scene, camera, setAspect, setEnv, setViewRotation, update, compile, stats, rebuild, weapons, get aspect() { return aspect; } };
}
const F0 = { kind: null, frame: 1, size: 0, gain: 1, light: 1 };

// ------------------------------------------------------------ pickups ----
const PICK_CACHE = {};
function pickupGeometry(id) {
  if (PICK_CACHE[id]) return PICK_CACHE[id];
  const parts = buildParts(DEFS[id], false), std = [], gl = [];
  for (const p of Object.values(parts)) if (p.pickup) { std.push(...p.std); gl.push(...p.glow); }
  return (PICK_CACHE[id] = { std: std.length ? mergeGeometries(std) : null, glow: gl.length ? mergeGeometries(gl) : null });
}
// World-space weapon pickup (feet): lying on the floor, origin at the floor contact point, centred.
export function buildWeaponPickup(id) {
  const group = new THREE.Group();
  group.name = 'pickup:' + id;
  const def = DEFS[id];
  if (!def || !def.pickup) return group;   // fists can't be picked up
  const geo = pickupGeometry(id), inner = new THREE.Group();
  if (geo.std) inner.add(new THREE.Mesh(geo.std, stdMaterial(PICKUP_UNIFORMS)));
  if (geo.glow) { const m = new THREE.MeshBasicMaterial({ vertexColors: true }); m.color.setScalar(2.5); inner.add(new THREE.Mesh(geo.glow, m)); }
  inner.rotation.fromArray(def.pickup.rot);
  inner.scale.setScalar(def.pickup.scale);
  inner.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(inner, true);
  inner.position.set(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  group.add(inner);
  return group;
}
// Assign the room's IBL to every lit material of a pickup (or the view model's own groups).
export function setEnv(group, env) {
  env = env || null;
  group.traverse(o => {
    if (!o.isMesh || !o.material || !o.material.isMeshStandardMaterial) return;
    const m = o.material;
    if (!!m.envMap !== !!env) m.needsUpdate = true;
    m.envMap = env; m.envMapIntensity = 1;
  });
}
