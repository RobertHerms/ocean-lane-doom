// Shots and projectiles: hitscan bullets with Doom's spread and vertical autoaim, fist / chainsaw, rockets,
// plasma, BFG (ball + 40 tracers), imp fireballs, splash damage. Walls, furniture and closed doors stop
// everything (BVH raycasts against the house); imps are vertical cylinders.
import * as THREE from 'three';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const d8 = () => 1 + Math.floor(Math.random() * 8);

// projectile kinds: speed ft/s, collision radius ft, direct damage roll, splash
export const MISSILES = {
  fireball: { speed: 22, r: 0.45, dmg: () => 3 * d8(), boom: 'fireball', snd: 'fireHit' },
  rocket: { speed: 44, r: 0.35, dmg: () => 20 * d8(), splash: [10, 128], boom: 'rocket', snd: 'explode' },
  plasma: { speed: 55, r: 0.35, dmg: () => 5 * d8(), boom: 'plasma', snd: 'plasmaHit' },
  bfg: { speed: 55, r: 0.8, dmg: () => 100 * d8(), boom: 'bfg', snd: 'bfgExplode', spray: true },
};

// ctx: { world() → meshes to raycast, imps, fx, audio, player (object with x,z,feet,camY,yaw,pitch,dead,radius,height),
//        hurtPlayer(amount, src, kind), opts() → { autoaim } }
export function createCombat(ctx) {
  const ray = new THREE.Raycaster();
  ray.firstHitOnly = true;
  const o = new THREE.Vector3(), d = new THREE.Vector3(), n3 = new THREE.Matrix3();
  const flying = [];

  // first thing along a ray: { t, point, normal, imp|null } or null
  function trace(ox, oy, oz, dx, dy, dz, far, skipImp = null) {
    o.set(ox, oy, oz); d.set(dx, dy, dz).normalize();
    ray.set(o, d); ray.far = far;
    const hits = ray.intersectObjects(ctx.world(), false);
    const w = hits[0];
    const ih = ctx.imps?.raycast(ox, oy, oz, d.x, d.y, d.z, w ? w.distance : far, skipImp);
    if (ih) return { t: ih.t, point: new THREE.Vector3(ox + d.x * ih.t, oy + d.y * ih.t, oz + d.z * ih.t), imp: ih.imp, normal: null };
    if (w) {
      let normal = null;
      if (w.face) { n3.getNormalMatrix(w.object.matrixWorld); normal = w.face.normal.clone().applyMatrix3(n3).normalize(); }
      return { t: w.distance, point: w.point, normal, imp: null };
    }
    return null;
  }
  function sight(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return true;
    o.set(ax, ay, az); d.set(dx / len, dy / len, dz / len);
    ray.set(o, d); ray.far = len - 0.3;
    return ray.intersectObjects(ctx.world(), false).length === 0;
  }

  // aim: the view direction, with Doom-style vertical autoaim toward an imp near the crosshair
  function aim(yawOff = 0, pitchOff = 0) {
    const p = ctx.player;
    let yaw = p.yaw + yawOff, pitch = p.pitch;
    if (ctx.opts().autoaim) {
      let best = null, bestA = 0.07;                         // within ±4° horizontally
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      for (const k of ctx.imps?.list || []) {
        if (k.state === 'dead' || k.state === 'gone') continue;
        const dx = k.x - p.x, dz = k.z - p.z, dist = Math.hypot(dx, dz);
        if (dist < 0.5 || dist > 80) continue;
        const cos = (dx * fx + dz * fz) / dist;
        if (cos <= 0) continue;
        const a = Math.acos(clamp(cos, -1, 1));
        if (a >= bestA) continue;
        const cy = k.feet + k.height * 0.55;
        const want = Math.atan2(cy - p.camY, dist);
        // only when the imp is roughly where the player is looking vertically too
        if (Math.abs(want - p.pitch) > 0.45) continue;
        if (!sight(p.x, p.camY, p.z, k.x, cy, k.z)) continue;
        best = want; bestA = a;
      }
      if (best !== null) pitch = best;
    }
    pitch += pitchOff;
    const cp = Math.cos(pitch);
    return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  }
  // where shots leave the player (slightly below the eye so tracers read)
  const muzzle = () => { const p = ctx.player; return [p.x, p.camY - 0.35, p.z]; };

  // ------------------------------------------------------------ hitscan ----
  function bullet(yawOff, pitchOff, damage) {
    const [dx, dy, dz] = aim(yawOff, pitchOff);
    const [ox, oy, oz] = muzzle();
    const h = trace(ox, oy, oz, dx, dy, dz, 250);
    if (!h) return false;
    if (h.imp) {
      ctx.fx.hitSpark?.(h.point);
      ctx.imps.damage(h.imp, damage, { x: ox, z: oz });
      return true;
    }
    ctx.fx.puff?.(h.point, h.normal);
    return false;
  }
  // fist / chainsaw: short hitscan; the saw pulls you toward what it bites and turns you to face it
  function melee(range, damage, yawOff, saw = false) {
    const p = ctx.player;
    const [dx, dy, dz] = aim(yawOff, 0);
    const h = trace(p.x, p.camY - 0.8, p.z, dx, dy, dz, range + 1.0);
    if (!h) return false;
    if (h.imp) {
      const k = h.imp;
      ctx.fx.hitSpark?.(h.point);
      ctx.imps.damage(k, damage, { x: p.x, z: p.z });
      const want = Math.atan2(-(k.x - p.x), -(k.z - p.z));
      let dYaw = want - p.yaw;
      while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
      while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
      p.yaw += saw ? clamp(dYaw, -0.09, 0.09) : dYaw;
      if (saw) ctx.pull?.(k.x - p.x, k.z - p.z);
      return true;
    }
    if (h.t < range) ctx.fx.puff?.(h.point, h.normal);
    return false;
  }

  // ---------------------------------------------------------- projectiles ----
  function spawn(kind, ox, oy, oz, dx, dy, dz, owner, speed) {
    const M = MISSILES[kind];
    const l = Math.hypot(dx, dy, dz) || 1;
    const vis = ctx.fx.projectile?.(kind) || null;
    const m = { kind, M, x: ox, y: oy, z: oz, vx: dx / l * speed, vy: dy / l * speed, vz: dz / l * speed, owner, vis, age: 0 };
    vis?.setPos(ox, oy, oz); vis?.setDir(m.vx, m.vy, m.vz);
    flying.push(m);
    return m;
  }
  // player's rockets / plasma / BFG ball
  function missile(kind) {
    const [dx, dy, dz] = aim(0, 0);
    const p = ctx.player;
    const [ox, oy, oz] = muzzle();
    // start just in front of the player (but not inside a wall right in front of us)
    const h = trace(ox, oy, oz, dx, dy, dz, 1.2);
    const s = h ? Math.max(0, h.t - 0.3) : 1.0;
    const m = spawn(kind, ox + dx * s, oy + dy * s, oz + dz * s, dx, dy, dz, 'player', MISSILES[kind].speed);
    m.fireYaw = p.yaw;
    if (h && s < 0.4) explode(m, null, h.point);
  }
  // an imp's fireball toward a point
  function fireball(ox, oy, oz, tx, ty, tz, owner, speed) {
    spawn('fireball', ox, oy, oz, tx - ox, ty - oy, tz - oz, owner, speed || MISSILES.fireball.speed);
  }

  function explode(m, hitImp, at, hitPlayer = false) {
    const M = m.M;
    const x = at ? at.x : m.x, y = at ? at.y : m.y, z = at ? at.z : m.z;
    m.dead = true;
    m.vis?.remove();
    ctx.fx.explosion?.({ x, y, z }, M.boom);
    ctx.audio.play(M.snd, { x, y, z });
    const src = { x: x - m.vx * 0.01, z: z - m.vz * 0.01 };
    if (hitImp) {
      // Doom: an imp's fireball hitting another imp bursts harmlessly (same species)
      if (!(m.owner !== 'player' && m.kind === 'fireball')) ctx.imps.damage(hitImp, M.dmg(), src);
    }
    if (hitPlayer) ctx.hurtPlayer(M.dmg(), m.owner === 'player' ? null : m.owner, m.kind);
    if (M.splash) {
      const [R, dmg] = M.splash;
      ctx.imps.radiusDamage(x, y, z, R, dmg, src);
      const p = ctx.player;
      if (!p.dead) {
        const cy = clamp(y, p.feet, p.feet + p.height);
        const dd = Math.max(0, Math.hypot(p.x - x, p.z - z, cy - y) - p.radius);
        if (dd < R && sight(x, y, z, p.x, p.camY - 1, p.z)) ctx.hurtPlayer(Math.round(dmg * (1 - dd / R)), null, 'splash', { x, z });
      }
    }
    if (M.spray && m.owner === 'player') bfgSpray(m.fireYaw ?? ctx.player.yaw);
  }
  // A_BFGSpray: 40 tracers from the shooter across a 90° fan, 15d8 each on the first imp in line
  function bfgSpray(yaw) {
    const p = ctx.player;
    if (p.dead) return;
    for (let i = 0; i < 40; i++) {
      const a = yaw + Math.PI / 4 - (Math.PI / 2) * i / 40;
      let best = null, bestT = 90;
      for (const k of ctx.imps.list) {
        if (k.state === 'dead' || k.state === 'gone') continue;
        const dx = k.x - p.x, dz = k.z - p.z, dist = Math.hypot(dx, dz);
        if (dist > bestT || dist < 0.1) continue;
        const fx = -Math.sin(a), fz = -Math.cos(a);
        const along = dx * fx + dz * fz, off = Math.abs(dx * fz - dz * fx);
        if (along <= 0 || off > k.radius + along * 0.035) continue;
        if (!sight(p.x, p.camY, p.z, k.x, k.feet + k.height * 0.5, k.z)) continue;
        best = k; bestT = dist;
      }
      if (!best) continue;
      let dmg = 0;
      for (let j = 0; j < 15; j++) dmg += d8();
      ctx.fx.bfgSpray?.({ x: best.x, y: best.feet + best.height * 0.5, z: best.z });
      ctx.imps.damage(best, dmg, { x: p.x, z: p.z });
    }
  }

  function update(dt) {
    const p = ctx.player;
    for (const m of flying) {
      if (m.dead) continue;
      m.age += dt;
      const step = Math.hypot(m.vx, m.vy, m.vz) * dt;
      const dx = m.vx * dt, dy = m.vy * dt, dz = m.vz * dt;
      // the world and imps along this frame's step
      const h = trace(m.x, m.y, m.z, dx, dy, dz, step + m.M.r, m.owner !== 'player' ? m.owner : null);
      // the player (for imps' fireballs): segment vs. body cylinder
      let tp = Infinity;
      if (m.owner !== 'player' && !p.dead) {
        for (let s = 1; s <= 4; s++) {
          const f = s / 4, x = m.x + dx * f, y = m.y + dy * f, z = m.z + dz * f;
          if (Math.hypot(x - p.x, z - p.z) < p.radius + m.M.r && y > p.feet - m.M.r && y < p.feet + p.height + m.M.r) { tp = step * f; break; }
        }
      }
      if (tp < Infinity && (!h || tp <= h.t)) { explode(m, null, { x: m.x + dx * tp / step, y: m.y + dy * tp / step, z: m.z + dz * tp / step }, true); continue; }
      if (h && h.t <= step + m.M.r) {
        const back = Math.max(0, h.t - m.M.r * 0.5), l = step || 1;
        explode(m, h.imp, { x: m.x + dx * back / l, y: m.y + dy * back / l, z: m.z + dz * back / l });
        continue;
      }
      m.x += dx; m.y += dy; m.z += dz;
      m.vis?.setPos(m.x, m.y, m.z);
      if (m.age > 8) { m.dead = true; m.vis?.remove(); }
    }
    for (let i = flying.length - 1; i >= 0; i--) if (flying[i].dead) flying.splice(i, 1);
  }
  function clear() { for (const m of flying) m.vis?.remove(); flying.length = 0; }

  return { trace, sight, aim, bullet, melee, missile, fireball, spawn, update, clear, flying };
}
