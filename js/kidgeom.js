// Geometry for the children (no three.js dependency, so it can run in a worker): signed-distance
// bodies and hair with child proportions, polygonised with surface nets, plus skeleton joints and
// skin weights. Units are feet; each child stands at the origin facing +z, arms in a slight A-pose.
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ================================================================= SDF ====
function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }
function smax(a, b, k) { return -smin(-a, -b, k); }
function ell(px, py, pz, e) {
  const x = (px - e[0]) / e[3], y = (py - e[1]) / e[4], z = (pz - e[2]) / e[5];
  const k0 = Math.sqrt(x * x + y * y + z * z);
  const k1 = Math.sqrt(x * x / (e[3] * e[3]) + y * y / (e[4] * e[4]) + z * z / (e[5] * e[5]));
  return k1 < 1e-9 ? -Math.min(e[3], e[4], e[5]) : k0 * (k0 - 1) / k1;
}
// round cone: radius ra at a, rb at b (Inigo Quilez)
function rcone(px, py, pz, a, b, ra, rb) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const l2 = bx * bx + by * by + bz * bz, rr = ra - rb, a2 = l2 - rr * rr, il2 = 1 / l2;
  const ax = px - a[0], ay = py - a[1], az = pz - a[2];
  const y = ax * bx + ay * by + az * bz, z = y - l2;
  const qx = ax * l2 - bx * y, qy = ay * l2 - by * y, qz = az * l2 - bz * y;
  const x2 = qx * qx + qy * qy + qz * qz, y2 = y * y * l2, z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - ra;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - ra;
}
function torus(px, py, pz, c, R, r, tilt = 0) {
  let x = px - c[0], y = py - c[1], z = pz - c[2];
  if (tilt) { const cs = Math.cos(tilt), sn = Math.sin(tilt); const yy = y * cs - z * sn; z = y * sn + z * cs; y = yy; }
  const q = Math.sqrt(x * x + z * z) - R;
  return Math.sqrt(q * q + y * y) - r;
}
function hash3(x, y, z) { let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); }
function vnoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const n = (a, b, c) => hash3(ix + a, iy + b, iz + c);
  return lerp(lerp(lerp(n(0, 0, 0), n(1, 0, 0), fx), lerp(n(0, 1, 0), n(1, 1, 0), fx), fy),
    lerp(lerp(n(0, 0, 1), n(1, 0, 1), fx), lerp(n(0, 1, 1), n(1, 1, 1), fx), fy), fz);
}

