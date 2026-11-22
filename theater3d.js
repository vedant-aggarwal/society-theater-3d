// theater3d.js — theater hero. Core scene: renderer, room, lights,

// velvet curtain rig, load/open timeline. Shelf + text live in theater3d-shelf.js,
// interaction in theater3d-interact.js, the overlay type in theater3d-hud.js.
window.__theater3dBooted = true;

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as TEX from './theater3d-textures.js';
import { buildShelf, buildText, buildCrest } from './theater3d-shelf.js';
import { initInteraction } from './theater3d-interact.js';

/* ============================== boot / fallback ============================== */

const stage = document.getElementById('stage');
const fallbackEl = document.getElementById('fallback');

function showFallback() {
  fallbackEl.classList.add('on');
  document.getElementById('vignette').style.display = 'none';
  const t = document.getElementById('tagline'); if (t) t.style.display = 'none';
  const h = document.getElementById('hint'); if (h) h.style.display = 'none';
  const hud = document.getElementById('hud'); if (hud) hud.style.display = 'none';
  if (stage) stage.style.display = 'none';
}

let renderer;
try {
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2') || probe.getContext('webgl');
  if (!gl) throw new Error('no webgl');
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
} catch (e) {
  showFallback();
  throw e;
}

/* ============================== quality tier ============================== */

const coarse = matchMedia('(hover: none)').matches || matchMedia('(pointer: coarse)').matches;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = coarse || Math.min(innerWidth, innerHeight) < 560;

const Q = {
  mobile, coarse, reduced,
  dpr: Math.min(devicePixelRatio || 1, 1.5),   // both reference sites cap at 1.5
  shadowMap: mobile ? 768 : 1536,
  textShadow: !mobile,
  dust: mobile ? 50 : 130,
  aniso: mobile ? 4 : 8,
};

renderer.setPixelRatio(Q.dpr);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = !mobile;   // shadow maps off on mobile; baked contact shadows still ground the books
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.86;
renderer.outputColorSpace = THREE.SRGBColorSpace;
stage.appendChild(renderer.domElement);

renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  showFallback();
});

/* ============================== scene / camera ============================== */

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x150505);
scene.fog = new THREE.FogExp2(0x1a0706, 0.040);

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 60);
const rig = new THREE.Group();          // parallax happens on the rig
rig.add(camera);
scene.add(rig);

const VIEW = { camPos: new THREE.Vector3(0.10, 2.05, 8.90), lookAt: new THREE.Vector3(0.30, 1.95, -1.20) };
function placeCamera() {
  camera.position.copy(VIEW.camPos);
  camera.lookAt(VIEW.lookAt);
}
placeCamera();

// neutral studio environment for the metals (gold text, brass) — per-material, not scene-wide
const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

/* ============================== shared context ============================== */

const ctx = {
  THREE, renderer, scene, camera, rig, envMap, Q,
  state: {
    phase: 'loading',      // loading -> opening -> open
    openT: 0,              // 0 closed .. 1 open
    t0: performance.now(),
    openStartAt: 0,
    ready: false,
    portrait: false,
  },
  covers: {},              // name -> THREE.Texture
  books: [],
  updaters: [],            // fn(dt, t)
  layoutFns: [],           // fn(portrait)
  onOpenFinished: [],
  groups: {},
};
ctx.onOpen = (fn) => { if (ctx.state.phase === 'open') fn(); else ctx.onOpenFinished.push(fn); };
window.__theaterCtx = ctx;

/* ============================== lights ============================== */

const hemi = new THREE.HemisphereLight(0x6a3d26, 0x1e0d08, 0.26);
scene.add(hemi);

const amb = new THREE.AmbientLight(0xffb489, 0.075);
scene.add(amb);

// key: warm pool from above onto the shelf
const key = new THREE.SpotLight(0xffd9a0, 165, 0, 0.58, 0.66, 1.5);
key.position.set(2.10, 5.30, 1.90);
key.target.position.set(2.30, 1.85, -0.45);
key.castShadow = true;
key.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.camera.near = 1; key.shadow.camera.far = 14;
scene.add(key, key.target);

const textSpot = new THREE.SpotLight(0xffc890, 120, 0, 0.52, 0.80, 1.5);
// Upstage of the curtain plane (z 2.20). At z 3.30 this spot sat in front of the cloth
// and printed a hard-edged pool on the left drape, complete with the drape's own shadow,
// which read as a lens flare in the top corner of every frame.
textSpot.position.set(-3.35, 3.95, 1.35);
textSpot.target.position.set(-2.62, 2.4, -2.3);
textSpot.castShadow = Q.textShadow;
if (Q.textShadow) {
  textSpot.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
  textSpot.shadow.bias = -0.0004;
  textSpot.shadow.normalBias = 0.02;
}
scene.add(textSpot, textSpot.target);

const washL = new THREE.PointLight(0xff9d63, 2.6, 11.0, 2.1);
washL.position.set(-3.0, 2.6, -1.55);
scene.add(washL);
const washR = new THREE.PointLight(0xffab74, 1.2, 10.5, 2.1);
washR.position.set(3.4, 3.1, -1.30);
scene.add(washR);

// left-side fill. Kept well upstage of the curtain plane: at z 2.2 it sat inside the
// left drape and burned a hot blob into the cloth at the top of frame.
const fill = new THREE.PointLight(0xffb27a, 2.9, 15, 1.5);
fill.position.set(-5.2, 3.1, 0.10);
scene.add(fill);

// low warm bounce off the floor boards
const bounce = new THREE.PointLight(0xff8a48, 3.4, 9.0, 1.7);
bounce.position.set(-1.6, 0.95, 2.2);
scene.add(bounce);

const floorSpot = new THREE.SpotLight(0xffc084, 70, 13, 0.50, 0.9, 1.5);
floorSpot.position.set(0.4, 6.4, 5.0);
floorSpot.target.position.set(0.1, 0, 3.6);
floorSpot.castShadow = false;
scene.add(floorSpot, floorSpot.target);

// footlight wash for the curtain while it is the whole show
const curtainSpot = new THREE.SpotLight(0xffb878, 300, 0, 1.05, 0.72, 1.4);
curtainSpot.position.set(0, 6.0, 9.4);
curtainSpot.target.position.set(0, 1.2, 2.0);
scene.add(curtainSpot, curtainSpot.target);
const CURTAIN_SPOT_OPEN = 30;   // where the ramp *ends*; never assigned as a jump

// one-shot glare that travels across the gold name after the curtain opens
const glare = new THREE.SpotLight(0xfff2cc, 0, 0, 0.20, 0.55, 1.2);
glare.position.set(-2.3, 2.6, 1.8);
glare.target.position.set(-3.8, 2.25, -2.3);
scene.add(glare, glare.target);
ctx.glare = glare;

// the follow spot — trails the cursor with lag, widens over the name, tightens over a tag.
// Driven from theater3d-interact.js; parked and dark until the curtain is open.
if (!Q.coarse) {
  const followSpot = new THREE.SpotLight(0xffe0b0, 0, 0, 0.26, 0.85, 1.1);
  followSpot.position.set(0, 4.2, 4.6);
  followSpot.target.position.set(0, 1.6, -2.3);
  scene.add(followSpot, followSpot.target);
  ctx.followSpot = followSpot;
}

