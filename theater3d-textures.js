// theater3d-textures.js — every surface in the theater is painted here, on canvases.

// No image downloads: wood, velvet, brass, paper and the generated covers are all procedural.
import * as THREE from 'three';

/* ---------------- utilities ---------------- */

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// deterministic PRNG so the scene looks the same on every load
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// tileable value noise on a canvas-sized grid
function valueNoise(w, h, cell, rand) {
  const gw = Math.ceil(w / cell) + 1, gh = Math.ceil(h / cell) + 1;
  const g = new Float32Array(gw * gh);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const sm = t => t * t * (3 - 2 * t);
  return (x, y) => {
    const gx = (x / cell) % (gw - 1), gy = (y / cell) % (gh - 1);
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = sm(gx - x0), fy = sm(gy - y0);
    const i00 = g[y0 * gw + x0], i10 = g[y0 * gw + x0 + 1];
    const i01 = g[(y0 + 1) * gw + x0], i11 = g[(y0 + 1) * gw + x0 + 1];
    return (i00 * (1 - fx) + i10 * fx) * (1 - fy) + (i01 * (1 - fx) + i11 * fx) * fy;
  };
}

function fbm(w, h, cells, rand) {
  const octaves = cells.map(c => valueNoise(w, h, c, rand));
  return (x, y) => {
    let v = 0, amp = 1, tot = 0;
    for (const o of octaves) { v += o(x, y) * amp; tot += amp; amp *= 0.5; }
    return v / tot;
  };
}

function tex(c, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/* ---------------- WOOD ---------------- */
export function makeWood({
  size = 1024, planks = 7, seed = 7,
  base = [92, 54, 26], dark = [46, 24, 10], light = [148, 96, 48],
  grainAlpha = 0.35, gapPx = 3,
  tint = [0, 0, 0],       // optional additive rgb shift so callers can warm/cool a piece
  variance = 1,           // multiplies plank-to-plank heartwood/sapwood drift
} = {}) {
  const rand = mulberry32(seed);
  // the fields are low-frequency, so they are baked to coarse lookup grids once
  // instead of evaluating noise per pixel — ~4× faster over a 1024² board
  const grid = (step, fn) => {
    const n = Math.ceil(size / step) + 1;
    const a = new Float32Array(n * n);
    for (let gy = 0; gy < n; gy++) for (let gx = 0; gx < n; gx++) a[gy * n + gx] = fn(gx * step, gy * step);
    return { a, n, step };
  };
  const look = (f2, xx, yy) => f2.a[((yy / f2.step) | 0) * f2.n + ((xx / f2.step) | 0)];
  const undN = fbm(size, size, [241, 101], rand);
  const wobN = fbm(size, size, [73, 29], rand);
  const shnN = valueNoise(size, size, 337, rand);
  const fineN = valueNoise(size, size, 4, rand);
  const und = grid(4, undN);   // slow patches → where the cool undertone lives
  const wob = grid(2, wobN);   // deflects the rings so the figure wanders
  const shn = grid(4, shnN);   // very slow drift → wax sheen / roughness

  // undertones derived from the caller's base so any palette stays coherent:
  // green-grey (red suppressed) and a cooler brown (blue lifted)
  const cool = [base[0] * 0.52, base[1] * 0.88, base[2] * 0.74];
  const coolBrown = [dark[0] * 0.92, dark[1] * 1.02, dark[2] * 1.25];

  const pw = size / planks;
  const P = [];
  for (let p = 0; p < planks; p++) {
    const drift = (rand() - 0.5) * 0.8 * variance;   // sapwood/heartwood banding, plank to plank
    // pith usually off-plank → rings cut the face as arches (cathedral figure)
    const cx = p * pw + pw * 0.5 + (rand() - 0.5) * pw * 3.2;
    const cy = rand() * size * 2 - size * 0.5;
    const ay = 0.10 + rand() * 0.10;                 // ring squash along Y → flame arches
    const ringW = 10 + rand() * 10;
    const phase = rand() * 10;
    const knots = [];
    if (rand() > 0.55) knots.push({ kx: p * pw + pw * (0.22 + rand() * 0.56), ky: size * (0.12 + rand() * 0.76), r: 7 + rand() * 11 });
    const joints = [];
    const nj = 1 + Math.floor(rand() * 2);
    for (let j = 0; j < nj; j++) joints.push(rand() * size);
    const t = drift;
    const early = base.map((b2, i) => b2 + (light[i] - b2) * Math.max(0, t) + (dark[i] - b2) * Math.max(0, -t) + tint[i]);
    const late = dark.map((d2, i) => d2 * (1 + t * 0.25) + tint[i] * 0.6);
    P.push({ cx, cy, ay, ringW, phase, knots, joints, early, late });
  }

  const c = canvas(size, size), x = c.getContext('2d');
  const b = canvas(size, size), bx = b.getContext('2d');
  const r = canvas(size, size), rx = r.getContext('2d');
  const mi = x.createImageData(size, size), md = mi.data;
  const bi = bx.createImageData(size, size), bd = bi.data;
  const ri = rx.createImageData(size, size), rd = ri.data;

  const lateK = grainAlpha / 0.35;   // old knob kept meaningful: it scales ring contrast
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const p = Math.min(planks - 1, (xx / pw) | 0);
      const pp = P[p];
      const i = (yy * size + xx) * 4;

      // anisotropic radius from the off-plank pith, wobbled → arched growth rings
      const rdx = xx - pp.cx, rdy = (yy - pp.cy) * pp.ay;
      let d = Math.sqrt(rdx * rdx + rdy * rdy) + (look(wob, xx, yy) - 0.5) * 16;
      let knotK = 0;
      for (const k of pp.knots) {
        const dx = xx - k.kx, dy = (yy - k.ky) * 0.6, q = dx * dx + dy * dy;
        d += Math.exp(-q / (k.r * k.r * 7)) * k.r * 1.5;   // rings deflect around the knot
        const kk = Math.exp(-q / (k.r * k.r));
        if (kk > knotK) knotK = kk;
      }
      const u = look(und, xx, yy);
      const s = Math.sin((d / pp.ringW + pp.phase) * Math.PI * 2) * 0.5 + 0.5;
      const lw = Math.min(1, Math.pow(s, 5) * (0.55 + 0.6 * u) * lateK) * 0.8; // narrow latewood band, strength varies

      // end-grain darkening near butt joints
      let jk = 0;
      for (const jy of pp.joints) { const q2 = 1 - Math.abs(yy - jy) / 14; if (q2 > jk) jk = q2; }

      const ck = Math.max(0, u - 0.56) * 1.5;   // green-grey lives in patches, not everywhere
      const cb = Math.max(0, 0.42 - u) * 1.3;   // cool-brown in the complementary patches
      const sheen = look(shn, xx, yy) - 0.5;
      const fine = (fineN(xx, yy) - 0.5) * 7; // fine speckle at ~half the old amplitude

      for (let ch = 0; ch < 3; ch++) {
        let v = pp.early[ch] + (pp.late[ch] - pp.early[ch]) * lw;
        v += (cool[ch] - v) * ck * 0.28;
        v += (coolBrown[ch] - v) * cb * 0.22;
        v *= 1 - knotK * 0.55 - jk * 0.28;
        v += sheen * 9 + fine;
        md[i + ch] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      md[i + 3] = 255;

      // bump: latewood ridges do the structure, knots sink, speckle stays quiet
      const bv = 150 - lw * 70 - knotK * 55 + fine * 1.5;
      bd[i] = bd[i + 1] = bd[i + 2] = bv < 0 ? 0 : bv > 255 ? 255 : bv; bd[i + 3] = 255;

      // roughness: open latewood + knots + end grain rough, waxed patches smooth
      const rv = 160 + lw * 28 + knotK * 45 + jk * 20 - sheen * 60;
      rd[i] = rd[i + 1] = rd[i + 2] = rv < 0 ? 0 : rv > 255 ? 255 : rv; rd[i + 3] = 255;
    }
  }
  x.putImageData(mi, 0, 0); bx.putImageData(bi, 0, 0); rx.putImageData(ri, 0, 0);

  // plank gaps, edge catch-light, crisp joint shadows — cheap fills over the field
  for (let p = 0; p < planks; p++) {
    const px0 = p * pw;
    if (gapPx > 0) {
      x.fillStyle = 'rgba(12,5,2,0.9)'; x.fillRect(px0 + pw - gapPx, 0, gapPx, size);
      x.fillStyle = 'rgba(255,230,190,0.05)'; x.fillRect(px0, 0, 1.5, size);
      bx.fillStyle = 'rgb(10,10,10)'; bx.fillRect(px0 + pw - gapPx, 0, gapPx, size);
      rx.fillStyle = 'rgb(210,210,210)'; rx.fillRect(px0 + pw - gapPx, 0, gapPx, size);
    }
    for (const jy of P[p].joints) {
      x.fillStyle = 'rgba(12,5,2,0.6)'; x.fillRect(px0, jy, pw - gapPx, 2);
      bx.fillStyle = 'rgb(24,24,24)'; bx.fillRect(px0, jy, pw - gapPx, 2);
    }
  }

  return { map: tex(c), bump: tex(b, { srgb: false }), rough: tex(r, { srgb: false }) };
}

