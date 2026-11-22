// theater3d-sound.js — the theater's sound, synthesised entirely at runtime.

//
// No audio assets, no network. Every cue is built in the Web Audio API from
// noise sources, biquad filters, scheduled envelopes, and a convolution reverb
// whose impulse response is generated in a loop: a decaying noise burst with
// progressive high-frequency damping and a handful of early-reflection taps,
// which is enough to put every cue in the same small hall.
//
// Contract (published as ctx.sound by initSound(ctx)):
//   enabled                  boolean, reflects the user's opt-in
//   enable() / disable() / toggle()
//   cue(name, opts)          one-shot; opts may carry { gain, rate, progress }
//   setRoom(level)           0..1 ambience bed level
//   makeToggleButton()       -> HTMLElement in the house style, state in text
//   dispose()
//
// Cues: curtainOpen, curtainClose (both accept { progress } for scroll-driven
// scrubbing), roomTone (the bed; started once, levelled by setRoom), bookOut,
// bookOpen, pageTurn (per-call variation), tick.
//
// Non-negotiables honoured here:
//  - Silent by default. The AudioContext is not even constructed until the
//    user opts in (or, on a later visit with the choice persisted, until their
//    first gesture). localStorage key: 't3.sound'. A stored "on" stays on:
//    enabled state and the toggle reflect it immediately on load, the first
//    gesture of any kind (pointer, key, wheel, scroll, touch) brings the
//    context up and starts the room, and storage is only ever written from
//    the visitor's own toggle — never from context state or visibility.
//  - prefers-reduced-motion: the stored choice is NOT auto-restored; the bed
//    never self-starts. The toggle still works if they ask for sound.
//  - Duck, don't stack: one master gain, a DynamicsCompressor as a limiter on
//    the output, per-cue voice caps with oldest-voice stealing, and the room
//    bed ducks under curtain/book cues.
//  - No per-frame allocation, nodes disconnected when voices die, context
//    suspended on visibilitychange, dispose() tears everything down.
//
// ---------------------------------------------------------------------------
// selfTest() — renders every cue through an OfflineAudioContext (same output
// chain, seeded RNG) and returns measured duration / peak / RMS / rough
// spectral balance per cue. Expected values (post-limiter, loose bounds —
// the point is "is it alive, is it clean, is it in the right register"):
//
//   cue           render  peak         rms            balance expectation
//   curtainOpen   3.2s    0.10 - 0.55  0.015 - 0.110  low-dominant, mid cloth
//   curtainClose  3.3s    0.10 - 0.60  0.015 - 0.110  as above, heavier arrival
//   roomTone      3.0s    0.015- 0.160 0.005 - 0.050  low >> mid; a little high
//   bookOut       1.2s    0.04 - 0.35  0.006 - 0.070  mid/high paper + soft low set-down
//   bookOpen      1.5s    0.06 - 0.40  0.008 - 0.080  low boards + high settle
//   pageTurn      1.1s    0.05 - 0.35  0.006 - 0.060  high-leaning
//   tick          0.5s    0.015- 0.25  0.002 - 0.050  high, dry (no reverb)
//
// Additional per-cue checks selfTest applies:
//   roomTone: low band RMS > 2.5x mid band (it must not read as hiss);
//   pageTurn: high band > low band; tick: high band > low band;
//   every cue: peak <= 0.95 (the limiter is doing its job), rms above the
//   floor (the cue is actually audible), effective duration (last sample
//   above -60 dBFS) within [0.5 * dur, dur + tail + 0.3].
// ---------------------------------------------------------------------------

'use strict';

const TAU = Math.PI * 2;
const LS_KEY = 't3.sound';

/* ============================ deterministic rng ============================ */
/* selfTest uses a seeded generator so its numbers are reproducible run to run.
   Live playback uses Math.random for per-call variation. */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================ source material ============================ */

/* A looping noise buffer with its tail crossfaded into its head so the loop
   point is inaudible. White by default; 'pink' runs a Paul Kellett filter so
   the energy tilts down at ~3 dB/oct, which is what big soft objects sound
   like before any further filtering. */
function makeNoiseBuffer(ac, seconds, rng, pink) {
  const sr = ac.sampleRate;
  const n = Math.max(sr, Math.floor(seconds * sr));
  const buf = ac.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  if (pink) {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else {
    for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  }
  // crossfade the last 60ms into the first 60ms: no click at the loop point
  const f = Math.min(Math.floor(sr * 0.06), n >> 2);
  for (let i = 0; i < f; i++) {
    const k = i / f;
    d[n - f + i] = d[n - f + i] * (1 - k) + d[i] * k;
  }
  return buf;
}

/* The hall. ~1.6s stereo IR: exponentially decaying noise whose one-pole
   lowpass tightens over time (high frequencies die first, as they do in a
   plastered room), with four early-reflection taps in the first 45ms so the
   room has walls, not just a wash. Small hall, wood and plaster: RT ~1.25s. */
function makeImpulse(ac, rng) {
  const sr = ac.sampleRate;
  const dur = 1.6, rt = 1.25;
  const n = Math.floor(dur * sr);
  const buf = ac.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const amp = Math.exp(-6.9 * t / rt);
      // lowpass coefficient eases from open (0.55) to closed (0.10)
      const k = 0.55 + (0.10 - 0.55) * Math.min(1, t / dur);
      lp += k * ((rng() * 2 - 1) * amp - lp);
      d[i] = lp;
    }
    // early reflections — slightly different per channel for width
    const taps = [[0.011, 0.55], [0.019, 0.42], [0.028, 0.33], [0.043, 0.22]];
    for (const [tt, ta] of taps) {
      const idx = Math.floor((tt + ch * 0.0013) * sr);
      if (idx < n) d[idx] += ta * (rng() < 0.5 ? -1 : 1) * (0.8 + rng() * 0.4);
    }
    // normalise to a civilised peak
    let peak = 0;
    for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
    if (peak > 0) { const s = 0.5 / peak; for (let i = 0; i < n; i++) d[i] *= s; }
  }
  return buf;
}

/* ============================ tiny graph helpers ============================ */

