// The two children, as reusable parts for the imps (js/game/imps.js).
// Each body is a signed-distance model with child proportions, polygonised with surface nets, skinned to a
// small skeleton and animated with a procedural walk. Geometry is shared per child; every instance has its
// own skeleton and materials (lighting probe, glowing eyes, burn-away dissolve). The navigation grid is
// built from the same floors and colliders the player walks on.
import * as THREE from 'three';
import * as L from './layout.js';
import { roomAt } from './house.js';
import { REST_ARM, GIRL, BOY, BONES, PARENT, armFrame, buildKidGeometry } from './kidgeom.js';
export { GIRL, BOY, REST_ARM };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------- shaders ----
const lin = hex => { const c = new THREE.Color(hex); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; };
const f = v => v.toFixed(4);
const GLSL_LIB = `
float kBump = 0.0;   // height for strand/fabric bump, set by kidAlbedo
float kGlowMask = 0.0;   // where the eyes glow (irises), set by the eye kidAlbedo
vec3 kPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 vSigmaX = normalize(dFdx(surf_pos)), vSigmaY = normalize(dFdy(surf_pos)), vN = surf_norm;
  vec3 R1 = cross(vSigmaY, vN), R2 = cross(vN, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDir;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}
float kh31(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float kvn(vec3 x){ vec3 i = floor(x), g = fract(x); g = g * g * (3.0 - 2.0 * g);
  return mix(mix(mix(kh31(i), kh31(i + vec3(1,0,0)), g.x), mix(kh31(i + vec3(0,1,0)), kh31(i + vec3(1,1,0)), g.x), g.y),
             mix(mix(kh31(i + vec3(0,0,1)), kh31(i + vec3(1,0,1)), g.x), mix(kh31(i + vec3(0,1,1)), kh31(i + vec3(1,1,1)), g.x), g.y), g.z); }
`;
function faceGLSL(S) {
  return `
vec3 facePaint(vec3 p, vec3 col) {
  if (p.z < 0.08 || p.y < ${f(S.chin - 0.03)}) return col;
  float ax = abs(p.x);
  float dc = length(vec2(ax - 0.112, p.y - ${f(S.eyeY - 0.088)}));
  col = mix(col, ${lin(S.blush)}, 0.34 * smoothstep(0.08, 0.0, dc));
  float bx = ax - ${f(S.eyeX)};
  float by = p.y - (${f(S.eyeY + S.browDY)} - 1.8 * bx * bx - 0.18 * bx);
  float brow = smoothstep(0.012, 0.005, abs(by)) * smoothstep(0.058, 0.04, abs(bx + 0.004));
  col = mix(col, ${lin(S.brow)}, 0.8 * brow);
  float mx = p.x / ${f(S.mouthW)};
  float yc = ${f(S.mouthY)} + ${f(S.smile)} * mx * mx;
  float lips = smoothstep(0.022, 0.011, abs(p.y - yc - 0.002)) * smoothstep(1.05, 0.72, abs(mx));
  col = mix(col, ${lin(S.lip)}, 0.55 * lips);
  float ln = smoothstep(0.0055, 0.0015, abs(p.y - yc)) * smoothstep(1.0, 0.8, abs(mx));
  col = mix(col, ${lin(S.lipLine)}, 0.9 * ln);
  // upper lash line along the top of the eye opening, and a soft lid crease above it
  float ex = bx / ${f(S.eyeR * 1.3)};
  if (abs(ex) < 1.05) {
    float top = ${f(S.eyeY)} + ${f(S.eyeR * 0.7)} * sqrt(max(0.0, 1.0 - ex * ex)) - 0.002 * ex;
    col = mix(col, vec3(0.05, 0.035, 0.03), smoothstep(0.009, 0.003, abs(p.y - top - 0.003)) * smoothstep(1.05, 0.7, abs(ex)) * 0.85);
    col *= 1.0 - 0.12 * smoothstep(0.02, 0.0, abs(p.y - top - 0.022)) * smoothstep(1.1, 0.6, abs(ex));
  }
  float dn = length(vec2(ax - 0.016, p.y - ${f(S.nose[1] - 0.024)}));
  col = mix(col, ${lin(S.lipLine)} * 0.7, 0.45 * smoothstep(0.009, 0.003, dn));
  return col;
}`;
}
function girlGLSL(S) {
  return faceGLSL(S) + `
uniform sampler2D uLeo;
float pyOf(float y) {
  if (y > 2.48) return mix(256.0, 221.0, (y - 2.48) / 0.32);
  if (y > 2.10) return mix(331.0, 256.0, (y - 2.10) / 0.38);
  if (y > 1.56) return mix(423.0, 331.0, (y - 1.56) / 0.54);
  return mix(458.0, 423.0, (y - 1.38) / 0.18);
}
vec3 kidAlbedo(vec3 p, float lab, inout float rough, inout float metal) {
  vec3 col = ${lin(S.skin)} * (0.965 + 0.07 * kvn(p * 40.0));
  rough = 0.55; metal = 0.0;
  float ax = abs(p.x);
  bool leo = false;
  if (lab < 0.5 && p.y < 2.9) {
    float s = clamp(ax / 0.105, 0.0, 1.0);
    float top = p.z > 0.02 ? 2.47 + 0.34 * s * s : 2.6 + 0.21 * s * s;
    if (ax < 0.105) leo = p.y < top;
    else if (ax < 0.255) leo = true;
    else leo = p.y < 2.47;
  }
  if (lab > 2.5 && p.y > 1.38) leo = true;
  if (leo) {
    float qx = lab > 2.5 ? sign(p.x) * max(ax, 0.075) : p.x;
    vec2 uv = vec2(clamp((244.0 + qx * 160.0 - 188.0) / 110.0, 0.08, 0.92), clamp((pyOf(p.y) - 216.0) / 250.0, 0.03, 0.99));
    col = texture2D(uLeo, vec2(uv.x, 1.0 - uv.y)).rgb;
    rough = 0.42;
    vec3 q = p * 70.0; vec3 cell = floor(q);
    if (kh31(cell) > 0.86) {
      vec3 o = cell + 0.5 + (vec3(kh31(cell + 3.1), kh31(cell + 7.7), kh31(cell + 1.9)) - 0.5) * 0.5;
      float sp = smoothstep(0.34, 0.2, length(q - o));
      col = mix(col, vec3(0.82, 0.82, 0.88), sp);
      rough = mix(rough, 0.12, sp); metal = mix(0.0, 0.85, sp);
    }
  } else if (lab < 0.5) col = facePaint(p, col);
  return col;
}`;
}
function boyGLSL(S) {
  const a = armFrame(S, 1);
  return faceGLSL(S) + `
vec3 kidAlbedo(vec3 p, float lab, inout float rough, inout float metal) {
  vec3 col = ${lin(S.skin)} * (0.965 + 0.07 * kvn(p * 40.0));
  rough = 0.55; metal = 0.0;
  int cloth = 0;
  vec2 g = vec2(0.0);
  if (lab < 0.5) {
    if (p.y < ${f(S.neckY + 0.05)} && p.y > 1.26) { cloth = 1; g = vec2(atan(p.x, p.z) * 0.27, p.y) / 0.118; }
    else if (p.y <= 1.26) cloth = 2;
  } else if (lab < 2.5) {
    float sd = lab < 1.5 ? 1.0 : -1.0;
    vec3 dir = vec3(sd * ${f(Math.sin(REST_ARM))}, ${f(-Math.cos(REST_ARM))}, 0.0);
    vec3 d = p - vec3(sd * ${f(S.shX)}, ${f(S.shY)}, 0.0);
    float s = dot(d, dir);
    if (s < ${f(S.arm.up + S.arm.fore - 0.02)}) {
      cloth = 1;
      vec3 pr = d - dir * s;
      g = vec2(atan(pr.z, dot(pr, vec3(${f(Math.cos(REST_ARM))} * sd, ${f(Math.sin(REST_ARM))}, 0.0))) * 0.075, s) / 0.118;
    }
  } else if (p.y > 1.26) { cloth = 1; g = vec2(atan(p.x, p.z) * 0.27, p.y) / 0.118; }
  else cloth = p.y > 0.2 ? 2 : 3;
  if (cloth == 1) {
    vec2 fl = abs(fract(g) - 0.5);
    float ln = smoothstep(0.462, 0.492, max(fl.x, fl.y));
    col = mix(${lin(S.shirt)}, ${lin(S.lines)}, 0.5 * ln);
    col *= 0.955 + 0.07 * kvn(p * 90.0);
    rough = 0.8;
    if (lab < 0.5 && p.z > 0.1 && p.y < ${f(S.neckY - 0.03)}) {
      col = mix(col, col * 0.84, smoothstep(0.005, 0.0, abs(abs(p.x) - 0.034)));
      for (int i = 0; i < 4; i++) {
        float d = length(vec2(p.x, p.y - (${f(S.neckY - 0.11)} - float(i) * 0.24)));
        col = mix(col, ${lin(S.button)}, smoothstep(0.02, 0.016, d));
        col = mix(col, ${lin(S.button)} * 0.65, smoothstep(0.004, 0.0, abs(d - 0.019)) * 0.6);
      }
    }
    if (p.y < 1.3 && lab < 0.5) col *= smoothstep(1.255, 1.3, p.y) * 0.25 + 0.75;
  } else if (cloth == 2) {
    col = ${lin(S.pants)} * (0.93 + 0.1 * kvn(vec3(p.x * 30.0, p.y * 6.0, p.z * 30.0)));
    if (p.y < 0.36) col *= 0.93 + 0.07 * sin(p.y * 140.0);
    rough = 0.85;
  } else if (cloth == 3) {
    bool yel = p.z > ${f(a.sh[2] + S.foot.z + S.foot.half * 0.45)} || (p.z < -0.04 && p.y < 0.13);
    col = (yel ? ${lin(S.sockYellow)} : ${lin(S.sock)}) * (0.9 + 0.15 * kvn(p * 120.0));
    rough = 0.95;
  } else if (lab < 0.5) col = facePaint(p, col);
  return col;
}`;
}
function hairGLSL(S) {
  const [d, m, l] = S.hair;
  const long = S.name === 'Girl';
  return `
vec3 kidAlbedo(vec3 p, float lab, inout float rough, inout float metal) {
  float a = atan(p.x, p.z + 0.05);
  float s = a * ${long ? '55.0' : '38.0'} + kvn(p * vec3(${long ? '5.0, 1.2, 5.0' : '7.0, 7.0, 7.0'})) * 9.0;
  float n = kvn(vec3(s, p.y * ${long ? '1.5' : '6.0'}, 0.5));
  float n2 = kvn(vec3(s * 3.1, p.y * ${long ? '4.0' : '14.0'}, 2.0));
  vec3 col = mix(mix(${lin(d)}, ${lin(m)}, 0.55), ${lin(m)}, smoothstep(0.1, 0.8, n));
  col = mix(col, ${lin(l)}, smoothstep(0.55, 0.95, n2) * 0.45);
  col = mix(col, ${lin(l)}, smoothstep(0.55, 0.9, kvn(p * 7.0)) * 0.25);
  col *= mix(0.8, 1.06, smoothstep(${f(S.H - 0.12)}, ${f(S.H - 0.7)}, p.y));
  // hair behind the neck and under the jaw sits in shadow
  float cav = (1.0 - smoothstep(0.1, 0.25, abs(p.x))) * smoothstep(-0.2, -0.06, p.z) * smoothstep(${f(S.chin + 0.06)}, ${f(S.chin - 0.06)}, p.y);
  col *= 1.0 - 0.7 * cav;
  rough = 0.4 + 0.22 * n2; metal = 0.0;
  kBump = n * 0.65 + n2 * 0.35;
  return col;
}`;
}
function eyeGLSL(S) {
  return `
vec3 kidAlbedo(vec3 p, float lab, inout float rough, inout float metal) {
  vec3 d = normalize(p);
  float c = d.z;
  vec3 col = vec3(0.8, 0.78, 0.74);
  float ang = atan(d.y, d.x);
  vec3 iris = ${lin(S.iris)} * (0.7 + 0.55 * kvn(vec3(ang * 9.0, c * 30.0, 1.0)));
  col = mix(col, iris, smoothstep(0.835, 0.85, c));
  col = mix(col, ${lin(S.iris)} * 0.3, smoothstep(0.018, 0.0, abs(c - 0.843)) * 0.8);
  col = mix(col, vec3(0.012), smoothstep(0.962, 0.968, c));
  col *= mix(1.0, 0.45, smoothstep(0.05, 0.5, d.y));          // shadow of the upper lid
  kGlowMask = smoothstep(0.82, 0.86, c);
  rough = 0.06; metal = 0.0;
  return col;
}`;
}