// ======================================================== surface nets ====
const CO = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
function polygonize(f, bmin, bmax, h) {
  const nx = Math.ceil((bmax[0] - bmin[0]) / h) + 1, ny = Math.ceil((bmax[1] - bmin[1]) / h) + 1, nz = Math.ceil((bmax[2] - bmin[2]) / h) + 1;
  const v = new Float32Array(nx * ny * nz);
  const id = (i, j, k) => i + nx * (j + ny * k);
  // evaluate in 4³ blocks; a block whose centre is far from the surface takes the centre value
  const B = 4;
  for (let k0 = 0; k0 < nz; k0 += B) for (let j0 = 0; j0 < ny; j0 += B) for (let i0 = 0; i0 < nx; i0 += B) {
    const i1 = Math.min(i0 + B, nx), j1 = Math.min(j0 + B, ny), k1 = Math.min(k0 + B, nz);
    const ci = (i0 + i1 - 1) / 2, cj = (j0 + j1 - 1) / 2, ck = (k0 + k1 - 1) / 2;
    const d = f(bmin[0] + ci * h, bmin[1] + cj * h, bmin[2] + ck * h);
    const rad = Math.hypot(i1 - 1 - i0, j1 - 1 - j0, k1 - 1 - k0) * h / 2;
    const far = Math.abs(d) > rad * 1.8 + 2 * h;
    for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      v[id(i, j, k)] = far ? d : f(bmin[0] + i * h, bmin[1] + j * h, bmin[2] + k * h);
    }
  }
  const cx = nx - 1, cy = ny - 1;
  const cell = new Int32Array(cx * cy * (nz - 1)).fill(-1);
  const cid = (i, j, k) => i + cx * (j + cy * k);
  const pos = [];
  const c = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let inside = 0;
    for (let q = 0; q < 8; q++) { c[q] = v[id(i + CO[q][0], j + CO[q][1], k + CO[q][2])]; if (c[q] < 0) inside++; }
    if (inside === 0 || inside === 8) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of EDGES) {
      if ((c[a] < 0) === (c[b] < 0)) continue;
      const t = c[a] / (c[a] - c[b]);
      sx += CO[a][0] + t * (CO[b][0] - CO[a][0]); sy += CO[a][1] + t * (CO[b][1] - CO[a][1]); sz += CO[a][2] + t * (CO[b][2] - CO[a][2]);
      n++;
    }
    cell[cid(i, j, k)] = pos.length / 3;
    pos.push(bmin[0] + (i + sx / n) * h, bmin[1] + (j + sy / n) * h, bmin[2] + (k + sz / n) * h);
  }
  const quads = [];
  const quad = (a, b, c2, d, flip) => { if (a < 0 || b < 0 || c2 < 0 || d < 0) return; if (flip) quads.push(a, d, c2, b); else quads.push(a, b, c2, d); };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = v[id(i, j, k)], b = v[id(i + 1, j, k)];
    if ((a < 0) === (b < 0)) continue;
    quad(cell[cid(i, j - 1, k - 1)], cell[cid(i, j, k - 1)], cell[cid(i, j, k)], cell[cid(i, j - 1, k)], !(a < 0));
  }
  for (let k = 1; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = v[id(i, j, k)], b = v[id(i, j + 1, k)];
    if ((a < 0) === (b < 0)) continue;
    quad(cell[cid(i - 1, j, k - 1)], cell[cid(i, j, k - 1)], cell[cid(i, j, k)], cell[cid(i - 1, j, k)], a < 0);
  }
  for (let k = 0; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = v[id(i, j, k)], b = v[id(i, j, k + 1)];
    if ((a < 0) === (b < 0)) continue;
    quad(cell[cid(i - 1, j - 1, k)], cell[cid(i, j - 1, k)], cell[cid(i, j, k)], cell[cid(i - 1, j, k)], !(a < 0));
  }
  // snap vertices onto the surface and take normals from the field gradient
  const P = new Float32Array(pos), N = new Float32Array(pos.length), e = h * 0.35;
  for (let i = 0; i < P.length; i += 3) {
    let x = P[i], y = P[i + 1], z = P[i + 2], gx = 0, gy = 0, gz = 1;
    for (let it = 0; it < 3; it++) {
      const d = f(x, y, z);
      gx = f(x + e, y, z) - f(x - e, y, z); gy = f(x, y + e, z) - f(x, y - e, z); gz = f(x, y, z + e) - f(x, y, z - e);
      const g2 = (gx * gx + gy * gy + gz * gz) / (4 * e * e);
      if (it < 2 && g2 > 1e-6) { const s = d / g2 / (2 * e); x -= gx * s; y -= gy * s; z -= gz * s; }
    }
    const gl = Math.hypot(gx, gy, gz) || 1;
    P[i] = x; P[i + 1] = y; P[i + 2] = z; N[i] = gx / gl; N[i + 1] = gy / gl; N[i + 2] = gz / gl;
  }
  const index = [];
  for (let q = 0; q < quads.length; q += 4) {
    const [a, b, c2, d] = [quads[q], quads[q + 1], quads[q + 2], quads[q + 3]];
    // split along the shorter diagonal
    const dac = (P[a * 3] - P[c2 * 3]) ** 2 + (P[a * 3 + 1] - P[c2 * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[c2 * 3 + 2]) ** 2;
    const dbd = (P[b * 3] - P[d * 3]) ** 2 + (P[b * 3 + 1] - P[d * 3 + 1]) ** 2 + (P[b * 3 + 2] - P[d * 3 + 2]) ** 2;
    if (dac < dbd) index.push(a, b, c2, a, c2, d); else index.push(a, b, d, b, c2, d);
  }
  // make every triangle face along the field gradient
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c2 = index[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c2] - P[a], vy = P[c2 + 1] - P[a + 1], vz = P[c2 + 2] - P[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (fx * (N[a] + N[b] + N[c2]) + fy * (N[a + 1] + N[b + 1] + N[c2 + 1]) + fz * (N[a + 2] + N[b + 2] + N[c2 + 2]) < 0) {
      const tmp = index[t + 1]; index[t + 1] = index[t + 2]; index[t + 2] = tmp;
    }
  }
  return { pos: P, nrm: N, index };
}

