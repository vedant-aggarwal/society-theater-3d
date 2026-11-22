// theater3d-hud.js -- theater hero: the HTML overlay (playbill HUD).

//
// One line (the tagline), then a
// rule-separated credits strip of what they actually do. Hovering a column
// opens a playbill card with a live, scaled-down iframe of the real
// destination page; the wheel over the card scrolls the framed page itself
// (same-origin, driven from the parent) so the whole preview can be read;
// clicking navigates there. Destinations that do not exist yet degrade to a
// quiet "IN REHEARSAL" veil, never a broken frame.
//
// Contract:
//   import { initHud } from './theater3d-hud.js';
//   initHud(ctx);                    // after this, ctx.hud is published:
//   ctx.hud = {
//     el,                            // the root overlay element
//     setAnchor(x, y),               // screen px; block hangs from this point.
//                                    //   landscape: top-LEFT of the block
//                                    //   portrait:  top-CENTRE of the block
//                                    // First external call permanently takes
//                                    // over from the internal fallback driver.
//     onFocusChange(cb),             // cb({ kind:'wordmark'|'column'|null, rect, key? })
//                                    //   returns an unsubscribe function
//     show(), hide(),                // reveal / conceal the whole overlay
//     closePreview(),                // convenience: close the card now
//   }
//
// Nothing is interactive before ctx.state.phase === 'open' (gated by the
// .is-open class set from ctx.onOpen). Until setAnchor is driven externally,
// an internal updater projects the 3D wordmark itself so the HUD is never
// stranded at (0,0).

const PAGES = [
  {
    key: 'campaigns', label: 'CAMPAIGNS', href: 'work.html', act: 'ACT I',
    trk: '.18em', pad: '18px',
    note: 'Sample campaigns for sample brands.',
    aria: 'Campaigns. Sample work for sample brands.',
  },
  {
    key: 'summit', label: 'SUMMIT', href: 'summit.html', act: 'ACT II',
    trk: '.24em', pad: '24px', flagship: true,
    note: 'A sample flagship competition.',
    aria: 'Summit. A sample flagship competition.',
  },
  {
    key: 'publishing', label: 'PUBLISHING', href: 'archive.html', act: 'ACT III',
    trk: '.18em', pad: '18px',
    note: 'The Bulletin, The Casebook and The Series, as samples.',
    aria: 'Publishing. The Bulletin, The Casebook and The Series.',
  },
  {
    key: 'case', label: 'THE CASE METHOD', href: 'learn.html', act: 'ACT IV',
    trk: '.15em', pad: '14px',
    note: 'Workshops and case-cracking sessions.',
    aria: 'The case method. Workshops and case-cracking sessions.',
  },
  {
    key: 'society', label: 'THE SOCIETY', href: 'society.html', act: 'ACT V',
    trk: '.15em', pad: '14px',
    note: 'The team, the handovers, the college.',
    aria: 'The society. Who we are.',
  },
];

const LINE = 'A sample student society, staged as a theater';
const FRAME_W = 1280;                 // desktop render size, scaled into the card
const HOVER_INTENT_MS = 120;          // sweeping the strip must not strobe
const RETARGET_MS = 60;               // switching columns while already open
const CLOSE_MS = 280;
const REPROBE_MS = 8000;              // a missing page is re-checked, not cached forever

function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}