function gainNode(ac, v) { const g = ac.createGain(); g.gain.value = v; return g; }
function filt(ac, type, f, q) {
  const b = ac.createBiquadFilter();
  b.type = type; b.frequency.value = f;
  if (q != null) b.Q.value = q;
  return b;
}
function noiseSrc(ac, buf, rate) {
  const s = ac.createBufferSource();
  s.buffer = buf; s.loop = true;
  if (rate) s.playbackRate.value = rate;
  return s;
}

/* Drive an AudioParam along fn(t01) over [t0, t0+dur] with one value curve.
   One Float32Array per call at cue time — never per frame. */
function scheduleCurve(param, t0, dur, fn, n) {
  n = n || Math.max(12, Math.round(dur * 96));
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.max(0, fn(i / (n - 1)));
  try { param.setValueCurveAtTime(a, t0, dur); }
  catch (e) { param.setValueAtTime(a[n - 1], t0); }
}

/* A shaped noise layer: source -> bandpass (moving centre) -> gain (envelope).
   The moving filter and the slow amplitude curve are what make it cloth and
   not a noise burst. Returns its nodes for the voice's cleanup list. */
function clothLayer(ac, out, buf, t0, dur, o, rng) {
  const src = noiseSrc(ac, buf, o.rate || 1);
  const bp = filt(ac, o.type || 'bandpass', o.fc(0), o.q != null ? o.q : 1.3);
  const g = gainNode(ac, 0);
  src.connect(bp); bp.connect(g); g.connect(out);
  const ph1 = rng() * TAU, ph2 = rng() * TAU;
  const wob = o.wob || 0, wobHz = o.wobHz || 3.1;
  scheduleCurve(bp.frequency, t0, dur, (t) =>
    o.fc(t) * (1
      + wob * Math.sin(TAU * wobHz * t * dur + ph1)
      + wob * 0.6 * Math.sin(TAU * wobHz * 2.63 * t * dur + ph2)));
  scheduleCurve(g.gain, t0, dur, o.env);
  src.start(t0); src.stop(t0 + dur + 0.03);
  return { sources: [src], nodes: [bp, g] };
}

/* A soft weighted impact: pitched sine dropping in frequency with a fast
   (but never instant) attack and exponential decay, plus an optional short
   noise contact. o.att widens the attack for objects that are set down
   rather than knocked; the contact noise rises over 4ms instead of being
   stamped on at full level, so it reads as touch, not as a cut. */
function thump(ac, out, bufWhite, t0, o) {
  const f0 = o.f0 || 58, f1 = o.f1 || f0 * 0.72, g0 = o.g || 0.25, dur = o.dur || 0.3;
  const att = o.att || 0.006;
  const osc = ac.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f0, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur * 0.8);
  const g = gainNode(ac, 0);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(g0, t0 + att);
  g.gain.setTargetAtTime(0, t0 + att + 0.006, dur * 0.24);
  osc.connect(g); g.connect(out);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
  const nodes = [g], sources = [osc];
  if (o.click) {
    const cs = noiseSrc(ac, bufWhite);
    const hp = filt(ac, 'highpass', o.clickF || 1400, 0.9);
    const cg = gainNode(ac, 0);
    cg.gain.setValueAtTime(0, t0);
    cg.gain.linearRampToValueAtTime(o.click, t0 + 0.004);
    cg.gain.setTargetAtTime(0, t0 + 0.007, 0.008);
    cs.connect(hp); hp.connect(cg); cg.connect(out);
    cs.start(t0); cs.stop(t0 + 0.08);
    sources.push(cs); nodes.push(hp, cg);
  }
  return { sources, nodes };
}

/* A short cloth flick — the fabric catching up with itself. */
function flick(ac, out, buf, t0, o, rng) {
  const dur = o.dur || 0.16;
  return clothLayer(ac, out, buf, t0, dur, {
    fc: (t) => (o.f0 || 700) + ((o.f1 || 380) - (o.f0 || 700)) * t,
    q: 1.4,
    env: (t) => (o.g || 0.08) * Math.pow(Math.sin(Math.PI * Math.min(1, t)), 1.4),
    wob: 0.06, wobHz: 9,
  }, rng);
}

/* merge helper for build results */
function mergeBuilt(...parts) {
  const sources = [], nodes = [];
  for (const p of parts) { sources.push(...p.sources); nodes.push(...p.nodes); }
  return { sources, nodes };
}

/* ============================ the cue book ============================
   Every cue is a pure function of (ac, out, buffers, t0, rng, opts) that
   wires its graph into `out`, schedules everything, and returns its node
   lists. Nothing here touches module state, which is what lets selfTest
   render the identical cue in an OfflineAudioContext.                   */