// =============================================================== kids ====
// Units are feet; each child is modelled standing at the origin facing +z, arms in a slight A-pose.
export const REST_ARM = 0.56;   // rest abduction of the arms (rad from vertical)

export const GIRL = {
  name: 'Girl', dot: '#ff79b6', H: 3.6, radius: 0.55, speed: 2.45, step: 1.0, hipYaw: 0.07, sway: 0.022, bob: 0.03,
  armRest: 0.2, elbow: 0.22, armSwing: 0.28, kneeAmp: 0.95, splay: 0.02, lookYaw: 0.75,
  cranium: [0, 3.285, -0.012, 0.222, 0.3, 0.262], jaw: [0, 3.1, 0.042, 0.176, 0.152, 0.198],
  cheek: [0.095, 3.125, 0.105, 0.085, 0.075, 0.085], nose: [0, 3.162, 0.228, 0.03, 0.037, 0.033],
  ear: [0.218, 3.2, -0.01, 0.028, 0.068, 0.046],
  chin: 2.95, eyeX: 0.082, eyeY: 3.232, eyeR: 0.036, mouthY: 3.07, mouthW: 0.066, smile: 0.018, browDY: 0.075,
  neck: [[0, 2.79, -0.02], [0, 3.02, -0.015], 0.098, 0.09],
  shX: 0.33, shY: 2.72, shR: 0.1,
  torso: [[0, 2.5, 0, 0.305, 0.3, 0.2], [0, 2.13, 0.016, 0.29, 0.3, 0.205], [0, 1.8, -0.01, 0.298, 0.23, 0.21], [0, 1.77, -0.075, 0.265, 0.2, 0.168]],
  arm: { up: 0.55, fore: 0.45, hand: 0.36, r: [0.082, 0.068, 0.063, 0.048] },
  hip: [0.158, 1.72, 0], knee: [0.15, 0.98, 0.012], calf: [0.148, 0.72, -0.012], ankle: [0.145, 0.14, -0.02],
  legR: [0.162, 0.102, 0.098, 0.063],
  foot: { z: 0.14, half: 0.27, w: 0.088, h: 0.068 },
  waistY: 2.1, chestY: 2.45, neckY: 2.84, headY: 3.0,
  skin: '#ecbca2', blush: '#e39486', lip: '#d88a84', lipLine: '#914f4a', brow: '#8a6d52',
  iris: '#6d5238', hair: ['#6e5a48', '#9c8468', '#c6ad8b'],
};
export const BOY = {
  name: 'Boy', dot: '#5aa7ff', H: 3.0, radius: 0.5, speed: 1.85, step: 0.6, hipYaw: 0.05, sway: 0.04, bob: 0.035,
  armRest: 0.32, elbow: 0.5, armSwing: 0.16, kneeAmp: 0.6, splay: 0.07, lookYaw: 0.9,
  cranium: [0, 2.715, -0.015, 0.232, 0.29, 0.268], jaw: [0, 2.53, 0.045, 0.188, 0.16, 0.2],
  cheek: [0.1, 2.555, 0.11, 0.098, 0.088, 0.095], nose: [0, 2.6, 0.232, 0.028, 0.032, 0.03],
  ear: [0.232, 2.625, -0.02, 0.032, 0.07, 0.05],
  chin: 2.37, eyeX: 0.084, eyeY: 2.665, eyeR: 0.036, mouthY: 2.49, mouthW: 0.06, smile: 0.012, browDY: 0.072,
  neck: [[0, 2.22, -0.02], [0, 2.44, -0.015], 0.1, 0.092],
  shX: 0.3, shY: 2.19, shR: 0.105,
  torso: [[0, 1.97, 0, 0.3, 0.26, 0.215], [0, 1.66, 0.03, 0.305, 0.3, 0.238], [0, 1.37, -0.01, 0.295, 0.2, 0.222], [0, 1.34, -0.07, 0.262, 0.18, 0.18]],
  arm: { up: 0.42, fore: 0.36, hand: 0.29, r: [0.09, 0.076, 0.071, 0.052] },
  hip: [0.152, 1.3, 0], knee: [0.158, 0.73, 0.012], calf: [0.158, 0.5, -0.01], ankle: [0.158, 0.11, -0.015],
  legR: [0.178, 0.122, 0.116, 0.08],
  foot: { z: 0.1, half: 0.215, w: 0.09, h: 0.062 },
  collar: true, cuffs: true,
  waistY: 1.6, chestY: 1.92, neckY: 2.26, headY: 2.42,
  skin: '#efbfa4', blush: '#e8988a', lip: '#d98a82', lipLine: '#8e4c46', brow: '#6b4d3a',
  iris: '#4a3222', hair: ['#4f3626', '#735340', '#9c7858'], lines: '#a7aebb',
  shirt: '#f1eee6', button: '#e7e2d6', pants: '#a1978b', sock: '#7d7e85', sockYellow: '#f2c03c',
};

