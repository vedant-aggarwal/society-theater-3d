/* ============================================================
   theater3d-company.js — the roll runs, the stage stays.

   The stage is stuck to the screen and the roll moves past it.
   Whoever crosses the READING LINE is the one who is up. That is
   the whole mechanism, and it means the section needs no hovering
   and no tapping to work: it plays as you scroll, on a phone
   exactly as on a desktop.

   HOW THE LINE IS WATCHED. Not with a scroll listener driving
   requestAnimationFrame. That was the first version and it was
   wrong twice over: rAF does not run in a background tab, so the
   whole section froze on the first name and looked broken, and
   measuring every name on every frame is work to do on a
   thread that has a WebGL scene on it.

   Instead every name carries its own IntersectionObserver whose
   root margin collapses the viewport to a thin band at 42% height.
   A name entering that band IS the event. No scroll handler, no
   polling, no rAF, nothing running between crossings, and it
   behaves identically whether or not the tab has focus.

   The band sits at 42% rather than the middle because the eye
   reads above centre, and because the stage sits alongside: a name
   level with the middle of the screen has already gone past the
   portrait it belongs to.

   Between one credit and the next nobody is in the band and
   nothing fires, so whoever was up stays up. That is the correct
   behaviour, not a gap to paper over.
   ============================================================ */

const LINE = 42;          // percent of viewport height
const BAND = 1;           // percent tall, enough to catch a crossing

const root = document.querySelector('.company');
if (root) init(root);

function init(root) {
  const names = [...root.querySelectorAll('.co__name')];
  const frame = root.querySelector('.co__frame');
  const shot = root.querySelector('#co-shot');
  const nameEl = root.querySelector('#co-name');
  const roleEl = root.querySelector('#co-role');
  const noteEl = root.querySelector('#co-note');
  if (!names.length || !shot) return;

  let current = null;
  let held = null;          // a name being pointed at, which wins over the scroll
  let swapTimer = 0;

  function up(btn, immediate) {
    if (!btn || btn === current) return;
    current = btn;
    const { slug, name, role, note, noteurl } = btn.dataset;

    for (const b of names) b.classList.toggle('is-up', b === btn);

    const paint = () => {
      shot.src = `assets/people/${slug}.jpg`;
      nameEl.textContent = name;
      roleEl.textContent = role;
      if (note) {
        noteEl.hidden = false;
        noteEl.textContent = '';
        const a = document.createElement('a');
        a.href = noteurl;
        a.rel = 'noopener';
        a.textContent = note;
        noteEl.appendChild(a);
      } else {
        noteEl.hidden = true;
        noteEl.textContent = '';
      }
      frame.classList.remove('is-swapping');
    };

    if (immediate) { paint(); return; }
    frame.classList.add('is-swapping');
    clearTimeout(swapTimer);
    swapTimer = setTimeout(paint, 110);
  }

  /* ---- the reading line, as a band every name watches ---- */
  const band = new IntersectionObserver((entries) => {
    if (held) return;                       // a pointer is in charge right now
    // if several cross in one callback, the last one down the roll wins,
    // which is the one the reader has arrived at
    let pickBtn = null;
    for (const e of entries) if (e.isIntersecting) pickBtn = e.target;
    if (pickBtn) up(pickBtn);
  }, {
    rootMargin: `-${LINE}% 0px -${100 - LINE - BAND}% 0px`,
    threshold: 0,
  });
  for (const b of names) band.observe(b);

  /* ---- pointing overrides, letting go gives it back ---- */
  for (const b of names) {
    b.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      held = b;
      up(b);
    });
    b.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      if (held === b) held = null;
    });
    b.addEventListener('focus', () => { held = b; up(b); });
    b.addEventListener('blur', () => { if (held === b) held = null; });
    b.addEventListener('click', () => { held = null; up(b); });
  }

  /* ---- the faces are fetched before they are needed ---- */
  new IntersectionObserver((entries, obs) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    obs.disconnect();
    for (const b of names) {
      const img = new Image();
      img.decoding = 'async';
      img.src = `assets/people/${b.dataset.slug}.jpg`;
    }
  }, { rootMargin: '500px' }).observe(root);

  up(names[0], true);
}