/* ---------------- VELVET ---------------- */
// dense nap mottle + faint vertical combing; the folds themselves are geometry.
export function makeVelvet({ size = 512, seed = 21, base = [96, 18, 14] } = {}) {
  const rand = mulberry32(seed);
  const c = canvas(size, size), x = c.getContext('2d');
  const n1 = fbm(size, size, [97, 41, 17, 7], rand);

  const img = x.createImageData(size, size), d = img.data;
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const i = (yy * size + xx) * 4;
      const nap = n1(xx, yy);
      const comb = Math.sin(xx * 0.85 + n1(xx * 0.2, yy * 0.2) * 9) * 0.5 + 0.5; // fine vertical threads
      // nap amplitude halved after the "too textured" verdict — the folds are geometry, the map only whispers
      const v = 0.80 + nap * 0.22 + comb * 0.06;
      d[i]     = Math.min(255, base[0] * v);
      d[i + 1] = Math.min(255, base[1] * v);
      d[i + 2] = Math.min(255, base[2] * v);
      d[i + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);

  const b = canvas(size, size), bx = b.getContext('2d');
  bx.filter = 'grayscale(1)';
  bx.drawImage(c, 0, 0);

  const map = tex(c, { repeat: [3, 2] });
  const bump = tex(b, { srgb: false, repeat: [3, 2] });
  return { map, bump };
}