export function armFrame(S, side) {
  const dir = [side * Math.sin(REST_ARM), -Math.cos(REST_ARM), 0];
  const sh = [side * S.shX, S.shY, 0];
  const at = t => [sh[0] + dir[0] * t, sh[1] + dir[1] * t, sh[2]];
  return { dir, sh, el: at(S.arm.up), wr: at(S.arm.up + S.arm.fore), tip: at(S.arm.up + S.arm.fore + S.arm.hand), at };
}

// Body field split into components: [core, armL, armR, legL, legR]
function bodyComponents(S, sockets) {
  const A = [armFrame(S, 1), armFrame(S, -1)];
  const [n0, n1, nr0, nr1] = S.neck;
  return (x, y, z) => {
    // head
    let head = smin(ell(x, y, z, S.cranium), ell(x, y, z, S.jaw), 0.08);
    head = smin(head, ell(x, y, z, S.cheek), 0.05);
    head = smin(head, ell(x, y, z, [-S.cheek[0], ...S.cheek.slice(1)]), 0.05);
    head = smin(head, ell(x, y, z, S.nose), 0.03);
    head = smin(head, ell(x, y, z, S.ear), 0.02);
    head = smin(head, ell(x, y, z, [-S.ear[0], ...S.ear.slice(1)]), 0.02);
    if (sockets) for (const s of sockets) head = smax(head, -ell(x, y, z, s), 0.01);
    let core = smin(head, rcone(x, y, z, n0, n1, nr0, nr1), 0.06);
    // torso
    let t = ell(x, y, z, S.torso[0]);
    for (let i = 1; i < S.torso.length; i++) t = smin(t, ell(x, y, z, S.torso[i]), 0.1);
    t = smin(t, rcone(x, y, z, [-S.shX, S.shY, 0], [S.shX, S.shY, 0], S.shR, S.shR), 0.09);
    core = smin(core, t, 0.07);
    if (S.collar) {
      core = smin(core, torus(x, y, z, [0, S.neckY + 0.015, 0.0], 0.125, 0.021, -0.42), 0.01);
    }
    // arms
    const arms = A.map(a => {
      let d = rcone(x, y, z, a.sh, a.el, S.arm.r[0], S.arm.r[1]);
      d = smin(d, rcone(x, y, z, a.el, a.wr, S.arm.r[1] * 0.96, S.arm.r[3]), 0.03);
      // hand: flattened palm (thin across the arm plane) with a thumb forward
      const hc = a.at(S.arm.up + S.arm.fore + S.arm.hand * 0.42);
      const ux = a.dir[0], uy = a.dir[1];
      const px = x - hc[0], py = y - hc[1], pz = z - hc[2];
      const u = px * ux + py * uy, w = px * uy - py * ux;            // along the arm, across the arm plane
      const hand = ell(u, w, pz, [0, 0, 0, S.arm.hand * 0.5, S.arm.r[3] * 0.82, S.arm.r[3] * 1.5]);
      d = smin(d, hand, 0.035);
      const th0 = a.at(S.arm.up + S.arm.fore + 0.03), th1 = a.at(S.arm.up + S.arm.fore + S.arm.hand * 0.42);
      d = smin(d, rcone(x, y, z, [th0[0], th0[1], 0.035], [th1[0], th1[1], 0.075], S.arm.r[3] * 0.45, S.arm.r[3] * 0.38), 0.02);
      return d;
    });
    // legs
    const legs = [1, -1].map(s => {
      const hp = [s * S.hip[0], S.hip[1], S.hip[2]], kn = [s * S.knee[0], S.knee[1], S.knee[2]];
      const cf = [s * S.calf[0], S.calf[1], S.calf[2]], an = [s * S.ankle[0], S.ankle[1], S.ankle[2]];
      let d = rcone(x, y, z, hp, kn, S.legR[0], S.legR[1]);
      d = smin(d, rcone(x, y, z, kn, cf, S.legR[1], S.legR[2]), 0.04);
      d = smin(d, rcone(x, y, z, cf, an, S.legR[2], S.legR[3]), 0.05);
      let foot = ell(x, y, z, [s * S.ankle[0], S.foot.h, S.foot.z, S.foot.w, S.foot.h, S.foot.half]);
      foot = smax(foot, -y, 0.012);
      d = smin(d, foot, 0.05);
      if (S.cuffs) d = smin(d, torus(x, y, z, [an[0], an[1] + 0.09, an[2]], S.legR[3] + 0.012, 0.03), 0.02);
      return d;
    });
    return [core, arms[0], arms[1], legs[0], legs[1]];
  };
}
function bodyField(comps) {
  return (x, y, z) => {
    const c = comps(x, y, z);
    return Math.min(smin(c[0], c[1], 0.045), smin(c[0], c[2], 0.045), smin(c[0], c[3], 0.05), smin(c[0], c[4], 0.05));
  };
}

