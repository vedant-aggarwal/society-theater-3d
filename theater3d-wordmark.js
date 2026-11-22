// theater3d-wordmark.js — the back-wall wordmark, set in the display face.

//
// An earlier version extruded the name in Droid Serif, the stock typeface that
// ships in the three.js examples folder, while the masthead everywhere else on the
// site is Noto Serif Display. This module extrudes the real letterforms.
//
// How: Noto Serif Display is a variable TTF (wght 100-900, wdth 62.5-100). We pinned
// the *named instance* "Condensed Bold" (wght=700, wdth=75) once with
// fontTools.varLib.instancer, converted the glyph outlines to a three.js typeface
// JSON (52 glyphs: A-Z, 0-9, space, basic punctuation — 25 KB), and ship that file at
// ./assets/fonts/noto-serif-display-condensed-bold.typeface.json. No runtime
// conversion, no extra CDN dependency, and the condensation is a genuine drawn
// condensed cut, not an X-squash of the normal width.
//
// LICENSE — Noto Serif Display:
//   Copyright 2012 Google Inc. / The Noto Project Authors.
//   SIL Open Font License, Version 1.1 — https://openfontlicense.org
//   Source: https://github.com/google/fonts/tree/main/ofl/notoserifdisplay
//   Full text: ./assets/fonts/OFL.txt (committed alongside the converted font).
//   The OFL permits conversion, embedding and redistribution of derived font data.
//
// If the Noto file cannot be fetched or parsed, the module falls back to the old
// Droid Serif CDN path (with the historical 0.80 X-squash baked into the geometry)
// so the page never loses its wordmark. `wordmarkSource()` and
// `geometry.userData.wordmarkSource` report which route was taken.

import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';

export const SOURCE_NOTO = 'noto-serif-display-condensed-bold';
export const SOURCE_DROID_FALLBACK = 'droid-serif-bold-fallback';

const NOTO_URL = new URL('./assets/fonts/noto-serif-display-condensed-bold.typeface.json', import.meta.url).href;
const DROID_URL = 'https://unpkg.com/three@0.169.0/examples/fonts/droid/droid_serif_bold.typeface.json';

let _source = null;          // set by the last successful buildWordmarkGeometry
let _fontCache = {};         // url -> Promise<Font>

/** Which letterforms the last built geometry actually used:
 *  SOURCE_NOTO | SOURCE_DROID_FALLBACK | null (nothing built yet). */
export function wordmarkSource() { return _source; }

function loadFont(url, manager) {
  if (!_fontCache[url]) {
    _fontCache[url] = new FontLoader(manager).loadAsync(url);
  }
  return _fontCache[url];
}

export async function buildWordmarkGeometry(text, opts = {}) {
  const {
    size = 0.46,
    depth = 0.15,
    curveSegments = 12,
    bevelThickness = 0.022,
    bevelSize = 0.010,
    bevelSegments = 4,
    manager,
  } = opts;

  let font = null;
  let source = SOURCE_NOTO;
  try {
    font = await loadFont(NOTO_URL, manager);
  } catch (err) {
    console.warn('[wordmark] Noto Serif Display typeface unavailable, falling back to Droid Serif:', err);
    source = SOURCE_DROID_FALLBACK;
    font = await loadFont(DROID_URL, manager);
  }

  const geo = new TextGeometry(text, {
    font, size, depth, curveSegments,
    bevelEnabled: true, bevelThickness, bevelSize, bevelSegments,
  });

  if (source === SOURCE_DROID_FALLBACK) {
    // The Droid path needs the historical condensation; bake it into the geometry so
    // the caller never has to know which route ran. (BufferGeometry.scale fixes the
    // normals via the normal matrix.) The Noto route needs none: wdth=75 is a real
    // drawn condensed instance.
    geo.scale(0.80, 1, 1);
  }

  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.translate(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, 0);
  geo.computeBoundingBox();

  geo.userData.wordmarkSource = source;
  geo.userData.condensed = source === SOURCE_NOTO ? 'baked' : 'x-squash';
  _source = source;
  return geo;
}

/** Local-unit extents of a built wordmark geometry: { width, height, depth }. */
export function wordmarkMetrics(geometry) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  return {
    width: bb.max.x - bb.min.x,
    height: bb.max.y - bb.min.y,
    depth: bb.max.z - bb.min.z,
  };
}
