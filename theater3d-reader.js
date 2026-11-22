// theater3d-reader.js — the edition reader. The missing half of the metaphor:


export function initReader(ctx) {
  ctx = ctx || {};
  if (ctx.reader) return ctx.reader;

  const Q = ctx.Q || {};
  const reduced = ('reduced' in Q) ? !!Q.reduced
    : matchMedia('(prefers-reduced-motion: reduce)').matches;
  const coarse = ('coarse' in Q) ? !!Q.coarse
    : (matchMedia('(hover: none)').matches || matchMedia('(pointer: coarse)').matches);

  const EASE = 'cubic-bezier(.2,.85,.3,1)';
  const TURN_MS = 420;        // one leaf, turned with mass
  const RAISE_MS = 460;       // the pick-up
  const LOWER_MS = 340;       // laying it back down
  const INDEX_URL = 'assets/editions/index.json';
  const HASH_RE = /^#read\/([A-Za-z0-9_-]+)(?:\/(\d+))?$/;

  // Titles for absent editions reached by bare id (deep link). A ROWS entry, when
  // one was clicked, overrides these with its own plate.
  const ABSENT_TITLES = {
    mb2: { prop: 'BULLETIN', ed: 'SAMPLE TWO', sub: 'Sample edition 2' },
    mb3: { prop: 'BULLETIN', ed: 'SAMPLE THREE', sub: 'Sample edition 3' },
    mk2: { prop: 'CASEBOOK', ed: 'SECOND EDITION', sub: 'Sample edition 2' },
  };

  /* ------------------------------ data ------------------------------ */
  // index.json is fetched once, eagerly, so a click almost never waits on it.
  // Failure is remembered: open() then returns false and the click handler can
  // fall back to the archive page instead.

  let data = null;
  let dataState = 'pending';           // pending -> ready | failed
  const dataPromise = fetch(INDEX_URL)
    .then((r) => { if (!r.ok) throw new Error('index.json ' + r.status); return r.json(); })
    .then((j) => {
      if (!j || typeof j !== 'object' || !j.editions) throw new Error('index.json malformed');
      data = j; dataState = 'ready'; return true;
    })
    .catch((e) => {
      dataState = 'failed';
      console.warn('[reader] editions index unavailable; open() will decline', e);
      return false;
    });

  /* ------------------------------ DOM ------------------------------ */

  function el(tag, cls, parent) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  const root = el('div', 't3reader' + (reduced ? ' is-reduced' : ''));
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Edition reader');
  root.tabIndex = -1;

  const house = el('div', 't3r-house', root);      // the darkened room; click = put it back
  const pool = el('div', 't3r-pool', root);        // the lamp pool on the table

  // top plate: what you are holding, and the way out
  const plate = el('header', 't3r-plate', root);
  const titleBox = el('div', 't3r-title', plate);
  const titleMain = el('span', 't3r-title-main', titleBox);
  const titleSub = el('span', 't3r-title-sub', titleBox);
  const closeBtn = el('button', 't3r-close', plate);
  closeBtn.type = 'button';
  closeBtn.textContent = 'CLOSE';
  closeBtn.setAttribute('aria-label', 'Close the reader and put the copy back');

  // the object: boards, shadow, leaves, click zones
  const copyWrap = el('div', 't3r-copywrap', root);
  const shadow = el('div', 't3r-shadow', copyWrap);
  const copy = el('figure', 't3r-copy', copyWrap);

  const stage = el('div', 't3r-stage', copy);
  const book = el('div', 't3r-book', stage);

  function mkHalf(side) {
    const h = el('div', 't3r-half t3r-half-' + side, book);
    const img = el('img', 't3r-page', h);
    img.alt = ''; img.draggable = false;
    el('div', 't3r-gutter', h);
    return { el: h, img, page: 0 };
  }
  const halfL = mkHalf('l');
  const halfR = mkHalf('r');

  // the leaf: one sheet, two faces, hinged on the spine
  const flip = el('div', 't3r-flip', book);
  function mkFace(back) {
    const f = el('div', 't3r-face' + (back ? ' t3r-face-b' : ''), flip);
    const img = el('img', 't3r-page', f);
    img.alt = ''; img.draggable = false;
    el('div', 't3r-shade', f);
    el('div', 't3r-lit', f);
    return { el: f, img, page: 0 };
  }
  const faceF = mkFace(false);   // the page being left behind
  const faceB = mkFace(true);    // the new left page, arriving

  const cast = el('div', 't3r-cast', book);   // the shadow the leaf throws below itself

  const edgeL = el('div', 't3r-edge t3r-edge-l', book);   // leaves already read
  const edgeR = el('div', 't3r-edge t3r-edge-r', book);   // leaves still to come
  const veil = el('div', 't3r-copyveil', copy);           // dark until the lamp reaches it

  const zonePrev = el('button', 't3r-zone t3r-zone-prev', copy);
  zonePrev.type = 'button';
  zonePrev.setAttribute('aria-label', 'Previous page');
  const zoneNext = el('button', 't3r-zone t3r-zone-next', copy);
  zoneNext.type = 'button';
  zoneNext.setAttribute('aria-label', 'Next page');

  // the absent-edition panel: bound boards, the reason, the way on
  const absentBox = el('div', 't3r-absent', copyWrap);
  const absentKick = el('p', 't3r-absent-kick', absentBox);
  absentKick.textContent = 'NOT IN THE ARCHIVE';
  const absentTitle = el('p', 't3r-absent-title', absentBox);
  const absentSub = el('p', 't3r-absent-sub', absentBox);
  el('div', 't3r-absent-rule', absentBox);
  const absentWhy = el('p', 't3r-absent-why', absentBox);
  const absentGo = el('a', 't3r-absent-go', absentBox);
  absentGo.href = 'archive.html';
  absentGo.textContent = 'CONSULT THE ARCHIVE';

  // foot: position and the turn controls
  const foot = el('footer', 't3r-foot', root);
  const btnPrev = el('button', 't3r-btn t3r-btn-prev', foot);
  btnPrev.type = 'button';
  btnPrev.setAttribute('aria-label', 'Previous page');
  btnPrev.innerHTML = '&#8592;';
  const pos = el('span', 't3r-pos', foot);
  const btnNext = el('button', 't3r-btn t3r-btn-next', foot);
  btnNext.type = 'button';
  btnNext.setAttribute('aria-label', 'Next page');
  btnNext.innerHTML = '&#8594;';
  const hint = el('p', 't3r-hint', root);
  hint.textContent = coarse ? 'Swipe to turn · tap outside to put it back'
    : 'Arrow keys turn the pages · Esc puts it back';

  const live = el('p', 'sr-only', root);
  live.setAttribute('aria-live', 'polite');

  document.body.appendChild(root);

  /* ------------------------------ state ------------------------------ */

  const st = {
    open: false,
    id: null,
    rec: null,            // the edition record out of index.json
    count: 0,
    page: 1,
    absent: false,
    entry: null,          // the ROWS entry, when the shelf handed us one
    spread: 0,            // 0 = the cover alone on the right, then 1 = pages 2 and 3
    drag: null,           // the live drag, while a leaf is held under the pointer
    openedViaPush: false, // whether close() should history.back()
    turning: 0,           // timeout id of the turn in flight
    prevFocus: null,
    prevOverflow: '',
    closeToken: 0,
  };
  const cache = new Map();      // 'id/page' -> { img, loaded }
  const onOpenCbs = [];
  const onCloseCbs = [];

  const fire = (list, arg) => {
    for (const cb of list) { try { cb(arg); } catch (e) { /* a bad listener must not break the reader */ } }
  };

  /* ------------------------------ preloading ------------------------------ */
  // Neighbouring leaves are warmed so a turn is never a flash; the run is never
  // loaded up front. Anything not yet decoded shows as a paper leaf, not white.

  function pageRec(rec, id, i) {
    const key = id + '/' + i;
    let r = cache.get(key);
    if (r) return r;
    const img = new Image();
    r = { img, loaded: false };
    img.onload = () => { r.loaded = true; };
    img.src = rec.pages[i - 1].src;
    cache.set(key, r);
    return r;
  }

  function preloadAround(n, dir) {
    if (!st.rec) return;
    const want = [n, n + (dir || 1), n - (dir || 1), n + 2 * (dir || 1)];
    for (const i of want) {
      if (i >= 1 && i <= st.count) pageRec(st.rec, st.id, i);
    }
  }

  /* ---------------- pages, spreads and the leaf ----------------
     A magazine opens as a cover alone on the right, then settles into spreads. Spread s
     shows page 2s on the left and 2s+1 on the right, so s=0 is page 1 by itself. That is
     why the block slides half a page sideways on the first turn and never again. */
  const leftOf = (sp) => (sp <= 0 ? 0 : sp * 2);
  const rightOf = (sp) => sp * 2 + 1;
  const lastSpread = () => Math.floor(Math.max(0, st.count - 1) / 2);
  const spreadOfPage = (n) => (n <= 1 ? 0 : Math.floor(n / 2));

  function paint(slot, n) {
    if (slot.page === n) return;
    slot.page = n;
    slot.el.classList.toggle('is-void', !(n >= 1 && n <= st.count));
    if (!(n >= 1 && n <= st.count)) { slot.img.removeAttribute('src'); return; }
    const r = pageRec(st.rec, st.id, n);
    slot.img.classList.remove('is-in');
    slot.img.onload = () => slot.img.classList.add('is-in');
    slot.img.src = r.img.src;
    slot.img.alt = plainTitle() + ', page ' + n + ' of ' + st.count;
    if (r.loaded) slot.img.classList.add('is-in');
  }
  // a face has no slot semantics, but it does need the same decode handling
  function paintFace(face, n) {
    face.page = -1;
    paint(face, n);
  }

  function showSpread(sp) {
    st.spread = sp;
    paint(halfL, leftOf(sp));
    paint(halfR, rightOf(sp));
    // half a page right while only the cover shows, dead centre once it is open
    const k = sp <= 0 ? -0.5 : (rightOf(sp) > st.count ? 0.5 : 0);
    root.style.setProperty('--shiftk', String(k));
    st.page = leftOf(sp) || 1;
  }

  /* The leaf's angle, and everything that hangs off it. Driven identically by the
     animation and by a finger, which is the only way the two can feel like one thing. */
  function setLeafAngle(deg) {
    const a = Math.max(-180, Math.min(0, deg));
    flip.style.transform = 'translateZ(2px) rotateY(' + a.toFixed(2) + 'deg)';
    const rad = a * Math.PI / 180;
    // darkest edge on, flat again on either side: |sin| is exactly that curve
    const edgeOn = Math.abs(Math.sin(rad));
    root.style.setProperty('--t3f-d', (0.10 + edgeOn * 0.62).toFixed(3));
    root.style.setProperty('--t3f-lit', (Math.max(0, Math.sin(rad * 2)) * 0.5).toFixed(3));
    // the cast shadow is anchored at the spine and stretched by the cosine, so it
    // shortens to nothing as the sheet stands up and lays out again on the far side
    const c = Math.cos(rad);
    cast.style.transform = 'translateZ(1px) scaleX(' + c.toFixed(3) + ')';
    cast.style.opacity = (Math.abs(c) * 0.5).toFixed(3);
    return a;
  }

  function armLeaf(dir, fromSpread) {
    /* Forward: the sheet whose front is the right page we are leaving and whose back is
       the left page arriving. Backward: the same sheet, met from the other side. */
    if (dir > 0) {
      paintFace(faceF, rightOf(fromSpread));
      paintFace(faceB, leftOf(fromSpread + 1));
      paint(halfR, rightOf(fromSpread + 1));   // revealed as the leaf lifts
      paint(halfL, leftOf(fromSpread));
    } else {
      paintFace(faceF, rightOf(fromSpread - 1));
      paintFace(faceB, leftOf(fromSpread));
      paint(halfL, leftOf(fromSpread - 1));    // revealed as the leaf lifts off the left
      paint(halfR, rightOf(fromSpread));
    }
    flip.classList.add('is-live');
    flip.style.transition = 'none';
    setLeafAngle(dir > 0 ? 0 : -180);
    void flip.offsetWidth;
  }

  function landLeaf(sp) {
    flip.classList.remove('is-live');
    flip.style.transition = 'none';
    showSpread(sp);
    setLeafAngle(0);
    root.style.setProperty('--t3f-d', '0');
    root.style.setProperty('--t3f-lit', '0');
    cast.style.opacity = '0';
    refreshChrome();
    writeHash(false);
    preloadAround(st.page, 1);
    fit();
  }

  /* ------------------------------ titles / chrome ------------------------------ */

  function titleParts() {
    if (st.rec) {
      return {
        prop: String(st.rec.property || '').toUpperCase(),
        ed: String(st.rec.edition || '').toUpperCase(),
        sub: st.rec.date || '',
      };
    }
    if (st.entry && st.entry.prop) {
      return { prop: st.entry.prop, ed: st.entry.ed || '', sub: st.entry.sub || '' };
    }
    return ABSENT_TITLES[st.id] || { prop: 'THIS EDITION', ed: '', sub: '' };
  }
  function plainTitle() {
    const t = titleParts();
    return (t.prop + (t.ed ? ' ' + t.ed : '')).trim();
  }

  function refreshChrome() {
    const t = titleParts();
    titleMain.textContent = t.prop + (t.ed ? ' · ' + t.ed : '');
    titleSub.textContent = t.sub || '';
    root.setAttribute('aria-label', plainTitle() + (st.absent ? '' : ', reader'));
    if (st.absent) {
      pos.textContent = '';
      btnPrev.disabled = true;
      btnNext.disabled = true;
      return;
    }
    // a spread is two pages, and the readout should say so rather than pick one
    const l = leftOf(st.spread), r = Math.min(st.count, rightOf(st.spread));
    pos.textContent = (l ? l + '\u2013' + r : String(r)) + ' / ' + st.count;
    btnPrev.disabled = st.spread <= 0;
    btnNext.disabled = st.spread >= lastSpread();
    zonePrev.style.display = st.spread <= 0 ? 'none' : '';
    zoneNext.style.display = st.spread >= lastSpread() ? 'none' : '';
    /* the fore-edges are the leaves still bound on either side, so they actually shift as
       you move through the book: thick on the side with more to go, thin on the side
       already turned. Written as vars, since the stylesheet owns where they sit. */
    root.style.setProperty('--edl', Math.min(18, Math.max(0, l - 1) * 1.4).toFixed(1) + 'px');
    root.style.setProperty('--edr', Math.min(18, Math.max(0, st.count - r) * 1.4).toFixed(1) + 'px');
  }

  /* ------------------------------ sizing ------------------------------ */
  // The leaf is fitted to the room, driven by the page's real w/h from index.json,
  // so mv2's two aspect ratios are each honoured leaf by leaf.

  function fit() {
    if (!st.open || st.absent || !st.rec) return;
    const pg = st.rec.pages[Math.max(0, st.page - 1)] || st.rec.pages[0];
    const a = (pg && pg.w && pg.h) ? pg.w / pg.h : 0.707;
    // two pages side by side now, so the width budget is halved before the aspect is applied
    const availW = Math.min(innerWidth - (coarse ? 24 : 120), 1180);
    const availH = innerHeight - 176;                 // plate above, foot below
    let pw = Math.min(availW / 2, availH * a);
    pw = Math.max(120, pw);
    const ph = pw / a;
    root.style.setProperty('--pw', pw.toFixed(1) + 'px');
    root.style.setProperty('--ph', ph.toFixed(1) + 'px');
    copy.style.width = (pw * 2).toFixed(1) + 'px';
    copy.style.height = ph.toFixed(1) + 'px';
  }
  addEventListener('resize', fit);
  /* ------------------------------ the hash ------------------------------ */

  function hashFor() {
    return '#read/' + st.id + (st.absent ? '' : '/' + st.page);
  }
  function writeHash(push) {
    const url = location.pathname + location.search + hashFor();
    try {
      if (push) { history.pushState(null, '', url); st.openedViaPush = true; }
      else history.replaceState(null, '', url);
    } catch (e) { /* file:// in some browsers; the reader still works, just not deep-linked */ }
  }
  function stripHash() {
    if (!HASH_RE.test(location.hash)) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* see above */ }
  }

  addEventListener('hashchange', () => {
    const m = location.hash.match(HASH_RE);
    if (!m) { if (st.open) domClose(); return; }
    const id = m[1], page = m[2] ? parseInt(m[2], 10) : 1;
    if (st.open && st.id === id) {
      if (!st.absent && page !== st.page) goTo(page, page > st.page ? 1 : -1);
      return;
    }
    tryOpen(id, { page, viaHash: true, entry: null });
  });

  /* ------------------------------ turning ------------------------------ */
  /* One sheet, hinged on the spine, rotating through vertical. The front face is the page
     being left behind and the back face is the page arriving, mirrored by the stylesheet so
     it reads the right way round once the leaf has gone over. Nothing fades. The same
     setLeafAngle drives the animation and the drag, so a page released mid turn continues
     exactly as it was being held. */

  function settleTurn() {
    if (!st.turning) return;
    clearTimeout(st.turning);
    st.turning = 0;
    landLeaf(st.spreadPending != null ? st.spreadPending : st.spread);
    st.spreadPending = null;
  }

  function runTurn(fromSp, toSp, dir, done) {
    armLeaf(dir, fromSp);
    st.spreadPending = toSp;
    const to = dir > 0 ? -180 : 0;
    // rAF so the armed angle is committed before the transition is attached
    requestAnimationFrame(() => {
      flip.style.transition = 'transform ' + TURN_MS + 'ms ' + EASE;
      setLeafAngle(to);
      // the shading and the cast shadow are stepped alongside, since they are not
      // transitionable in one declaration and a linear approximation reads wrong
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / TURN_MS);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;   // the same ease
        const cur = dir > 0 ? -180 * e : -180 * (1 - e);
        const keep = flip.style.transform;
        setLeafAngle(cur);
        flip.style.transform = keep;    // the transition owns the leaf; we only shade it
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    st.turning = setTimeout(() => {
      st.turning = 0;
      st.spreadPending = null;
      landLeaf(toSp);
      if (done) done();
    }, TURN_MS + 40);
  }

  function goToSpread(sp, dir, announceIt) {
    if (!st.open || st.absent || !st.rec) return;
    const max = lastSpread();
    sp = Math.max(0, Math.min(max, sp));
    if (sp === st.spread) { nudge(dir); return; }
    dir = dir || (sp > st.spread ? 1 : -1);
    settleTurn();
    const from = st.spread;
    // a turn moves exactly one sheet; a jump lands without one
    if (reduced || Math.abs(sp - from) !== 1) {
      landLeaf(sp);
    } else {
      runTurn(from, sp, dir);
      st.spread = sp;
      st.page = leftOf(sp) || 1;
      refreshChrome();
      writeHash(false);
      preloadAround(st.page, dir);
    }
    if (announceIt !== false) {
      live.textContent = st.count
        ? 'Pages ' + (leftOf(sp) || 1) + ' to ' + Math.min(st.count, rightOf(sp)) + ' of ' + st.count
        : '';
    }
  }

  // kept for the hash route and for anything that still thinks in single pages
  function goTo(n, dir, announceIt) {
    goToSpread(spreadOfPage(Math.max(1, Math.min(st.count, n))), dir, announceIt);
  }

  function laneWidth() {
    const r = stage.getBoundingClientRect();
    return Math.max(1, r.width / 2);
  }

  function beginDrag(e, dir) {
    if (reduced || st.absent || !st.rec || st.turning) return;
    const to = st.spread + dir;
    if (to < 0 || to > lastSpread()) return;
    settleTurn();
    armLeaf(dir, st.spread);
    st.drag = { id: e.pointerId, x0: e.clientX, dir, to, angle: dir > 0 ? 0 : -180, moved: false };
    root.classList.add('is-dragging');
    try { copy.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
  }

  function moveDrag(e) {
    const d = st.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    if (Math.abs(dx) > 3) d.moved = true;
    // forward drags left, backward drags right; either way progress is 0 to 1 across a lane
    const prog = Math.max(0, Math.min(1, (d.dir > 0 ? -dx : dx) / laneWidth()));
    d.prog = prog;
    d.angle = d.dir > 0 ? -180 * prog : -180 * (1 - prog);
    flip.style.transition = 'none';
    setLeafAngle(d.angle);
  }

  function endDrag(e) {
    const d = st.drag;
    if (!d || (e && e.pointerId !== d.id)) return;
    st.drag = null;
    root.classList.remove('is-dragging');
    try { if (e) copy.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }
    const committed = (d.prog || 0) >= 0.5;
    const target = committed ? (d.dir > 0 ? -180 : 0) : (d.dir > 0 ? 0 : -180);
    const landing = committed ? d.to : st.spread;
    const span = Math.abs(target - d.angle);
    const ms = Math.max(120, Math.round(TURN_MS * (span / 180)));
    flip.style.transition = 'transform ' + ms + 'ms ' + EASE;
    setLeafAngle(target);
    st.turning = setTimeout(() => {
      st.turning = 0;
      landLeaf(landing);
      if (committed) {
        if (ctx.sound) ctx.sound.cue('pageTurn');
      }
    }, ms + 30);
    if (committed) {
      st.spread = landing;
      st.page = leftOf(landing) || 1;
      refreshChrome();
      writeHash(false);
      preloadAround(st.page, d.dir);
    }
  }

  if (!coarse) {
    copy.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || st.absent || reduced) return;
      const r = stage.getBoundingClientRect();
      const dir = (e.clientX - r.left) > r.width / 2 ? 1 : -1;
      beginDrag(e, dir);
    });
    copy.addEventListener('pointermove', moveDrag);
    copy.addEventListener('pointerup', endDrag);
    copy.addEventListener('pointercancel', endDrag);
    // a drag that actually moved must not also fire the click zone underneath it
    copy.addEventListener('click', (e) => {
      if (st.dragJustEnded) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  // asking for a page past either cover: the block refuses, with a little mass
  function nudge(dir) {
    if (reduced || !dir) return;
    stage.classList.remove('is-nudge-l', 'is-nudge-r');
    void stage.offsetWidth;
    stage.classList.add(dir > 0 ? 'is-nudge-r' : 'is-nudge-l');
    setTimeout(() => stage.classList.remove('is-nudge-l', 'is-nudge-r'), 300);
  }

  const next = () => goToSpread(st.spread + 1, 1);
  const prev = () => goToSpread(st.spread - 1, -1);
  /* ------------------------------ open / close ------------------------------ */

  function flyFrom(rect) {
    if (!rect || reduced) return;
    const r = copy.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const sx = Math.max(0.04, rect.w / r.width);
    const sy = Math.max(0.04, rect.h / r.height);
    const dx = (rect.x + rect.w / 2) - (r.left + r.width / 2);
    const dy = (rect.y + rect.h / 2) - (r.top + r.height / 2);
    root.classList.add('is-flying');
    copy.style.transition = 'none';
    copy.style.transformOrigin = '50% 50%';
    copy.style.transform =
      'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
    void copy.offsetWidth;
    copy.style.transition = 'transform ' + RAISE_MS + 'ms ' + EASE;
    copy.style.transform = 'none';
    setTimeout(() => {
      root.classList.remove('is-flying');
      copy.style.transition = '';
      copy.style.transform = '';
    }, RAISE_MS + 40);
  }

  function flyBack(rect, done) {
    if (!rect || reduced) { done(); return; }
    const r = copy.getBoundingClientRect();
    if (!r.width || !r.height) { done(); return; }
    const sx = Math.max(0.04, rect.w / r.width);
    const sy = Math.max(0.04, rect.h / r.height);
    const dx = (rect.x + rect.w / 2) - (r.left + r.width / 2);
    const dy = (rect.y + rect.h / 2) - (r.top + r.height / 2);
    root.classList.add('is-flying');
    copy.style.transformOrigin = '50% 50%';
    copy.style.transition = 'transform ' + LOWER_MS + 'ms ' + EASE;
    copy.style.transform =
      'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px) scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
    setTimeout(() => {
      root.classList.remove('is-flying');
      copy.style.transition = 'none';
      copy.style.transform = '';
      done();
    }, LOWER_MS + 30);
  }

  function doOpen(id, opts) {
    opts = opts || {};
    const absent = !data.editions[id];
    const rec = data.editions[id] || null;

    if (st.open && st.id === id && !absent) {
      goTo(Math.max(1, Math.min(rec.count || rec.pages.length, opts.page || 1)));
      return;
    }

    settleTurn();
    st.id = id;
    st.rec = rec;
    st.absent = absent;
    st.entry = opts.entry || null;
    st.count = rec ? (rec.count || rec.pages.length) : 0;
    st.page = rec ? Math.max(1, Math.min(st.count, opts.page || 1)) : 1;

    root.classList.toggle('is-absent', absent);
    copy.style.display = absent ? 'none' : '';
    absentBox.style.display = absent ? '' : 'none';
    shadow.style.display = '';

    if (absent) {
      const t = titleParts();
      absentTitle.textContent = t.prop;
      absentSub.textContent = [t.ed, t.sub].filter(Boolean).join(' · ');
      absentWhy.textContent = (data.absent && data.absent[id]) || 'This edition is not in the archive.';
    } else {
      flip.classList.remove('is-live');
      // -1, not 0: 0 is a legitimate "no page here" value, so resetting to it made
      // paint() short-circuit and the empty left slot never got marked void
      halfL.page = halfR.page = faceF.page = faceB.page = -1;
      showSpread(spreadOfPage(st.page));
      setLeafAngle(0);
      preloadAround(st.page, 1);
    }
    refreshChrome();

    const firstOpen = !st.open;
    st.open = true;

    if (firstOpen) {
      st.prevFocus = document.activeElement;
      st.prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      document.body.classList.add('t3r-open');
      root.hidden = false;
      st.closeToken++;

      // the pick-up: lamp first, then the copy comes up off the table
      root.classList.remove('is-lit', 'is-raised');
      st.fromRect = (opts && opts.fromScreen && typeof opts.fromScreen.w === 'number')
        ? opts.fromScreen : null;
      if (reduced) {
        root.classList.add('is-lit', 'is-raised');
      } else {
        void root.offsetWidth;
        root.classList.add('is-lit');
        setTimeout(() => {
          if (!st.open) return;
          root.classList.add('is-raised');
          // fit() has already run synchronously at the end of doOpen, so the copy has its
          // real size here and there is nothing to wait a frame for. Deliberately not
          // wrapped in requestAnimationFrame: rAF does not fire in a background tab, and
          // the flight would then be skipped entirely rather than merely deferred.
          if (st.fromRect) flyFrom(st.fromRect);
        }, 150);
      }

      root.addEventListener('keydown', onKey);
      document.addEventListener('focusin', keepFocus);
      fire(onOpenCbs, { id: st.id, absent: st.absent });
    }

    fit();
    if (opts.viaHash) writeHash(false);
    else writeHash(true);
    root.focus({ preventScroll: true });
    live.textContent = absent
      ? plainTitle() + '. ' + absentWhy.textContent
      : plainTitle() + '. Page ' + st.page + ' of ' + st.count + '.';
  }

  // resolve an id against the loaded (or still loading) index
  function tryOpen(id, opts) {
    if (!id) return false;
    if (dataState === 'failed') return false;
    if (dataState === 'ready') {
      if (!data.editions[id] && !(data.absent && data.absent[id])) return false;
      doOpen(id, opts);
      return true;
    }
    // index still in flight (a click this early is rare; a deep link is not)
    dataPromise.then((ok) => {
      if (!ok) return;
      if (data.editions[id] || (data.absent && data.absent[id])) doOpen(id, opts);
    });
    return true;
  }

  function domClose() {
    if (!st.open) return;
    st.open = false;
    st.openedViaPush = false;
    settleTurn();
    fire(onCloseCbs, { id: st.id });
    root.removeEventListener('keydown', onKey);
    document.removeEventListener('focusin', keepFocus);

    const token = ++st.closeToken;
    const finish = () => {
      if (token !== st.closeToken) return;
      root.hidden = true;
      root.classList.remove('is-lit', 'is-raised');
      document.documentElement.style.overflow = st.prevOverflow;
      document.body.classList.remove('t3r-open');
      if (st.prevFocus && st.prevFocus.focus) {
        try { st.prevFocus.focus({ preventScroll: true }); } catch (e) { /* focus target may be gone */ }
      }
      st.prevFocus = null;
    };
    if (reduced) { finish(); return; }
    // laid back down, then the lamp goes out
    if (st.fromRect) {
      // back to the shelf, front side on, and only then is the room let go
      const rect = st.fromRect;
      st.fromRect = null;
      flyBack(rect, () => {
        if (token !== st.closeToken) return;
        root.classList.remove('is-raised', 'is-lit');
        setTimeout(finish, 220);
      });
      return;
    }
    root.classList.remove('is-raised');
    setTimeout(() => { if (token === st.closeToken) root.classList.remove('is-lit'); }, LOWER_MS);
    setTimeout(finish, LOWER_MS + 300);
  }

  function userClose() {
    if (!st.open) return;
    if (st.openedViaPush && HASH_RE.test(location.hash)) {
      // Back both closes the reader and repairs the history the open() created.
      // The hashchange handler does the actual closing; the timer is the net
      // under a history stack something else has meddled with.
      const token = st.closeToken;
      history.back();
      setTimeout(() => { if (st.open && token === st.closeToken) { stripHash(); domClose(); } }, 260);
    } else {
      stripHash();
      domClose();
    }
  }

  /* ------------------------------ keyboard ------------------------------ */
  // Listening on the root (bubble phase), then stopping propagation: native
  // button activation still happens, but the scene's own window-level Tab/Enter
  // handlers in theater3d-interact.js never see keys meant for the reader.

  function focusables() {
    const all = root.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])');
    const out = [];
    for (const n of all) {
      if (n.disabled || n.offsetParent === null) continue;
      out.push(n);
    }
    return out;
  }

  function onKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); userClose(); return; }
    if (!st.absent) {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); next(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); prev(); return; }
      if (e.key === 'Home') { e.preventDefault(); goTo(1, -1); return; }
      if (e.key === 'End') { e.preventDefault(); goTo(st.count, 1); return; }
    }
    if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      const first = f[0], lastEl = f[f.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || cur === root)) { e.preventDefault(); lastEl.focus(); }
      else if (!e.shiftKey && cur === lastEl) { e.preventDefault(); first.focus(); }
    }
  }

  function keepFocus(e) {
    if (!st.open || root.contains(e.target)) return;
    root.focus({ preventScroll: true });
  }

  /* ------------------------------ pointer ------------------------------ */

  closeBtn.addEventListener('click', userClose);
  root.addEventListener('click', (e) => {
    if (e.target === root || e.target === house || e.target === pool) userClose();
  });

  let dragSuppressClick = false;
  zonePrev.addEventListener('click', () => { if (!dragSuppressClick) prev(); });
  zoneNext.addEventListener('click', () => { if (!dragSuppressClick) next(); });
  btnPrev.addEventListener('click', prev);
  btnNext.addEventListener('click', next);

  /* Touch swipe. Fine pointers are handled by the drag block up in the turning section,
     which takes hold of the leaf itself; this is the same gesture for a finger, and it must
     be gated, not merely coexist. Unguarded, both blocks answered one pointerup on a mouse:
     mine sprang the leaf back and this one then read the same travel as a flick and turned
     the page anyway, so a deliberately short drag advanced two spreads. */
  if (coarse) {
    let down = null, dx = 0;
    copy.addEventListener('pointerdown', (e) => {
      if (st.absent || e.button > 0) return;
      down = { x: e.clientX, t: performance.now(), id: e.pointerId };
      dx = 0;
      try { copy.setPointerCapture(e.pointerId); } catch (err) { /* capture is best-effort */ }
    });
    copy.addEventListener('pointermove', (e) => {
      if (!down || e.pointerId !== down.id) return;
      dx = e.clientX - down.x;
      if (Math.abs(dx) > 6 && !reduced) {
        // a touch drag takes hold of the same leaf the pointer does, so the gesture is
        // one behaviour with two input devices rather than two different animations
        if (!st.drag && !st.turning) {
          const dir = dx < 0 ? 1 : -1;
          const to = st.spread + dir;
          if (to >= 0 && to <= lastSpread()) {
            armLeaf(dir, st.spread);
            st.drag = { id: e.pointerId, x0: down.x, dir, to, angle: dir > 0 ? 0 : -180 };
            root.classList.add('is-dragging');
          }
        }
        if (st.drag) moveDrag(e);
      }
    });
    const release = (e) => {
      if (!down || (e.pointerId !== undefined && e.pointerId !== down.id)) return;
      const dt = performance.now() - down.t;
      const fast = Math.abs(dx) > 24 && dt < 260;
      const far = Math.abs(dx) > 56;
      down = null;
      if (st.drag) {
        // a flick counts as committed even if it did not travel half the lane
        if (far || fast) st.drag.prog = Math.max(st.drag.prog || 0, 0.5);
        dragSuppressClick = true;
        setTimeout(() => { dragSuppressClick = false; }, 80);
        endDrag(e);
      } else if (far || fast) {
        dragSuppressClick = true;
        setTimeout(() => { dragSuppressClick = false; }, 80);
        if (dx < 0) next(); else prev();
      }
      dx = 0;
    };
    copy.addEventListener('pointerup', release);
    copy.addEventListener('pointercancel', release);
  }

  /* ------------------------------ deep-link restore ------------------------------ */

  {
    const m = location.hash.match(HASH_RE);
    if (m) {
      const id = m[1], page = m[2] ? parseInt(m[2], 10) : 1;
      dataPromise.then((ok) => {
        if (!ok || st.open) return;
        if (data.editions[id] || (data.absent && data.absent[id])) {
          doOpen(id, { page, viaHash: true });
        }
      });
    }
  }

  /* ------------------------------ published API ------------------------------ */

  ctx.reader = {
    open(entryOrId, opts) {
      try {
        const id = typeof entryOrId === 'string'
          ? entryOrId
          : (entryOrId && entryOrId.id) || null;
        const entry = (entryOrId && typeof entryOrId === 'object') ? entryOrId : null;
        return tryOpen(id, Object.assign({ entry }, opts || {}));
      } catch (e) {
        console.warn('[reader] open failed soft', e);
        return false;
      }
    },
    close() { userClose(); },
    isOpen() { return st.open; },
    onOpen(cb) { if (typeof cb === 'function') onOpenCbs.push(cb); },
    onClose(cb) { if (typeof cb === 'function') onCloseCbs.push(cb); },
  };
  return ctx.reader;
}