// front of the face at (x, y): march in from outside along -z
function surfaceZ(f, x, y) {
  let lo = -0.2, hi = 0.6;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (f(x, y, m) < 0) lo = m; else hi = m; }
  return lo;
}

const HAIR = {
  Girl(x, y, z) {
    // full, wavy shoulder-length hair (photo): a low rounded crown that widens quickly, most of the
    // volume beside the ears and cheeks, falling in soft waves onto the shoulders
    let d = ell(x, y, z, [0, 3.29, -0.045, 0.34, 0.335, 0.325]);
    const flare = clamp((3.3 - y) / 0.5, 0, 1);
    const rx = 0.33 + 0.035 * flare, rz = 0.27 + 0.02 * flare;
    const ex = x / rx, ez = (z + 0.07) / rz;
    let cur = (Math.sqrt(ex * ex + ez * ez) - 1) * rz;
    cur = Math.max(cur, Math.abs(y - 2.98) - 0.3);
    d = smin(d, cur, 0.12);
    for (const s of [-1, 1]) d = smin(d, rcone(x, y, z, [s * 0.25, 3.1, 0.05], [s * 0.3, 2.6, 0.02], 0.055, 0.065), 0.06);   // locks resting on the shoulders
    const a = Math.atan2(x, z + 0.05);
    const lower = clamp((3.2 - y) / 0.45, 0, 1);
    d += 0.012 * Math.sin(a * 9 + y * 11) * lower + 0.02 * (vnoise(x * 7, y * 3, z * 7) - 0.5)
      + 0.05 * (vnoise(x * 13, 0.3, z * 13) - 0.5) * clamp((2.84 - y) / 0.2, 0, 1);
    d = smax(d, -ell(x, y, z, [0, 3.14, 0.23, 0.19, 0.31, 0.2]), 0.035);   // the face
    // nothing in front of the throat: below the chin the hair stays behind the neck, beside it the locks may come forward
    const below = clamp((2.99 - y) / 0.08, 0, 1), beside = clamp((Math.abs(x) - 0.15) / 0.06, 0, 1);
    const zmax = 0.07 - below * (1 - beside) * 0.12 + beside * 0.08;
    const front = (z - zmax) - Math.max(0, y - 3.02) * 8;
    return smax(d, front, 0.03);
  },
  Boy(x, y, z) {
    let d = ell(x, y, z, [0, 2.73, -0.028, 0.26, 0.318, 0.297]);
    const a = Math.atan2(x, z);
    const hl = 2.52 + 0.35 * Math.pow((1 + Math.cos(a)) / 2, 1.2);
    d = smax(d, hl - y, 0.03);
    d -= 0.026 * vnoise(x * 9, y * 9, z * 9) + 0.014 * vnoise(x * 20 + 5, y * 20, z * 20);
    d = smin(d, ell(x, y, z, [0.03, 2.995, 0.07, 0.11, 0.045, 0.09]), 0.05);
    d = smin(d, ell(x, y, z, [-0.07, 2.99, -0.05, 0.1, 0.045, 0.1]), 0.05);
    d = smin(d, ell(x, y, z, [0.05, 2.9, 0.19, 0.14, 0.045, 0.075]), 0.04);
    return smax(d, -ell(x, y, z, [0, 2.6, 0.245, 0.2, 0.28, 0.14]), 0.02);
  },
};

