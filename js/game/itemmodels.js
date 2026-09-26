// Pickup models for the DOOM mode: ammo, health, armour, powerups and keycards (weapon pickups are in viewmodel.js).
// Each type is modelled once from primitives in world feet (origin at the floor contact, centred on x/z), merged per
// layer and shared by every copy:
//   lit    one mesh: colour, metalness, roughness, a surface pattern (fabric, wood, cardboard, worn paint, armour
//          sheen, flowing energy …) and glow are per-vertex attributes read by a patched MeshStandardMaterial;
//   glass  the potion flask (reflections at full strength over an almost clear body);
//   orb    soulsphere / megasphere: one camera-facing quad that ray-traces a glowing, swirling ball and its corona;
//   fx     contact shadow, floor glow and halo quads in one premultiplied-alpha mesh (shadows darken, glows add).
// Materials are per copy, so every item takes its own room's IBL and animates its own glow: 1–3 draw calls an item.
// Glows follow the renderer's exposure part of the way (ITEM_TUNING), so they read in dark rooms without blowing out.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const ITEM_TYPES = ['clip', 'ammo', 'shell', 'shellbox', 'rocket', 'rocketbox', 'cell', 'cellpack', 'backpack',
  'stimpack', 'medikit', 'hbonus', 'abonus', 'greenarmor', 'bluearmor', 'soulsphere', 'megasphere', 'berserk',
  'keyBlue', 'keyYellow', 'keyRed'];

// ------------------------------------------------------------- tuning ----
// Read live. glow: emissive accents; fx: halos and floor glow; sphere: soulsphere / megasphere; shadow: contact shadow
// darkness. Glows scale by (v / ref)^adapt, clamped to [min, max], where v is the scene luminance that reads as mid
// grey (setItemAmbient, the value fx.setAmbient takes; without it v = 0.15 / the renderer's exposure): brighter in a
// dark room than in a sunlit one, but only part of the way (adapt 0 = physical, 1 = constant on screen like fullbright).
export const ITEM_TUNING = { glow: 1, fx: 1, sphere: 1, shadow: 0.6, ref: 0.15, adapt: 0.6, min: 0.3, max: 2.5 };
const HOVER = 1.5;      // soulsphere / megasphere: gap between the floor and the bottom of the ball
const ORB_R = 0.65;     // ball radius
const ORB_HALO = 2.0;   // corona quad half size, in ball radii
const TIC = 1 / 35;
const WRAP = 1200;      // shader clocks wrap (float precision in long sessions)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// Doom's A-B-C-D-C-B bonus cycles (6 tics a frame) as a triangle wave 0..1..0 over `tics`
const cyc = (t, tics) => { const x = ((t / (tics * TIC)) % 1 + 1) % 1; return 1 - Math.abs(x * 2 - 1); };

// ------------------------------------------------------------ shaders ----
// Exposure-adapted gains shared by every item material; refreshed from the renderer just before an item draws.
const K = { glow: { value: 1 }, fx: { value: 1 }, orb: { value: 1 }, shadow: { value: 0.6 } };
let ambient = 0;
function adapt(renderer) {
  const T = ITEM_TUNING, v = ambient > 0 ? ambient : 0.15 / Math.max(renderer.toneMappingExposure || 1, 1e-3);
  const a = clamp(Math.pow(v / T.ref, T.adapt), T.min, T.max);
  K.glow.value = T.glow * a; K.fx.value = T.fx * a; K.orb.value = T.sphere * a; K.shadow.value = T.shadow;
}

