// Ocean Lane: Imps in the House — a Doom-style game in the walkthrough house.
// The house engine is the walkthrough's: baked global illumination (lightmaps + per-vertex probes), per-room
// reflection probes, auto exposure, doors, collisions and stairs. On top of it: Doom's player movement and damage,
// its nine weapons, the children as imps, pickups, keys and secrets, a Doom status bar, menus and an automap.
import * as THREE from 'three';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import * as L from './layout.js';
import { buildHouse, roomAt } from './house.js';
import { layoutLightmap, collectProbes, doorFrame } from './lightmap.js';
import { makeMaterial, isGlow, setAnisotropy } from './materials.js';
import { prebuildKids } from './kids.js';
import { Audio } from './game/audio.js';
import { createFx } from './game/fx.js';
import { createViewModel, buildWeaponPickup, setEnv as setWeaponEnv } from './game/viewmodel.js';
import { buildItem, animateItem, setEnv as setItemEnv, setItemAmbient } from './game/itemmodels.js';
import { createHud } from './game/hud.js';
import { createScreens } from './game/screens.js';
import { createImps } from './game/imps.js';
import { createWeapons, WEAPONS } from './game/weapons.js';
import { createCombat } from './game/combat.js';
import { createItems, applyPickup, LOCKS, SECRETS, isWeaponItem, isPowerup } from './game/items.js';
const kidGeometry = prebuildKids(1.6);   // the imps' meshes build in workers while the house loads

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ------------------------------------------------------------ constants ----
const TEST = new URLSearchParams(location.search).has('test');   // headless tests: no pointer lock, no gestures
if (TEST) {   // tests read warning counts from window.__warns
  const warn = console.warn;
  window.__warns = {};
  console.warn = (...a) => { const k = String(a[0]).slice(0, 70); window.__warns[k] = (window.__warns[k] || 0) + 1; warn.apply(console, a); };
}
const EYE = 5.35, R = 0.75, STEP = 1.05;
const WALK = 9, RUN = 15;                    // ft/s; Doom's momentum: 0.90625 friction per tic
const TURN_WALK = 2.8, TURN_RUN = 4.3;       // keyboard turning, rad/s
const MOUSE = 0.0022, TOUCH_LOOK = 0.0075;             // radians per pixel of mouse / finger movement
const BODY_LO = 1.0, BODY_HI = 5.9;
const CROUCH_EYE = 3.1, CROUCH_HI = 3.6, JUMP_V = 9.5;
const PAR = 180;                             // par time for the intermission (s)
const LEVEL_NAME = 'OCEAN LANE';
let bodyHi = BODY_HI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// -------------------------------------------------------------- options ----
// Remembered per browser. Time of day scales and tints the baked daylight layer and adds the house lights on top.
const OPT_KEY = 'oceanLaneDoom.options';
const DEFAULTS = { sens: 1, music: 0.6, sfx: 0.8, brightness: 0, fov: 74, bloom: 0.05, lights: 1, tod: 'night',
  alwaysRun: true, autoaim: true, viewBob: true, retro: false, messages: true };
const opts = { ...DEFAULTS };
try { Object.assign(opts, JSON.parse(localStorage.getItem(OPT_KEY) || '{}')); } catch (e) { /* storage unavailable */ }
const saveOpts = () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(opts)); } catch (e) { /* ignore */ } };
const TOD = {
  day: { day: [1, 1, 1], key: 1.0, zen: [0.9, 1.45, 3.1], hor: [2.9, 3.35, 4.0], sun: 1, frost: 1 },
  dusk: { day: [0.3, 0.19, 0.12], key: 0.75, zen: [0.22, 0.2, 0.42], hor: [1.5, 0.75, 0.42], sun: 0.15, frost: 0.3 },
  night: { day: [0.008, 0.011, 0.022], key: 0.5, zen: [0.004, 0.006, 0.016], hor: [0.012, 0.014, 0.024], sun: 0, frost: 0.03 },
};
const tod = () => TOD[opts.tod] || TOD.day;

// ---------------------------------------------------------------- page ----
const canvas = document.getElementById('view');
const warnEl = document.getElementById('warn');
let W = window.innerWidth, H = window.innerHeight, viewH = H;

// ------------------------------------------------------------- renderer ----
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: TEST });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1;
setAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(opts.fov, W / H, 0.08, 800);
camera.rotation.order = 'YXZ';
// effects first: their four point lights must exist before any material compiles (the light count never changes)
const fx = createFx({ scene, camera });
const vm = createViewModel({ renderer });

