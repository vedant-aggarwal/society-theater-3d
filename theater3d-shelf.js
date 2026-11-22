// theater3d-shelf.js — the shelf of editions, the gold name, the marks.

import * as THREE from 'three';
import * as TEX from './theater3d-textures.js';
import { buildWordmarkGeometry, wordmarkMetrics, wordmarkSource } from './theater3d-wordmark.js';

/* ============================ the editions ============================ */
const ROWS = [
  { name: 'BULLETIN', note: 'THE MONTHLY BULLETIN', books: [
    { id: 'mb1', cover: 'mb1', pages: 6,  copies: 3, aspect: 0.707, cloth: 0, prop: 'BULLETIN', ed: 'SAMPLE ONE',   plate: 'ED. 1', sub: 'Sample edition 1', inside: 'The first sample issue' },
    { id: 'mb2', cover: null, bound: true, pages: 12, copies: 4, aspect: 0.75,  cloth: 1, prop: 'BULLETIN', ed: 'SAMPLE TWO',   plate: 'ED. 2', sub: 'Sample edition 2', inside: 'Bound in boards, no cover in the archive' },
    { id: 'mb3', cover: 'mb3', pages: 14, copies: 4, aspect: 0.75,  cloth: 2, prop: 'BULLETIN', ed: 'SAMPLE THREE', plate: 'ED. 3', sub: 'Sample edition 3', inside: 'Placeholder contents' },
    { id: 'mb4', cover: 'mb4', pages: 16, copies: 4, aspect: 0.706, cloth: 3, prop: 'BULLETIN', ed: 'SAMPLE FOUR',  plate: 'ED. 4', sub: 'Sample edition 4', inside: 'The longest sample issue' },
  ]},
  { name: 'CASEBOOK', note: 'THE SAMPLE CASEBOOK', books: [
    { id: 'mkT', cover: 'casebookT', pages: 11, copies: 5, aspect: 0.707, cloth: 4, prop: 'CASEBOOK', ed: 'THE TEASER',     plate: 'TEASER', sub: 'Sample teaser',    inside: 'A sample teaser' },
    { id: 'mk2', cover: 'casebook2', pages: 58, copies: 5, aspect: 0.708, cloth: 5, prop: 'CASEBOOK', ed: 'SECOND EDITION', plate: 'ED. 2',  sub: 'Sample edition 2', inside: 'The full sample casebook' },
  ]},
  { name: 'SERIES', note: 'THE CONCEPT SERIES', books: [
    { id: 'mv1', cover: 'mv1', pages: 5, copies: 7, aspect: 0.8, cloth: 2, prop: 'SERIES', ed: 'S1 · E1', plate: 'S1 E1', sub: 'Sample episode 1', inside: 'Season one opens' },
    { id: 'mv2', cover: 'mv2', pages: 5, copies: 7, aspect: 0.8, cloth: 4, prop: 'SERIES', ed: 'S1 · E2', plate: 'S1 E2', sub: 'Sample episode 2', inside: 'Episode two' },
  ]},
];

const SHELF = {
  x: 2.44, z: -0.30,
  W: 3.82, D: 0.62,            // outer width / depth
  side: 0.12, plank: 0.075,    // panel + plank thickness
  rail: 0.145,                 // the label rail under each plank — sized to be legible, not pretty
  rowY: [0.40, 1.52, 2.64],    // top surface of each plank (bottom row first)
  bookH: 0.86,                 // the books are the subject: they must be legible, not decorative
  gapEntry: 0.17,              // between entries within a row
};
SHELF.caseH = SHELF.rowY[2] + SHELF.bookH + 0.24;

const thickOf = p => Math.min(0.17, 0.034 + p * 0.0044);

// Held over the reading table in the open foreground: clear of the case on its right,
// clear of the name above it, and clear of the overlay block on its left. The copy no
// longer has to blot anything out to be looked at.
export const PRESENT = { x: -0.38, y: 1.12, z: 1.75, scale: 1.80 };

/* ============================ small canvases ============================ */

function contactShadowTex() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 32, 4, 64, 32, 60);
  g.addColorStop(0, 'rgba(0,0,0,0.85)'); g.addColorStop(0.55, 'rgba(0,0,0,0.4)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.save(); x.scale(1, 0.5); x.fillStyle = g; x.fillRect(0, 0, 128, 128); x.restore();
  return new THREE.CanvasTexture(c);
}

const LOZENGE = '\u2756';   // the gold mark at the foot of every spine

// fallback cloth if the textures module has not gained makeSpineCloth yet
const CLOTHS = [
  ['#2c0503', '#4a0b06', '#260402'],   // deep oxblood
  ['#33140b', '#5c2416', '#2a0f08'],   // browner ox-red
  ['#1d0508', '#3a0d16', '#180407'],   // near-black burgundy
  ['#33220f', '#5e441f', '#2a1c0c'],   // tan buckram
  ['#0e1a12', '#1d3322', '#0b150e'],   // bookbinders' green
  ['#3d1a1c', '#6b3030', '#331416'],   // faded rose oxblood
];
function clothGround(x, w, h, variant, seed) {
  if (TEX.makeSpineCloth) {
    const r = TEX.makeSpineCloth({ variant, w, h, seed });
    const src = r && (r.canvas || r);
    if (src && src.width) { x.drawImage(src, 0, 0, w, h); return; }
  }
  const [a, b, c] = CLOTHS[variant % CLOTHS.length];
  const g = x.createLinearGradient(0, 0, w, 0);
  g.addColorStop(0, a); g.addColorStop(0.5, b); g.addColorStop(1, c);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const rand = TEX.mulberry32(seed);
  for (let i = 0; i < 30; i++) {
    x.strokeStyle = `rgba(0,0,0,${(rand() * 0.14).toFixed(2)})`; x.lineWidth = 1;
    const yy = rand() * h; x.beginPath(); x.moveTo(0, yy); x.lineTo(w, yy); x.stroke();
  }
}