// Standard material whose albedo comes from kidAlbedo() and whose diffuse light comes from an SH probe.
// shared: { sh: Vector3[9], irr: {value}, dissolve: {value}, glow: {value: Color} } — per instance.
function kidMaterial(key, glsl, shared, extra = {}, bump = 0) {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0 });
  const mapsChunk = THREE.ShaderChunk.lights_fragment_maps.replace('iblIrradiance += getIBLIrradiance( geometryNormal );', '');
  m.onBeforeCompile = sh => {
    sh.uniforms.uSH = { value: shared.sh };
    sh.uniforms.uIrr = shared.irr;
    sh.uniforms.uDissolve = shared.dissolve;
    sh.uniforms.uGlowCol = shared.glow;
    for (const [k, v] of Object.entries(extra)) sh.uniforms[k] = v;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float lab;\nvarying vec3 vRest;\nvarying float vLab;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRest = position;\nvLab = lab;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRest;\nvarying float vLab;\nuniform vec3 uSH[9];\nuniform float uIrr;\nuniform float uDissolve;\nuniform vec3 uGlowCol;\n' + GLSL_LIB + glsl)
      .replace('#include <map_fragment>', `#include <map_fragment>
float kRough = roughness, kMetal = metalness;
diffuseColor.rgb = kidAlbedo(vRest, vLab, kRough, kMetal);
// burning away: the noise threshold rises with uDissolve, the edge glows like embers and chars what is left
float kDis = kvn(vRest * 7.0) * 0.65 + kvn(vRest * 19.0) * 0.35;
if (uDissolve > 0.0 && kDis < uDissolve) discard;
float kEdge = uDissolve > 0.0 ? smoothstep(uDissolve + 0.07, uDissolve, kDis) : 0.0;
diffuseColor.rgb *= 1.0 - (uDissolve > 0.0 ? 0.85 * smoothstep(uDissolve + 0.25, uDissolve, kDis) : 0.0);`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = kRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = kMetal;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uGlowCol * kGlowMask + vec3(7.0, 2.0, 0.35) * kEdge;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' +
        (bump ? `normal = kPerturb(-vViewPosition, normal, vec2(dFdx(kBump), dFdy(kBump)) * ${bump.toFixed(4)}, faceDirection);` : ''))
      .replace('#include <lights_fragment_maps>', mapsChunk +
        '\nirradiance += max(shGetIrradianceAt(transformNormalByInverseViewMatrix(geometryNormal, viewMatrix), uSH), vec3(0.0)) * uIrr;');
  };
  m.customProgramCacheKey = () => 'kid-' + key;
  return m;
}

