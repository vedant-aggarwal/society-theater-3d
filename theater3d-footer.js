/* ============================================================
   theater3d-footer.js — copper, and the current in it.

   The canvas draws two things and only two things: the traces
   running from the chip out to every pad, and the charge moving
   along them. It draws nothing you can click. Every pad is a real
   anchor sitting above it in normal flow, which is why the whole
   board still tabs, middle clicks and reads correctly with this
   file deleted.

   THE ROUTING IS MEASURED, NOT WRITTEN DOWN. Pad positions come
   out of getBoundingClientRect after the browser has laid the grid
   out, so the traces follow whatever the layout did at whatever
   width, and the mobile reflow needs no separate wiring. Nothing
   here knows what the grid looks like.

   Traces are routed the way a board actually routes them: out of
   the chip on one axis, a 45 degree elbow, then in to the pad on
   the other. Right angles alone read as a flowchart; the mitre is
   most of what makes it read as copper.

   THE POINTER IS A CHARGE. Current near it accelerates and
   brightens, and the copper it passes over lights up. Pressing
   anywhere on the board fires a surge from the chip that runs
   every trace at once. That is the part worth playing with, and it
   costs one distance check per particle per frame.

   COST. One 2D canvas, roughly sixty particles, and the loop is
   gated on an IntersectionObserver so it does not run while the
   board is off screen, which it is for most of a very long page.
   Under reduced motion the file draws the copper once, static, and
   never starts a loop at all.
   ============================================================ */

const DPR_CAP = 2;
const PER_TRACE = 5;        // charges in flight on each trace
const SPEED = 0.00042;      // fraction of a trace per millisecond
const POINTER_R = 150;      // px, how far the pointer's field reaches
const SURGE_MS = 1100;

const field = document.querySelector('[data-board]');
if (field) init(field);

