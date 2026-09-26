// Synthesised sound effects and music: WebAudio only, no audio files.
// Every effect is a builder that schedules oscillators, filtered noise, waveshapers and envelopes into any
// BaseAudioContext. On unlock each builder is rendered once through an OfflineAudioContext into a mono buffer
// (normalised to its mix level, then lightly crushed to ~22 kHz / 10 bit for a 90s feel), so a sound in game costs
// one buffer source + gain + panner and pitch variation is free (playbackRate). dev/test-audio.html renders the same
// builders to measure them. The music is an original metal loop, synthesised and scheduled live with a lookahead clock.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------- tuning ----
const MAX_VOICES = 24;            // simultaneous effect voices (loops count but are never stolen)
const NAME_CAP = 4;               // default per-name cap; the oldest voice of that name is stolen
const NEAR = 6, FAR = 90;         // feet: full volume within NEAR, linear falloff to silence at FAR
const MAX_PAN = 0.8;
const SFX_GAIN = 0.8, MUSIC_GAIN = 0.24;   // bus gains at volume 1: the music sits ~7 dB under a pistol shot
// Master compressor: gentle glue on the music, limits pile-ups (SSG + rockets + screams) while single shots keep
// their transients; then OUT_GAIN and a soft clip that only engages above -2 dBFS.
const COMP = { threshold: -12, knee: 10, ratio: 8, attack: 0.002, release: 0.2 }, OUT_GAIN = 0.9;
const LATE_START = 0.3;           // a one-shot that had to wait (buffer not rendered, context not running) still plays if this fresh (s)
const LOOP_XF = 0.06;             // loop seam crossfade (s)
const BPM = 150, STEP = 60 / BPM / 4, BARS = 32;   // 16th-note step 0.1 s; 32 bars = 51.2 s loop
const LOOKAHEAD = 0.12, TICK_MS = 25;

// ------------------------------------------------------------- random ----
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; };
const vary = (r, a) => 1 + (r() - 0.5) * a;

// ---------------------------------------------------- node primitives ----
const gain = (c, v = 0) => { const g = c.createGain(); g.gain.value = v; return g; };
const biq = (c, type, f, q = 0.707, db = 0) => {
  const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.gain.value = db; return b;
};
const ch = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };

// Envelopes on an AudioParam; pts = [t0, v0, t1, v1, …] seconds after t, values times k.
function lin(p, t, pts, k = 1) {
  p.setValueAtTime(pts[1] * k, t + pts[0]);
  for (let i = 2; i < pts.length; i += 2) p.linearRampToValueAtTime(pts[i + 1] * k, t + pts[i]);
  return p;
}
function expo(p, t, pts, k = 1) {
  p.setValueAtTime(pts[1] * k, t + pts[0]);
  for (let i = 2; i < pts.length; i += 2) p.exponentialRampToValueAtTime(Math.max(1e-4, pts[i + 1] * k), t + pts[i]);
  return p;
}
// Percussive: ramp to peak, optional hold, then exponential decay with time constant tau.
function hit(p, t, peak, tau, atk = 0.001, hold = 0) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + atk);
  if (hold) p.setValueAtTime(peak, t + atk + hold);
  p.setTargetAtTime(0, t + atk + hold, tau);
  return p;
}

// Pulse waves (duty 25% = 'pulse', 10% = 'thin') as cached PeriodicWaves per context.
const waves = new WeakMap();
function pulseWave(c, duty) {
  let m = waves.get(c);
  if (!m) waves.set(c, (m = {}));
  if (!m[duty]) {
    const n = 48, re = new Float32Array(n), im = new Float32Array(n);
    for (let k = 1; k < n; k++) re[k] = Math.sin(Math.PI * k * duty) / k;
    m[duty] = c.createPeriodicWave(re, im);
  }
  return m[duty];
}
function osc(c, type, f, t, dur) {   // type: built-in name, 'pulse' / 'thin', or a PeriodicWave
  const o = c.createOscillator();
  if (type === 'pulse') o.setPeriodicWave(pulseWave(c, 0.25));
  else if (type === 'thin') o.setPeriodicWave(pulseWave(c, 0.1));
  else if (typeof type !== 'string') o.setPeriodicWave(type);
  else o.type = type;
  o.frequency.value = f;
  o.start(t); o.stop(t + dur);
  return o;
}

// Noise buffers (white, pink, brown, crackle = sparse clicks), generated once per sample rate, loop-seamless.
// AudioBuffers are not tied to a context, so the same buffers feed the offline renders and the live context.
const NOISE_SEC = 2.5;
const noises = new Map(), noiseRms = new Map();
function noiseBuf(kind, sr) {
  const key = kind + sr;
  let b = noises.get(key);
  if (b) return b;
  const n = Math.round(sr * NOISE_SEC), m = Math.round(sr * 0.05), r = rng(hash(kind));
  const d = new Float32Array(n + m);
  if (kind === 'pink') {
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n + m; i++) {
      const w = r() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = b0 + b1 + b2 + w * 0.1848;
    }
  } else if (kind === 'brown') {
    let v = 0;
    for (let i = 0; i < n + m; i++) { v = (v + 0.02 * (r() * 2 - 1)) / 1.02; d[i] = v; }
  } else if (kind === 'crackle') {
    const p = 110 / sr;
    for (let i = 0; i < n + m - 16; i++) if (r() < p) {
      const a = (0.25 + 0.75 * r()) * (r() < 0.5 ? -1 : 1);
      for (let k = 0; k < 16; k++) d[i + k] += a * Math.exp(-k / 3) * (k & 1 ? -0.6 : 1);
    }
  } else for (let i = 0; i < n + m; i++) d[i] = r() * 2 - 1;
  for (let i = 0; i < m; i++) { const w = i / m; d[i] = d[i] * w + d[n + i] * (1 - w); }   // seamless loop
  let pk = 0, e = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(d[i]));
  for (let i = 0; i < n; i++) { d[i] /= pk; e += d[i] * d[i]; }
  b = new AudioBuffer({ length: n, sampleRate: sr, numberOfChannels: 1 });
  b.copyToChannel(d.subarray(0, n), 0);
  noises.set(key, b); noiseRms.set(key, Math.sqrt(e / n));
  return b;
}
function noise(c, kind, t, dur, r, rate = 1) {
  const s = c.createBufferSource();
  s.buffer = noiseBuf(kind, c.sampleRate); s.loop = true; s.playbackRate.value = rate;
  s.start(t, r() * (NOISE_SEC - 0.5)); s.stop(t + dur);
  return s;
}
// Gain that brings a noise band [lo, hi] up to the loudness of a sine of amplitude 1 (so layer levels compare
// like for like however narrow the filter is). Crackle is scaled by its peaks instead (it is mostly silence).
function nlevel(kind, lo, hi, sr) {
  const nyq = sr / 2;
  hi = Math.max(hi, lo + 30);
  if (kind === 'crackle') return 0.6 / Math.sqrt(Math.min(1, (hi - lo) / nyq) + 0.02);
  noiseBuf(kind, sr);
  const fc = 0.00315 * sr;   // brown noise corner (leaky integrator pole)
  const frac = kind === 'white' ? (hi - lo) / nyq
    : kind === 'pink' ? Math.log(hi / Math.max(20, lo)) / Math.log(nyq / 20)
    : (Math.atan(hi / fc) - Math.atan(lo / fc)) / (Math.PI / 2);
  return Math.min(40, 0.7 / (noiseRms.get(kind + sr) * Math.sqrt(Math.max(1e-4, frac))));
}

// Waveshaper curves: tanh (normalised so ±1 → ±1), asym (tube-like, even harmonics), safe (identity then a
// soft knee; input pre-halved so it covers ±2).
const curves = new Map();
function curveOf(kind, k) {
  const key = kind + k;
  let cv = curves.get(key);
  if (cv) return cv;
  const n = 2049, nk = Math.tanh(k), na = Math.tanh(k * 0.7);
  cv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    if (kind === 'asym') cv[i] = x >= 0 ? Math.tanh(k * x) / nk : 0.9 * Math.tanh(k * 0.7 * x) / na;
    else if (kind === 'safe') { const u = Math.abs(2 * x); cv[i] = Math.sign(x) * (u < 0.8 ? u : 0.8 + 0.2 * Math.tanh((u - 0.8) / 0.2)); }
    else cv[i] = Math.tanh(k * x) / nk;
  }
  curves.set(key, cv);
  return cv;
}
function shaper(c, k, kind = 'tanh', os = '2x') {
  const s = c.createWaveShaper(); s.curve = curveOf(kind, k); s.oversample = os; return s;
}

// Small-room impulse response: early reflections + a decaying noise tail that darkens as it fades; unit energy.
const irs = new Map();
function irBuf(rt, sr) {
  const key = rt + ':' + sr;
  let b = irs.get(key);
  if (b) return b;
  const n = Math.ceil(sr * rt), d = new Float32Array(n), r = rng(hash('ir' + key)), pre = Math.round(sr * 0.011);
  let lp = 0, e = 0;
  for (let i = pre; i < n; i++) {
    const x = (i - pre) / (n - pre), a = 0.85 - 0.7 * x;
    lp += a * ((r() * 2 - 1) - lp);
    d[i] = lp * Math.sqrt((2 - a) / a) * Math.exp(-6.9 * (i - pre) / (sr * rt));
    e += d[i] * d[i];
  }
  for (const [ms, g] of [[4, 0.5], [8, -0.4], [13, 0.3], [19, -0.25]]) d[Math.round(sr * ms / 1000)] += g * Math.sqrt(e * 0.12);
  e = 0;
  for (let i = 0; i < n; i++) e += d[i] * d[i];
  const k = 1 / Math.sqrt(e);
  for (let i = 0; i < n; i++) d[i] *= k;
  b = new AudioBuffer({ length: n, sampleRate: sr, numberOfChannels: 1 });
  b.copyToChannel(d, 0);
  irs.set(key, b);
  return b;
}

// Amplitude modulator node: y = x·(1 − d/2 + d/2·lfo). d = 1 → full tremolo, d = 2 → ring modulation.
function am(c, t, dur, f, d, type = 'sine', f2 = 0) {
  const g = gain(c, 1 - d / 2), l = osc(c, type, f, t, dur);
  if (f2) expo(l.frequency, t, [0, f, dur, f2]);
  ch(l, gain(c, d / 2), g.gain);
  return g;
}