const NOISE = `
float itHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float itNoise(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(itHash(i), itHash(i + vec3(1, 0, 0)), f.x), mix(itHash(i + vec3(0, 1, 0)), itHash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(itHash(i + vec3(0, 0, 1)), itHash(i + vec3(1, 0, 1)), f.x), mix(itHash(i + vec3(0, 1, 1)), itHash(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
`;
// Surface patterns (per-vertex pbr.z). Detail is in object feet and fades out once a pixel covers it.
const PAT = { plain: 0, fabric: 1, woodX: 2, woodZ: 3, card: 4, worn: 5, armour: 6, blink: 7, hazard: 8, flow: 9, charge: 10, pebble: 11 };
const LIT_HEAD = `
varying vec4 vPbr;
varying vec3 vObj;
uniform float uGlow, uBlink, uSheen, uSheenK, uTime, uGlowK;
${NOISE}
vec3 itBump(vec3 pos, vec3 n, float h) {
  vec3 dx = dFdx(pos), dy = dFdy(pos);
  float hx = dFdx(h), hy = dFdy(h);
  vec3 r1 = cross(dy, n), r2 = cross(n, dx);
  float det = dot(dx, r1);
  if (abs(det) < 1e-14) return n;
  return normalize(abs(det) * n - sign(det) * (hx * r1 + hy * r2));
}
`;
const LIT_PATTERN = `
float itK = floor(vPbr.z + 0.5);
vec3 itP = vObj;
float itFw = max(length(fwidth(itP)), 1e-5);
float itN = itNoise(itP * 23.0) * 0.6 + itNoise(itP * 67.0) * 0.4;
float itRough = vPbr.y * (0.88 + 0.24 * itN);
float itMetal = vPbr.x;
float itE = vPbr.w, itCh = uGlow, itSh = 0.0, itH = 0.0;
if (itK == 1.0) {                      // woven fabric: mottled, fine weave that fades with distance
  float lod = clamp(2.0 - itFw * 180.0, 0.0, 1.0);
  vec3 q = itP * 420.0;
  float wv = sin(q.x + q.z) * sin(q.y + 0.5 * (q.x - q.z));
  diffuseColor.rgb *= (0.8 + 0.34 * itNoise(itP * 7.0)) * (1.0 + 0.12 * wv * lod);
  itH = wv * 0.0005 * lod + (itNoise(itP * 28.0) - 0.5) * 0.002;
  itRough = min(1.0, vPbr.y * (0.95 + 0.1 * itN));
} else if (itK == 2.0 || itK == 3.0) {  // wood, grain along x (2) or z (3)
  vec3 w = itK == 2.0 ? itP : itP.zyx;
  float g = sin((w.y * 0.8 + w.z) * 64.0 + itNoise(w * vec3(1.2, 11.0, 11.0)) * 9.0 + itNoise(w * vec3(0.4, 3.0, 3.0)) * 14.0);
  float grain = smoothstep(0.25, 1.0, g) * clamp(2.0 - itFw * 60.0, 0.0, 1.0);
  diffuseColor.rgb *= (0.76 + 0.42 * itNoise(w * vec3(0.5, 4.0, 4.0))) * (1.0 - 0.3 * grain);
  itRough = vPbr.y * (0.9 + 0.2 * grain);
  itH = -grain * 0.001;
} else if (itK == 4.0) {                // cardboard and paper
  diffuseColor.rgb *= 0.9 + 0.16 * itNoise(itP * 45.0) + 0.06 * itNoise(itP * 160.0);
  itRough = 0.88;
  itH = (itNoise(itP * 90.0) - 0.5) * 0.0007;
} else if (itK == 5.0) {                // worn paint: chips and grime
  float s = itNoise(itP * 16.0) * 0.55 + itNoise(itP * 70.0) * 0.45;
  float chip = smoothstep(0.75, 0.79, s);
  diffuseColor.rgb *= 0.8 + 0.32 * itNoise(itP * 4.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.16, 0.17), chip);
  itMetal = mix(itMetal, 0.9, chip); itRough = mix(itRough, 0.42, chip);
  itH = -chip * 0.0012;
} else if (itK == 6.0) {                // armour plate: hammered finish, a sheen sweeping across
  itH = (itNoise(itP * 24.0) - 0.5) * 0.0012;
  float d = dot(itP, vec3(0.6, 1.0, 0.2)) - uSheen;
  itSh = exp(-d * d * 600.0) * uSheenK;
} else if (itK == 7.0) {                // glow on the blink channel (keycards)
  itCh = uBlink;
} else if (itK == 8.0) {                // hazard stripes
  diffuseColor.rgb *= mix(1.0, 0.05, step(0.5, fract((itP.x + itP.y + itP.z) * 5.5)));
} else if (itK == 9.0) {                // energy flowing upward
  itCh = uGlow * (0.5 + 0.5 * pow(0.5 + 0.5 * sin(itP.y * 46.0 - uTime * 7.0), 2.0));
} else if (itK == 10.0) {               // charge bars filling along x
  itCh = uGlow * mix(0.2, 1.0, step(itP.x * 1.45 + 0.5, fract(uTime * 0.4) * 1.3));
} else if (itK == 11.0) {               // pebbled rubber / leather
  float pb = itNoise(itP * 110.0);
  itH = (pb - 0.5) * 0.001;
  itRough = min(1.0, vPbr.y * (0.9 + 0.2 * pb));
}
vec3 itEmit = (diffuseColor.rgb * itE * itCh + mix(diffuseColor.rgb, vec3(1.0), 0.3) * itSh) * uGlowK;
`;
function litMaterial() {
  const u = { uGlow: { value: 1 }, uBlink: { value: 1 }, uSheen: { value: -9 }, uSheenK: { value: 0 }, uTime: { value: 0 }, uGlowK: K.glow };
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, envMapIntensity: 1 });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'attribute vec4 pbr;\nvarying vec4 vPbr;\nvarying vec3 vObj;\n' + sh.vertexShader
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vPbr = pbr; vObj = position;');
    sh.fragmentShader = LIT_HEAD + sh.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + LIT_PATTERN)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(itRough, 0.04, 1.0);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = clamp(itMetal, 0.0, 1.0);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n  normal = itBump(-vViewPosition, normal, itH);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += itEmit;');
  };
  m.customProgramCacheKey = () => 'itemlit1';
  m.userData.u = u;
  return m;
}
// Glass: the body tints what is behind it a little, reflections stay at full strength (premultiplied blending).
function glassMaterial() {
  const m = new THREE.MeshStandardMaterial({ color: 0xd6ecff, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.14,
    depthWrite: false, envMapIntensity: 1 });
  m.blending = THREE.CustomBlending;
  m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
      float glF = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 3.0);
      gl_FragColor = vec4(totalDiffuse * diffuseColor.a + totalSpecular * (1.0 + 1.5 * glF), min(1.0, diffuseColor.a + 0.3 * glF));`);
  };
  m.customProgramCacheKey = () => 'itemglass1';
  return m;
}
// fx quads. aFx: x kind (0 contact shadow, 1 floor glow, 2 halo), y channel (0 steady, 1 glow, 2 blink), z/w params:
// shadow = footprint half size (x, z), glow = radius, halo = half size + height over which it fades into the floor.
// aCol: glow colour (linear, HDR), or for shadows (darkness, edge softness, corner radius).
const FX_VERT = `
attribute vec3 aCol;
attribute vec4 aFx;
uniform float uGlow, uBlink, uLift, uFxK, uShadowK;
varying vec2 vUv; varying vec3 vCol; varying vec4 vFx; varying float vH, vK;
void main() {
  vUv = uv; vFx = aFx; vCol = aCol;
  vK = aFx.x < 0.5 ? uShadowK : (aFx.y < 0.5 ? 1.0 : aFx.y < 1.5 ? uGlow : uBlink) * uFxK;
  vec4 wp;
  if (aFx.x > 1.5) {
    vec4 c = modelMatrix * vec4(position + vec3(0.0, uLift, 0.0), 1.0);
    vec2 o = (uv * 2.0 - 1.0) * aFx.z;
    wp = vec4(c.xyz + vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * o.x
                    + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * o.y, 1.0);
  } else wp = modelMatrix * vec4(position, 1.0);
  vH = wp.y - modelMatrix[3].y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const FX_FRAG = `
varying vec2 vUv; varying vec3 vCol; varying vec4 vFx; varying float vH, vK;
float sdRound(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  if (vFx.x < 0.5) {
    float d = sdRound(p * (vFx.zw + vCol.y), vFx.zw, min(vCol.z, min(vFx.z, vFx.w)));
    float a = 1.0 - smoothstep(-0.3 * vCol.y, vCol.y, d);
    gl_FragColor = vec4(0.0, 0.0, 0.0, vCol.x * vK * a * a);
  } else {
    float r = max(1.0 - length(p), 0.0);
    float a = vFx.x < 1.5 ? r * r * (0.6 + 0.4 * r)
      : (r * r * r * 0.75 + pow(r, 10.0) * 0.8) * smoothstep(0.0, vFx.w, vH);
    gl_FragColor = vec4(vCol * vK * a, 0.0);
  }
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
function fxMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uGlow: { value: 1 }, uBlink: { value: 1 }, uLift: { value: 0 }, uFxK: K.fx, uShadowK: K.shadow },
    vertexShader: FX_VERT, fragmentShader: FX_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
  });
}
// The soulsphere: a camera-facing quad; the fragment shader intersects the view ray with the ball, marches through it
// (a swirl that turns faster toward the centre, and a face that looks at the viewer), adds a bright limb, a glint and
// the corona around it. Premultiplied: the ball dims what is behind it a little, the light adds.
const ORB_VERT = `
uniform float uSize;
varying vec3 vW, vC;
void main() {
  vC = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vW = vC + (vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * position.x
           + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * position.y) * 2.0 * uSize;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;
const ORB_FRAG = `
uniform float uR, uTime, uGlow, uOrbK, uFace;
uniform vec3 uDeep, uMid, uHot;
varying vec3 vW, vC;
${NOISE}
vec2 itRot(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
void main() {
  vec3 rd = normalize(vW - cameraPosition);
  vec3 oc = cameraPosition - vC;
  float b = dot(oc, rd);
  float d2 = max(dot(oc, oc) - b * b, 0.0);
  float dr = sqrt(d2) / uR;
  float edge = smoothstep(1.0, 0.975, dr);
  vec3 col = uMid * (0.3 * exp(-max(dr - 1.0, 0.0) * 6.0) * (1.0 - smoothstep(1.2, 1.9, dr)) * (1.0 - edge));
  float alpha = 0.0;
  if (dr < 1.0) {
    float h = sqrt(uR * uR - d2), t0 = -b - h, t1 = -b + h;
    vec3 n = (oc + rd * t0) / uR;
    float mu = clamp(-dot(n, rd), 0.0, 1.0);
    // the face looks at the viewer, also up at a player looking down on it (its hollows then line up with the view
    // rays and stay crisp), turning its head slowly from side to side
    vec3 F = normalize(oc);
    F.xz = itRot(F.xz, sin(uTime * 0.53) * 0.45);
    vec3 X = normalize(cross(vec3(0.0, 1.0, 0.0), F) + vec3(1e-4, 0.0, 0.0)), U = cross(F, X);
    // march front to back: glowing swirl arms and wisps; the face is hollow, so its eyes and mouth read dark
    vec3 acc = vec3(0.0);
    float T = 1.0, dt = (t1 - t0) / uR / 8.0, hol = 0.0;
    for (int i = 0; i < 8; i++) {
      vec3 p = (oc + rd * mix(t0, t1, (float(i) + 0.5) / 8.0)) / uR;
      float r = length(p);
      vec3 q = p;
      q.xz = itRot(q.xz, uTime * 0.9 + (1.0 - r) * 3.5);
      float n1 = itNoise(q * 2.2 + vec3(0.0, uTime * 0.4, 0.0));
      float arms = pow(max(sin(atan(q.z, q.x) * 3.0 + q.y * 4.0 + n1 * 5.0 - uTime * 1.3), 0.0), 4.0) * smoothstep(0.04, 0.3, length(q.xz));
      float wisp = pow(itNoise(q * 4.5 - uTime * 0.3), 2.0);
      vec2 f = vec2(dot(p, X), dot(p, U));
      f += (vec2(itNoise(q * 2.6 + uTime * 0.4), itNoise(q * 2.6 + 7.0 - uTime * 0.3)) - 0.5) * 0.12;
      vec2 e = vec2(abs(f.x) - 0.3, f.y - 0.17) * vec2(1.0, 1.3);
      float ee = dot(e, e), front = smoothstep(-0.35, 0.1, dot(p, F));
      float mouth = exp(-pow((f.y + 0.3 - 0.45 * f.x * f.x) / 0.07, 2.0)) * smoothstep(0.44, 0.16, abs(f.x));
      float hollow = clamp((exp(-ee / 0.018) + 0.85 * mouth) * 1.6 * uFace, 0.0, 1.0) * front;
      float brow = max(exp(-ee / 0.05) - exp(-ee / 0.018), 0.0) * front * uFace;   // a glowing rim around each socket
      hol = max(hol, hollow);
      float dens = (0.3 + 1.8 * arms + 0.9 * wisp + 1.2 * brow) * smoothstep(1.02, 0.15, r) * (1.0 - 0.92 * hollow);
      acc += T * mix(uDeep * 2.5, uMid, clamp(arms + 0.6 * wisp + brow, 0.0, 1.0)) * dens * dt;
      T *= exp(-dens * dt * 1.1);
    }
    float core = exp(-dr * dr * 3.0);
    vec3 body = acc * 3.2 + uHot * pow(core, 6.0) * 0.5 * T * (1.0 - 0.9 * hol);
    body += uMid * pow(1.0 - mu, 3.0) * 1.1 * (1.0 - 0.5 * hol);
    vec3 L = normalize(vec3(-0.35, 0.85, 0.4));
    body += vec3(0.9, 0.95, 1.0) * pow(max(dot(reflect(rd, n), L), 0.0), 80.0) * 1.6;
    col += body * edge;
    alpha = 0.72 * edge;
  }
  gl_FragColor = vec4(col * uGlow * uOrbK, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
const ORB_GEO = new THREE.PlaneGeometry(1, 1);
ORB_GEO.boundingSphere = new THREE.Sphere(new THREE.Vector3(), ORB_R * ORB_HALO * 1.45);
function orbMaterial(o) {
  return new THREE.ShaderMaterial({
    uniforms: { uSize: { value: ORB_R * ORB_HALO }, uR: { value: ORB_R }, uTime: { value: 0 }, uGlow: { value: 1 }, uFace: { value: 1 },
      uOrbK: K.orb, uDeep: { value: new THREE.Vector3(...o.deep) }, uMid: { value: new THREE.Vector3(...o.mid) }, uHot: { value: new THREE.Vector3(...o.hot) } },
    vertexShader: ORB_VERT, fragmentShader: ORB_FRAG,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
}

// ----------------------------------------------------------- surfaces ----
// spec(sRGB hex, metalness, roughness, pattern, emissive gain)
const spec = (hex, m, r, k = 0, e = 0) => ({ c: new THREE.Color(hex), m, r, k, e });
const S = {
  gun: spec('#2e333a', 0.8, 0.36, PAT.worn),       // blued steel, chipped finish
  steel: spec('#a9afb6', 0.92, 0.3),
  steelDk: spec('#4b5058', 0.85, 0.42),
  brass: spec('#c99a45', 1, 0.3, 0, 0.1),
  copper: spec('#c46f40', 1, 0.3, 0, 0.06),
  primer: spec('#b8b09c', 1, 0.34),
  gold: spec('#e0b04a', 1, 0.25, 0, 0.15),
  poly: spec('#1d1e21', 0.04, 0.55),
  rubber: spec('#171717', 0, 0.85, PAT.pebble),
  inside: spec('#090909', 0, 0.95),
  olive: spec('#515d2d', 0.35, 0.52, PAT.worn),
  oliveDk: spec('#343c1c', 0.35, 0.58, PAT.worn),
  stencil: spec('#e6b62c', 0.05, 0.6, 0, 0.3),
  hull: spec('#b8190f', 0, 0.36),
  card: spec('#8e2c18', 0, 0.85, PAT.card),         // printed cardboard
  cardIn: spec('#b48d5b', 0, 0.9, PAT.card),
  label: spec('#e9dcae', 0, 0.8, PAT.card, 0.08),
  ink: spec('#241a14', 0, 0.8, PAT.card),
  inkRed: spec('#a8160d', 0, 0.7, PAT.card, 0.15),
  wood: spec('#8c5b30', 0, 0.72, PAT.woodX),
  woodZ: spec('#8c5b30', 0, 0.72, PAT.woodZ),
  woodDk: spec('#5c3a1d', 0, 0.75, PAT.woodX),
  rope: spec('#a88e5c', 0, 0.9, PAT.fabric),
  foam: spec('#1b1c1d', 0, 0.95, PAT.pebble),
  warhead: spec('#6e737b', 0.7, 0.4, PAT.worn),
  redPaint: spec('#b3261d', 0.2, 0.45, 0, 0.25),
  cellCase: spec('#2c3137', 0.65, 0.42, PAT.worn),
  hazard: spec('#e7b92c', 0.1, 0.55, PAT.hazard, 0.12),
  energy: spec('#19ff7a', 0, 0.3, PAT.flow, 2.6),
  charge: spec('#39ffa0', 0, 0.3, PAT.charge, 2.4),
  vent: spec('#1c3a2c', 0.2, 0.5, PAT.flow, 1.4),
  glassDk: spec('#07100c', 0.1, 0.12),
  termRed: spec('#c21d14', 0.1, 0.4, 0, 0.3),
  bag: spec('#6d4827', 0, 0.92, PAT.fabric),
  bagLt: spec('#7c5530', 0, 0.92, PAT.fabric),
  bagDk: spec('#553719', 0, 0.92, PAT.fabric),
  strap: spec('#2e2014', 0, 0.8, PAT.fabric),
  roll: spec('#5c6839', 0, 0.95, PAT.fabric),
  buckle: spec('#a7a296', 0.9, 0.35, 0, 0.12),
  white: spec('#eceae3', 0, 0.42),
  whiteDk: spec('#cfccc3', 0, 0.5),
  stim: spec('#c8181a', 0, 0.22, 0, 0.35),
  needleCap: spec('#e8761c', 0, 0.45, 0, 0.1),
  seam: spec('#50545a', 0.1, 0.6),
  cross: spec('#d8171a', 0, 0.4, 0, 0.55),
  black: spec('#151619', 0.15, 0.5, PAT.pebble),
  crossHot: spec('#ff1a14', 0, 0.35, 0, 1.6),
  cork: spec('#a57a4c', 0, 0.9, PAT.card),
  twine: spec('#c8b48a', 0, 0.9, PAT.fabric),
  potion: spec('#0b4dff', 0, 0.2, 0, 2.6),
  bubble: spec('#bfe4ff', 0, 0.1, 0, 3),
  glass: { c: new THREE.Color(1, 1, 1), m: 0, r: 0.05, k: 0, e: 0, glass: true },
};

// ----------------------------------------------------- geometry kit ----
// Parts are built through a matrix stack into the current node's lists, then merged per node and layer.
let B = null, OUT = null;
const STACK = [new THREE.Matrix4()];
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
function xf(pos, rot, scl) {
  _e.set(rot ? rot[0] : 0, rot ? rot[1] : 0, rot ? rot[2] : 0);
  if (scl === undefined || scl === null) _s.set(1, 1, 1); else if (typeof scl === 'number') _s.setScalar(scl); else _s.fromArray(scl);
  return new THREE.Matrix4().compose(_p.set(pos ? pos[0] : 0, pos ? pos[1] : 0, pos ? pos[2] : 0), _q.setFromEuler(_e), _s);
}
const top = () => STACK[STACK.length - 1];
const push = m => { STACK.push(top().clone().multiply(m)); };
const pop = () => { STACK.pop(); };
function node(name) { OUT = B.nodes[name] || (B.nodes[name] = { std: [], glass: [] }); }
// add(geometry, spec, pos, rot, scale) — or add(geometry, spec, matrix)
function add(geo, sp, pos, rot, scl) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  g.clearGroups();
  const m = top().clone().multiply(pos && pos.isMatrix4 ? pos : xf(pos, rot, scl));
  g.applyMatrix4(m);
  if (m.determinant() < 0) flip(g);
  const n = g.attributes.position.count, col = new Float32Array(n * 3), pbr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    col[i * 3] = sp.c.r; col[i * 3 + 1] = sp.c.g; col[i * 3 + 2] = sp.c.b;
    pbr[i * 4] = sp.m; pbr[i * 4 + 1] = sp.r; pbr[i * 4 + 2] = sp.k; pbr[i * 4 + 3] = sp.e;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('pbr', new THREE.BufferAttribute(pbr, 4));
  (sp.glass ? OUT.glass : OUT.std).push(g);
}
function flip(g) {   // mirrored transform: restore the winding of every triangle
  for (const k of ['position', 'normal']) {
    const a = g.attributes[k].array;
    for (let i = 0; i < a.length; i += 9) for (let j = 0; j < 3; j++) { const t = a[i + 3 + j]; a[i + 3 + j] = a[i + 6 + j]; a[i + 6 + j] = t; }
  }
}
const V2 = p => new THREE.Vector2(p[0], p[1]);
const G = {
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
  plane: (w, h) => new THREE.PlaneGeometry(w, h),   // facing +z
  rbox: (w, h, d, r, seg = 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4)),
  cyl: (rt, rb, h, seg = 16, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open),
  cylX: (r, len, seg = 12) => new THREE.CylinderGeometry(r, r, len, seg).rotateZ(Math.PI / 2),
  cylZ: (r, len, seg = 12) => new THREE.CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2),
  // lathe about y: pts [radius, y], ascending y faces outward
  lathe: (pts, seg = 16, crease = 0.6) => toCreasedNormals(new THREE.LatheGeometry(pts.map(V2), seg), crease),
  sph: (r, ws = 16, hs = 12, t0 = 0, tl = Math.PI, p0 = 0, pl = Math.PI * 2) => new THREE.SphereGeometry(r, ws, hs, p0, pl, t0, tl),
  tor: (R, r, arc = Math.PI * 2, ts = 20, rs = 8) => new THREE.TorusGeometry(R, r, rs, ts, arc),
  // outline (Shape or [x, y] points) in the xy plane, extruded along z and centred, bevelled
  ext(shape, d, bev = 0.006, cs = 8) {
    const sh = shape instanceof THREE.Shape ? shape : new THREE.Shape(shape.map(V2));
    const depth = Math.max(d - 2 * bev, 1e-3);
    const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: bev > 0, bevelThickness: bev, bevelSize: bev * 0.85, bevelSegments: 2, curveSegments: cs });
    g.translate(0, 0, -depth / 2);
    return toCreasedNormals(g, 0.6);
  },
  // side profile [z, y] extruded across x
  side: (pts, w, bev = 0.006, cs = 8) => G.ext(pts, w, bev, cs).rotateY(-Math.PI / 2),
};
function rrect(w, h, r, x0 = 0, y0 = 0, path = new THREE.Shape()) {
  const x = x0 - w / 2, y = y0 - h / 2;
  path.moveTo(x + r, y); path.lineTo(x + w - r, y); path.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  path.lineTo(x + w, y + h - r); path.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  path.lineTo(x + r, y + h); path.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(x, y + r); path.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return path;
}
// A soft bag panel: swell the middle, narrow toward the top, smooth normals over the whole surface.
function soft(g, cy, hy, swell, taper = 0) {
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = clamp((p.getY(i) - cy) / hy, -1, 1), s = 1 + swell * (1 - u * u) - taper * (u + 1) / 2;
    p.setX(i, p.getX(i) * s); p.setZ(i, p.getZ(i) * (1 + swell * 1.4 * (1 - u * u)));
  }
  g.computeVertexNormals();
  return g;
}
// Stencilled / printed text from a 3×5 pixel font: one quad per horizontal run of pixels, facing +z, centred at x0.
const FONT = {
  A: '010101111101101', C: '111100100100111', E: '111100110100111', G: '111100101101111', H: '101101111101101',
  K: '101110100110101', L: '100100100100111', M: '101111111101101', O: '111101101101111', R: '110101110101101',
  S: '111100111001111', T: '111010010010010', 0: '111101101101111', 1: '010110010010111', 2: '111001111100111',
  5: '111100111001111', '.': '000000000000010', '-': '000000111000000',
};
function text(str, px, sp, x0, y0, z = 0) {
  let x = x0 - (str.length * 4 - 1) * px / 2;
  for (const ch of str) {
    const g = FONT[ch];
    if (g) for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3;) {
        if (g[r * 3 + c] !== '1') { c++; continue; }
        let e = c; while (e < 2 && g[r * 3 + e + 1] === '1') e++;
        add(G.plane((e - c + 1) * px, px), sp, [x + (c + (e - c + 1) / 2) * px, y0 + (4.5 - r) * px, z]);
        c = e + 1;
      }
    }
    x += 4 * px;
  }
}
// fx quads (see FX_VERT): floor quads lie at y, halos are camera-facing around their centre
function fxQuad(kind, ch, c, ex, ez, col, p0, p1) {
  const F = B.fx, i0 = F.pos.length / 3;
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    if (kind === 2) F.pos.push(c[0], c[1], c[2]); else F.pos.push(c[0] + u * ex, c[1], c[2] - v * ez);
    F.uv.push((u + 1) / 2, (v + 1) / 2);
    F.col.push(col[0], col[1], col[2]);
    F.fx.push(kind, ch, p0, p1);
  }
  F.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
  F.reach = Math.max(F.reach, kind === 2 ? ex : 0);
}
const lin = (c, k = 1) => (Array.isArray(c) ? c.map(v => v * k) : new THREE.Color(c).multiplyScalar(k).toArray());
function shadow(hw, hd, o = {}) {
  const soft = o.soft ?? 0.14;
  fxQuad(0, 0, [o.x || 0, 0.01, o.z || 0], hw + soft, hd + soft, [o.dark ?? 1, soft, o.r ?? Math.min(hw, hd) * 0.5], hw, hd);
}
function pool(radius, color, o = {}) { fxQuad(1, o.ch ?? 1, [o.x || 0, 0.014, o.z || 0], radius, radius, lin(color, o.k ?? 1), radius, 0); }
function halo(y, size, color, o = {}) { fxQuad(2, o.ch ?? 1, [o.x || 0, y, o.z || 0], size, size, lin(color, o.k ?? 1), size, o.fade ?? 0.3); }

// --------------------------------------------------------- shared bits ----
// cartridge along +y from its head (0) to the bullet tip (len)
function cartridge(len, r, seg = 12) {
  const c = len * 0.6;
  add(G.lathe([[0, 0], [r * 1.02, 0], [r * 1.02, len * 0.04], [r * 0.84, len * 0.06], [r * 0.88, len * 0.085], [r, len * 0.1],
    [r, c - len * 0.03], [r * 0.95, c]], seg), S.brass);
  add(G.lathe([[r * 0.94, c - len * 0.01], [r * 0.93, c + len * 0.06], [r * 0.8, c + len * 0.2], [r * 0.52, c + len * 0.32],
    [r * 0.15, len - len * 0.01], [0, len]], seg), S.copper);
}
// shotgun shell along +y: brass head with rim and primer, ribbed plastic hull, folded crimp at the far end
function shotShell(len, r, seg = 12, ribs = 0) {
  const hb = len * 0.24;
  add(G.lathe([[0, 0.001], [r * 0.34, 0.001], [r * 0.36, 0], [r * 1.12, 0], [r * 1.12, len * 0.028], [r * 1.02, len * 0.04], [r * 1.02, hb],
    [r * 0.99, hb + 0.004]], seg), S.brass);
  add(G.lathe([[0, -0.0005], [r * 0.33, -0.0005], [r * 0.33, 0.0015]], seg), S.primer);
  const pts = [[r * 0.985, hb - 0.004], [r, hb + 0.002]];
  for (let i = 1; i <= ribs; i++) { const y = hb + (len - hb - 0.03) * i / (ribs + 1); pts.push([r, y - 0.008], [r * 0.975, y], [r, y + 0.008]); }
  pts.push([r, len - 0.03], [r * 0.94, len - 0.012], [r * 0.64, len], [r * 0.2, len - 0.014], [0, len - 0.018]);
  add(G.lathe(pts, seg, 0.5), S.hull);
}
// rocket standing along +y: nozzle at 0, fuze tip at 1.2; `from` skips what a crate hides
function rocketBody(o = {}) {
  const R = 0.115, seg = o.seg || 18, from = o.from || 0;
  if (!from) add(G.lathe([[0.05, 0.075], [0.068, 0.02], [0.084, 0.02], [0.086, 0.03], [0.08, 0.04], [0.092, 0.085], [R * 0.95, 0.11]], seg), S.steelDk);
  const body = from ? [[R, from]] : [[R * 0.95, 0.11], [R, 0.13]];
  if (from < 0.39) body.push([R, 0.39], [R * 1.05, 0.395], [R * 1.05, 0.43], [R, 0.435]);
  body.push([R, 0.72]);
  add(G.lathe(body, seg), S.olive);
  add(G.lathe([[R * 1.008, 0.72], [R * 1.008, 0.775]], seg), S.stencil);
  add(G.lathe([[R, 0.775], [R, 0.83], [R * 0.985, 0.86], [R * 0.9, 0.95], [R * 0.72, 1.04], [R * 0.47, 1.11], [R * 0.24, 1.155], [R * 0.2, 1.16]], seg), S.warhead);
  add(G.lathe([[R * 1.004, 0.835], [R * 1.004, 0.86]], seg), S.redPaint);
  add(G.lathe([[0.024, 1.158], [0.022, 1.19], [0.012, 1.2], [0, 1.201]], Math.max(8, seg >> 1)), S.brass);
  if (!from) {
    const fin = [[0.1, 0.09], [0.255, 0.005], [0.255, 0.135], [0.1, 0.405]];
    for (let i = 0; i < 4; i++) {
      push(xf(null, [0, i * Math.PI / 2 + Math.PI / 4, 0]));
      add(G.ext(fin, 0.024, 0.005, 1), S.oliveDk);
      pop();
    }
  }
}
// rounded-rectangle band (e.g. a lid seam) lying flat at height y
function band(w, d, r, h, y, sp) { add(G.ext(rrect(w, d, r), h, 0, 6).rotateX(-Math.PI / 2), sp, [0, y, 0]); }
// medical cross facing +z, centred, arms `a` long and `b` wide, `t` thick
function cross(a, b, t, sp) { add(G.box(a, b, t), sp); add(G.box(b, a, t), sp); }
// U-shaped carry handle hanging from two mounts on a +z face (in the current frame)
function handle(w, r, sp, mount) {
  add(G.tor(w / 2, r, Math.PI, 12, 6), sp, [0, 0, 0], [0, 0, Math.PI]);
  for (const s of [-1, 1]) add(G.rbox(0.07, 0.07, 0.05, 0.015, 1), mount, [s * w / 2, 0.01, -0.02]);
}

// ------------------------------------------------------------ items ----
const DEFS = {};

DEFS.clip = { build() {
  // pistol magazine on its base plate, raked like the grip it came out of, a round in the feed lips
  add(G.rbox(0.165, 0.05, 0.3, 0.02, 1), S.poly, [0, 0.025, 0.004]);
  add(G.side([[-0.118, 0.045], [0.118, 0.045], [0.068, 0.462], [0.04, 0.476], [-0.14, 0.476], [-0.166, 0.462]], 0.124, 0.01), S.gun);
  for (let i = 0; i < 4; i++) {   // witness holes showing the brass inside
    const y = 0.15 + i * 0.075;
    add(G.cylX(0.013, 0.128, 10), S.brass, [0, y, -0.068 - (y - 0.045) * 0.115]);
  }
  push(xf([0, 0.476 + 0.035, -0.15], [Math.PI / 2, 0, 0])); cartridge(0.21, 0.035, 12); pop();
  shadow(0.085, 0.155, { soft: 0.1 });
} };

DEFS.ammo = { build() {
  // olive ammo can, lid thrown open on its hinge, packed with big rounds
  const W = 1.0, H = 0.5, D = 0.46;
  add(G.rbox(W, H, D, 0.035, 2), S.olive, [0, H / 2, 0]);
  add(G.box(W - 0.06, 0.01, D - 0.06), S.inside, [0, H - 0.003, 0]);
  for (const s of [-1, 1]) {
    add(G.rbox(W + 0.012, 0.04, 0.03, 0.012, 1), S.oliveDk, [0, H + 0.012, s * (D / 2 - 0.009)]);
    add(G.rbox(0.03, 0.04, D - 0.03, 0.012, 1), S.oliveDk, [s * (W / 2 - 0.009), H + 0.012, 0]);
    add(G.rbox(0.03, 0.36, 0.26, 0.012, 1), S.oliveDk, [s * (W / 2 + 0.006), 0.26, 0]);   // pressed side panels
  }
  for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
    push(xf([(i - 2.5) * 0.148 + (j - 1) * 0.012, H - 0.04, (j - 1) * 0.128]));
    const r = 0.045;
    add(G.lathe([[r, 0], [r, 0.08], [r * 0.9, 0.1]], 8), S.brass);
    add(G.lathe([[r * 0.88, 0.095], [r * 0.8, 0.14], [r * 0.52, 0.185], [r * 0.14, 0.21], [0, 0.212]], 8), S.copper);
    pop();
  }
  // latch lever standing up at the side
  add(G.rbox(0.03, 0.22, 0.06, 0.012, 1), S.oliveDk, [W / 2 + 0.03, H + 0.06, D / 2 - 0.1], [0.25, 0, 0]);
  add(G.cylX(0.03, 0.05, 10), S.steelDk, [W / 2 + 0.02, H - 0.03, D / 2 - 0.1]);
  // stencilled markings on both long faces
  for (const s of [-1, 1]) {
    push(xf([0, 0, s * (D / 2 + 0.0015)], [0, s < 0 ? Math.PI : 0, 0]));
    text('CAL .50', 0.024, S.stencil, -0.05, 0.27);
    add(G.plane(0.74, 0.03), S.stencil, [0, 0.19, 0]);
    text('AMMO', 0.016, S.stencil, -0.22, 0.1);
    pop();
  }
  // lid, hinged along the back edge
  push(xf([0, H + 0.02, -D / 2 - 0.005], [-1.85, 0, 0]));
  add(G.rbox(W + 0.02, 0.075, D + 0.02, 0.03, 2), S.olive, [0, 0.0375, D / 2 + 0.01]);
  add(G.box(W - 0.09, 0.012, D - 0.09), S.rubber, [0, -0.004, D / 2 + 0.01]);
  add(G.rbox(0.38, 0.03, 0.075, 0.012, 1), S.oliveDk, [0, 0.09, D / 2 + 0.01]);
  for (const s of [-1, 1]) add(G.rbox(0.05, 0.05, 0.09, 0.012, 1), S.oliveDk, [s * 0.2, 0.08, D / 2 + 0.01]);
  pop();
  shadow(W / 2, D / 2, { r: 0.04 });
} };

DEFS.shell = { build() {
  // four shotgun shells tumbled on the floor
  const L = 0.44, r = 0.058;
  for (const [x, y, z, yaw] of [[-0.02, r * 1.1, -0.123, 0.12], [0.04, r * 1.1, 0, Math.PI - 0.07], [-0.03, r * 1.1, 0.123, 0.2], [0.02, r * 1.1 + 0.1, 0.062, Math.PI - 0.3]]) {
    push(xf([x, y, z], [0, yaw, -Math.PI / 2])); push(xf([0, -L / 2, 0]));
    shotShell(L, r, 14, 4);
    pop(); pop();
  }
  shadow(0.25, 0.2, { soft: 0.1 });
} };

DEFS.shellbox = { build() {
  // open carton of shells: printed outer card, plain inner card, a row of shells showing their brass heads
  const W = 1.1, D = 0.54, H = 0.3, HF = 0.17, t = 0.012;
  add(G.box(W, t, D), S.card, [0, t / 2, 0]);
  add(G.box(W - 2 * t, t, D - 2 * t), S.cardIn, [0, t * 1.5, 0]);
  add(G.box(W, H, t), S.card, [0, H / 2, -D / 2 + t / 2]);
  add(G.box(W - 2 * t, H - t, t), S.cardIn, [0, (H + t) / 2, -D / 2 + t * 1.5]);
  add(G.box(W, HF, t), S.card, [0, HF / 2, D / 2 - t / 2]);
  add(G.box(W - 2 * t, HF - t, t), S.cardIn, [0, (HF + t) / 2, D / 2 - t * 1.5]);
  const sideP = (d, h0, h1) => [[-d / 2, 0], [d / 2, 0], [d / 2, h1], [-d / 2 + 0.07, h0], [-d / 2, h0]];
  for (const s of [-1, 1]) {
    add(G.side(sideP(D, H, HF), t, 0), S.card, [s * (W / 2 - t / 2), 0, 0]);
    add(G.side(sideP(D - 2 * t, H - 0.002, HF - 0.002), t, 0), S.cardIn, [s * (W / 2 - t * 1.5), 0.001, 0]);
  }
  // printing: label band and calibre on the front, name on the back
  push(xf([0, 0, D / 2 + 0.0015]));
  add(G.plane(W - 0.08, 0.075), S.label, [0, 0.088, 0]);
  text('12 GA', 0.012, S.inkRed, -0.3, 0.058);
  add(G.plane(0.2, 0.012), S.ink, [0.27, 0.1, 0.0005]); add(G.plane(0.2, 0.012), S.ink, [0.27, 0.075, 0.0005]);
  pop();
  push(xf([0, 0, -D / 2 - 0.0015], [0, Math.PI, 0]));
  add(G.plane(W - 0.08, 0.09), S.label, [0, 0.15, 0]);
  text('SHELLS', 0.014, S.inkRed, 0, 0.115);
  pop();
  // lid thrown back on its hinge, tuck flap hanging off its edge
  push(xf([0, H, -D / 2], [-2.0, 0, 0]));
  add(G.box(W, t, D), S.card, [0, t / 2, D / 2]);
  add(G.box(W - 2 * t, t, D - 2 * t), S.cardIn, [0, -t / 2, D / 2]);
  add(G.box(W - 0.02, 0.09, t), S.card, [0, -0.045, D - t / 2], [0.25, 0, 0]);
  push(xf([0, t + 0.0015, D / 2], [0, Math.PI, 0])); push(xf(null, [-Math.PI / 2, 0, 0]));
  add(G.plane(0.62, 0.2), S.label, [0, 0, 0]);
  text('12 GA', 0.024, S.inkRed, 0, -0.06, 0.0005);
  pop(); pop();
  pop();
  // the top layer of shells, heads to the front
  const r = 0.05, L = 0.44;
  for (let i = 0; i < 10; i++) {
    push(xf([(i - 4.5) * 0.1035 + Math.sin(i * 7.1) * 0.003, 0.013 + r * 3 + Math.sin(i * 3.7) * 0.004, L / 2 - 0.005], [-Math.PI / 2, 0, 0]));
    shotShell(L, r, 10, 0);
    pop();
  }
  shadow(W / 2, D / 2, { r: 0.02 });
} };

DEFS.rocket = { build() {
  rocketBody();
  shadow(0.2, 0.2, { soft: 0.14, r: 0.2 });
} };

DEFS.rocketbox = { build() {
  // open wooden crate, five rockets standing in a foam insert
  const W = 0.96, H = 0.6, D = 0.74, t = 0.045, ph = (H - 0.04) / 3;
  add(G.box(W, 0.04, D), S.woodZ, [0, 0.02, 0]);
  for (let i = 0; i < 3; i++) {
    const y = 0.04 + (i + 0.5) * ph, h = ph - 0.012;
    for (const s of [-1, 1]) {
      add(G.box(W, h, t), S.wood, [0, y, s * (D / 2 - t / 2)]);
      add(G.box(t, h, D - 2 * t), S.woodZ, [s * (W / 2 - t / 2), y, 0]);
    }
  }
  for (const s of [-1, 1]) {
    // end cleats, corner brackets and a rope handle on each end
    for (const z of [-1, 1]) add(G.box(0.028, H - 0.02, 0.075), S.woodDk, [s * (W / 2 + 0.014), H / 2, z * (D / 2 - 0.05)]);
    add(G.box(0.028, 0.075, D - 0.03), S.woodDk, [s * (W / 2 + 0.014), H - 0.06, 0]);
    for (const z of [-1, 1]) {
      add(G.box(0.1, 0.1, 0.006), S.steelDk, [s * (W / 2 - 0.035), H - 0.06, z * (D / 2 + 0.003)]);
      add(G.box(0.006, 0.1, 0.1), S.steelDk, [s * (W / 2 + 0.031), H - 0.06, z * (D / 2 - 0.035)]);
    }
    add(G.tor(0.1, 0.018, Math.PI, 12, 6), S.rope, [s * (W / 2 + 0.035), 0.4, 0], [0, Math.PI / 2, Math.PI]);
    push(xf([0, 0, s * (D / 2 + 0.0015)], [0, s < 0 ? Math.PI : 0, 0]));
    text('ROCKETS', 0.022, S.stencil, 0, 0.26);
    add(G.plane(0.7, 0.028), S.stencil, [0, 0.43, 0]);
    pop();
  }
  add(G.box(W - 2 * t, 0.02, D - 2 * t), S.foam, [0, 0.46, 0]);
  for (const [x, z, a] of [[-0.23, -0.16, 0.4], [0.23, -0.16, 1.9], [0, 0, 0.7], [-0.23, 0.16, 2.8], [0.23, 0.16, 4.1]]) {
    push(xf([x, 0.04, z], [0.012 * Math.sin(a * 3), a, 0.012 * Math.cos(a * 5)])); rocketBody({ from: 0.4, seg: 14 }); pop();
  }
  shadow(W / 2 + 0.03, D / 2, { r: 0.03 });
} };

DEFS.cell = { build() {
  // energy cell: a glowing core behind a caged casing, steel end caps and a terminal
  add(G.lathe([[0, 0], [0.145, 0], [0.155, 0.01], [0.155, 0.05], [0.148, 0.056], [0.155, 0.062], [0.155, 0.075], [0.14, 0.088], [0.125, 0.09]], 20), S.steel);
  add(G.cyl(0.118, 0.118, 0.42, 20, true), S.energy, [0, 0.3, 0]);
  for (const y of [0.19, 0.3, 0.41]) add(G.tor(0.12, 0.009, Math.PI * 2, 20, 6), S.steelDk, [0, y, 0], [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    add(G.rbox(0.07, 0.42, 0.04, 0.012, 1), S.cellCase, [Math.cos(a) * 0.135, 0.3, Math.sin(a) * 0.135], [0, -a + Math.PI / 2, 0]);
  }
  add(G.lathe([[0.125, 0.51], [0.14, 0.512], [0.155, 0.525], [0.155, 0.56], [0.148, 0.566], [0.155, 0.572], [0.155, 0.59], [0.14, 0.6],
    [0.07, 0.605], [0, 0.605]], 20), S.steel);
  add(G.cyl(0.157, 0.157, 0.02, 20), S.hazard, [0, 0.545, 0]);
  add(G.lathe([[0.045, 0.6], [0.045, 0.63], [0.035, 0.645], [0, 0.648]], 12), S.brass);
  shadow(0.155, 0.155, { soft: 0.1, r: 0.155 });
  pool(0.55, '#19ff7a', { k: 0.22 });
  halo(0.3, 0.42, '#19ff7a', { k: 0.3, fade: 0.25 });
}, anim(it, t) {
  it.su.uTime.value = t % WRAP;
  it.su.uGlow.value = it.fu.uGlow.value = 0.85 + 0.15 * Math.sin(t * 2.3);
} };

DEFS.cellpack = { build() {
  // big energy pack: armoured case, glowing charge windows front and back, handle and terminals on top
  const W = 1.16, H = 0.5, D = 0.56, y0 = 0.05;
  add(G.rbox(W, H, D, 0.045, 2), S.cellCase, [0, y0 + H / 2, 0]);
  for (const s of [-1, 1]) add(G.rbox(W - 0.08, 0.05, 0.08, 0.015, 1), S.rubber, [0, 0.025, s * 0.19]);
  for (const s of [-1, 1]) {
    push(xf([0, 0, s * D / 2], [0, s < 0 ? Math.PI : 0, 0]));
    add(G.rbox(0.8, 0.27, 0.03, 0.02, 1), S.steelDk, [0, 0.3, 0.004]);
    add(G.box(0.72, 0.19, 0.01), S.glassDk, [0, 0.3, 0.018]);
    for (let i = 0; i < 6; i++) add(G.box(0.085, 0.14, 0.008), S.charge, [(i - 2.5) * 0.114, 0.3, 0.021]);
    add(G.plane(0.9, 0.05), S.hazard, [0, 0.125, 0.0015]);
    pop();
    // cooling fins on the ends
    for (let i = 0; i < 5; i++) add(G.box(0.035, 0.34, 0.03), S.steelDk, [s * (W / 2 + 0.012), 0.3, (i - 2) * 0.09]);
  }
  // top: vents, handle, terminals
  for (let i = 0; i < 4; i++) add(G.box(0.34, 0.008, 0.028), S.vent, [0, y0 + H + 0.001, (i - 1.5) * 0.07]);
  for (const s of [-1, 1]) add(G.cyl(0.028, 0.034, 0.12, 12), S.steelDk, [s * 0.3, y0 + H + 0.06, -0.02]);
  add(G.cylX(0.03, 0.64, 12), S.steel, [0, y0 + H + 0.12, -0.02]);
  add(G.cylX(0.038, 0.32, 12), S.rubber, [0, y0 + H + 0.12, -0.02]);
  for (const [x, sp] of [[-0.44, S.termRed], [0.44, S.poly]]) {
    add(G.cyl(0.05, 0.055, 0.045, 14), S.steel, [x, y0 + H + 0.022, 0.13]);
    add(G.cyl(0.035, 0.05, 0.06, 14), sp, [x, y0 + H + 0.07, 0.13]);
  }
  shadow(W / 2 + 0.02, D / 2, { r: 0.05 });
  pool(1.0, '#39ffa0', { k: 0.12 });
}, anim(it, t) {
  it.su.uTime.value = t % WRAP;
  it.su.uGlow.value = it.fu.uGlow.value = 0.9 + 0.1 * Math.sin(t * 1.9);
} };

DEFS.backpack = { build() {
  // soldier's rucksack standing up: soft main bag, top flap, pockets, straps and a bedroll on top
  add(soft(G.rbox(0.82, 0.92, 0.42, 0.16, 3), 0, 0.46, 0.06, 0.08), S.bag, [0, 0.462, 0]);
  add(soft(G.rbox(0.86, 0.13, 0.5, 0.06, 2), 0, 0.065, 0.03), S.bagDk, [0, 0.95, 0.02]);
  add(soft(G.rbox(0.72, 0.34, 0.07, 0.035, 2), 0, 0.17, 0.05), S.bagDk, [0, 0.83, 0.235], [-0.14, 0, 0]);
  add(soft(G.rbox(0.56, 0.36, 0.16, 0.07, 2), 0, 0.18, 0.08), S.bagLt, [0, 0.29, 0.25]);
  add(soft(G.rbox(0.58, 0.09, 0.18, 0.04, 1), 0, 0.045, 0.02), S.bagDk, [0, 0.45, 0.255]);
  for (const s of [-1, 1]) {
    add(soft(G.rbox(0.15, 0.42, 0.3, 0.07, 2), 0, 0.21, 0.06), S.bagLt, [s * 0.47, 0.31, 0.01]);
    add(G.box(0.07, 0.5, 0.018), S.strap, [s * 0.2, 0.72, 0.29], [-0.1, 0, 0]);
    add(G.box(0.1, 0.075, 0.02), S.buckle, [s * 0.2, 0.6, 0.302], [-0.1, 0, 0]);
    add(G.box(0.05, 0.2, 0.016), S.strap, [s * 0.16, 0.36, 0.34]);
    add(G.box(0.07, 0.05, 0.018), S.buckle, [s * 0.16, 0.3, 0.347]);
    // shoulder straps on the back
    add(G.tor(0.34, 0.035, Math.PI * 0.85, 14, 6).rotateZ(-Math.PI * 0.425), S.strap, [s * 0.2, 0.55, -0.235], [0, Math.PI / 2, 0], [0.45, 1, 1]);
  }
  add(G.rbox(0.6, 0.66, 0.05, 0.03, 1), S.bagDk, [0, 0.52, -0.225]);
  add(G.tor(0.07, 0.016, Math.PI, 10, 6), S.strap, [0, 0.99, -0.2]);
  // bedroll strapped on top
  add(G.cylX(0.145, 0.9, 20), S.roll, [0, 1.15, -0.02]);
  for (const s of [-1, 1]) {
    add(G.tor(0.148, 0.012, Math.PI * 2, 20, 5), S.strap, [s * 0.3, 1.15, -0.02], [0, Math.PI / 2, 0]);
    add(G.cylX(0.1, 0.004, 16), S.bagDk, [s * 0.451, 1.15, -0.02]);
  }
  shadow(0.5, 0.3, { soft: 0.16, r: 0.2 });
} };

DEFS.stimpack = { build() {
  // small white field kit: red cross on the lid, a stim syringe under an elastic strap along its front edge
  add(G.rbox(0.56, 0.2, 0.4, 0.05, 3), S.white, [0, 0.1, 0]);
  band(0.566, 0.406, 0.053, 0.016, 0.1, S.seam);
  push(xf([-0.03, 0.203, -0.05], [-Math.PI / 2, 0, 0])); cross(0.19, 0.062, 0.01, S.cross); pop();
  for (const s of [-1, 1]) { push(xf([0.1, 0.1, s * 0.202], [0, s < 0 ? Math.PI : 0, 0])); cross(0.085, 0.028, 0.006, S.cross); pop(); }
  add(G.tor(0.045, 0.012, Math.PI, 10, 6), S.seam, [0.28, 0.1, 0], [0, 0, -Math.PI / 2]);
  push(xf([0, 0.224, 0.125]));
  add(G.cylX(0.022, 0.17, 12), S.stim);
  add(G.cylX(0.025, 0.012, 12), S.whiteDk, [-0.085, 0, 0]);
  add(G.box(0.012, 0.03, 0.078), S.whiteDk, [-0.095, 0, 0]);
  add(G.cylX(0.008, 0.07, 6), S.whiteDk, [-0.13, 0, 0]);
  add(G.cylX(0.02, 0.01, 12), S.whiteDk, [-0.168, 0, 0]);
  add(G.cyl(0.006, 0.014, 0.075, 8).rotateZ(-Math.PI / 2), S.needleCap, [0.122, 0, 0]);
  add(G.box(0.03, 0.05, 0.058), S.seam, [0.02, -0.001, 0]);
  pop();
  shadow(0.28, 0.2, { soft: 0.1, r: 0.07 });
} };

DEFS.medikit = { build() {
  // first-aid case: white shell, grey seam, big red cross, handle and latches on the front
  const W = 1.15, H = 0.3, D = 0.78;
  add(G.rbox(W, H, D, 0.06, 2), S.white, [0, H / 2, 0]);
  band(W + 0.008, D + 0.008, 0.064, 0.02, 0.19, S.seam);
  push(xf([0, H + 0.004, 0], [-Math.PI / 2, 0, 0])); cross(0.5, 0.16, 0.014, S.cross); pop();
  for (const s of [-1, 1]) { push(xf([s * (W / 2 + 0.003), 0.15, 0], [0, s * Math.PI / 2, 0])); cross(0.17, 0.055, 0.006, S.cross); pop(); }
  push(xf([0, 0.2, D / 2 + 0.03])); handle(0.34, 0.024, S.poly, S.seam); pop();
  for (const s of [-1, 1]) add(G.rbox(0.09, 0.1, 0.03, 0.01, 1), S.steel, [s * 0.4, 0.19, D / 2 + 0.005]);
  shadow(W / 2, D / 2, { r: 0.06 });
} };

DEFS.berserk = { build() {
  // black medical case, steel corners, a fiercely glowing red cross
  const W = 1.05, H = 0.4, D = 0.7;
  add(G.rbox(W, H, D, 0.05, 2), S.black, [0, H / 2, 0]);
  band(W + 0.008, D + 0.008, 0.054, 0.02, 0.27, S.seam);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0.055, H - 0.05]) {
    add(G.rbox(0.12, 0.11, 0.12, 0.03, 1), S.steel, [sx * (W / 2 - 0.045), y, sz * (D / 2 - 0.045)]);
  }
  push(xf([0, H + 0.004, 0], [-Math.PI / 2, 0, 0])); cross(0.46, 0.15, 0.014, S.crossHot); pop();
  push(xf([0, 0.16, D / 2 + 0.003])); cross(0.18, 0.06, 0.006, S.crossHot); pop();
  push(xf([0, 0.3, -D / 2 - 0.02], [0, Math.PI, 0])); handle(0.34, 0.024, S.poly, S.steelDk); pop();
  for (const s of [-1, 1]) add(G.rbox(0.09, 0.1, 0.03, 0.01, 1), S.steel, [s * 0.3, 0.27, D / 2 + 0.005]);
  shadow(W / 2, D / 2, { r: 0.05 });
  halo(H + 0.12, 0.55, '#ff2a14', { k: 0.28, fade: 0.3 });
}, anim(it, t) {
  // a heartbeat: lub-dub, rest
  const x = (t % 1.1 + 1.1) % 1.1, beat = Math.exp(-(((x - 0.05) / 0.07) ** 2)) + 0.7 * Math.exp(-(((x - 0.3) / 0.08) ** 2));
  it.su.uGlow.value = it.fu.uGlow.value = 0.65 + 0.7 * beat;
} };

DEFS.hbonus = { build() {
  // round-bottomed potion flask: glowing blue draught, cork and twine
  add(G.lathe([[0, 0], [0.08, 0], [0.117, 0.012], [0.152, 0.046], [0.172, 0.1], [0.178, 0.16], [0.17, 0.22], [0.146, 0.278], [0.1, 0.322],
    [0.066, 0.348], [0.056, 0.37], [0.056, 0.43], [0.066, 0.436], [0.068, 0.455], [0.058, 0.462]], 22, 0.9), S.glass);
  add(G.lathe([[0, 0.012], [0.074, 0.012], [0.106, 0.022], [0.143, 0.054], [0.162, 0.1], [0.167, 0.16], [0.162, 0.21], [0.152, 0.24],
    [0.1, 0.242], [0, 0.243]], 22, 0.9), S.potion);
  for (const [x, y, z, r] of [[0.05, 0.08, 0.04, 0.016], [-0.06, 0.13, -0.02, 0.012], [0.02, 0.19, -0.07, 0.01], [-0.03, 0.06, 0.08, 0.009]]) {
    add(G.sph(r, 8, 6), S.bubble, [x, y, z]);
  }
  add(G.lathe([[0, 0.39], [0.049, 0.39], [0.051, 0.455], [0.06, 0.505], [0.056, 0.52], [0, 0.523]], 14), S.cork);
  add(G.tor(0.059, 0.008, Math.PI * 2, 18, 5), S.twine, [0, 0.4, 0], [Math.PI / 2, 0, 0]);
  add(G.tor(0.06, 0.008, Math.PI * 2, 18, 5), S.twine, [0, 0.415, 0], [Math.PI / 2, 0, 0]);
  shadow(0.12, 0.12, { soft: 0.1, r: 0.12 });
  pool(0.45, '#2a86ff', { k: 0.35 });
  halo(0.17, 0.42, '#2a86ff', { k: 0.4, fade: 0.2 });
}, anim(it, t) {
  it.su.uGlow.value = it.fu.uGlow.value = 0.7 + 0.55 * cyc(t, 36);
} };

DEFS.abonus = { build() {
  // small armour helmet: green shell, crest, a glowing T-visor
  const sc = [1, 1.05, 1.18];
  push(xf([0, -0.012, 0]));
  add(G.sph(0.22, 28, 12, 0, Math.PI * 0.52), spec('#3d9442', 0.55, 0.33, PAT.armour, 0.06), [0, 0.035, 0], null, sc);
  add(G.tor(0.222, 0.02, Math.PI * 2, 32, 6), spec('#23592a', 0.6, 0.38, PAT.armour), [0, 0.03, 0], [Math.PI / 2, 0, 0], [1, 1.18, 1]);
  add(G.tor(0.226, 0.018, Math.PI, 20, 6), spec('#23592a', 0.6, 0.38, PAT.armour), [0, 0.035, 0], [0, Math.PI / 2, 0], [1.18, 1.05, 1]);
  const vis = spec('#2fd24e', 0.2, 0.12, 0, 1.3);
  add(G.sph(0.224, 18, 3, 0.98, 0.2, Math.PI / 2 - 0.8, 1.6), vis, [0, 0.035, 0], null, sc);
  add(G.sph(0.224, 4, 5, 1.16, 0.4, Math.PI / 2 - 0.13, 0.26), vis, [0, 0.035, 0], null, sc);
  for (const s of [-1, 1]) add(G.rbox(0.035, 0.13, 0.12, 0.015, 1), spec('#23592a', 0.6, 0.38, PAT.armour), [s * 0.213, 0.095, -0.02], [0, 0, s * 0.1]);
  pop();
  shadow(0.22, 0.26, { soft: 0.1, r: 0.2 });
  halo(0.16, 0.38, '#46ff5a', { k: 0.22, fade: 0.2 });
}, anim(it, t) {
  const c = cyc(t, 36);
  it.su.uGlow.value = 0.6 + 0.8 * c;
  it.fu.uGlow.value = 0.5 + 0.9 * c;
  it.su.uSheen.value = ((t % 1.6 + 1.6) % 1.6) / 1.6 * 0.6 - 0.12;
  it.su.uSheenK.value = 0.22;
} };

// ------------------------------------------------------------- armour ----
// The vest is a rigid shell: a superelliptic cross-section per height [y, half width, half depth], pectorals swelling
// the front; raised plates are the same surface pushed out, bevelled down to it at their borders.
const TORSO = [[0.02, 0.38, 0.2], [0.1, 0.375, 0.198], [0.25, 0.362, 0.192], [0.42, 0.356, 0.19], [0.58, 0.374, 0.196],
  [0.74, 0.414, 0.207], [0.9, 0.448, 0.218], [1.04, 0.468, 0.224], [1.16, 0.474, 0.222], [1.25, 0.466, 0.214],
  [1.31, 0.44, 0.2], [1.355, 0.385, 0.18], [1.385, 0.31, 0.16], [1.405, 0.25, 0.145], [1.415, 0.225, 0.138]];
function torsoAB(y) {
  let i = 0;
  while (i < TORSO.length - 2 && TORSO[i + 1][0] < y) i++;
  const [y0, a0, b0] = TORSO[i], [y1, a1, b1] = TORSO[i + 1], t = clamp((y - y0) / (y1 - y0), 0, 1);
  return [a0 + (a1 - a0) * t, b0 + (b1 - b0) * t];
}
function torsoPt(th, y, off) {
  const [a, b] = torsoAB(y), c = Math.cos(th), s = Math.sin(th), e = 2 / 3;
  const x = (a + off) * Math.sign(c) * Math.pow(Math.abs(c), e);
  let z = (b + off) * Math.sign(s) * Math.pow(Math.abs(s), e);
  if (s > 0) z += s * 0.04 * (Math.exp(-(((x - 0.2) / 0.14) ** 2)) + Math.exp(-(((x + 0.2) / 0.14) ** 2))) * Math.exp(-(((y - 1.0) / 0.15) ** 2));
  return [x, y, z];
}
function surfGeo(pos, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
// Surface over angles th (0 = +x, π/2 = front) × heights ys, pushed out by off; bev > 0 bevels the border down to the
// torso. wrap: a closed ring.
function torsoSurf(ths, ys, off, bev = 0, wrap = false) {
  const pos = [], idx = [], nt = ths.length, ny = ys.length;
  const t0 = ths[0], t1 = ths[nt - 1], y0 = ys[0], y1 = ys[ny - 1];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nt; i++) {
    let o = off;
    if (bev > 0) {
      const edge = Math.min(wrap ? 1 : Math.min(ths[i] - t0, t1 - ths[i]) * 0.36, ys[j] - y0, y1 - ys[j]);
      o = 0.002 + (off - 0.002) * smooth(0, bev, edge);
    }
    pos.push(...torsoPt(ths[i], ys[j], o));
  }
  const cols = wrap ? nt : nt - 1;
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < cols; i++) {
    const i1 = (i + 1) % nt, a = j * nt + i, b = (j + 1) * nt + i, c = (j + 1) * nt + i1, d = j * nt + i1;
    idx.push(a, b, c, a, c, d);
  }
  return surfGeo(pos, idx);
}
// An oval patch lying on the torso (arm openings): centre (th0, y0), radii rt (angle) and ry (height)
function torsoOval(th0, y0, rt, ry, off, rings = 3, seg = 18) {
  const pos = [...torsoPt(th0, y0, off)], idx = [], ring = k => 1 + (k - 1) * seg;
  for (let k = 1; k <= rings; k++) for (let i = 0; i < seg; i++) {
    const a = i / seg * Math.PI * 2, f = k / rings;
    pos.push(...torsoPt(th0 + Math.cos(a) * rt * f, y0 + Math.sin(a) * ry * f, off));
  }
  for (let i = 0; i < seg; i++) {
    const i1 = (i + 1) % seg;
    idx.push(0, ring(1) + i1, ring(1) + i);
    for (let k = 2; k <= rings; k++) {
      const p = ring(k - 1), c = ring(k);
      idx.push(p + i, c + i1, c + i, p + i, p + i1, c + i1);
    }
  }
  return surfGeo(pos, idx);
}
const span = (a, b, n, bev = 0) => {   // n steps from a to b, with extra samples `bev` inside each end
  const out = [];
  for (let i = 0; i <= n; i++) out.push(a + (b - a) * i / n);
  if (bev) out.splice(1, 0, a + bev), out.splice(out.length - 1, 0, b - bev);
  return out.sort((p, q) => p - q);
};
function armour(main, trim, plate, gem) {
  const M = spec(main, 0.45, 0.36, PAT.armour), T = spec(trim, 0.55, 0.42, PAT.armour), P = spec(plate, 0.5, 0.33, PAT.armour);
  return { build() {
    push(xf([0, -0.021, 0], null, 1.08));
    const ring = Array.from({ length: 36 }, (_, i) => i / 36 * Math.PI * 2 + Math.PI / 2);
    add(torsoSurf(ring, TORSO.map(r => r[0]), 0, 0, true), T);
    // chest plate over the pectorals, three abdominal plates, the back plate and the hem
    add(torsoSurf(span(Math.PI / 2 - 1.2, Math.PI / 2 + 1.2, 16, 0.06), span(0.84, 1.27, 8, 0.03), 0.018, 0.035), M);
    for (const [ya, yb] of [[0.34, 0.47], [0.5, 0.63], [0.66, 0.79]]) {
      add(torsoSurf(span(Math.PI / 2 - 0.95, Math.PI / 2 + 0.95, 12, 0.05), span(ya, yb, 2, 0.022), 0.016, 0.022), P);
    }
    add(torsoSurf(span(Math.PI * 1.5 - 1.15, Math.PI * 1.5 + 1.15, 14, 0.06), span(0.3, 1.25, 8, 0.03), 0.016, 0.03), M);
    add(torsoSurf(ring, span(0.02, 0.1, 1, 0.02), 0.012, 0.02, true), T);
    for (const s of [-1, 1]) {
      // arm opening under the pauldrons
      add(torsoOval(s > 0 ? 0 : Math.PI, 1.08, 0.42, 0.16, 0.003), S.inside);
      // pauldrons: two stacked shells on each shoulder
      add(G.sph(1, 12, 8), P, [s * 0.43, 1.3, 0], [0, 0, -s * 0.45], [0.24, 0.1, 0.24]);
      add(G.sph(1, 12, 8), M, [s * 0.53, 1.2, 0], [0, 0, -s * 0.95], [0.2, 0.09, 0.25]);
      // side straps and buckles
      for (const y of [0.56, 0.76]) {
        const [a] = torsoAB(y);
        add(G.box(0.03, 0.06, 0.2), spec('#1b1d1f', 0.1, 0.7, PAT.pebble), [s * (a + 0.012), y, 0]);
        add(G.box(0.04, 0.075, 0.045), S.steel, [s * (a + 0.02), y, 0.03]);
      }
    }
    // collar and the dark inside of the neck
    add(G.tor(0.2, 0.035, Math.PI * 2, 20, 6), T, [0, 1.415, 0], [Math.PI / 2, 0, 0], [1.2, 0.72, 1]);
    add(new THREE.CircleGeometry(0.21, 20).rotateX(-Math.PI / 2), S.inside, [0, 1.4, 0], null, [1.1, 1, 0.68]);
    // chest emblem with a glowing gem
    const zc = torsoPt(Math.PI / 2, 1.03, 0.018)[2];
    add(G.cyl(0.09, 0.09, 0.03, 6), T, [0, 1.03, zc + 0.008], [Math.PI / 2, Math.PI / 6, 0]);
    add(G.tor(0.075, 0.009, Math.PI * 2, 6, 4), S.steel, [0, 1.03, zc + 0.024], [0, 0, Math.PI / 6]);
    add(G.sph(0.048, 12, 8), spec(gem, 0, 0.2, 0, 2.6), [0, 1.03, zc + 0.02], null, [1, 1, 0.55]);
    pop();
    shadow(0.45, 0.26, { soft: 0.16, r: 0.2 });
  }, anim(it, t) {
    // Doom's armour flicker (6 tics dim, 7 bright) softened, and a sheen sweeping up the plates
    it.su.uGlow.value = 0.85 + 0.35 * Math.sin(t * Math.PI * 2 / (13 * TIC));
    const ph = (t % 2.4 + 2.4) % 2.4;
    it.su.uSheen.value = ph / 1.1 * 2.4 - 0.5;
    it.su.uSheenK.value = ph < 1.1 ? 0.2 : 0;
  } };
}
DEFS.greenarmor = armour('#3c8f3d', '#1c3a1f', '#4aa24a', '#8dff5a');
DEFS.bluearmor = armour('#2f5fcf', '#16285a', '#3f73e0', '#78d4ff');

// ------------------------------------------------------------ spheres ----
function sphere(deep, mid, hot, poolCol, tics) {
  return { build() {
    B.orb = { y: HOVER + ORB_R, deep, mid, hot };
    pool(1.4, poolCol, { k: 0.36 });
  }, anim(it, t) {
    const bob = Math.sin(t * 2.4);
    it.nodes.orb.position.y = HOVER + ORB_R + 0.07 * bob;
    const g = 0.88 + 0.24 * cyc(t, tics);
    it.ou.uGlow.value = g; it.ou.uTime.value = t % WRAP;
    it.fu.uGlow.value = g * (1 - 0.12 * bob);
  } };
}
DEFS.soulsphere = sphere([0.03, 0.08, 0.45], [0.12, 0.4, 1.5], [0.8, 1.5, 3.5], [0.2, 0.5, 1.8], 36);
DEFS.megasphere = sphere([0.42, 0.24, 0.03], [1.5, 1.05, 0.22], [3.6, 3.0, 1.4], [1.7, 1.1, 0.25], 24);

// ------------------------------------------------------------ keycards ----
function keycard(hex) {
  const body = spec(hex, 0.1, 0.34, PAT.blink, 0.3), line = spec(hex, 0, 0.4, PAT.blink, 3.2);
  const white = spec('#eeeeea', 0, 0.4, PAT.blink, 0.1), ink = spec('#161616', 0, 0.5), glowCol = new THREE.Color(hex).toArray();
  return { build() {
    node('spin');
    const W = 0.34, H = 0.5, T = 0.03, cy = 0.14 + H / 2;
    const sh = rrect(W, H, 0.035);
    sh.holes.push(rrect(0.1, 0.03, 0.015, 0, H / 2 - 0.05, new THREE.Path()));
    add(G.ext(sh, T, 0.005, 6), body, [0, cy, 0]);
    for (const s of [-1, 1]) {
      push(xf([0, cy, s * (T / 2 + 0.0015)], [0, s < 0 ? Math.PI : 0, 0]));
      // glowing frame
      const fw = W - 0.05, fh = H - 0.05, lw = 0.009;
      add(G.plane(fw, lw), line, [0, fh / 2, 0]); add(G.plane(fw, lw), line, [0, -fh / 2, 0]);
      add(G.plane(lw, fh), line, [fw / 2, 0, 0]); add(G.plane(lw, fh), line, [-fw / 2, 0, 0]);
      if (s > 0) {
        add(G.plane(0.26, 0.05), white, [0, 0.12, 0]);
        add(G.rbox(0.075, 0.06, 0.004, 0.012, 1), S.gold, [-0.075, 0.025, 0]);
        add(G.tor(0.026, 0.008, Math.PI * 2, 14, 4), white, [0.07, 0.045, 0]);
        add(G.plane(0.013, 0.08), white, [0.07, -0.018, 0]);
        add(G.plane(0.022, 0.01), white, [0.085, -0.05, 0]); add(G.plane(0.016, 0.01), white, [0.082, -0.03, 0]);
        for (const [y, w] of [[-0.1, 0.22], [-0.13, 0.15], [-0.16, 0.19]]) add(G.plane(w, 0.012), ink, [-0.11 + w / 2, y, 0]);
      } else {
        add(G.plane(0.06, 0.42), ink, [-0.09, -0.01, 0]);
        add(G.plane(0.13, 0.06), white, [0.06, -0.13, 0]);
      }
      pop();
    }
    shadow(0.1, 0.04, { soft: 0.14, dark: 0.45 });
    pool(0.55, glowCol, { ch: 2, k: 0.55 });
    halo(cy, 0.52, glowCol, { ch: 2, k: 0.75, fade: 0.28 });
  }, anim(it, t) {
    // Doom blinks keys 10 tics on, 10 off: a softened square wave; the card turns so it never stays edge-on
    const on = smooth(-0.35, 0.35, Math.sin(t * Math.PI * 2 / (20 * TIC)));
    it.su.uBlink.value = 0.45 + 0.55 * on;
    it.fu.uBlink.value = 0.4 + 0.6 * on;
    const bob = 0.03 * Math.sin(t * 2.1);
    it.nodes.spin.rotation.y = t * 1.3;
    it.nodes.spin.position.y = bob;
    it.fu.uLift.value = bob;
  } };
}
DEFS.keyBlue = keycard('#1f63ff');
DEFS.keyYellow = keycard('#ffc21a');
DEFS.keyRed = keycard('#e8141b');

// ------------------------------------------------------------ assembly ----
const CACHE = {};
function geometry(type) {
  if (CACHE[type]) return CACHE[type];
  B = { nodes: {}, fx: { pos: [], uv: [], col: [], fx: [], idx: [], reach: 0 }, orb: null };
  STACK.length = 1;
  node('base');
  DEFS[type].build();
  const out = { nodes: [], fx: null, orb: B.orb, tris: B.orb ? 2 : 0 };   // the orb is one shared quad
  for (const [name, n] of Object.entries(B.nodes)) {
    const std = n.std.length ? mergeGeometries(n.std) : null, glass = n.glass.length ? mergeGeometries(n.glass) : null;
    for (const g of [std, glass]) if (g) { g.computeBoundingSphere(); out.tris += g.attributes.position.count / 3; }
    out.nodes.push({ name, std, glass });
  }
  const F = B.fx;
  if (F.pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(F.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(F.uv, 2));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(F.col, 3));
    g.setAttribute('aFx', new THREE.Float32BufferAttribute(F.fx, 4));
    g.setIndex(F.idx);
    g.computeBoundingSphere();
    g.boundingSphere.radius += F.reach + 0.1;   // halos are expanded in the vertex shader
    out.fx = g; out.tris += F.idx.length / 3;
  }
  B = OUT = null;
  return (CACHE[type] = out);
}
function mesh(g, m) { const o = new THREE.Mesh(g, m); o.onBeforeRender = adapt; return o; }
const WARNED = new Set();

// World-space pickup (feet): origin at the floor contact, centred on x/z. Place it with position / rotation.y only;
// the idle animation moves its children.
export function buildItem(type) {
  const root = new THREE.Group();
  root.name = 'item:' + type;
  const def = DEFS[type];
  if (!def) {
    if (!WARNED.has(type)) { WARNED.add(type); console.warn('itemmodels: unknown item type', type); }
    return root;
  }
  const geo = geometry(type), lit = litMaterial();
  const it = { type, anim: def.anim || null, su: lit.userData.u, fu: null, ou: null, nodes: {} };
  for (const n of geo.nodes) {
    let g = root;
    if (n.name !== 'base') { g = new THREE.Group(); g.name = n.name; root.add(g); }
    it.nodes[n.name] = g;
    if (n.std) g.add(mesh(n.std, lit));
    if (n.glass) g.add(mesh(n.glass, glassMaterial()));
  }
  if (geo.orb) {
    const g = new THREE.Group(), m = orbMaterial(geo.orb);
    g.name = 'orb'; g.position.y = geo.orb.y;
    g.add(mesh(ORB_GEO, m)); root.add(g);
    it.nodes.orb = g; it.ou = m.uniforms;
  }
  if (geo.fx) { const m = fxMaterial(); root.add(mesh(geo.fx, m)); it.fu = m.uniforms; }
  root.userData.item = it;
  if (it.anim) it.anim(it, 0);
  return root;
}

// Optional, once a frame: the scene luminance that reads as mid grey (the house's exposure key / exposure), exactly what
// fx.setAmbient() takes. Glows adapt to it (ITEM_TUNING); without it they follow the renderer's exposure.
export function setItemAmbient(v) { ambient = v > 0 ? v : 0; }

// Per-frame idle animation (glow pulses, blinking keys, sphere swirl and bob, armour sheen). time in seconds.
export function animateItem(group, time) {
  const it = group && group.userData.item;
  if (it && it.anim) it.anim(it, time);
}

// Assign the room's IBL to every lit material of an item.
export function setEnv(group, env) {
  env = env || null;
  if (group) group.traverse(o => {
    const m = o.material;
    if (!o.isMesh || !m || !m.isMeshStandardMaterial) return;
    if (!!m.envMap !== !!env) m.needsUpdate = true;
    m.envMap = env; m.envMapIntensity = 1;
  });
}

// Triangles of a type's shared geometry (for budgets and tests).
export function itemTriangles(type) { return DEFS[type] ? geometry(type).tris : 0; }