/* ============================== room ============================== */

const room = new THREE.Group();
scene.add(room);
ctx.groups.room = room;

const WALL_Z = -2.6;

{
  const floorTex = TEX.makeWood({
    seed: 7, planks: 8, base: [104, 62, 34], dark: [44, 26, 14], light: [158, 108, 60],
    variance: 0.28, cool: 0.34, knots: 3,
  });
  for (const m of [floorTex.map, floorTex.bump, floorTex.rough]) {
    if (!m) continue;
    m.wrapS = m.wrapT = THREE.RepeatWrapping;
    m.repeat.set(4.364, 3.167);
    m.anisotropy = Q.aniso;
  }
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 30),
    new THREE.MeshStandardMaterial({
      map: floorTex.map, bumpMap: floorTex.bump, bumpScale: 0.62,
      roughnessMap: floorTex.rough || null,
      color: 0x8a6648, roughness: 0.62, metalness: 0.0,
    })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 1.0);
  floor.receiveShadow = true;
  room.add(floor);

  // a worn stage rug so the middle of the floor is not an empty plane
  {
    const rug = new THREE.Mesh(
      new THREE.PlaneGeometry(6.2, 4.0),
      new THREE.MeshStandardMaterial({
        map: TEX.makeRug({ seed: 33 }),
        color: 0xffffff, roughness: 0.96,
        transparent: true, opacity: 0.94,
      })
    );
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(-0.35, 0.008, 1.35);
    rug.receiveShadow = true;
    room.add(rug);
  }

  const paint = TEX.makePaint({ seed: 5, base: [44, 15, 12], vary: 8, repeat: [3, 2] });
  const wallMat = new THREE.MeshStandardMaterial({ map: paint, color: 0xffffff, roughness: 0.88 });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(24, 10.4), wallMat);
  wall.position.set(0, 5.2, WALL_Z);
  wall.receiveShadow = true;
  room.add(wall);

  // panelling members — real geometry so the key/text lights model them
  const trimTex = TEX.makeWood({
    seed: 13, planks: 2, base: [64, 34, 18], dark: [32, 17, 8], light: [104, 62, 32],
    gapPx: 0, variance: 0.16, cool: 0.26, knots: 0,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    map: trimTex.map, roughnessMap: trimTex.rough || null,
    color: 0x94643e, roughness: 0.70,
  });
  const strip = (w, h, d, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), trimMat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    room.add(m);
    return m;
  };
  // baseboard, dado rail, crown
  strip(24, 0.34, 0.11, 0, 0.17, WALL_Z + 0.04);
  strip(24, 0.11, 0.10, 0, 1.16, WALL_Z + 0.04);
  strip(24, 0.16, 0.13, 0, 4.72, WALL_Z + 0.04);
  // tall panels
  const pw = 1.78, gap = 0.46, y0 = 1.36, y1 = 4.38;
  for (let i = -4; i <= 4; i++) {
    const cx = i * (pw + gap);
    const midY = (y0 + y1) / 2, ph = y1 - y0;
    strip(0.075, ph, 0.075, cx - pw / 2, midY, WALL_Z + 0.035);
    strip(0.075, ph, 0.075, cx + pw / 2, midY, WALL_Z + 0.035);
    strip(pw + 0.075, 0.075, 0.075, cx, y1, WALL_Z + 0.035);
    strip(pw + 0.075, 0.075, 0.075, cx, y0, WALL_Z + 0.035);
  }
  // wainscot spacers below the dado
  for (let i = -5; i <= 5; i++) strip(0.075, 0.78, 0.065, i * 1.68, 0.72, WALL_Z + 0.03);

  const darkMat = new THREE.MeshStandardMaterial({ map: paint, color: 0x4e2418, roughness: 0.94 });
  const wl = new THREE.Mesh(new THREE.PlaneGeometry(24, 10.4), darkMat);
  wl.rotation.y = Math.PI / 2; wl.position.set(-7.6, 5.2, 1); room.add(wl);
  const wr = wl.clone(); wr.rotation.y = -Math.PI / 2; wr.position.x = 7.6; room.add(wr);
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(30, 22), new THREE.MeshStandardMaterial({ color: 0x1e0b09, roughness: 1 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.set(0, 8.0, 1.0); room.add(ceil);
}

let picLight;

/* ============================== wall sconces ============================== */

function sconce(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);

  const brass = new THREE.MeshStandardMaterial({
    color: 0xE8C77A, roughness: 0.38, metalness: 0.92, envMap, envMapIntensity: 0.8,
  });
  const back = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.05, 16), brass);
  back.rotation.x = Math.PI / 2; g.add(back);
  const armCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0.02), new THREE.Vector3(0, 0.10, 0.16), new THREE.Vector3(0, 0.05, 0.30),
  ]);
  g.add(new THREE.Mesh(new THREE.TubeGeometry(armCurve, 12, 0.022, 8), brass));

  // a closed brass lantern rather than an open shade: a cone seen edge-on at this
  // distance read as a floating paper triangle, which is worse than no fixture at all
  const cage = new THREE.Mesh(
    new THREE.BoxGeometry(0.19, 0.30, 0.19),
    new THREE.MeshStandardMaterial({
      color: 0xC9A868, roughness: 0.42, metalness: 0.88, envMap, envMapIntensity: 0.7,
    })
  );
  cage.position.set(0, 0.02, 0.30);
  cage.castShadow = true;
  g.add(cage);
  const glass = new THREE.Mesh(
    new THREE.BoxGeometry(0.155, 0.255, 0.155),
    new THREE.MeshStandardMaterial({
      color: 0xffdcae, roughness: 0.55, transparent: true, opacity: 0.92,
      emissive: 0xffa652, emissiveIntensity: 0.34,
    })
  );
  glass.position.copy(cage.position);
  g.add(glass);
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.155, 0.10, 4), cage.material);
  cap.position.set(0, 0.21, 0.30); cap.rotation.y = Math.PI / 4;
  g.add(cap);

  if (!Q.mobile) {
    const bulb = new THREE.PointLight(0xffb066, 1.5, 4.6, 1.9);
    bulb.position.set(0, 0.02, 0.32);
    g.add(bulb);
  }

  // no painted wall pool: an additive plane out at the frame edge read as a lens flare
  // rather than as light. The bulb above does the work honestly.

  room.add(g);
  return g;
}
// high on the wall, clear of the wordmark and the case: they wash the crown and give the
// room a ceiling, which is what "bland" was really complaining about
sconce(-5.15, 3.55, WALL_Z + 0.10);
sconce(5.15, 3.55, WALL_Z + 0.10);