// ------------------------------------------------------ layer helpers ----
// Output stage of an effect: optional drive, filters and a small-room reverb send. Returns the input node.
function stage(c, out, o = {}) {
  const inp = gain(c, o.pre ?? (o.drive ? 0.45 : 1));
  let n = inp;
  if (o.drive) n = ch(n, shaper(c, o.drive, o.kind));
  if (o.hp) n = ch(n, biq(c, 'highpass', o.hp));
  if (o.lp) n = ch(n, biq(c, 'lowpass', o.lp));
  n.connect(out);
  if (o.verb) {
    const cv = c.createConvolver();
    cv.normalize = false; cv.buffer = irBuf(o.rt ?? 0.5, c.sampleRate);
    ch(n, cv, gain(c, o.verb), out);
  }
  return inp;
}
// Filtered noise layer. o: kind, hp, lp, f | fs (sweep points) with type/q, peak, tau/atk/hold or env, am [f, d, type].
function burst(c, out, t, r, o) {
  const kind = o.kind || 'white', atk = o.atk ?? 0.001, hold = o.hold ?? 0, tau = o.tau ?? 0.05;
  const dur = o.env ? o.env[o.env.length - 2] : atk + hold + tau * 7;
  let lo = 0, hi = c.sampleRate / 2, n = noise(c, kind, t, dur + 0.02, r, o.rate || 1);
  if (o.hp) { n = ch(n, biq(c, 'highpass', o.hp)); lo = o.hp; }
  if (o.lp) { n = ch(n, biq(c, 'lowpass', o.lp)); hi = Math.min(hi, o.lp * 1.1); }
  const f = o.f || (o.fs && o.fs[1]);
  if (f) {
    const type = o.type || 'bandpass', q = o.q ?? 1, b = biq(c, type, f, q);
    if (o.fs) expo(b.frequency, t, o.fs);
    n = ch(n, b);
    if (type === 'bandpass') { const bw = 1.57 * f / q; lo = Math.max(lo, f - bw / 2); hi = Math.min(hi, f + bw / 2); }
    else if (type === 'lowpass') hi = Math.min(hi, f * 1.1);
    else if (type === 'highpass') lo = Math.max(lo, f);
  }
  const k = (o.peak ?? 1) * nlevel(kind, lo, hi, c.sampleRate), g = gain(c);
  if (o.env) lin(g.gain, t, o.env, k); else hit(g.gain, t, k, tau, atk, hold);
  let v = ch(n, g);
  if (o.am) v = ch(v, am(c, t, dur, o.am[0], o.am[1], o.am[2]));
  v.connect(out);
  return g;
}
// Pitched thump (sine/triangle) with an exponential pitch drop f0 → f1 over pd seconds.
function thump(c, out, t, o) {
  const tau = o.tau ?? 0.06, atk = o.atk ?? 0.002, s = osc(c, o.type || 'sine', o.f0, t, atk + tau * 7 + 0.01);
  expo(s.frequency, t, [0, o.f0, o.pd ?? 0.08, o.f1 ?? o.f0]);
  const g = gain(c);
  hit(g.gain, t, o.peak ?? 1, tau, atk);
  ch(s, g, out);
  return g;
}
// Metallic ring: inharmonic sine partials, the higher ones quieter and shorter.
function ping(c, out, t, freqs, tau, peak) {
  freqs.forEach((f, i) => {
    const s = osc(c, 'sine', f, t, tau * 7 + 0.01), g = gain(c);
    hit(g.gain, t, peak / (1 + i * 0.5), tau / (1 + i * 0.4), 0.0005);
    ch(s, g, out);
  });
}
// Pitched note with a piecewise envelope.
function note(c, out, t, type, f, env, k = 1, cents = 0) {
  const s = osc(c, type, f, t, env[env.length - 2] + 0.01), g = gain(c);
  s.detune.value = cents;
  lin(g.gain, t, env, k);
  ch(s, g, out);
  return s;
}
// FM bell: sine carrier, inharmonic modulator whose index decays → chime.
function bell(c, out, t, f, tau, peak, ratio = 3.5) {
  const dur = tau * 7, car = osc(c, 'sine', f, t, dur), mod = osc(c, 'sine', f * ratio, t, dur), mg = gain(c), g = gain(c);
  expo(mg.gain, t, [0, f * 2.2, tau * 2, f * 0.05]);
  ch(mod, mg, car.frequency);
  hit(g.gain, t, peak, tau, 0.002);
  ch(car, g, out);
}
// Two-stroke firing: exhaust pop + low thud + a valve tick.
function pop(c, out, t, r, a) {
  burst(c, out, t, r, { kind: 'brown', f: 300, q: 2.2, peak: 0.9 * a, tau: 0.022 });
  thump(c, out, t, { f0: 72, f1: 52, pd: 0.03, peak: 0.6 * a, tau: 0.028 });
  burst(c, out, t, r, { f: 2400, q: 5, peak: 0.15 * a, tau: 0.005 });
}
// Door-hinge creak: stick-slip pulses (a thin pulse wave with a jittery rate) ringing wooden resonances.
function creak(c, out, t, r, dur, fpts, env, peak) {
  const x = osc(c, 'thin', fpts[1], t, dur), n = 40, cv = new Float32Array(n), av = new Float32Array(n);
  expo(x.frequency, t, fpts);
  let v = 0;
  for (let i = 0; i < n; i++) { cv[i] = v = v * 0.5 + (r() * 2 - 1) * 280; av[i] = 0.45 + 0.55 * r(); }
  x.detune.setValueCurveAtTime(cv, t, dur);
  const g = gain(c), jit = gain(c, 0), sum = gain(c, 1);
  lin(g.gain, t, env, peak);
  jit.gain.setValueCurveAtTime(av, t, dur);
  ch(x, g, jit);
  for (const [f, q, lv] of [[480, 7, 1], [1150, 9, 0.8], [2300, 11, 0.5], [3400, 12, 0.3]]) ch(jit, biq(c, 'bandpass', f, q), gain(c, lv), sum);
  ch(sum, gain(c, 4), out);
}

// Formant voice. Source: sawtooth glottis (+ sub-octave square, + an optional layered interval) with pitch contour
// f0, vibrato, random pitch drift, growl (vocal-fry AM) and ring modulation, overdriven harder the louder the
// envelope amp is (vocal effort: rough when loud, cleaner when soft). Then breath noise, formant bandpasses whose
// centre frequencies move along fm = [t0, [F1, F2, F3, F4], t1, […], …], the envelope and a light output grit.
// Driving the source rather than the output keeps the vowel resonances and the dynamics audible.
function voice(c, out, t, r, o) {
  const D = o.dur, oscs = [], src = gain(c, 1);
  if (o.vo) lin(src.gain, t, o.vo);
  const add = (type, mul, lv) => {
    const s = osc(c, type, o.f0[1] * mul, t, D);
    expo(s.frequency, t, o.f0, mul);
    ch(s, gain(c, lv), src);
    oscs.push(s);
  };
  add(o.wave || 'sawtooth', 1, 1);
  if (o.sub) add('square', 0.5, o.sub);
  if (o.layer) add('sawtooth', o.layer[0], o.layer[1]);
  if (o.vib) {
    const l = osc(c, 'sine', o.vib[0], t, D), g = gain(c, o.vib[1]);
    l.connect(g);
    for (const s of oscs) g.connect(s.detune);
  }
  if (o.jit) {
    const n = 24, cv = new Float32Array(n);
    let v = 0;
    for (let i = 0; i < n; i++) cv[i] = v = v * 0.6 + (r() * 2 - 1) * o.jit;
    for (const s of oscs) s.detune.setValueCurveAtTime(cv, t, D);
  }
  let v = src;
  if (o.growl) v = ch(v, am(c, t, D, o.growl[0], o.growl[1], 'triangle', o.growl[2]));
  if (o.ring) v = ch(v, am(c, t, D, o.ring[0], o.ring[1] * 2));
  if (o.drive) { const e = gain(c); lin(e.gain, t, o.amp, o.pre ?? 2); v = ch(v, e, shaper(c, o.drive)); }
  const mix = gain(c, 1), F = o.fm, bw = o.bw || [90, 110, 160, 200], fg = o.fg || [1, 0.5, 0.25, 0.15];
  v.connect(mix);
  if (o.breath) {
    const g = gain(c), bt = Array.isArray(o.breath) ? o.breath : [0, o.breath];
    lin(g.gain, t, bt, 0.15 * nlevel('white', F[1][0] - bw[0], F[1][0] + bw[0], c.sampleRate));
    ch(noise(c, 'white', t, D, r), g, mix);
  }
  const sum = gain(c, 1);
  for (let i = 0; i < F[1].length; i++) {
    const b = biq(c, 'bandpass', F[1][i], F[1][i] / bw[i]);
    b.frequency.setValueAtTime(F[1][i], t + F[0]);
    for (let k = 2; k < F.length; k += 2) b.frequency.linearRampToValueAtTime(F[k + 1][i], t + F[k]);
    ch(mix, b, gain(c, fg[i]), sum);
  }
  if (o.body) ch(mix, biq(c, 'lowpass', o.bodyF || 700), gain(c, o.body), sum);
  const a = gain(c);
  lin(a.gain, t, o.amp);
  let n = ch(sum, a);
  if (o.grit) n = ch(n, gain(c, o.grit[1] ?? 1), shaper(c, o.grit[0]));
  n.connect(out);
}

// ------------------------------------------------------------- sounds ----
// def(name, seconds, opts, build(c, out, t, rnd, len)). opts: lvl = normalised peak (dBFS), vars = rendered
// variants (picked at random), jit = random pitch spread (±fraction), cap = per-name voice cap, lofi = crush,
// loop = loop length (s) with pre = warm-up rendered before the loop window.
const DEFS = {}, KIT = {};
const mk = (table, name, dur, o, build) => {
  table[name] = { name, dur, build, lvl: -3, vars: 1, jit: 0, cap: NAME_CAP, lofi: 1, loop: 0, pre: 0, ...o };
};
const def = (...a) => mk(DEFS, ...a);
const kit = (...a) => mk(KIT, ...a);

