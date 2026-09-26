// Pickups: where they lie in the house and what touching them does (Doom's P_TouchSpecialThing).
// Models come from itemmodels.js (ammo, health, armour, powerups, keys) and viewmodel.js (weapons).
import { roomAt } from '../house.js';
import * as L from '../layout.js';

// [room, type, count]. Keys open the three locked closets; the secret rooms count for SECRET %.
const PLACEMENT = [
  ['foyer', 'clip'], ['foyer', 'hbonus', 2],
  ['liv', 'shotgun'], ['liv', 'shell', 2], ['liv', 'stimpack'], ['liv', 'abonus', 2],
  ['din', 'shell'], ['din', 'clip'], ['din', 'hbonus', 3],
  ['kit', 'chaingun'], ['kit', 'clip', 2], ['kit', 'medikit'],
  ['pantry', 'berserk'],
  ['hall', 'abonus', 3], ['hall', 'hbonus', 2], ['hall', 'stimpack'],
  ['br1', 'rocket_launcher'], ['br1', 'rocket', 2], ['br1', 'greenarmor'],
  ['wic', 'soulsphere'], ['wic', 'keyYellow'],
  ['bath1', 'stimpack'], ['bath1', 'cell'], ['bath2', 'medikit'],
  ['br2', 'shell', 2], ['br2', 'clip'], ['br2', 'backpack'],
  ['br3', 'plasma_gun'], ['br3', 'cell', 2], ['br3', 'keyBlue'],
  ['upcl', 'abonus', 2], ['lc', 'stimpack'], ['cl3', 'shellbox'],
  ['rear', 'shellbox'], ['rear', 'rocket'], ['coat', 'cellpack'],
  ['gar', 'chainsaw_pickup'], ['gar', 'rocketbox'], ['gar', 'ammo'], ['gar', 'cell'], ['gar', 'keyRed'],
  ['hb', 'stimpack'], ['laun', 'ssg_pickup'], ['laun', 'shell', 2],
  ['util', 'bluearmor'],
  ['clN', 'megasphere'],
  ['stcl', 'bfg_pickup'], ['stcl', 'cellpack'],
  ['play', 'shellbox'], ['play', 'backpack'], ['play', 'medikit'], ['play', 'abonus', 2], ['play', 'ammo'], ['play', 'rocket', 2],
  ['rcl', 'rocket', 2], ['rcl', 'cell'],
];
export const LOCKS = { stcl: 'red', util1: 'blue', util2: 'blue', clN: 'yellow' };
export const SECRETS = ['pantry', 'wic', 'coat', 'rcl'];
const WEAPON_ITEMS = { shotgun: 'shotgun', chaingun: 'chaingun', rocket_launcher: 'rocket', plasma_gun: 'plasma', bfg_pickup: 'bfg', ssg_pickup: 'ssg', chainsaw_pickup: 'chainsaw' };
// Doom counts bonuses and powerups toward ITEMS %
const COUNTED = new Set(['hbonus', 'abonus', 'soulsphere', 'megasphere', 'berserk']);

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ctx: { scene, nav, envs, buildItem, animateItem, setItemEnv, buildWeaponPickup, setWeaponEnv }
export function createItems(ctx) {
  const { scene, nav } = ctx;
  const list = [];
  let total = 0;
  // candidate floor cells per room: open floor away from walls, or in a closet too small for that, any walkable
  // cell that is not hard against something
  const cells = new Map();
  for (let n = 0; n < nav.nh.length; n++) {
    const r = nav.nroom[n];
    if (!cells.has(r)) cells.set(r, []);
    if (nav.adj[n].length >= 5 && !nav.tags.has(n)) cells.get(r).push(n);
  }
  const notDoor = list => list.filter(n => !nav.tags.has(n));
  const candidates = room => {
    const open = notDoor(nav.byRoom.get(room) || []);
    if (open.length >= 4) return open;
    if (cells.get(room)?.length) return cells.get(room);
    const any = [];                                   // a narrow closet: any walkable cell in it
    for (let n = 0; n < nav.nh.length; n++) if (nav.nroom[n] === room && !nav.tags.has(n)) any.push(n);
    return any;
  };
  // no walkable cell at all (the closet under the rear stairs): the middle of the room, on its floor
  const middle = room => {
    const r = L.ROOMS.find(q => q.id === room);
    if (!r) return null;
    const [x0, x1, z0, z1] = r.rects[0];
    return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, feet: r.h[0] };
  };

  function place() {
    clear();
    const R = rng(4242);
    const taken = [];                                 // spots used so far {x, z}
    for (const [room, type, count = 1] of PLACEMENT) {
      const openList = notDoor(nav.byRoom.get(room) || []);
      const open = openList.length >= 4;                // room with open floor away from walls
      const cand = open ? openList : candidates(room);
      // closets too small for open floor: fill from the middle outwards, keeping pickups apart and off the walls
      let order = cand;
      if (!open && cand.length) {
        const cx = cand.reduce((a, m) => a + nav.nx[m], 0) / cand.length, cz = cand.reduce((a, m) => a + nav.nz[m], 0) / cand.length;
        order = cand.slice().sort((a, b) => (nav.adj[b].length - nav.adj[a].length) * 4 + Math.hypot(nav.nx[a] - cx, nav.nz[a] - cz) - Math.hypot(nav.nx[b] - cx, nav.nz[b] - cz));
      }
      for (let c = 0; c < count; c++) {
        const apartXZ = (x, z, d) => taken.every(t => Math.hypot(t.x - x, t.z - z) > d);
        const apart = (m, d) => apartXZ(nav.nx[m], nav.nz[m], d);
        let n = -1, spot = null;
        if (open) {
          for (let tries = 0; tries < 60; tries++) {
            const m = cand[Math.floor(R() * cand.length)];
            if (apart(m, tries < 40 ? 1.6 : 0.9)) { n = m; break; }
          }
        } else n = order.find(m => apart(m, 1.2)) ?? order.find(m => apart(m, 0.7)) ?? -1;
        if (n < 0) {                                    // crowded: the free cell farthest from what is already there
          let best = -1;
          for (const m of [...cand, ...(cells.get(room) || [])]) { const d = Math.min(...taken.map(t => Math.hypot(t.x - nav.nx[m], t.z - nav.nz[m])), 99); if (d > best) { best = d; n = m; } }
        }
        if (n >= 0) spot = { x: nav.nx[n], z: nav.nz[n], feet: nav.nh[n] };
        else {
          const mid = middle(room);
          if (mid) { const k = taken.filter(t => t.room === room).length; spot = { ...mid, x: mid.x + (k % 2 ? 0.9 : k ? -0.9 : 0) }; }
        }
        if (!spot) { console.warn('no room for', type, 'in', room); continue; }
        taken.push({ x: spot.x, z: spot.z, room });
        const weapon = WEAPON_ITEMS[type];
        const obj = weapon ? ctx.buildWeaponPickup(weapon) : ctx.buildItem(type);
        obj.position.set(spot.x, spot.feet, spot.z);
        obj.rotation.y = R() * Math.PI * 2;
        scene.add(obj);
        const env = ctx.envs.get(roomAt(spot.x, spot.z, spot.feet + 1)?.id) || ctx.envs.get('ext');
        if (env) (weapon ? ctx.setWeaponEnv : ctx.setItemEnv)(obj, env);
        const it = { type, weapon, obj, x: spot.x, z: spot.z, feet: spot.feet, room, taken: false, counted: COUNTED.has(type), phase: R() * 10 };
        if (it.counted) total++;
        list.push(it);
      }
    }
  }
  function clear() {
    for (const it of list) scene.remove(it.obj);
    list.length = 0; total = 0;
  }
  function relight() {
    for (const it of list) {
      const env = ctx.envs.get(roomAt(it.x, it.z, it.feet + 1)?.id) || ctx.envs.get('ext');
      if (env) (it.weapon ? ctx.setWeaponEnv : ctx.setItemEnv)(it.obj, env);
    }
  }
  function update(time) {
    for (const it of list) if (!it.taken && !it.weapon) ctx.animateItem(it.obj, time + it.phase);
  }
  // items the player is touching (Doom: bounding boxes overlap, feet within reach)
  function touching(p) {
    const out = [];
    for (const it of list) {
      if (it.taken) continue;
      if (Math.abs(it.feet - p.feet) > 2.4) continue;
      if (Math.hypot(it.x - p.x, it.z - p.z) < 1.55) out.push(it);
    }
    return out;
  }
  function take(it) { it.taken = true; it.obj.visible = false; }
  function setVisible(v) { for (const it of list) it.obj.visible = v && !it.taken; }

  return { list, place, clear, update, touching, take, relight, setVisible, get total() { return total; } };
}