// spine: bound cloth, gold grid — property at head, edition centred, gold mark at foot
function spineCanvas(entry, T) {
  const w = Math.max(64, Math.round(T * 1300)), h = 760;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  clothGround(x, w, h, entry.cloth || 0, 17 + entry.id.length + entry.pages);

  // head + tail bands
  x.fillStyle = '#E8C77A';
  x.fillRect(w * 0.16, h * 0.028, w * 0.68, 3); x.fillRect(w * 0.16, h * 0.962, w * 0.68, 3);

  x.save(); x.translate(w / 2, 0); x.rotate(Math.PI / 2); x.textBaseline = 'middle';
  const gold = '#E8C77A', dim = 'rgba(232,199,122,0.80)';
  const PAD = h * 0.055, GAP = h * 0.045;

  // the foot lozenge is fixed, and claims its width first
  const lozSize = Math.round(w * 0.46);
  x.font = '400 ' + lozSize + 'px Georgia, serif';
  const lozW = x.measureText(LOZENGE).width;
  const footStart = h - PAD - lozW;

  // the property name at the head: the letter spacing goes before the size does
  const propPlain = entry.prop;
  const headMax = h * 0.40;
  const propFont = (px) => '600 ' + px + 'px Montserrat, sans-serif';
  let propSize = Math.round(w * 0.30);
  let propText = propPlain.split('').join(' ');
  x.font = propFont(propSize);
  if (x.measureText(propText).width > headMax) propText = propPlain;
  while (x.measureText(propText).width > headMax && propSize > 8) {
    propSize -= 1; x.font = propFont(propSize);
  }
  const propW = x.measureText(propText).width;

  // the edition takes what is left between the two, and is centred in it
  const edBandA = PAD + propW + GAP, edBandB = footStart - GAP;
  const edBand = Math.max(24, edBandB - edBandA);
  const edFont = (px) => '600 ' + px + 'px "Noto Serif Display", Georgia, serif';
  let edSize = Math.round(w * 0.38);
  x.font = edFont(edSize);
  while (x.measureText(entry.ed).width > edBand && edSize > 8) {
    edSize -= 1; x.font = edFont(edSize);
  }
  const edW = x.measureText(entry.ed).width;
  const edMid = edBandA + edBand / 2;

  // and say so loudly if a band was still exceeded, so this cannot regress in silence
  if (propW > headMax + 0.5 || edW > edBand + 0.5) {
    console.warn('[theater3d] spine layout overflow on', entry.id, {
      propW: Math.round(propW), headMax: Math.round(headMax),
      edW: Math.round(edW), edBand: Math.round(edBand),
    });
  }

  x.textAlign = 'left'; x.font = propFont(propSize);
  x.fillStyle = dim; x.fillText(propText, PAD, 0);

  x.textAlign = 'center'; x.font = edFont(edSize);
  x.fillStyle = 'rgba(0,0,0,0.5)'; x.fillText(entry.ed, edMid + 1.5, 1.5);
  x.fillStyle = gold; x.fillText(entry.ed, edMid, 0);

  x.textAlign = 'left'; x.font = '400 ' + lozSize + 'px Georgia, serif';
  x.fillStyle = gold; x.fillText(LOZENGE, footStart, 0);
  x.restore();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// top edge: the paper block, with the cover art wrapping over the front board
function topEdgeCanvas(coverImg) {
  const w = 256, h = 96;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#ece2c4'; x.fillRect(0, 0, w, h);
  const rand = TEX.mulberry32(9);
  for (let i = 0; i < 52; i++) {
    const p = (i / 52) * h + rand() * 2;
    x.strokeStyle = `rgba(120,100,60,${(0.05 + rand() * 0.12).toFixed(2)})`;
    x.lineWidth = 0.9;
    x.beginPath(); x.moveTo(0, p); x.lineTo(w, p + (rand() - 0.5) * 1.5); x.stroke();
  }
  const sg = x.createLinearGradient(0, 0, w, 0);
  sg.addColorStop(0, 'rgba(50,30,8,0.26)'); sg.addColorStop(0.2, 'rgba(0,0,0,0)');
  sg.addColorStop(0.9, 'rgba(0,0,0,0)'); sg.addColorStop(1, 'rgba(50,30,8,0.15)');
  x.fillStyle = sg; x.fillRect(0, 0, w, h);
  if (coverImg) {
    const strip = Math.round(h * 0.16);
    x.save(); x.scale(1, -1); x.translate(0, -strip);
    x.drawImage(coverImg, 0, 0, coverImg.width, coverImg.height * 0.03, 0, 0, w, strip);
    x.restore();
    x.fillStyle = 'rgba(255,244,210,0.28)'; x.fillRect(0, strip, w, 1.6);
    x.fillStyle = '#31100a'; x.fillRect(0, h - Math.round(h * 0.05), w, Math.round(h * 0.05));
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}


function boundCoverCanvas(entry) {
  const w = 620, h = Math.round(620 / (entry.aspect || 0.72));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  clothGround(x, w, h, entry.cloth || 0, 71 + entry.pages);
  // the gilt frame, blind-stamped
  x.strokeStyle = 'rgba(232,199,122,0.62)'; x.lineWidth = 3;
  x.strokeRect(w * 0.085, h * 0.065, w * 0.83, h * 0.87);
  x.strokeStyle = 'rgba(232,199,122,0.30)'; x.lineWidth = 1;
  x.strokeRect(w * 0.105, h * 0.080, w * 0.79, h * 0.84);
  x.textAlign = 'center';
  x.fillStyle = 'rgba(232,199,122,0.55)';
  x.font = `600 ${Math.round(w * 0.036)}px Montserrat, sans-serif`;
  x.fillText('THE SOCIETY · SAMPLE COLLEGE'.split('').join(' '), w / 2, h * 0.20);
  x.fillStyle = '#E8C77A';
  x.font = `700 ${Math.round(w * 0.155)}px "Noto Serif Display", Georgia, serif`;
  x.fillText(entry.prop, w / 2, h * 0.44);
  x.strokeStyle = 'rgba(232,199,122,0.55)'; x.lineWidth = 2;
  x.beginPath(); x.moveTo(w * 0.28, h * 0.50); x.lineTo(w * 0.72, h * 0.50); x.stroke();
  x.fillStyle = 'rgba(232,199,122,0.88)';
  x.font = `600 ${Math.round(w * 0.052)}px Montserrat, sans-serif`;
  x.fillText(entry.ed.split('').join(' '), w / 2, h * 0.58);
  x.fillStyle = 'rgba(240,232,208,0.62)';
  x.font = `italic ${Math.round(w * 0.048)}px "Crimson Pro", Georgia, serif`;
  x.fillText(entry.sub || '', w / 2, h * 0.66);
  x.fillStyle = 'rgba(240,232,208,0.34)';
  x.font = `400 ${Math.round(w * 0.034)}px "Crimson Pro", Georgia, serif`;
  x.fillText('bound in boards; the cover is not in the archive', w / 2, h * 0.86);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  return tex;
}

/* ============================ one volume ============================ */

/* Shared across every copy in the case. These were being rebuilt per book: 23 volumes
   x six canvases each is 138 textures for six distinct images, and it showed in
   renderer.info.memory. Only the boards and the spine actually differ per edition. */
const shared = {};
function sharedBits(envMap) {
  if (shared.ready) return shared;
  shared.paperMat = new THREE.MeshStandardMaterial({
    map: TEX.makePaperEdge({ horizontal: false }), color: 0xbeb49a,
    roughness: 0.62, metalness: 0.03, envMap, envMapIntensity: 0.30,
  });
  shared.clothMat = new THREE.MeshStandardMaterial({ color: 0x3c0906, roughness: 0.75 });
  shared.backMat = new THREE.MeshStandardMaterial({
    map: TEX.makeBackCover(), color: 0x9a9a9a, roughness: 0.7,
  });
  shared.contact = contactShadowTex();
  shared.glare = TEX.makeGlareStripe();
  shared.hidden = new THREE.MeshBasicMaterial({ visible: false });
  shared.ready = true;
  return shared;
}

/* Per edition, not per copy: four copies of the October issue are the same object. */
const perEntry = new Map();
function entryMats(entry, ctx) {
  const key = entry.id;
  let m = perEntry.get(key);
  if (m) return m;
  const { envMap } = ctx;
  const T = thickOf(entry.pages);
  m = {
    cover: new THREE.MeshStandardMaterial({
      map: entry.bound ? boundCoverCanvas(entry) : null,
      color: entry.bound ? 0xb0b0b0 : 0x4a0b06,
      roughness: entry.bound ? 0.72 : 0.55, metalness: 0.0, envMap, envMapIntensity: 0.30,
    }),
    top: new THREE.MeshStandardMaterial({
      map: topEdgeCanvas(null), color: 0xbeb49a,
      roughness: 0.62, metalness: 0.03, envMap, envMapIntensity: 0.28,
    }),
    spine: new THREE.MeshStandardMaterial({
      map: spineCanvas(entry, T), color: 0x8a8a8a, roughness: 0.74, metalness: 0.03,
      envMap, envMapIntensity: 0.14,
    }),
    dressed: false,
  };
  perEntry.set(key, m);
  return m;
}

function buildBook(entry, ctx) {
  const s = sharedBits(ctx.envMap);
  const mats = entryMats(entry, ctx);
  const H = SHELF.bookH, T = thickOf(entry.pages), W = H * entry.aspect;
  const g = new THREE.Group();

  // faces: +x front cover · -x back cover · +y top · -y bottom · +z spine · -z fore-edge
  const body = new THREE.Mesh(new THREE.BoxGeometry(T, H, W),
    [mats.cover, s.backMat, mats.top, s.clothMat, mats.spine, s.paperMat]);
  body.castShadow = true; body.receiveShadow = true;
  body.position.y = H / 2;
  g.add(body);

  const cs = new THREE.Mesh(
    new THREE.PlaneGeometry(T * 2.6, W * 1.12),
    new THREE.MeshBasicMaterial({ map: s.contact, transparent: true, opacity: 0.55, depthWrite: false })
  );
  cs.rotation.x = -Math.PI / 2; cs.position.y = 0.004; cs.renderOrder = 1;
  g.add(cs);

  // glare stripe that sweeps the cover when the copy is pulled
  const glare = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.15, H * 1.02),
    new THREE.MeshBasicMaterial({
      map: s.glare, transparent: true, opacity: 0,
      color: new THREE.Color(0.30, 0.29, 0.26),
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  glare.rotation.y = Math.PI / 2;
  glare.position.set(T / 2 + 0.004, H / 2, 0);
  glare.renderOrder = 6;
  g.add(glare);

  // fat proxy for reliable ray hits; travels with the copy
  const proxy = new THREE.Mesh(new THREE.BoxGeometry(T + 0.07, H + 0.05, W + 0.03), s.hidden);
  proxy.position.y = H / 2;
  g.add(proxy);

  const book = {
    entry, group: g, body, coverMat: mats.cover, topMat: mats.top,
    glareMesh: glare, proxy, contact: cs,
    dims: { T, H, W },
    home: new THREE.Vector3(), homeRotY: 0, homeRotZ: 0,
    pulled: 0,
  };
  proxy.userData.book = book;

  book.applyCover = (tex) => {
    if (mats.dressed) return;              // one edition, one dressing, however many copies
    mats.dressed = true;
    mats.cover.map = tex; mats.cover.color.set(0xffffff);
    mats.cover.roughness = 0.5; mats.cover.needsUpdate = true;
    mats.top.map = topEdgeCanvas(tex.image); mats.top.needsUpdate = true;
  };
  return book;
}

/* ============================ the case ============================ */

export function buildShelf(ctx) {
  const { scene, envMap, Q } = ctx;
  const shelf = new THREE.Group();
  shelf.position.set(SHELF.x, 0, SHELF.z);
  scene.add(shelf);
  ctx.groups.shelf = shelf;

  const woodT = TEX.makeWood({
    seed: 19, planks: 3, base: [82, 46, 24], dark: [36, 18, 8], light: [130, 82, 42],
    gapPx: 0, variance: 0.22, cool: 0.30, knots: 2,
  });
  const wood = new THREE.MeshStandardMaterial({
    map: woodT.map, bumpMap: woodT.bump, bumpScale: 0.38,
    roughnessMap: woodT.rough || null, color: 0xa4744c, roughness: 0.58,
  });
  const woodDark = new THREE.MeshStandardMaterial({ map: woodT.map, color: 0x7a5236, roughness: 0.74 });

  const caseH = SHELF.caseH;
  const put = (geo, mat, x, y, z, cast = true) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = true;
    shelf.add(m); return m;
  };
  // sides, top, back, cornice, feet
  put(new THREE.BoxGeometry(SHELF.side, caseH, SHELF.D), wood, -(SHELF.W - SHELF.side) / 2, caseH / 2, 0);
  put(new THREE.BoxGeometry(SHELF.side, caseH, SHELF.D), wood, (SHELF.W - SHELF.side) / 2, caseH / 2, 0);
  put(new THREE.BoxGeometry(SHELF.W, 0.085, SHELF.D + 0.04), wood, 0, caseH + 0.042, 0);
  put(new THREE.BoxGeometry(SHELF.W + 0.14, 0.10, SHELF.D + 0.12), wood, 0, caseH + 0.135, 0);   // cornice
  put(new THREE.BoxGeometry(SHELF.W - SHELF.side, caseH, 0.03), woodDark, 0, caseH / 2, -SHELF.D / 2 + 0.015, false);
  put(new THREE.BoxGeometry(SHELF.W, 0.11, SHELF.D + 0.03), woodDark, 0, 0.055, 0);

  // baked contact shadow so the case sits on the boards
  {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g2 = c.getContext('2d');
    const rg = g2.createRadialGradient(128, 32, 8, 128, 32, 126);
    rg.addColorStop(0, 'rgba(0,0,0,0.8)'); rg.addColorStop(0.6, 'rgba(0,0,0,0.45)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g2.save(); g2.scale(1, 0.25); g2.fillStyle = rg; g2.fillRect(0, 0, 256, 256); g2.restore();
    const cs = new THREE.Mesh(
      new THREE.PlaneGeometry(SHELF.W * 1.35, SHELF.D * 2.6),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, opacity: 0.6, depthWrite: false })
    );
    cs.rotation.x = -Math.PI / 2; cs.position.set(0, 0.006, 0.1); cs.renderOrder = 1;
    shelf.add(cs);
  }

  const innerW = SHELF.W - SHELF.side * 2;
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xE8C77A, roughness: 0.34, metalness: 0.9, envMap, envMapIntensity: 0.85,
  });

  {
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(SHELF.W * 0.92, 0.34, 0.035),
      new THREE.MeshStandardMaterial({
        map: TEX.makeHeaderPlate
          ? TEX.makeHeaderPlate('THE RECORD', 'EVERY EDITION THE SOCIETY HAS PUT INTO THE WORLD')
          : headerPlateFallback('THE RECORD', 'EVERY EDITION THE SOCIETY HAS PUT INTO THE WORLD'),
        color: 0xc2c2c2, roughness: 0.38, metalness: 0.58, envMap, envMapIntensity: 0.6,
      })
    );
    board.position.set(0.18, caseH + 0.33, SHELF.D / 2 - 0.02);
    board.castShadow = true;
    shelf.add(board);

    const recordSpot = new THREE.SpotLight(0xffc890, 118, 6.4, 0.30, 0.70, 1.4);
    recordSpot.position.set(0.18, caseH + 1.62, SHELF.D / 2 + 1.42);
    recordSpot.target.position.set(0.18, caseH + 0.30, SHELF.D / 2 - 0.02);
    recordSpot.castShadow = false;
    shelf.add(recordSpot, recordSpot.target);
    ctx.recordSpot = recordSpot;

    const tab = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.26, 0.03),
      new THREE.MeshStandardMaterial({
        map: TEX.makeBrassPlate('SEARCH', { w: 320, h: 200, seed: 77, fs: 0.30 }),
        color: 0xbcbcbc, roughness: 0.34, metalness: 0.64, envMap, envMapIntensity: 0.6,
      })
    );
    tab.position.set(-SHELF.W * 0.46 - 0.02, caseH + 0.33, SHELF.D / 2 - 0.02);
    tab.castShadow = true;
    tab.userData.link = 'archive.html';
    shelf.add(tab);
    ctx.searchTab = tab;
  }

  const lampsPerRow = Q.mobile ? 1 : 1;
  for (let r = 0; r < 3; r++) {
    if (Q.mobile && r === 1) continue;      // the middle row keeps the fewest secrets
    const inner = new THREE.PointLight(0xffc79a, 3.4, 4.4, 1.15);
    inner.position.set(0, SHELF.rowY[r] + 0.44, -SHELF.D / 2 + 0.16);
    shelf.add(inner);
  }
  void lampsPerRow;

  ctx.books = [];
  ctx.slotProxies = [];

  ROWS.forEach((row, r) => {
    const y = SHELF.rowY[ROWS.length - 1 - r];

    // plank
    put(new THREE.BoxGeometry(innerW + 0.02, SHELF.plank, SHELF.D - 0.02), wood, 0, y - SHELF.plank / 2, 0);

    // the label rail — sized so the row name is readable from the visitor's actual distance
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(innerW + 0.02, SHELF.rail, 0.024),
      new THREE.MeshStandardMaterial({
        map: TEX.makeFascia(row.name, { seed: 11 + r, note: row.note, w: 2048, h: 224 }),
        color: 0xbcbcbc, roughness: 0.52, metalness: 0.32, envMap, envMapIntensity: 0.45,
      })
    );
    rail.position.set(0, y - SHELF.plank - SHELF.rail / 2, SHELF.D / 2 - 0.004);
    rail.castShadow = true; rail.receiveShadow = true;
    shelf.add(rail);

    /* --- pack the row: entries take the width they need, the run is centred ---
       Even slots left the two-entry row looking abandoned. Real shelves pack. */
    const widthOf = (entry, isDisplay) => {
      if (entry.ghost) return SHELF.bookH * 0.70 * 0.72;
      if (isDisplay) return SHELF.bookH * entry.aspect;
      const T = thickOf(entry.pages);
      return (entry.copies || 1) * T + ((entry.copies || 1) - 1) * 0.008;
    };
    const firstReal = row.books.findIndex(b => !b.ghost);
    const widths = row.books.map((e, s) => widthOf(e, s === firstReal));
    const run = widths.reduce((a, b) => a + b, 0) + SHELF.gapEntry * (row.books.length - 1);
    let cursor = -Math.min(innerW * 0.5 - 0.06, run / 2);

    row.books.forEach((entry, s) => {
      const wEntry = widths[s];
      const cx = cursor + wEntry / 2;
      cursor += wEntry + SHELF.gapEntry;

      // brass plate under every slot, ghosts included
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(entry.ghost ? 0.44 : 0.32, 0.062, 0.010),
        new THREE.MeshStandardMaterial({
          map: TEX.makeBrassPlate(entry.ghost ? `${entry.plate} · RECORDED` : entry.plate,
            { w: entry.ghost ? 512 : 384, h: 72, seed: 3 + s + r * 7 }),
          color: 0xb4b4b4, roughness: 0.36, metalness: 0.62, envMap, envMapIntensity: 0.55,
        })
      );
      plate.position.set(cx, y - SHELF.plank / 2, SHELF.D / 2 + 0.010);
      shelf.add(plate);

      if (entry.ghost) {
        const gw = SHELF.bookH * 0.70 * 0.72, gh = SHELF.bookH * 0.70;
        const card = new THREE.Mesh(
          new THREE.PlaneGeometry(gw, gh),
          new THREE.MeshStandardMaterial({
            map: TEX.makeGhostPlate
              ? TEX.makeGhostPlate({ label: entry.plate, sub: entry.sub || '' })
              : ghostPlateFallback(entry.plate, entry.sub || ''),
            color: 0xc9b48e, roughness: 0.95, transparent: true, opacity: 0.90,
            side: THREE.DoubleSide,
          })
        );
        card.position.set(cx, y + gh / 2, -0.02);
        card.rotation.y = 0.05;
        card.receiveShadow = true;
        shelf.add(card);
        // and the dust square where the copy would stand
        const dust = new THREE.Mesh(
          new THREE.PlaneGeometry(gw * 1.05, 0.22),
          new THREE.MeshBasicMaterial({ color: 0x2a1210, transparent: true, opacity: 0.30, depthWrite: false })
        );
        dust.rotation.x = -Math.PI / 2; dust.position.set(cx, y + 0.004, -0.02);
        shelf.add(dust);
        return;
      }

      // one display copy per row stands face-out, the way a library shows its newest issue.
      if (s === firstReal) {
        const book = buildBook(entry, ctx);
        const W = SHELF.bookH * entry.aspect;
        book.group.position.set(cx, y, SHELF.D / 2 - W / 2 - 0.075);
        book.group.rotation.y = -Math.PI / 2 + 0.06;
        book.home.copy(book.group.position);
        book.homeRotY = book.group.rotation.y;
        book.faceOut = true;
        book.row = r;
        shelf.add(book.group);
        ctx.books.push(book);
        addSlotProxy(ctx, shelf, book, cx, y, W, SHELF.bookH);
        return;
      }

      const copies = entry.copies || 1;
      const T = thickOf(entry.pages), gapC = 0.008;
      const runW = copies * T + (copies - 1) * gapC;
      for (let cI = 0; cI < copies; cI++) {
        const book = buildBook(entry, ctx);
        const jz = (cI * 2654435761 % 97) / 97;   // deterministic jitter
        const bx = cx - runW / 2 + T / 2 + cI * (T + gapC);
        book.group.position.set(bx, y, 0.02 - jz * 0.02);
        book.group.rotation.y = (jz - 0.5) * 0.02;
        book.home.copy(book.group.position);
        book.homeRotY = book.group.rotation.y;
        book.row = r;
        book.copyIndex = cI;
        book.copyCount = copies;
        shelf.add(book.group);
        ctx.books.push(book);
        // a spine is thin, so the target is widened to the pitch between copies: adjacent
        // targets meet without overlapping and there is no dead gap to fall through
        addSlotProxy(ctx, shelf, book, bx, y, T + gapC, SHELF.bookH, true);
      }
    });

    // a brass bookend closes the run so the empty half of a short row reads as room to grow
    if (cursor - SHELF.gapEntry < innerW / 2 - 0.24) {
      const be = new THREE.Mesh(new THREE.BoxGeometry(0.035, SHELF.bookH * 0.62, SHELF.D * 0.55), brassMat);
      be.position.set(cursor - SHELF.gapEntry + 0.09, y + SHELF.bookH * 0.31, 0);
      be.castShadow = true; be.receiveShadow = true;
      shelf.add(be);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.014, SHELF.D * 0.55), brassMat);
      foot.position.set(cursor - SHELF.gapEntry + 0.19, y + 0.007, 0);
      shelf.add(foot);
    }
  });

  // covers may already be in, or land later
  ctx.assignCover = (name, tex) => {
    for (const b of ctx.books) if (b.entry.cover === name) b.applyCover(tex);
  };
  for (const [name, tex] of Object.entries(ctx.covers)) ctx.assignCover(name, tex);

  ctx.layoutFns.push((portrait) => {
    if (portrait) {
      // centred and set back, but not through the wall at z = -2.60. The last 8% of width
      // comes off the case instead, which is cheaper than losing the frame.
      shelf.position.set(0, 0, -2.05);
      shelf.scale.setScalar(0.92);
    } else {
      shelf.position.set(SHELF.x, 0, SHELF.z);
      shelf.scale.setScalar(1);
    }
  });
}