const CUES = {

  /* Heavy velvet leaving: track rumble underneath, rings ticking along the
     rail, two cloth layers with moving centres, and a settle at the end
     when the gathered drape lands. ~2.1s. */
  curtainOpen: {
    dur: 2.1, tail: 1.1, cap: 1, send: 0.30,
    build(ac, out, bufs, t0, rng, opts) {
      const D = 2.1;
      const hump = (t) => Math.sin(Math.PI * Math.min(1, Math.max(0, t)));
      const parts = [];

      // track rumble — pink noise kept below ~130Hz, swelling with the travel
      parts.push(clothLayer(ac, out, bufs.pink, t0, D, {
        type: 'lowpass', q: 0.8,
        fc: (t) => 92 + 46 * hump(t),
        env: (t) => 0.55 * Math.pow(hump(Math.min(1, t * 1.06)), 0.8)
          * (1 + 0.18 * Math.sin(TAU * 1.7 * t * D)),
        wob: 0.05, wobHz: 1.3,
      }, rng));

      // rings on the rail — a very quiet bumpy band up at 2.4k
      {
        const bumps = [];
        for (let i = 0; i < 7; i++) bumps.push(0.08 + rng() * 0.78);
        parts.push(clothLayer(ac, out, bufs.white, t0, D, {
          q: 8,
          fc: (t) => 2300 + 260 * Math.sin(TAU * 0.9 * t + 1),
          env: (t) => {
            let e = 0;
            for (const c of bumps) e = Math.max(e, Math.exp(-Math.pow((t - c) / 0.022, 2)));
            return 0.028 * e * hump(t);
          },
          wob: 0.02, wobHz: 7,
        }, rng));
      }

      // cloth body — the main moving mass
      parts.push(clothLayer(ac, out, bufs.white, t0, D, {
        q: 1.2,
        fc: (t) => 420 + 760 * Math.pow(hump(t), 1.15),
        env: (t) => 0.17 * Math.pow(hump(Math.pow(t, 0.92)), 1.3),
        wob: 0.11, wobHz: 2.7,
      }, rng));

      // cloth sheen — a lighter, higher layer riding on top
      parts.push(clothLayer(ac, out, bufs.white, t0, D, {
        q: 1.1,
        fc: (t) => 950 + 880 * hump(t),
        env: (t) => 0.055 * Math.pow(hump(t), 1.7),
        wob: 0.14, wobHz: 4.3,
      }, rng));

      // the settle: the drape lands against the leg and stops
      parts.push(thump(ac, out, bufs.white, t0 + 1.86, { f0: 58, f1: 40, g: 0.24, dur: 0.34 }));
      parts.push(flick(ac, out, bufs.white, t0 + 1.88, { f0: 720, f1: 360, g: 0.075, dur: 0.20 }, rng));
      return mergeBuilt(...parts);
    },
  },

  /* The same material arriving. The movement builds toward the end, the
     arrival is heavier than the open's settle, and the cloth sways once
     after it lands. ~2.1s. */
  curtainClose: {
    dur: 2.1, tail: 1.2, cap: 1, send: 0.30,
    build(ac, out, bufs, t0, rng, opts) {
      const D = 2.1;
      // late-weighted movement: quiet start, mass arriving
      const move = (t) => Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t)) * 0.92), 1.1)
        * (0.35 + 0.65 * Math.min(1, t * 1.35));
      const parts = [];

      // the tug as the cord takes the weight
      parts.push(thump(ac, out, bufs.white, t0 + 0.03, { f0: 74, f1: 55, g: 0.10, dur: 0.16 }));

      parts.push(clothLayer(ac, out, bufs.pink, t0, D, {
        type: 'lowpass', q: 0.8,
        fc: (t) => 86 + 52 * move(t),
        env: (t) => 0.58 * Math.pow(move(t), 0.85),
        wob: 0.05, wobHz: 1.1,
      }, rng));

      parts.push(clothLayer(ac, out, bufs.white, t0, D, {
        q: 1.2,
        fc: (t) => 390 + 700 * Math.pow(move(t), 1.1),
        env: (t) => 0.18 * Math.pow(move(t), 1.25),
        wob: 0.12, wobHz: 2.4,
      }, rng));

      parts.push(clothLayer(ac, out, bufs.white, t0, D, {
        q: 1.1,
        fc: (t) => 880 + 820 * move(t),
        env: (t) => 0.05 * Math.pow(move(t), 1.6),
        wob: 0.15, wobHz: 4.0,
      }, rng));

      // arrival: heavier than the open's settle — the halves meet
      parts.push(thump(ac, out, bufs.white, t0 + 1.88, { f0: 52, f1: 36, g: 0.34, dur: 0.42, click: 0.05, clickF: 900 }));
      parts.push(flick(ac, out, bufs.white, t0 + 1.90, { f0: 640, f1: 300, g: 0.09, dur: 0.24 }, rng));
      // one after-sway as the fabric comes to rest
      parts.push(flick(ac, out, bufs.white, t0 + 2.22, { f0: 420, f1: 260, g: 0.035, dur: 0.30 }, rng));
      return mergeBuilt(...parts);
    },
  },

  /* The bed. Large, mostly empty, wood and plaster: fourth-order lowpassed
     pink noise below ~150Hz with two incommensurate slow LFOs so it never
     repeats, and a whisper of air above 6kHz (fourth-order highpass) so the
     room has a ceiling. Deliberately nothing between — mid content is what
     reads as hiss. Runs forever live; selfTest renders a 3s window. */
  roomTone: {
    dur: 3.0, tail: 0.0, cap: 1, send: 0.08, bed: true,
    build(ac, out, bufs, t0, rng, opts) {
      const dur = opts && opts.dur;    // offline render passes a duration; live omits it
      const sources = [], nodes = [];

      // low: building rumble
      const low1 = filt(ac, 'lowpass', 150, 0.7);
      const low2 = filt(ac, 'lowpass', 150, 0.7);
      const lowG = gainNode(ac, 0.30);
      const sLow = noiseSrc(ac, bufs.pink, 0.85);
      sLow.connect(low1); low1.connect(low2); low2.connect(lowG); lowG.connect(out);
      sources.push(sLow); nodes.push(low1, low2, lowG);

      // two slow LFOs at incommensurate rates breathe the low bed
      for (const [hz, depth] of [[0.031, 0.075], [0.0127, 0.05]]) {
        const o = ac.createOscillator();
        o.type = 'sine'; o.frequency.value = hz;
        o.detune.value = 0;
        const og = gainNode(ac, depth);
        o.connect(og); og.connect(lowG.gain);
        o.start(t0 + rng() * 0.5);
        sources.push(o); nodes.push(og);
      }

      // air: a whisper above 6k, its own slow breath
      const hi1 = filt(ac, 'highpass', 5800, 0.7);
      const hi2 = filt(ac, 'highpass', 7200, 0.7);
      const hiG = gainNode(ac, 0.011);
      const sHi = noiseSrc(ac, bufs.white, 1);
      sHi.connect(hi1); hi1.connect(hi2); hi2.connect(hiG); hiG.connect(out);
      const oh = ac.createOscillator();
      oh.type = 'sine'; oh.frequency.value = 0.021;
      const ohg = gainNode(ac, 0.004);
      oh.connect(ohg); ohg.connect(hiG.gain);
      oh.start(t0);
      sources.push(sHi, oh); nodes.push(hi1, hi2, hiG, ohg);

      sLow.start(t0);
      sHi.start(t0);
      if (dur) for (const s of sources) { try { s.stop(t0 + dur); } catch (e) { /* oscillators already limited */ } }
      return { sources, nodes };
    },
  },

  /* A copy sliding out of a tight run: paper-on-paper friction dropping in
     pitch as it comes free, then a soft set-down as the tail clears the
     shelf edge — soft card meeting soft card, never a snip. ~0.55s. */
  bookOut: {
    dur: 0.55, tail: 0.65, cap: 2, send: 0.2,
    build(ac, out, bufs, t0, rng, opts) {
      const r = (opts && opts.rate) || 1;
      const D = 0.55 / r;
      const slideEnv = (t) => Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.5)), 0.9) * Math.max(0, 1 - t * 1.15);
      const parts = [];
      // friction body
      parts.push(clothLayer(ac, out, bufs.white, t0, D * 0.72, {
        q: 1.5,
        fc: (t) => (2300 - 1100 * Math.pow(t, 0.9)) * r,
        env: (t) => 0.15 * slideEnv(t),
        wob: 0.10, wobHz: 11,
      }, rng));
      // paper brightness
      parts.push(clothLayer(ac, out, bufs.white, t0, D * 0.72, {
        q: 1.2,
        fc: (t) => (4300 - 1700 * t) * r,
        env: (t) => 0.05 * slideEnv(t),
        wob: 0.13, wobHz: 15,
      }, rng));
      // the set-down as it clears the run. Rebuilt after review: the old
      // knock (205Hz thump, 6ms attack, plus a 1600Hz highpassed click)
      // read as a shallow snip. Now: a lowpassed contact pat with a slow
      // rise and nothing bright in it, a low-mid body with a ~20ms attack
      // so the copy has weight, and the cue's reverb send (0.2) lands it
      // in the same room as everything else.
      parts.push(clothLayer(ac, out, bufs.white, t0 + 0.31 / r, 0.18 / r, {
        type: 'lowpass', q: 0.9,
        fc: (t) => (780 - 340 * t) * r,
        env: (t) => 0.055 * Math.pow(Math.sin(Math.PI * Math.min(1, t)), 1.6),
        wob: 0.05, wobHz: 7,
      }, rng));
      parts.push(thump(ac, out, bufs.white, t0 + 0.33 / r, {
        f0: 150 * r, f1: 104 * r, g: 0.11, dur: 0.2, att: 0.02,
      }));
      // shelf body resonance under the set-down — same register, softer
      parts.push(thump(ac, out, bufs.white, t0 + 0.34 / r, { f0: 92, f1: 74, g: 0.075, dur: 0.24, att: 0.028 }));
      return mergeBuilt(...parts);
    },
  },

  /* Boards opening: a short resonant creak falling in pitch, the front
     board laying back with a soft thud, then a page settling in two small
     bright flutters. ~0.7s. */
  bookOpen: {
    dur: 0.7, tail: 0.8, cap: 2, send: 0.18,
    build(ac, out, bufs, t0, rng, opts) {
      const r = (opts && opts.rate) || 1;
      const parts = [];
      // spine creak — high-Q band falling from 520 to 240, wobbling
      parts.push(clothLayer(ac, out, bufs.white, t0, 0.30 / r, {
        q: 8,
        fc: (t) => (520 - 280 * t) * r,
        env: (t) => 0.05 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.2)), 0.7),
        wob: 0.06, wobHz: 13,
      }, rng));
      // the board landing open
      parts.push(thump(ac, out, bufs.white, t0 + 0.16 / r, { f0: 95 * r, f1: 68 * r, g: 0.16, dur: 0.22 }));
      // pages settling — two flutters, the second softer
      parts.push(flick(ac, out, bufs.white, t0 + 0.34 / r, { f0: 1500 * r, f1: 900 * r, g: 0.06, dur: 0.11 }, rng));
      parts.push(flick(ac, out, bufs.white, t0 + 0.50 / r, { f0: 1150 * r, f1: 700 * r, g: 0.038, dur: 0.13 }, rng));
      return mergeBuilt(...parts);
    },
  },

  /* One sheet. A fast bright transient (the lift), a soft band-passed tail
     (the sheet travelling and laying down), and per-call variation in rate,
     brightness and an optional second flick so ten in a row never sound
     mechanical. ~0.34s nominal. */
  pageTurn: {
    dur: 0.34, tail: 0.7, cap: 3, send: 0.14,
    build(ac, out, bufs, t0, rng, opts) {
      const r = (opts && opts.rate) || (0.9 + rng() * 0.24);
      const D = 0.34 / r;
      const parts = [];
      // the lift: fast, bright, over in ~70ms
      parts.push(clothLayer(ac, out, bufs.white, t0, 0.09 / r, {
        type: 'highpass', q: 0.8,
        fc: (t) => (1700 + 500 * rng()) * r,
        env: (t) => 0.20 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.6),
        wob: 0.05, wobHz: 20,
      }, rng));
      // the tail: the sheet in the air, gliding down and dying softly
      parts.push(clothLayer(ac, out, bufs.white, t0 + 0.03 / r, D, {
        q: 1.2,
        fc: (t) => (980 - 400 * t) * r,
        env: (t) => 0.07 * Math.pow(1 - t, 1.7) * Math.min(1, t * 6),
        wob: 0.10, wobHz: 9,
      }, rng));
      // sometimes the sheet catches a second time
      if (rng() < 0.45) {
        parts.push(flick(ac, out, bufs.white, t0 + 0.12 / r, {
          f0: 1400 * r, f1: 800 * r, g: 0.05, dur: 0.07,
        }, rng));
      }
      return mergeBuilt(...parts);
    },
  },

  /* The control click. Very small, very dry: no reverb send, 50ms of
     band-passed noise with an instant decay. */
  tick: {
    dur: 0.05, tail: 0.15, cap: 2, send: 0,
    build(ac, out, bufs, t0, rng, opts) {
      const src = noiseSrc(ac, bufs.white);
      const bp = filt(ac, 'bandpass', 2500, 4.5);
      const g = gainNode(ac, 0);
      g.gain.setValueAtTime(0.13, t0);
      g.gain.setTargetAtTime(0, t0 + 0.004, 0.012);
      src.connect(bp); bp.connect(g); g.connect(out);
      src.start(t0); src.stop(t0 + 0.08);
      return { sources: [src], nodes: [bp, g] };
    },
  },
};