// ------------------------------------------------------------ skeleton ----
export const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'upL', 'foreL', 'handL', 'upR', 'foreR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];
export const PARENT = { spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', upL: 'chest', foreL: 'upL', handL: 'foreL', upR: 'chest', foreR: 'upR', handR: 'foreR', thighL: 'hips', shinL: 'thighL', footL: 'shinL', thighR: 'hips', shinR: 'thighR', footR: 'shinR' };
function joints(S) {
  const aL = armFrame(S, 1), aR = armFrame(S, -1);
  const leg = s => ({
    hip: [s * S.hip[0], S.hip[1], S.hip[2]], knee: [s * S.knee[0], S.knee[1], S.knee[2]],
    ankle: [s * S.ankle[0], S.ankle[1], S.ankle[2]], toe: [s * S.ankle[0], 0.05, S.foot.z + S.foot.half * 0.85],
  });
  const lL = leg(1), lR = leg(-1);
  // [joint, segment end] per bone
  return {
    hips: [[0, S.hip[1], 0], [0, S.waistY, 0]], spine: [[0, S.waistY, 0], [0, S.chestY, 0]],
    chest: [[0, S.chestY, 0], [0, S.neckY, -0.015]], neck: [[0, S.neckY, -0.015], [0, S.headY, -0.012]],
    head: [[0, S.headY, -0.012], [0, S.H - 0.05, 0]],
    upL: [aL.sh, aL.el], foreL: [aL.el, aL.wr], handL: [aL.wr, aL.tip],
    upR: [aR.sh, aR.el], foreR: [aR.el, aR.wr], handR: [aR.wr, aR.tip],
    thighL: [lL.hip, lL.knee], shinL: [lL.knee, lL.ankle], footL: [lL.ankle, lL.toe],
    thighR: [lR.hip, lR.knee], shinR: [lR.knee, lR.ankle], footR: [lR.ankle, lR.toe],
  };
}
function segDist(p, a, b) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2];
  const t = clamp(((p[0] - a[0]) * bx + (p[1] - a[1]) * by + (p[2] - a[2]) * bz) / (bx * bx + by * by + bz * bz), 0, 1);
  return Math.hypot(p[0] - a[0] - bx * t, p[1] - a[1] - by * t, p[2] - a[2] - bz * t);
}
const ALLOWED = [
  ['hips', 'spine', 'chest', 'neck', 'head', 'upL', 'upR', 'thighL', 'thighR'],
  ['chest', 'upL', 'foreL', 'handL'], ['chest', 'upR', 'foreR', 'handR'],
  ['hips', 'thighL', 'shinL', 'footL'], ['hips', 'thighR', 'shinR', 'footR'],
];
function skinWeights(S, J, P, lab) {
  const n = P.length / 3;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const bi = Object.fromEntries(BONES.map((b, i) => [b, i]));
  for (let v = 0; v < n; v++) {
    const p = [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]], l = lab[v];
    let ws = [];
    if (l === 0 && p[1] > S.chin + 0.01) ws = [['head', 1]];
    else {
      for (const b of ALLOWED[l]) {
        const d = segDist(p, J[b][0], J[b][1]);
        let w = 1 / Math.pow(d * d + 2e-4, 2);
        if (l === 0 && (b === 'upL' || b === 'upR')) w *= clamp((p[1] - (S.shY - 0.1)) / 0.14, 0, 1) * clamp((Math.abs(p[0]) - (S.shX - 0.14)) / 0.1, 0, 1);
        if (l === 0 && (b === 'thighL' || b === 'thighR')) w *= clamp((S.hip[1] + 0.02 - p[1]) / 0.16, 0, 1) * (Math.sign(p[0]) === (b === 'thighL' ? 1 : -1) ? 1 : 0);
        if (l === 0 && b === 'head') w *= clamp((p[1] - (S.chin - 0.1)) / 0.1, 0, 1);
        ws.push([b, w]);
      }
      ws.sort((a, b) => b[1] - a[1]);
      ws = ws.slice(0, 4);
    }
    const tot = ws.reduce((a, w) => a + w[1], 0) || 1;
    ws.forEach(([b, w], k) => { si[v * 4 + k] = bi[b]; sw[v * 4 + k] = w / tot; });
  }
  return { si, sw };
}