// --- weapons ---
def('pistol', 0.45, { lvl: -1.5, vars: 3, jit: 0.03 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 2.2, lp: 9500, verb: 0.16, rt: 0.45 });
  burst(c, s, t, r, { hp: 1800, f: 3400, q: 0.8, peak: 0.8, tau: 0.006 });                        // supersonic crack
  burst(c, s, t, r, { fs: [0, 1200 * vary(r, 0.15), 0.09, 450], q: 0.9, peak: 1, tau: 0.028 });   // muzzle blast
  thump(c, s, t, { f0: 190, f1: 55, pd: 0.07, peak: 0.9, tau: 0.045 });                            // chest thump
  burst(c, s, t + 0.004, r, { kind: 'brown', lp: 900, peak: 0.45, atk: 0.006, tau: 0.08 });        // room
});
def('chaingun', 0.3, { lvl: -2, vars: 3, jit: 0.04 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 2.6, lp: 9000, verb: 0.1, rt: 0.35 });
  burst(c, s, t, r, { hp: 2000, f: 3800, q: 0.8, peak: 0.8, tau: 0.005 });
  burst(c, s, t, r, { fs: [0, 1400 * vary(r, 0.15), 0.06, 600], q: 1, peak: 1, tau: 0.018 });
  thump(c, s, t, { f0: 230, f1: 75, pd: 0.05, peak: 0.8, tau: 0.028 });
  burst(c, s, t + 0.003, r, { kind: 'brown', lp: 800, peak: 0.35, atk: 0.004, tau: 0.045 });
});
def('shotgun', 1.08, { lvl: -1, vars: 2, jit: 0.025 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 3, pre: 0.4, lp: 9000, verb: 0.2, rt: 0.6 });
  burst(c, s, t, r, { hp: 1200, f: 2600, q: 0.7, peak: 0.8, tau: 0.01 });
  burst(c, s, t, r, { type: 'lowpass', fs: [0, 6000, 0.25, 350], q: 0.5, peak: 1.2, atk: 0.002, tau: 0.07 });
  thump(c, s, t, { f0: 125, f1: 38, pd: 0.15, peak: 1.1, tau: 0.09 });
  thump(c, s, t, { type: 'triangle', f0: 70, f1: 34, pd: 0.2, peak: 0.5, tau: 0.15 });
  burst(c, s, t + 0.008, r, { kind: 'brown', lp: 500, peak: 0.8, atk: 0.01, tau: 0.16 });
  // pump, in step with the view model (shot at tic 3; pump back over tics 10–20, home over 24–34): the slide rasps
  // back into a "ka" at tic 20 (0.49 s), then forward into a "chunk" at tic 34 (0.89 s)
  const m = stage(c, o, { drive: 1.5, pre: 0.8, verb: 0.1, rt: 0.35 }), k = t + 17 / 35, u = t + 31 / 35;
  burst(c, m, k - 0.1, r, { fs: [0, 650, 0.1, 950], q: 2, env: [0, 0, 0.06, 1, 0.09, 0.6, 0.1, 0], peak: 0.15 });
  burst(c, m, k, r, { f: 2600, q: 3, peak: 0.45, tau: 0.006 });
  ping(c, m, k, [1850, 3100, 4700], 0.02, 0.16);
  burst(c, m, u - 0.1, r, { fs: [0, 950, 0.1, 700], q: 2, env: [0, 0, 0.06, 1, 0.09, 0.6, 0.1, 0], peak: 0.15 });
  burst(c, m, u, r, { f: 1300, q: 2, peak: 0.55, tau: 0.012 });
  thump(c, m, u, { f0: 190, f1: 110, pd: 0.03, peak: 0.45, tau: 0.02 });
  ping(c, m, u, [1400, 2650], 0.025, 0.12);
});
def('ssgFire', 1.05, { lvl: -0.5, vars: 2, jit: 0.02 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 4, pre: 0.35, lp: 8500, verb: 0.24, rt: 0.8 });
  for (const dt of [0, 0.011]) {   // both barrels, a hair apart
    burst(c, s, t + dt, r, { hp: 1000, f: 2200, q: 0.7, peak: 0.8, tau: 0.012 });
    burst(c, s, t + dt, r, { type: 'lowpass', fs: [0, 7000, 0.32, 260], q: 0.5, peak: 1.1, atk: 0.002, tau: 0.1 });
  }
  thump(c, s, t, { f0: 100, f1: 28, pd: 0.22, peak: 1.3, tau: 0.14 });
  thump(c, s, t, { type: 'triangle', f0: 58, f1: 25, pd: 0.3, peak: 0.6, tau: 0.2 });
  burst(c, s, t + 0.015, r, { kind: 'brown', lp: 420, peak: 1, atk: 0.015, tau: 0.25 });
});
def('ssgOpen', 0.35, { lvl: -4 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 1.6, pre: 0.7, verb: 0.12, rt: 0.35 });
  burst(c, s, t, r, { hp: 3000, peak: 0.6, tau: 0.003 });
  burst(c, s, t, r, { f: 1800, q: 2.5, peak: 0.7, tau: 0.012 });
  ping(c, s, t, [820, 2263, 4430], 0.05, 0.3);
  thump(c, s, t, { f0: 160, f1: 120, pd: 0.03, peak: 0.3, tau: 0.025 });
  burst(c, s, t + 0.055, r, { f: 3200, q: 3, peak: 0.45, tau: 0.004 });                  // latch lets go
  ping(c, s, t + 0.055, [1330, 3050], 0.03, 0.15);
});
def('ssgLoad', 0.4, { lvl: -5 }, (c, o, t, r) => {   // both shells seat within tics 38–45 (0.2 s)
  const s = stage(c, o, { drive: 1.4, pre: 0.8, verb: 0.1, rt: 0.35 });
  for (const dt of [0, 0.105]) {
    const u = t + dt;
    burst(c, s, u, r, { fs: [0, 3200, 0.07, 1900], q: 2.5, env: [0, 0, 0.015, 0.8, 0.06, 1, 0.075, 0], peak: 0.25 });   // brass sliding in
    burst(c, s, u + 0.075, r, { f: 700, q: 1.5, peak: 0.6, tau: 0.014 });                                              // seats
    thump(c, s, u + 0.075, { f0: 230, f1: 170, pd: 0.03, peak: 0.4, tau: 0.02 });
    ping(c, s, u + 0.075, [2400, 3900], 0.025, 0.12);
  }
});
def('ssgClose', 0.4, { lvl: -3.5 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 2.2, pre: 0.55, verb: 0.14, rt: 0.4 });
  burst(c, s, t, r, { hp: 2500, peak: 0.8, tau: 0.004 });
  burst(c, s, t, r, { f: 1100, q: 1.5, peak: 0.8, tau: 0.02 });
  thump(c, s, t, { f0: 150, f1: 70, pd: 0.05, peak: 0.7, tau: 0.045 });
  ping(c, s, t, [610, 1530, 2980, 4100], 0.06, 0.25);
  burst(c, s, t + 0.022, r, { f: 2800, q: 2, peak: 0.4, tau: 0.005 });
});
def('punch', 0.3, { lvl: -2, vars: 2, jit: 0.05 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 2.5, pre: 0.5, lp: 7000, verb: 0.1, rt: 0.35 });
  thump(c, s, t, { f0: 120, f1: 45, pd: 0.09, peak: 1, tau: 0.06 });
  burst(c, s, t, r, { kind: 'brown', lp: 600, peak: 0.8, atk: 0.003, tau: 0.05 });
  burst(c, s, t, r, { kind: 'pink', f: 350, q: 1, peak: 0.5, tau: 0.035 });
  burst(c, s, t, r, { f: 1400, q: 1.2, peak: 0.3, tau: 0.012 });
});
def('sawUp', 0.72, { lvl: -3 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 3.5, pre: 0.5, lp: 6000, verb: 0.08, rt: 0.3 });
  burst(c, s, t, r, { fs: [0, 800, 0.12, 1700], q: 3, env: [0, 0, 0.02, 1, 0.1, 0.7, 0.13, 0], peak: 0.2 });   // starter cord
  for (let tt = 0.03, iv = 0.12; tt < 0.36; tt += iv, iv *= 0.76) pop(c, s, t + tt, r, 1);                    // coughs, faster
  // catches: a buzz that revs up and settles toward idle
  const b = gain(c);
  lin(b.gain, t, [0.28, 0, 0.34, 0.5, 0.48, 0.9, 0.6, 0.6, 0.72, 0]);
  for (const [type, k] of [['sawtooth', 1], ['pulse', 1.01]]) {
    const x = osc(c, type, 30 * k, t + 0.28, 0.45);
    expo(x.frequency, t, [0.28, 30 * k, 0.48, 115 * k, 0.7, 75 * k]);
    ch(x, b);
  }
  ch(b, biq(c, 'bandpass', 800, 0.9), gain(c, 2), s);
});
def('sawIdle', 0, { lvl: -7, loop: 1, pre: 0.4 }, (c, o, t, r, D) => {
  const s = stage(c, o, { drive: 2.5, pre: 0.5, lp: 5200, verb: 0.08, rt: 0.3 });
  const N = 12, amps = [], jit = [];   // 12 firings per 1 s loop; the same lumpy pattern every loop
  for (let k = 0; k < N; k++) { amps.push(0.7 + 0.3 * r()); jit.push((r() - 0.5) * 0.012); }
  amps[5] *= 0.5; amps[10] *= 0.7;
  for (let k = 0; ; k++) {
    const tk = t + k / N + jit[k % N];
    if (tk > D) break;
    if (tk >= 0) pop(c, s, tk, r, amps[k % N]);
  }
  const h = osc(c, 'sawtooth', 48, t, D);   // engine hum: whole cycles per loop keep the seam clean
  ch(h, biq(c, 'lowpass', 280), gain(c, 0.12), s);
});
def('sawFull', 0, { lvl: -5, loop: 1, pre: 0.3 }, (c, o, t, r, D) => {
  const s = stage(c, o, { drive: 5, pre: 0.5, lp: 6500, hp: 60 });
  const src = gain(c, 1), vib = osc(c, 'sine', 7, t, D), vg = gain(c, 22), body = gain(c, 1);
  vib.connect(vg);
  for (const [type, f, lv] of [['sawtooth', 104, 1], ['pulse', 105, 0.6], ['square', 52, 0.35]]) {
    const x = osc(c, type, f, t, D);
    vg.connect(x.detune);
    ch(x, gain(c, lv), src);
  }
  ch(src, biq(c, 'bandpass', 900, 1.2), gain(c, 1.4), body);
  ch(src, biq(c, 'bandpass', 2400, 2), gain(c, 0.8), body);
  ch(src, biq(c, 'lowpass', 400), gain(c, 0.6), body);
  body.connect(s);
  burst(c, s, t, r, { hp: 2500, f: 4000, q: 0.8, env: [0, 1, D, 1], peak: 0.25, am: [104, 1.6, 'sawtooth'] });   // chain teeth
});
def('sawHit', 0.5, { lvl: -2, vars: 2, jit: 0.04 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 3, pre: 0.5, lp: 7000, verb: 0.1, rt: 0.35 }), E = [0, 0, 0.01, 1, 0.3, 0.8, 0.5, 0];
  const b = gain(c);
  lin(b.gain, t, E, 0.8);
  for (const [type, f, lv] of [['sawtooth', 150, 1], ['square', 75, 0.5]]) {
    const x = osc(c, type, f, t, 0.5);
    expo(x.frequency, t, [0, f, 0.5, f * 0.88]);
    ch(x, gain(c, lv), b);
  }
  ch(b, am(c, t, 0.5, 311, 1), gain(c, 2), shaper(c, 6), biq(c, 'bandpass', 1200, 0.8), s);   // metallic grit
  burst(c, s, t, r, { f: 1800, q: 2, env: E, peak: 0.7, am: [35, 1.8, 'square'] });                  // tearing
  burst(c, s, t, r, { f: 2500, q: 1, peak: 0.8, tau: 0.02 });
  thump(c, s, t, { f0: 140, f1: 80, pd: 0.04, peak: 0.6, tau: 0.03 });
});
def('rocketFire', 1.0, { lvl: -2, vars: 2, jit: 0.03 }, (c, o, t, r) => {   // launch kick, then the motor whooshes away
  const s = stage(c, o, { drive: 2.5, pre: 0.5, verb: 0.2, rt: 0.6 });
  thump(c, s, t, { f0: 115, f1: 38, pd: 0.1, peak: 1.2, tau: 0.07 });
  burst(c, s, t, r, { hp: 2500, peak: 0.7, tau: 0.008 });                                                           // igniter crack
  burst(c, s, t, r, { f: 700, q: 1.2, peak: 0.9, tau: 0.03 });                                                       // chuff
  burst(c, s, t, r, { fs: [0, 900, 0.08, 2800, 0.5, 1100, 1.0, 500], q: 1.2, env: [0, 0, 0.02, 0.8, 0.1, 0.75, 0.4, 0.3, 1.0, 0] });   // whoosh
  burst(c, s, t, r, { kind: 'brown', lp: 600, env: [0, 0, 0.02, 0.9, 0.12, 0.65, 0.45, 0.25, 1.0, 0], am: [22, 1, 'triangle'] });      // motor
  burst(c, s, t, r, { hp: 4000, env: [0, 0, 0.01, 0.3, 0.3, 0.1, 0.9, 0] });                                                            // hiss
});
def('explode', 1.7, { lvl: -0.3, vars: 2, jit: 0.04 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 3.5, pre: 0.4, verb: 0.3, rt: 1 });
  burst(c, s, t, r, { hp: 900, peak: 1, tau: 0.015 });
  burst(c, s, t, r, { type: 'lowpass', fs: [0, 3500, 0.12, 1400, 0.8, 200], q: 0.6, peak: 1.3, atk: 0.004, tau: 0.25 });
  thump(c, s, t, { f0: 70, f1: 24, pd: 0.45, peak: 1.4, atk: 0.004, tau: 0.22 });
  burst(c, s, t, r, { kind: 'crackle', f: 2200, q: 0.8, env: [0, 0, 0.03, 0.9, 0.6, 0.4, 1.4, 0] });
  burst(c, s, t, r, { kind: 'brown', lp: 160, peak: 1, atk: 0.02, tau: 0.45 });
});
def('plasma', 0.3, { lvl: -3, vars: 2, jit: 0.04 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 2, pre: 0.6, lp: 11000, verb: 0.12, rt: 0.4 });
  const z = osc(c, 'sawtooth', 2600, t, 0.3), zg = gain(c);
  expo(z.frequency, t, [0, 2600, 0.14, 260]);
  lin(zg.gain, t, [0, 0, 0.003, 0.8, 0.05, 0.5, 0.22, 0]);
  ch(z, am(c, t, 0.3, 1330, 1.2), biq(c, 'bandpass', 1800, 0.7), zg, s);
  const car = osc(c, 'sine', 900, t, 0.3), mod = osc(c, 'sine', 210, t, 0.3), mg = gain(c, 700), cg = gain(c);
  expo(car.frequency, t, [0, 900, 0.15, 200]);
  ch(mod, mg, car.frequency);
  hit(cg.gain, t, 0.6, 0.06);
  ch(car, cg, s);
  burst(c, s, t, r, { hp: 5000, peak: 0.45, tau: 0.03 });
});
def('plasmaHit', 0.6, { lvl: -3, vars: 2, jit: 0.05 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 2, pre: 0.6, verb: 0.2, rt: 0.5 });
  burst(c, s, t, r, { kind: 'crackle', hp: 1500, env: [0, 0, 0.005, 1, 0.25, 0.4, 0.55, 0] });
  burst(c, s, t, r, { hp: 3000, peak: 0.6, atk: 0.004, tau: 0.1 });
  const z = osc(c, 'square', 1400, t, 0.4), zg = gain(c);
  expo(z.frequency, t, [0, 1400, 0.2, 150]);
  hit(zg.gain, t, 0.5, 0.08);
  ch(z, am(c, t, 0.4, 700, 1), zg, s);
  thump(c, s, t, { f0: 300, f1: 120, pd: 0.05, peak: 0.5, tau: 0.03 });
});
def('bfgFire', 1.75, { lvl: -0.5 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 2.5, pre: 0.45, lp: 10000, verb: 0.25, rt: 0.9 }), T = 0.85;
  // charge: a whine sweeping up with vibrato that speeds up, rising shimmer and crackle
  const w = gain(c), lfo = osc(c, 'sine', 6, t, T + 0.05), lg = gain(c, 45);
  lin(w.gain, t, [0, 0, 0.1, 0.25, 0.75, 0.8, T, 0.9, T + 0.02, 0]);
  expo(lfo.frequency, t, [0, 6, T, 30]);
  lfo.connect(lg);
  for (const [type, k, lv] of [['sawtooth', 1, 0.5], ['sine', 2, 0.6], ['square', 1.5, 0.2]]) {
    const x = osc(c, type, 160 * k, t, T + 0.05);
    expo(x.frequency, t, [0, 160 * k, T, 1500 * k]);
    lg.connect(x.detune);
    ch(x, gain(c, lv), w);
  }
  ch(w, biq(c, 'lowpass', 5000), s);
  burst(c, s, t, r, { fs: [0, 800, T, 6000], q: 4, env: [0, 0, 0.8, 1, T + 0.01, 0], peak: 0.35 });
  burst(c, s, t, r, { kind: 'crackle', hp: 2500, env: [0, 0, 0.4, 0.3, T, 1, T + 0.02, 0], peak: 0.5 });
  // release
  const u = t + T, z = osc(c, 'sawtooth', 1100, u, 0.9), zg = gain(c);
  thump(c, s, u, { f0: 80, f1: 22, pd: 0.5, peak: 1.4, tau: 0.22 });
  burst(c, s, u, r, { type: 'lowpass', fs: [0, 5000, 0.3, 300], q: 0.5, peak: 1.2, tau: 0.16 });
  expo(z.frequency, u, [0, 1100, 0.45, 55]);
  hit(zg.gain, u, 0.9, 0.2);
  ch(z, am(c, u, 0.9, 97, 1.4), biq(c, 'lowpass', 3000), zg, s);
  burst(c, s, u, r, { kind: 'crackle', hp: 2000, peak: 0.6, tau: 0.3 });
});
def('bfgExplode', 2.3, { lvl: -0.2 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 4, pre: 0.4, verb: 0.35, rt: 1.4 });
  burst(c, s, t, r, { hp: 700, peak: 1, tau: 0.02 });
  burst(c, s, t, r, { type: 'lowpass', fs: [0, 3000, 0.2, 900, 1.5, 90], q: 0.6, peak: 1.3, atk: 0.005, tau: 0.4 });
  thump(c, s, t, { f0: 55, f1: 18, pd: 0.8, peak: 1.5, tau: 0.45 });
  // electric growl: FM sawtooth, ring modulated
  const g = osc(c, 'sawtooth', 110, t, 2.3), m = osc(c, 'sine', 37, t, 2.3), mg = gain(c, 90), gg = gain(c);
  expo(g.frequency, t, [0, 110, 1.5, 45]);
  ch(m, mg, g.frequency);
  hit(gg.gain, t, 0.7, 0.5, 0.01);
  ch(g, am(c, t, 2.3, 173, 1), biq(c, 'lowpass', 1500), gg, s);
  const z = osc(c, 'square', 2400, t, 1.8), zg = gain(c);
  expo(z.frequency, t, [0, 2400, 0.6, 80]);
  hit(zg.gain, t, 0.4, 0.25);
  ch(z, am(c, t, 1.8, 520, 2), zg, s);
  burst(c, s, t, r, { kind: 'crackle', f: 4000, q: 0.6, env: [0, 0, 0.02, 1, 1.2, 0.3, 2.2, 0] });
});