// a picture light over the name. Cast gold in a dark room has nothing to reflect, so the
// letters were reading bronze-black; the fixture is the honest fix and it dresses the wall.
{
  const brass = new THREE.MeshStandardMaterial({
    color: 0xC9A868, roughness: 0.40, metalness: 0.9, envMap, envMapIntensity: 0.8,
  });
  const g = new THREE.Group();
  g.position.set(-2.86, 3.16, WALL_Z + 0.14);
  const hoodLen = 2.60;
  for (const ax of [-hoodLen * 0.31, hoodLen * 0.31]) {
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.035), brass);
    plate.position.set(ax, 0.03, -0.13);
    g.add(plate);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, 0.44, 10), brass);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(ax, -0.005, 0.07);
    arm.castShadow = true;
    g.add(arm);
  }
  const hoodMat = new THREE.MeshStandardMaterial({
    color: 0x6E4E24, roughness: 0.62, metalness: 0.62, envMap, envMapIntensity: 0.35,
    side: THREE.DoubleSide,
  });
  const hood = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, hoodLen, 20, 1, true, Math.PI * 0.06, Math.PI * 1.05), hoodMat);
  hood.rotation.z = Math.PI / 2;
  hood.position.set(0, -0.04, 0.27);
  g.add(hood);
  room.add(g);

  const pic = new THREE.SpotLight(0xffe6bc, 132, 9.0, 0.70, 0.96, 1.25);
  pic.position.set(-2.86, 3.95, WALL_Z + 1.70);
  pic.target.position.set(-2.86, 2.42, WALL_Z + 0.05);
  scene.add(pic, pic.target);
  picLight = pic;
}

/* ============================== framed photographs ============================== */

function framedPhoto(name, w, h, x, y, z, tilt = 0, lean = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = tilt;
  g.rotation.x = lean;

  const gilt = new THREE.MeshStandardMaterial({
    color: 0xB9975B, roughness: 0.46, metalness: 0.8, envMap, envMapIntensity: 0.6,
  });
  const fw = 0.055, d = 0.05;
  const bar = (bw, bh, bx, by) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, d), gilt);
    m.position.set(bx, by, 0); m.castShadow = true; g.add(m);
  };
  bar(w + fw * 2, fw, 0, h / 2 + fw / 2);
  bar(w + fw * 2, fw, 0, -h / 2 - fw / 2);
  bar(fw, h, -w / 2 - fw / 2, 0);
  bar(fw, h, w / 2 + fw / 2, 0);

  // mount board, then the picture inset into it
  const mount = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ color: 0xE4D6B4, roughness: 0.92 })
  );
  mount.position.z = -0.012;
  g.add(mount);

  const pic = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 0.80, h * 0.80),
    new THREE.MeshStandardMaterial({ color: 0x8a7a62, roughness: 0.72 })
  );
  pic.position.z = -0.006;
  g.add(pic);
  framedPhoto.pending = framedPhoto.pending || [];
  framedPhoto.pending.push({ name, mat: pic.material });

  // glass: a faint raking sheen so it reads as glazed
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({
      map: TEX.makeGlareStripe(), transparent: true, opacity: 0.035,
      blending: THREE.AdditiveBlending, depthWrite: false,
    })
  );
  glass.position.z = 0.012;
  g.add(glass);

  room.add(g);
  return g;
}

// The back wall is spoken for: the name owns the left of it and the case owns the right.
// So the photographs come down onto the floor, where the empty foreground was. An easel
// downstage-left, and one frame still leaning against the wainscot waiting to be hung.
{
  const easelWood = new THREE.MeshStandardMaterial({ color: 0x5c3a22, roughness: 0.74 });
  const e = new THREE.Group();
  e.position.set(-2.15, 0, 1.30);
  e.rotation.y = 0.40;
  for (const lx of [-0.30, 0.30]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 1.60, 8), easelWood);
    leg.position.set(lx, 0.79, 0.02); leg.rotation.x = 0.10; leg.castShadow = true; e.add(leg);
  }
  const backLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.020, 0.024, 1.55, 8), easelWood);
  backLeg.position.set(0, 0.76, -0.30); backLeg.rotation.x = -0.24; backLeg.castShadow = true; e.add(backLeg);
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.035, 0.09), easelWood);
  ledge.position.set(0, 0.86, 0.07); ledge.castShadow = true; e.add(ledge);
  room.add(e);

  framedPhoto('room1', 0.66, 0.66, -2.15, 1.24, 1.25, 0.40, -0.10);
  framedPhoto('room2', 0.58, 0.58, 1.05, 0.44, WALL_Z + 0.28, -0.16, -0.13);
}

/* ============================== a table with a stack ============================== */
// Something in the middle distance so the floor between the name and the case is not empty.

{
  const woodT = TEX.makeWood({
    seed: 41, planks: 2, base: [70, 38, 20], dark: [30, 15, 7], light: [110, 66, 34],
    gapPx: 0, variance: 0.20, cool: 0.30, knots: 1,
  });
  const wood = new THREE.MeshStandardMaterial({
    map: woodT.map, bumpMap: woodT.bump, bumpScale: 0.35,
    roughnessMap: woodT.rough || null, color: 0x8a5c3a, roughness: 0.60,
  });
  const t = new THREE.Group();
  t.position.set(-1.15, 0, 0.55);
  t.rotation.y = 0.22;
  const top = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.055, 0.62), wood);
  top.position.y = 0.72; top.castShadow = true; top.receiveShadow = true; t.add(top);
  for (const [lx, lz] of [[-0.46, -0.24], [0.46, -0.24], [-0.46, 0.24], [0.46, 0.24]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.036, 0.72, 10), wood);
    leg.position.set(lx, 0.36, lz); leg.castShadow = true; t.add(leg);
  }
  // a short stack of copies, spines out, lying flat
  const stackMat = [
    new THREE.MeshStandardMaterial({ color: 0x4a0b06, roughness: 0.66 }),
    new THREE.MeshStandardMaterial({ color: 0x3a1712, roughness: 0.70 }),
    new THREE.MeshStandardMaterial({ color: 0x2c2318, roughness: 0.72 }),
  ];
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.045, 0.29), stackMat[i]);
    b.position.set(-0.16 + i * 0.014, 0.772 + i * 0.047, 0.02 + i * 0.012);
    b.rotation.y = (i - 1) * 0.05;
    b.castShadow = true; b.receiveShadow = true;
    t.add(b);
  }
  room.add(t);
}

/* ============================== haze: beam + dust ============================== */

{
  const beamTex = TEX.makeBeamGradient();
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.24, 1.85, 5.2, 32, 1, true),
    new THREE.MeshBasicMaterial({
      map: beamTex, transparent: true, opacity: 0.062, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    })
  );
  beam.position.set(2.55, 3.55, 1.35);
  beam.rotation.z = 0.07; beam.rotation.x = -0.16;
  beam.renderOrder = 5;
  room.add(beam);
  ctx.updaters.push((dt, t) => {
    beam.material.opacity = 0.056 + Math.sin(t * 0.7) * 0.009 + Math.sin(t * 1.7) * 0.004;
  });

  const dustGeo = new THREE.BufferGeometry();
  const n = Q.dust;
  const pos = new Float32Array(n * 3), seed = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = 0.4 + Math.random() * 4.4;
    pos[i * 3 + 1] = 0.3 + Math.random() * 4.2;
    pos[i * 3 + 2] = -2.2 + Math.random() * 4.0;
    seed[i * 3] = Math.random() * 100; seed[i * 3 + 1] = 0.2 + Math.random() * 0.6; seed[i * 3 + 2] = Math.random() * 100;
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    size: 0.030, map: TEX.makeDustSprite(), transparent: true, opacity: 0.42,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  room.add(dust);
  ctx.updaters.push((dt, t) => {
    const p = dustGeo.attributes.position.array;
    for (let i = 0; i < n; i++) {
      p[i * 3] += Math.sin(t * 0.3 + seed[i * 3]) * 0.0006;
      p[i * 3 + 1] -= seed[i * 3 + 1] * dt * 0.05;
      if (p[i * 3 + 1] < 0.2) p[i * 3 + 1] = 4.4;
    }
    dustGeo.attributes.position.needsUpdate = true;
  });
}