/* ============================ the output chain ============================
   voice -> voiceGain -> bus -> highpass(28) -> master -> limiter -> speakers
                    \-> send -> convolver -> wet return -> bus
   The 28Hz highpass keeps sub-rumble out of the limiter; the limiter
   (a DynamicsCompressor at -6dB / 12:1 / 2ms attack) is what lets rapid
   fire never clip or pile into mush.                                     */

function buildChain(ac, rng) {
  const bus = gainNode(ac, 1);
  const hp = filt(ac, 'highpass', 28, 0.7);
  const master = gainNode(ac, 0.9);
  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 4;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.18;
  bus.connect(hp); hp.connect(master); master.connect(limiter);
  limiter.connect(ac.destination);

  const conv = ac.createConvolver();
  conv.buffer = makeImpulse(ac, rng);
  const wetIn = gainNode(ac, 1);
  const wetRet = gainNode(ac, 0.55);
  wetIn.connect(conv); conv.connect(wetRet); wetRet.connect(bus);

  return { bus, wetIn, master, limiter, conv, wetRet, hp };
}

function makeBuffers(ac, rng) {
  return {
    white: makeNoiseBuffer(ac, 2.2, rng, false),
    pink: makeNoiseBuffer(ac, 4.0, rng, true),
  };
}