// --- player (a man's grunts: formant voice, lightly driven) ---
def('playerPain', 0.42, { lvl: -3, vars: 2, jit: 0.03 }, (c, o, t, r) => {
  voice(c, o, t, r, { dur: 0.42, f0: [0, 150, 0.05, 168, 0.18, 128, 0.42, 95], sub: 0.22, jit: 30, growl: [34, 0.3],
    breath: 0.25, fm: [0, [640, 1190, 2390, 3300], 0.25, [600, 1100, 2350, 3300], 0.42, [520, 1000, 2300, 3200]],
    body: 0.25, drive: 1.8, pre: 3, amp: [0, 0, 0.012, 1, 0.09, 0.9, 0.24, 0.35, 0.42, 0] });
});
def('playerDeath', 1.55, { lvl: -2 }, (c, o, t, r) => {
  voice(c, o, t, r, { dur: 1.55, f0: [0, 185, 0.08, 205, 0.35, 180, 0.7, 150, 1.0, 118, 1.3, 88, 1.55, 68],
    sub: 0.3, vib: [5.5, 35], jit: 40, growl: [30, 0.3, 16], breath: [0, 0.2, 1.0, 0.3, 1.5, 0.8],
    fm: [0, [760, 1150, 2500, 3400], 0.5, [700, 1100, 2450, 3350], 0.9, [540, 900, 2400, 3300], 1.3, [460, 840, 2300, 3200],
      1.55, [420, 800, 2250, 3200]],
    body: 0.3, drive: 2.2, pre: 3, amp: [0, 0, 0.04, 1, 0.3, 0.85, 0.5, 1, 0.9, 0.75, 1.25, 0.35, 1.55, 0] });
});
def('noWay', 0.32, { lvl: -5, jit: 0.02 }, (c, o, t, r) => {   // "oof"
  voice(c, o, t, r, { dur: 0.24, f0: [0, 132, 0.12, 118, 0.24, 100], sub: 0.15, jit: 20, breath: 0.3,
    fm: [0, [330, 800, 2250, 3200], 0.24, [350, 850, 2250, 3200]], body: 0.35, drive: 1.5, pre: 3,
    amp: [0, 0, 0.015, 1, 0.1, 0.85, 0.17, 0.3, 0.22, 0] });
  burst(c, o, t + 0.15, r, { hp: 1800, lp: 7500, env: [0, 0, 0.03, 1, 0.16, 0], peak: 0.12 });
});
def('playerLand', 0.26, { lvl: -9, jit: 0.03 }, (c, o, t, r) => {   // "hup": breathy h, short vowel, lips close
  voice(c, o, t, r, { dur: 0.2, f0: [0, 140, 0.2, 118], sub: 0.1, breath: [0, 1.2, 0.05, 1, 0.07, 0.15],
    vo: [0, 0, 0.045, 0, 0.065, 1], fm: [0, [440, 1020, 2240, 3100]], body: 0.3, drive: 1.3, pre: 3,
    amp: [0, 0, 0.02, 0.5, 0.05, 0.6, 0.07, 1, 0.15, 0.85, 0.165, 0] });
  burst(c, o, t + 0.19, r, { f: 1500, q: 0.8, peak: 0.1, tau: 0.01 });
});

// --- pickups and UI ---
def('itemUp', 0.16, { lvl: -4 }, (c, o, t) => {
  const s = stage(c, o, { lp: 7000 });
  note(c, s, t, 'pulse', 1318.5, [0, 0, 0.003, 0.6, 0.045, 0.45, 0.07, 0]);
  note(c, s, t + 0.055, 'pulse', 1760, [0, 0, 0.003, 0.6, 0.05, 0.45, 0.1, 0]);
});
def('weaponUp', 0.62, { lvl: -4 }, (c, o, t, r) => {
  const m = stage(c, o, { drive: 1.5, pre: 0.8, verb: 0.1, rt: 0.35 });
  burst(c, m, t, r, { f: 2200, q: 2, peak: 0.6, tau: 0.008 });
  ping(c, m, t, [1700, 2900], 0.02, 0.2);
  burst(c, m, t + 0.01, r, { f: 1200, q: 1.5, env: [0, 0, 0.02, 1, 0.06, 0], peak: 0.25 });
  burst(c, m, t + 0.09, r, { f: 1600, q: 2, peak: 0.7, tau: 0.01 });
  thump(c, m, t + 0.09, { f0: 220, f1: 150, pd: 0.03, peak: 0.4, tau: 0.02 });
  ping(c, m, t + 0.09, [1250, 2600], 0.025, 0.15);
  // rising power chord, strummed upward
  const s = stage(c, o, { drive: 1.6, pre: 0.6, lp: 3500, verb: 0.18, rt: 0.5 });
  [196, 293.7, 392, 587.3].forEach((f, i) => {
    const u = t + 0.16 + i * 0.03, end = 0.44 - i * 0.03;
    for (const dt of [-6, 6]) note(c, s, u, 'sawtooth', f, [0, 0, 0.005, 0.3, 0.2, 0.2, end, 0], 1, dt);
  });
});
def('powerUp', 1.1, { lvl: -5, lofi: 0 }, (c, o, t, r) => {
  const st = stage(c, o, { verb: 0.35, rt: 1.1 }), trem = am(c, t, 1.1, 13, 0.5);
  trem.connect(st);
  [440, 554.4, 659.3, 880, 1108.7, 1318.5, 1760].forEach((f, i) => {
    const u = t + i * 0.07, tail = 1.05 - i * 0.07;
    for (const dt of [-8, 8]) note(c, trem, u, 'triangle', f, [0, 0, 0.004, 0.3, tail * 0.4, 0.12, tail, 0], 1, dt);
    note(c, trem, u, 'sine', f * 2, [0, 0, 0.003, 0.12, 0.25, 0], 1);
  });
  burst(c, st, t, r, { hp: 6000, env: [0, 0, 0.1, 0.08, 0.7, 0.05, 1.0, 0] });
});
def('secret', 2.0, { lvl: -5, lofi: 0 }, (c, o, t) => {
  const s = stage(c, o, { verb: 0.45, rt: 1.5 });
  [[0, 587.3], [0.2, 830.6], [0.4, 1108.7]].forEach(([dt, f]) => bell(c, s, t + dt, f, 0.5, 0.5));   // tritone + major 7th
  note(c, s, t, 'sine', 73.4, [0, 0, 0.3, 0.25, 1.9, 0]);
});
def('menuMove', 0.09, { lvl: -3 }, (c, o, t, r) => {   // cursor tick-tock: crisp click with a small knock under it
  burst(c, o, t, r, { f: 2600, q: 3, peak: 0.8, tau: 0.004 });
  thump(c, o, t, { f0: 1900, peak: 0.3, tau: 0.008 });
  thump(c, o, t, { f0: 540, f1: 440, pd: 0.02, peak: 0.45, tau: 0.012 });
  burst(c, o, t + 0.028, r, { f: 1700, q: 3, peak: 0.5, tau: 0.004 });
});
def('menuSelect', 0.22, { lvl: -5 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 2.2, pre: 0.5, verb: 0.08, rt: 0.3 });
  burst(c, s, t, r, { f: 1300, q: 0.9, peak: 0.9, tau: 0.018 });
  thump(c, s, t, { f0: 240, f1: 80, pd: 0.05, peak: 0.8, tau: 0.03 });
  burst(c, s, t, r, { hp: 2500, peak: 0.6, tau: 0.004 });
  burst(c, s, t, r, { kind: 'brown', lp: 800, peak: 0.3, tau: 0.04 });
});
def('menuBack', 0.12, { lvl: -5 }, (c, o, t, r) => {
  thump(c, o, t, { f0: 620, f1: 520, pd: 0.02, peak: 0.7, tau: 0.012 });
  burst(c, o, t, r, { f: 800, q: 2, peak: 0.4, tau: 0.006 });
  thump(c, o, t + 0.045, { f0: 430, f1: 380, pd: 0.02, peak: 0.6, tau: 0.015 });
  burst(c, o, t + 0.045, r, { f: 600, q: 2, peak: 0.3, tau: 0.006 });
});
def('menuSlider', 0.05, { lvl: -4 }, (c, o, t, r) => {
  burst(c, o, t, r, { f: 3400, q: 5, peak: 0.6, tau: 0.003 });
  thump(c, o, t, { f0: 1250, peak: 0.5, tau: 0.007 });
});
def('tally', 0.09, { lvl: -4.5, cap: 2 }, (c, o, t, r) => {   // typewriter key
  burst(c, o, t, r, { hp: 2000, peak: 0.9, tau: 0.0025 });
  burst(c, o, t, r, { f: 850, q: 1.5, peak: 0.6, tau: 0.01 });
  thump(c, o, t, { f0: 3200, peak: 0.15, tau: 0.012 });
  thump(c, o, t, { f0: 180, peak: 0.3, tau: 0.01 });
});
def('tallyDone', 0.7, { lvl: -3 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 3, pre: 0.45, verb: 0.2, rt: 0.6 });
  burst(c, s, t, r, { hp: 1000, peak: 0.9, tau: 0.01 });
  burst(c, s, t, r, { type: 'lowpass', fs: [0, 3000, 0.3, 250], q: 0.6, peak: 1.1, tau: 0.1 });
  thump(c, s, t, { f0: 85, f1: 32, pd: 0.2, peak: 1.2, tau: 0.12 });
});