/* ============================== curtain rig ============================== */

const CUR = {
  z: 2.20, W: 5.20, H: 5.85, y0: -1.55,
  hLandscape: 5.85, hPortrait: 6.92,
  segX: mobile ? 112 : 160, segY: mobile ? 28 : 40, folds: 5.0,
  openK: 0.60,           // recomputed at open start from the live aspect
  gatherFrac: 0.745,      // gather to this fraction of the visible half-width: the rest stays as drape
};
CUR.top = CUR.y0 + CUR.H;   // the cloth stops inside the frame so the valance is visible
const CROWN_BASE_TOP = CUR.top;

const velvet = TEX.makeVelvet({ seed: 21, base: [82, 15, 11] });
for (const m of [velvet.map, velvet.bump]) {
  m.wrapS = m.wrapT = THREE.MirroredRepeatWrapping;
  m.needsUpdate = true;
}
const velvetMat = new THREE.MeshPhysicalMaterial({
  map: velvet.map, bumpMap: velvet.bump, bumpScale: 0.42,
  color: 0xffffff, roughness: 0.92, metalness: 0,
  sheen: 0.42, sheenColor: new THREE.Color(0x8a3222), sheenRoughness: 0.72,
  side: THREE.DoubleSide,
});

function makeCurtainHalf(side /* +1 right, -1 left */, seedPhase) {
  const g = new THREE.PlaneGeometry(1, 1, CUR.segX, CUR.segY);
  const nx = CUR.segX + 1, ny = CUR.segY + 1;

  const colU = new Float32Array(nx), col1mU = new Float32Array(nx),
    colEdge = new Float32Array(nx), colFold = new Float32Array(nx),
    colBelly = new Float32Array(nx), colHem = new Float32Array(nx),
    colSwaySin = new Float32Array(nx), colSwayCos = new Float32Array(nx);
  for (let ix = 0; ix < nx; ix++) {
    const u = ix / CUR.segX;
    colU[ix] = u; col1mU[ix] = 1 - u;
    colEdge[ix] = Math.max(0, 1 - u * 3.4);
    const ph = u * CUR.folds * Math.PI * 2 + seedPhase + Math.sin(u * 9.1 + seedPhase) * 0.4;
    colFold[ix] = 0.62 * Math.sin(ph) + 0.38 * Math.sin(ph * 0.47 + 2.1);
    colBelly[ix] = 1 - Math.abs(u - 0.5) * 2;
    colHem[ix] = 1 + Math.sin(u * 17 + seedPhase * 7);
    colSwaySin[ix] = Math.sin(u * 5); colSwayCos[ix] = Math.cos(u * 5);
  }
  // per-row constants (v only), same treatment
  const rowV = new Float32Array(ny), rowDrag = new Float32Array(ny),
    rowAmpV = new Float32Array(ny), rowHem = new Float32Array(ny);
  for (let iy = 0; iy < ny; iy++) {
    const v = 1 - iy / CUR.segY;   // matches PlaneGeometry's top-first row order
    rowV[iy] = v;
    // bottom drags behind the track, and not on a straight line: a monotonic lag gives
    // a leading edge that is a perfect diagonal, which reads as a sheet of card. Real
    // cloth hangs from folds, so the drag itself has the fold frequency in it.
    rowDrag[iy] = Math.pow(1 - v, 1.6) * (0.86 + 0.14 * Math.sin(v * 7.0 + seedPhase * 1.7));
    rowAmpV[iy] = 0.44 + 0.56 * (1 - v);
    rowHem[iy] = (1 - v) * 0.026;
  }
  // per-frame row scratch, allocated once and reused
  const rowXK = new Float32Array(ny), rowScal = new Float32Array(ny),
    rowAmp = new Float32Array(ny), rowBelly = new Float32Array(ny),
    rowY = new Float32Array(ny), rowSwS = new Float32Array(ny), rowSwC = new Float32Array(ny);

  const mesh = new THREE.Mesh(g, velvetMat);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  /* The left half is drawn by mirroring x, which reverses its triangle winding. Left that
     way it renders correctly only by luck: DoubleSide plus the fragment shader's
     gl_FrontFacing flip put the lighting back. Everything that reads geometry without that
     flip saw a surface facing upstage, and the occlusion pass printed the whole room onto
     the closed cloth. Flipping the winding back here, once, at build time, is the fix at
     the root: after this both halves are wound the same way, front-facing is true for both,
     and the normals written in updateCurtainHalf are used as stored by every pass. */
  if (side < 0 && g.index) {
    const ix = g.index.array;
    for (let i = 0; i < ix.length; i += 3) { const b = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = b; }
    g.index.needsUpdate = true;
  }
  mesh.position.set(0, 0, CUR.z);
  scene.add(mesh);
  return {
    mesh, side, seedPhase, geo: g, nx, ny,
    colU, col1mU, colEdge, colFold, colBelly, colHem, colSwaySin, colSwayCos,
    rowV, rowDrag, rowAmpV, rowHem,
    rowXK, rowScal, rowAmp, rowBelly, rowY, rowSwS, rowSwC,
  };
}

const curtainR = makeCurtainHalf(1, 0.0);
const curtainL = makeCurtainHalf(-1, 2.3);

const easeHeavy = (t) => {           // slow start, weighted finish
  t = Math.max(0, Math.min(1, t));
  const s = t * t * (3 - 2 * t);
  return s * s * (3 - 2 * s);
};

const LAG = 0.24, LAG_DEN = 1 - LAG * 0.4;

