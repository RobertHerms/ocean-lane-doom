// The children, enlarged to about six feet and turned into imps.
// Behaviour follows Doom's imp: stand around (here: wander the house) until they see or hear the player,
// then chase; every few steps decide whether to attack (the closer, the likelier); claw at arm's length,
// otherwise wind up and throw a fireball; flinch when hurt (200/256), answer pain with an immediate attack;
// on Nightmare they respawn. They route over the house's navigation grid, climb the stairs and open doors.
import * as THREE from 'three';
import { LightProbeGenerator } from 'three/addons/lights/LightProbeGenerator.js';
import { roomAt } from '../house.js';
import { Kid, NavGrid, kidAssets, GIRL, BOY, REST_ARM } from '../kids.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const TICS = 35;

// Doom's imp, in feet and seconds
export const IMP = {
  health: 60, painChance: 200 / 256, reaction: 8,              // tics before a newly woken imp may attack
  melee: 1.9,                                                  // claw reach beyond both bodies' radii (ft)
  attackTics: 22, fireTic: 16, painTics: 6,
  speed: { Girl: 6.2, Boy: 5.6 },                              // chasing (ft/s); the player walks 9, runs 15
  scale: { Girl: 1.75, Boy: 2.0 },                             // 3.6 ft → 6.3 ft, 3.0 ft → 6.0 ft
  voice: { Girl: 1.16, Boy: 0.9 },                             // pitch of their growls
  fireball: 22, fireballFast: 44,                              // ft/s (Nightmare doubles it, like -fast)
  wakeGlow: new THREE.Color(5.0, 0.9, 0.12),                   // eye glow once they are hunting
};

// Where the imps start: [room, child, lowest skill that has it]. Skills 1–2 get 6, 3 gets 10, 4–5 get 14.
const ROSTER = [
  ['liv', 'Girl', 1], ['kit', 'Boy', 1], ['play', 'Girl', 1], ['br1', 'Boy', 1], ['gar', 'Girl', 1], ['br2', 'Boy', 1],
  ['din', 'Boy', 3], ['play', 'Boy', 3], ['laun', 'Girl', 3], ['br3', 'Girl', 3],
  ['hall', 'Girl', 4], ['gar', 'Boy', 4], ['rear', 'Girl', 4], ['kit', 'Girl', 4],
];
const WANDER = { play: 5, liv: 4, kit: 2.5, din: 1.5, br2: 2.5, br3: 2, br1: 1.5, hall: 0.6, laun: 0.8, gar: 1.5, foyer: 0.4 };