// --- world ---
const latch = (c, s, t, r) => {
  burst(c, s, t, r, { hp: 2500, peak: 0.6, tau: 0.003 });
  ping(c, s, t, [2350, 3900, 5100], 0.02, 0.2);
  burst(c, s, t + 0.03, r, { f: 1400, q: 2, peak: 0.5, tau: 0.008 });
};
def('doorOpen', 1.1, { lvl: -4, vars: 2, jit: 0.03 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 1.4, pre: 0.8, verb: 0.15, rt: 0.5 });
  latch(c, s, t, r);
  creak(c, s, t + 0.12, r, 0.9, [0, 55, 0.25, 120, 0.55, 85, 0.9, 140], [0, 0, 0.08, 0.8, 0.4, 1, 0.7, 0.6, 0.9, 0], 1);
});
def('doorClose', 0.8, { lvl: -3, vars: 2, jit: 0.03 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 1.8, pre: 0.6, verb: 0.18, rt: 0.5 });
  creak(c, s, t, r, 0.36, [0, 130, 0.2, 70, 0.36, 50], [0, 0, 0.04, 0.8, 0.3, 0.6, 0.36, 0], 0.8);
  const u = t + 0.4;   // slam into the frame, latch catches
  thump(c, s, u, { f0: 110, f1: 55, pd: 0.06, peak: 1, tau: 0.06 });
  burst(c, s, u, r, { kind: 'brown', lp: 700, peak: 0.8, tau: 0.05 });
  burst(c, s, u, r, { f: 1800, q: 1, peak: 0.4, tau: 0.01 });
  burst(c, s, u + 0.02, r, { hp: 3000, peak: 0.5, tau: 0.003 });
  ping(c, s, u + 0.02, [2600, 4200], 0.02, 0.2);
});
def('garage', 3.25, { lvl: -6 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 1.6, pre: 0.6, verb: 0.15, rt: 0.6 }), E = [0, 0, 0.25, 1, 2.85, 1, 3.1, 0];
  const clunk = u => {
    thump(c, s, u, { f0: 90, f1: 60, pd: 0.05, peak: 0.8, tau: 0.06 });
    burst(c, s, u, r, { kind: 'brown', lp: 500, peak: 0.6, tau: 0.05 });
    burst(c, s, u, r, { f: 1500, q: 2, peak: 0.3, tau: 0.01 });
  };
  clunk(t); clunk(t + 3.05);
  const m = gain(c), w = osc(c, 'sine', 300, t, 3.15), wg = gain(c);
  lin(m.gain, t, E, 0.5);
  for (const [type, f, lv] of [['sawtooth', 60, 1], ['sawtooth', 120.5, 0.6], ['square', 30, 0.4]]) ch(osc(c, type, f, t, 3.15), gain(c, lv), m);
  ch(m, biq(c, 'lowpass', 380), s);
  expo(w.frequency, t, [0, 300, 0.4, 420, 2.85, 432, 3.1, 300]);   // motor whine
  lin(wg.gain, t, E, 0.12);
  ch(w, wg, s);
  burst(c, s, t, r, { f: 1100, q: 2.5, env: E, peak: 0.28, am: [9, 1.6, 'square'] });                                 // chain
  burst(c, s, t, r, { kind: 'brown', lp: 220, env: [0.1, 0, 0.5, 1, 2.85, 1, 3.1, 0], peak: 0.5, am: [3.3, 0.5] });   // panels
});
def('telefog', 1.35, { lvl: -3 }, (c, o, t, r) => {
  const s = stage(c, o, { verb: 0.35, rt: 1 }), D = 1.35, E = [0, 0, 0.15, 0.8, 0.6, 1, D, 0];
  for (const lf of [4, 6.5]) {   // two swirling resonant sweeps
    const b = biq(c, 'bandpass', 400, 3), l = osc(c, 'sine', lf, t, D), lg = gain(c, 900), g = gain(c);
    expo(b.frequency, t, [0, 400, 0.7, 2500, D, 1200]);
    ch(l, lg, b.detune);
    lin(g.gain, t, E, 0.6 * nlevel('white', 300, 900, c.sampleRate));
    ch(noise(c, 'white', t, D, r), b, g, s);
  }
  [1320, 1760, 2217, 2637].forEach((f, i) => {   // shimmer
    const x = osc(c, 'sine', f, t, D), wob = osc(c, 'sine', 11 + i * 1.7, t, D), g = gain(c);
    expo(x.frequency, t, [0, f, D, f * 1.12]);
    ch(wob, gain(c, 30), x.detune);
    lin(g.gain, t, [0, 0, 0.2, 0.12, 0.8, 0.14, D, 0]);
    ch(x, am(c, t, D, 16 + i * 2, 1.4), g, s);
  });
  burst(c, s, t, r, { kind: 'brown', type: 'lowpass', fs: [0, 200, 0.5, 700, D, 150], q: 0.7, env: [0, 0, 0.2, 0.6, 0.5, 0.7, D, 0] });
});

// --- imps: the children turned demonic ---
// Sawtooth voice + sub-octave square, growl AM (vocal-fry rattle), ring modulation for inhuman grit, a hard-driven
// source, formant bandpasses a bit under an adult man's (a big throat). Pitch stays under ~360 Hz so nothing reads
// as a child's voice; each imp plays the set at its own rate (girl ~1.15, boy ~0.9).
const IMP = { sub: 0.6, breath: 0.35, bw: [130, 170, 240, 320], fg: [1, 0.7, 0.4, 0.25], body: 0.25, drive: 4, pre: 2.5, grit: [2, 1.5], jit: 45 };
def('impSight1', 0.85, { lvl: -3, jit: 0.04 }, (c, o, t, r) => {
  burst(c, o, t, r, { f: 2500, q: 1, env: [0, 0, 0.03, 1, 0.1, 0], peak: 0.2 });   // hiss before the screech
  voice(c, o, t, r, { ...IMP, dur: 0.85, f0: [0, 140, 0.12, 250, 0.35, 330, 0.6, 270, 0.85, 180], layer: [1.41, 0.35],
    vib: [9, 40], growl: [42, 0.6], ring: [117, 0.35],
    fm: [0, [450, 900, 2100, 3000], 0.15, [720, 1150, 2300, 3200], 0.6, [640, 1000, 2200, 3100], 0.85, [480, 850, 2100, 3000]],
    amp: [0, 0, 0.03, 0.7, 0.12, 1, 0.55, 0.9, 0.85, 0] });
});
def('impSight2', 0.78, { lvl: -4.5, jit: 0.04 }, (c, o, t, r) => {   // two-part bark: "GRAAH — rrk"
  voice(c, o, t, r, { ...IMP, dur: 0.78, f0: [0, 230, 0.08, 300, 0.3, 170, 0.38, 190, 0.45, 240, 0.78, 105], sub: 0.5,
    growl: [55, 0.65], ring: [89, 0.4], breath: 0.4,
    fm: [0, [620, 1600, 2300, 3100], 0.3, [700, 1150, 2300, 3100], 0.4, [560, 1400, 2250, 3050], 0.78, [460, 850, 2150, 2950]],
    amp: [0, 0, 0.02, 1, 0.28, 0.8, 0.33, 0.12, 0.38, 0.9, 0.6, 0.6, 0.78, 0], drive: 6 });
});
def('impActive', 0.45, { lvl: -6, vars: 2, jit: 0.05 }, (c, o, t, r) => {   // snarl / chuff while hunting
  burst(c, o, t, r, { f: 700, q: 0.8, env: [0, 0, 0.015, 1, 0.09, 0], peak: 0.35 });
  voice(c, o, t + 0.03, r, { ...IMP, dur: 0.4, f0: [0, 82, 0.15, 96, 0.4, 68], sub: 0.8, growl: [27, 0.85], ring: [61, 0.3],
    breath: 0.6, fm: [0, [420, 800, 2100, 2900], 0.4, [380, 760, 2050, 2900]], amp: [0, 0, 0.04, 0.8, 0.22, 0.7, 0.4, 0] });
});
def('impPain', 0.32, { lvl: -5, vars: 2, jit: 0.04 }, (c, o, t, r) => {
  voice(c, o, t, r, { ...IMP, dur: 0.32, f0: [0, 290, 0.04, 360, 0.2, 220, 0.32, 170], sub: 0.45, growl: [58, 0.4], ring: [143, 0.35],
    fm: [0, [620, 1500, 2300, 3100], 0.2, [560, 1150, 2200, 3000], 0.32, [500, 1000, 2150, 3000]],
    amp: [0, 0, 0.008, 1, 0.1, 0.85, 0.32, 0] });
});
def('impDeath1', 1.1, { lvl: -2.5, jit: 0.03 }, (c, o, t, r) => {
  voice(c, o, t, r, { ...IMP, dur: 1.1, f0: [0, 320, 0.1, 340, 0.5, 200, 0.9, 95, 1.1, 70], vib: [7, 60], growl: [45, 0.6, 22],
    ring: [97, 0.4], breath: [0, 0.3, 1.1, 0.6],
    fm: [0, [800, 1250, 2500, 3300], 0.5, [650, 1000, 2400, 3200], 1.1, [450, 800, 2300, 3100]],
    amp: [0, 0, 0.03, 1, 0.4, 0.85, 0.8, 0.45, 1.1, 0] });
});
def('impDeath2', 1.25, { lvl: -3, jit: 0.03 }, (c, o, t, r) => {   // choked shriek, gurgling roar, rattling exhale
  const fm = [0, [760, 1350, 2500, 3300], 0.12, [640, 1150, 2400, 3200]];
  for (let k = 0, u = 0.2; u < 0.8; k++, u += 0.055) fm.push(u, k & 1 ? [430, 1500, 2400, 3150] : [620, 950, 2300, 3100]);   // throat floods and clears
  fm.push(1.0, [400, 800, 2250, 3050], 1.25, [360, 700, 2200, 3000]);
  voice(c, o, t, r, { ...IMP, dur: 1.25, f0: [0, 300, 0.07, 360, 0.16, 210, 0.3, 175, 0.75, 110, 1.0, 70, 1.25, 52],
    vib: [11, 90], growl: [16, 0.85, 9], ring: [71, 0.45], breath: [0, 0.25, 0.6, 0.35, 0.9, 1.1, 1.25, 0.8], fm,
    amp: [0, 0, 0.01, 1, 0.1, 0.9, 0.14, 0.25, 0.2, 0.95, 0.6, 0.8, 0.85, 0.45, 1.05, 0.3, 1.25, 0] });
});
def('claw', 0.4, { lvl: -4, vars: 2, jit: 0.06 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 2, pre: 0.6, verb: 0.1, rt: 0.35 });
  burst(c, s, t, r, { fs: [0, 500, 0.12, 3200, 0.2, 1400], q: 1.8, env: [0, 0, 0.08, 0.7, 0.14, 0.9, 0.2, 0] });   // swish
  burst(c, s, t + 0.13, r, { hp: 2800, peak: 0.8, tau: 0.015 });                                                  // slash
  burst(c, s, t + 0.13, r, { f: 1900, q: 3, env: [0, 0, 0.005, 0.6, 0.12, 0], am: [70, 1.6, 'square'] });         // tear
  burst(c, s, t + 0.14, r, { kind: 'brown', lp: 400, peak: 0.4, tau: 0.03 });
});
def('fireShoot', 0.6, { lvl: -3, vars: 2, jit: 0.05 }, (c, o, t, r) => {   // soft-onset "fwoom", flickering, crackling
  const s = stage(c, o, { drive: 2.5, pre: 0.5, verb: 0.15, rt: 0.45 });
  burst(c, s, t, r, { fs: [0, 350, 0.12, 1500, 0.5, 700], q: 0.9, env: [0, 0, 0.06, 0.9, 0.2, 0.75, 0.55, 0] });            // fwoom
  burst(c, s, t, r, { kind: 'pink', lp: 900, env: [0, 0, 0.05, 1, 0.22, 0.6, 0.55, 0], am: [14, 1.3, 'triangle'] });          // flame flutter
  burst(c, s, t, r, { kind: 'crackle', hp: 1500, env: [0, 0, 0.04, 0.8, 0.3, 0.6, 0.55, 0], peak: 1.4 });
  thump(c, s, t, { f0: 90, f1: 60, pd: 0.05, peak: 0.2, tau: 0.05, atk: 0.02 });
});
def('fireHit', 0.7, { lvl: -2, vars: 2, jit: 0.05 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 3, pre: 0.45, verb: 0.2, rt: 0.5 });
  thump(c, s, t, { f0: 130, f1: 50, pd: 0.08, peak: 0.9, tau: 0.05 });
  burst(c, s, t, r, { type: 'lowpass', fs: [0, 3500, 0.2, 500], q: 0.6, peak: 1, tau: 0.09 });
  burst(c, s, t, r, { kind: 'crackle', f: 2500, q: 0.7, env: [0, 0, 0.01, 1, 0.2, 0.5, 0.65, 0] });
  burst(c, s, t, r, { hp: 4500, peak: 0.4, atk: 0.005, tau: 0.12 });
});