function updateCurtainHalf(half, gGlobal, time) {
  const { side, seedPhase, geo, nx, ny } = half;
  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal.array;
  const W = CUR.W, openK = CUR.openK, y0 = CUR.y0, H = CUR.H;

  // per-row, per-frame terms: 41 easings + a handful of sines, not 6600 of them
  const gWin = Math.max(0, 1 - Math.abs(gGlobal * 2 - 1));
  for (let iy = 0; iy < ny; iy++) {
    const v = half.rowV[iy];
    const g = easeHeavy((gGlobal - LAG * half.rowDrag[iy]) / LAG_DEN);
    half.rowXK[iy] = g * openK;
    // the leading edge scallops with the folds instead of ending in a clean line
    half.rowScal[iy] = 0.030 * Math.sin(v * 5.1 + seedPhase * 2.0 + gGlobal * 2.6) * gWin;
    // bigger cloth wants deeper folds, or it reads as printed stripes
    half.rowAmp[iy] = 0.155 * (1 + 1.9 * g) * half.rowAmpV[iy];
    half.rowBelly[iy] = 0.16 * (1 - v) * (1 - g);            // closed belly
    half.rowY[iy] = y0 + v * H;
    const swayAmp = 0.06 * Math.max(0, g * (1 - g) * 4);     // sway mid-open
    const A = time * 2.1 + v * 3.0 + seedPhase;
    half.rowSwS[iy] = Math.sin(A) * swayAmp;
    half.rowSwC[iy] = Math.cos(A) * swayAmp;
  }

  let j = 0;
  for (let iy = 0; iy < ny; iy++) {
    const xk = half.rowXK[iy], sc = half.rowScal[iy], am = half.rowAmp[iy],
      be = half.rowBelly[iy], yb = half.rowY[iy], hm = half.rowHem[iy],
      ss = half.rowSwS[iy], cc = half.rowSwC[iy];
    for (let ix = 0; ix < nx; ix++, j += 3) {
      const x01 = half.colU[ix] + half.col1mU[ix] * xk + half.colEdge[ix] * sc;
      pos[j] = side * x01 * W;
      pos[j + 1] = yb - hm * half.colHem[ix];                                  // uneven hem
      // sin(t*2.1 + v*3 + u*5 + phase) split by the angle-sum identity into
      // row(sin/cos) * col(cos/sin) — exact, and free of per-vertex trig
      pos[j + 2] = am * half.colFold[ix] + be * half.colBelly[ix]
        + ss * half.colSwayCos[ix] + cc * half.colSwaySin[ix];
    }
  }

  const rs = nx * 3;
  j = 0;
  for (let iy = 0; iy < ny; iy++) {
    const jm = iy === 0 ? 0 : -rs, jp = iy === ny - 1 ? 0 : rs;
    for (let ix = 0; ix < nx; ix++, j += 3) {
      const im = ix === 0 ? 0 : -3, ip = ix === nx - 1 ? 0 : 3;
      const ax = pos[j + ip] - pos[j + im],
        ay = pos[j + ip + 1] - pos[j + im + 1],
        az = pos[j + ip + 2] - pos[j + im + 2];
      const bx = pos[j + jp] - pos[j + jm],
        by = pos[j + jp + 1] - pos[j + jm + 1],
        bz = pos[j + jp + 2] - pos[j + jm + 2];
      const cx = by * az - bz * ay, cy = bz * ax - bx * az, cz = bx * ay - by * ax;
      // `side` because the left half's positions are mirrored, and a mirror inverts the
      // handedness of a cross product taken from them. Its winding was flipped back at
      // build time, so nothing downstream re-flips this for us: it has to be right here.
      const L = (Math.sqrt(cx * cx + cy * cy + cz * cz) || 1) * side;
      nor[j] = cx / L; nor[j + 1] = cy / L; nor[j + 2] = cz / L;
    }
  }

  geo.attributes.position.needsUpdate = true;
  geo.attributes.normal.needsUpdate = true;
}

/* valance across the top, with the load-progress braid */
const valance = TEX.makeValance({ scallops: 11 });
let valanceMesh;
// everything that hangs from the rail rides together when the rail moves
const crown = new THREE.Group();
scene.add(crown);
// The valance hangs *down* from the cloth's top rail, and it is doing two jobs that pull
// against each other: it has to be inside the frame to be seen at all, and it must not hang
// low enough to occlude the bookcase standing 6m further upstage. Because the cloth is
// nearer the camera, every world-unit it drops eats several of the case's. 0.60 is the
// whole budget: below ~3.66 it starts cutting the case's header off.
const VAL = { W: CUR.W * 2.28, H: 0.60, y: CUR.top - 0.55 };
{
  const g = new THREE.PlaneGeometry(1, 1, 120, 10);
  const mat = new THREE.MeshPhysicalMaterial({
    map: valance.texture, alphaMap: valance.alpha, transparent: true, alphaTest: 0.04,
    color: 0xffffff, roughness: 0.9, metalness: 0,
    sheen: 0.26, sheenColor: new THREE.Color(0x9c4030), sheenRoughness: 0.80,
    side: THREE.DoubleSide,
  });
  valanceMesh = new THREE.Mesh(g, mat);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) + 0.5, v = p.getY(i) + 0.5;
    const z = 0.11 * Math.sin(u * 46) * (0.5 + 0.5 * (1 - v)) + 0.03 * Math.sin(u * 7);
    p.setXYZ(i, (u - 0.5) * VAL.W, VAL.y + v * VAL.H, z);
  }
  g.computeVertexNormals();
  valanceMesh.position.set(0, 0, CUR.z + 0.20);
  valanceMesh.frustumCulled = false;
  valanceMesh.castShadow = false;
  valanceMesh.receiveShadow = false;
  crown.add(valanceMesh);
}
ctx.valanceProgress = valance.setProgress;

/* proscenium: a near-black board above the valance so no void shows, plus the gilt edge */
{
  const pros = new THREE.Mesh(
    new THREE.PlaneGeometry(34, 9),
    new THREE.MeshBasicMaterial({ color: 0x0d0303, fog: false })
  );
  pros.position.set(0, CUR.top + 4.5, CUR.z + 0.30);
  crown.add(pros);

  // gilt band along the bottom of the proscenium header — reads as a real arch, not a mask
  const band = new THREE.Mesh(
    new THREE.BoxGeometry(34, 0.13, 0.10),
    new THREE.MeshStandardMaterial({
      color: 0xB9975B, roughness: 0.44, metalness: 0.85, envMap, envMapIntensity: 0.7,
    })
  );
  band.position.set(0, CUR.top + 0.03, CUR.z + 0.32);
  crown.add(band);
  const bandLip = new THREE.Mesh(
    new THREE.BoxGeometry(34, 0.05, 0.10),
    new THREE.MeshStandardMaterial({
      color: 0x8E6B2C, roughness: 0.5, metalness: 0.85, envMap, envMapIntensity: 0.6,
    })
  );
  bandLip.position.set(0, CUR.top - 0.10, CUR.z + 0.32);
  crown.add(bandLip);

  // side legs: black masking so the gathered drape has something to disappear behind
  for (const s of [1, -1]) {
    const leg = new THREE.Mesh(
      new THREE.PlaneGeometry(8, 16),
      new THREE.MeshBasicMaterial({ color: 0x0d0303, fog: false })
    );
    leg.position.set(s * (CUR.W + 3.9), 2.0, CUR.z + 0.28);
    crown.add(leg);
  }

  crown.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
}

const ropes = new THREE.Group();
ropes.visible = false;
scene.add(ropes);
let ropesBuilt = false;