function init(field) {
  const canvas = field.querySelector('.board__wire');
  const chip = field.querySelector('[data-chip]');
  const pads = [...field.querySelectorAll('.board__pad')];
  if (!canvas || !chip || !pads.length) return;

  const ctx = canvas.getContext('2d', { alpha: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  let traces = [];
  let charges = [];
  let w = 0, h = 0;
  let pointer = null;
  let surgeAt = -Infinity;
  let running = false;
  let raf = 0;

  /* ---- routing ------------------------------------------------------ */

  function centre(el) {
    const f = field.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - f.left + r.width / 2, y: r.top - f.top + r.height / 2, r };
  }

  // out of the chip on one axis, a mitred elbow, then in to the pad
  function route(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const m = Math.min(Math.abs(dx), Math.abs(dy));
    const sx = Math.sign(dx) || 1;
    const sy = Math.sign(dy) || 1;
    const pts = [{ x: from.x, y: from.y }];
    if (Math.abs(dx) > Math.abs(dy)) {
      pts.push({ x: from.x + (Math.abs(dx) - m) * sx, y: from.y });
      pts.push({ x: to.x, y: to.y });
    } else {
      pts.push({ x: from.x, y: from.y + (Math.abs(dy) - m) * sy });
      pts.push({ x: to.x, y: to.y });
    }
    // length of each leg, so a charge can travel the path at even speed
    let total = 0;
    const legs = [];
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      legs.push(l);
      total += l;
    }
    return { pts, legs, total };
  }

  function at(trace, t) {
    let d = t * trace.total;
    for (let i = 0; i < trace.legs.length; i++) {
      if (d <= trace.legs[i] || i === trace.legs.length - 1) {
        const k = trace.legs[i] ? d / trace.legs[i] : 0;
        const a = trace.pts[i], b = trace.pts[i + 1];
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      }
      d -= trace.legs[i];
    }
    return trace.pts[trace.pts.length - 1];
  }

  function measure() {
    const f = field.getBoundingClientRect();
    w = Math.max(1, Math.round(f.width));
    h = Math.max(1, Math.round(f.height));
    const dpr = Math.min(DPR_CAP, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const c = centre(chip);
    traces = pads.map((pad) => {
      const p = centre(pad);
      // leave the chip from the edge nearest the pad, not from its middle
      const from = {
        x: c.x + Math.max(-1, Math.min(1, (p.x - c.x) / 140)) * (c.r.width / 2 - 6),
        y: c.y + Math.max(-1, Math.min(1, (p.y - c.y) / 90)) * (c.r.height / 2 - 4),
      };
      return { ...route(from, p), pad };
    });

    charges = [];
    traces.forEach((tr, i) => {
      for (let n = 0; n < PER_TRACE; n++) {
        charges.push({ tr: i, t: (n / PER_TRACE + i * 0.13) % 1, jitter: 0.6 + (n % 3) * 0.28 });
      }
    });
  }

  /* ---- drawing ------------------------------------------------------ */

  function copper(now) {
    for (const tr of traces) {
      const live = tr.pad.matches(':hover, :focus-visible');
      ctx.beginPath();
      ctx.moveTo(tr.pts[0].x, tr.pts[0].y);
      for (let i = 1; i < tr.pts.length; i++) ctx.lineTo(tr.pts[i].x, tr.pts[i].y);
      ctx.strokeStyle = live ? 'rgba(232,199,122,.55)' : 'rgba(185,151,91,.26)';
      ctx.lineWidth = live ? 2 : 1.5;
      ctx.stroke();

      // the pointer lights the copper it is over
      if (pointer) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(pointer.x, pointer.y, POINTER_R, 0, Math.PI * 2);
        ctx.clip();
        ctx.beginPath();
        ctx.moveTo(tr.pts[0].x, tr.pts[0].y);
        for (let i = 1; i < tr.pts.length; i++) ctx.lineTo(tr.pts[i].x, tr.pts[i].y);
        ctx.strokeStyle = 'rgba(232,199,122,.34)';
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function frame(now) {
    raf = 0;
    if (!running) return;
    ctx.clearRect(0, 0, w, h);
    copper(now);

    const surge = Math.max(0, 1 - (now - surgeAt) / SURGE_MS);

    for (const c of charges) {
      const tr = traces[c.tr];
      if (!tr) continue;
      const p = at(tr, c.t);

      let boost = 1;
      if (pointer) {
        const d = Math.hypot(p.x - pointer.x, p.y - pointer.y);
        if (d < POINTER_R) boost += (1 - d / POINTER_R) * 2.6;
      }
      const live = tr.pad.matches(':hover, :focus-visible');
      if (live) boost += 1.5;
      boost += surge * 5;

      c.t = (c.t + SPEED * 16.7 * c.jitter * boost) % 1;

      const bright = Math.min(1, (boost - 1) / 3 + .26);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.4 + bright * 1.9, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,228,166,${.3 + bright * .7})`;
      ctx.fill();

      if (bright > .5) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6 + bright * 7, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(232,199,122,${(bright - .5) * .16})`;
        ctx.fill();
      }
    }

    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduced.matches) return;
    running = true;
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
  }

  /* ---- static, for anyone who asked not to be moved at ---- */
  function still() {
    ctx.clearRect(0, 0, w, h);
    copper(0);
  }

  /* ---- wiring up ---------------------------------------------------- */

  measure();
  // Draw the copper ONCE straight away, whatever happens next. The loop only
  // starts when the observer says the board is on screen, and until then this
  // canvas would otherwise be blank: a board with no traces on it, which is
  // what a reader sees for the split second before the observer fires and for
  // as long as the tab stays hidden.
  still();

  new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) start(); else stop();
  }, { rootMargin: '160px' }).observe(field);

  addEventListener('resize', () => {
    measure();
    if (reduced.matches) still();
  }, { passive: true });

  field.addEventListener('pointermove', (e) => {
    const f = field.getBoundingClientRect();
    pointer = { x: e.clientX - f.left, y: e.clientY - f.top };
  }, { passive: true });
  field.addEventListener('pointerleave', () => { pointer = null; });

  // pressing the board fires a surge out of the chip along every trace
  field.addEventListener('pointerdown', () => { surgeAt = performance.now(); }, { passive: true });

  reduced.addEventListener?.('change', () => {
    if (reduced.matches) { stop(); still(); } else { start(); }
  });
}