function geometryFrom(mesh, lab) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(mesh.nrm, 3));
  g.setAttribute('lab', new THREE.BufferAttribute(lab || new Float32Array(mesh.pos.length / 3), 1));
  g.setIndex(new THREE.BufferAttribute(mesh.index, 1));
  return g;
}

// Start building both children's geometry in workers (call early; the imps await it).
// q: polygonisation step multiplier (1 = walkthrough detail).
export function prebuildKids(q = 1) {
  const one = name => new Promise(resolve => {
    try {
      const w = new Worker(new URL('./kidworker.js', import.meta.url), { type: 'module' });
      w.onmessage = e => { resolve(e.data); w.terminate(); };
      w.onerror = () => { w.terminate(); resolve(buildKidGeometry(name, q)); };
      w.postMessage({ name, q });
    } catch (e) { resolve(buildKidGeometry(name, q)); }
  });
  const t0 = performance.now();
  return Promise.all([one('Girl'), one('Boy')]).then(([a, b]) => ({ Girl: a, Boy: b, ms: performance.now() - t0 }));
}

let blobTex = null;
function blobTexture() {
  if (blobTex) return blobTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.62)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}

// Geometry shared by every instance of one child (GPU buffers are uploaded once).
export function kidAssets(S, G, leoTex) {
  const body = G.body, hair = G.hair;
  const bodyGeo = geometryFrom(body, body.lab);
  bodyGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(body.si, 4));
  bodyGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(body.sw, 4));
  // long hair is skinned to the head above the jaw and to the chest below it, so it drapes on the shoulders
  const hairGeo = geometryFrom(hair), hn = hair.pos.length / 3;
  const hsi = new Uint16Array(hn * 4), hsw = new Float32Array(hn * 4);
  const iHead = BONES.indexOf('head'), iChest = BONES.indexOf('chest');
  for (let v = 0; v < hn; v++) {
    const t = clamp((hair.pos[v * 3 + 1] - (S.chin - 0.28)) / 0.36, 0, 1), w = t * t * (3 - 2 * t);
    hsi[v * 4] = iHead; hsw[v * 4] = w; hsi[v * 4 + 1] = iChest; hsw[v * 4 + 1] = 1 - w;
  }
  hairGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(hsi, 4));
  hairGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(hsw, 4));
  const eyeGeo = new THREE.SphereGeometry(S.eyeR, 20, 14);
  eyeGeo.setAttribute('lab', new THREE.BufferAttribute(new Float32Array(eyeGeo.attributes.position.count), 1));
  return { S, J: G.J, eyes: G.eyes, bodyGeo, hairGeo, eyeGeo, leoTex, stats: { tris: body.index.length / 3, hairTris: hair.index.length / 3 } };
}