function buildRopes(gatherX) {
  ropes.clear();
  const ropeMat = new THREE.MeshStandardMaterial({
    map: TEX.makeRopeTexture(), color: 0xE8C77A, roughness: 0.42, metalness: 0.62,
    envMap, envMapIntensity: 0.75, transparent: true, opacity: 0,
  });

  // The bundle: after gathering, the cloth occupies x from gatherX out to CUR.W. The tie
  // has to wrap *that*, at a height inside the visible frame. Both halves are now derived
  // from the same live number instead of two hand-tuned constants, which is why one side
  // used to float away from its curtain.
  const tieY = CUR.y0 + CUR.H * 0.50;
  const inner = gatherX;                       // inboard face of the drape
  const grip = Math.min(0.78, (CUR.W - gatherX) * 0.52);   // how much cloth the cord gathers

  for (const s of [1, -1]) {
    const grp = new THREE.Group();
    const pts = [
      new THREE.Vector3(s * (inner + grip + 0.30), tieY + 0.62, CUR.z - 0.22),  // hook, upstage
      new THREE.Vector3(s * (inner + grip * 0.9), tieY + 0.22, CUR.z + 0.02),
      new THREE.Vector3(s * (inner + grip * 0.4), tieY + 0.02, CUR.z + 0.26),   // round the front
      new THREE.Vector3(s * (inner + 0.04), tieY - 0.11, CUR.z + 0.20),
      new THREE.Vector3(s * (inner + 0.01), tieY - 0.14, CUR.z - 0.06),         // under and behind
      new THREE.Vector3(s * (inner + grip * 0.7), tieY - 0.02, CUR.z - 0.24),
      new THREE.Vector3(s * (inner + grip + 0.26), tieY + 0.40, CUR.z - 0.26),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    const rope = new THREE.Mesh(new THREE.TubeGeometry(curve, 52, 0.028, 8), ropeMat);
    rope.castShadow = true;
    grp.add(rope);

    // the tassel hangs off the front of the loop, where the cord crosses the cloth
    const tass = new THREE.Group();
    tass.position.copy(pts[3]);
    const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.010, 0.010, 0.17, 6), ropeMat);
    cord.position.y = -0.085; tass.add(cord);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.042, 14, 12), ropeMat);
    head.position.y = -0.192; head.scale.y = 1.25; tass.add(head);
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.070, 0.18, 14, 1, true), ropeMat);
    skirt.position.y = -0.312; tass.add(skirt);
    const fringe = new THREE.Mesh(new THREE.CylinderGeometry(0.070, 0.058, 0.05, 14, 1, true), ropeMat);
    fringe.position.y = -0.425; tass.add(fringe);
    grp.add(tass);

    let swing = 0.16 * s;
    ctx.updaters.push((dt, t) => {
      if (!ropes.visible) return;
      swing *= (1 - Math.min(1, dt * 0.55));
      tass.rotation.z = Math.sin(t * 2.4 + (s > 0 ? 0 : 1.1)) * swing;
      tass.rotation.x = Math.sin(t * 1.9 + (s > 0 ? 0.6 : 2.2)) * swing * 0.5;
    });

    grp.traverse((o) => { if (o.isMesh) o.receiveShadow = false; });
    ropes.add(grp);
  }
  ropes.visible = true;
}

/* ============================== assets: covers, crest, font ============================== */

const manager = new THREE.LoadingManager();
const texLoader = new THREE.TextureLoader(manager);
ctx.texLoader = texLoader;
ctx.manager = manager;

function loadCover(name, url) {
  texLoader.load(url, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = Q.aniso;
    ctx.covers[name] = t;
    if (ctx.assignCover) ctx.assignCover(name, t);
    // wall photographs are waiting on the same loader
    for (const p of (framedPhoto.pending || [])) {
      if (p.name === name) { p.mat.map = t; p.mat.color.set(0xffffff); p.mat.needsUpdate = true; }
    }
  });
}
loadCover('mb4', 'assets/covers/bulletin-4.jpg');
loadCover('mb3', 'assets/covers/bulletin-3.jpg');

loadCover('mb1', 'assets/covers/bulletin-1.jpg');
loadCover('casebook2', 'assets/covers/casebook-2.jpg');
loadCover('casebookT', 'assets/covers/casebook-teaser.jpg');
loadCover('mv1', 'assets/covers/series-1.jpg');
loadCover('mv2', 'assets/covers/series-2.jpg');
loadCover('crest', 'assets/crest.jpg');
loadCover('crestMask', 'assets/crest-mask.png');
loadCover('logo', 'assets/logo.jpg');
loadCover('logoMask', 'assets/logo-mask.jpg');
loadCover('room1', 'assets/room-frame-1.jpg');
loadCover('room2', 'assets/room-frame-2.jpg');

let loadFrac = 0, fontsReady = false, everythingLoaded = false;
let loadedAtMs = 0, fontsAtMs = 0;
manager.onProgress = (url, n, total) => {
  loadFrac = n / total;
  ctx.valanceProgress(reduced ? 1 : loadFrac * (fontsReady ? 0.97 : 0.92));
};
manager.onLoad = () => {
  everythingLoaded = true;
  loadedAtMs = performance.now() - ctx.state.t0;
  ctx.valanceProgress(reduced ? 1 : 0.97);
};
manager.onError = (url) => console.warn('[theater3d] failed to load', url);

document.fonts.ready.then(() => {
  fontsReady = true;
  fontsAtMs = performance.now() - ctx.state.t0;
  // redraw everything that bakes type into canvas now the real faces exist
  if (ctx.refreshCanvasType) ctx.refreshCanvasType();
  if (everythingLoaded) ctx.valanceProgress(reduced ? 1 : 0.97);
});

/* build the right-hand side of the stage */
buildShelf(ctx);
buildText(ctx);   // async inside (font json); adds group when ready
buildCrest(ctx);

let post = null;
import('./theater3d-post.js')
  .then((m) => {
    post = (m && typeof m.initPost === 'function') ? m.initPost(ctx) : null;
    if (post) {
      post.setSize(innerWidth, innerHeight);
      ctx.post = post;
      renderer.info.autoReset = false;   // the composer resets per internal pass otherwise
    }
  })
  .catch((e) => console.warn('[theater3d] post-processing unavailable, plain render path', e));

import('./theater3d-sound.js')
  .then((m) => {
    if (!m || typeof m.initSound !== 'function') return;
    m.initSound(ctx);
    const btn = ctx.sound.makeToggleButton();
    btn.className += ' t3snd-place';
    document.body.appendChild(btn);
    // the curtain already open by the time the module lands? then just lay the room in.
    if (ctx.state.phase === 'open') ctx.sound.setRoom(1);
  })
  .catch((e) => console.warn('[theater3d] sound unavailable', e));

import('./theater3d-reader.js')
  .then((m) => {
    if (!m || typeof m.initReader !== 'function') return;
    m.initReader(ctx);
    // the stage stops rendering while the copy is out: it is fully covered, and the
    // composer is the most expensive thing on the page
    ctx.reader.onOpen(() => {
      renderer.setAnimationLoop(null);
      if (ctx.sound) ctx.sound.cue('bookOpen');
    });
    // a turn is a turn however it was asked for: keyboard, zone, button or swipe
    const posEl = document.querySelector('.t3r-pos');
    if (posEl && 'MutationObserver' in window) {
      new MutationObserver(() => { if (ctx.sound) ctx.sound.cue('pageTurn'); })
        .observe(posEl, { childList: true, characterData: true, subtree: true });
    }
    ctx.reader.onClose(() => {
      if (heroOnScreen && !document.hidden) { last = performance.now(); renderer.setAnimationLoop(loop); }
    });
  })
  .catch((e) => console.warn('[theater3d] reader unavailable, clicks fall back to the archive', e));

/* the overlay type — loaded lazily so a failure there cannot take the scene down */
import('./theater3d-hud.js')
  .then((m) => {
    if (m && typeof m.initHud === 'function') { m.initHud(ctx); document.body.classList.add('has-hud'); }
  })
  .catch((e) => console.warn('[theater3d] hud unavailable, falling back to the static tagline', e));

/* ============================== open timeline ============================== */

const tagline = document.getElementById('tagline');
const hint = document.getElementById('hint');