// --- drum kit for the music (rendered like the effects) ---
const metal = (c, out, t, tau, peak, hp) => {   // six detuned squares through a highpass: cymbal metal
  const f = biq(c, 'highpass', hp, 0.7), g = gain(c);
  for (const m of [205.3, 304.4, 369.6, 522.7, 540, 800]) osc(c, 'square', m * 1.3, t, tau * 7 + 0.01).connect(f);
  hit(g.gain, t, peak / 6, tau, 0.0005);
  ch(f, g, out);
};
kit('kick', 0.4, { lvl: -1 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 1.8, pre: 0.6 });
  thump(c, s, t, { f0: 160, f1: 48, pd: 0.06, peak: 1, tau: 0.1 });
  thump(c, s, t, { type: 'triangle', f0: 90, f1: 45, pd: 0.08, peak: 0.4, tau: 0.08 });
  burst(c, s, t, r, { f: 3200, q: 1, peak: 0.35, tau: 0.004 });   // beater click so it cuts through the guitars
});
kit('snare', 0.35, { lvl: -2 }, (c, o, t, r) => {
  const s = stage(c, o, { drive: 1.6, pre: 0.6 });
  thump(c, s, t, { type: 'triangle', f0: 240, f1: 180, pd: 0.04, peak: 0.8, tau: 0.045 });
  thump(c, s, t, { f0: 340, f1: 300, pd: 0.03, peak: 0.3, tau: 0.03 });
  burst(c, s, t, r, { hp: 1500, f: 4000, q: 0.5, peak: 0.9, tau: 0.075 });
  burst(c, s, t, r, { f: 1200, q: 0.7, peak: 0.4, tau: 0.02 });
});
kit('hat', 0.15, { lvl: -3 }, (c, o, t, r) => {
  burst(c, o, t, r, { hp: 7000, f: 10000, q: 0.8, peak: 0.6, tau: 0.02 });
  metal(c, o, t, 0.02, 0.5, 7000);
});
kit('ohat', 0.6, { lvl: -3 }, (c, o, t, r) => {
  burst(c, o, t, r, { hp: 7000, f: 10000, q: 0.8, peak: 0.6, tau: 0.13 });
  metal(c, o, t, 0.12, 0.5, 7000);
});
kit('crash', 2.2, { lvl: -3 }, (c, o, t, r) => {
  burst(c, o, t, r, { hp: 4000, peak: 0.7, atk: 0.002, tau: 0.55 });
  burst(c, o, t, r, { f: 6000, q: 2, peak: 0.3, tau: 0.4 });
  metal(c, o, t, 0.5, 0.6, 5000);
});
for (const [name, f] of [['tomH', 170], ['tomM', 125], ['tomL', 90]]) {
  kit(name, 0.6, { lvl: -2 }, (c, o, t, r) => {
    const s = stage(c, o, { drive: 1.5, pre: 0.6 });
    thump(c, s, t, { f0: f * 1.4, f1: f, pd: 0.05, peak: 1, tau: 0.16 });
    thump(c, s, t, { type: 'triangle', f0: f * 1.4, f1: f, pd: 0.05, peak: 0.3, tau: 0.1 });
    burst(c, s, t, r, { lp: 1500, peak: 0.25, tau: 0.03 });
  });
}
kit('anvil', 0.5, { lvl: -3 }, (c, o, t, r) => {   // industrial clank
  const s = stage(c, o, { drive: 1.5, pre: 0.7 }), a = gain(c, 1);
  bell(c, a, t, 520, 0.12, 0.8, 1.41);
  ch(a, am(c, t, 0.5, 1370, 1.2), s);
  burst(c, s, t, r, { f: 3000, q: 2, peak: 0.5, tau: 0.01 });
});

// ---------------------------------------------------------- rendering ----
function crush(y, sr) {   // sample-and-hold to ~22 kHz, 10-bit steps
  const h = Math.max(1, Math.round(sr / 22050)), q = 512;
  for (let i = 0; i < y.length; i++) y[i] = i % h ? y[i - (i % h)] : Math.round(y[i] * q) / q;
}
async function renderDef(d, sr, variant) {
  const len = d.loop ? d.pre + d.loop + LOOP_XF : d.dur;
  const oc = new OfflineAudioContext(1, Math.ceil(len * sr), sr);
  const out = gain(oc, 1);
  ch(out, biq(oc, 'highpass', 18, 0.6), oc.destination);   // DC blocker (drive and brown noise leave some)
  d.build(oc, out, 0, rng(hash(d.name) + variant * 7919), len);
  const raw = (await oc.startRendering()).getChannelData(0);
  let rawPeak = 0, y;
  for (let i = 0; i < raw.length; i++) rawPeak = Math.max(rawPeak, Math.abs(raw[i]));
  if (d.loop) {   // take one period after the warm-up and crossfade the seam
    const P = Math.round(d.pre * sr), L = Math.round(d.loop * sr), X = Math.round(LOOP_XF * sr);
    y = raw.slice(P, P + L);
    for (let i = 0; i < X; i++) { const w = i / X; y[i] = raw[P + i] * w + raw[P + L + i] * (1 - w); }
  } else {        // trim the silent tail, short fade-out
    let end = raw.length;
    const th = rawPeak * 3e-4, f = Math.round(0.004 * sr);
    while (end > 1 && Math.abs(raw[end - 1]) < th) end--;
    y = raw.slice(0, Math.min(raw.length, end + f));
    for (let i = 0; i < Math.min(f, y.length); i++) y[y.length - 1 - i] *= i / f;
  }
  let pk = 0;
  for (let i = 0; i < y.length; i++) pk = Math.max(pk, Math.abs(y[i]));
  const k = pk > 0 ? Math.pow(10, d.lvl / 20) / pk : 0;
  for (let i = 0; i < y.length; i++) y[i] *= k;
  if (d.lofi) crush(y, sr);
  const buffer = new AudioBuffer({ length: y.length, sampleRate: sr, numberOfChannels: 1 });
  buffer.copyToChannel(y, 0);
  return { buffer, rawPeak };
}

export const SOUND_NAMES = Object.keys(DEFS);
export const KIT_NAMES = Object.keys(KIT);
export const LOOP_NAMES = SOUND_NAMES.filter(n => DEFS[n].loop);
// Render one effect (or drum) exactly as the game stores it: { buffer (mono AudioBuffer), rawPeak }.
export function renderSound(name, { sampleRate = 44100, variant = 0 } = {}) {
  const d = DEFS[name] || KIT[name];
  return d ? renderDef(d, sampleRate, variant) : Promise.reject(new Error('unknown sound: ' + name));
}

// -------------------------------------------------------------- music ----
// Original loop, E minor / phrygian, 150 BPM, 32 bars: verse riff ×2 (the second with double kick and an anvil),
// a half-time bridge in C–D–B♭–B with a lead melody, verse 3, and a drum fill back to the top.
const E2 = 82.407;
// Guitar/bass bar patterns: [16th step, length in steps, semitones above low E, palm-muted?]
const RIFF = {
  a: [[0, 2, 0, 0], [2, 1, 0, 1], [3, 1, 0, 1], [4, 1, 0, 1], [5, 1, 0, 1], [6, 2, 6, 0], [8, 1, 0, 1], [10, 1, 0, 1],
    [11, 1, 0, 1], [12, 2, 5, 0], [14, 1, 0, 1], [15, 1, 0, 1]],
  b: [[0, 2, 0, 0], [2, 1, 0, 1], [3, 1, 0, 1], [4, 2, 3, 0], [6, 1, 0, 1], [7, 1, 0, 1], [8, 4, 1, 0], [12, 1, 0, 1],
    [13, 1, 0, 1], [14, 1, 0, 1], [15, 1, 0, 1]],
  // turnaround: climbs G–A–B♭ to a held B that pulls back to E (a pedal E under a falling line would echo a
  // well-known game riff, so the line rises)
  c: [[0, 1, 0, 1], [1, 1, 0, 1], [2, 2, 3, 0], [4, 1, 0, 1], [5, 1, 0, 1], [6, 2, 5, 0], [8, 1, 0, 1], [9, 1, 0, 1],
    [10, 2, 6, 0], [12, 4, 7, 0]],
  d: [[0, 3, 0, 0], [3, 1, 0, 1], [4, 1, 0, 1], [5, 1, 0, 1], [6, 1, 1, 1], [7, 1, 1, 1], [8, 2, 3, 0], [10, 2, 1, 0], [12, 4, 0, 0]],
  e: [[0, 1, 0, 1], [1, 1, 0, 1], [2, 1, 0, 1], [3, 1, 0, 1], [4, 2, 6, 0], [6, 2, 5, 0], [8, 1, 0, 1], [9, 1, 0, 1],
    [10, 1, 0, 1], [11, 1, 0, 1], [12, 2, 3, 0], [14, 2, 1, 0]],
  f: [[0, 4, 0, 0], [4, 1, 0, 1], [5, 1, 0, 1], [6, 1, 0, 1], [7, 1, 0, 1], [8, 8, 1, 0]],
};
const bridge = R => [[0, 6, R, 0], [6, 1, R, 1], [7, 1, R, 1], [8, 6, R, 0], [14, 1, R, 1], [15, 1, R, 1]];
// Drum bar patterns, one char per 16th: X accent, x normal, o ghost; toms H/M/L.
const BEAT = {
  V: { kick: 'x..x..x.x.xx..x.', snare: '....x.......x...', hat: 'x.x.x.x.x.x.x.x.' },
  D: { kick: 'xoxoxoxoxoxoxoxo', snare: '....x.......x...', ohat: 'x...x...x...x...', anvil: '..............x.' },
  DF: { kick: 'xoxoxoxoxoxo....', snare: '....x.......oxxX', ohat: 'x...x...x.......' },
  H: { kick: 'x.....x...x.....', snare: '........x.......', ohat: 'x...x...x...x...' },
  HF: { kick: 'x.....x.x.x.x...', snare: '..............xX', ohat: 'x...x...........', tom: '........HHMMLL..' },
  F: { kick: 'x.xx..x.x.x.x.x.', snare: '....x...xx....xX', hat: 'x.x.x.x.........', tom: '..........HMLL..' },
};
// Lead melody for the bridge: [step, length, midi note]
const LEAD = [
  [[0, 8, 76], [8, 4, 79], [12, 4, 78]], [[0, 12, 76], [12, 4, 74]],
  [[0, 8, 78], [8, 4, 81], [12, 4, 79]], [[0, 8, 78], [8, 8, 74]],
  [[0, 8, 77], [8, 4, 74], [12, 4, 77]], [[0, 8, 79], [8, 4, 77], [12, 4, 74]],
  [[0, 12, 78], [12, 4, 75]], [[0, 8, 71]],
];
// Bar plan: [riff, beat, lead bar]
const SONG = [
  ['a', 'V'], ['b', 'V'], ['a', 'V'], ['c', 'V'], ['a', 'V'], ['b', 'V'], ['a', 'V'], ['d', 'V'],
  ['a', 'D'], ['b', 'D'], ['a', 'D'], ['c', 'D'], ['a', 'D'], ['b', 'D'], ['a', 'D'], ['d', 'DF'],
  [bridge(8), 'H', 0], [bridge(8), 'H', 1], [bridge(10), 'H', 2], [bridge(10), 'H', 3],
  [bridge(6), 'H', 4], [bridge(6), 'H', 5], [bridge(7), 'H', 6], [bridge(7), 'HF', 7],
  ['a', 'V'], ['b', 'V'], ['a', 'V'], ['c', 'V'], ['a', 'V'], ['b', 'V'], ['e', 'V'], ['f', 'F'],
];
const CRASH = new Set([0, 8, 16, 20, 24, 28]);
const KIT_MIX = { kick: 1, snare: 0.85, hat: 0.3, ohat: 0.26, crash: 0.42, tomH: 0.75, tomM: 0.75, tomL: 0.8, anvil: 0.35 };
const KIT_PAN = { kick: 0, snare: 0, hat: 0.3, ohat: 0.3, crash: -0.35, tomH: -0.3, tomM: 0, tomL: 0.3, anvil: 0.45 };
const TOMS = { H: 'tomH', M: 'tomM', L: 'tomL' };
const VEL = { X: 1, x: 0.85, o: 0.55 };
// Flatten the plan into one event list per 16th step so the scheduler does no searching.
const STEPS = [];
for (let bar = 0; bar < BARS; bar++) {
  const [riff, beat, lead] = SONG[bar], evs = typeof riff === 'string' ? RIFF[riff] : riff;
  for (let s = 0; s < 16; s++) {
    const list = [];
    for (const e of evs) if (e[0] === s) list.push(['g', e[2], e[1], e[3], s === 0 ? 1 : 0.85]);
    for (const k in BEAT[beat]) {
      const chr = BEAT[beat][k][s];
      if (chr !== '.') list.push(k === 'tom' ? ['d', TOMS[chr], 0.9] : ['d', k, VEL[chr]]);
    }
    if (s === 0 && CRASH.has(bar)) list.push(['d', 'crash', 1]);
    if (lead !== undefined) for (const e of LEAD[lead]) if (e[0] === s) list.push(['l', e[2], e[1]]);
    STEPS.push(list);
  }
}

