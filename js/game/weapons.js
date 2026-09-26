// Weapon logic, following Doom's weapon state tables (35 tics per second): when each shot happens, when the
// trigger is re-checked (A_ReFire), ammo use, switching (16 tics down, 16 up), bob, and Doom's damage and
// spread per weapon. The pose of the 3D weapon comes from the state object `vm` handed to the view model.
const TICS = 35;
const rand = n => Math.floor(Math.random() * n);          // 0..n-1
const spread = k => (Math.random() - Math.random()) * k;  // Doom's (P_Random() - P_Random()) spread, triangular

export const WEAPONS = {
  fist:     { slot: 1, ammo: null, per: 0, name: 'fist' },
  chainsaw: { slot: 1, ammo: null, per: 0, name: 'chainsaw' },
  pistol:   { slot: 2, ammo: 'bull', per: 1, name: 'pistol' },
  shotgun:  { slot: 3, ammo: 'shel', per: 1, name: 'shotgun' },
  ssg:      { slot: 3, ammo: 'shel', per: 2, name: 'super shotgun' },
  chaingun: { slot: 4, ammo: 'bull', per: 1, name: 'chaingun' },
  rocket:   { slot: 5, ammo: 'rckt', per: 1, name: 'rocket launcher' },
  plasma:   { slot: 6, ammo: 'cell', per: 1, name: 'plasma gun' },
  bfg:      { slot: 7, ammo: 'cell', per: 40, name: 'BFG 9000' },
};
// Doom's preference when the current weapon runs dry (P_CheckAmmo)
const FALLBACK = ['plasma', 'ssg', 'chaingun', 'shotgun', 'pistol', 'chainsaw', 'rocket', 'bfg', 'fist'];
const H_SPREAD = 5.6 * Math.PI / 180;     // (P_Random()-P_Random())<<18 → ±5.6°
const SSG_H = 11.2 * Math.PI / 180, SSG_V = 7.1 * Math.PI / 180;

// clip per weapon: length (tics), shot tics, refire check tic, flash (start, length, frames)
const CLIPS = {
  fist: { clip: 'punch', len: 17, shots: [4], refire: 17 },
  chainsaw: { clip: 'saw', len: 8, shots: [0, 4], refire: 8 },
  pistol: { clip: 'fire', len: 19, shots: [4], refire: 14, flash: [[4, 7, 1]] },
  shotgun: { clip: 'fire', len: 44, shots: [3], refire: 37, flash: [[3, 4, 1], [7, 3, 2]] },
  ssg: { clip: 'fire', len: 57, shots: [3], refire: 51, flash: [[3, 5, 1], [8, 4, 2]], events: { 24: 'ssgOpen', 38: 'ssgLoad', 51: 'ssgClose' } },
  chaingun: { clip: 'fire', len: 8, shots: [0, 4], refire: 8, flash: [[0, 4, 1], [4, 4, 2]] },
  rocket: { clip: 'fire', len: 20, shots: [8], refire: 20, flash: [[0, 3, 1], [3, 4, 2], [7, 4, 3], [11, 4, 4]] },
  plasma: { clip: 'fire', len: 3, shots: [0], refire: 3, flash: [[0, 4, 0]] },
  bfg: { clip: 'fire', len: 40, shots: [30], refire: 40, flash: [[20, 11, 1]], events: { 0: 'bfgFire' } },
};