// Everything the renderer needs for one child, as plain typed arrays. q scales the polygonisation step
// (1 = the walkthrough's close-up detail; the game uses coarser meshes because there are many imps).
export function buildKidGeometry(name, q = 1) {
  const S = name === 'Girl' ? GIRL : BOY;
  const comps0 = bodyComponents(S, null);
  const core0 = (x, y, z) => comps0(x, y, z)[0];
  const sockets = [], eyes = [];
  for (const s of [1, -1]) {
    const zf = surfaceZ(core0, s * S.eyeX, S.eyeY);
    sockets.push([s * S.eyeX, S.eyeY, zf - 0.008, S.eyeR * 1.3, S.eyeR * 0.7, S.eyeR * 0.85]);
    eyes.push([s * S.eyeX, S.eyeY, zf - 0.03]);
  }
  const comps = bodyComponents(S, sockets);
  const field = bodyField(comps);
  const reach = S.shX + (S.arm.up + S.arm.fore + S.arm.hand) * Math.sin(REST_ARM) + 0.12;
  const body = polygonize(field, [-reach, -0.03, -0.45], [reach, S.H + 0.04, 0.5], (S.H > 3.3 ? 0.016 : 0.015) * q);
  const nv = body.pos.length / 3, lab = new Float32Array(nv);
  for (let i = 0; i < nv; i++) {
    const c = comps(body.pos[i * 3], body.pos[i * 3 + 1], body.pos[i * 3 + 2]);
    let best = 0; for (let k = 1; k < 5; k++) if (c[k] < c[best]) best = k;
    lab[i] = best;
  }
  const J = joints(S);
  const { si, sw } = skinWeights(S, J, body.pos, lab);
  const hair = S.name === 'Girl'
    ? polygonize(HAIR.Girl, [-0.5, 2.3, -0.5], [0.5, S.H + 0.12, 0.42], 0.0125 * q)
    : polygonize(HAIR.Boy, [-0.42, S.chin + 0.02, -0.42], [0.42, S.H + 0.12, 0.36], 0.0125 * q);
  return {
    name, J, eyes,
    body: { pos: body.pos, nrm: body.nrm, index: Uint32Array.from(body.index), lab, si, sw },
    hair: { pos: hair.pos, nrm: hair.nrm, index: Uint32Array.from(hair.index) },
  };
}