// Guitar amp: tighten → asymmetric drive → mid scoop / presence → two-pole cabinet rolloff, panned. Two inputs:
// open notes through a fixed lowpass, palm-muted notes through a lowpass whose cutoff each chug sweeps down.
function ampChain(c, out, pan) {
  const inp = gain(c, 1), p = c.createStereoPanner(), open = biq(c, 'lowpass', 5200, 0.9), mute = biq(c, 'lowpass', 1700, 0.9);
  p.pan.value = pan;
  open.connect(inp); mute.connect(inp);
  ch(inp, biq(c, 'highpass', 120), gain(c, 6), shaper(c, 3, 'asym'), biq(c, 'highpass', 70), biq(c, 'peaking', 650, 0.9, -5),
    biq(c, 'peaking', 1900, 1.2, 4), biq(c, 'lowpass', 4800, 0.9), biq(c, 'lowpass', 6500, 0.6), gain(c, 0.22), p, out);
  return { open, mute };
}
// Fourier series of summed sawtooths (m = partial number over the wave's fundamental, lv = level), plus squares
// (sq); raw amplitudes, so a sum matches the separate oscillators it replaces.
function sumWave(c, saws, sq = []) {
  const n = 256, re = new Float32Array(n), im = new Float32Array(n);
  for (const [m, lv] of saws) for (let k = 1; k * m < n; k++) im[k * m] += lv * 2 / (k * Math.PI) * (k & 1 ? 1 : -1);
  for (const [m, lv] of sq) for (let k = 1; k * m < n; k += 2) im[k * m] += lv * 4 / (k * Math.PI);
  return c.createPeriodicWave(re, im, { disableNormalization: true });
}
function createSong(c, dest, kitBufs) {
  const S = { c, kit: kitBufs, out: gain(c, 0.85), dp: {} };
  S.out.connect(dest);
  // Power chords as one wave an octave under the root: root (2), fifth (3), octave (4) saws. Each note then costs
  // one oscillator + one gain per side; palm-muted notes share a lowpass per side whose cutoff each chug sweeps.
  S.wMute = sumWave(c, [[2, 1], [3, 1]]);
  S.wOpen = sumWave(c, [[2, 1], [3, 1], [4, 1]]);
  S.wBass = sumWave(c, [[1, 1]], [[1, 1]]);
  S.gtr = [ampChain(c, S.out, -0.6), ampChain(c, S.out, 0.6)];   // double-tracked rhythm guitars
  S.bass = gain(c, 1);
  S.bOpen = biq(c, 'lowpass', 900, 1); S.bMute = biq(c, 'lowpass', 1100, 1);
  S.bOpen.connect(S.bass); S.bMute.connect(S.bass);
  ch(S.bass, shaper(c, 1.5), biq(c, 'lowpass', 2200), gain(c, 0.5), S.out);
  S.lead = gain(c, 1);
  const lo = gain(c, 0.16), dl = c.createDelay(1), fb = gain(c, 0.3);
  ch(S.lead, biq(c, 'highpass', 200), gain(c, 3), shaper(c, 2.5), biq(c, 'peaking', 1300, 1, 4), biq(c, 'lowpass', 3800), lo, S.out);
  dl.delayTime.value = STEP * 3;
  ch(lo, dl, fb, dl);
  ch(dl, biq(c, 'lowpass', 2500), gain(c, 0.5), S.out);
  S.lfo = c.createOscillator();   // lead vibrato
  S.lfo.frequency.value = 5.6;
  S.vib = gain(c, 16);
  ch(S.lfo, S.vib);
  S.lfo.start();
  S.drums = gain(c, 0.9);
  S.drums.connect(S.out);
  const room = c.createConvolver();
  room.normalize = false; room.buffer = irBuf(0.7, c.sampleRate);
  ch(S.drums, room, gain(c, 0.2), S.out);
  for (const k in KIT_PAN) { const p = c.createStereoPanner(); p.pan.value = KIT_PAN[k]; ch(p, S.drums); S.dp[k] = p; }
  return S;
}
function gtr(S, t, semi, len, muted, vel) {
  const c = S.c, f = E2 * Math.pow(2, semi / 12), dur = len * STEP;
  for (let side = 0; side < 2; side++) {
    const ts = t + side * 0.006, g = gain(c), amp = S.gtr[side], o = osc(c, muted ? S.wMute : S.wOpen, f / 2, ts, muted ? 0.3 : dur + 0.06);
    o.detune.value = (side ? 5 : -5) + (Math.random() - 0.5) * 4;   // second take slightly sharp
    if (muted) { expo(amp.mute.frequency, ts, [0, 1700, 0.07, 380]); hit(g.gain, ts, vel * 0.8, 0.06, 0.002); }
    else lin(g.gain, ts, [0, 0, 0.004, vel, dur - 0.02, vel * 0.8, dur + 0.05, 0]);
    ch(o, g, muted ? amp.mute : amp.open);
  }
}
function bass(S, t, semi, len, muted, vel) {
  const c = S.c, f = E2 / 2 * Math.pow(2, semi / 12), dur = muted ? 0.13 : len * STEP, g = gain(c);
  if (muted) expo(S.bMute.frequency, t, [0, 1100, 0.08, 280]);
  lin(g.gain, t, [0, 0, 0.004, vel, dur, vel * 0.7, dur + 0.05, 0]);
  ch(osc(c, S.wBass, f, t, dur + 0.06), g, muted ? S.bMute : S.bOpen);
}
function lead(S, t, midi, len) {
  const c = S.c, f = 440 * Math.pow(2, (midi - 69) / 12), dur = len * STEP;
  for (const det of [-9, 9]) {
    const o = osc(c, 'sawtooth', f, t, dur + 0.15), g = gain(c);
    o.detune.setValueAtTime(det - 100, t);   // bend up into the note
    o.detune.linearRampToValueAtTime(det, t + 0.06);
    S.vib.connect(o.detune);
    o.onended = () => { try { S.vib.disconnect(o.detune); } catch (e) { /* already gone */ } };   // or the LFO keeps it alive
    lin(g.gain, t, [0, 0, 0.02, 0.5, dur, 0.45, dur + 0.12, 0]);
    ch(o, g, S.lead);
  }
}
function drum(S, name, t, vel) {
  const b = S.kit[name];
  if (!b) return;
  const s = S.c.createBufferSource(), g = gain(S.c, vel * KIT_MIX[name]);
  s.buffer = b;
  ch(s, g, S.dp[name]);
  s.start(t);
}
function songStep(S, i, t) {
  for (const e of STEPS[i % STEPS.length]) {
    if (e[0] === 'g') { gtr(S, t, e[1], e[2], e[3], e[4]); bass(S, t, e[1], e[2], e[3], e[4]); }
    else if (e[0] === 'd') drum(S, e[1], t, e[2]);
    else lead(S, t, e[1], e[2]);
  }
}
// Dev page: render bars of the music offline (stereo), optionally with effects on top (events [[t, name, vol]])
// and through the real master chain at full volume (mix). Notes are scheduled half a second at a time from
// suspend points, like the live clock does, so the graph stays small and the render time reflects the live cost.
export async function renderMusic(bars = BARS, { sampleRate = 44100, mix = false, events = [] } = {}) {
  const kitBufs = {}, fx = {};
  for (const n of KIT_NAMES) kitBufs[n] = (await renderDef(KIT[n], sampleRate, 0)).buffer;
  for (const [, n] of events) if (!fx[n]) fx[n] = (await renderDef(DEFS[n], sampleRate, 0)).buffer;
  let len = bars ? bars * 16 * STEP + 1.5 : 0.1;
  for (const [t, n] of events) len = Math.max(len, t + fx[n].duration + 0.1);
  const oc = new OfflineAudioContext(2, Math.ceil(len * sampleRate), sampleRate);
  let mDest = oc.destination, sDest = oc.destination;
  if (mix) {
    const m = master(oc, oc.destination);
    m.sfx.gain.value = SFX_GAIN; m.music.gain.value = MUSIC_GAIN;
    mDest = m.music; sDest = m.sfx;
  }
  for (const [t, n, v = 1] of events) {
    const s = oc.createBufferSource();
    s.buffer = fx[n];
    ch(s, gain(oc, v), sDest);
    s.start(t);
  }
  if (bars) {
    const S = createSong(oc, mDest, kitBufs), N = bars * 16, CH = 0.5;
    let i = 0;
    const upTo = until => { for (; i < N && i * STEP < until; i++) songStep(S, i, 0.02 + i * STEP); };
    upTo(2 * CH);
    for (let u = CH; u < N * STEP; u += CH) {
      const at = u;
      oc.suspend(at).then(() => { upTo(at + 2 * CH); oc.resume(); });
    }
  }
  return oc.startRendering();
}

// ------------------------------------------------------------- runtime ----
let ctx = null, sfxBus = null, musicBus = null, outNode = null, meterNode = null, blip = null;
let vSfx = 1, vMusic = 1;
const bank = {}, kitBank = {}, voices = [], pending = [], warned = new Set(), failed = new Set();
const LS = { x: 0, y: 5.35, z: 0, rx: 1, rz: 0 };   // listener position and right vector
const NO_OPTS = {};
let song = null, timer = 0, nextT = 0, stepI = 0, wantMusic = false;

const running = () => !!ctx && ctx.state === 'running';
const warnOnce = name => { if (!warned.has(name)) { warned.add(name); console.warn('audio: unknown sound "' + name + '"'); } };
// AudioParams throw on NaN/Infinity, which would take the caller's game loop down with them.
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const volOf = v => Math.max(0, num(v, 1));
const rateOf = r => clamp(num(r, 1), 0.05, 16);
const tooFar = p => {
  const dx = num(p.x, LS.x) - LS.x, dy = num(p.y, LS.y) - LS.y, dz = num(p.z, LS.z) - LS.z;
  return dx * dx + dy * dy + dz * dz >= FAR * FAR;
};

