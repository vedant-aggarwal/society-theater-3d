/* ============================================================
   theater3d-marquee.js — the marquee's slide preview.

   Hover or focus a card and the post it stands for is pulled up
   out of the band and held to the light: its real pages, advancing
   on their own, with a rail you can scrub, a pause, and the link
   that opens the post where it was actually published.

   There is no video anywhere in this project and none is invented.
   The advancing pages ARE the preview, and they are the post.

   Loading, in the order it matters:
     1. nothing, until the band enters the viewport
     2. then page one of every card, quietly, so the first hover is
        instant rather than a spinner
     3. the rest of a post's pages only once that post is opened
   ============================================================ */

const ADVANCE_MS = 1900;
const OPEN_DELAY = 90;      // enough that sweeping the pointer across the band is not a slideshow
const CLOSE_DELAY = 220;    // enough to move the pointer from the card up into the panel

const band = document.querySelector('.band');
if (band) init(band);

function init(band) {
  const cards = [...band.querySelectorAll('.band__card')];
  if (!cards.length) return;

  const pv = buildPanel();
  document.body.appendChild(pv.root);

  const cache = new Map();   // src -> Promise<void>, so nothing is fetched twice
  let openCard = null;
  let openTimer = 0;
  let closeTimer = 0;
  let tickTimer = 0;
  let paused = false;
  let pages = [];
  let at = 0;

  /* ---- 1. the band is not worth a byte until it is on screen ---- */
  const io = new IntersectionObserver((entries, obs) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    obs.disconnect();
    // page one of each post, so the first hover has something to show at once
    const seen = new Set();
    for (const c of cards) {
      const first = (c.dataset.pages || '').split('|')[0];
      if (first && !seen.has(first)) { seen.add(first); load(first); }
    }
  }, { rootMargin: '300px' });
  io.observe(band);

  function load(src) {
    if (cache.has(src)) return cache.get(src);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = img.onerror = () => resolve();
      img.src = src;
    });
    cache.set(src, p);
    return p;
  }

  /* ---- 2. opening ---- */
  function open(card) {
    if (openCard === card) return;
    close(true);
    openCard = card;
    card.setAttribute('aria-expanded', 'true');
    band.classList.add('is-held');

    pages = (card.dataset.pages || '').split('|').filter(Boolean);
    at = 0;
    paused = false;

    pv.kind.textContent = card.dataset.kind || '';
    pv.title.textContent = card.dataset.title || '';
    pv.date.textContent = card.dataset.date || '';
    pv.line.textContent = card.dataset.line || '';
    pv.out.href = card.dataset.url || '#';

    const total = Number(card.dataset.count) || pages.length;
    const more = Number(card.dataset.more) || 0;
    pv.count.textContent = more > 0
      ? `1 / ${pages.length} of ${total}`
      : `1 / ${total}`;

    pv.root.classList.remove('is-ready');
    pv.setPages(pages);
    place(card);
    pv.root.classList.add('is-open');

    // page one first, then the rest of this post in the background
    load(pages[0]).then(() => {
      if (openCard !== card) return;
      pv.root.classList.add('is-ready');
      show(0);
      pages.slice(1).forEach(load);
      schedule();
    });
  }

  function close(immediate) {
    clearTimeout(tickTimer);
    if (!openCard) return;
    openCard.setAttribute('aria-expanded', 'false');
    openCard = null;
    pv.root.classList.remove('is-open');
    band.classList.remove('is-held');
    if (immediate) pv.root.classList.remove('is-ready');
  }

  function place(card) {
    const c = card.getBoundingClientRect();
    const w = pv.root.offsetWidth || 300;
    const h = pv.root.offsetHeight || 460;
    const cardMid = c.left + c.width / 2;

    const left = Math.min(Math.max(cardMid - w / 2, 12), window.innerWidth - w - 12);
    pv.root.style.left = `${left}px`;
    pv.stem.style.left = `${cardMid - left}px`;

    // The slide wants to sit above the band, held up to the light. When the
    // band is near the top of the window there is no room up there, and a
    // panel half off the screen is worse than one that flipped. So it flips.
    const below = (c.top - 14) < h;
    pv.root.classList.toggle('is-below', below);
    if (below) {
      pv.root.style.bottom = 'auto';
      pv.root.style.top = `${c.bottom + 14}px`;
    } else {
      pv.root.style.top = 'auto';
      pv.root.style.bottom = `${window.innerHeight - c.top + 14}px`;
    }
  }

  /* ---- 3. the pages, advancing ---- */
  function show(i) {
    at = (i + pages.length) % pages.length;
    pv.imgs.forEach((im, n) => im.classList.toggle('is-on', n === at));
    pv.segs.forEach((s, n) => s.classList.toggle('is-on', n === at));
    const total = Number(openCard?.dataset.count) || pages.length;
    const more = Number(openCard?.dataset.more) || 0;
    pv.count.textContent = more > 0
      ? `${at + 1} / ${pages.length} of ${total}`
      : `${at + 1} / ${total}`;
  }

  function schedule() {
    clearTimeout(tickTimer);
    if (paused || pages.length < 2) return;
    tickTimer = setTimeout(() => { show(at + 1); schedule(); }, ADVANCE_MS);
  }

  function step(d) { paused = true; setPaused(); show(at + d); }

  function setPaused() {
    pv.play.textContent = paused ? '▶' : '‖';
    pv.play.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    schedule();
  }

  /* ---- 4. wiring ---- */
  for (const card of cards) {
    card.setAttribute('aria-expanded', 'false');
    card.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'touch') return;
      clearTimeout(closeTimer);
      clearTimeout(openTimer);
      openTimer = setTimeout(() => open(card), OPEN_DELAY);
    });
    card.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch') return;
      clearTimeout(openTimer);
      closeTimer = setTimeout(() => close(), CLOSE_DELAY);
    });
    card.addEventListener('focus', () => { clearTimeout(closeTimer); open(card); });
    card.addEventListener('click', (e) => {
      e.preventDefault();
      if (openCard === card) { close(); return; }
      open(card);
    });
  }

  pv.root.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  pv.root.addEventListener('pointerleave', () => { closeTimer = setTimeout(() => close(), CLOSE_DELAY); });

  pv.onSeek = (i) => { paused = true; setPaused(); show(i); };
  pv.prev.addEventListener('click', () => step(-1));
  pv.next.addEventListener('click', () => step(1));
  pv.play.addEventListener('click', () => { paused = !paused; setPaused(); });

  band.addEventListener('focusout', (e) => {
    if (!band.contains(e.relatedTarget)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (!openCard) return;
    if (e.key === 'Escape') { close(); openCard?.focus?.(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
  });
  // a card can drift out from under an open panel if the page moves
  window.addEventListener('resize', () => { if (openCard) place(openCard); }, { passive: true });
  document.addEventListener('scroll', () => { if (openCard) place(openCard); }, { passive: true });
}

function buildPanel() {
  const root = document.createElement('div');
  root.className = 'slidepv';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Post preview');
  root.innerHTML = `
    <div class="slidepv__stage">
      <p class="slidepv__wait">opening</p>
    </div>
    <div class="slidepv__rail"></div>
    <div class="slidepv__body">
      <p class="slidepv__kind"></p>
      <p class="slidepv__title"></p>
      <p class="slidepv__date"></p>
      <p class="slidepv__line"></p>
      <div class="slidepv__foot">
        <span class="slidepv__keys">
          <button class="slidepv__key" type="button" aria-label="Previous page">&#8249;</button>
          <button class="slidepv__key" type="button" aria-label="Pause">&#8214;</button>
          <button class="slidepv__key" type="button" aria-label="Next page">&#8250;</button>
          <span class="slidepv__count"></span>
        </span>
        <a class="slidepv__out" href="#" target="_blank" rel="noopener">Open the post</a>
      </div>
    </div>
    <span class="slidepv__stem"></span>`;

  const stage = root.querySelector('.slidepv__stage');
  const rail = root.querySelector('.slidepv__rail');
  const keys = root.querySelectorAll('.slidepv__key');

  const pv = {
    root, stage, rail,
    stem: root.querySelector('.slidepv__stem'),
    kind: root.querySelector('.slidepv__kind'),
    title: root.querySelector('.slidepv__title'),
    date: root.querySelector('.slidepv__date'),
    line: root.querySelector('.slidepv__line'),
    count: root.querySelector('.slidepv__count'),
    out: root.querySelector('.slidepv__out'),
    prev: keys[0], play: keys[1], next: keys[2],
    imgs: [], segs: [],
    setPages(srcs) {
      stage.querySelectorAll('.slidepv__page').forEach((n) => n.remove());
      rail.textContent = '';
      pv.imgs = srcs.map((src) => {
        const im = document.createElement('img');
        im.className = 'slidepv__page';
        im.alt = '';
        im.decoding = 'async';
        im.src = src;
        stage.appendChild(im);
        return im;
      });
      pv.segs = srcs.map((_, i) => {
        const s = document.createElement('button');
        s.className = 'slidepv__seg';
        s.type = 'button';
        s.setAttribute('aria-label', `Page ${i + 1}`);
        // the panel does not own the page index; it asks the band to move it,
        // so scrubbing the rail and the arrow keys cannot disagree
        s.addEventListener('click', () => pv.onSeek && pv.onSeek(i));
        rail.appendChild(s);
        return s;
      });
    },
  };
  return pv;
}