// ctx: { audio, combat, player() → {x, z, feet, camY, yaw, pitch, speed, runSpeed}, onEmpty }
export function createWeapons(ctx, P) {
  const { audio } = ctx;
  const vm = { weapon: 'pistol', lower: 1, bobX: 0, bobY: 0, clip: 'idle', tics: 0, flash: 0, spin: 0, charge: 0, berserk: false, time: 0 };
  const S = {
    ready: 'pistol', pending: null, phase: 'raise',   // raise | ready | fire | cool | lower
    tics: 0, refire: 0, fired: new Set(), looped: false, attackDown: false, bobPhase: 0, sawLoop: null, lastSaw: '',
  };

  const has = w => !!P.weapons[w];
  const ammoOk = (w, n = 1) => { const d = WEAPONS[w]; return !d.ammo || P.ammo[d.ammo] >= d.per * n; };
  function bestWeapon() { return FALLBACK.find(w => has(w) && ammoOk(w)) || 'fist'; }
  function select(w) {
    if (!has(w) || w === S.ready && !S.pending) { if (w === S.ready) S.pending = null; return false; }
    if (w === S.pending) return false;
    S.pending = w;
    return true;
  }
  // number keys: 1 toggles fist/chainsaw, 3 toggles shotgun/super shotgun (like Doom II)
  function slot(n) {
    const cur = S.pending || S.ready;
    if (n === 1) {
      if (has('chainsaw')) return select(cur === 'chainsaw' ? 'fist' : 'chainsaw');
      return select('fist');
    }
    if (n === 3) {
      if (has('ssg') && has('shotgun')) return select(cur === 'ssg' ? 'shotgun' : 'ssg');
      return select(has('ssg') ? 'ssg' : 'shotgun');
    }
    const w = Object.keys(WEAPONS).find(k => WEAPONS[k].slot === n);
    return w ? select(w) : false;
  }
  function cycle(dir) {
    const order = ['fist', 'chainsaw', 'pistol', 'shotgun', 'ssg', 'chaingun', 'rocket', 'plasma', 'bfg'];
    let i = order.indexOf(S.pending || S.ready);
    for (let n = 0; n < order.length; n++) {
      i = (i + dir + order.length) % order.length;
      if (has(order[i]) && ammoOk(order[i])) return select(order[i]);
    }
    return false;
  }

  // ----------------------------------------------------------------- shots ----
  function shoot(w, first) {
    const c = ctx.combat, d = WEAPONS[w];
    if (d.ammo) P.ammo[d.ammo] = Math.max(0, P.ammo[d.ammo] - d.per);
    switch (w) {
      case 'fist': {
        const dmg = (1 + rand(10)) * 2 * (P.strength ? 10 : 1);
        const hit = c.melee(4.2, dmg, spread(H_SPREAD));
        if (hit) audio.play('punch');
        return;
      }
      case 'chainsaw': {
        const hit = c.melee(4.4, 2 * (1 + rand(10)), spread(H_SPREAD), true);
        if (hit) audio.play('sawHit');
        setSawLoop('sawFull');
        return;
      }
      case 'pistol': audio.play('pistol'); c.bullet(first ? 0 : spread(H_SPREAD), 0, 5 * (1 + rand(3))); break;
      case 'chaingun': audio.play('chaingun'); c.bullet(first ? 0 : spread(H_SPREAD), 0, 5 * (1 + rand(3))); break;
      case 'shotgun': audio.play('shotgun'); for (let i = 0; i < 7; i++) c.bullet(spread(H_SPREAD), 0, 5 * (1 + rand(3)), i > 0); break;
      case 'ssg': audio.play('ssgFire'); for (let i = 0; i < 20; i++) c.bullet(spread(SSG_H), spread(SSG_V), 5 * (1 + rand(3)), i > 0); break;
      case 'rocket': audio.play('rocketFire'); c.missile('rocket'); break;
      case 'plasma': audio.play('plasma'); c.missile('plasma'); break;
      case 'bfg': c.missile('bfg'); break;
    }
    ctx.onFire?.(w);
  }
  function setSawLoop(name) {
    if (S.lastSaw === name) return;
    S.sawLoop?.stop(); S.sawLoop = name ? audio.loop(name) : null; S.lastSaw = name;
  }

  // --------------------------------------------------------------- update ----
  // input: { fire: bool }. dead: lower the weapon for good.
  function update(dt, input, pl) {
    vm.time += dt;
    const fireHeld = input.fire && !pl.dead;
    S.attackDown = fireHeld;
    const w = S.ready, cl = CLIPS[w];
    vm.berserk = !!P.strength;
    // bob (only while ready, as in Doom): x swings with a 64-tic period, y bounces twice as often
    const bob = Math.min(1, (pl.speed * pl.speed) / (pl.runSpeed * pl.runSpeed) * 1.6) * (pl.viewBob === false ? 0 : 1);
    S.bobPhase += dt * TICS * (2 * Math.PI / 64);
    if (S.phase === 'ready') {
      vm.bobX += (bob * Math.cos(S.bobPhase) - vm.bobX) * Math.min(1, dt * 12);
      vm.bobY += (bob * Math.abs(Math.sin(S.bobPhase)) - vm.bobY) * Math.min(1, dt * 12);
    }
    // chainsaw engine noise: idles while the saw is up
    if (w === 'chainsaw' && S.phase !== 'lower' && !pl.dead) { if (S.phase !== 'fire') setSawLoop('sawIdle'); } else setSawLoop('');

    if (pl.dead && S.phase !== 'lower') { S.phase = 'lower'; S.tics = 0; S.pending = null; }
    switch (S.phase) {
      case 'raise':
        vm.lower = Math.max(0, vm.lower - dt * TICS / 16);
        vm.clip = 'idle'; vm.tics = 0; vm.flash = 0;
        if (vm.lower === 0) S.phase = 'ready';
        break;
      case 'lower':
        vm.lower = Math.min(1, vm.lower + dt * TICS / 16);
        vm.flash = 0;
        if (vm.lower === 1 && !pl.dead) {
          S.ready = S.pending || S.ready; S.pending = null; vm.weapon = S.ready; S.phase = 'raise';
          if (S.ready === 'chainsaw') audio.play('sawUp');
        }
        break;
      case 'ready':
        vm.clip = 'idle'; vm.tics += dt * TICS; vm.flash = 0;
        vm.charge = Math.max(0, vm.charge - dt * 1.5);
        if (S.pending) { S.phase = 'lower'; break; }
        if (!ammoOk(w)) { select(bestWeapon()); break; }
        if (fireHeld) startFire(w);
        break;
      case 'fire': {
        const prev = S.looped ? -1e-6 : S.tics;          // just went round again: the tic-0 shot is due
        S.looped = false;
        S.tics += dt * TICS;
        vm.clip = cl.clip; vm.tics = S.tics;
        // shots and sound events whose tic we just passed
        for (const t of cl.shots) if (prev <= t && S.tics > t && !S.fired.has(t)) {
          S.fired.add(t);
          if (!ammoOk(w)) continue;
          shoot(w, S.refire === 0 && t === cl.shots[0]);
        }
        if (cl.events) for (const [t, snd] of Object.entries(cl.events)) if (prev <= +t && S.tics > +t) audio.play(snd);
        vm.flash = 0;
        if (cl.flash) for (const [t0, len, f] of cl.flash) if (S.tics >= t0 && S.tics < t0 + len) vm.flash = f || 1 + rand(2);
        if (w === 'chaingun') vm.spin += dt * 18;
        if (w === 'bfg') vm.charge = Math.min(1, S.tics / 30);
        if (w === 'plasma') vm.charge = 1;
        // A_ReFire: still holding the trigger (and fed)? go round again, counting refires for accuracy
        if (prev < cl.refire && S.tics >= cl.refire) {
          if (fireHeld && !S.pending && ammoOk(w)) { S.refire++; S.tics -= cl.refire; S.fired.clear(); S.looped = true; break; }
          S.refire = 0;
          if (w === 'plasma') { S.phase = 'cool'; S.tics = 0; break; }
        }
        if (S.tics >= cl.len) { S.phase = 'ready'; S.tics = 0; S.refire = 0; vm.tics = 0; if (!ammoOk(w)) select(bestWeapon()); }
        break;
      }
      case 'cool':                                          // plasma gun's 20-tic cool-down frame
        S.tics += dt * TICS;
        vm.clip = 'cool'; vm.tics = S.tics; vm.flash = 0;
        vm.charge = Math.max(0, 1 - S.tics / 20);
        if (S.tics >= 20) { S.phase = 'ready'; S.tics = 0; }
        break;
    }
  }
  function startFire(w) {
    if (!ammoOk(w)) { select(bestWeapon()); return; }
    S.phase = 'fire'; S.tics = 0; S.fired.clear();
    ctx.onAttack?.(w);                                    // wakes the imps (Doom's P_NoiseAlert)
  }

  // new game / respawn: pistol raised from the bottom
  function reset() {
    S.ready = has('pistol') ? 'pistol' : 'fist'; S.pending = null; S.phase = 'raise'; S.tics = 0; S.refire = 0;
    vm.weapon = S.ready; vm.lower = 1; vm.clip = 'idle'; vm.flash = 0; vm.charge = 0; vm.spin = 0;
    setSawLoop('');
  }
  // Doom's weapon pickup: switch to it if it is new to us
  function gotWeapon(w, isNew) { if (isNew) select(w); }
  // Doom's ammo pickup: when we had none of that ammo, bring up a weapon that uses it
  function gotAmmo(type, had) {
    if (had) return;
    const r = S.ready;
    if (type === 'bull' && r === 'fist') select(has('chaingun') ? 'chaingun' : 'pistol');
    if (type === 'shel' && (r === 'fist' || r === 'pistol') && has('shotgun')) select('shotgun');
    if (type === 'cell' && (r === 'fist' || r === 'pistol') && has('plasma')) select('plasma');
    if (type === 'rckt' && r === 'fist' && has('rocket')) select('rocket');
  }

  return {
    vm, update, slot, cycle, select, reset, gotWeapon, gotAmmo,
    get current() { return S.ready; },
    get attackDown() { return S.attackDown; },
    get firing() { return S.phase === 'fire'; },
    stopSounds() { setSawLoop(''); },
  };
}