class Voice {
  constructor(name, pos, vol, rate, looped) {
    this.name = name; this.loop = looped; this.vol = vol; this.rate = rate;
    this.t0 = performance.now(); this.dead = false;   // wall clock: the context may be suspended
    this.src = this.g = this.p = null; this.a = 0; this.pn = 0;
    this.hasPos = false; this.x = 0; this.y = 0; this.z = 0;
    if (pos) this.place(pos);
  }
  place(p) { this.hasPos = true; this.x = num(p.x, LS.x); this.y = num(p.y, LS.y); this.z = num(p.z, LS.z); }
  // Nodes are made only once the sound really starts (buffer rendered and context running), so requests that
  // queue while the context is suspended hold nothing.
  start(buf) {
    const s = this.src = ctx.createBufferSource(), t = ctx.currentTime;
    this.g = gain(ctx, 0); this.p = ctx.createStereoPanner();
    ch(s, this.g, this.p, sfxBus);
    s.buffer = buf; s.loop = this.loop; s.playbackRate.value = this.rate;
    s.onended = () => this.free();
    this.apply(true);
    if (this.loop) { this.g.gain.setValueAtTime(0, t); this.g.gain.setTargetAtTime(this.a, t, 0.004); }   // mid-wave: fade in
    s.start(t);
  }
  // Distance attenuation and pan relative to the listener; smoothed so moving sources don't zipper.
  apply(now) {
    let a = this.vol, p = 0;
    if (this.hasPos) {
      const dx = this.x - LS.x, dy = this.y - LS.y, dz = this.z - LS.z, h2 = dx * dx + dz * dz, d = Math.sqrt(h2 + dy * dy);
      a *= d <= NEAR ? 1 : d >= FAR ? 0 : 1 - (d - NEAR) / (FAR - NEAR);
      if (h2 > 1e-6) { const h = Math.sqrt(h2); p = (dx * LS.rx + dz * LS.rz) / h * MAX_PAN * Math.min(1, h / 4); }
    }
    if (now) { this.g.gain.value = a; this.p.pan.value = p; }
    else if (Math.abs(a - this.a) > 0.002 || Math.abs(p - this.pn) > 0.005) {
      const t = ctx.currentTime;
      this.g.gain.setTargetAtTime(a, t, 0.025);
      this.p.pan.setTargetAtTime(p, t, 0.025);
    }
    this.a = a; this.pn = p;
  }
  setPos(p) { if (p) this.place(p); else this.hasPos = false; if (this.src) this.apply(false); }
  setRate(r) { this.rate = rateOf(r); if (this.src) this.src.playbackRate.setTargetAtTime(this.rate, ctx.currentTime, 0.03); }
  setVol(v) { this.vol = volOf(v); if (this.src) this.apply(false); }
  stop() {
    if (this.dead) return;
    this.dead = true;
    if (this.src) {
      const t = ctx.currentTime;
      this.g.gain.setTargetAtTime(0, t, 0.008);
      // onended frees it, but a suspended context would hold it until resumed: then let go now
      try { this.src.stop(t + 0.05); if (ctx.state === 'running') return; } catch (e) { /* never started */ }
    }
    this.free();
  }
  free() {
    this.dead = true;
    let i = voices.indexOf(this);
    if (i >= 0) voices.splice(i, 1);
    if ((i = pending.indexOf(this)) >= 0) pending.splice(i, 1);
    if (this.p) this.p.disconnect();
  }
}

// Make room for a new voice: per-name cap (one-shots only) then the global cap; loops are never stolen.
function makeRoom(name, cap) {
  let same = 0, oldSame = null, old = null, n = 0;
  for (const v of voices) {
    if (v.dead) continue;
    n++;
    if (v.loop) continue;
    if (v.name === name) { same++; if (!oldSame || v.t0 < oldSame.t0) oldSame = v; }
    if (!old || v.t0 < old.t0) old = v;
  }
  if (cap && same >= cap) { oldSame.stop(); return true; }
  if (n < MAX_VOICES) return true;
  if (!old) return false;
  old.stop();
  return true;
}
function pick(name) {   // random variant, avoiding an immediate repeat
  const vs = bank[name];
  if (vs.length === 1) return vs[0];
  let i = (Math.random() * vs.length) | 0;
  if (vs[i] === vs.last) i = (i + 1) % vs.length;
  return (vs.last = vs[i]);
}
function launch(v) {
  voices.push(v);
  if (bank[v.name] && running()) v.start(pick(v.name));
  else pending.push(v);
  return v;
}
// A buffer arrived or the context started running: start what was waiting for it. A one-shot that waited too long
// would now play late (or all at once with the others), so it is dropped; loops always start.
function flush() {
  if (!pending.length) return;
  const run = running(), now = performance.now();
  for (const v of pending.slice()) {
    if (!v.loop && now - v.t0 > LATE_START * 1000 || failed.has(v.name) && !bank[v.name]) v.free();
    else if (run && bank[v.name]) { pending.splice(pending.indexOf(v), 1); v.start(pick(v.name)); }
  }
}
function wake() {   // the context is running (after unlock or an interruption)
  if (ctx.state !== 'running') return;
  flush();
  tryMusic();
}

// Render everything into the live context's sample rate: UI first (menus are used right after unlock), then the
// drum kit (music), weapons, player, imps, world. Three renders in flight at a time.
const FIRST = ['menuMove', 'menuSelect', 'menuBack', 'menuSlider', 'tally', 'tallyDone'];
async function renderBank() {
  const sr = Math.min(ctx.sampleRate, 48000), jobs = [];   // sources resample on playback: no need for 96k+ buffers
  for (const n of FIRST) jobs.push([DEFS[n], 0, bank]);
  for (const n of KIT_NAMES) jobs.push([KIT[n], 0, kitBank]);
  for (const n of SOUND_NAMES) if (!FIRST.includes(n)) jobs.push([DEFS[n], 0, bank]);
  for (const n of SOUND_NAMES) for (let v = 1; v < DEFS[n].vars; v++) jobs.push([DEFS[n], v, bank]);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const [d, v, into] = jobs[next++];
      try {
        const { buffer } = await renderDef(d, sr, v);
        if (into === kitBank) { kitBank[d.name] = buffer; tryMusic(); }
        else { (bank[d.name] || (bank[d.name] = [])).push(buffer); if (bank[d.name].length === 1) flush(); }
      } catch (e) {
        console.warn('audio: failed to render "' + d.name + '"', e);
        if (into === bank && !bank[d.name]) { failed.add(d.name); flush(); }   // drop requests for a sound that never comes
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

// Master: effects bus + music bus → compressor → soft safety clip (linear to -2 dBFS, then a knee up to 0 dBFS).
// Any context, so the dev page can measure the real output offline.
function master(c, dest) {
  const comp = c.createDynamicsCompressor(), m = { sfx: gain(c, 0), music: gain(c, 0) };
  for (const k in COMP) comp[k].value = COMP[k];
  ch(m.sfx, comp); ch(m.music, comp);
  m.out = ch(comp, gain(c, 0.5 * OUT_GAIN), shaper(c, 1, 'safe', 'none'));   // the safe curve covers ±2: pre-halve
  m.out.connect(dest);
  return m;
}
function buildMix() {
  const m = master(ctx, ctx.destination);
  sfxBus = m.sfx; musicBus = m.music; outNode = m.out;
  applyVolumes();
}
function applyVolumes() {   // squared: sliders feel even
  if (!ctx) return;
  const t = ctx.currentTime;
  sfxBus.gain.setTargetAtTime(SFX_GAIN * vSfx * vSfx, t, 0.03);
  musicBus.gain.setTargetAtTime(MUSIC_GAIN * vMusic * vMusic, t, 0.03);
}

function tryMusic() {
  if (wantMusic && !song && ctx && ctx.state === 'running' && KIT_NAMES.every(n => kitBank[n])) beginSong();
}
function beginSong() {
  endSong();
  song = createSong(ctx, musicBus, kitBank);
  stepI = 0;
  nextT = ctx.currentTime + 0.08;
  timer = setInterval(pump, TICK_MS);
  pump();
}
function pump() {
  if (!song) return;
  const now = ctx.currentTime, ahead = document.hidden ? 1.5 : LOOKAHEAD;   // hidden tabs throttle timers to ~1 Hz
  if (nextT < now - 0.05) {   // fell behind (throttled/suspended): skip ahead instead of bursting old notes
    const skip = Math.ceil((now - nextT) / STEP);
    stepI = (stepI + skip) % STEPS.length;
    nextT += skip * STEP;
  }
  // At music volume 0 the clock keeps going but no notes are made (the synth is the costliest part of the audio);
  // turned back up, it comes in on the beat.
  while (nextT < now + ahead) { if (vMusic > 0) songStep(song, stepI, nextT); stepI = (stepI + 1) % STEPS.length; nextT += STEP; }
}
function endSong() {
  if (!song) return;
  clearInterval(timer);
  timer = 0;
  const S = song;
  song = null;
  S.out.gain.setTargetAtTime(0, ctx.currentTime, 0.06);
  setTimeout(() => { try { S.lfo.stop(); } catch (e) { /* already stopped */ } S.out.disconnect(); }, 2000);
}

export const Audio = {
  // Create/resume the context; call from every user gesture (idempotent, cheap once running). Starts rendering the
  // sound bank. Never throws: main calls it first thing in its key and pointer handlers.
  unlock() {
    if (!ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) return;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) {
        try { ctx = new AC(); } catch (e2) { console.warn('audio: no AudioContext', e2); return; }   // pre-options WebKit
      }
      ctx.onstatechange = wake;
      buildMix();
      renderBank();
    }
    if (ctx.state === 'running') return;
    // Retried on every gesture, even with one pending: a resume() made outside a gesture may never settle.
    try {
      Promise.resolve(ctx.resume()).then(wake, () => { /* not allowed yet: the next gesture retries */ });
      const s = ctx.createBufferSource();   // a silent blip inside the gesture: older iOS only unlocks on playback
      s.buffer = blip || (blip = ctx.createBuffer(1, 1, ctx.sampleRate));
      s.connect(ctx.destination);
      s.start();
    } catch (e) { /* closed or not resumable */ }
  },
  get ready() { return running(); },
  setListener(x, y, z, yaw) {
    LS.x = num(x, LS.x); LS.y = num(y, LS.y); LS.z = num(z, LS.z);
    if (num(yaw, null) !== null) { LS.rx = Math.cos(yaw); LS.rz = -Math.sin(yaw); }
    for (let i = 0; i < voices.length; i++) { const v = voices[i]; if (v.hasPos && v.src && !v.dead) v.apply(false); }
  },
  // One-shot. pos {x, y, z} (feet) → positional; null → the player's own / UI sound. Returns the voice (it has
  // stop(), setPos(p), setRate(r), setVol(v)) or null: before unlock, unknown name, too far away to hear.
  play(name, pos = null, opts = NO_OPTS) {
    const d = DEFS[name];
    if (!d) { warnOnce(name); return null; }
    if (!ctx || failed.has(name) && !bank[name]) return null;
    if (pos && tooFar(pos)) return null;   // inaudible from here: don't spend a voice
    if (!makeRoom(name, d.cap)) return null;
    const o = opts || NO_OPTS, rate = rateOf(o.rate) * (d.jit ? 1 + (Math.random() * 2 - 1) * d.jit : 1);
    return launch(new Voice(name, pos, volOf(o.vol), rate, false));
  },
  // Continuous sound (chainsaw). Returns { setPos(p), setRate(r), setVol(v), stop() } or null (before unlock).
  loop(name, pos = null) {
    if (!DEFS[name]) { warnOnce(name); return null; }
    if (!ctx || failed.has(name) && !bank[name] || !makeRoom(name, 0)) return null;
    return launch(new Voice(name, pos, 1, 1, true));
  },
  setVolumes(v) {
    if (!v) return;
    if (v.sfx !== undefined) vSfx = clamp(+v.sfx || 0, 0, 1);
    if (v.music !== undefined) vMusic = clamp(+v.music || 0, 0, 1);
    applyVolumes();
  },
  music: {
    // Start from the top (restarts if already playing). Before unlock it is remembered and starts on unlock.
    start() { wantMusic = true; if (song) endSong(); tryMusic(); },
    stop() { wantMusic = false; endSong(); },
    get playing() { return wantMusic; },
  },
};

// Dev/diagnostics only (the test page): live voice count and render progress.
export const audioDebug = {
  get voices() { return voices.filter(v => !v.dead).length; },
  get pending() { return pending.length; },   // requests waiting for a buffer or for the context to run
  get rendered() { return Object.keys(bank).length; },
  get kitReady() { return KIT_NAMES.every(n => kitBank[n]); },
  get state() { return ctx ? ctx.state : 'none'; },
  get context() { return ctx; },
  get step() { return song ? stepI : -1; },   // next 16th step the music clock will schedule
  meter() {   // peak and RMS (dBFS) of the master output over the last ~85 ms
    if (!outNode) return null;
    if (!meterNode) { meterNode = ctx.createAnalyser(); meterNode.fftSize = 4096; outNode.connect(meterNode); }
    const d = new Float32Array(meterNode.fftSize);
    meterNode.getFloatTimeDomainData(d);
    let pk = 0, e = 0;
    for (let i = 0; i < d.length; i++) { pk = Math.max(pk, Math.abs(d[i])); e += d[i] * d[i]; }
    return { peak: 20 * Math.log10(pk || 1e-9), rms: 10 * Math.log10(e / d.length || 1e-18) };
  },
};