// ============================================================== the kid ====
export class Kid {
  constructor(A, scale = 1) {
    const S = A.S;
    this.S = S;
    this.name = S.name;
    this.scale = scale;
    this.radius = S.radius * scale;
    this.height = S.H * scale;
    this.shared = {
      sh: Array.from({ length: 9 }, () => new THREE.Vector3()), irr: KIDS_IRR,
      dissolve: { value: 0 }, glow: { value: new THREE.Color(0, 0, 0) },
    };
    this.targetSH = null;
    const J = A.J;
    const extra = A.leoTex ? { uLeo: { value: A.leoTex } } : {};
    this.bodyMat = kidMaterial(S.name + '-body', S.name === 'Girl' ? girlGLSL(S) : boyGLSL(S), this.shared, extra);
    this.mesh = new THREE.SkinnedMesh(A.bodyGeo, this.bodyMat);
    // --- skeleton
    this.bones = {};
    for (const b of BONES) { const bone = new THREE.Bone(); bone.name = b; this.bones[b] = bone; }
    for (const b of BONES) {
      const j = J[b][0], p = PARENT[b] ? J[PARENT[b]][0] : [0, 0, 0];
      this.bones[b].position.set(j[0] - p[0], j[1] - p[1], j[2] - p[2]);
      if (PARENT[b]) this.bones[PARENT[b]].add(this.bones[b]);
    }
    this.mesh.add(this.bones.hips);
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(BONES.map(b => this.bones[b])));
    this.rest = Object.fromEntries(BONES.map(b => [b, this.bones[b].position.clone()]));
    // generous fixed bounds (any pose, lying down included) so the skinned meshes can be frustum culled
    const bounds = new THREE.Sphere(new THREE.Vector3(0, S.H * 0.45, 0), S.H * 0.85);
    this.mesh.boundingSphere = bounds;
    // --- hair (skinned to head + chest)
    const hj = J.head[0];
    this.hairMat = kidMaterial(S.name + '-hair', hairGLSL(S), this.shared, {}, 1.6);
    this.hair = new THREE.SkinnedMesh(A.hairGeo, this.hairMat);
    this.hair.boundingSphere = bounds;
    this.mesh.add(this.hair);
    this.hair.bind(this.mesh.skeleton, this.mesh.bindMatrix);
    // --- eyes
    this.eyeMat = kidMaterial(S.name + '-eye', eyeGLSL(S), this.shared);
    this.eyes = A.eyes.map(e => {
      const m = new THREE.Mesh(A.eyeGeo, this.eyeMat);
      m.position.set(e[0] - hj[0], e[1] - hj[1], e[2] - hj[2]);
      this.bones.head.add(m);
      return m;
    });
    // --- contact shadow
    this.blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, color: 0x000000, polygonOffset: true, polygonOffsetFactor: -2 }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.scale.set(S.H * 0.42 * scale, S.H * 0.34 * scale, 1);
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.scale.setScalar(scale);
    this.materials = [this.bodyMat, this.hairMat, this.eyeMat];
    // --- state
    this.x = 0; this.z = 0; this.feet = 0; this.heading = 0;
    this.phase = 0; this.walkW = 0; this.speedNow = 0; this.run = 0;
    this.look = { yaw: 0, pitch: 0 };
    this.blinkT = 2 + Math.random() * 3; this.blink = 0;
    this.idleLook = 0; this.idleLookT = 0;
    this.room = null;
  }

  place(x, z, feet, heading = 0) { this.x = x; this.z = z; this.feet = feet; this.heading = heading; }

  // Walk / run cycle, idle breathing, head tracking. focus ({x, y, z}) is what the head turns to (or null);
  // idle lets the head glance around. run (0..1) leans the body forward and pumps the arms.
  animate(dt, t, focus, idle = true) {
    const S = this.S, B = this.bones, R = this.rest;
    const w = this.walkW, run = this.run;
    const legLen = S.hip[1] - S.ankle[1];
    const A = Math.asin(clamp(S.step / (2 * legLen), 0, 0.6)) * (1.1 + 0.45 * run) * w;
    const ph = this.phase;
    const e = (b, x, y, z, order = 'XYZ') => B[b].rotation.set(x, y, z, order);
    // legs
    for (const [side, off] of [['L', 0], ['R', Math.PI]]) {
      const p = ph + off, sn = Math.sin(p);
      const thigh = -A * sn - run * w * 0.12;
      const knee = w * (0.07 + (S.kneeAmp + 0.5 * run) * Math.pow(Math.max(0, Math.cos(p + 0.35)), 1.4)) + (1 - w) * 0.03;
      const toe = w * 0.4 * Math.pow(Math.max(0, -Math.sin(p - 0.25)), 3);
      const sgn = side === 'L' ? 1 : -1;
      e('thigh' + side, thigh, 0, sgn * S.splay);
      e('shin' + side, knee, 0, 0);
      e('foot' + side, -(thigh + knee) + toe - w * 0.1 * Math.pow(Math.max(0, sn), 4), 0, -sgn * S.splay);
    }
    // pelvis & spine
    const sn = Math.sin(ph), cs = Math.cos(ph);
    const breathe = Math.sin(t * 1.7) * 0.012;
    const idleSway = (1 - w) * Math.sin(t * 0.37 + (S.H > 3.3 ? 0 : 1.3)) * 0.018;
    B.hips.position.set(R.hips.x - w * S.sway * cs + idleSway, R.hips.y - w * S.bob * (1 + run) * (1 - Math.cos(2 * ph)) / 2, R.hips.z);
    e('hips', run * w * 0.1, -w * S.hipYaw * sn, w * 0.03 * cs + (1 - w) * idleSway * 0.6, 'YXZ');
    e('spine', w * 0.045 + run * w * 0.14, 0, 0);
    e('chest', breathe - w * 0.02 + run * w * 0.06, w * S.hipYaw * 1.6 * sn, -w * 0.02 * cs, 'YXZ');
    // arms: lowered from the rest A-pose, swinging against the legs (bent and pumping when running)
    const armDown = REST_ARM - S.armRest;
    const swing = S.armSwing * (1 + 1.6 * run);
    e('upL', w * swing * sn + 0.04, 0, -armDown + (1 - w) * 0.03 * Math.sin(t * 0.9));
    e('upR', -w * swing * sn + 0.04, 0, armDown - (1 - w) * 0.03 * Math.sin(t * 0.9 + 1));
    e('foreL', -(S.elbow + run * 0.9 + w * 0.22 * Math.max(0, -sn)), 0, 0);
    e('foreR', -(S.elbow + run * 0.9 + w * 0.22 * Math.max(0, sn)), 0, 0);
    e('handL', 0, 0, 0.1); e('handR', 0, 0, -0.1);
    // head: look at the focus point when in view, otherwise glance around
    let ty = 0, tp = 0.05;
    const cosH = Math.cos(this.heading), sinH = Math.sin(this.heading);
    if (focus) {
      const dx = focus.x - this.x, dz = focus.z - this.z, dist = Math.hypot(dx, dz);
      const lx = dx * cosH - dz * sinH, lz = dx * sinH + dz * cosH;
      const yaw = Math.atan2(lx, lz);
      if (Math.abs(yaw) < 1.9) {
        ty = clamp(yaw, -S.lookYaw, S.lookYaw);
        tp = -clamp(Math.atan2(focus.y - (this.feet + S.eyeY * this.scale), Math.max(dist, 0.5)), -0.3, 0.55);
      }
    } else if (idle) {
      this.idleLookT -= dt;
      if (this.idleLookT <= 0) { this.idleLook = (Math.random() * 2 - 1) * 0.7; this.idleLookT = 1.5 + Math.random() * 3; }
      ty = this.idleLook;
    }
    const k = Math.min(1, dt * 4);
    this.look.yaw += (ty - this.look.yaw) * k; this.look.pitch += (tp - this.look.pitch) * k;
    e('neck', this.look.pitch * 0.35, this.look.yaw * 0.35 - w * S.hipYaw * 0.8 * sn, 0, 'YXZ');
    e('head', this.look.pitch * 0.65 + w * 0.02 * Math.cos(2 * ph), this.look.yaw * 0.6, 0, 'YXZ');
    // eyes lead the head a little; blink now and then
    this.blinkT -= dt;
    if (this.blinkT <= 0) { this.blink = 0.14; this.blinkT = 2.2 + Math.random() * 4; }
    this.blink = Math.max(0, this.blink - dt);
    const lidScale = this.blink > 0 ? 0.12 : 1;
    const eyYaw = clamp((ty - this.look.yaw * 0.95) * 0.8, -0.4, 0.4), eyPitch = clamp((tp - this.look.pitch) * 0.8, -0.3, 0.3);
    for (const m of this.eyes) { m.rotation.set(eyPitch, eyYaw, 0, 'YXZ'); m.scale.set(1, lidScale, 1); }
    this.place3d();
  }
  place3d() {
    this.group.position.set(this.x, this.feet, this.z);
    this.group.rotation.y = this.heading;
    this.blob.position.set(this.x, this.feet + 0.015, this.z);
  }
}

