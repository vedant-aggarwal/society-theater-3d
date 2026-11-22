// theater3d-interact.js — the picker, the follow spot, the parallax.

import * as THREE from 'three';
import { PRESENT } from './theater3d-shelf.js';

export function initInteraction(ctx) {
  const { renderer, camera, rig, scene, Q } = ctx;
  const canvas = renderer.domElement;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const peek = document.getElementById('peek');
  if (peek) { peek.textContent = ''; peek.classList.remove('on'); peek.style.display = 'none'; }

  const stageEl = document.getElementById('stage') || canvas.parentElement || canvas;
  let interactiveOn = null;
  function setInteractive(on) {
    on = !!on;
    if (interactiveOn === on) return;
    interactiveOn = on;
    stageEl.classList.toggle('is-interactive', on);
  }
  setInteractive(false);

  /* ---------------- the presentation light ---------------- */
  // A copy held out of the case needs its own pool or it reads as floating, not held.
  const showSpot = new THREE.SpotLight(0xfff0d4, 0, 5.2, 0.26, 0.78, 1.9);
  // upstage of the curtain plane, or the pool lands on the drape instead of the copy
  showSpot.position.set(PRESENT.x - 0.9, PRESENT.y + 2.4, PRESENT.z + 0.55);
  showSpot.target.position.set(PRESENT.x, PRESENT.y, PRESENT.z);
  scene.add(showSpot, showSpot.target);
  let showSpotTarget = 0;

  /* ---------------- per-book pose state ---------------- */
  for (const b of ctx.books) {
    b.cur = { pos: b.home.clone(), rotY: b.homeRotY || 0, rotZ: b.homeRotZ || 0, scale: 1 };
    b.tgt = { pos: b.home.clone(), rotY: b.homeRotY || 0, rotZ: b.homeRotZ || 0, scale: 1 };
    b.sweep = -1;           // glare sweep progress, -1 idle
    b.mode = 'home';        // home | present | lean
  }

  // rows, for the neighbours-lean-into-the-gap behaviour
  const rows = {};
  for (const b of ctx.books) {
    const key = Math.round(b.home.y * 100);
    (rows[key] = rows[key] || []).push(b);
  }
  for (const k in rows) rows[k].sort((a, b) => a.home.x - b.home.x);

  let hovered = null;
  // 0 at rest, 1 while a copy is being presented. The stage gives way to the copy.
  ctx.presenting = 0;

  // PRESENT is written in world space; the books live under the shelf group
  const presentLocal = new THREE.Vector3();
  function refreshPresentLocal() {
    presentLocal.set(PRESENT.x, PRESENT.y, PRESENT.z);
    if (ctx.groups.shelf) ctx.groups.shelf.worldToLocal(presentLocal);
  }
  refreshPresentLocal();
  ctx.layoutFns.push(refreshPresentLocal);

  function setPose(b, mode) {
    if (b.mode === mode) return;
    b.mode = mode;
    if (mode === 'home') {
      b.tgt.pos.copy(b.home); b.tgt.rotY = b.homeRotY || 0; b.tgt.rotZ = b.homeRotZ || 0; b.tgt.scale = 1;
    } else if (mode === 'present') {
      // out of the case, into the open, square to the room and a touch off-axis so the
      // spine catches light and you can still tell it is an object
      b.tgt.pos.set(presentLocal.x, presentLocal.y - (b.dims.H * PRESENT.scale) / 2, presentLocal.z);
      b.tgt.rotY = -Math.PI / 2 + 0.14;
      b.tgt.rotZ = -0.035;
      b.tgt.scale = PRESENT.scale;
      b.sweep = 0;
    } else if (mode === 'lean') {
      b.tgt.pos.copy(b.home); b.tgt.rotZ = (b.homeRotZ || 0) + b.leanDir * (b.leanAmt ?? 0.05);
      b.tgt.pos.x += b.leanDir * 0.012; b.tgt.rotY = b.homeRotY || 0; b.tgt.scale = 1;
    }
  }

  function hoverBook(b) {
    if (hovered === b) return;
    if (hovered) releaseHover();
    hovered = b;
    setPose(b, 'present');
    if (ctx.sound) ctx.sound.cue('bookOut');
    b.group.renderOrder = 20;
    showSpotTarget = 110;
    ctx.presentTarget = 1;
    document.body.classList.add('presenting');
    // rack focus onto the copy; the chain glides there on its own
    if (ctx.post) ctx.post.focus = camera.getWorldPosition(new THREE.Vector3())
      .distanceTo(new THREE.Vector3(PRESENT.x, PRESENT.y, PRESENT.z));

    // the copies either side of the gap lean into it — the shelf reacts to being emptied
    const row = rows[Math.round(b.home.y * 100)];
    const i = row.indexOf(b);
    for (const [n, dir] of [[row[i - 1], -1], [row[i + 1], 1]]) {
      if (!n) continue;
      n.leanDir = dir;
      n.leanAmt = Math.min(0.06, Math.max(0.02, (b.dims.T * 0.9) / n.dims.H));
      setPose(n, 'lean');
    }
    showPeek(b);
    setInteractive(true);
  }

  function releaseHover() {
    if (!hovered) return;
    const row = rows[Math.round(hovered.home.y * 100)];
    for (const n of row) setPose(n, 'home');
    hovered.group.renderOrder = 0;
    hovered = null;
    showSpotTarget = 0;
    ctx.presentTarget = 0;
    document.body.classList.remove('presenting');
    if (ctx.post) ctx.post.focus = null;   // back to the case
    hidePeek();
  }

  const PEEK = { w: 2.05, h: 0.54, px: 1024 };
  const peekCanvas = document.createElement('canvas');
  peekCanvas.width = PEEK.px; peekCanvas.height = Math.round(PEEK.px * PEEK.h / PEEK.w);
  const peekTex = new THREE.CanvasTexture(peekCanvas);
  peekTex.colorSpace = THREE.SRGBColorSpace;
  peekTex.anisotropy = 8;
  const peekMat = new THREE.MeshBasicMaterial({
    map: peekTex, transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
  });
  const peekMesh = new THREE.Mesh(new THREE.PlaneGeometry(PEEK.w, PEEK.h), peekMat);
  // upstage of the copy and a little below it: the copy stands in front of its own label
  // Below the copy and just behind it: far enough back that the copy occludes it when they
  // overlap, near enough forward that the reading table does not cut across it. At
  // z - 0.42 the table stood in front of the card and sliced the line in half.
  // Low enough that the held copy does not cut across the line. Behind it in z, so on the
  // occasions they do overlap the copy still wins, which is the whole point of moving this
  // into the room; but not so far back that the reading table crosses it.
  peekMesh.position.set(PRESENT.x, PRESENT.y - 0.86, PRESENT.z - 0.10);
  peekMesh.visible = false;
  peekMesh.userData.noAO = true;      // a floating card must not print occlusion on the room
  scene.add(peekMesh);

  function drawPeek(entry) {
    const c = peekCanvas, x = c.getContext('2d');
    const W = c.width, Hh = c.height;
    x.clearRect(0, 0, W, Hh);
    // the same paper card the rail plates are cut from, so it belongs to the object language
    x.fillStyle = 'rgba(20,6,4,0.62)';
    x.fillRect(0, Hh * 0.06, W, Hh * 0.88);
    x.fillStyle = 'rgba(232,199,122,0.55)';
    x.fillRect(W * 0.30, Hh * 0.075, W * 0.40, 2);
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = '#E8C77A';
    x.font = `600 ${Math.round(Hh * 0.30)}px "Noto Serif Display", Georgia, serif`;
    x.fillText(`${entry.prop} \u00b7 ${entry.ed}`, W / 2, Hh * 0.36);
    if (entry.inside) {
      x.fillStyle = 'rgba(248,240,216,0.72)';
      x.font = `400 ${Math.round(Hh * 0.17)}px "Crimson Pro", Georgia, serif`;
      x.fillText(entry.inside, W / 2, Hh * 0.66);
    }
    peekTex.needsUpdate = true;
  }

  let peekOpacityTgt = 0;
  function showPeek(b) {
    drawPeek(b.entry);
    peekMesh.visible = true;
    peekOpacityTgt = 1;
  }
  function hidePeek() { peekOpacityTgt = 0; }
  ctx.updaters.push((dt) => {
    if (!peekMesh.visible && peekOpacityTgt === 0) return;
    // the same timing the DOM caption faded on
    peekMat.opacity += (peekOpacityTgt - peekMat.opacity) * Math.min(1, dt * 6.5);
    if (peekOpacityTgt === 0 && peekMat.opacity < 0.01) {
      peekMat.opacity = 0; peekMesh.visible = false;
    }
  });

  const _bb = new THREE.Box3();
  const _c8 = Array.from({ length: 8 }, () => new THREE.Vector3());
  function screenRectOf(b) {
    if (!b || !b.group) return null;
    _bb.setFromObject(b.group);
    if (!isFinite(_bb.min.x) || _bb.isEmpty()) return null;
    const r = canvas.getBoundingClientRect();
    let i = 0;
    for (const x of [_bb.min.x, _bb.max.x]) {
      for (const y of [_bb.min.y, _bb.max.y]) {
        for (const z of [_bb.min.z, _bb.max.z]) _c8[i++].set(x, y, z).project(camera);
      }
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const v of _c8) {
      const px = r.left + (v.x * 0.5 + 0.5) * r.width;
      const py = r.top + (-v.y * 0.5 + 0.5) * r.height;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
    if (!isFinite(x0) || x1 <= x0 || y1 <= y0) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function openCopy(b) {
    if (!ctx.reader) return false;
    const rect = screenRectOf(b);
    return !!ctx.reader.open(b.entry, rect ? { fromScreen: rect } : undefined);
  }

  /* ---------------- raycast ---------------- */
  // slot proxies first: a static target in the case, so sweeping the row is stable and
  // the presented copy in the open is a second, equally valid target for the same book.
  function targets() {
    const t = ctx.slotProxies ? ctx.slotProxies.slice() : [];
    if (hovered) t.push(hovered.proxy);
    if (ctx.searchTab) t.push(ctx.searchTab);
    return t;
  }
  function toNDC(cx, cy) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    return ndc;
  }

  function pick(cx, cy) {
    toNDC(cx, cy);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(targets(), false)[0];
    if (!hit) return null;
    if (hit.object.userData.link) return { link: hit.object.userData.link };
    return hit.object.userData.book || null;
  }

  const follow = {
    tgt: new THREE.Vector3(0.2, 1.9, -1.6),
    cur: new THREE.Vector3(0.2, 1.9, -1.6),
    angle: 0.26, angleTgt: 0.26,
    lvl: 0, lvlTgt: 0,
    kind: null,
  };
  const followPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 1.7); // a working plane mid-room
  const followHit = new THREE.Vector3();
  const lensPoint = new THREE.Vector3();
  // the wordmark sits on the back wall, not on the follow plane, so the lens needs its own
  const wallPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 2.24);
  const wallHit = new THREE.Vector3();

  function aimFollowAt(clientX, clientY) {
    toNDC(clientX, clientY);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(followPlane, followHit)) return;
    follow.tgt.set(
      THREE.MathUtils.clamp(followHit.x, -5.6, 5.9),
      THREE.MathUtils.clamp(followHit.y, 0.05, 4.35),
      followHit.z
    );
    // the world point under the glass, for the lens on the wordmark
    lensPoint.copy(followHit);
  }

  function setFollowKind(kind) {
    follow.kind = kind;
    // wide and soft over the name, tight and brighter over a tag. Levels are low because
    // the spot rides close to the wall: at 190 it was washing the whole set, not the target.
    if (kind === 'wordmark')      { follow.angleTgt = 0.46; follow.lvlTgt = 155; }
    else if (kind === 'column')   { follow.angleTgt = 0.15; follow.lvlTgt = 150; }
    else if (kind === 'book')     { follow.angleTgt = 0.18; follow.lvlTgt = 105; }
    else if (kind === 'frame')    { follow.angleTgt = 0.20; follow.lvlTgt = 120; }
    else                          { follow.angleTgt = 0.30; follow.lvlTgt = Q.reduced ? 38 : 54; }
  }
  setFollowKind(null);

  let lensOn = false;
  function aimLensAt(clientX, clientY) {
    if (!ctx.wordmarkLens) return;
    if (!lensOn) { ctx.wordmarkLens.set(null); return; }
    toNDC(clientX, clientY);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(wallPlane, wallHit)) return;
    // radius chosen so the swell reads about as wide as the drawn glass does on screen
    ctx.wordmarkLens.set(wallHit, 0.62, 0.085);
  }

  // the HUD tells us when the pointer is over the name or over one of the tag columns
  const wireHud = () => {
    if (!ctx.hud || !ctx.hud.onFocusChange) return false;
    ctx.hud.onFocusChange((e) => {
      const kind = e && e.kind ? e.kind : (hovered ? 'book' : null);
      setFollowKind(kind);
      lensOn = kind === 'wordmark';
      if (!lensOn && ctx.wordmarkLens) ctx.wordmarkLens.set(null);
    });
    return true;
  };
  if (!wireHud()) {
    const iv = setInterval(() => { if (wireHud()) clearInterval(iv); }, 300);
    setTimeout(() => clearInterval(iv), 20000);
  }

  /* ---------------- pointer: hover + click (fine pointers) ---------------- */
  if (!Q.coarse) {
    let raf = 0, lastX = 0, lastY = 0;
    canvas.addEventListener('pointermove', (e) => {
      lastX = e.clientX; lastY = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (ctx.state.phase !== 'open') return;
        aimFollowAt(lastX, lastY);
        aimLensAt(lastX, lastY);   // and the swell under the glass, if it is on the name
        const b = pick(lastX, lastY);
        setInteractive(!!b);
        if (b && b.link) { releaseHover(); return; }
        if (b) { hoverBook(b); if (!follow.kind || follow.kind === 'book') setFollowKind('book'); }
        else { releaseHover(); if (follow.kind === 'book') setFollowKind(null); }
      });
    });
    canvas.addEventListener('pointerleave', () => { releaseHover(); setInteractive(false); setFollowKind(null); });
    canvas.addEventListener('click', (e) => {
      if (ctx.state.phase !== 'open') return;
      const b = pick(e.clientX, e.clientY);
      if (!b) return;
      if (b.link) { location.href = b.link; return; }
      // open the copy in the room; the archive is only the fallback
      if (openCopy(b)) return;
      location.href = 'archive.html';
    });
  }

  /* ---------------- touch: tap presents, second tap opens ---------------- */
  if (Q.coarse) {
    canvas.addEventListener('click', (e) => {
      if (ctx.state.phase !== 'open') return;
      const b = pick(e.clientX, e.clientY);
      if (b && b.link) { location.href = b.link; return; }
      if (b && hovered === b) {
        if (openCopy(b)) return;
        location.href = 'archive.html'; return;
      }
      if (b) hoverBook(b); else releaseHover();
    });
  }

  /* ---------------- keyboard: books are reachable without a mouse ---------------- */
  let focusIdx = -1;
  const reachable = () => (ctx.slotProxies || []).map(p => p.userData.book);
  addEventListener('keydown', (e) => {
    if (ctx.state.phase !== 'open') return;
    const list = reachable();
    if (e.key === 'Tab' && !e.target.closest('.t3hud')) {
      e.preventDefault();
      focusIdx = (focusIdx + (e.shiftKey ? -1 : 1) + list.length + 1) % (list.length + 1);
      if (focusIdx === list.length) { releaseHover(); focusIdx = -1; return; }
      hoverBook(list[focusIdx]);
    } else if (e.key === 'Enter' && hovered) {
      if (!openCopy(hovered)) location.href = 'archive.html';
    } else if (e.key === 'Escape') {
      releaseHover(); focusIdx = -1;
    }
  });

  /* ---------------- parallax: damped, a few degrees maximum ---------------- */
  const par = { x: 0, y: 0, tx: 0, ty: 0 };
  if (!Q.reduced) {
    if (!Q.coarse) {
      addEventListener('pointermove', (e) => {
        par.tx = (e.clientX / innerWidth - 0.5) * 2;
        par.ty = (e.clientY / innerHeight - 0.5) * 2;
      });
    }
    addEventListener('deviceorientation', (e) => {
      if (e.gamma == null) return;
      par.tx = THREE.MathUtils.clamp(e.gamma / 24, -1, 1);
      par.ty = THREE.MathUtils.clamp((e.beta - 48) / 32, -1, 1);
    });
  }

  /* ---------------- the frame update ---------------- */
  ctx.updaters.push((dt) => {
    // parallax — rotate the rig, never the scene
    par.x += (par.tx - par.x) * Math.min(1, dt * 3.2);
    par.y += (par.ty - par.y) * Math.min(1, dt * 3.2);
    rig.rotation.y = -par.x * 0.030;                     // ≈ 1.7° max
    rig.rotation.x = -par.y * 0.016;
    rig.position.x = par.x * 0.13;
    rig.position.y = -par.y * 0.055;

    // the follow spot lags the cursor, and eases rather than tracks
    if (ctx.followSpot && ctx.state.phase === 'open') {
      const k = 1 - Math.exp(-dt * 2.6);
      follow.cur.lerp(follow.tgt, k);
      const ka = 1 - Math.exp(-dt * 3.4);
      follow.angle += (follow.angleTgt - follow.angle) * ka;
      follow.lvl += (follow.lvlTgt - follow.lvl) * ka;
      const s = ctx.followSpot;
      s.angle = follow.angle;
      s.intensity = follow.lvl;
      s.target.position.set(follow.cur.x, follow.cur.y, follow.cur.z);
      // keep the source close to the target so the cone stays a pool, not a flood
      s.position.set(follow.cur.x * 0.7, follow.cur.y + 1.7, follow.cur.z + 2.2);
    }

    // the presentation pool comes up with the copy, and the rest of the stage gives way
    showSpot.intensity += (showSpotTarget - showSpot.intensity) * Math.min(1, dt * 5.5);
    ctx.presenting += ((ctx.presentTarget || 0) - ctx.presenting) * Math.min(1, dt * 4.5);

    // book poses — critically-damped chase, reads as mass
    const k = 1 - Math.exp(-dt * 8.0);
    for (const b of ctx.books) {
      b.cur.pos.lerp(b.tgt.pos, k);
      b.cur.rotY += (b.tgt.rotY - b.cur.rotY) * k;
      b.cur.rotZ += (b.tgt.rotZ - b.cur.rotZ) * k;
      b.cur.scale += (b.tgt.scale - b.cur.scale) * k;
      b.group.position.copy(b.cur.pos);
      b.group.rotation.set(0, b.cur.rotY, b.cur.rotZ);
      b.group.scale.setScalar(b.cur.scale);
      // the contact shadow belongs to the shelf, not to a copy in mid-air
      if (b.contact) b.contact.material.opacity = 0.55 * Math.max(0, 1 - (b.cur.scale - 1) * 2.2);

      // glare sweep across the cover while it comes out
      if (b.sweep >= 0) {
        b.sweep += dt / 0.7;
        const s = b.sweep;
        if (s >= 1) { b.sweep = -1; b.glareMesh.material.opacity = 0; }
        else {
          b.glareMesh.material.opacity = Math.sin(Math.PI * s) * 0.7;
          b.glareMesh.position.z = -b.dims.W / 2 + b.dims.W * s;
        }
      }
    }
  });
}