// What each pickup does to the player P; returns a message, or null if it could not be picked up.
// game: { skill, weapons (createWeapons), hud } — ammo is doubled on the easiest and the hardest skill.
const CLIP = { bull: 10, shel: 4, cell: 20, rckt: 1 };
export function applyPickup(it, P, game) {
  const dbl = game.skill === 1 || game.skill === 5 ? 2 : 1;
  const give = (type, n) => {
    if (P.ammo[type] >= P.max[type]) return false;
    const had = P.ammo[type];
    P.ammo[type] = Math.min(P.max[type], P.ammo[type] + n * dbl);
    game.weapons.gotAmmo(type, had);
    return true;
  };
  const weapon = (w, ammo, n) => {
    const isNew = !P.weapons[w];
    const got = ammo ? give(ammo, n) : false;
    if (!isNew && !got) return false;
    P.weapons[w] = true;
    game.weapons.gotWeapon(w, isNew);
    if (isNew) game.hud.onWeaponPickup();
    return true;
  };
  switch (it.type) {
    case 'clip': return give('bull', 10) ? 'Picked up a clip.' : null;
    case 'ammo': return give('bull', 50) ? 'Picked up a box of bullets.' : null;
    case 'shell': return give('shel', 4) ? 'Picked up 4 shotgun shells.' : null;
    case 'shellbox': return give('shel', 20) ? 'Picked up a box of shotgun shells.' : null;
    case 'rocket': return give('rckt', 1) ? 'Picked up a rocket.' : null;
    case 'rocketbox': return give('rckt', 5) ? 'Picked up a box of rockets.' : null;
    case 'cell': return give('cell', 20) ? 'Picked up an energy cell.' : null;
    case 'cellpack': return give('cell', 100) ? 'Picked up an energy cell pack.' : null;
    case 'backpack':
      if (!P.backpack) { P.backpack = true; for (const k of Object.keys(P.max)) P.max[k] *= 2; }
      for (const [k, n] of Object.entries(CLIP)) give(k, n);
      return 'Picked up a backpack full of ammo!';
    case 'stimpack':
      if (P.health >= 100) return null;
      P.health = Math.min(100, P.health + 10); return 'Picked up a stimpack.';
    case 'medikit': {
      if (P.health >= 100) return null;
      const low = P.health < 25;
      P.health = Math.min(100, P.health + 25);
      return low ? 'Picked up a medikit. You REALLY needed that!' : 'Picked up a medikit.';
    }
    case 'hbonus': P.health = Math.min(200, P.health + 1); return 'Picked up a health bonus.';
    case 'abonus': P.armor = Math.min(200, P.armor + 1); if (!P.armorType) P.armorType = 1; return 'Picked up an armor bonus.';
    case 'greenarmor': if (P.armor >= 100) return null; P.armor = 100; P.armorType = 1; return 'Picked up the armor.';
    case 'bluearmor': if (P.armor >= 200) return null; P.armor = 200; P.armorType = 2; return 'Picked up the MegaArmor!';
    case 'soulsphere': P.health = Math.min(200, P.health + 100); return 'Supercharge!';
    case 'megasphere': P.health = 200; P.armor = 200; P.armorType = 2; return 'MegaSphere!';
    case 'berserk':
      if (P.health < 100) P.health = 100;
      P.strength = true; P.berserkT = 20;
      game.weapons.select('fist');
      return 'Berserk!';
    case 'keyBlue': P.keys.blue = true; return 'Picked up a blue keycard.';
    case 'keyYellow': P.keys.yellow = true; return 'Picked up a yellow keycard.';
    case 'keyRed': P.keys.red = true; return 'Picked up a red keycard.';
    case 'shotgun': return weapon('shotgun', 'shel', 8) ? 'You got the shotgun!' : null;
    case 'ssg_pickup': return weapon('ssg', 'shel', 8) ? 'You got the super shotgun!' : null;
    case 'chaingun': return weapon('chaingun', 'bull', 20) ? 'You got the chaingun!' : null;
    case 'rocket_launcher': return weapon('rocket', 'rckt', 2) ? 'You got the rocket launcher!' : null;
    case 'plasma_gun': return weapon('plasma', 'cell', 40) ? 'You got the plasma gun!' : null;
    case 'bfg_pickup': return weapon('bfg', 'cell', 40) ? 'You got the BFG 9000! Naptime is over.' : null;
    case 'chainsaw_pickup': return weapon('chainsaw', null, 0) ? 'A chainsaw! Time to trim the hedges!' : null;
  }
  return null;
}
export const isWeaponItem = t => !!WEAPON_ITEMS[t];
export const isPowerup = t => ['soulsphere', 'megasphere', 'berserk'].includes(t);