/* A static invisible box left at the slot. Hover latches to *either* this or the copy's
   own travelling proxy, so presenting a copy out in the open cannot drop the hover. */
// `exact` keeps the target to the width it was given. A per-copy target must not be padded:
// padding made adjacent copies' boxes overlap, and two coplanar boxes under one ray is a
// coin toss at the boundary, which is a worse bug than a slightly small target.
function addSlotProxy(ctx, shelf, book, cx, y, w, h, exact) {
  /* The depth matters as much as the width once there is one of these per copy. At
     SHELF.D * 0.8 the target is a half metre deep box, and the camera does not look at the
     case square on: from stage left, copy N-1's box silhouettes copy N's centre, so every
     aim landed one copy to the left. Measured, that was a clean off by one across all
     three rows. A shallow slab standing at the books' own depth has no such parallax. */
  const p = new THREE.Mesh(
    new THREE.BoxGeometry(exact ? w : Math.max(w, 0.12) + 0.06, h + 0.06, exact ? 0.05 : SHELF.D * 0.8),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  p.position.set(cx, y + h / 2, exact ? 0.02 : 0);
  p.userData.book = book;
  shelf.add(p);
  ctx.slotProxies.push(p);
  book.slotProxy = p;
}

/* ---- fallbacks, used only until theater3d-textures.js gains these makers ---- */

function headerPlateFallback(title, sub) {
  const w = 1600, h = 240;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#B9975B'); g.addColorStop(0.42, '#E8C77A');
  g.addColorStop(0.58, '#C9A868'); g.addColorStop(1, '#8E6B2C');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(60,32,6,0.55)'; x.lineWidth = 4; x.strokeRect(10, 10, w - 20, h - 20);
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillStyle = 'rgba(48,24,4,0.92)';
  x.font = `700 ${Math.round(h * 0.42)}px "Noto Serif Display", Georgia, serif`;
  x.fillText(title, w / 2, h * 0.40);
  x.font = `600 ${Math.round(h * 0.135)}px Montserrat, sans-serif`;
  x.fillStyle = 'rgba(52,28,6,0.72)';
  x.fillText(sub.split('').join(' '), w / 2, h * 0.74);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function ghostPlateFallback(label, sub) {
  const w = 420, h = 600;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#2a1512'; x.fillRect(0, 0, w, h);
  x.strokeStyle = 'rgba(232,199,122,0.34)'; x.lineWidth = 2;
  x.setLineDash([9, 9]); x.strokeRect(14, 14, w - 28, h - 28); x.setLineDash([]);
  x.textAlign = 'center';
  x.fillStyle = 'rgba(232,199,122,0.62)';
  x.font = '600 34px Montserrat, sans-serif';
  x.fillText(label, w / 2, h * 0.46);
  x.fillStyle = 'rgba(240,232,208,0.34)';
  x.font = 'italic 24px "Crimson Pro", Georgia, serif';
  wrapText(x, sub, w / 2, h * 0.56, w - 70, 30);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function wrapText(x, text, cx, cy, maxW, lh) {
  const words = String(text).split(' ');
  let line = '', y = cy;
  for (const wd of words) {
    const test = line ? line + ' ' + wd : wd;
    if (x.measureText(test).width > maxW && line) { x.fillText(line, cx, y); line = wd; y += lh; }
    else line = test;
  }
  if (line) x.fillText(line, cx, y);
}

/* ============================ the name ============================ */


export function buildText(ctx) {
  const { scene, envMap } = ctx;
  const group = new THREE.Group();
  scene.add(group);
  ctx.groups.text = group;

  buildWordmarkGeometry('THE SOCIETY', { manager: ctx.manager }).then((geo) => {
    const m = wordmarkMetrics(geo);

    const gold = TEX.makeGoldSurface ? TEX.makeGoldSurface({ seed: 61 }) : null;
    // Cast gold, not mirror gold. At roughness 0.30 with metalness 1 the faces have nothing
    // to reflect in a dark room and go bronze-black; a broader specular lobe is both more
    // like real gilded signage and the only thing that reads as gold under one raking light.
    const faceMat = new THREE.MeshPhysicalMaterial({
      color: 0xE0B25C, metalness: 0.96, roughness: 0.44,
      map: gold ? gold.map : null,
      roughnessMap: gold ? gold.rough : null,
      bumpMap: gold ? gold.bump : null, bumpScale: gold ? 0.014 : 0,
      envMap, envMapIntensity: 1.25,
    });
    const sideMat = new THREE.MeshPhysicalMaterial({
      color: 0x9C7530, metalness: 0.96, roughness: 0.56,
      map: gold ? gold.map : null,
      roughnessMap: gold ? gold.rough : null,
      envMap, envMapIntensity: 0.95,
    });
    patchForLens(faceMat); patchForLens(sideMat);
    const mesh = new THREE.Mesh(geo, [faceMat, sideMat]);
    mesh.castShadow = true;
    // no X squash: the condensation is drawn into the letterforms, not applied to them
    group.add(mesh);
    ctx.textMesh = mesh;

    ctx.textWidth = m.width;
    ctx.textHeight = m.height;
    applyTextLayout(ctx);

    /* the hook the interaction module drives from the cursor. A world point goes in, the
       mesh's own local space comes out, and the uniform eases toward it in the frame loop
       so a fast cursor swells the letters rather than snapping them. */
    const _lp = new THREE.Vector3();
    ctx.wordmarkLens = {
      set(worldPoint, radius, strength) {
        if (!worldPoint) { lensTarget.on = false; lensTarget.s = 0; return; }
        _lp.copy(worldPoint);
        mesh.worldToLocal(_lp);
        lensTarget.c.copy(_lp);
        lensTarget.on = true;
        if (typeof radius === 'number') lensTarget.r = radius;
        lensTarget.s = typeof strength === 'number' ? strength : 0.16;
      },
    };
    ctx.updaters.push((dt) => {
      const k = Math.min(1, dt * 9);
      // the centre only chases while the glass is actually on the name; letting it ease
      // away on exit would drag a bulge across the letterforms on the way out
      if (lensTarget.on) lensU.c.value.lerp(lensTarget.c, k);
      lensU.r.value += (lensTarget.r - lensU.r.value) * k;
      lensU.s.value += (lensTarget.s - lensU.s.value) * Math.min(1, dt * 6);
    });
    if (wordmarkSource() !== 'noto-serif-display-condensed-bold') {
      console.warn('[theater3d] wordmark fell back to', wordmarkSource());
    }

    ctx.onOpen(() => sweepGlare(ctx, group));
  });

  // the static fallback tagline is anchored under the name via projection; the HUD
  // overlay, when it loads, takes the same anchor and replaces it.
  const tagline = document.getElementById('tagline');
  const anchor = new THREE.Vector3();
  ctx.updaters.push(() => {
    if (!ctx.textMesh) return;
    anchor.setFromMatrixPosition(ctx.groups.text.matrixWorld);
    anchor.y -= (ctx.textHeight || 0.46) * ctx.groups.text.scale.y * 0.5 + 0.30;
    const p = anchor.clone().project(ctx.camera);
    const py = (-p.y * 0.5 + 0.5) * innerHeight;
    const px = (p.x * 0.5 + 0.5) * innerWidth;
    if (ctx.hud && ctx.hud.setAnchor) { ctx.hud.setAnchor(px, py); return; }
    tagline.style.left = `${px}px`;
    tagline.style.top = `${py}px`;
  });

  ctx.layoutFns.push(() => applyTextLayout(ctx));
}

function applyTextLayout(ctx) {
  const g = ctx.groups.text;
  if (!ctx.textMesh) return;
  if (ctx.state.portrait) {
    // above the case, not behind it: on a phone the name and the shelf stack, and the
    // overlay block has to fit between them
    g.position.set(0, 5.85, -2.24);
    const maxW = 2 * Math.tan(THREE.MathUtils.degToRad(ctx.camera.fov / 2)) * (7.60 + 2.24) * ctx.camera.aspect * 0.86;
    g.scale.setScalar(Math.min(1.9, Math.min(3.50, maxW) / (ctx.textWidth || 3)));
  } else {
    g.position.set(-2.86, 2.46, -2.24);
    g.scale.setScalar(Math.min(1.9, 5.30 / (ctx.textWidth || 3)));
  }
}

function sweepGlare(ctx, group) {
  const glare = ctx.glare;
  if (!glare || ctx.Q.reduced) return;
  const start = performance.now(), DUR = 2100;
  const w = (ctx.textWidth || 3.4) * group.scale.x;
  const x0 = group.position.x - w * 0.75, x1 = group.position.x + w * 0.75;
  const fn = () => {
    const p = (performance.now() - start) / DUR;
    if (p >= 1) { glare.intensity = 0; return; }
    glare.intensity = 88 * Math.sin(Math.PI * Math.min(1, p));   // was 260: far too hot
    glare.target.position.set(x0 + (x1 - x0) * p, group.position.y, group.position.z);
    glare.position.set(x0 + (x1 - x0) * p + 0.7, group.position.y + 0.5, group.position.z + 3.4);
    requestAnimationFrame(fn);
  };
  fn();
}

const lensU = {
  c: { value: new THREE.Vector3(0, 0, 0) },   // lens centre, in the mesh's own local space
  r: { value: 0.9 },                          // radius, local units
  s: { value: 0.0 },                          // lift, local units
};
const lensTarget = { c: new THREE.Vector3(), r: 0.9, s: 0.0, on: false };

function patchForLens(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uLensC = lensU.c;
    sh.uniforms.uLensR = lensU.r;
    sh.uniforms.uLensS = lensU.s;
    sh.vertexShader = 'uniform vec3 uLensC;\nuniform float uLensR;\nuniform float uLensS;\n'
      + sh.vertexShader;
    sh.vertexShader = sh.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n'
      + '  float lensD = distance(transformed.xy, uLensC.xy);\n'
      + '  transformed.z += uLensS * smoothstep(uLensR, 0.0, lensD);'
    );
  };
  mat.customProgramCacheKey = () => 'wordmark-lens';
}

/* ============================ the marks ============================ */

export function buildCrest(ctx) {
  const { scene, envMap } = ctx;
  const holder = new THREE.Group();
  scene.add(holder);
  ctx.groups.crest = holder;

  const ready = () => ctx.covers.crest && ctx.covers.crestMask && ctx.covers.logo && ctx.covers.logoMask;
  const tryBuild = () => {
    if (!ready() || holder.children.length) return;

    const disc = (map, mask, r, x, tone) => {
      mask.colorSpace = THREE.NoColorSpace;
      const m = new THREE.Mesh(
        new THREE.CircleGeometry(r, 56),
        new THREE.MeshStandardMaterial({
          map, alphaMap: mask, transparent: true, alphaTest: 0.04,
          roughness: 0.94, metalness: 0.0, color: tone,
        })
      );
      m.position.x = x;
      holder.add(m);
      return m;
    };

    disc(ctx.covers.logo, ctx.covers.logoMask, 0.40, -0.46, 0xb9ad97);
    // the hairline rule between the two marks
    const rule = new THREE.Mesh(
      new THREE.PlaneGeometry(0.006, 0.62),
      new THREE.MeshBasicMaterial({ color: 0xE8C77A, transparent: true, opacity: 0.42 })
    );
    rule.position.x = 0.06;
    holder.add(rule);
    // the college's, smaller, on the right
    disc(ctx.covers.crest, ctx.covers.crestMask, 0.27, 0.48, 0xa79a8a);

    layoutCrest(ctx);
  };
  const iv = setInterval(() => { tryBuild(); if (holder.children.length) clearInterval(iv); }, 200);
  setTimeout(() => clearInterval(iv), 20000);
  ctx.layoutFns.push(() => layoutCrest(ctx));
}

function layoutCrest(ctx) {
  const h = ctx.groups.crest;
  if (!h) return;
  if (ctx.state.portrait) { h.position.set(0, 6.45, -2.38); h.scale.setScalar(0.82); }
  else { h.position.set(-2.86, 3.66, -2.38); h.scale.setScalar(1.06); }
}