export function initHud(ctx) {
  const Q = (ctx && ctx.Q) || {};
  const reduced = !!Q.reduced;
  const coarse = !!Q.coarse;
  const byKey = {};
  for (const p of PAGES) byKey[p.key] = p;

  /* ------------------------------ DOM ------------------------------ */

  const root = el('div', 't3hud' + (reduced ? ' t3hud-reduced' : ''));
  const block = el('div', 't3hud-block', root);

  const line = el('p', 't3hud-line', block);
  line.textContent = LINE;

  const nav = el('nav', 't3hud-credits', block);
  nav.setAttribute('aria-label', 'What we do');

  const colEls = {};
  let colIdx = 0, ruleIdx = 0;
  const buildRow = (pages) => {
    const row = el('div', 't3hud-row', nav);
    pages.forEach((p, i) => {
      if (i > 0) {
        const rule = el('span', 't3hud-rule', row);
        rule.setAttribute('aria-hidden', 'true');
        rule.style.setProperty('--i', ruleIdx++);
      }
      const a = el('a', 't3hud-col' + (p.flagship ? ' is-flagship' : ''), row);
      a.href = p.href;
      a.textContent = p.label;
      a.dataset.key = p.key;
      a.setAttribute('aria-label', p.aria);
      a.style.setProperty('--trk', p.trk);
      a.style.setProperty('--pad', p.pad);
      a.style.setProperty('--i', colIdx++);
      colEls[p.key] = a;
    });
  };
  buildRow(PAGES.slice(0, 3));   // in portrait these become two readable rows
  buildRow(PAGES.slice(3));

  // the playbill card
  const card = el('aside', 't3hud-card', root);
  card.setAttribute('aria-hidden', 'true');
  const head = el('header', 't3hud-card-head', card);
  const actEl = el('span', 't3hud-card-act', head);
  const nameEl = el('span', 't3hud-card-name', head);
  el('div', 't3hud-card-drule', card);
  const stageEl = el('div', 't3hud-card-stage', card);
  const veil = el('div', 't3hud-card-veil', stageEl);
  const veilTitle = el('span', 't3hud-veil-title', veil);
  const veilState = el('span', 't3hud-veil-state', veil);
  const veilSub = el('span', 't3hud-veil-sub', veil);
  const foot = el('div', 't3hud-card-foot', card);
  const noteEl = el('p', 't3hud-card-note', foot);
  // the honest affordance: the preview scrolls. Fine pointers only — on
  // touch the card is an arm-then-navigate control, not a scroll surface.
  if (!coarse) {
    const hint = el('span', 't3hud-card-hint', foot);
    hint.textContent = 'Scroll to read';
    hint.setAttribute('aria-hidden', 'true');
  }

  document.body.appendChild(root);

  /* ------------------------------ state ------------------------------ */

  const layers = {};        // key -> layer element holding that page's iframe
  const probes = {};        // key -> { ok, pending, at, promise }
  const focusCbs = [];
  let active = null;        // key of the page the card currently shows
  let armed = null;         // touch: first tap arms, second tap navigates
  let portraitNow = !!(ctx.state && ctx.state.portrait);
  let extDriven = false;    // has setAnchor been called from outside?
  let blockW = 0;
  let lastAx = -1e9, lastAy = -1e9;
  let lastFocusSig = '';
  let openTimer = 0, closeTimer = 0, parkTimer = 0, settleTimer = 0;

  const isInteractive = () => root.classList.contains('is-open');

  /* ------------------------------ focus events ------------------------------ */

  function emitFocus(kind, rect, key) {
    const sig = kind ? kind + ':' + (key || '') : '';
    if (sig === lastFocusSig) return;
    lastFocusSig = sig;
    for (const cb of focusCbs) {
      try { cb({ kind, rect: rect || null, key: key || null }); } catch (e) { /* a bad listener must not break the hud */ }
    }
  }

  /* ------------------------------ probing ------------------------------ */
  // A destination may not exist yet (pages are being built in parallel).
  // Probe before mounting an iframe so a 404 page is never shown; misses are
  // re-checked after REPROBE_MS instead of being cached forever.

  function probeUrl(href) {
    return fetch(href, { method: 'HEAD', cache: 'no-cache' })
      .then((r) => {
        if (r.ok) return true;
        if (r.status === 405 || r.status === 501) {
          // server without HEAD support; ask properly once
          return fetch(href, { method: 'GET', cache: 'no-cache' })
            .then((g) => g.ok).catch(() => false);
        }
        return false;
      })
      // fetch cannot probe file:// -- mount optimistically there, treat
      // network failure as "missing" everywhere else
      .catch(() => location.protocol === 'file:');
  }

  function probe(page) {
    const rec = probes[page.key];
    if (rec && (rec.pending || rec.ok || Date.now() - rec.at < REPROBE_MS)) return rec.promise;
    const r = { pending: true, ok: false, at: Date.now() };
    r.promise = probeUrl(page.href).then((ok) => {
      r.ok = ok; r.pending = false; r.at = Date.now();
      return ok;
    });
    probes[page.key] = r;
    return r.promise;
  }

  /* ------------------------------ card layers ------------------------------ */
  // One layer per destination, created lazily on first hover and kept warm.
  // Layers are never reparented (that would reload the iframe); inactive ones
  // are display:none, which also parks their rendering work.

  function ensureLayer(page) {
    let layer = layers[page.key];
    if (layer) return layer;
    layer = el('div', 't3hud-card-layer');
    layer.style.display = 'none';
    layer.dataset.state = 'empty';       // empty -> loading -> live
    stageEl.insertBefore(layer, veil);   // veil stays on top
    layers[page.key] = layer;
    return layer;
  }

  function mountFrame(page, layer) {
    if (layer.dataset.state !== 'empty') return;
    layer.dataset.state = 'loading';
    const f = document.createElement('iframe');
    f.className = 't3hud-frame';
    f.setAttribute('scrolling', 'no');
    f.setAttribute('tabindex', '-1');
    f.setAttribute('aria-hidden', 'true');
    f.setAttribute('loading', 'lazy');
    f.title = page.label + ' preview';
    f.addEventListener('load', () => {
      layer.dataset.state = 'live';
      if (active === page.key) setVeil(null);
    });
    f.src = page.href;
    layer.appendChild(f);
  }

  function setVeil(state, page) {
    if (!state) { veil.classList.add('is-lifted'); card.classList.add('is-live'); return; }
    card.classList.remove('is-live');
    veil.classList.remove('is-lifted');
    if (page) veilTitle.textContent = page.label;
    if (state === 'missing') {
      veilState.textContent = 'IN REHEARSAL';
      veilSub.textContent = 'this page is still being staged';
    } else {
      veilState.textContent = 'OPENING';
      veilSub.textContent = 'raising the curtain';
    }
  }

  /* ------------------------------ card open/close ------------------------------ */

  function positionCard(page) {
    const a = colEls[page.key];
    if (!a) return;
    const r = a.getBoundingClientRect();
    const nr = nav.getBoundingClientRect();
    card.style.setProperty('--t3-scale', (stageEl.clientWidth / FRAME_W).toFixed(4));
    const cW = card.offsetWidth, cH = card.offsetHeight;
    const cx = r.left + r.width / 2;
    const left = Math.min(Math.max(12, cx - cW / 2), Math.max(12, innerWidth - cW - 12));
    let top = nr.bottom + 16;
    let flip = false;
    if (top + cH > innerHeight - 10) {
      const above = nr.top - cH - 16;
      if (above > 10) { top = above; flip = true; }
      else top = Math.max(10, innerHeight - cH - 10);
    }
    card.style.left = left.toFixed(1) + 'px';
    card.style.top = top.toFixed(1) + 'px';
    card.style.transformOrigin = (cx - left).toFixed(1) + 'px ' + (flip ? '100%' : '0px');
    card.classList.toggle('is-flip', flip);
  }

  function openCard(page) {
    if (!isInteractive() || !page) return;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    clearTimeout(parkTimer);
    active = page.key;

    actEl.textContent = page.act;
    nameEl.textContent = page.label;
    noteEl.textContent = page.note;

    const layer = ensureLayer(page);
    for (const k in layers) layers[k].style.display = k === page.key ? 'block' : 'none';

    if (layer.dataset.state === 'live') setVeil(null);
    else setVeil('opening', page);

    probe(page).then((ok) => {
      if (active !== page.key) return;
      if (!ok) { setVeil('missing', page); return; }
      mountFrame(page, layer);
      if (layer.dataset.state === 'live') setVeil(null);
    });

    positionCard(page);
    card.classList.add('is-on');
  }

  function closeCard(immediate) {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    active = null;
    if (armed && colEls[armed]) colEls[armed].classList.remove('is-armed');
    armed = null;
    card.classList.remove('is-on');
    // once fully hidden, park every layer so warm iframes stop rendering
    clearTimeout(parkTimer);
    parkTimer = setTimeout(() => {
      if (card.classList.contains('is-on')) return;
      for (const k in layers) layers[k].style.display = 'none';
    }, immediate || reduced ? 0 : 480);
  }

  function scheduleOpen(page) {
    if (!isInteractive()) return;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    const delay = card.classList.contains('is-on') ? RETARGET_MS : HOVER_INTENT_MS;
    openTimer = setTimeout(() => openCard(page), delay);
  }

  function scheduleClose() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => closeCard(), CLOSE_MS);
  }

  /* ------------------------------ pointer (fine) ------------------------------ */

  if (!coarse) {
    block.addEventListener('pointerenter', () => {
      if (!isInteractive()) return;
      emitFocus('wordmark', block.getBoundingClientRect());
    });
    block.addEventListener('pointerleave', () => emitFocus(null));

    for (const p of PAGES) {
      const a = colEls[p.key];
      a.addEventListener('pointerenter', () => {
        if (!isInteractive()) return;
        emitFocus('column', a.getBoundingClientRect(), p.key);
        scheduleOpen(p);
      });
      a.addEventListener('pointerleave', () => {
        if (!isInteractive()) return;
        emitFocus('wordmark', block.getBoundingClientRect());
        scheduleClose();
      });
    }

    // the card sits below the strip; travelling onto it keeps it open
    card.addEventListener('pointerenter', () => clearTimeout(closeTimer));
    card.addEventListener('pointerleave', () => scheduleClose());

    // the wheel over the open card reads the preview, never the page behind
    // it. The iframe is same-origin, so the parent scrolls the framed
    // document directly (scrolling="no" maps to overflow:hidden, which
    // still scrolls programmatically and never shows a scrollbar in the
    // scaled render). Guard: if the document is not reachable, the wheel is
    // still swallowed so the hero does not scroll away under the card, but
    // nothing is touched. Listener lives on the card alone — the wheel is
    // stolen nowhere else on the page.
    card.addEventListener('wheel', (e) => {
      if (!card.classList.contains('is-on') || !active) return;
      e.preventDefault();
      clearTimeout(closeTimer);          // scrolling the preview keeps it open
      const layer = layers[active];
      const f = layer && layer.querySelector('iframe');
      let doc = null;
      try { doc = f && f.contentDocument; } catch (err) { doc = null; }
      const sc = doc && (doc.scrollingElement || doc.documentElement);
      if (!sc) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 16
        : e.deltaMode === 2 ? e.deltaY * 800
        : e.deltaY;
      sc.scrollTop += dy;
    }, { passive: false });
  }

  /* ------------------------------ touch ------------------------------ */
  // First tap on a column opens the preview; a second tap on the same
  // column follows the link. Tapping elsewhere closes and disarms.

  if (coarse) {
    for (const p of PAGES) {
      const a = colEls[p.key];
      a.addEventListener('click', (e) => {
        if (!isInteractive()) { e.preventDefault(); return; }
        if (armed === p.key && card.classList.contains('is-on')) return; // navigate
        e.preventDefault();
        if (armed && colEls[armed]) colEls[armed].classList.remove('is-armed');
        armed = p.key;
        a.classList.add('is-armed');
        openCard(p);
        emitFocus('column', a.getBoundingClientRect(), p.key);
      });
    }
    document.addEventListener('pointerdown', (e) => {
      if (root.contains(e.target)) return;
      if (card.classList.contains('is-on')) { closeCard(); emitFocus(null); }
    }, { passive: true });
  }

  /* ------------------------------ keyboard ------------------------------ */
  // The columns are real links: tab-reachable, focus opens the preview,
  // Enter navigates (native), Escape closes.

  nav.addEventListener('focusin', (e) => {
    const a = e.target.closest && e.target.closest('.t3hud-col');
    if (!a || !isInteractive()) return;
    const p = byKey[a.dataset.key];
    openCard(p);
    emitFocus('column', a.getBoundingClientRect(), p.key);
  });
  nav.addEventListener('focusout', (e) => {
    if (e.relatedTarget && nav.contains(e.relatedTarget)) return;
    scheduleClose();
    emitFocus(null);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && card.classList.contains('is-on')) closeCard();
  });

  /* ------------------------------ anchoring ------------------------------ */

  function applyAnchor(x, y) {
    if (!blockW) blockW = block.offsetWidth || 0;
    const ax = Math.min(Math.max(blockW / 2 + 8, x),
                        Math.max(blockW / 2 + 8, innerWidth - blockW / 2 - 8));
    const ay = Math.min(Math.max(8, y), innerHeight - 48);
    if (Math.abs(ax - lastAx) < 0.25 && Math.abs(ay - lastAy) < 0.25) return;
    lastAx = ax; lastAy = ay;
    const tf = 'translate3d(' + ax.toFixed(1) + 'px, ' + ay.toFixed(1) + 'px, 0) translateX(-50%)';
    block.style.transform = tf;
    block.style.setProperty('--t3-anchor', tf);
  }

  function setAnchor(x, y) {
    extDriven = true;
    applyAnchor(x, y);
  }

  // Fallback driver: until setAnchor is driven from outside, project the 3D
  // wordmark ourselves (same maths as the tagline) so the block always hangs
  // under the name. Disabled forever by the first external setAnchor call.
  if (ctx.updaters && ctx.THREE) {
    const v = new ctx.THREE.Vector3();
    ctx.updaters.push(() => {
      if (extDriven) return;
      const g = ctx.groups && ctx.groups.text;
      if (!g || !ctx.textWidth || !ctx.camera) return;
      v.setFromMatrixPosition(g.matrixWorld);
      v.y -= 0.55;
      if (!portraitNow) v.x -= (ctx.textWidth * (g.scale.x || 1)) / 2;
      v.project(ctx.camera);
      applyAnchor((v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight);
    });
  }

  /* ------------------------------ layout / lifecycle ------------------------------ */

  function onLayout(portrait) {
    portraitNow = !!portrait;
    root.classList.toggle('is-portrait', portraitNow);
    blockW = 0;               // re-measure on next anchor
    lastAx = -1e9; lastAy = -1e9;
    if (active) positionCard(byKey[active]);
  }
  if (ctx.layoutFns) ctx.layoutFns.push(onLayout);
  onLayout(portraitNow);

  function show() {
    root.classList.add('is-shown');
    blockW = 0;
    clearTimeout(settleTimer);
    // after the entrance choreography, drop the stagger delays so hover
    // states respond immediately
    settleTimer = setTimeout(() => root.classList.add('is-settled'), reduced ? 0 : 1600);
  }

  function hide() {
    root.classList.remove('is-shown');
    closeCard(true);
    emitFocus(null);
  }

  if (typeof ctx.onOpen === 'function') {
    ctx.onOpen(() => {
      root.classList.add('is-open');
      show();
    });
  } else {
    // no lifecycle available: be visible and interactive rather than dead
    root.classList.add('is-open');
    show();
  }

  /* ------------------------------ published API ------------------------------ */

  ctx.hud = {
    el: root,
    setAnchor,
    onFocusChange(cb) {
      if (typeof cb === 'function') focusCbs.push(cb);
      return () => {
        const i = focusCbs.indexOf(cb);
        if (i >= 0) focusCbs.splice(i, 1);
      };
    },
    show,
    hide,
    closePreview: () => closeCard(true),
  };
  return ctx.hud;
}