/* ============================ initSound ============================ */

export function initSound(ctx) {
  ctx = ctx || {};
  if (ctx.sound) return ctx.sound;

  const reduced = typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let ac = null, chain = null, bufs = null;
  let enabled = false;
  let disposed = false;
  let roomLevel = 0.8;
  let bedRequested = false;
  let bed = null;             // { out, sg, sources, nodes, creakTimer }
  let scrub = null;           // persistent curtain-scrub voice
  const voices = new Map();   // cue name -> Set of live voice handles
  const buttons = new Set();
  const roomDuckTC = 0.5;

  /* ---------------- persistence ---------------- */
  function readStored() {
    try { return localStorage.getItem(LS_KEY) === '1'; } catch (e) { return false; }
  }
  function store(v) {
    try { localStorage.setItem(LS_KEY, v ? '1' : '0'); } catch (e) { /* private mode */ }
  }

  /* ---------------- context lifecycle ---------------- */
  function ensureContext() {
    if (ac) return ac;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC({ latencyHint: 'interactive' });
    chain = buildChain(ac, Math.random);
    bufs = makeBuffers(ac, Math.random);
    // the bed ducks under curtain/book cues through this stage
    chain.roomDuck = gainNode(ac, 1);
    chain.roomDuck.connect(chain.bus);
    // master starts silent and fades up so enabling is never a pop
    chain.master.gain.setValueAtTime(0.0001, ac.currentTime);
    chain.master.gain.setTargetAtTime(0.9, ac.currentTime + 0.02, 0.12);
    return ac;
  }

  function running() {
    return !!(enabled && ac && ac.state === 'running');
  }

  /* ---------------- the room bed ---------------- */
  function startBed() {
    if (bed || !running() || !bedRequested) return;
    const out = gainNode(ac, roomLevel);
    out.connect(chain.roomDuck);
    const sg = gainNode(ac, CUES.roomTone.send);
    out.connect(sg); sg.connect(chain.wetIn);
    const built = CUES.roomTone.build(ac, out, bufs, ac.currentTime + 0.02, Math.random, {});
    bed = { out, sg, sources: built.sources, nodes: built.nodes, creakTimer: 0 };
    // fade the bed in over ~1.5s: room tone should arrive, not switch on
    out.gain.setValueAtTime(0.0001, ac.currentTime);
    out.gain.setTargetAtTime(roomLevel, ac.currentTime + 0.05, 0.55);
    scheduleCreak();
  }

  /* Very occasionally, very quietly, the building moves. Live only —
     selfTest never sees these, and neither will most visitors. */
  function scheduleCreak() {
    if (!bed) return;
    bed.creakTimer = setTimeout(() => {
      if (!bed || !running() || document.hidden) { if (bed) scheduleCreak(); return; }
      const t0 = ac.currentTime + 0.02;
      const built = clothLayer(ac, bed.out, bufs.white, t0, 0.5, {
        q: 7,
        fc: (t) => 330 - 130 * t,
        env: (t) => 0.022 * Math.pow(Math.sin(Math.PI * t), 1.5),
        wob: 0.08, wobHz: 6,
      }, Math.random);
      // let its nodes die with the bed; they are three nodes every ~20s
      bed.sources.push(...built.sources); bed.nodes.push(...built.nodes);
      scheduleCreak();
    }, 14000 + Math.random() * 18000);
  }

  function stopBed(fast) {
    if (!bed) return;
    clearTimeout(bed.creakTimer);
    const b = bed; bed = null;
    if (ac) {
      const now = ac.currentTime;
      try {
        b.out.gain.cancelScheduledValues(now);
        b.out.gain.setTargetAtTime(0, now, fast ? 0.05 : 0.3);
      } catch (e) { /* context closing */ }
    }
    setTimeout(() => {
      for (const s of b.sources) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} }
      for (const n of b.nodes) { try { n.disconnect(); } catch (e) {} }
      try { b.out.disconnect(); } catch (e) {}
      try { b.sg.disconnect(); } catch (e) {}
    }, fast ? 120 : 900);
  }

  /* ---------------- ducking ---------------- */
  function duckFor(name, dur) {
    if (!bed || !chain.roomDuck) return;
    if (!/^curtain|^book/.test(name)) return;
    const now = ac.currentTime;
    const g = chain.roomDuck.gain;
    g.cancelScheduledValues(now);
    g.setTargetAtTime(0.55, now, 0.08);
    g.setTargetAtTime(1, now + Math.max(0.3, dur * 0.6), roomDuckTC);
  }

  /* ---------------- one-shot voices ---------------- */
  function play(name, opts) {
    opts = opts || {};
    if (disposed) return false;
    const def = CUES[name];
    if (!def) return false;

    // the bed is not a one-shot: remember it was asked for, start if we can
    if (def.bed) {
      bedRequested = true;
      if (typeof opts.gain === 'number') setRoom(opts.gain);
      startBed();
      return true;
    }

    // scroll-driven scrub path for the curtain cues
    if ((name === 'curtainOpen' || name === 'curtainClose') && typeof opts.progress === 'number') {
      return scrubUpdate(name, opts.progress);
    }

    if (!running()) return false;

    let set = voices.get(name);
    if (!set) { set = new Set(); voices.set(name, set); }
    if (set.size >= def.cap) {
      // steal the oldest voice: ease it out rather than stacking. The fade
      // is ~250ms of exponential decay — stealing must never read as a cut.
      const oldest = set.values().next().value;
      if (oldest) oldest.kill();
    }

    const t0 = ac.currentTime + 0.015;
    const out = gainNode(ac, typeof opts.gain === 'number' ? opts.gain : 1);
    out.connect(chain.bus);
    let sg = null;
    if (def.send > 0) {
      sg = gainNode(ac, def.send);
      out.connect(sg); sg.connect(chain.wetIn);
    }
    const built = def.build(ac, out, bufs, t0, Math.random, opts);

    const v = {
      done: false,
      kill() {
        if (v.done || !ac) return;
        try {
          out.gain.cancelScheduledValues(ac.currentTime);
          out.gain.setTargetAtTime(0, ac.currentTime, 0.05);
        } catch (e) {}
        setTimeout(cleanup, 320);
      },
    };
    function cleanup() {
      if (v.done) return;
      v.done = true;
      set.delete(v);
      for (const s of built.sources) { try { s.stop(); } catch (e) {} try { s.disconnect(); } catch (e) {} }
      for (const n of built.nodes) { try { n.disconnect(); } catch (e) {} }
      try { out.disconnect(); } catch (e) {}
      if (sg) { try { sg.disconnect(); } catch (e) {} }
    }
    set.add(v);
    setTimeout(cleanup, (def.dur + def.tail) * 1000 + 150);
    duckFor(name, def.dur);
    return true;
  }

  /* ---------------- the scrub voice ----------------
     The close is a pure function of scroll, scrubbed both ways, so its sound
     cannot be a timeline. One persistent voice: cloth band + track rumble
     whose gains follow the scrub *velocity* (still cloth is silent cloth) and
     whose centre frequency rises with speed. Crossing the end of the travel
     fires the arrival settle once; re-arming happens on the way back.      */
  function ensureScrub() {
    if (scrub || !running()) return scrub;
    const out = gainNode(ac, 1);
    out.connect(chain.bus);
    const sg = gainNode(ac, 0.26);
    out.connect(sg); sg.connect(chain.wetIn);

    const sCloth = noiseSrc(ac, bufs.white);
    const bp = filt(ac, 'bandpass', 520, 1.3);
    const gCloth = gainNode(ac, 0);
    sCloth.connect(bp); bp.connect(gCloth); gCloth.connect(out);

    const sRum = noiseSrc(ac, bufs.pink);
    const lp = filt(ac, 'lowpass', 110, 0.8);
    const gRum = gainNode(ac, 0);
    sRum.connect(lp); lp.connect(gRum); gRum.connect(out);

    sCloth.start(); sRum.start();
    scrub = {
      out, sg, bp, lp, gCloth, gRum,
      sources: [sCloth, sRum],
      lastP: -1, lastT: 0,
      armedEnd: true, armedStart: false,
    };
    return scrub;
  }

  function scrubUpdate(name, p) {
    if (!running()) return false;
    const s = ensureScrub();
    if (!s) return false;
    p = Math.min(1, Math.max(0, p));
    const nowMs = performance.now();
    const now = ac.currentTime;

    if (s.lastP >= 0) {
      const dt = Math.max(1 / 240, (nowMs - s.lastT) / 1000);
      const vel = Math.min(3, Math.abs(p - s.lastP) / dt);   // progress units / s
      const amt = Math.min(0.65, vel * 0.55);
      // movement drives level; speed drives brightness — fast cloth is brighter
      s.gCloth.gain.setTargetAtTime(amt * 0.16, now, 0.05);
      s.gRum.gain.setTargetAtTime(amt * 0.40, now, 0.06);
      s.bp.frequency.setTargetAtTime(420 + 780 * Math.min(1, vel * 0.55), now, 0.07);
      // and always decay back to silence so a paused scroll goes quiet
      s.gCloth.gain.setTargetAtTime(0, now + 0.09, 0.20);
      s.gRum.gain.setTargetAtTime(0, now + 0.09, 0.24);
    }
    // arrival at the closed end — the halves meet, once
    if (p >= 0.985 && s.armedEnd) {
      s.armedEnd = false;
      const w = gainNode(ac, 1); w.connect(chain.bus);
      const wsg = gainNode(ac, 0.3); w.connect(wsg); wsg.connect(chain.wetIn);
      const built = mergeBuilt(
        thump(ac, w, bufs.white, now + 0.01, { f0: 52, f1: 36, g: 0.30, dur: 0.4, click: 0.04, clickF: 900 }),
        flick(ac, w, bufs.white, now + 0.03, { f0: 640, f1: 300, g: 0.08, dur: 0.22 }, Math.random),
      );
      setTimeout(() => {
        for (const src of built.sources) { try { src.disconnect(); } catch (e) {} }
        for (const n of built.nodes) { try { n.disconnect(); } catch (e) {} }
        try { w.disconnect(); wsg.disconnect(); } catch (e) {}
      }, 1200);
      duckFor('curtainClose', 0.5);
    }
    if (p < 0.85) s.armedEnd = true;
    // back at fully open — a smaller settle
    if (p <= 0.015 && s.armedStart) {
      s.armedStart = false;
      const w = gainNode(ac, 1); w.connect(chain.bus);
      const built = thump(ac, w, bufs.white, now + 0.01, { f0: 60, f1: 44, g: 0.14, dur: 0.28 });
      setTimeout(() => {
        for (const src of built.sources) { try { src.disconnect(); } catch (e) {} }
        for (const n of built.nodes) { try { n.disconnect(); } catch (e) {} }
        try { w.disconnect(); } catch (e) {}
      }, 900);
    }
    if (p > 0.15) s.armedStart = true;

    s.lastP = p; s.lastT = nowMs;
    return true;
  }

  function stopScrub() {
    if (!scrub) return;
    const s = scrub; scrub = null;
    for (const src of s.sources) { try { src.stop(); } catch (e) {} try { src.disconnect(); } catch (e) {} }
    try { s.bp.disconnect(); s.lp.disconnect(); s.gCloth.disconnect(); s.gRum.disconnect(); } catch (e) {}
    try { s.out.disconnect(); s.sg.disconnect(); } catch (e) {}
  }

  /* ---------------- enable / disable ----------------
     `enabled` is the preference, not the machinery. It flips only when the
     visitor chooses (toggle) or when storage said so at load; the state of
     the AudioContext never rewrites it, and storage is written in exactly
     two places: enable() and disable(), both reachable only from a choice
     the visitor made. */

  /* Bring the audio machinery up to match an enabled preference. Safe to
     call any number of times; if the browser refuses to run the context
     (no user activation has landed yet) the gesture listeners stay armed
     and the next gesture tries again. */
  function bringUp() {
    if (disposed || !enabled) return;
    const c = ensureContext();
    if (!c) return;
    const proceed = () => {
      if (!enabled || disposed || !ac) return;
      if (ac.state !== 'running') return;    // stay armed; a later gesture will land
      removeGestureListeners();
      chain.master.gain.cancelScheduledValues(ac.currentTime);
      chain.master.gain.setTargetAtTime(0.9, ac.currentTime, 0.12);
      startBed();
      syncButtons();
    };
    if (c.state === 'suspended') c.resume().then(proceed, proceed);
    else proceed();
  }

  function enable() {
    if (disposed) return;
    enabled = true;
    store(true);
    if (!ensureContext()) { enabled = false; syncButtons(); return; }
    syncButtons();
    bringUp();
    // called outside a user activation? arm for the first gesture of any kind
    if (ac.state !== 'running') armGestures();
  }

  function disable() {
    if (disposed) return;
    enabled = false;
    store(false);
    removeGestureListeners();
    if (ac && chain) {
      chain.master.gain.cancelScheduledValues(ac.currentTime);
      chain.master.gain.setTargetAtTime(0.0001, ac.currentTime, 0.08);
    }
    stopBed(false);
    stopScrub();
    // suspend a beat later so the fade-out is heard, then the clock stops
    setTimeout(() => { if (!enabled && ac && ac.state === 'running') ac.suspend(); }, 450);
    syncButtons();
  }

  function toggle() {
    if (enabled) { disable(); }
    else { enable(); play('tick'); }
    return enabled;
  }

  function setRoom(level) {
    roomLevel = Math.min(1, Math.max(0, +level || 0));
    // asking for a non-zero room level is asking for the room: remember it,
    // so the bed starts now if it can, or on the first gesture that lands.
    if (roomLevel > 0) { bedRequested = true; startBed(); }
    if (bed && ac) bed.out.gain.setTargetAtTime(roomLevel, ac.currentTime, 0.4);
  }

  /* ---------------- visibility ----------------
     Backgrounding suspends the clock; coming back resumes it. This touches
     only the context, never `enabled` and never storage — the preference
     cannot be clobbered by tabbing away. */
  function onVisibility() {
    if (!ac) return;
    if (document.hidden) {
      if (ac.state === 'running') ac.suspend().catch(() => {});
    } else if (enabled && ac.state === 'suspended') {
      ac.resume().catch(() => {});
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  /* Returning from the back/forward cache: same contract as visibility —
     resume if we may, re-arm for a gesture if we may not. */
  function onPageShow() {
    if (disposed || !enabled) return;
    if (ac && ac.state === 'suspended' && !document.hidden) ac.resume().catch(() => {});
    if (!ac || ac.state !== 'running') armGestures();
  }
  addEventListener('pageshow', onPageShow);

  /* ---------------- restore a persisted opt-in ----------------
     A stored "on" IS on: `enabled` comes up true immediately, the toggle
     stamps "Sound · On", and the stored value is never rewritten by this
     path. Only the machinery waits — the context needs a user gesture, so
     listeners for a gesture of any kind (pointer, key, wheel, scroll,
     touch) each try to bring the audio up, and stay armed until one
     actually lands (scroll and wheel do not count as user activation in
     every browser, so success is checked, never assumed).
     Under prefers-reduced-motion the stored choice is deliberately not
     auto-restored: nothing self-starts, the toggle still works, and the
     stored value is left exactly as the visitor set it. */
  const GESTURE_EVENTS = ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'];
  let gestureArmed = false;
  function onFirstGesture() {
    if (!disposed && enabled) bringUp();
  }
  function armGestures() {
    if (gestureArmed || disposed) return;
    gestureArmed = true;
    for (const ev of GESTURE_EVENTS) {
      addEventListener(ev, onFirstGesture, ev === 'keydown' ? false : { passive: true });
    }
  }
  function removeGestureListeners() {
    if (!gestureArmed) return;
    gestureArmed = false;
    for (const ev of GESTURE_EVENTS) removeEventListener(ev, onFirstGesture);
  }
  if (!reduced && readStored()) {
    enabled = true;
    armGestures();
  }

  /* ---------------- the toggle button ---------------- */
  const STYLE_ID = 't3snd-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
.t3snd-btn {
  appearance: none;
  -webkit-appearance: none;
  display: inline-block;
  padding: 8px 14px;
  font-family: 'Montserrat', Arial, sans-serif;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .22em;
  text-transform: uppercase;
  white-space: nowrap;
  color: rgba(232, 199, 122, .82);
  background: rgba(21, 5, 5, .55);
  border: 1px solid rgba(232, 199, 122, .38);
  border-radius: 2px;
  cursor: pointer;
  transition: color 260ms ease, border-color 260ms ease, background 260ms ease;
}
.t3snd-btn:hover {
  color: #E8C77A;
  border-color: rgba(232, 199, 122, .7);
  background: rgba(30, 8, 6, .65);
}
.t3snd-btn:focus-visible {
  outline: 1px solid rgba(232, 199, 122, .9);
  outline-offset: 4px;
}
.t3snd-btn.is-on {
  color: #E8C77A;
  border-color: rgba(232, 199, 122, .62);
}
@media (prefers-reduced-motion: reduce) {
  .t3snd-btn { transition: none; }
}`;
    document.head.appendChild(st);
  }

  function syncButtons() {
    for (const b of buttons) {
      b.textContent = enabled ? 'Sound · On' : 'Sound · Off';
      b.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      b.classList.toggle('is-on', enabled);
    }
  }

  function makeToggleButton() {
    injectStyle();
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 't3snd-btn';
    b.setAttribute('aria-label', 'Toggle sound');
    buttons.add(b);
    b.addEventListener('click', () => { removeGestureListeners(); toggle(); });
    // stamp initial state
    b.textContent = enabled ? 'Sound · On' : 'Sound · Off';
    b.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    b.classList.toggle('is-on', enabled);
    return b;
  }

  /* ---------------- dispose ---------------- */
  function dispose() {
    if (disposed) return;
    disposed = true;
    enabled = false;
    removeGestureListeners();
    document.removeEventListener('visibilitychange', onVisibility);
    removeEventListener('pageshow', onPageShow);
    stopBed(true);
    stopScrub();
    for (const set of voices.values()) for (const v of set) v.kill();
    voices.clear();
    buttons.clear();
    if (ac) { const c = ac; ac = null; chain = null; bufs = null; try { c.close(); } catch (e) {} }
  }

  /* ---------------- publish ---------------- */
  const api = {
    get enabled() { return enabled; },
    enable, disable, toggle,
    cue: play,
    setRoom,
    makeToggleButton,
    dispose,
    selfTest,
  };
  ctx.sound = api;
  return api;
}

/* ============================ selfTest ============================
   Renders every cue through an OfflineAudioContext using the same output
   chain and a seeded RNG, and measures what came out. Run in a browser:
     const r = await (await import('./theater3d-sound.js')).selfTest();
     console.table(r.results);
   Expected values are in the header comment; each result carries its own
   expectation and a pass flag with loose tolerances.                    */

const EXPECT = {
  curtainOpen:  { peak: [0.10, 0.55], rms: [0.015, 0.110] },
  curtainClose: { peak: [0.10, 0.60], rms: [0.015, 0.110] },
  roomTone:     { peak: [0.015, 0.160], rms: [0.005, 0.050] },
  bookOut:      { peak: [0.04, 0.35], rms: [0.006, 0.070] },
  bookOpen:     { peak: [0.06, 0.40], rms: [0.008, 0.080] },
  pageTurn:     { peak: [0.05, 0.35], rms: [0.006, 0.060] },
  tick:         { peak: [0.015, 0.25], rms: [0.002, 0.050] },
};

/* one pass of an RBJ biquad over a mono Float32Array, for rough band RMS */
function biquadRms(data, sr, type, f, Q) {
  Q = Q || Math.SQRT1_2;
  const w0 = TAU * f / sr, cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'lowpass') {
    b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
  } else { // highpass
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
  }
  a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, acc = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    acc += y * y;
  }
  return Math.sqrt(acc / data.length);
}

export async function selfTest() {
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) return { ok: false, error: 'OfflineAudioContext unavailable' };
  const sr = 44100;
  const results = {};
  let allPass = true;

  for (const name of Object.keys(CUES)) {
    const def = CUES[name];
    const renderS = def.bed ? 3.0 : def.dur + def.tail;
    const oc = new OAC(2, Math.ceil(renderS * sr), sr);
    const rng = mulberry32(42);
    const chain = buildChain(oc, rng);
    const bufs = makeBuffers(oc, mulberry32(7));

    const out = gainNode(oc, def.bed ? 0.8 : 1);
    out.connect(chain.bus);
    if (def.send > 0) {
      const sg = gainNode(oc, def.send);
      out.connect(sg); sg.connect(chain.wetIn);
    }
    const buildRng = mulberry32(1234);
    const opts = def.bed ? { dur: renderS - 0.05 }
      : (name === 'pageTurn' ? { rate: 1 } : {});
    def.build(oc, out, bufs, 0.02, buildRng, opts);

    const rendered = await oc.startRendering();
    const L = rendered.getChannelData(0), R = rendered.getChannelData(1);
    const n = L.length;
    const mono = new Float32Array(n);
    let peak = 0, acc = 0, lastAudible = 0;
    for (let i = 0; i < n; i++) {
      const m = (L[i] + R[i]) * 0.5;
      mono[i] = m;
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > peak) peak = a;
      if (a > 0.001) lastAudible = i;            // -60 dBFS
      acc += m * m;
    }
    const rms = Math.sqrt(acc / n);
    const effDur = lastAudible / sr;

    // rough spectral balance: low < 200, mid 250..2500, high > 2500 (air check
    // for the bed uses > 6000 separately)
    const low = biquadRms(mono, sr, 'lowpass', 200);
    const midHp = biquadRms(mono, sr, 'highpass', 250);
    const high = biquadRms(mono, sr, 'highpass', 2500);
    const mid = Math.max(0, Math.sqrt(Math.max(0, midHp * midHp - high * high)));
    const air = biquadRms(mono, sr, 'highpass', 6000);

    const exp = EXPECT[name];
    const checks = [];
    let pass = true;
    const inR = (v, r) => v >= r[0] && v <= r[1];
    if (!inR(peak, exp.peak)) { pass = false; checks.push(`peak ${peak.toFixed(3)} outside [${exp.peak}]`); }
    if (!inR(rms, exp.rms)) { pass = false; checks.push(`rms ${rms.toFixed(4)} outside [${exp.rms}]`); }
    if (peak > 0.95) { pass = false; checks.push('limiter failed: peak > 0.95'); }
    if (!def.bed && (effDur < def.dur * 0.5 || effDur > def.dur + def.tail + 0.3)) {
      pass = false; checks.push(`effective duration ${effDur.toFixed(2)}s outside [${(def.dur * 0.5).toFixed(2)}, ${(def.dur + def.tail + 0.3).toFixed(2)}]`);
    }
    if (name === 'roomTone' && low < mid * 2.5) { pass = false; checks.push('bed reads as hiss: low < 2.5x mid'); }
    if ((name === 'pageTurn' || name === 'tick') && high <= low) { pass = false; checks.push('transient not bright: high <= low'); }

    results[name] = {
      duration: +effDur.toFixed(3),
      declared: def.bed ? renderS : def.dur,
      peak: +peak.toFixed(4),
      rms: +rms.toFixed(5),
      low: +low.toFixed(5),
      mid: +mid.toFixed(5),
      high: +high.toFixed(5),
      air: +air.toFixed(5),
      expectPeak: exp.peak.join('..'),
      expectRms: exp.rms.join('..'),
      pass,
      notes: checks.join('; ') || 'ok',
    };
    if (!pass) allPass = false;
  }

  return { ok: allPass, results };
}