const stats = { frames: 0, acc: 0, worst: 0, avgMs: 0, worstMs: 0, fps: 0, curtainMs: 0 };
window.__frameStats = stats;

const WARM = {
  need: 8, budget: 24,
  frames: 0, resets: 0,
  compiled: false, compileMs: 0, deadline: 0,
};
const HARD_OPEN_MS = 9000;

let curtainAcc = 0, curtainN = 0;

function beginOpening(now) {
  ctx.state.phase = 'opening';
  ctx.valanceProgress(1);        // the braid completes as the cloth is cleared to move
  if (ctx.sound) ctx.sound.cue('curtainOpen');
  ctx.state.openStartAt = now;
  // gather the cloth to a fraction of the visible half-width, so a real drape stays in frame
  const dist = VIEW.camPos.z - CUR.z;
  const halfW = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist * camera.aspect;
  const target = Math.min(CUR.W - 0.5, Math.max(1.15, halfW * CUR.gatherFrac));
  CUR.openK = target / CUR.W;
}

function finishOpening() {
  ctx.state.phase = 'open';
  ctx.state.openT = 1;
  if (curtainN > 0) {
    stats.curtainMs = +(curtainAcc / curtainN).toFixed(3);
    console.info(`[theater3d] curtain travel: ${curtainN} frames rendered over ${OPEN_MS}ms, ` +
      `cloth update avg ${stats.curtainMs}ms/frame (both halves, ${(CUR.segX + 1) * (CUR.segY + 1)} verts each)`);
    curtainAcc = 0; curtainN = 0;
  }
  updateCurtainHalf(curtainR, 1, 0);
  updateCurtainHalf(curtainL, 1, 0);
  tagline.classList.add('on');
  hint.classList.add('on');
  if (ctx.hud && ctx.hud.show) ctx.hud.show();
  // and the safety net: if the entrance never completed (a backgrounded tab freezes
  // these transitions), stop waiting for it and put the block on screen.
  setTimeout(() => {
    const root = document.querySelector('.t3hud');
    const line = document.querySelector('.t3hud-line');
    if (!root || !line) return;
    root.classList.add('is-forced');   // unconditional: by now the entrance is either
    // finished (the class simply pins the final state) or it was frozen by a background
    // tab and never will be. Either way the block belongs on screen.
  }, 3200);
  for (const f of ctx.onOpenFinished) f();
}

const OPEN_MS = 2100;
const ROPE_AT = 0.62;      // the tie-backs are threaded while the cloth is still travelling

if (reduced) {
  ctx.valanceProgress(1);
  CUR.openK = 0.46;
  buildRopes(CUR.openK * CUR.W * 0.98);
  ropesBuilt = true;
  ropes.traverse(o => { if (o.material) o.material.opacity = 1; });
  finishOpening();
  curtainSpot.intensity = CURTAIN_SPOT_OPEN;
}

/* ============================== resize / layout ============================== */

function layout() {
  const portrait = innerWidth / innerHeight < 0.82;
  ctx.state.portrait = portrait;
  camera.aspect = innerWidth / innerHeight;
  if (portrait) {
    // a longer lens on a phone too: 58 deg left a third of the frame as empty floor
    camera.fov = 46;
    VIEW.camPos.set(0, 2.60, 7.60);
    VIEW.lookAt.set(0, 3.00, -1.10);
  } else {
    camera.fov = 38;
    VIEW.camPos.set(0.10, 2.05, 8.90);
    VIEW.lookAt.set(0.30, 1.95, -1.20);
  }
  // raise the whole rig on a phone so the valance sits at the very top of the frame
  // instead of hanging across the bookcase
  CUR.H = portrait ? CUR.hPortrait : CUR.hLandscape;
  CUR.top = CUR.y0 + CUR.H;
  crown.position.y = CUR.top - CROWN_BASE_TOP;
  placeCamera();
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (post) post.setSize(innerWidth, innerHeight);
  if (ctx.state.phase !== 'loading') {
    // the gather point depends on the live aspect, so the tie-backs have to be re-hung
    const dist = VIEW.camPos.z - CUR.z;
    const halfW = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist * camera.aspect;
    CUR.openK = Math.min(CUR.W - 0.5, Math.max(1.15, halfW * CUR.gatherFrac)) / CUR.W;
    if (ropesBuilt) buildRopes(CUR.openK * CUR.W * 0.98);
  }
  for (const f of ctx.layoutFns) f(portrait);
}
addEventListener('resize', layout);
layout();

/* ============================== interaction ============================== */

initInteraction(ctx);

/* ============================== frame stats ============================== */

/* ============================== main loop ============================== */

let last = performance.now();
let settleUntil = 0;
let closeP = -1;          // curtain-close progress, driven by scroll
let ropeIn = 0;           // how far the tie-backs have faded in
let ropesFade = 1;

/* The stage renders only while it is actually on screen. Scrolling down to the band
   should not keep a WebGL scene running behind an opaque page.
   Driven off scroll position, not IntersectionObserver: a backgrounded tab reports its
   observers as not-intersecting, which stopped the loop before the curtain had opened
   and left the page on a closed curtain forever. */
let heroOnScreen = true;
function updateHeroVisibility() {
  const past = scrollY > innerHeight * 0.88;
  document.body.classList.toggle('past-hero', past);
  if (past === !heroOnScreen) return;
  heroOnScreen = !past;
  if (heroOnScreen && !document.hidden) { last = performance.now(); renderer.setAnimationLoop(loop); }
  else if (past) renderer.setAnimationLoop(null);
}
addEventListener('scroll', updateHeroVisibility, { passive: true });

// render only while the tab is actually visible
document.addEventListener('visibilitychange', () => {
  if (document.hidden) renderer.setAnimationLoop(null);
  // coming back from a background tab: CSS transitions and the projected overlay both
  // froze while we were away, so re-run layout rather than resuming mid-pose
  else if (heroOnScreen) {
    last = performance.now();
    layout();
    // A backgrounded tab freezes CSS transitions mid-flight, so the overlay can come back
    // stranded at a fraction of its opacity. Replay its entrance rather than leave it there.
    if (ctx.hud && ctx.state.phase === 'open') {
      const line = document.querySelector('.t3hud-line');
      if (line && parseFloat(getComputedStyle(line).opacity) < 0.98) { ctx.hud.hide(); ctx.hud.show(); }
    }
    renderer.setAnimationLoop(loop);
  }
});