// tiny seeded RNG so a skill level always starts with the same layout
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export async function createImps(ctx) {
  const { scene, renderer, floorAt, boxes, doors, envs, mirrors, audio, fx } = ctx;
  const geom = await ctx.geometry;
  const leo = await new THREE.TextureLoader().loadAsync('textures/leotard.png');
  leo.colorSpace = THREE.SRGBColorSpace; leo.anisotropy = 4;
  const assets = { Girl: kidAssets(GIRL, geom.Girl, leo), Boy: kidAssets(BOY, geom.Boy, null) };
  const nav = new NavGrid(boxes, doors, floorAt, { R: 0.62, TOP: 6.0 });
  const list = [];
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
  let time = 0;

  // -------------------------------------------------------- lighting cache ----
  // Imps are lit by spherical-harmonics probes captured from the baked house, cached per 5 ft cell and level.
  const shCache = new Map();
  const cubeRT = new THREE.WebGLCubeRenderTarget(16, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(0.05, 400, cubeRT);
  let capturing = false, lastCapture = -1;
  const cellKey = (x, z, feet) => `${Math.floor(x / 5)},${Math.floor(z / 5)},${Math.round(feet)}`;
  async function capture(key, x, y, z) {
    capturing = true;
    const vis = list.map(k => k.group.visible);
    for (const k of list) { k.group.visible = false; k.blob.visible = false; }
    for (const m of mirrors) m.visible = false;
    ctx.hideDynamic?.(true);
    cubeCam.position.set(x, y, z);
    cubeCam.update(renderer, scene);
    ctx.hideDynamic?.(false);
    for (const m of mirrors) m.visible = true;
    list.forEach((k, i) => { k.group.visible = vis[i]; k.blob.visible = vis[i]; });
    try {
      const probe = await LightProbeGenerator.fromCubeRenderTarget(renderer, cubeRT);
      const sh = probe.sh.coefficients.map(v => v.clone());
      shCache.set(key, sh);
      addToAverage(sh);
    } catch (e) { shCache.set(key, null); }
    capturing = false;
  }
  // average of everything captured so far: stands in until an imp's own cell has been captured
  const avgSH = Array.from({ length: 9 }, () => new THREE.Vector3());
  let avgN = 0;
  function addToAverage(sh) { avgN++; avgSH.forEach((v, i) => v.lerp(sh[i], 1 / avgN)); }
  function light(k, dt, now) {
    const key = cellKey(k.x, k.z, k.feet);
    const sh = shCache.get(key);
    if (sh === undefined) {
      if (!capturing && now - lastCapture > 120) { lastCapture = now; capture(key, k.x, k.feet + k.height * 0.55, k.z); }
      if (!k.hasSH && avgN) k.shared.sh.forEach((v, i) => v.copy(avgSH[i]));
    } else if (sh) {
      if (!k.hasSH) { k.hasSH = true; k.shared.sh.forEach((v, i) => v.copy(sh[i])); }
      else k.shared.sh.forEach((v, i) => v.lerp(sh[i], Math.min(1, dt * 3)));
    }
    const r = roomAt(k.x, k.z, k.feet + 1.5)?.id || 'ext';
    if (r !== k.room) {
      k.room = r;
      const env = envs.get(r) || envs.get('ext');
      for (const m of k.materials) { m.envMap = env || null; m.envMapIntensity = 1; m.needsUpdate = !!env !== !!m.userData.hadEnv; m.userData.hadEnv = !!env; }
    }
  }

  // ------------------------------------------------------------ spawning ----
  function make(kind) {
    const k = new Kid(assets[kind], IMP.scale[kind]);
    k.kind = kind;
    k.voice = IMP.voice[kind];
    k.speed = IMP.speed[kind];
    k.walkSpeed = (kind === 'Girl' ? GIRL.speed : BOY.speed) * k.scale;
    scene.add(k.group); scene.add(k.blob);
    list.push(k);
    return k;
  }
  function reset(k, x, z, feet, heading) {
    k.place(x, z, feet, heading);
    Object.assign(k, {
      health: IMP.health, state: 'idle', timer: 1 + Math.random() * 4, path: null, pi: 0, goal: -1,
      reaction: 0, movecount: 0, justAttacked: false, justHit: false, chaseT: Math.random() * 3 / TICS,
      attackT: 0, melee: false, fired: false, painT: 0, deathT: 0, vx: 0, vz: 0, awake: 0, see: false, seeT: Math.random() * 0.3,
      mode: 'path', dirX: 0, dirZ: 0, repathT: 0, waitDoor: null, blocked: false, respawnT: 0, lookT: Math.random() * 0.3,
    });
    k.speedNow = 0; k.walkW = 0; k.run = 0;
    k.group.visible = true; k.blob.visible = true;
    k.mesh.rotation.x = 0; k.mesh.position.y = 0;
    k.shared.dissolve.value = 0;
    k.shared.glow.value.setRGB(0, 0, 0);
    k.hand?.remove(); k.hand = null;
  }
  function spawn(skill, seed = 1) {
    clear();
    const R = rng(seed * 7919 + skill);
    const used = [];
    const tier = skill <= 2 ? 1 : skill === 3 ? 3 : 4;
    for (const [room, kind, min] of ROSTER) {
      if (min > tier) continue;
      const cand = nav.byRoom.get(room) || [];
      let n = -1;
      for (let tries = 0; tries < 40 && cand.length; tries++) {
        const c = cand[Math.floor(R() * cand.length)];
        if (used.every(u => Math.hypot(nav.nx[u] - nav.nx[c], nav.nz[u] - nav.nz[c]) > 3.5)) { n = c; break; }
      }
      if (n < 0) continue;
      used.push(n);
      const k = make(kind);
      reset(k, nav.nx[n], nav.nz[n], nav.nh[n], R() * Math.PI * 2);
      k.home = { x: nav.nx[n], z: nav.nz[n], feet: nav.nh[n], heading: k.heading };
    }
  }
  async function prewarm() {
    for (const k of list) {
      const key = cellKey(k.x, k.z, k.feet);
      if (shCache.has(key)) continue;
      while (capturing) await new Promise(r => setTimeout(r, 5));
      await capture(key, k.x, k.feet + k.height * 0.55, k.z);
    }
  }
  function clear() {
    for (const k of list) { scene.remove(k.group); scene.remove(k.blob); k.hand?.remove(); for (const m of k.materials) m.dispose(); k.blob.material.dispose(); }
    list.length = 0;
  }

  // --------------------------------------------------------------- senses ----
  const eyeY = k => k.feet + k.S.eyeY * k.scale;
  function canSee(k, p) {
    if (p.dead) return false;
    const dx = p.x - k.x, dz = p.z - k.z, d = Math.hypot(dx, dz);
    if (d > 90 || Math.abs(p.feet - k.feet) > 14) return false;
    return ctx.sight(k.x, eyeY(k), k.z, p.x, p.camY - 0.4, p.z);
  }
  function inFront(k, p) {
    const dx = p.x - k.x, dz = p.z - k.z, d = Math.hypot(dx, dz) || 1;
    return (dx * Math.sin(k.heading) + dz * Math.cos(k.heading)) / d > -0.05 || d < 5;
  }
  function wake(k, sound = true) {
    if (k.state === 'dead' || k.state === 'gone') return;
    if (k.state === 'idle' || k.state === 'walk') {
      k.state = 'chase'; k.reaction = ctx.nightmare?.() ? 0 : IMP.reaction; k.movecount = 0; k.path = null;
      if (sound) audio.play(Math.random() < 0.5 ? 'impSight1' : 'impSight2', { x: k.x, y: eyeY(k), z: k.z }, { rate: k.voice });
    }
  }
  // Gunfire wakes every imp the sound can reach: through open doorways, not through shut doors.
  const heard = new Uint32Array(nav.nh.length);
  let heardGen = 0, lastNoise = -1;
  function noise(x, z, feet, now) {
    if (now - lastNoise < 250) return;
    lastNoise = now;
    const start = nav.nearest(x, z, feet);
    if (start < 0) return;
    const gen = ++heardGen, q = [start];
    const was = nav.doorsOpenable; nav.doorsOpenable = false;
    heard[start] = gen;
    for (let i = 0; i < q.length; i++) for (const m of nav.adj[q[i]]) if (heard[m] !== gen && !nav.isBlocked(m)) { heard[m] = gen; q.push(m); }
    nav.doorsOpenable = was;
    for (const k of list) {
      if (k.state !== 'idle' && k.state !== 'walk') continue;
      const n = nav.at(k.x, k.z, k.feet);
      if (n >= 0 && heard[n] === gen) wake(k);
    }
  }

  // ------------------------------------------------------------- movement ----
  function turnTo(k, want, rate, dt) {
    let dh = want - k.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    k.heading += clamp(dh, -rate * dt, rate * dt);
    return dh;
  }
  const walkable = (x, z, feet) => { const n = nav.at(x, z, feet); return n >= 0 && !nav.isBlocked(n) && nav.adj[n].length >= 5 ? n : -1; };
  function stepTo(k, x, z) {
    const n = walkable(x, z, k.feet);
    if (n < 0) return false;
    k.x = x; k.z = z; k.feet = floorAt(x, z, k.feet);
    return true;
  }
  function plan(k, goal) {
    const from = nav.nearest(k.x, k.z, k.feet);
    if (from < 0 || goal < 0) return false;
    nav.doorsOpenable = true;
    const p = nav.path(from, goal, 9000);
    nav.doorsOpenable = false;
    if (!p || p.length < 2) { k.path = null; return false; }
    k.path = p; k.pi = 1; k.goal = goal;
    return true;
  }
  // follow the planned path; opens a shut door that is in the way and waits for it
  function followPath(k, speed, dt) {
    if (!k.path) return false;
    if (k.waitDoor) {
      k.speedNow = Math.max(0, k.speedNow - dt * 8);
      if (k.waitDoor.t > 0.9) { k.waitDoor = null; k.repathT = 0; }
      return true;
    }
    const n = k.path[k.pi];
    const tx = nav.nx[n], tz = nav.nz[n];
    const dx = tx - k.x, dz = tz - k.z, dist = Math.hypot(dx, dz);
    const last = k.pi === k.path.length - 1;
    if (dist < (last ? 0.3 : 0.6)) {
      if (last) { k.path = null; return false; }
      k.pi++;
      return true;
    }
    // a shut door within reach along the way: open it (Doom's monsters use doors too)
    const ahead = Math.min(dist, 1.6), ax = k.x + dx / dist * ahead, az = k.z + dz / dist * ahead;
    const an = nav.at(ax, az, k.feet), door = an >= 0 ? nav.shutDoorAt(an) : null;
    if (door && !door.locked) {
      if (door.target < 0.5) ctx.openDoor(door);
      k.waitDoor = door;
      return true;
    }
    const dh = turnTo(k, Math.atan2(dx, dz), 7, dt);
    const target = speed * clamp(Math.cos(dh) * 1.3, 0.2, 1);
    k.speedNow += (target - k.speedNow) * Math.min(1, dt * 5);
    const s = k.speedNow * dt;
    const nx = k.x + Math.sin(k.heading) * s, nz = k.z + Math.cos(k.heading) * s;
    // cutting a corner onto an unwalkable cell: slide along the path segment instead
    if (!stepTo(k, nx, nz)) { k.x += dx / dist * s; k.z += dz / dist * s; k.feet = floorAt(k.x, k.z, k.feet); }
    return true;
  }

  // ------------------------------------------------------------ Doom logic ----
  const nightmare = () => !!ctx.nightmare?.();
  const meleeRange = (k, p) => k.radius + 0.75 + IMP.melee;
  function newChaseDir(k, p, dist) {
    k.movecount = Math.floor(Math.random() * 16);
    // in the open and fairly close: head straight at the player with Doom's zig-zag (±60°); else take the path
    if (k.see && dist < 30 && Math.random() < 0.75) {
      const a = Math.atan2(p.x - k.x, p.z - k.z) + (Math.random() - 0.5) * 2.1;
      k.mode = 'direct'; k.dirX = Math.sin(a); k.dirZ = Math.cos(a);
    } else k.mode = 'path';
    k.blocked = false;
  }
  function checkMissileRange(k, dist) {
    if (!k.see) return false;
    if (k.justHit) { k.justHit = false; return true; }
    if (k.reaction > 0) return false;
    let d = dist * 12 - 64;                                 // Doom map units (≈ inches), less the melee reach
    if (d > 200) d = 200;
    return Math.random() * 256 >= d;
  }
  function startAttack(k, p, dist) {
    k.state = 'attack'; k.attackT = 0; k.fired = false;
    k.melee = dist < meleeRange(k, p) + 0.3;
    k.speedNow = 0;
    if (!k.melee) k.hand = fx.handFireball?.() || null;
  }
  function chaseTic(k, p) {
    if (k.reaction > 0) k.reaction = Math.max(0, k.reaction - 3);
    if (p.dead) { k.state = 'idle'; k.timer = 2 + Math.random() * 3; k.path = null; return; }
    const dist = Math.hypot(p.x - k.x, p.z - k.z);
    if (k.justAttacked) {
      k.justAttacked = false;
      if (!nightmare()) { newChaseDir(k, p, dist); return; }
    }
    if (k.see && dist < meleeRange(k, p) && Math.abs(p.feet - k.feet) < 3) { startAttack(k, p, dist); return; }
    if ((nightmare() || k.movecount === 0) && checkMissileRange(k, dist)) { startAttack(k, p, dist); k.justAttacked = true; return; }
    if (--k.movecount < 0 || k.blocked) newChaseDir(k, p, dist);
    if (Math.random() < 3 / 256) audio.play('impActive', { x: k.x, y: eyeY(k), z: k.z }, { rate: k.voice });
  }
  function chaseMove(k, p, dt) {
    const dx = p.x - k.x, dz = p.z - k.z, dist = Math.hypot(dx, dz);
    k.run = Math.min(1, k.run + dt * 3);
    if (dist < meleeRange(k, p) * 0.8 && Math.abs(p.feet - k.feet) < 3) {        // close enough: face and stop
      turnTo(k, Math.atan2(dx, dz), 8, dt);
      k.speedNow = Math.max(0, k.speedNow - dt * 10);
      return;
    }
    if (k.mode === 'direct') {
      turnTo(k, Math.atan2(k.dirX, k.dirZ), 8, dt);
      k.speedNow += (k.speed - k.speedNow) * Math.min(1, dt * 5);
      const s = k.speedNow * dt;
      if (!stepTo(k, k.x + k.dirX * s, k.z + k.dirZ * s)) { k.blocked = true; k.mode = 'path'; }
      return;
    }
    k.repathT -= dt;
    const goal = nav.nearest(p.x, p.z, p.feet);
    const far = k.goal < 0 || goal < 0 || Math.hypot(nav.nx[k.goal] - nav.nx[goal], nav.nz[goal] - nav.nz[k.goal]) > 3;
    if (!k.path || (k.repathT <= 0 && far)) {
      k.repathT = 0.6 + Math.random() * 0.4;
      if (!plan(k, goal)) { k.blocked = true; k.speedNow = Math.max(0, k.speedNow - dt * 6); turnTo(k, Math.atan2(dx, dz), 4, dt); return; }
    }
    if (!followPath(k, k.speed, dt)) k.path = null;
  }

  // wandering before they have noticed the player: stroll between rooms like the kids did
  function wander(k, dt) {
    k.run = Math.max(0, k.run - dt * 2);
    if (k.state === 'idle') {
      k.speedNow = Math.max(0, k.speedNow - dt * 4);
      k.timer -= dt;
      if (k.timer <= 0) {
        const rooms = Object.entries(WANDER).filter(([r]) => nav.byRoom.has(r));
        const tot = rooms.reduce((a, e) => a + e[1], 0);
        let x = Math.random() * tot, room = rooms[0][0];
        for (const [r, w] of rooms) { x -= w; if (x <= 0) { room = r; break; } }
        const c = nav.byRoom.get(room);
        if (c && plan(k, c[Math.floor(Math.random() * c.length)])) k.state = 'walk';
        else k.timer = 2 + Math.random() * 3;
      }
      return;
    }
    if (!followPath(k, k.walkSpeed, dt)) { k.state = 'idle'; k.timer = 3 + Math.random() * 7; }
  }

  // ------------------------------------------------------------ attacking ----
  function handPos(k, out) {
    k.group.updateMatrixWorld(true);
    return k.bones.handR.getWorldPosition(out);
  }
  function attack(k, p, dt) {
    const prev = k.attackT;
    k.attackT += dt * TICS;
    k.speedNow = Math.max(0, k.speedNow - dt * 12);
    turnTo(k, Math.atan2(p.x - k.x, p.z - k.z), 9, dt);                  // A_FaceTarget
    if (!k.fired && k.attackT >= IMP.fireTic) {
      k.fired = true;
      const dist = Math.hypot(p.x - k.x, p.z - k.z);
      if (!p.dead && dist < meleeRange(k, p) + 0.2 && Math.abs(p.feet - k.feet) < 3 && canSee(k, p)) {
        audio.play('claw', { x: k.x, y: eyeY(k), z: k.z }, { rate: k.voice });
        ctx.hurtPlayer((1 + Math.floor(Math.random() * 8)) * 3, k);
      } else if (!p.dead) {
        const h = handPos(k, tmp);
        const speed = nightmare() ? IMP.fireballFast : IMP.fireball;
        ctx.fireMissile('fireball', h.x, h.y, h.z, p.x, p.camY - 1.1, p.z, k, speed);   // at the chest: hits show on screen
        audio.play('fireShoot', { x: h.x, y: h.y, z: h.z });
      }
      k.hand?.remove(); k.hand = null;
    }
    if (k.hand) { const h = handPos(k, tmp2); k.hand.setPos(h.x, h.y, h.z); k.hand.setScale(smooth(0, IMP.fireTic, k.attackT)); }
    if (k.attackT >= IMP.attackTics) { k.state = 'chase'; k.hand?.remove(); k.hand = null; }
    void prev;
  }

  // ------------------------------------------------------------ damage ----
  function damage(k, amount, src = null, player = null) {
    if (k.state === 'dead' || k.state === 'gone') return false;
    k.health -= amount;
    if (src) {                                               // knock-back away from the source (Doom's thrust)
      const dx = k.x - src.x, dz = k.z - src.z, d = Math.hypot(dx, dz) || 1, push = Math.min(12, amount * 0.12);
      k.vx += dx / d * push; k.vz += dz / d * push;
    }
    if (k.health <= 0) { kill(k); return true; }
    const asleep = k.state === 'idle' || k.state === 'walk';
    if (asleep) { k.state = 'chase'; k.movecount = 0; k.path = null; }
    k.reaction = 0;
    if (Math.random() < IMP.painChance) {
      k.justHit = true;
      if (k.state === 'attack') { k.hand?.remove(); k.hand = null; }
      k.state = 'pain'; k.painT = 0;
      audio.play('impPain', { x: k.x, y: eyeY(k), z: k.z }, { rate: k.voice });
    }
    void player;
    return false;
  }
  function kill(k) {
    k.state = 'dead'; k.deathT = 0; k.screamed = false;
    k.hand?.remove(); k.hand = null;
    k.speedNow = 0; k.path = null;
    ctx.onKill?.(k);
  }
  // splash damage (rockets, BFG): falls off with distance to the body, needs a clear line to it
  function radiusDamage(x, y, z, radius, maxDamage, src) {
    for (const k of list) {
      if (k.state === 'dead' || k.state === 'gone') continue;
      const cy = clamp(y, k.feet, k.feet + k.height);
      const d = Math.max(0, Math.hypot(k.x - x, k.z - z, cy - y) - k.radius);
      if (d >= radius) continue;
      if (!ctx.sight(x, y, z, k.x, k.feet + k.height * 0.5, k.z)) continue;
      damage(k, Math.round(maxDamage * (1 - d / radius)), src || { x, z });
    }
  }
  // nearest imp body hit by a ray (vertical cylinders)
  function raycast(ox, oy, oz, dx, dy, dz, far, skip = null) {
    let best = null, bt = far;
    const a = dx * dx + dz * dz;
    for (const k of list) {
      if (k === skip || k.state === 'dead' || k.state === 'gone') continue;
      const fx = ox - k.x, fz = oz - k.z, r = k.radius * 0.9;
      const b = 2 * (fx * dx + fz * dz), c = fx * fx + fz * fz - r * r;
      let t;
      if (a < 1e-9) { if (c > 0) continue; t = 0; } else {
        const disc = b * b - 4 * a * c;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        t = (-b - sq) / (2 * a);
        if (t < 0) t = c < 0 ? 0 : (-b + sq) / (2 * a);
        if (t < 0) continue;
      }
      if (t >= bt) continue;
      const y = oy + dy * t;
      if (y < k.feet || y > k.feet + k.height) {
        // could still enter through the top or bottom cap
        if (Math.abs(dy) < 1e-6) continue;
        const ty = (y > k.feet + k.height ? k.feet + k.height : k.feet);
        const tc = (ty - oy) / dy;
        if (tc < 0 || tc >= bt) continue;
        const hx = ox + dx * tc - k.x, hz = oz + dz * tc - k.z;
        if (hx * hx + hz * hz > r * r) continue;
        t = tc;
      }
      best = k; bt = t;
    }
    return best ? { imp: best, t: bt } : null;
  }

  // ------------------------------------------------------------- posing ----
  const Q = (b, x, y, z) => { b.rotation.x = x; b.rotation.y = y; b.rotation.z = z; };
  function poseAttack(k) {
    const B = k.bones, u = k.attackT, S = k.S;
    const armDown = REST_ARM - S.armRest;
    const wind = smooth(0, 13, u), thr = smooth(IMP.fireTic - 1, IMP.fireTic + 2, u), back = smooth(IMP.fireTic + 2, IMP.attackTics, u);
    const on = wind * (1 - back);
    const up = B.upR.rotation, fore = B.foreR.rotation, ch = B.chest.rotation;
    let ux, uz, fx, cy;
    if (k.melee) {   // raise the hand to the side, then rake it across
      ux = lerp(-0.25, -1.1, thr); uz = lerp(-1.9, -0.35, thr); fx = lerp(-1.2, -0.35, thr); cy = lerp(-0.35, 0.65, thr);
    } else {         // overhand throw: arm cocked up and back, then whipped forward
      ux = lerp(0.55, -1.35, thr); uz = lerp(-2.35, -1.0, thr); fx = lerp(-1.75, -0.2, thr); cy = lerp(-0.5, 0.75, thr);
    }
    Q(B.upR, lerp(up.x, ux, on), up.y, lerp(up.z, uz, on));
    Q(B.foreR, lerp(fore.x, fx, on), fore.y, fore.z);
    ch.y = lerp(ch.y, cy, on);
    B.spine.rotation.x += 0.12 * on * (thr - 0.3);
    B.upL.rotation.z += 0.35 * on; B.upL.rotation.x -= 0.3 * on;           // the other arm balances
    void armDown;
  }
  function posePain(k) {
    const B = k.bones, s = 1 - clamp(k.painT / IMP.painTics, 0, 1), e = s * s;
    B.chest.rotation.x -= 0.4 * e; B.head.rotation.x -= 0.35 * e; B.neck.rotation.x -= 0.15 * e;
    B.upL.rotation.z += 0.45 * e; B.upR.rotation.z -= 0.45 * e;
  }
  function poseDeath(k) {
    const B = k.bones, t = k.deathT, S = k.S;
    const c = smooth(0, 0.35, t), f = smooth(0.22, 0.85, t);
    const legLen = S.hip[1] - S.ankle[1];
    for (const s of ['L', 'R']) { B['thigh' + s].rotation.x = -0.95 * c; B['shin' + s].rotation.x = 1.7 * c; B['foot' + s].rotation.x = -0.4 * c; }
    B.hips.position.y = k.rest.hips.y - 0.32 * legLen * c;
    B.spine.rotation.x = 0.35 * c - 0.25 * f; B.chest.rotation.x = 0.2 * c - 0.2 * f;
    B.head.rotation.x = 0.45 * c - 0.7 * f; B.neck.rotation.x = 0.2 * c - 0.3 * f;
    B.upL.rotation.z = 1.2 * f - 0.3 * c; B.upR.rotation.z = -1.2 * f + 0.3 * c;
    B.foreL.rotation.x = -0.6 * f; B.foreR.rotation.x = -0.6 * f;
    k.mesh.rotation.x = -1.42 * f;                   // topple backwards about the feet
    k.mesh.position.y = 0.26 * f;                    // (keeps the back on the floor instead of in it)
    for (const m of k.eyes) m.scale.set(1, t > 0.3 ? 0.12 : 1, 1);
  }

  // --------------------------------------------------------------- update ----
  function update(dt, player, now) {
    time += dt;
    const p = player;
    const focus = { x: p.x, y: p.camY, z: p.z };
    for (const k of list) {
      if (k.state === 'gone') {
        if (nightmare() && k.respawnT > 0) {                            // Nightmare: they come back
          k.respawnT -= dt;
          if (k.respawnT <= 0) {
            const h = k.home;
            if (Math.hypot(p.x - h.x, p.z - h.z) > 4) {
              reset(k, h.x, h.z, h.feet, h.heading); k.state = 'chase'; k.reaction = 0;
              fx.telefog?.({ x: h.x, y: h.feet, z: h.z }); audio.play('telefog', { x: h.x, y: h.feet + 3, z: h.z });
              ctx.onRespawn?.(k);
            } else k.respawnT = 2;
          }
        }
        continue;
      }
      // knock-back drifts and decays
      if (k.vx || k.vz) {
        const nx = k.x + k.vx * dt, nz = k.z + k.vz * dt;
        if (k.state !== 'dead' && walkable(nx, nz, k.feet) >= 0) { k.x = nx; k.z = nz; k.feet = floorAt(nx, nz, k.feet); }
        const fr = Math.pow(0.02, dt);
        k.vx *= fr; k.vz *= fr;
        if (Math.abs(k.vx) + Math.abs(k.vz) < 0.05) k.vx = k.vz = 0;
      }
      if (k.state === 'dead') {
        k.deathT += dt;
        if (!k.screamed && k.deathT > 8 / TICS) { k.screamed = true; audio.play(Math.random() < 0.5 ? 'impDeath1' : 'impDeath2', { x: k.x, y: k.feet + 4, z: k.z }, { rate: k.voice }); }
        k.walkW = 0; k.run = 0;
        k.shared.glow.value.multiplyScalar(Math.pow(0.02, dt));
        k.animate(dt, time, null, false);
        poseDeath(k);
        const dis = clamp((k.deathT - 1.3) / 1.6, 0, 1);
        k.shared.dissolve.value = dis > 0 ? 0.02 + dis * 1.05 : 0;
        if (dis > 0 && dis < 0.95 && Math.floor(k.deathT * 12) !== Math.floor((k.deathT - dt) * 12)) {
          fx.embers?.({ x: k.x + (Math.random() - 0.5) * 2, y: k.feet + 0.6, z: k.z + (Math.random() - 0.5) * 2 }, 5);
        }
        if (dis >= 1) { k.state = 'gone'; k.group.visible = false; k.blob.visible = false; k.respawnT = 12 + Math.random() * 8; }
        light(k, dt, now);
        continue;
      }
      // eyes: can it see the player? (checked a few times a second)
      k.seeT -= dt;
      if (k.seeT <= 0) { k.seeT = 0.18 + Math.random() * 0.1; k.see = canSee(k, p); }
      const asleep = k.state === 'idle' || k.state === 'walk';
      if (asleep) {
        if (k.see && inFront(k, p)) wake(k);
        else wander(k, dt);
      }
      if (k.state === 'chase') {
        k.chaseT += dt;
        while (k.chaseT >= 3 / TICS && k.state === 'chase') { k.chaseT -= 3 / TICS; chaseTic(k, p); }
        if (k.state === 'chase') chaseMove(k, p, dt);
      } else if (k.state === 'attack') attack(k, p, dt);
      else if (k.state === 'pain') {
        k.painT += dt * TICS;
        k.speedNow = Math.max(0, k.speedNow - dt * 12);
        if (k.painT >= IMP.painTics) k.state = 'chase';
      }
      // animation
      const moving = k.speedNow > 0.1;
      k.walkW += ((moving ? 1 : 0) - k.walkW) * Math.min(1, dt * 6);
      k.phase += (k.speedNow / k.scale * dt) / (2 * k.S.step) * 2 * Math.PI;
      if (!moving && k.walkW < 0.05) k.phase = Math.round(k.phase / Math.PI) * Math.PI;
      k.awake = asleep && k.state !== 'chase' ? Math.max(0, k.awake - dt) : Math.min(1, k.awake + dt * 3);
      k.shared.glow.value.copy(IMP.wakeGlow).multiplyScalar(k.awake * (0.85 + 0.15 * Math.sin(time * 9 + k.x)));
      const hunting = !asleep;
      k.animate(dt, time, hunting || (k.see && Math.hypot(p.x - k.x, p.z - k.z) < 12) ? focus : null, !hunting);
      if (k.state === 'attack') poseAttack(k);
      else if (k.state === 'pain') posePain(k);
      light(k, dt, now);
    }
    // keep bodies apart
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a.state === 'dead' || a.state === 'gone') continue;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        if (b.state === 'dead' || b.state === 'gone' || Math.abs(a.feet - b.feet) > 3) continue;
        const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = (a.radius + b.radius) * 0.85;
        if (d >= min || d < 1e-4) continue;
        const push = (min - d) / 2, ux = dx / d, uz = dz / d;
        if (walkable(a.x - ux * push, a.z - uz * push, a.feet) >= 0) { a.x -= ux * push; a.z -= uz * push; }
        if (walkable(b.x + ux * push, b.z + uz * push, b.feet) >= 0) { b.x += ux * push; b.z += uz * push; }
        a.place3d(); b.place3d();
      }
    }
  }

  return {
    list, nav, spawn, clear, update, damage, radiusDamage, raycast, noise, wake, prewarm,
    get alive() { return list.filter(k => k.state !== 'dead' && k.state !== 'gone').length; },
    clearLighting() { shCache.clear(); avgN = 0; for (const k of list) { k.room = null; k.hasSH = false; } prewarm(); },
    stats: { Girl: assets.Girl.stats, Boy: assets.Boy.stats, buildMs: geom.ms },
  };
}