// HDR pipeline: 4x MSAA world render → first-person weapon on top → bloom → tone map + sRGB
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.setPixelRatio(renderer.getPixelRatio());
composer.setSize(W, H);
composer.addPass(new RenderPass(scene, camera));
const vmPass = new RenderPass(vm.scene, vm.camera);
vmPass.clear = false; vmPass.clearDepth = true;
composer.addPass(vmPass);
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.05, 0.15, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// Sky dome: same radiance as the bake so windows read correctly.
const SKY = { zenith: [0.9, 1.45, 3.1], horizon: [2.9, 3.35, 4.0] };
const sunDir = new THREE.Vector3(...L.SUN_DIR).normalize();
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { zen: { value: new THREE.Vector3(...SKY.zenith) }, hor: { value: new THREE.Vector3(...SKY.horizon) }, sun: { value: sunDir }, sunK: { value: 1 } },
  vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
  fragmentShader: `varying vec3 vD; uniform vec3 zen, hor, sun; uniform float sunK;
    void main(){ vec3 d = normalize(vD); vec3 c = d.y < 0.0 ? hor * 0.35 : mix(hor, zen, pow(d.y, 0.55));
      float s = max(dot(d, sun), 0.0); c += vec3(1.0, 0.95 - 0.35 * (1.0 - sunK), 0.85 - 0.6 * (1.0 - sunK)) * sunK * (pow(s, 1200.0) * 400.0 + pow(s, 12.0) * 1.5);
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), skyMat);
sky.frustumCulled = false;
scene.add(sky);

// --------------------------------------------------------------- menus ----
const game = { state: 'title', skill: 3, stats: null, secrets: new Set(), deadT: 0, quietShown: false, time: 0 };
let screens = null;   // created below; the title screen shows the loading progress
const setLoading = t => screens?.setLoading(t);

// ---------------------------------------------------------------- build ----
const house = buildHouse();
const parts = house.b.parts;
const atlas = layoutLightmap(parts);
const probeList = collectProbes(house);

async function loadBake() {
  try {
    // meta.json is always fetched fresh; the bake's timestamp versions the big files
    const meta = await (await fetch('baked/meta.json', { cache: 'no-store' })).json();
    const v = encodeURIComponent(meta.date || meta.seconds || '');
    if (meta.W !== atlas.W || meta.H !== atlas.H || meta.probes !== probeList.count) {
      console.warn('Baked lighting is out of date with the layout', meta, atlas, probeList.count);
      return null;
    }
    const tex = t => { t.flipY = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true; return t; };
    const bin = async n => new Float32Array(await (await fetch(`baked/${n}?v=${v}`)).arrayBuffer());
    if (meta.layers) {
      const [lmDay, lmLamp, prDay, prLamp] = await Promise.all([
        new HDRLoader().loadAsync(`baked/lightmap_day.hdr?v=${v}`), new HDRLoader().loadAsync(`baked/lightmap_lamps.hdr?v=${v}`),
        bin('probes_day.bin'), bin('probes_lamps.bin')]);
      const rt = new THREE.WebGLRenderTarget(meta.W, meta.H, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false });
      rt.texture.channel = 1;
      return { meta, lm: rt.texture, rt, lmDay: tex(lmDay), lmLamp: tex(lmLamp), prDay, prLamp, probes: new Float32Array(prDay.length) };
    }
    const lm = tex(await new HDRLoader().loadAsync(`baked/lightmap.hdr?v=${v}`));
    lm.channel = 1;
    return { meta, lm, probes: await bin('probes.bin') };
  } catch (e) {
    console.warn('No baked lighting found', e);
    return null;
  }
}

const bake = new URLSearchParams(location.search).has('nobake') ? null : await loadBake();
const mixK = () => ({ dk: tod().day, lk: opts.lights });
function mixProbes() {
  if (!bake?.prDay) return;
  const { dk, lk } = mixK(), a = bake.prDay, b = bake.prLamp, o = bake.probes;
  for (let i = 0; i < o.length; i += 3) for (let c = 0; c < 3; c++) o[i + c] = a[i + c] * dk[c] + b[i + c] * lk;
}
mixProbes();
const irrTargets = [];
if (!bake) {
  scene.add(new THREE.HemisphereLight('#ffffff', '#8a7a66', 2.5));
  warnEl.classList.remove('hidden');
}

// ------------------------------------------------ assemble static geometry ----
const roomKey = (x, z, y) => { const r = roomAt(x, z, y); return r ? r.id : 'ext'; };
const groups = new Map();
function group(matKey, variant, room) {
  const k = `${matKey}|${variant}|${room}`;
  if (!groups.has(k)) groups.set(k, { matKey, variant, room, pos: [], nrm: [], uv: [], uv1: [], irr: [], pidx: [] });
  return groups.get(k);
}
const probeIrr = i => (bake ? [bake.probes[i * 3], bake.probes[i * 3 + 1], bake.probes[i * 3 + 2]] : [0.3, 0.3, 0.3]);
for (const p of parts) {
  if (p.kind === 'poly') {
    const c = p.pts.reduce((a, q) => [a[0] + q[0], a[1] + q[1], a[2] + q[2]], [0, 0, 0]).map(v => v / p.pts.length);
    const room = roomKey(c[0] + p.n[0] * 0.3, c[2] + p.n[2] * 0.3, c[1] + p.n[1] * 0.3 + 0.01);
    const g = group(p.mat, p.lm ? 'lm' : 'basic', room);
    for (let i = 1; i < p.pts.length - 1; i++) {
      for (const k of [0, i, i + 1]) {
        g.pos.push(...p.pts[k]); g.nrm.push(...p.n); g.uv.push(...p.uv[k]);
        if (p.uv1) g.uv1.push(...p.uv1[k]);
      }
    }
  } else if (p.kind === 'mesh') {
    const n = p.pos.length / 3;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += p.pos[i * 3]; cy += p.pos[i * 3 + 1]; cz += p.pos[i * 3 + 2]; }
    const g = group(p.mat, isGlow(p.mat) ? 'glow' : 'vx', roomKey(cx / n, cz / n, cy / n));
    for (let i = 0; i < n; i++) {
      g.pos.push(p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]);
      g.nrm.push(p.nrm[i * 3], p.nrm[i * 3 + 1], p.nrm[i * 3 + 2]);
      g.uv.push(p.uv[i * 2], p.uv[i * 2 + 1]);
      g.irr.push(...probeIrr(p.probeBase + i));
      g.pidx.push(p.probeBase + i);
    }
  }
}
const roomMaterials = new Map();
const staticMeshes = [];
for (const g of groups.values()) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
  if (g.variant === 'lm') geo.setAttribute('uv1', new THREE.Float32BufferAttribute(g.uv1, 2));
  if (g.variant === 'vx') {
    geo.setAttribute('irr', new THREE.Float32BufferAttribute(g.irr, 3));
    irrTargets.push({ attr: geo.attributes.irr, pidx: Int32Array.from(g.pidx) });
  }
  let mat;
  if (g.variant === 'basic') {
    const src = makeMaterial(g.matKey, 'flat');
    mat = new THREE.MeshBasicMaterial({ map: src.map, color: '#d8d8d8', side: THREE.DoubleSide });
  } else if (g.variant === 'lm' && !bake) mat = makeMaterial(g.matKey, 'flat');
  else mat = makeMaterial(g.matKey, g.variant === 'glow' ? 'flat' : g.variant, bake?.lm);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.matrixAutoUpdate = false;
  geo.computeBoundsTree();
  scene.add(mesh);
  staticMeshes.push(mesh);
  if (!roomMaterials.has(g.room)) roomMaterials.set(g.room, []);
  roomMaterials.get(g.room).push(mat);
}

// glass & mirrors
const glassMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.02, metalness: 0, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide });
const frostMat = new THREE.MeshBasicMaterial({ color: '#e4e9ea', transparent: true, opacity: 0.88, depthWrite: false, side: THREE.DoubleSide });
for (const [mat, list] of [[glassMat, house.glass.filter(gl => !gl.frosted)], [frostMat, house.glass.filter(gl => gl.frosted)]]) {
  const pos = [], nrm = [];
  for (const gl of list) for (let i = 1; i < gl.pts.length - 1; i++) for (const k of [0, i, i + 1]) { pos.push(...gl.pts[k]); nrm.push(...gl.n); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  const glass = new THREE.Mesh(geo, mat);
  glass.renderOrder = 2;
  scene.add(glass);
}
const mirrors = [];
for (const m of house.mirrors) {
  const [a, b, c] = m.pts;
  const w = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), h = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
  const refl = new Reflector(new THREE.PlaneGeometry(w, h), { textureWidth: 768, textureHeight: Math.round(768 * h / w), color: 0xb8b8b8, clipBias: 0.003 });
  refl.position.set((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2);
  refl.lookAt(refl.position.x + m.n[0], refl.position.y + m.n[1], refl.position.z + m.n[2]);
  scene.add(refl);
  mirrors.push(refl);
}

// ------------------------------------------------------------------ doors ----
const doorMeshes = [];
function buildDynamic(obj, room) {
  const byMat = new Map();
  for (const p of obj.parts) {
    if (p.kind !== 'mesh') continue;
    if (!byMat.has(p.mat)) byMat.set(p.mat, []);
    byMat.get(p.mat).push(p);
  }
  const grp = new THREE.Group();
  for (const [key, list] of byMat) {
    const pos = [], nrm = [], uv = [], irr = [], pidx = [];
    for (const p of list) {
      const n = p.pos.length / 3;
      for (let i = 0; i < n; i++) {
        pos.push(p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]);
        nrm.push(p.nrm[i * 3], p.nrm[i * 3 + 1], p.nrm[i * 3 + 2]);
        uv.push(p.uv[i * 2], p.uv[i * 2 + 1]);
        irr.push(...probeIrr(p.probeBase + i));
        pidx.push(p.probeBase + i);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('irr', new THREE.Float32BufferAttribute(irr, 3));
    geo.computeBoundsTree();
    irrTargets.push({ attr: geo.attributes.irr, pidx: Int32Array.from(pidx) });
    const mat = makeMaterial(key, isGlow(key) ? 'flat' : 'vx');
    const mesh = new THREE.Mesh(geo, mat);
    grp.add(mesh);
    doorMeshes.push(mesh);
    if (!roomMaterials.has(room)) roomMaterials.set(room, []);
    roomMaterials.get(room).push(mat);
  }
  return grp;
}

const KEY_COLOR = { red: 0xff2a1a, blue: 0x2f6bff, yellow: 0xffc020 };
class Door {
  constructor(d) {
    const s = d.spec;
    Object.assign(this, s);
    this.w = d.w;
    const f = doorFrame(s);
    this.hx = f.hx; this.hz = f.hz; this.thC = f.thC; this.dlt = f.dlt;
    this.cx = s.axis === 'x' ? (s.a0 + s.a1) / 2 : s.c;
    this.cz = s.axis === 'x' ? s.c : (s.a0 + s.a1) / 2;
    const room = roomKey(this.cx + (s.axis === 'z' ? s.swing * 0.8 : 0), this.cz + (s.axis === 'x' ? s.swing * 0.8 : 0), s.base + 3);
    this.pivot = buildDynamic(d, room);
    if (s.slide) {
      this.ax = s.axis === 'x' ? [1, 0] : [0, 1];
      this.hx0 = this.hx + (s.axis === 'z' ? s.slide.track : 0);
      this.hz0 = this.hz + (s.axis === 'x' ? s.slide.track : 0);
    }
    this.pivot.position.set(this.hx, s.base, this.hz);
    // locked doors carry a glowing stripe in their key's colour near the handle edge, on both faces
    this.locked = LOCKS[s.id] || null;
    if (this.locked) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 5.0, 0.2),
        new THREE.MeshStandardMaterial({ color: 0x111111, emissive: KEY_COLOR[this.locked], emissiveIntensity: 2.2, roughness: 0.5 }));
      strip.position.set(this.w - 0.32, 3.4, 0);
      this.pivot.add(strip);
    }
    this.pivot.traverse(o => { o.userData.door = this; });
    scene.add(this.pivot);
    this.t = 0; this.target = 0;
    this.update(0);
  }
  update(dt) {
    const sp = 1.6 * dt;
    this.t = this.target > this.t ? Math.min(this.target, this.t + sp) : Math.max(this.target, this.t - sp);
    const e = this.t * this.t * (3 - 2 * this.t);
    if (this.slide) {
      const off = e * this.slide.dist;
      this.hx = this.hx0 + this.ax[0] * off; this.hz = this.hz0 + this.ax[1] * off;
      this.pivot.position.set(this.hx, this.base, this.hz);
      this.pivot.rotation.y = this.thC;
      this.dx = Math.cos(this.thC); this.dz = -Math.sin(this.thC);
      return;
    }
    const a = this.thC + this.dlt * e;
    this.pivot.rotation.y = a;
    this.dx = Math.cos(a); this.dz = -Math.sin(a);
  }
  get isOpen() { return this.target > 0.5; }
}
const doors = house.doors.map(d => new Door(d));
const doorGroups = new Map();
for (const d of doors) { if (!doorGroups.has(d.group)) doorGroups.set(d.group, []); doorGroups.get(d.group).push(d); }
const OPEN_AT_START = ['bath2', 'br1', 'bath1', 'br2', 'br3', 'hb', 'laun', 'garI'];
function resetDoors() {
  for (const d of doors) { d.target = d.t = OPEN_AT_START.includes(d.id) ? 1 : 0; d.update(0); }
}
resetDoors();

class GarageDoor {
  constructor(d) {
    Object.assign(this, d.spec);
    this.isGarage = true;
    this.base = 0;
    this.cx = (this.x0 + this.x1) / 2; this.cz = this.z;
    this.grp = buildDynamic(d, 'gar');
    this.grp.traverse(o => { o.userData.door = this; });
    scene.add(this.grp);
    this.t = 0; this.target = 0;
    this.update(0);
  }
  update(dt) {
    const sp = 0.45 * dt;
    this.t = this.target > this.t ? Math.min(this.target, this.t + sp) : Math.max(this.target, this.t - sp);
    const e = this.t * this.t * (3 - 2 * this.t);
    this.grp.rotation.x = -e * Math.PI / 2;
    this.grp.position.set(this.x0, e * (this.h + 0.05), this.z - 0.1 - e * 0.25);
  }
  get isOpen() { return this.target > 0.5; }
}
const garageDoors = house.garageDoors.map(d => new GarageDoor(d));

// Sliding patio door: one press rolls the shade up, then slides the left-hand panel open (and back).
class Slider {
  constructor(s) {
    Object.assign(this, s.spec);
    this.isSlider = true;
    const room = roomKey(this.cx, this.cz + 1, this.base + 3);
    this.panel = buildDynamic(s.panel, room);
    this.shade = buildDynamic(s.shade, room);
    const pos = [], nrm = [];
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...s.glass[k]); nrm.push(...s.n); }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    const pane = new THREE.Mesh(geo, glassMat);
    pane.renderOrder = 2;
    this.panel.add(pane);
    for (const g of [this.panel, this.shade]) { g.traverse(o => { o.userData.door = this; }); scene.add(g); }
    this.box = { x0: this.a0, x1: this.a1, y0: this.base, y1: this.base + 7, z0: this.c - 0.3, z1: this.c + 0.3 };
    this.t = 0; this.target = 0;
    this.update(0);
  }
  update(dt) {
    const sp = 0.55 * dt;
    this.t = this.target > this.t ? Math.min(this.target, this.t + sp) : Math.max(this.target, this.t - sp);
    const ease = v => v * v * (3 - 2 * v);
    const c01 = v => Math.min(1, Math.max(0, v));
    const up = ease(c01(this.t / 0.45)), slide = ease(c01((this.t - 0.55) / 0.45));
    const k = 1 - 0.94 * up;
    this.shade.scale.y = k;
    this.shade.position.y = this.top * (1 - k);
    this.panel.position.x = slide * this.slide;
    this.box.x0 = this.a0 + slide * this.slide;
  }
  get isOpen() { return this.target > 0.5; }
}
const sliders = (house.sliders || []).map(s => new Slider(s));
const worldMeshes = [...staticMeshes, ...doorMeshes];

// ------------------------------------------------------ reflection probes ----
const envs = new Map();
const envMats = [];
const glowMats = [];
scene.traverse(o => { const m = o.material; if (m?.userData?.key && isGlow(m.userData.key)) glowMats.push({ m, base: m.emissiveIntensity, day: m.userData.key === 'frosted' }); });
let imps = null, items = null;
// imps, pickups and effects stay out of every capture (reflections, lighting probes)
function hideDynamic(on) {
  fx.setVisible(!on);
  items?.setVisible(!on);
  if (imps) for (const k of imps.list) { if (on) { k._vis = k.group.visible; k.group.visible = false; k.blob.visible = false; } else { k.group.visible = k._vis ?? true; k.blob.visible = k._vis ?? true; } }
}
function captureEnvs() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const cubeRT = new THREE.WebGLCubeRenderTarget(128, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(0.1, 400, cubeRT);
  for (const m of mirrors) m.visible = false;
  hideDynamic(true);
  const old = [...envs.values()];
  const capture = (id, x, y, z) => { cubeCam.position.set(x, y, z); cubeCam.update(renderer, scene); envs.set(id, pmrem.fromCubemap(cubeRT.texture).texture); };
  for (const r of L.ROOMS) {
    const big = r.rects.reduce((a, b) => ((b[1] - b[0]) * (b[3] - b[2]) > (a[1] - a[0]) * (a[3] - a[2]) ? b : a));
    const y = (r.id === 'foyer' || r.id === 'rear') ? L.MID + 5 : r.h[0] + 5;
    capture(r.id, (big[0] + big[1]) / 2, Math.min(y, r.h[1] - 0.5), (big[2] + big[3]) / 2);
  }
  capture('ext', 24.8, 5.5, 42);
  hideDynamic(false);
  for (const m of mirrors) m.visible = true;
  cubeRT.dispose(); pmrem.dispose();
  for (const { m, room } of envMats) m.envMap = envs.get(room) || envs.get('ext');
  glassMat.envMap = envs.get('ext');
  for (const t of old) t.dispose();
  vmRoom = null;
}
// -------------------------------------------------------- live lighting ----
const mixScene = new THREE.Scene(), mixCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const mixMat = bake?.rt ? new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  uniforms: { day: { value: bake.lmDay }, lamp: { value: bake.lmLamp }, dk: { value: new THREE.Vector3() }, lk: { value: 1 } },
  vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `precision highp float; uniform sampler2D day, lamp; uniform vec3 dk; uniform float lk; out vec4 o;
    void main(){ ivec2 p = ivec2(gl_FragCoord.xy); o = vec4(texelFetch(day, p, 0).rgb * dk + texelFetch(lamp, p, 0).rgb * lk, 1.0); }`,
}) : null;
if (mixMat) { const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mixMat); q.frustumCulled = false; mixScene.add(q); }
function applyLighting(recapture = false) {
  const t = tod();
  skyMat.uniforms.zen.value.set(...t.zen); skyMat.uniforms.hor.value.set(...t.hor); skyMat.uniforms.sunK.value = t.sun;
  frostMat.color.set('#e4e9ea').multiplyScalar(t.frost);
  for (const g of glowMats) g.m.emissiveIntensity = g.base * (g.day ? t.frost : opts.lights);
  bloom.strength = opts.bloom;
  if (camera.fov !== opts.fov) { camera.fov = opts.fov; camera.updateProjectionMatrix(); }
  if (!mixMat) return;
  const { dk, lk } = mixK();
  mixMat.uniforms.dk.value.set(...dk); mixMat.uniforms.lk.value = lk;
  const prev = renderer.getRenderTarget();
  renderer.setRenderTarget(bake.rt); renderer.render(mixScene, mixCam); renderer.setRenderTarget(prev);
  mixProbes();
  const pr = bake.probes;
  for (const { attr, pidx } of irrTargets) {
    const a = attr.array;
    for (let j = 0; j < pidx.length; j++) { const s = pidx[j] * 3; a[j * 3] = pr[s]; a[j * 3 + 1] = pr[s + 1]; a[j * 3 + 2] = pr[s + 2]; }
    attr.needsUpdate = true;
  }
  if (recapture) { captureEnvs(); imps?.clearLighting(); items?.relight(); }
}
let vmRoom = null;
// Wait for the house's photo textures before the first render: the material library clones them before their
// images arrive (three.js then warns every frame), and the reflection captures must see them textured.
{
  const texs = new Set();
  scene.traverse(o => { const m = o.material; if (m) for (const k of ['map', 'normalMap', 'roughnessMap', 'emissiveMap']) if (m[k]?.isTexture) texs.add(m[k]); });
  const t0 = performance.now();
  while ([...texs].some(t => !t.image) && performance.now() - t0 < 20000) await new Promise(r => setTimeout(r, 50));
}
applyLighting();
if (bake) {
  setLoading('Capturing reflections…');
  captureEnvs();
  for (const [room, mats] of roomMaterials) {
    const env = envs.get(room) || envs.get('ext');
    for (const m of mats) {
      if (!m.isMeshStandardMaterial || m.roughness >= 0.8) continue;
      m.envMap = env;
      m.envMapIntensity = 1;
      envMats.push({ m, room });
      // specular only — diffuse light is already baked
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = sh => {
        if (prev) prev(sh);
        sh.fragmentShader = sh.fragmentShader.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', '');
      };
      const prevKey = m.customProgramCacheKey.bind(m);
      m.customProgramCacheKey = () => prevKey() + '|spec';
      m.needsUpdate = true;
    }
  }
  glassMat.envMap = envs.get('ext');
}

// --------------------------------------------------------------- player ----
const player = { x: L.START.x, z: L.START.z, feet: L.START.feet, vy: 0, vx: 0, vz: 0, yaw: L.START.yaw, pitch: 0.02,
  camY: L.START.feet + EYE, dead: false, radius: R, height: BODY_HI, speed: 0, viewDrop: 0 };
const P = {};
function resetStats() {
  Object.assign(P, {
    health: 100, armor: 0, armorType: 0,
    ammo: { bull: 50, shel: 0, rckt: 0, cell: 0 }, max: { bull: 200, shel: 50, rckt: 50, cell: 300 }, backpack: false,
    weapons: { fist: true, pistol: true }, keys: { blue: false, yellow: false, red: false },
    strength: false, berserkT: 0, god: false, noclip: false, dead: false, reveal: false,
  });
}
resetStats();
const boxes = house.b.boxes;
for (const s of sliders) boxes.push(s.box);

function floorAt(x, z, feet) {
  const lim = feet + STEP;
  let best = 0;
  for (const f of L.FLOORS) {
    const [x0, x1, z0, z1] = f.r;
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1 && f.h <= lim && f.h > best) best = f.h;
  }
  for (const f of L.FLIGHTS) {
    const [x0, x1, z0, z1] = f.r;
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1) {
      const h = f.h0 + (f.h1 - f.h0) * (z - z0) / (z1 - z0);
      if (h <= lim && h > best) best = h;
    }
  }
  return best;
}
function resolve(px, pz, feet) {
  const b0 = feet + BODY_LO, b1 = feet + bodyHi;
  for (let it = 0; it < 3; it++) {
    for (const c of boxes) {
      if (c.y1 <= b0 || c.y0 >= b1) continue;
      if (px < c.x0 - R || px > c.x1 + R || pz < c.z0 - R || pz > c.z1 + R) continue;
      const cx = clamp(px, c.x0, c.x1), cz = clamp(pz, c.z0, c.z1);
      const dx = px - cx, dz = pz - cz, d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      if (d2 > 1e-10) { const dd = Math.sqrt(d2); px = cx + dx / dd * R; pz = cz + dz / dd * R; }
      else {
        const l = px - c.x0, r = c.x1 - px, t = pz - c.z0, bb = c.z1 - pz, m = Math.min(l, r, t, bb);
        if (m === l) px = c.x0 - R; else if (m === r) px = c.x1 + R; else if (m === t) pz = c.z0 - R; else pz = c.z1 + R;
      }
    }
    for (const d of doors) {
      if (d.base + L.DOOR_H <= b0 || d.base >= b1) continue;
      const ax = d.hx, az = d.hz, vx = d.dx * d.w, vz = d.dz * d.w;
      const u = clamp(((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz), 0, 1);
      const cx = ax + vx * u, cz = az + vz * u;
      const dx = px - cx, dz = pz - cz, d2 = dx * dx + dz * dz, rr = R + 0.08;
      if (d2 < rr * rr && d2 > 1e-10) { const dd = Math.sqrt(d2); px = cx + dx / dd * rr; pz = cz + dz / dd * rr; }
    }
    for (const g of garageDoors) {
      if (g.t < 0.75 && b0 < g.h && px > g.x0 - R && px < g.x1 + R && Math.abs(pz - g.z) < R + 0.1) pz = pz < g.z ? g.z - R - 0.1 : g.z + R + 0.1;
    }
    if (imps) for (const k of imps.list) {
      if (k.state === 'dead' || k.state === 'gone' || Math.abs(k.feet - feet) > 3) continue;
      const dx = px - k.x, dz = pz - k.z, d2 = dx * dx + dz * dz, rr = R + k.radius * 0.8;
      if (d2 < rr * rr && d2 > 1e-8) { const dd = Math.sqrt(d2); px = k.x + dx / dd * rr; pz = k.z + dz / dd * rr; }
    }
  }
  return [px, pz];
}

// ------------------------------------------------------------ game parts ----
setLoading('Summoning the imps…');
const combatCtx = {
  world: () => worldMeshes, imps: null, fx, audio: Audio, player,
  hurtPlayer: (n, src, kind, at) => hurtPlayer(n, src, kind, at),
  pull: (dx, dz) => { const l = Math.hypot(dx, dz) || 1; player.vx += dx / l * 3; player.vz += dz / l * 3; },
  opts: () => opts,
};
const combat = createCombat(combatCtx);
fx.setSight(combat.sight);
try {
  imps = await createImps({
    scene, renderer, floorAt, boxes, doors, envs, mirrors, audio: Audio, fx, geometry: kidGeometry,
    sight: combat.sight, hideDynamic,
    openDoor: d => { if (!d.isOpen) toggleDoor(d, true); },
    hurtPlayer: (n, k) => hurtPlayer(n, k, 'claw'),
    fireMissile: (kind, ox, oy, oz, tx, ty, tz, owner, speed) => combat.fireball(ox, oy, oz, tx, ty, tz, owner, speed),
    onKill: () => { if (game.stats) game.stats.kills++; },
    nightmare: () => game.skill === 5 && game.state !== 'title',
  });
} catch (e) { console.error('imps', e); }
combatCtx.imps = imps;
items = createItems({ scene, nav: imps.nav, envs, buildItem, animateItem, setItemEnv, buildWeaponPickup, setWeaponEnv });
const weapons = createWeapons({
  audio: Audio, combat,
  onAttack: () => imps.noise(player.x, player.z, player.feet, performance.now()),
  onFire: w => muzzleFlash(w),
}, P);
const hud = createHud({ stbar: document.getElementById('stbar'), msg: document.getElementById('msg'), flashEl: document.getElementById('flash'), crosshair: document.getElementById('crosshair') });
screens = createScreens({
  container: document.getElementById('screens'), mapContainer: document.getElementById('mapLayer'), audio: Audio, L,
  getOptions: () => ({ ...opts, inGame: game.state === 'playing' || game.state === 'paused' }),
  setOption: (k, v, done) => setOption(k, v, done),
  onAction: (a, arg) => onAction(a, arg),
});
screens.openMenu('title');
screens.setLoading('Loading…');
// the title backdrop: imps wander the house and every pickup lies ready (this also compiles their shaders)
imps.spawn(3);
items.place();
await imps.prewarm();
Audio.setVolumes({ sfx: opts.sfx, music: opts.music });

// muzzle flashes light the room (Doom's extralight)
const FLASH = { pistol: [0xffc47a, 60, 25], chaingun: [0xffc47a, 60, 25], shotgun: [0xffbb66, 90, 28], ssg: [0xffbb66, 120, 30],
  rocket: [0xffa04c, 80, 26], plasma: [0x6ea8ff, 40, 18], bfg: [0x7cff60, 160, 32] };
function muzzleFlash(w) {
  const f = FLASH[w];
  if (!f) return;
  const fx0 = -Math.sin(player.yaw), fz0 = -Math.cos(player.yaw);
  fx.flash({ x: player.x + fx0 * 1.2, y: player.camY - 0.3, z: player.z + fz0 * 1.2 }, f[0], f[1], f[2], w === 'bfg' ? 0.3 : 0.1);
}

// ------------------------------------------------------------- damage ----
function hurtPlayer(n, src, kind, at) {
  if (P.dead || game.state !== 'playing' || P.god) return;
  if (game.skill === 1) n >>= 1;                              // "too young": half damage
  if (n <= 0) return;
  let saved = 0;
  if (P.armorType) {
    saved = P.armorType === 1 ? Math.floor(n / 3) : Math.floor(n / 2);
    if (P.armor <= saved) { saved = P.armor; P.armorType = 0; }
    P.armor -= saved;
  }
  const lost = n - saved;
  P.health = Math.max(0, P.health - lost);
  const s = src || at;
  let ang = null;
  if (src) ang = wrapA(Math.atan2(-(src.x - player.x), -(src.z - player.z)) - player.yaw);
  hud.onDamage(lost, ang);
  if (s) {                                                    // knock-back away from the hit
    const dx = player.x - s.x, dz = player.z - s.z, d = Math.hypot(dx, dz) || 1, k = Math.min(10, n * 0.12);
    player.vx += dx / d * k; player.vz += dz / d * k;
  }
  if (P.health <= 0) die();
  else Audio.play('playerPain');
}
function die() {
  P.dead = true; player.dead = true; P.health = 0;
  game.deadT = 0;
  Audio.play('playerDeath');
  weapons.stopSounds();
}

// -------------------------------------------------------------- doors ----
function toggleDoor(t, byImp = false) {
  if (t.locked && !byImp && !P.keys[t.locked]) {
    hud.message(`You need a ${t.locked} key to open this door.`);
    Audio.play('noWay');
    return;
  }
  const pos = { x: t.cx, y: (t.base || 0) + 3.5, z: t.cz };
  if (t.isGarage) { t.target = t.isOpen ? 0 : 1; Audio.play('garage', pos); return; }
  if (t.isSlider) { t.target = t.isOpen ? 0 : 1; Audio.play(t.isOpen ? 'doorOpen' : 'doorClose', pos); return; }
  const open = !t.isOpen;
  if (t.slide) {
    for (const d of doorGroups.get(t.group)) d.target = open && d === t ? 1 : 0;
  } else for (const d of doorGroups.get(t.group)) d.target = open ? 1 : 0;
  Audio.play(open ? 'doorOpen' : 'doorClose', pos);
}
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
const allDoorLike = [...doors, ...garageDoors, ...sliders];
function lineOfSight(x, y, z, tx, ty, tz) {
  const d = new THREE.Vector3(tx - x, ty - y, tz - z);
  const dist = d.length();
  ray.set(new THREE.Vector3(x, y, z), d.normalize());
  ray.far = dist - 0.4;
  return ray.intersectObjects(staticMeshes, false).length === 0;
}
function doorAtScreen(sx, sy) {
  ray.setFromCamera({ x: sx / W * 2 - 1, y: -(sy / viewH) * 2 + 1 }, camera);
  ray.far = 7;
  const hits = ray.intersectObjects(worldMeshes, false);
  if (hits.length && hits[0].object.userData.door) return hits[0].object.userData.door;
  return null;
}
function findDoorTarget() {
  ray.setFromCamera({ x: 0, y: 0 }, camera);
  ray.far = 7;
  const hits = ray.intersectObjects(worldMeshes, false);
  if (hits.length && hits[0].object.userData.door) return hits[0].object.userData.door;
  const fx0 = -Math.sin(player.yaw), fz0 = -Math.cos(player.yaw);
  let best = null, bestScore = Infinity;
  for (const d of allDoorLike) {
    if (Math.abs(d.base - player.feet) > 3) continue;
    const vx = d.cx - player.x, vz = d.cz - player.z, dist = Math.hypot(vx, vz);
    if (dist > (d.isGarage ? 12 : 5.5) || dist < 0.01) continue;
    const cos = (vx * fx0 + vz * fz0) / dist;
    if (cos < 0.45 && dist > 1.6) continue;
    if (!lineOfSight(player.x, player.feet + EYE, player.z, d.cx, d.base + 3.5, d.cz)) continue;
    const score = dist * (2.2 - cos);
    if (score < bestScore) { bestScore = score; best = d; }
  }
  return best;
}
// Space / E / right click: open the door you face; anything else within reach gets Doom's grunt
function use() {
  if (game.state !== 'playing') return;
  if (P.dead) { if (game.deadT > 0.8) startGame(game.skill); return; }
  const t = findDoorTarget();
  if (t) { toggleDoor(t); return; }
  const f = combat.trace(player.x, player.camY, player.z, -Math.sin(player.yaw), 0, -Math.cos(player.yaw), 4.5);
  if (f && !f.imp) Audio.play('noWay');
}

// ---------------------------------------------------------------- flow ----
function startGame(skill) {
  game.skill = skill;
  game.state = 'playing';
  game.stats = { kills: 0, killsTotal: 0, items: 0, itemsTotal: 0, secrets: 0, secretsTotal: SECRETS.length, time: 0 };
  game.secrets.clear(); game.quietShown = false; game.deadT = 0; game.time = 0;
  resetStats();
  Object.assign(player, { x: L.START.x, z: L.START.z, feet: L.START.feet, vy: 0, vx: 0, vz: 0, yaw: L.START.yaw, pitch: 0.02,
    camY: L.START.feet + EYE, dead: false, speed: 0, viewDrop: 0 });
  crouch = false; bodyHi = BODY_HI;
  combat.clear(); fx.clear?.();
  resetDoors();
  imps.spawn(skill);
  imps.prewarm();
  items.place();
  game.stats.killsTotal = imps.list.length;
  game.stats.itemsTotal = items.total;
  weapons.reset();
  hud.reset();
  hud.setVisible(true);
  screens.closeMenu();
  screens.automap.show(false); hud.setCrosshair(true);
  document.body.classList.add('playing');
  layout();
  Audio.unlock();
  Audio.music.start();
  lockPointer();
}
function pause() {
  if (game.state !== 'playing') return;
  game.state = 'paused';
  keys.clear(); fireHeld = false; mouseFire = false; cursor.inView = false;
  screens.openMenu('pause');
  if (document.pointerLockElement) { expectUnlock = true; document.exitPointerLock(); }
}
function resume() {
  if (game.state !== 'paused') return;
  game.state = 'playing';
  screens.closeMenu();
  lockPointer();
}
function toTitle() {
  game.state = 'title';
  weapons.stopSounds();
  Audio.music.stop();
  hud.setVisible(false);
  screens.automap.show(false); hud.setCrosshair(true);
  document.body.classList.remove('playing');
  layout();
  screens.openMenu('title');
  if (document.pointerLockElement) { expectUnlock = true; document.exitPointerLock(); }
}
function finishLevel() {
  game.state = 'intermission';
  weapons.stopSounds();
  keys.clear(); fireHeld = false;
  screens.automap.show(false); hud.setCrosshair(true);
  if (document.pointerLockElement) { expectUnlock = true; document.exitPointerLock(); }
  const s = game.stats;
  screens.intermission({ levelName: LEVEL_NAME, kills: s.kills, killsTotal: s.killsTotal, items: s.items, itemsTotal: s.itemsTotal,
    secrets: s.secrets, secretsTotal: s.secretsTotal, time: Math.floor(game.time), par: PAR }, () => toTitle());
}
function onAction(a, arg) {
  if (a === 'newGame') startGame(arg || 3);
  else if (a === 'resume') resume();
  else if (a === 'restart') startGame(game.skill);
  else if (a === 'quitToTitle') toTitle();
}
function setOption(k, v, done = true) {
  opts[k] = v;
  saveOpts();
  if (k === 'music' || k === 'sfx') Audio.setVolumes({ sfx: opts.sfx, music: opts.music });
  else if (k === 'tod' || k === 'lights') { if (done !== false) applyLighting(true); }   // relight once the slider is let go
  else if (k === 'bloom' || k === 'fov') applyLighting(false);
  else if (k === 'retro') layout();
}

// ---------------------------------------------------------------- input ----
const keys = new Set();
let fireHeld = false, mouseFire = false, expectUnlock = false, cheatBuf = '';
const CAPTURE = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown', 'Home', 'End', 'Tab', 'Alt', 'Control'];
function lockPointer() {
  if (TEST || touchOn || game.state !== 'playing') return;
  try { const p = canvas.requestPointerLock?.(); p?.catch?.(() => {}); } catch (e) { /* not available */ }
}
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && game.state === 'playing' && !expectUnlock) pause();
  expectUnlock = false;
});
window.addEventListener('keydown', e => {
  Audio.unlock();
  if (CAPTURE.includes(e.key)) e.preventDefault();
  if (screens.menuOpen || screens.intermissionActive) { if (screens.handleKey(e)) e.preventDefault(); return; }
  if (game.state !== 'playing') return;
  if (e.key === 'Escape') { pause(); return; }
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (!e.repeat) {
    if (/^[a-z]$/.test(k)) cheat(k);
    if (k >= '1' && k <= '7') weapons.slot(+k);
    else if (k === ' ' || k === 'e') use();
    else if (k === 'Tab' || k === 'm') toggleMap();
    else if (k === 'j') jump();
    else if (k === 'x') setCrouch(!crouch);
    else if ((k === '=' || k === '+') && screens.automap.visible) screens.automap.zoom(1);
    else if (k === '-' && screens.automap.visible) screens.automap.zoom(-1);
    else if (k === 'Home' || k === 'c') player.pitch = 0;
  }
  keys.add(k);
});
window.addEventListener('keyup', e => keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key));
window.addEventListener('blur', () => { keys.clear(); fireHeld = false; mouseFire = false; cursor.inView = false; lookStick.x = 0; stick.x = stick.y = 0; });
const CHEATS = ['iddqd', 'idkfa', 'idfa', 'idclip', 'idspispopd', 'iddt', 'idchoppers', 'idbeholds'];
function cheat(ch) {
  cheatBuf = (cheatBuf + ch).slice(-12);
  const c = CHEATS.find(x => cheatBuf.endsWith(x));
  if (!c) return;
  cheatBuf = '';
  switch (c) {
    case 'iddqd': P.god = !P.god; if (P.god) P.health = Math.max(P.health, 100); hud.message(P.god ? 'God mode on.' : 'God mode off.'); break;
    case 'idkfa': case 'idfa':
      for (const w of Object.keys(WEAPONS)) P.weapons[w] = true;
      if (!P.backpack) { P.backpack = true; for (const a of Object.keys(P.max)) P.max[a] *= 2; }
      for (const a of Object.keys(P.ammo)) P.ammo[a] = P.max[a];
      P.armor = 200; P.armorType = 2;
      if (c === 'idkfa') P.keys = { blue: true, yellow: true, red: true };
      hud.message(c === 'idkfa' ? 'Weapons, ammo, armor and keys added.' : 'Weapons, ammo and armor added.');
      break;
    case 'idclip': case 'idspispopd': P.noclip = !P.noclip; hud.message(P.noclip ? 'Walking through walls.' : 'Walls are solid again.'); break;
    case 'iddt': P.reveal = !P.reveal; hud.message(P.reveal ? 'The map shows everything.' : 'The map is back to normal.'); break;
    case 'idchoppers': P.weapons.chainsaw = true; weapons.select('chainsaw'); hud.message('Hedge trimmer!'); break;
    case 'idbeholds': P.strength = true; P.berserkT = 20; if (P.health < 100) P.health = 100; hud.message('Berserk!'); break;
  }
}

// Mouse: moving it left / right turns you (yaw) and up / down tilts the view (pitch), whether or not the pointer
// is captured. Left button fires, right button uses, the wheel changes weapons. Where the browser refuses pointer lock (some embedded views), the cursor resting near the
// left or right edge of the view keeps turning, so you can still spin all the way round.
let dragging = null;
const lookBy = (dx, dy, k) => { player.yaw -= dx * k; player.pitch = clamp(player.pitch - dy * k, -1.35, 1.35); };
const EDGE = 0.1, EDGE_TURN = 2.6;             // edge zone (fraction of the view width at each side), turn rate there
const cursor = { x: 0, inView: false };        // last position of a free (not captured) cursor
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  Audio.unlock();
  if (game.state !== 'playing') return;
  if (e.pointerType === 'touch') {
    dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() };
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (P.dead) { use(); return; }
  if (!document.pointerLockElement) lockPointer();
  if (e.button === 0) mouseFire = true;
  else if (e.button === 2) use();
});
window.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch') {
    if (!dragging || e.pointerId !== dragging.id) return;
    lookBy(e.clientX - dragging.x, e.clientY - dragging.y, TOUCH_LOOK * opts.sens);
    dragging.x = e.clientX; dragging.y = e.clientY;
    return;
  }
  if (game.state !== 'playing' || screens.menuOpen) { cursor.inView = false; return; }
  player.yaw -= e.movementX * MOUSE * opts.sens;
  player.pitch = clamp(player.pitch - e.movementY * MOUSE * opts.sens, -1.35, 1.35);
  if (document.pointerLockElement !== canvas) { cursor.x = e.clientX; cursor.inView = e.clientY < viewH; }
  else cursor.inView = false;
});
window.addEventListener('pointerout', e => { if (!e.relatedTarget) cursor.inView = false; });
// the free cursor parked in an edge zone keeps turning (called every frame while playing)
function edgeTurn(dt) {
  if (!cursor.inView || document.pointerLockElement || touchOn || !W) return;
  const u = cursor.x / W;
  const z = u < EDGE ? (u - EDGE) / EDGE : u > 1 - EDGE ? (u - (1 - EDGE)) / EDGE : 0;   // −1 … 1 inside the zones
  if (z) player.yaw -= clamp(z, -1, 1) * EDGE_TURN * opts.sens * dt;
}
const endDrag = e => {
  if (e.button === 0) mouseFire = false;
  if (!dragging || e.pointerId !== dragging.id) return;
  const tap = e.type === 'pointerup' && e.pointerType === 'touch' && Math.hypot(e.clientX - dragging.x0, e.clientY - dragging.y0) < 10
    && performance.now() - dragging.t0 < 350;
  dragging = null;
  if (tap && game.state === 'playing') { const t = doorAtScreen(e.clientX, e.clientY); if (t) toggleDoor(t); }
};
window.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
window.addEventListener('wheel', e => {
  if (game.state !== 'playing') return;
  if (screens.automap.visible) screens.automap.zoom(e.deltaY < 0 ? 1 : -1);
  else weapons.cycle(e.deltaY > 0 ? 1 : -1);
}, { passive: true });

// Touch: left stick walks; the right stick turns like a gamepad stick — held over, it keeps turning, faster the
// further it is pushed (swiping on the view itself still turns 1:1). FIRE (hold), USE, GUN (next weapon), MAP, pause.
const stick = { x: 0, y: 0 }, lookStick = { x: 0 };
const STICK_TURN = 3.6;                        // rad/s at full deflection (about 200°/s)
let touchOn = false, touchFire = false;
function enableTouch() { if (touchOn) return; touchOn = true; document.body.classList.add('touch'); layout(); }
if (matchMedia('(pointer: coarse)').matches) enableTouch();
window.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') enableTouch(); }, true);
function thumbStick(el, onMove, onEnd) {
  const knob = el.querySelector('.knob');
  let id = null, cx = 0, cy = 0, lx = 0, ly = 0;
  const move = e => {
    const reach = el.clientWidth * 0.31;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const d = Math.hypot(dx, dy);
    if (d > reach) { dx *= reach / d; dy *= reach / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    onMove(dx / reach, dy / reach, e.clientX - lx, e.clientY - ly);
    lx = e.clientX; ly = e.clientY;
  };
  el.addEventListener('pointerdown', e => {
    if (id !== null) return;
    e.preventDefault();
    id = e.pointerId;
    try { el.setPointerCapture(id); } catch (err) { /* synthetic pointers in tests */ }
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2; lx = e.clientX; ly = e.clientY;
    el.classList.add('active');
    move(e);
  });
  el.addEventListener('pointermove', e => { if (e.pointerId === id) move(e); });
  const end = e => { if (e.pointerId !== id) return; id = null; knob.style.transform = ''; el.classList.remove('active'); onEnd(); };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
thumbStick(document.getElementById('stickWalk'), (x, y) => {
  const m = Math.hypot(x, y), k = m < 0.15 ? 0 : (m - 0.15) / 0.85 / m;
  stick.x = x * k; stick.y = y * k;
}, () => { stick.x = stick.y = 0; });
thumbStick(document.getElementById('stickLook'), x => {
  // small dead zone, then a curve that gives fine control near the middle and a fast spin at the rim
  const m = Math.abs(x), k = m < 0.12 ? 0 : (m - 0.12) / 0.88;
  lookStick.x = Math.sign(x) * Math.pow(k, 1.6);
}, () => { lookStick.x = 0; });
const btn = (id, down, up) => {
  const el = document.getElementById(id);
  el.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); el.classList.add('on'); down(); });
  const off = () => { el.classList.remove('on'); up?.(); };
  el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('pointerleave', off);
};
btn('btnFire', () => { touchFire = true; if (P.dead) use(); }, () => { touchFire = false; });
btn('btnUse', use);
btn('btnNext', () => weapons.cycle(1));
btn('btnMap', () => toggleMap());
btn('btnMenu', pause);

function toggleMap() { const on = screens.automap.toggle(); hud.setCrosshair(!on); }

// ----------------------------------------------------- crouch and jump ----
let crouch = false;
function headroom() {
  const y0 = player.feet + CROUCH_HI, y1 = player.feet + BODY_HI, r = R - 0.05;
  return !boxes.some(c => c.y1 > y0 && c.y0 < y1 && (clamp(player.x, c.x0, c.x1) - player.x) ** 2 + (clamp(player.z, c.z0, c.z1) - player.z) ** 2 < r * r);
}
function setCrouch(on) {
  if (!on && !headroom()) return;
  crouch = on; bodyHi = on ? CROUCH_HI : BODY_HI; player.height = bodyHi;
}
function jump() {
  if (game.state !== 'playing' || P.dead || player.vy !== 0) return;
  if (player.feet - floorAt(player.x, player.z, player.feet) > 0.05) return;
  if (crouch) { setCrouch(false); if (crouch) return; }
  player.vy = JUMP_V; player.feet += 0.02;
}

// --------------------------------------------------------- auto exposure ----
const meterRT = new THREE.WebGLRenderTarget(48, 27, { type: THREE.HalfFloatType });
const meterBuf = new Uint16Array(48 * 27 * 4);
const EXPOSURE_KEY = 0.15;
const keyNow = () => EXPOSURE_KEY * Math.pow(2, opts.brightness) * tod().key;
let exposure = 1, targetExposure = 1, meterBusy = false, lastMeter = 0;
const half = h => THREE.DataUtils.fromHalfFloat(h);
async function meter(now) {
  if (meterBusy || now - lastMeter < 200) return;
  meterBusy = true; lastMeter = now;
  renderer.setRenderTarget(meterRT);
  for (const m of mirrors) m.visible = false;
  fx.setVisible(false);
  renderer.render(scene, camera);
  fx.setVisible(true);
  for (const m of mirrors) m.visible = true;
  renderer.setRenderTarget(null);
  try {
    await renderer.readRenderTargetPixelsAsync(meterRT, 0, 0, 48, 27, meterBuf);
    let s = 0, n = 0;
    for (let i = 0; i < meterBuf.length; i += 4) {
      const l = 0.2126 * half(meterBuf[i]) + 0.7152 * half(meterBuf[i + 1]) + 0.0722 * half(meterBuf[i + 2]);
      s += Math.log(Math.max(l, 1e-4)); n++;
    }
    targetExposure = clamp(keyNow() / Math.exp(s / n), 0.03, 3.5);
  } catch (e) { /* ignore */ }
  meterBusy = false;
}

// ---------------------------------------------------------------- layout ----
function layout() {
  W = window.innerWidth; H = window.innerHeight;
  if (!W || !H) return;
  const { barH } = hud.resize(W, H);
  viewH = Math.max(1, Math.ceil(H - barH));   // the bar covers the sub-pixel overlap
  canvas.style.height = viewH + 'px';
  const pr = opts.retro ? Math.min(window.devicePixelRatio, 2) * 0.34 : Math.min(window.devicePixelRatio, 2);
  document.body.classList.toggle('retro', !!opts.retro);
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  renderer.setSize(W, viewH, false);
  canvas.style.width = '100vw';
  composer.setSize(W, viewH);
  camera.aspect = W / viewH;
  camera.updateProjectionMatrix();
  vm.setAspect(W / viewH);
  screens.resize(W, H, viewH);
  // touch controls sit above the status bar
  const lift = barH + 18;
  const place = (id, css) => Object.assign(document.getElementById(id).style, css);
  place('stickWalk', { left: '18px', bottom: `${lift}px` });
  place('stickLook', { right: '18px', bottom: `${lift}px` });
  place('btnFire', { right: '26px', bottom: `${lift + 150}px` });
  place('btnUse', { right: '100px', bottom: `${lift + 150}px` });
  place('btnNext', { right: '26px', bottom: `${lift + 228}px` });
  place('btnMap', { left: '26px', bottom: `${lift + 150}px` });
  place('btnMenu', { right: '14px', top: '14px' });   // clear of the message line
}
window.addEventListener('resize', layout);
hud.setVisible(false);
layout();

// ------------------------------------------------------------------ loop ----
const hudState = { health: 100, armor: 0, ammo: null, max: null, cur: null, arms: { 2: false, 3: false, 4: false, 5: false, 6: false, 7: false },
  keys: null, god: false, dead: false, attackDown: false, berserk: 0, invuln: 0, messages: true };
const mapState = { player: null, doors: [], imps: [], items: [], revealAll: false, levelName: LEVEL_NAME, roomName: '' };
let time = 0, titleYaw = 0;

function play(dt, input) {
  game.time += dt;
  // -------- movement (Doom momentum: thrust against 0.90625 friction per tic)
  if (!P.dead) {
    let mf = 0, ms = 0, turn = 0, look = 0;
    const alt = keys.has('Alt');
    if (keys.has('ArrowUp') || keys.has('w')) mf += 1;
    if (keys.has('ArrowDown') || keys.has('s')) mf -= 1;
    if (keys.has('ArrowLeft')) { if (alt) ms -= 1; else turn += 1; }
    if (keys.has('ArrowRight')) { if (alt) ms += 1; else turn -= 1; }
    if (keys.has('a') || keys.has(',')) ms -= 1;
    if (keys.has('d') || keys.has('.')) ms += 1;
    if (keys.has('PageUp') || keys.has('r')) look += 1;
    if (keys.has('PageDown') || keys.has('f')) look -= 1;
    mf -= stick.y; ms += stick.x;
    if (input) { mf += (input.forward ? 1 : 0) - (input.back ? 1 : 0); ms += (input.right ? 1 : 0) - (input.left ? 1 : 0); turn += input.turn || 0; }
    const run = opts.alwaysRun !== keys.has('Shift');
    player.yaw += turn * (run ? TURN_RUN : TURN_WALK) * dt;
    player.yaw -= lookStick.x * STICK_TURN * opts.sens * dt;
    edgeTurn(dt);
    player.pitch = clamp(player.pitch + look * 1.25 * dt, -1.35, 1.35);
    const fx0 = -Math.sin(player.yaw), fz0 = -Math.cos(player.yaw);
    let wx = fx0 * mf - fz0 * ms, wz = fz0 * mf + fx0 * ms;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) { wx /= wl; wz /= wl; }
    const top = (run ? RUN : WALK) * (crouch ? 0.5 : 1);
    const k = 1 - Math.pow(0.90625, dt * 35);
    player.vx += (wx * top - player.vx) * k;
    player.vz += (wz * top - player.vz) * k;
  } else {
    const k = 1 - Math.pow(0.90625, dt * 35);
    player.vx -= player.vx * k; player.vz -= player.vz * k;
  }
  const x0 = player.x, z0 = player.z;
  for (let i = 0; i < 3; i++) {
    const nx = player.x + player.vx * dt / 3, nz = player.z + player.vz * dt / 3;
    if (P.noclip) { player.x = nx; player.z = nz; } else [player.x, player.z] = resolve(nx, nz, player.feet);
  }
  // blocked by a wall: lose the speed going into it (Doom slides along instead of piling up momentum)
  if (dt > 0) {
    const ax = (player.x - x0) / dt, az = (player.z - z0) / dt;
    if (Math.abs(ax) < Math.abs(player.vx)) player.vx = ax;
    if (Math.abs(az) < Math.abs(player.vz)) player.vz = az;
  }
  player.speed = Math.hypot(player.vx, player.vz);
  // -------- weapons, shots, imps
  const fire = !P.dead && (fireHeld || mouseFire || touchFire || keys.has('Control') || !!input?.fire);
  weapons.update(dt, { fire }, { dead: P.dead, speed: player.speed, runSpeed: RUN, viewBob: opts.viewBob });
  combat.update(dt);
  imps.update(dt, player, performance.now());
  // -------- pickups
  if (!P.dead) for (const it of items.touching(player)) {
    const msg = applyPickup(it, P, { skill: game.skill, weapons, hud });
    if (!msg) continue;
    items.take(it);
    if (it.counted) game.stats.items++;
    hud.message(msg); hud.onBonus();
    Audio.play(isWeaponItem(it.type) ? 'weaponUp' : isPowerup(it.type) ? 'powerUp' : 'itemUp');
  }
  // -------- secrets, the exit, the quiet house
  const here = roomAt(player.x, player.z, player.feet + 2);
  if (here && SECRETS.includes(here.id) && !game.secrets.has(here.id)) {
    game.secrets.add(here.id); game.stats.secrets++;
    hud.message('A secret is revealed!'); Audio.play('secret');
  }
  if (!game.quietShown && game.stats.killsTotal && game.skill !== 5 && imps.alive === 0) {
    game.quietShown = true;
    hud.message('The house is quiet. Leave by the front door.');
  }
  if (!P.dead && player.z > 33 && player.x > 20.6 && player.x < 29.05 && player.feet > 1.5) { finishLevel(); return; }   // out onto the stoop
  if (P.berserkT > 0) P.berserkT = Math.max(0, P.berserkT - dt);
  if (P.dead) {
    game.deadT += dt;
    if (game.deadT > 1.5 && game.deadT - dt <= 1.5) hud.message('Press SPACE or click to try again.');
  }
}

function tick(dt, now, input = null) {
  time += dt;
  if (game.state === 'playing') play(dt, input);
  else if (game.state === 'title') {
    // title backdrop: turn slowly on the entry landing while the imps potter about
    titleYaw += dt * 0.12;
    Object.assign(player, { x: L.START.x, z: L.START.z - 0.5, feet: L.START.feet, yaw: L.START.yaw + Math.sin(titleYaw) * 1.1, pitch: 0.05 + Math.sin(titleYaw * 0.7) * 0.06 });
    imps.update(dt, { x: player.x, z: player.z, feet: player.feet, camY: player.camY, dead: true }, now);
  }
  // physics outside play too (a dead player keeps sinking)
  const fl = floorAt(player.x, player.z, player.feet);
  if (player.vy <= 0 && fl >= player.feet - 1e-4) { player.feet = fl; player.vy = 0; }
  else if (player.vy === 0 && player.feet - fl <= 0.9) player.feet = fl;
  else {
    player.vy -= 32 * dt; player.feet += player.vy * dt;
    if (player.feet <= fl) { if (player.vy < -14 && game.state === 'playing' && !P.dead) Audio.play('playerLand'); player.feet = fl; player.vy = 0; }
  }
  if (game.state === 'playing' && !P.noclip) [player.x, player.z] = resolve(player.x, player.z, player.feet);
  for (const d of doors) if (d.t !== d.target) d.update(dt);
  for (const g of garageDoors) if (g.t !== g.target) g.update(dt);
  for (const s of sliders) if (s.t !== s.target) s.update(dt);
  items.update(time);

  // -------- camera: eye height, Doom's view bob, the death drop
  player.viewDrop = P.dead && game.state !== 'title' ? Math.min(1, player.viewDrop + dt * 2) : 0;
  const eyeH = (crouch ? CROUCH_EYE : EYE) * (1 - player.viewDrop) + 0.5 * player.viewDrop;
  const bobK = game.state === 'playing' && opts.viewBob && !P.dead ? Math.min(1, player.speed / RUN) : 0;
  const bob = Math.sin(time * 2 * Math.PI * 35 / 20) * 0.11 * bobK;
  player.camY = player.vy !== 0 ? player.feet + eyeH : player.camY + (player.feet + eyeH + bob - player.camY) * Math.min(1, dt * 14);
  camera.position.set(player.x, player.camY, player.z);
  camera.rotation.set(player.pitch, player.yaw, P.dead && game.state !== 'title' ? player.viewDrop * 0.35 : 0);
  sky.position.copy(camera.position);
  Audio.setListener(player.x, player.camY, player.z, player.yaw);

  // -------- the weapon: lit by the room it is in
  const room = roomAt(player.x, player.z, player.feet + 2)?.id || 'ext';
  if (room !== vmRoom) { vmRoom = room; const env = envs.get(room) || envs.get('ext') || null; vm.setEnv(env); fx.setEnv?.(env); }
  if (game.state !== 'title') vm.update(dt, weapons.vm); else vm.update(dt, { ...weapons.vm, lower: 1 });
  vm.setViewRotation?.(camera.quaternion);
  fx.update(game.state === 'paused' ? 0 : dt);

  // -------- HUD, automap
  if (game.state === 'playing' || game.state === 'paused') {
    const w = WEAPONS[weapons.current];
    Object.assign(hudState, { health: P.health, armor: P.armor, ammo: P.ammo, max: P.max, cur: w.ammo, keys: P.keys, god: P.god, dead: P.dead,
      attackDown: weapons.attackDown, berserk: P.berserkT, messages: opts.messages });
    const a = hudState.arms;
    a[2] = !!P.weapons.pistol; a[3] = !!(P.weapons.shotgun || P.weapons.ssg); a[4] = !!P.weapons.chaingun;
    a[5] = !!P.weapons.rocket; a[6] = !!P.weapons.plasma; a[7] = !!P.weapons.bfg;
    if (game.state === 'playing') hud.update(dt, hudState);
    if (screens.automap.visible) {
      mapState.player = player;
      mapState.doors = allDoorLike;
      mapState.revealAll = P.reveal;
      mapState.imps = P.reveal ? imps.list.map(k => ({ x: k.x, z: k.z, feet: k.feet, heading: k.heading + Math.PI, dead: k.state === 'dead' || k.state === 'gone' })) : [];
      mapState.items = P.reveal ? items.list.filter(it => !it.taken) : [];
      mapState.roomName = roomAt(player.x, player.z, player.feet + 2)?.name.replace(/ \(.+\)/, '') || 'Outside';
      screens.automap.draw(mapState);
    }
  }
  screens.update(dt);

  // -------- exposure, render
  if (bake) {
    meter(now);
    exposure += (targetExposure - exposure) * Math.min(1, dt * 2.2);
    renderer.toneMappingExposure = exposure;
    fx.setAmbient?.(keyNow() / Math.max(exposure, 1e-3));
    setItemAmbient(keyNow() / Math.max(exposure, 1e-3));
  }
  bloom.threshold = 3.0 / Math.max(exposure, 1e-3);
  composer.render();
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (!W || canvas.width !== Math.floor(W * renderer.getPixelRatio())) layout();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  tick(dt, now);
}
screens.setLoading(null);
if (TEST) Audio.unlock();

// Debug / test hook: drive the game synchronously (works in a hidden tab where requestAnimationFrame stalls).
window.__game = {
  ready: true, P, player, imps, items, weapons, combat, hud, screens, fx, vm, opts, game, doors, camera, renderer, scene,
  start: startGame, pause, resume, toTitle,
  step(seconds = 0, input = {}) {
    const n = Math.max(1, Math.round(seconds * 60));
    for (let i = 0; i < n; i++) { if (input.fire !== undefined) fireHeld = !!input.fire; tick(1 / 60, performance.now(), input); }
    fireHeld = false;
    return { health: P.health, weapon: weapons.current, alive: imps.alive, state: game.state };
  },
  snap(x, z, feet, yaw, pitch = 0) { Object.assign(player, { x, z, feet, yaw, pitch, camY: feet + EYE, vy: 0, vx: 0, vz: 0 }); tick(1 / 60, performance.now()); },
  give(what = 'all') {
    if (what === 'all') { for (const c of 'idkfa') cheat(c); return; }
    if (WEAPONS[what]) { P.weapons[what] = true; weapons.select(what); }
    if (what === 'health') P.health = 100;
    if (what === 'armor') { P.armor = 200; P.armorType = 2; }
  },
  press(key) { window.dispatchEvent(new KeyboardEvent('keydown', { key })); window.dispatchEvent(new KeyboardEvent('keyup', { key })); },
  applyLighting,
};
requestAnimationFrame(frame);