renderer.setAnimationLoop(loop);
function loop() {
  const now = performance.now();
  const gapMs = now - last;              // raw frame-to-frame gap, un-clamped — the warm-up meters this
  const dt = Math.min(gapMs / 1000, 0.1);
  last = now;
  const t = now / 1000;

  const st = ctx.state;

  if (st.phase === 'loading') {
    const elapsed = now - st.t0;
    // the cloth still updates while waiting: it keeps the exact code path that will
    // run during the travel hot, so the warm-up measures the frames it is vouching for
    const c0 = performance.now();
    updateCurtainHalf(curtainR, 0, t);
    updateCurtainHalf(curtainL, 0, t);
    curtainAcc += performance.now() - c0; curtainN++;

    if (!reduced) {
      if (!WARM.compiled && everythingLoaded && fontsReady
        && (ctx.textMesh || now - st.t0 - loadedAtMs > 900)) {
        // (the wordmark mesh lands a beat after its font: compile with it in the scene
        // when possible, so no shader is left to compile mid-travel)
        const cc0 = performance.now();
        try { renderer.compile(scene, camera); } catch (e) { console.warn('[theater3d] precompile failed', e); }
        WARM.compileMs = performance.now() - cc0;
        WARM.compiled = true;
        WARM.deadline = now + 3200;
      }
      if (WARM.compiled) {
        if (gapMs <= WARM.budget) WARM.frames++;
        else { if (WARM.frames > 0) WARM.resets++; WARM.frames = 0; }
        // finish the braid two frames early: its canvas re-upload spikes one frame,
        // and that spike must land before the travel starts, not on its first step
        if (WARM.frames === WARM.need - 2) ctx.valanceProgress(1);
        const settled = WARM.frames >= WARM.need;
        if ((settled || now >= WARM.deadline) && elapsed >= 1700) {
          stats.curtainMs = +(curtainAcc / Math.max(1, curtainN)).toFixed(3);
          console.info(
            `[theater3d] open gate: assets ${Math.round(loadedAtMs)}ms · fonts ${Math.round(fontsAtMs)}ms · ` +
            `compile ${WARM.compileMs.toFixed(1)}ms · warm-up ${settled ? 'settled' : 'DEADLINE'} ` +
            `(${WARM.frames}/${WARM.need} consecutive ≤${WARM.budget}ms, ${WARM.resets} resets) · ` +
            `curtain update avg ${stats.curtainMs}ms/frame (both halves) · opening at ${Math.round(elapsed)}ms`
          );
          curtainAcc = 0; curtainN = 0;   // re-measure over the travel itself
          beginOpening(now);
        }
      } else if (elapsed >= HARD_OPEN_MS) {
        // absolute failsafe: a stalled asset must never hold the show forever
        console.warn(`[theater3d] opening on the hard ${HARD_OPEN_MS}ms deadline · assets:${everythingLoaded} fonts:${fontsReady}`);
        beginOpening(now);
      }
    }
  } else if (st.phase === 'opening') {
    const p = Math.min(1, (now - st.openStartAt) / OPEN_MS);
    st.openT = p;
    const e = easeHeavy(p);
    // the two halves are deliberately uneven
    const c0 = performance.now();
    updateCurtainHalf(curtainR, e, t);
    updateCurtainHalf(curtainL, Math.max(0, easeHeavy(Math.min(1, p * 1.04 - 0.04))), t);
    curtainAcc += performance.now() - c0; curtainN++;

    curtainSpot.intensity = 300 - (300 - CURTAIN_SPOT_OPEN) * e;
    renderer.toneMappingExposure = 0.96 - 0.10 * e;

    // thread the tie-backs mid-travel so nothing pops into existence at the end
    if (!ropesBuilt && p >= ROPE_AT) {
      buildRopes(CUR.openK * CUR.W * 0.98);
      ropesBuilt = true;
    }
    if (p >= 1) { finishOpening(); settleUntil = now + 2600; if (ctx.sound) ctx.sound.setRoom(1); }
  } else if (now < settleUntil) {
    // residual sway as the fabric settles, and the last of the light easing down
    const k = Math.max(0, (settleUntil - now) / 2600);
    updateCurtainHalf(curtainR, 1 - 0.007 * Math.sin(t * 3.1) * k, t);
    updateCurtainHalf(curtainL, 1 - 0.007 * Math.sin(t * 2.7 + 1) * k, t);
    curtainSpot.intensity = CURTAIN_SPOT_OPEN * (1 + 0.22 * k);
  } else {
    /* Scrolling away from the stage draws the curtain shut behind you, and the
       footlights come back up. Leaving a theater is not a fade; the house tells you
       the show is over. Scrubbing back up re-opens it, because it is a pure function
       of scroll rather than a one-way animation. */
    const p = reduced ? 0 : Math.min(1, Math.max(0, scrollY / (innerHeight * 0.70)));
    if (p !== closeP || p > 0) {
      closeP = p;
      // a single smoothstep, not easeHeavy: scroll-linked motion has to track the
      // gesture, and a double-smoothed curve puts the whole close in the last 30%
      const e = p * p * (3 - 2 * p);
      const idle = 0.004 * Math.sin(t * 0.9);            // the cloth is never quite still
      updateCurtainHalf(curtainR, 1 - e + idle, t);
      updateCurtainHalf(curtainL, 1 - e - idle * 0.8, t);
      curtainSpot.intensity = CURTAIN_SPOT_OPEN + (300 - CURTAIN_SPOT_OPEN) * e * 0.48;
      ropesFade = 1 - Math.min(1, p * 2.4);              // the tie-backs are let go first
      document.body.style.setProperty('--hero-out', e.toFixed(3));
      // the close is scrubbable, so the cloth is driven by position rather than fired
      if (ctx.sound) ctx.sound.cue('curtainClose', { progress: p });
    }
  }

  // ropes fade in over their own second, independent of the curtain's easing
  if (ropes.visible) {
    const rise = Math.min(1, ropeIn + dt * 0.9);
    ropeIn = rise;
    const target = rise * ropesFade;
    ropes.traverse(o => {
      if (!o.material) return;
      o.material.opacity += (target - o.material.opacity) * Math.min(1, dt * 6);
      o.visible = o.material.opacity > 0.01;
    });
  }

  for (const f of ctx.updaters) f(dt, t);

  {
    const d = ctx.presenting || 0;
    /* A room with nothing moving in it reads as a render. None of this is noticeable on
       its own; all of it is noticeable by its absence. The practicals have filaments,
       and the camera has an operator who is breathing. */
    const f = Q.reduced ? 1
      : 1 + Math.sin(t * 7.3) * 0.013 + Math.sin(t * 2.1) * 0.019 + Math.sin(t * 17.7) * 0.007;
    // a lean toward the copy, not a blackout: it no longer overlaps the name, so the
    // stage only has to give way a little
    textSpot.intensity = 120 * (1 - 0.34 * d) * f;
    picLight.intensity = 132 * (1 - 0.36 * d) * f;
    washL.intensity = 2.6 * (1 - 0.28 * d);
    key.intensity = 165 * f;
    if (!Q.reduced) {
      rig.position.y += Math.sin(t * 0.23) * 0.011;
      rig.position.x += Math.sin(t * 0.19 + 1.4) * 0.008;
      rig.rotation.z = Math.sin(t * 0.17) * 0.0014;
    }
  }

  if (post && post.enabled) { renderer.info.reset(); post.render(dt, t); }
  else renderer.render(scene, camera);

  // stats
  const frameMs = performance.now() - now;
  stats.acc += frameMs; stats.frames++;
  if (frameMs > stats.worst) stats.worst = frameMs;
  if (stats.frames >= 100) {
    stats.avgMs = +(stats.acc / stats.frames).toFixed(2);
    stats.worstMs = +stats.worst.toFixed(2);
    stats.fps = +(1000 / Math.max(stats.avgMs, 1000 / 240)).toFixed(0);
    stats.calls = renderer.info.render.calls;
    stats.triangles = renderer.info.render.triangles;
    stats.frames = 0; stats.acc = 0; stats.worst = 0;
  }
}