// Shared irradiance scale for the kids (uniform object so it can be tuned live).
const KIDS_IRR = { value: 1.0 };

// ======================================================== navigation ====
const G = 0.5, NX0 = -1, NZ0 = -14.5, NNX = 96, NNZ = 104;
export class NavGrid {
  // R: clearance around walls; TOP: body height checked against colliders
  constructor(boxes, doors, floorAt, { R = 0.58, TOP = 3.55 } = {}) {
    this.floorAt = floorAt;
    this.R = R; this.TOP = TOP;
    this.doorsOpenable = false;     // plan through shut (unlocked) doors: the imps open them on the way
    // spatial hash of collider boxes
    const HS = 2, hash = new Map();
    const hk = (i, j) => i * 1000 + j;
    for (const b of boxes) {
      for (let i = Math.floor((b.x0 - this.R) / HS); i <= Math.floor((b.x1 + this.R) / HS); i++)
        for (let j = Math.floor((b.z0 - this.R) / HS); j <= Math.floor((b.z1 + this.R) / HS); j++) {
          const k = hk(i, j); if (!hash.has(k)) hash.set(k, []); hash.get(k).push(b);
        }
    }
    const near = (x, z) => hash.get(hk(Math.floor(x / HS), Math.floor(z / HS))) || [];
    const blocked = (x, z, h) => {
      const b0 = h + 0.8, b1 = h + this.TOP, R2 = this.R * this.R;   // steps and landing edges are not walls
      for (const c of near(x, z)) {
        if (c.y1 <= b0 || c.y0 >= b1) continue;
        const cx = clamp(x, c.x0, c.x1), cz = clamp(z, c.z0, c.z1);
        if ((x - cx) ** 2 + (z - cz) ** 2 < R2) return true;
      }
      return false;
    };
    // nodes: one per walkable surface per cell
    this.nx = []; this.nz = []; this.nh = []; this.nroom = []; this.ncell = [];
    this.cells = new Array(NNX * NNZ);
    for (let j = 0; j < NNZ; j++) for (let i = 0; i < NNX; i++) {
      const x = NX0 + (i + 0.5) * G, z = NZ0 + (j + 0.5) * G;
      const hs = [0];
      for (const fl of L.FLOORS) { const [x0, x1, z0, z1] = fl.r; if (x >= x0 && x <= x1 && z >= z0 && z <= z1) hs.push(fl.h); }
      for (const fl of L.FLIGHTS) { const [x0, x1, z0, z1] = fl.r; if (x >= x0 && x <= x1 && z >= z0 && z <= z1) hs.push(fl.h0 + (fl.h1 - fl.h0) * (z - z0) / (z1 - z0)); }
      const uniq = [...new Set(hs.map(h => Math.round(h * 1000) / 1000))].sort((a, b) => a - b);
      for (const h of uniq) {
        if (uniq.some(s => s > h + 0.05 && s < h + 8.5)) continue;            // under a flight or landing
        const r = roomAt(x, z, h + 1);
        if (!r) continue;
        if (blocked(x, z, h)) continue;
        const id = this.nh.length;
        this.nx.push(x); this.nz.push(z); this.nh.push(h); this.nroom.push(r.id); this.ncell.push(i + j * NNX);
        (this.cells[i + j * NNX] ||= []).push(id);
      }
    }
    const N = this.nh.length;
    // adjacency (8-connected, height steps below 0.75 ft, no corner cutting)
    this.adj = new Array(N);
    const nodeAt = (i, j, h) => {
      if (i < 0 || j < 0 || i >= NNX || j >= NNZ) return -1;
      const list = this.cells[i + j * NNX]; if (!list) return -1;
      let best = -1, bd = 0.75;
      for (const m of list) { const d = Math.abs(this.nh[m] - h); if (d < bd) { bd = d; best = m; } }
      return best;
    };
    this.nodeAt = nodeAt;
    for (let n = 0; n < N; n++) {
      const i = this.ncell[n] % NNX, j = Math.floor(this.ncell[n] / NNX), h = this.nh[n];
      const out = [];
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const m = nodeAt(i + di, j + dj, h);
        if (m < 0) continue;
        if (di && dj && (nodeAt(i + di, j, h) < 0 || nodeAt(i, j + dj, h) < 0)) continue;
        out.push(m);
      }
      this.adj[n] = out;
    }
    // doors: doorway cells block when the door is shut, the swept leaf blocks when it is open
    this.tags = new Map();
    const tag = (n, d, mode) => { if (!this.tags.has(n)) this.tags.set(n, []); this.tags.get(n).push([d, mode]); };
    for (const d of doors) {
      const openA = d.thC + d.dlt, ox = Math.cos(openA), oz = -Math.sin(openA);
      for (let n = 0; n < N; n++) {
        if (Math.abs(this.nh[n] - d.base) > 1.2) continue;
        const x = this.nx[n], z = this.nz[n];
        const along = d.axis === 'x' ? x : z, across = d.axis === 'x' ? z - d.c : x - d.c;
        if (along > d.a0 - 0.1 && along < d.a1 + 0.1 && Math.abs(across) < 0.25 + this.R) tag(n, d, 'shut');
        if (d.slide) continue;
        const u = clamp((x - d.hx) * ox + (z - d.hz) * oz, 0, d.w);
        if (Math.hypot(x - d.hx - ox * u, z - d.hz - oz * u) < this.R + 0.12) tag(n, d, 'open');
      }
    }
    this.extraBlocked = new Set();
    // destination candidates per room (nodes with all 8 neighbours = away from walls and furniture)
    this.byRoom = new Map();
    for (let n = 0; n < N; n++) {
      if (this.adj[n].length < 8) continue;
      const r = this.nroom[n];
      if (!this.byRoom.has(r)) this.byRoom.set(r, []);
      this.byRoom.get(r).push(n);
    }
    // A* scratch, reused between searches (generation stamps instead of clearing)
    this.gs = new Float32Array(N); this.from = new Int32Array(N);
    this.stamp = new Uint32Array(N); this.closedAt = new Uint32Array(N);
    this.gen = 0;
  }
  // the shut door a node waits on, if any (imps open doors on their way)
  shutDoorAt(n) {
    const t = this.tags.get(n);
    if (!t) return null;
    for (const [d, mode] of t) if (mode === 'shut' && d.t < 0.85) return d;
    return null;
  }
  isBlocked(n) {
    if (this.extraBlocked.has(n)) return true;
    const t = this.tags.get(n);
    if (!t) return false;
    for (const [d, mode] of t) {
      if (mode === 'shut' && d.t < 0.85 && !(this.doorsOpenable && !d.locked)) return true;
      if (mode === 'open' && d.t > 0.15) return true;
    }
    return false;
  }
  nearest(x, z, feet) {
    const i = Math.floor((x - NX0) / G), j = Math.floor((z - NZ0) / G);
    for (let r = 0; r < 6; r++) {
      let best = -1, bd = Infinity;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const m = this.nodeAt(i + di, j + dj, feet);
        if (m < 0 || this.isBlocked(m)) continue;
        const d = Math.hypot(this.nx[m] - x, this.nz[m] - z);
        if (d < bd) { bd = d; best = m; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }
  // the walkable node under a point (no search), or -1
  at(x, z, feet) { return this.nodeAt(Math.floor((x - NX0) / G), Math.floor((z - NZ0) / G), feet); }
  // A* over the grid; gives up (null) after maxNodes expansions
  path(a, b, maxNodes = 12000) {
    if (a < 0 || b < 0 || this.isBlocked(b)) return null;
    const gen = ++this.gen, gs = this.gs, from = this.from, stamp = this.stamp, closedAt = this.closedAt;
    const heap = [];
    const push = (n, f) => { heap.push([f, n]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    const g = n => (stamp[n] === gen ? gs[n] : Infinity);
    const hx = this.nx[b], hz = this.nz[b], hh = this.nh[b];
    const heur = n => Math.hypot(this.nx[n] - hx, this.nz[n] - hz) + Math.abs(this.nh[n] - hh);
    stamp[a] = gen; gs[a] = 0; from[a] = -1; push(a, heur(a));
    let found = a === b, expanded = 0;
    while (heap.length) {
      const [, n] = pop();
      if (closedAt[n] === gen) continue;
      if (n === b) { found = true; break; }
      closedAt[n] = gen;
      if (++expanded > maxNodes) return null;
      for (const m of this.adj[n]) {
        if (closedAt[m] === gen || this.isBlocked(m)) continue;
        const ng = gs[n] + Math.hypot(this.nx[m] - this.nx[n], this.nz[m] - this.nz[n], (this.nh[m] - this.nh[n]) * 1.5)
          + (this.adj[m].length < 8 ? 0.35 : 0);                                  // keep off walls where there is room
        if (ng < g(m)) { stamp[m] = gen; gs[m] = ng; from[m] = n; push(m, ng + heur(m)); }
      }
    }
    if (!found) return null;
    const out = [b];
    while (out[out.length - 1] !== a) out.push(from[out[out.length - 1]]);
    return this.smooth(out.reverse());
  }
  // can a body walk straight from node a to node b? (a shut door on the way needs its own stop)
  clear(a, b) {
    const x0 = this.nx[a], z0 = this.nz[a], x1 = this.nx[b], z1 = this.nz[b];
    const len = Math.hypot(x1 - x0, z1 - z0), steps = Math.ceil(len / 0.2);
    let h = this.nh[a];
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      const m = this.nodeAt(Math.floor((x - NX0) / G), Math.floor((z - NZ0) / G), h);
      if (m < 0 || this.isBlocked(m) || this.adj[m].length < 6 || this.shutDoorAt(m)) return false;
      h = this.nh[m];
    }
    return Math.abs(h - this.nh[b]) < 0.75;          // must arrive on b's floor, not the one below or above it
  }
  smooth(p) {
    const out = [p[0]];
    let i = 0;
    while (i < p.length - 1) {
      let j = Math.min(p.length - 1, i + 40);
      while (j > i + 1 && !this.clear(p[i], p[j])) j--;
      out.push(p[j]); i = j;
    }
    return out;
  }
}