/* ---------------- RUG ---------------- */
export function makeRug({ w = 992, h = 640, seed = 33 } = {}) {
  const rand = mulberry32(seed);
  const c = canvas(w, h), x = c.getContext('2d');
  const cx = w / 2, cy = h / 2;
  const GOLD = 'rgba(232,199,122,';       // + alpha)
  const CREAM = 'rgba(232,215,180,';

  // ground: oxblood wool with slow tone drift so the pile reads as sheared, not painted
  x.fillStyle = '#40100a'; x.fillRect(0, 0, w, h);
  {
    const n = fbm(w, h, [171, 61, 23], rand);
    const img = x.getImageData(0, 0, w, h), d = img.data;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const i = (yy * w + xx) * 4, v = (n(xx, yy) - 0.5) * 16;
        d[i] += v; d[i + 1] += v * 0.7; d[i + 2] += v * 0.6;
      }
    }
    x.putImageData(img, 0, 0);
  }

  // dark selvedge binding at the very edge
  x.strokeStyle = 'rgba(18,5,2,0.85)'; x.lineWidth = 10;
  x.strokeRect(5, 5, w - 10, h - 10);

  x.strokeStyle = GOLD + '0.42)'; x.lineWidth = 3; x.strokeRect(20.5, 20.5, w - 41, h - 41);
  x.strokeStyle = GOLD + '0.30)'; x.lineWidth = 1; x.strokeRect(28.5, 28.5, w - 57, h - 57);

  // guard border: a run of lozenges between the rules and the field
  {
    const b0 = 38, b1 = 78, mid = (b0 + b1) / 2, r = (b1 - b0) * 0.34, step = 56;
    x.strokeStyle = GOLD + '0.34)'; x.lineWidth = 1.5;
    const loz = (px, py) => {
      x.beginPath();
      x.moveTo(px, py - r); x.lineTo(px + r * 1.5, py); x.lineTo(px, py + r); x.lineTo(px - r * 1.5, py);
      x.closePath(); x.stroke();
      x.fillStyle = GOLD + '0.10)'; x.fill();
    };
    // laid out from the centre of each run outward, so the corners always match
    for (let px = cx; px <= w - b1 - r; px += step) { loz(px, mid); loz(w - px, mid); loz(px, h - mid); loz(w - px, h - mid); }
    for (let py = cy; py <= h - b1 - r; py += step) { loz(mid, py); loz(mid, h - py); loz(w - mid, py); loz(w - mid, h - py); }
    x.strokeStyle = GOLD + '0.24)'; x.lineWidth = 1;
    x.strokeRect(b1 + 0.5, b1 + 0.5, w - b1 * 2 - 1, h - b1 * 2 - 1);
  }

  // field diaper: a whisper of diagonal lattice so the ground is not flat
  {
    x.save();
    x.beginPath(); x.rect(84, 84, w - 168, h - 168); x.clip();
    x.strokeStyle = GOLD + '0.045)'; x.lineWidth = 1;
    const sp = 46;
    for (let k = -h; k < w + h; k += sp) {
      x.beginPath(); x.moveTo(k, 0); x.lineTo(k + h, h); x.stroke();
      x.beginPath(); x.moveTo(k, h); x.lineTo(k + h, 0); x.stroke();
    }
    x.restore();
  }

  // the medallion — concentric and at the *true* centre, which is the whole point
  {
    const ring = (r, a, lw) => {
      x.strokeStyle = GOLD + a + ')'; x.lineWidth = lw;
      x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.stroke();
    };
    x.fillStyle = CREAM + '0.07)';
    x.beginPath(); x.arc(cx, cy, 150, 0, Math.PI * 2); x.fill();
    ring(150, '0.40', 2.5); ring(140, '0.26', 1);
    // sixteen-point star
    x.beginPath();
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2 - Math.PI / 2;
      const r = k % 2 === 0 ? 128 : 88;
      const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
      if (k === 0) x.moveTo(px, py); else x.lineTo(px, py);
    }
    x.closePath();
    x.fillStyle = 'rgba(64,16,10,0.9)'; x.fill();
    x.strokeStyle = GOLD + '0.38)'; x.lineWidth = 1.5; x.stroke();
    x.fillStyle = CREAM + '0.10)';
    x.beginPath(); x.arc(cx, cy, 62, 0, Math.PI * 2); x.fill();
    ring(62, '0.34', 1.5);
    // centre boss
    x.fillStyle = GOLD + '0.45)';
    x.beginPath(); x.arc(cx, cy, 16, 0, Math.PI * 2); x.fill();
    ring(26, '0.24', 1);
  }

  // corner quarter-fans, one drawing mirrored four ways so they can never disagree
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    x.save();
    x.translate(sx > 0 ? 84 : w - 84, sy > 0 ? 84 : h - 84);
    x.scale(sx, sy);
    x.strokeStyle = GOLD + '0.30)'; x.lineWidth = 1.5;
    x.beginPath(); x.arc(0, 0, 96, 0, Math.PI / 2); x.stroke();
    x.strokeStyle = GOLD + '0.20)'; x.lineWidth = 1;
    x.beginPath(); x.arc(0, 0, 78, 0, Math.PI / 2); x.stroke();
    for (let k = 1; k < 6; k++) {
      const a = (k / 6) * Math.PI / 2;
      x.beginPath(); x.moveTo(Math.cos(a) * 34, Math.sin(a) * 34);
      x.lineTo(Math.cos(a) * 92, Math.sin(a) * 92); x.stroke();
    }
    x.restore();
  }

  // weave: fine weft and warp over everything, so motif and ground share one cloth
  for (let yy = 1.5; yy < h; yy += 3) {
    x.strokeStyle = `rgba(0,0,0,${(0.03 + rand() * 0.05).toFixed(3)})`; x.lineWidth = 1;
    x.beginPath(); x.moveTo(0, yy); x.lineTo(w, yy + (rand() - 0.5) * 1.5); x.stroke();
  }
  for (let xx = 1.5; xx < w; xx += 6) {
    x.strokeStyle = `rgba(255,235,205,${(rand() * 0.025).toFixed(3)})`; x.lineWidth = 1;
    x.beginPath(); x.moveTo(xx, 0); x.lineTo(xx + (rand() - 0.5) * 2, h); x.stroke();
  }

  // wear: pale abrasions where feet actually go — off-centre, soft, few
  const wearAt = (px, py, r, a) => {
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, CREAM + a + ')'); g.addColorStop(1, CREAM + '0)');
    x.fillStyle = g; x.fillRect(px - r, py - r, r * 2, r * 2);
  };
  wearAt(cx + w * 0.22, cy + h * 0.18, 120, '0.06');
  wearAt(cx - w * 0.26, cy - h * 0.10, 95, '0.05');
  wearAt(cx + w * 0.05, cy + h * 0.30, 140, '0.07');   // the tread line downstage
  for (let i = 0; i < 3; i++) wearAt(rand() * w, rand() * h, 40 + rand() * 60, '0.035');

  // edges settle into shadow so the rug sits down on the boards
  const vg = x.createRadialGradient(cx, cy, h * 0.30, cx, cy, w * 0.62);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.20)');
  x.fillStyle = vg; x.fillRect(0, 0, w, h);

  return tex(c);   // clamped by default: this cloth exists once, edge to edge
}

