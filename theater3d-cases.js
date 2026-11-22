/* ============================================================
   theater3d-cases.js — section 3, the results board.

   Three jobs, all small:

   1. Build the flaps. Every character in the brand and result
      columns becomes its own split cell, and each one turns through
      a short run of glyphs before landing on the character it was
      given.

      THIS IS NOT A COUNT-UP, and the distinction is the whole
      reason it is allowed here. A count-up invents every
      intermediate number as though it were measuring something,
      which misrepresents what is being shown. A flap board is a
      mechanism landing on a value it was handed: the glyphs it
      passes through are characters, not quantities, and the value
      it lands on is quoted from the deck and will show its own
      source sentence. It runs ONCE, on first sight, and never
      again. Under reduced motion it is already landed.

   2. Selecting a row lights its lamp and opens that project below.

   3. "Read the five page deck" hands off to the existing edition
      reader through its own #read/<id> deep link, so a pasted link
      behaves exactly like a click and no reader code is touched.
   ============================================================ */

const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const STEP_MS = 42;        // one flap turning
const STAGGER_MS = 55;     // each cell starts after the one to its left
const TURNS = 6;           // how many glyphs a cell passes through before landing

const root = document.querySelector('.cases');
if (root) init(root);

function init(root) {
  const rows = [...root.querySelectorAll('.board__row')];
  const buttons = rows.map((r) => r.querySelector('.board__rowbtn'));
  const panels = [...root.querySelectorAll('.case')];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- 1. the flaps ---- */
  const cells = [...root.querySelectorAll('[data-flap]')];
  for (const cell of cells) build(cell);

  function build(cell) {
    const text = cell.dataset.flap || '';
    const line = document.createElement('span');
    line.className = 'flapline';
    // the accessible name is the finished string, not the letters mid-turn
    line.setAttribute('aria-label', text);
    for (const ch of text) {
      const f = document.createElement('span');
      f.className = 'flap' + (ch === ' ' ? ' flap--gap' : '');
      f.setAttribute('aria-hidden', 'true');
      f.dataset.target = ch;
      f.textContent = reduced || ch === ' ' ? ch : GLYPHS[0];
      line.appendChild(f);
    }
    cell.textContent = '';
    cell.appendChild(line);
  }

  function land(cell, index) {
    const flaps = [...cell.querySelectorAll('.flap')];
    flaps.forEach((f, i) => {
      const target = f.dataset.target;
      if (target === ' ') return;
      let n = 0;
      const start = index * 140 + i * STAGGER_MS;
      setTimeout(() => {
        f.classList.add('is-turning');
        const t = setInterval(() => {
          n += 1;
          if (n >= TURNS) {
            clearInterval(t);
            f.textContent = target;
            f.classList.remove('is-turning');
            return;
          }
          // characters passing the gate, not quantities being approximated
          f.textContent = GLYPHS[(Math.floor(n * 7 + i * 3)) % GLYPHS.length];
        }, STEP_MS);
      }, start);
    });
  }

  if (!reduced) {
    const io = new IntersectionObserver((entries, obs) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      obs.disconnect();                       // once, and never again
      cells.forEach((c, i) => land(c, Math.floor(i / 2)));
    }, { threshold: 0.35 });
    io.observe(root.querySelector('.board'));
  }

  /* ---- 2. the live row, and the loop of decks ----

     The carousel wraps: from the last project, the next one is the first, and it
     always turns the short way round. That is why the offset is computed modulo
     the count and then folded into the range [-half, +half] rather than simply
     subtracted, and why the transforms are written here instead of as one CSS
     rule per position: the loop stays correct whatever the deck count becomes. */

  const slides = [...root.querySelectorAll('.deckflow__slide')];
  const order = slides.map((s) => s.dataset.case);

  const SIDE_X = 47;        // percent of its own width a side deck steps aside
  const SIDE_Z = 190;       // pixels it steps back
  const SIDE_Y = 30;        // degrees it turns away
  const SIDE_S = 0.84;      // and how much smaller that leaves it

  function placeDecks(id) {
    const n = order.length;
    const at = Math.max(0, order.indexOf(id));
    slides.forEach((s, i) => {
      let o = ((i - at) % n + n) % n;          // 0 .. n-1
      if (o > n / 2) o -= n;                   // fold to the short way round
      const side = o !== 0;
      s.classList.toggle('is-side', side);
      s.style.zIndex = String(10 - Math.abs(o));
      s.style.opacity = Math.abs(o) > 1 ? '0' : (side ? '.85' : '1');
      s.style.transform =
        `translate(-50%, -50%)` +
        ` translateX(${o * SIDE_X}%)` +
        ` translateZ(${-Math.abs(o) * SIDE_Z}px)` +
        ` rotateY(${-o * SIDE_Y}deg)` +
        ` scale(${1 - Math.abs(o) * (1 - SIDE_S)})`;
      s.setAttribute('aria-hidden', Math.abs(o) > 1 ? 'true' : 'false');
      s.tabIndex = Math.abs(o) > 1 ? -1 : 0;
    });
  }

  let current = panels.find((p) => p.classList.contains('is-on'))?.dataset.case || order[0];
  rows[0]?.classList.add('is-on');
  placeDecks(current);

  function show(id) {
    if (!id || id === current) return;
    current = id;
    for (const p of panels) p.classList.toggle('is-on', p.dataset.case === id);
    for (const r of rows) {
      const on = r.querySelector('.board__rowbtn').dataset.case === id;
      r.classList.toggle('is-on', on);
      r.querySelector('.board__rowbtn').setAttribute('aria-expanded', String(on));
    }
    placeDecks(id);
  }

  for (const s of slides) {
    s.addEventListener('click', () => show(s.dataset.case));
    s.addEventListener('focus', () => show(s.dataset.case));
  }

  for (const b of buttons) {
    b.setAttribute('aria-expanded', String(b.dataset.case === current));
    b.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      show(b.dataset.case);
    });
    b.addEventListener('focus', () => show(b.dataset.case));
    b.addEventListener('click', () => show(b.dataset.case));
  }

  /* ---- 3. the reader ---- */
  for (const open of root.querySelectorAll('.case__open')) {
    open.addEventListener('click', (e) => {
      const hash = open.getAttribute('href');
      if (!hash || !hash.startsWith('#read/')) return;
      // Only intercept when the hash is already set, where no hashchange fires
      // and the reader would otherwise not hear about the click.
      if (location.hash === hash) {
        e.preventDefault();
        location.hash = '';
        requestAnimationFrame(() => { location.hash = hash; });
      }
    });
  }
}