/* ---------------- painted panelling / plaster ---------------- */
export function makePaint({ size = 512, seed = 5, base = [52, 15, 12], vary = 16, repeat = [2, 2] } = {}) {
  const rand = mulberry32(seed);
  const c = canvas(size, size), x = c.getContext('2d');
  const n = fbm(size, size, [141, 53, 19], rand);
  const img = x.createImageData(size, size), d = img.data;
  for (let yy = 0; yy < size; yy++) {
    for (let xx = 0; xx < size; xx++) {
      const i = (yy * size + xx) * 4;
      const brush = Math.sin(yy * 0.4 + n(xx, yy) * 8) * 0.04; // faint vertical brushing
      // 0.55 damp: callers keep their vary values but the whole wall reads as paint, not static
      const v = (n(xx, yy) - 0.5 + brush) * vary * 0.55;
      d[i] = base[0] + v; d[i + 1] = base[1] + v * 0.8; d[i + 2] = base[2] + v * 0.7; d[i + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  return tex(c, { repeat });
}

/* ---------------- BRASS ---------------- */
function brassBase(x, w, h, seed) {
  const rand = mulberry32(seed);
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#8a6a2c');
  g.addColorStop(0.18, '#d9b96a');
  g.addColorStop(0.5, '#f3dfa0');
  g.addColorStop(0.55, '#caa552');
  g.addColorStop(0.85, '#93712f');
  g.addColorStop(1, '#6e521f');
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
  // brushed lines — halved in count and weight; the gradient does the metal, these only hint
  for (let i = 0; i < 45; i++) {
    const yy = rand() * h;
    x.strokeStyle = rand() > 0.5 ? `rgba(255,240,200,${(rand() * 0.06).toFixed(3)})` : `rgba(70,50,15,${(rand() * 0.07).toFixed(3)})`;
    x.lineWidth = 0.7 + rand();
    x.beginPath(); x.moveTo(0, yy); x.lineTo(w, yy + (rand() - 0.5) * 3); x.stroke();
  }
}

// small engraved plate: month/year under a slot
export function makeBrassPlate(text, { w = 256, h = 64, seed = 3, font = 600, fs = 0.42 } = {}) {
  const c = canvas(w, h), x = c.getContext('2d');
  brassBase(x, w, h, seed + text.length);
  // bevel edge
  x.strokeStyle = 'rgba(255,244,205,0.85)'; x.lineWidth = 3; x.strokeRect(1.5, 1.5, w - 3, h - 3);
  x.strokeStyle = 'rgba(60,40,10,0.9)'; x.lineWidth = 2; x.strokeRect(4.5, 4.5, w - 9, h - 9);
  // screws
  for (const sx of [10, w - 10]) {
    x.fillStyle = '#5c451a'; x.beginPath(); x.arc(sx, h / 2, 3.4, 0, 7); x.fill();
    x.strokeStyle = 'rgba(255,240,200,.7)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(sx - 2.4, h / 2); x.lineTo(sx + 2.4, h / 2); x.stroke();
  }
  // engraved text: dark fill + light lower ridge
  x.font = `${font} ${Math.round(h * fs)}px Montserrat, sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  const cx = w / 2, cy = h / 2 + 1;
  x.fillStyle = 'rgba(255,244,205,0.5)'; x.fillText(text, cx, cy + 1.5);
  x.fillStyle = '#3a2708'; x.fillText(text, cx, cy);
  return tex(c);
}

// the fascia board under a shelf plank: dark wood with an engraved brass row plate centred
export function makeFascia(rowName, { w = 2048, h = 128, seed = 11 } = {}) {
  const c = canvas(w, h), x = c.getContext('2d');
  const rand = mulberry32(seed);
  // dark wood, horizontal grain
  x.fillStyle = '#33190b'; x.fillRect(0, 0, w, h);
  for (let i = 0; i < 90; i++) { // fewer, quieter grain lines — the fascia is a support, not a feature
    const yy = rand() * h;
    x.strokeStyle = rand() > 0.5 ? `rgba(20,9,3,${(0.07 + rand() * 0.13).toFixed(2)})` : `rgba(120,70,30,${(rand() * 0.10).toFixed(2)})`;
    x.lineWidth = 0.6 + rand() * 2;
    x.beginPath();
    x.moveTo(0, yy);
    for (let xx = 0; xx <= w; xx += 64) x.lineTo(xx, yy + Math.sin(xx * 0.004 + i) * 3);
    x.stroke();
  }
  x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(0, 0, w, 6);            // shadow under plank lip
  x.fillStyle = 'rgba(255,220,170,0.10)'; x.fillRect(0, h - 4, w, 4);  // catch light at bottom edge

  // centred brass strip
  const bw = Math.min(w * 0.36, rowName.length * 30 + 160), bh = h * 0.52;
  const bx0 = (w - bw) / 2, by0 = (h - bh) / 2;
  x.save();
  x.translate(bx0, by0);
  const g = x.createLinearGradient(0, 0, 0, bh);
  g.addColorStop(0, '#9a7834'); g.addColorStop(0.3, '#e6cc84'); g.addColorStop(0.55, '#c2a050'); g.addColorStop(1, '#7c5f26');
  x.fillStyle = g; x.fillRect(0, 0, bw, bh);
  x.strokeStyle = 'rgba(255,244,205,0.8)'; x.lineWidth = 2.5; x.strokeRect(1, 1, bw - 2, bh - 2);
  x.strokeStyle = 'rgba(50,32,8,0.9)'; x.lineWidth = 2; x.strokeRect(4, 4, bw - 8, bh - 8);
  x.font = `600 ${Math.round(bh * 0.44)}px Montserrat, sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = 'rgba(255,244,205,0.45)'; x.fillText(rowName, bw / 2, bh / 2 + 2.5);
  x.fillStyle = '#33220a'; x.fillText(rowName, bw / 2, bh / 2 + 1);
  x.restore();
  return tex(c);
}

/* ---------------- PAPER ---------------- */
// page-block edges: warm white with fine leaf lines
export function makePaperEdge({ w = 256, h = 256, horizontal = true, seed = 9 } = {}) {
  const rand = mulberry32(seed);
  const c = canvas(w, h), x = c.getContext('2d');
  x.fillStyle = '#ece2c4'; x.fillRect(0, 0, w, h);
  const lines = 90;
  for (let i = 0; i < lines; i++) {
    const p = (i / lines) * (horizontal ? h : w) + rand() * 2;
    x.strokeStyle = `rgba(120,100,60,${(0.07 + rand() * 0.12).toFixed(2)})`; // leaves stay countable, not stripey
    x.lineWidth = 0.8;
    x.beginPath();
    if (horizontal) { x.moveTo(0, p); x.lineTo(w, p + (rand() - 0.5) * 1.5); }
    else { x.moveTo(p, 0); x.lineTo(p + (rand() - 0.5) * 1.5, h); }
    x.stroke();
  }
  const g = x.createLinearGradient(0, 0, horizontal ? 0 : w, horizontal ? h : 0);
  g.addColorStop(0, 'rgba(60,40,10,0.18)'); g.addColorStop(0.5, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(60,40,10,0.22)');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  return tex(c);
}

/* ---------------- GENERATED COVERS ---------------- */
// paper grain pass shared by generated covers — strengths cut ~half across all callers
function paperGrain(x, w, h, seed, strength = 5) {
  const rand = mulberry32(seed);
  const n = fbm(w, h, [83, 29, 11], rand);
  const img = x.getImageData(0, 0, w, h), d = img.data;
  for (let yy = 0; yy < h; yy += 1) {
    for (let xx = 0; xx < w; xx += 1) {
      const i = (yy * w + xx) * 4;
      const v = (n(xx, yy) - 0.5) * strength;
      d[i] += v; d[i + 1] += v; d[i + 2] += v;
    }
  }
  x.putImageData(img, 0, 0);
}

export function makeCoverBulletin({ no = 2, monthLine = '№ 2 · OCT 2025', w = 512, h = 724, seed = 31 }) {
  const c = canvas(w, h), x = c.getContext('2d');
  // deep oxblood ground with diagonal light rake like the shot cover
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#5c1410'); g.addColorStop(0.45, '#420503'); g.addColorStop(1, '#2e0402');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const rand = mulberry32(seed);
  for (let i = 0; i < 6; i++) { // soft diagonal light streaks
    const sx = rand() * w * 1.4 - w * 0.2;
    const lg = x.createLinearGradient(sx, 0, sx + 130, h);
    lg.addColorStop(0, 'rgba(0,0,0,0)');
    lg.addColorStop(0.5, `rgba(190,80,60,${(0.05 + rand() * 0.07).toFixed(2)})`);
    lg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = lg;
    x.save(); x.translate(w / 2, h / 2); x.rotate(-0.5); x.translate(-w / 2, -h / 2);
    x.fillRect(sx, -h * 0.3, 130, h * 1.6); x.restore();
  }
  // inner rectangle panel, like the printed cover's plate
  x.strokeStyle = 'rgba(0,0,0,0.35)'; x.lineWidth = 2;
  x.strokeRect(w * 0.12, h * 0.42, w * 0.76, h * 0.4);
  x.fillStyle = 'rgba(0,0,0,0.16)'; x.fillRect(w * 0.12, h * 0.42, w * 0.76, h * 0.4);

  x.textAlign = 'center';
  // month banner
  x.font = `700 ${Math.round(w * 0.045)}px Montserrat, sans-serif`;
  x.fillStyle = '#F0F0F0';
  const [numPart, monthPart] = monthLine.split('·').map(s => s.trim());
  x.fillText(monthPart.toUpperCase(), w / 2, h * 0.10);
  // kicker
  x.font = `400 ${Math.round(w * 0.052)}px "Noto Serif Display", Georgia, serif`;
  x.fillStyle = '#F8F0D8';
  x.save();
  x.translate(w / 2, h * 0.20);
  x.scale(1.02, 1);
  const kick = "THE SOCIETY'S MONTHLY";
  x.fillText(kick.split('').join(' '), 0, 0);
  x.restore();
  // masthead
  x.font = `700 ${Math.round(w * 0.168)}px "Noto Serif Display", Georgia, serif`;
  x.fillStyle = 'rgba(0,0,0,0.45)';
  x.fillText('BULLETIN', w / 2 + 4, h * 0.325 + 4);
  const gg = x.createLinearGradient(0, h * 0.24, 0, h * 0.34);
  gg.addColorStop(0, '#f6dd92'); gg.addColorStop(0.55, '#E8C77A'); gg.addColorStop(1, '#c49b46');
  x.fillStyle = gg;
  x.fillText('BULLETIN', w / 2, h * 0.325);
  // rule + college line
  x.fillStyle = '#E8C77A'; x.fillRect(w * 0.08, h * 0.365, w * 0.84, 2);
  x.font = `700 ${Math.round(w * 0.031)}px Montserrat, sans-serif`;
  x.fillStyle = '#F8F0D8';
  x.fillText('SAMPLE COLLEGE OF COMMERCE', w / 2, h * 0.405);
  // big issue number in the plate
  x.font = `400 ${Math.round(w * 0.34)}px "Noto Serif Display", Georgia, serif`;
  x.fillStyle = 'rgba(232,199,122,0.9)';
  x.fillText(String(no), w / 2, h * 0.66);
  x.font = `italic 400 ${Math.round(w * 0.05)}px "Crimson Pro", Georgia, serif`;
  x.fillStyle = 'rgba(248,240,216,0.85)';
  x.fillText(numPart + ' · ' + monthPart, w / 2, h * 0.755);
  // footer
  x.font = `700 ${Math.round(w * 0.042)}px "Noto Serif Display", Georgia, serif`;
  x.fillStyle = '#E8C77A';
  x.fillText(no === 1 ? 'FIRST EDITION' : 'SECOND EDITION', w / 2, h * 0.93);
  x.font = `500 ${Math.round(w * 0.026)}px Montserrat, sans-serif`;
  x.fillStyle = 'rgba(240,240,240,0.75)';
  x.fillText('CURATED BY THE SOCIETY TEAM', w / 2, h * 0.885);

  paperGrain(x, w, h, seed, 4);
  return tex(c);
}

export function makeCoverCasebook1({ w = 512, h = 724, seed = 41 } = {}) {
  const c = canvas(w, h), x = c.getContext('2d');
  x.fillStyle = '#e9e6df'; x.fillRect(0, 0, w, h);
  const rand = mulberry32(seed);
  // marbled grey wash
  const n = fbm(w, h, [151, 67, 23], rand);
  const img = x.getImageData(0, 0, w, h), d = img.data;
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
    const i = (yy * w + xx) * 4, v = (n(xx, yy) - 0.5) * 14;
    d[i] += v; d[i + 1] += v; d[i + 2] += v;
  }
  x.putImageData(img, 0, 0);
  // circuit-ish traces, faint
  x.strokeStyle = 'rgba(120,120,120,0.5)'; x.lineWidth = 1.4;
  for (let i = 0; i < 26; i++) {
    let px = rand() * w, py = rand() * h;
    x.beginPath(); x.moveTo(px, py);
    for (let s = 0; s < 4; s++) {
      if (rand() > 0.5) px += (rand() - 0.5) * 160; else py += (rand() - 0.5) * 160;
      x.lineTo(px, py);
    }
    x.stroke();
    x.fillStyle = 'rgba(120,120,120,0.55)';
    x.beginPath(); x.arc(px, py, 3.4, 0, 7); x.fill();
  }
  // red corner diagonals
  const red = '#b01810', deep = '#7c100a';
  const tri = (pts, col) => { x.fillStyle = col; x.beginPath(); x.moveTo(...pts[0]); pts.slice(1).forEach(p => x.lineTo(...p)); x.closePath(); x.fill(); };
  tri([[0, h], [0, h - 190], [230, h]], red);
  tri([[0, h], [0, h - 110], [140, h]], '#e9e6df');
  tri([[0, h], [0, h - 60], [80, h]], deep);
  tri([[w, 0], [w - 210, 0], [w, 170]], red);
  tri([[w, 0], [w - 120, 0], [w, 90]], deep);
  tri([[w, h], [w, h - 150], [w - 170, h]], red);
  // titles
  x.textAlign = 'left';
  x.fillStyle = '#141414';
  x.font = `700 ${Math.round(w * 0.155)}px Montserrat, sans-serif`;
  x.fillText('CASEBOOK', w * 0.1, h * 0.335);
  x.font = `700 ${Math.round(w * 0.062)}px Montserrat, sans-serif`;
  x.fillText('MARKETING CASEBOOK', w * 0.1, h * 0.395);
  x.fillStyle = '#8c2014';
  x.font = `700 ${Math.round(w * 0.055)}px Montserrat, sans-serif`;
  x.fillText('First Edition', w * 0.1, h * 0.455);
  x.fillStyle = '#333';
  x.font = `700 ${Math.round(w * 0.037)}px Montserrat, sans-serif`;
  x.fillText('2024 to 2025', w * 0.1, h * 0.5);
  x.textAlign = 'right';
  x.font = `700 ${Math.round(w * 0.033)}px Montserrat, sans-serif`;
  x.fillStyle = '#222';
  x.fillText('The Society · A Sample Student Society', w * 0.94, h * 0.75);
  x.fillText('Sample College of Commerce', w * 0.94, h * 0.79);
  paperGrain(x, w, h, seed + 1, 3);
  return tex(c);
}

// spine strip: oxblood cloth with rotated gold title
export function makeSpine(title, { w = 96, h = 724, cloth = '#4a0b06', seed = 51 } = {}) {
  const c = canvas(w, h), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, '#2c0503'); g.addColorStop(0.5, cloth); g.addColorStop(1, '#2c0503');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const rand = mulberry32(seed + title.length);
  for (let i = 0; i < 30; i++) { // cloth weave, quieter
    x.strokeStyle = `rgba(0,0,0,${(rand() * 0.12).toFixed(2)})`;
    x.lineWidth = 1;
    const yy = rand() * h;
    x.beginPath(); x.moveTo(0, yy); x.lineTo(w, yy); x.stroke();
  }
  x.fillStyle = '#E8C77A';
  x.fillRect(w * 0.18, h * 0.035, w * 0.64, 3);
  x.fillRect(w * 0.18, h * 0.955, w * 0.64, 3);
  x.save();
  x.translate(w / 2, h / 2);
  x.rotate(Math.PI / 2);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `600 ${Math.round(w * 0.44)}px "Noto Serif Display", Georgia, serif`;
  x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillText(title, 1.5, 1.5);
  x.fillStyle = '#E8C77A'; x.fillText(title, 0, 0);
  x.restore();
  return tex(c);
}

// plain back cover
export function makeBackCover({ tone = '#3c0906', w = 256, h = 362 } = {}) {
  const c = canvas(w, h), x = c.getContext('2d');
  x.fillStyle = tone; x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(232,199,122,0.35)'; x.lineWidth = 2;
  x.strokeRect(w * 0.08, h * 0.06, w * 0.84, h * 0.88);
  x.textAlign = 'center';
  x.font = `600 ${Math.round(w * 0.07)}px "Noto Serif Display", Georgia, serif`;
  x.fillStyle = 'rgba(232,199,122,0.5)';
  x.fillText('THE SOCIETY', w / 2, h * 0.52);
  paperGrain(x, w, h, 61, 3);
  return tex(c);
}

/* ---------------- SPINE CLOTH ---------------- */
// Six bookcloth grounds so a shelf of spines never reads as one maroon run.
// Everything sits inside the oxblood room's temperature: the tan comes from the
// wood family, the green is bookbinders' green-black — period-correct next to
// oxblood and desaturated enough not to break the palette. Lettering is
// composited on top by the caller (spineCanvas in theater3d-shelf.js), so the
// raw canvas is returned alongside the texture.
const SPINE_CLOTHS = [
  { mid: [74, 11, 6],   edge: [44, 5, 3] },    // deep oxblood — the house cloth
  { mid: [92, 38, 20],  edge: [54, 20, 9] },   // browner ox-red
  { mid: [50, 8, 10],   edge: [28, 4, 5] },    // near-black burgundy
  { mid: [107, 74, 40], edge: [64, 42, 20] },  // dark tan buckram (wood family)
  { mid: [38, 48, 30],  edge: [20, 27, 16] },  // bookbinders' green-black
  { mid: [110, 53, 44], edge: [66, 28, 22] },  // faded rose-oxblood
];

export function spineVariantCount() { return SPINE_CLOTHS.length; }

export function makeSpineCloth({ variant = 0, w = 96, h = 724, seed = 51 } = {}) {
  const v = SPINE_CLOTHS[((variant % SPINE_CLOTHS.length) + SPINE_CLOTHS.length) % SPINE_CLOTHS.length];
  const rand = mulberry32(seed + variant * 131);
  const c = canvas(w, h), x = c.getContext('2d');
  const rgb = (a) => `rgb(${Math.round(a[0])},${Math.round(a[1])},${Math.round(a[2])})`;

  // rounded spine: dark toward the joints, colour on the round
  const g = x.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, rgb(v.edge)); g.addColorStop(0.5, rgb(v.mid)); g.addColorStop(1, rgb(v.edge));
  x.fillStyle = g; x.fillRect(0, 0, w, h);

  // sun fade from the head down, each copy a little differently; shadow pools at the tail
  const f = 0.05 + rand() * 0.07;
  const fade = x.createLinearGradient(0, 0, 0, h);
  fade.addColorStop(0, `rgba(232,215,180,${f.toFixed(3)})`);
  fade.addColorStop(0.35, 'rgba(232,215,180,0)');
  fade.addColorStop(1, 'rgba(0,0,0,0.06)');
  x.fillStyle = fade; x.fillRect(0, 0, w, h);

  // cloth weave: quiet warp + weft hatch — texture the eye finds, not one it trips on
  for (let i = 0; i < 30; i++) {
    x.strokeStyle = `rgba(0,0,0,${(0.03 + rand() * 0.08).toFixed(3)})`;
    x.lineWidth = 1;
    const yy = rand() * h;
    x.beginPath(); x.moveTo(0, yy); x.lineTo(w, yy + (rand() - 0.5) * 2); x.stroke();
  }
  for (let i = 0; i < 10; i++) {
    x.strokeStyle = `rgba(255,240,210,${(rand() * 0.04).toFixed(3)})`;
    x.lineWidth = 1;
    const xx = rand() * w;
    x.beginPath(); x.moveTo(xx, 0); x.lineTo(xx + (rand() - 0.5) * 3, h); x.stroke();
  }

  // wear at head and tail: pale abrasion where fingers pull the volume, a few nicks
  for (const [y0, dir] of [[0, 1], [h, -1]]) {
    const wearH = 8 + rand() * 10;
    const span = wearH * 2.2;
    const wg = x.createLinearGradient(0, y0, 0, y0 + dir * span);
    wg.addColorStop(0, 'rgba(214,196,160,0.18)');
    wg.addColorStop(1, 'rgba(214,196,160,0)');
    x.fillStyle = wg; x.fillRect(0, Math.min(y0, y0 + dir * span), w, span);
    for (let i = 0; i < 6; i++) {
      x.fillStyle = `rgba(20,8,4,${(0.08 + rand() * 0.10).toFixed(2)})`;
      x.fillRect(rand() * w, y0 + dir * rand() * wearH, 1.5 + rand() * 3, 1.2);
    }
  }

  return { canvas: c, texture: tex(c) };
}

/* ---------------- GOLD SURFACE ---------------- */
export function makeGoldSurface({ size = 1024, seed = 61 } = {}) {
  const rand = mulberry32(seed);
  const c = canvas(size, size), x = c.getContext('2d');     // map
  const r = canvas(size, size), rx = r.getContext('2d');    // roughness
  const b = canvas(size, size), bx = b.getContext('2d');    // bump

  x.fillStyle = '#f2e2ba'; x.fillRect(0, 0, size, size);    // near-white warm gold
  rx.fillStyle = 'rgb(80,80,80)'; rx.fillRect(0, 0, size, size); // ~0.31 base polish
  bx.fillStyle = 'rgb(128,128,128)'; bx.fillRect(0, 0, size, size);

  // gentle large-scale value drift — cast metal is never one tone
  for (let i = 0; i < 5; i++) {
    const gx = rand() * size, gy = rand() * size, gr = size * (0.3 + rand() * 0.4);
    const lg = x.createRadialGradient(gx, gy, 0, gx, gy, gr);
    const up = rand() > 0.5;
    lg.addColorStop(0, up ? 'rgba(255,246,214,0.20)' : 'rgba(160,120,60,0.14)');
    lg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = lg; x.fillRect(0, 0, size, size);
    // polished sweeps read smoother, dull pools rougher
    const rg = rx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    rg.addColorStop(0, up ? 'rgba(42,42,42,0.45)' : 'rgba(130,130,130,0.40)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    rx.fillStyle = rg; rx.fillRect(0, 0, size, size);
  }

  // directional tooling striations — full-width, near-horizontal
  for (let i = 0; i < 220; i++) {
    const yy = rand() * size, drift2 = (rand() - 0.5) * 4;
    const lite = rand() > 0.5;
    x.strokeStyle = lite ? `rgba(255,248,220,${(0.02 + rand() * 0.05).toFixed(3)})` : `rgba(150,110,50,${(0.02 + rand() * 0.05).toFixed(3)})`;
    x.lineWidth = 0.6 + rand() * 1.2;
    x.beginPath(); x.moveTo(0, yy); x.lineTo(size, yy + drift2); x.stroke();
    rx.strokeStyle = lite ? `rgba(45,45,45,${(0.10 + rand() * 0.16).toFixed(3)})` : `rgba(125,125,125,${(0.10 + rand() * 0.16).toFixed(3)})`;
    rx.lineWidth = 0.6 + rand() * 1.2;
    rx.beginPath(); rx.moveTo(0, yy); rx.lineTo(size, yy + drift2); rx.stroke();
    bx.strokeStyle = lite ? `rgba(170,170,170,${(0.10 + rand() * 0.12).toFixed(3)})` : `rgba(90,90,90,${(0.10 + rand() * 0.12).toFixed(3)})`;
    bx.lineWidth = 0.6 + rand() * 1.0;
    bx.beginPath(); bx.moveTo(0, yy); bx.lineTo(size, yy + drift2); bx.stroke();
  }

  // micro-pitting: casting flaws — tiny, sparse, rough inside
  for (let i = 0; i < 1300; i++) {
    const px = rand() * size, py = rand() * size, pr = 0.5 + rand() * 1.3;
    x.fillStyle = `rgba(110,80,35,${(0.10 + rand() * 0.12).toFixed(2)})`;
    x.beginPath(); x.arc(px, py, pr, 0, 7); x.fill();
    rx.fillStyle = `rgba(140,140,140,${(0.35 + rand() * 0.3).toFixed(2)})`;
    rx.beginPath(); rx.arc(px, py, pr, 0, 7); rx.fill();
    bx.fillStyle = `rgba(70,70,70,${(0.3 + rand() * 0.3).toFixed(2)})`;
    bx.beginPath(); bx.arc(px, py, pr, 0, 7); bx.fill();
  }

  // faint patina in the recesses: a few soft dull-warm pools, rougher where they sit
  for (let i = 0; i < 7; i++) {
    const gx = rand() * size, gy = rand() * size, gr = size * (0.06 + rand() * 0.12);
    const pg = x.createRadialGradient(gx, gy, 0, gx, gy, gr);
    pg.addColorStop(0, 'rgba(120,88,42,0.10)'); pg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = pg; x.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
    const prg = rx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    prg.addColorStop(0, 'rgba(138,138,138,0.5)'); prg.addColorStop(1, 'rgba(0,0,0,0)');
    rx.fillStyle = prg; rx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
  }

  return { map: tex(c), rough: tex(r, { srgb: false }), bump: tex(b, { srgb: false }) };
}

/* ---------------- GHOST PLATE ---------------- */
// A missing edition's slot must never render as a black hole. This paints the
// deliberate artefact instead: the shelf cavity's own dark wood, a pale
// dust-shadow where the volume kept the dust off, a hairline gold rule and the
// label in spaced Montserrat caps — "this issue exists but is not here yet".
export function makeGhostPlate({ w = 512, h = 724, label = '', sub = '' } = {}) {
  const c = canvas(w, h), x = c.getContext('2d');
  const rand = mulberry32(97 + label.length * 7 + sub.length);

  // ground: the case interior's tone, slightly graded so it has depth
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#241009'); g.addColorStop(0.6, '#2b140c'); g.addColorStop(1, '#1c0b06');
  x.fillStyle = g; x.fillRect(0, 0, w, h);

  // whisper of vertical grain so it belongs to the shelf
  for (let i = 0; i < 26; i++) {
    const gx = rand() * w, ph = rand() * 6;
    x.strokeStyle = `rgba(0,0,0,${(0.04 + rand() * 0.07).toFixed(2)})`;
    x.lineWidth = 0.8 + rand() * 1.5;
    x.beginPath();
    for (let yy = 0; yy <= h; yy += 24) {
      const gx2 = gx + Math.sin(yy * 0.01 + ph) * 4;
      if (yy === 0) x.moveTo(gx2, yy); else x.lineTo(gx2, yy);
    }
    x.stroke();
  }

  // dust-shadow card in the shape of the missing volume
  const bw = w * 0.66, bh = h * 0.82, bx0 = (w - bw) / 2, by0 = (h - bh) / 2;
  const dg = x.createLinearGradient(0, by0, 0, by0 + bh);
  dg.addColorStop(0, 'rgba(248,240,216,0.085)');
  dg.addColorStop(0.5, 'rgba(248,240,216,0.055)');
  dg.addColorStop(1, 'rgba(248,240,216,0.075)');
  x.fillStyle = dg; x.fillRect(bx0, by0, bw, bh);
  // dust settles hardest at the card's foot
  x.fillStyle = 'rgba(248,240,216,0.05)'; x.fillRect(bx0, by0 + bh - h * 0.02, bw, h * 0.02);

  x.strokeStyle = 'rgba(232,199,122,0.30)'; x.lineWidth = 1;
  x.strokeRect(bx0 + 0.5, by0 + 0.5, bw - 1, bh - 1);

  // label + sub, spaced Montserrat caps, deliberately faint
  x.textAlign = 'center'; x.textBaseline = 'middle';
  if (label) {
    x.font = `600 ${Math.round(w * 0.052)}px Montserrat, sans-serif`;
    x.fillStyle = 'rgba(232,199,122,0.42)';
    x.fillText(label.toUpperCase().split('').join(' '), w / 2, h * 0.455);
  }
  if (sub) {
    x.font = `500 ${Math.round(w * 0.034)}px Montserrat, sans-serif`;
    x.fillStyle = 'rgba(248,240,216,0.28)';
    x.fillText(sub.toUpperCase().split('').join(' '), w / 2, h * 0.53);
  }
  // small gold mark between rule and label, like an empty mount
  x.font = `400 ${Math.round(w * 0.05)}px Georgia, serif`;
  x.fillStyle = 'rgba(232,199,122,0.25)';
  x.fillText('❖', w / 2, h * 0.365);

  // soft vignette keeps it quiet at the edges
  const vg = x.createRadialGradient(w / 2, h / 2, h * 0.2, w / 2, h / 2, h * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.22)');
  x.fillStyle = vg; x.fillRect(0, 0, w, h);

  return tex(c);
}

/* ---------------- glare / beam / dust sprites ---------------- */
export function makeGlareStripe() {
  const c = canvas(256, 64), x = c.getContext('2d');
  x.clearRect(0, 0, 256, 64);
  const g = x.createLinearGradient(88, 0, 168, 0);
  g.addColorStop(0, 'rgba(255,245,220,0)');
  g.addColorStop(0.42, 'rgba(255,246,224,0.55)');
  g.addColorStop(0.5, 'rgba(255,252,240,0.95)');
  g.addColorStop(0.58, 'rgba(255,246,224,0.55)');
  g.addColorStop(1, 'rgba(255,245,220,0)');
  x.fillStyle = g; x.fillRect(80, 0, 96, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export function makeBeamGradient() {
  const c = canvas(128, 256), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, 'rgba(255,214,150,0.55)');
  g.addColorStop(0.55, 'rgba(255,196,130,0.18)');
  g.addColorStop(1, 'rgba(255,180,110,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 256);
  // fade the sides so the cone silhouette is soft
  const s = x.createLinearGradient(0, 0, 128, 0);
  s.addColorStop(0, 'rgba(0,0,0,1)'); s.addColorStop(0.25, 'rgba(0,0,0,0)');
  s.addColorStop(0.75, 'rgba(0,0,0,0)'); s.addColorStop(1, 'rgba(0,0,0,1)');
  x.globalCompositeOperation = 'destination-out';
  x.fillStyle = s; x.fillRect(0, 0, 128, 256);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function makeDustSprite() {
  const c = canvas(32, 32), x = c.getContext('2d');
  const g = x.createRadialGradient(16, 16, 0, 16, 16, 15);
  g.addColorStop(0, 'rgba(255,236,200,0.9)');
  g.addColorStop(0.4, 'rgba(255,222,170,0.35)');
  g.addColorStop(1, 'rgba(255,210,150,0)');
  x.fillStyle = g; x.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

/* ---------------- VALANCE (with load-progress trim) ---------------- */
// Returns { texture, alpha, setProgress } — the gold braid along the scallops
// gilds from the centre outwards as textures load.
export function makeValance({ w = 2048, h = 512, scallops = 9 } = {}) {
  const c = canvas(w, h), x = c.getContext('2d');
  const a = canvas(w, h), ax = a.getContext('2d');

  const sw = w / scallops, dip = h * 0.34, topBand = h * 0.30;
  const edgeY = (px) => {
    const k = (px % sw) / sw;
    return h - dip * (1 - Math.pow(Math.sin(k * Math.PI), 1.25)) - h * 0.18;
  };

  function drawBase() {
    // velvet body with vertical pleat shading
    const g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#4e0e0a'); g.addColorStop(0.6, '#5e130c'); g.addColorStop(1, '#3c0a06');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    const pleats = 64;
    for (let p = 0; p < pleats; p++) {
      const px = (p + 0.5) * (w / pleats);
      const lg = x.createLinearGradient(px - w / pleats / 2, 0, px + w / pleats / 2, 0);
      lg.addColorStop(0, 'rgba(0,0,0,0.35)');
      lg.addColorStop(0.35, 'rgba(200,80,50,0.10)');
      lg.addColorStop(0.5, 'rgba(255,120,80,0.13)');
      lg.addColorStop(0.65, 'rgba(200,80,50,0.10)');
      lg.addColorStop(1, 'rgba(0,0,0,0.35)');
      x.fillStyle = lg;
      x.fillRect(px - w / pleats / 2, 0, w / pleats, h);
    }
    // top rail shadow
    const tg = x.createLinearGradient(0, 0, 0, topBand);
    tg.addColorStop(0, 'rgba(0,0,0,0.55)'); tg.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = tg; x.fillRect(0, 0, w, topBand);

    // alpha: opaque above the scallop edge, transparent below
    ax.clearRect(0, 0, w, h);
    ax.fillStyle = '#fff';
    ax.beginPath();
    ax.moveTo(0, 0); ax.lineTo(w, 0);
    for (let px = w; px >= 0; px -= 8) ax.lineTo(px, edgeY(px));
    ax.closePath(); ax.fill();
    // fringe threads hanging below the scallop edge (both canvases)
    for (let px = 0; px < w; px += 7) {
      const ey = edgeY(px);
      const len = 26 + 10 * Math.sin(px * 0.05);
      x.strokeStyle = 'rgba(190,150,80,0.9)'; x.lineWidth = 2.6;
      x.beginPath(); x.moveTo(px, ey - 2); x.lineTo(px + 1.5, ey + len); x.stroke();
      ax.strokeStyle = 'rgba(255,255,255,0.9)'; ax.lineWidth = 2.6;
      ax.beginPath(); ax.moveTo(px, ey - 2); ax.lineTo(px + 1.5, ey + len); ax.stroke();
    }
  }

  function drawTrim(progress) {
    // braid follows the scallop edge, gilding outward from centre
    const half = w / 2;
    const lit = (px) => Math.abs(px - half) <= half * progress;
    for (let px = 0; px <= w - 3; px += 3) {
      const y1 = edgeY(px), y2 = edgeY(px + 3);
      const on = lit(px);
      x.strokeStyle = on ? '#E8C77A' : 'rgba(120,90,40,0.55)';
      x.lineWidth = on ? 9 : 6;
      x.beginPath(); x.moveTo(px, y1 - 5); x.lineTo(px + 3, y2 - 5); x.stroke();
      if (on) {
        x.strokeStyle = 'rgba(255,244,205,0.85)'; x.lineWidth = 2.5;
        x.beginPath(); x.moveTo(px, y1 - 8.5); x.lineTo(px + 3, y2 - 8.5); x.stroke();
      }
    }
  }

  drawBase(); drawTrim(0);
  const texture = tex(c, { aniso: 4 });
  const alpha = new THREE.CanvasTexture(a);

  let last = -1;
  function setProgress(p) {
    p = Math.max(0, Math.min(1, p));
    if (Math.abs(p - last) < 0.03 && p !== 1) return;
    last = p;
    drawBase(); drawTrim(p);
    texture.needsUpdate = true; alpha.needsUpdate = true;
  }
  return { texture, alpha, setProgress };
}

/* ---------------- gold rope material helper ---------------- */
export function makeRopeTexture() {
  const c = canvas(128, 128), x = c.getContext('2d');
  x.fillStyle = '#c8a24e'; x.fillRect(0, 0, 128, 128);
  for (let i = -128; i < 256; i += 14) { // twisted strands
    x.strokeStyle = 'rgba(90,60,15,0.8)'; x.lineWidth = 5;
    x.beginPath(); x.moveTo(i, 0); x.lineTo(i + 64, 128); x.stroke();
    x.strokeStyle = 'rgba(255,235,180,0.5)'; x.lineWidth = 2;
    x.beginPath(); x.moveTo(i + 7, 0); x.lineTo(i + 71, 128); x.stroke();
  }
  return tex(c, { repeat: [6, 1] });
}
