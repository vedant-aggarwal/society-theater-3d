// theater3d-post.js — the grade. Everything between "lit objects in a box" and a room

// with air in it happens here: GTAO in the shelf corners, bloom held to the gilt,
// a shallow pull of focus onto the case, and a quiet animated grain over the lot.
//
// Contract with theater3d.js (wired by the orchestrator, not from here):
//   import { initPost } from './theater3d-post.js';
//   const post = initPost(ctx);                  // null => keep the plain render path
//   ...in the loop:  post ? post.render(dt, t) : renderer.render(scene, camera);
//   ...in layout():  post && post.setSize(innerWidth, innerHeight);
//
// Tone mapping happens exactly once. three r152+ skips material tone mapping and the
// sRGB transfer whenever the render target is not the canvas, so the whole chain runs
// in linear half-float and OutputPass applies ACESFilmic + sRGB at the end — reading
// renderer.toneMappingExposure fresh every frame, which is what lets theater3d.js keep
// animating the exposure during the curtain open without this module knowing about it.

import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

/* ============================== tuning ============================== */
// The scene is a ~15-unit-wide interior seen through a 38° lens from ~9 units back.
// Every number below is sized to *that*, not to the library defaults (which are built
// for outdoor scale and produce either nothing or a grey wash here).

const TUNE = {
  ao: {
    // 0.32 world units ≈ a third of a book's height: deep enough to reach the join
    // where a shelf plank meets the back panel and the slot behind a run of spines,
    // small enough that the open floor stays clean.
    radius: 0.32,
    distanceExponent: 1.6,   // bias samples toward the near half of the radius — crisp creases
    thickness: 0.5,          // spines are thin; the default 1.0 over-occludes past them
    scale: 1.35,             // the corners must read *dark because enclosed*, not tinted
    samples: 12,
    distanceFallOff: 0.6,
  },
  aoDenoise: { lumaPhi: 10, depthPhi: 2.5, normalPhi: 4, radius: 6, radiusExponent: 2, rings: 2, samples: 8 },
  // The AO multiplier is warm, not grey: occlusion eats blue fastest and red slowest,
  // so an enclosed corner falls toward the room's own oxblood instead of toward soot.
  aoWarmth: { r: 0.78, g: 1.0, b: 1.12 },
  bloom: {
    threshold: 3.0,
    strength: 0.34,
    radius: 0.4,
  },
  dof: {
    cocScale: 2.4,           // how fast defocus grows away from the focus plane
    maxCoc: 0.0034,          // blur radius cap, as a fraction of frame height (~6.5px at 1906p)
    focusTol: 0.7,           // dead zone (world units) around focus — the whole case depth stays crisp
    focusLerp: 5.0,          // 1/s — a pulled focus glides, it does not snap
  },
  grain: { amount: 0.030, vignette: 0.12 },   // the CSS #vignette already grades the frame; stay under it
};

/* ============================== shaders ============================== */

// Cheap depth-driven DOF. BokehPass would re-render the whole scene a third time for
// its depth; the GTAO pass has already paid for a depth texture, so this reuses it —
// one fullscreen pass, 12 poisson taps, foreground-bleed guarded by per-tap depth.
const DofShader = {
  name: 'TheaterDofShader',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 60 },
    focusDist: { value: 9.4 },
    focusTol: { value: TUNE.dof.focusTol },
    cocScale: { value: TUNE.dof.cocScale },
    maxCoc: { value: TUNE.dof.maxCoc },
    aspect: { value: 0.5 },            // height/width, to keep the sample disk circular
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float cameraNear, cameraFar, focusDist, focusTol, cocScale, maxCoc, aspect;
    varying vec2 vUv;

    float viewDist(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      // perspective depth -> positive view-space distance
      return (cameraNear * cameraFar) / (cameraFar - d * (cameraFar - cameraNear));
    }
    float cocOf(float dist) {
      float d = max(0.0, abs(dist - focusDist) - focusTol);
      return clamp(d / max(dist, 0.001) * cocScale, 0.0, 1.0);
    }

    void main() {
      vec4 sharp = texture2D(tDiffuse, vUv);
      float dist = viewDist(vUv);
      float coc = cocOf(dist);
      float r = coc * maxCoc;
      if (r < 0.0002) { gl_FragColor = sharp; return; }

      // 12-point poisson disk
      vec2 taps[12];
      taps[0]  = vec2( 0.326, -0.406); taps[1]  = vec2(-0.840, -0.074);
      taps[2]  = vec2(-0.696,  0.457); taps[3]  = vec2(-0.203,  0.621);
      taps[4]  = vec2( 0.962, -0.195); taps[5]  = vec2( 0.473, -0.480);
      taps[6]  = vec2( 0.519,  0.767); taps[7]  = vec2( 0.185, -0.893);
      taps[8]  = vec2( 0.507,  0.064); taps[9]  = vec2( 0.896,  0.412);
      taps[10] = vec2(-0.322, -0.933); taps[11] = vec2(-0.792, -0.598);

      vec3 acc = sharp.rgb;
      float wsum = 1.0;
      for (int i = 0; i < 12; i++) {
        vec2 off = taps[i] * r;
        off.x *= aspect;
        vec2 uv = vUv + off;
        float td = viewDist(uv);
        // a tap nearer the camera than this pixel only contributes if it is itself
        // defocused — keeps the sharp shelf from smearing over the soft curtain edge
        float w = td >= dist ? 1.0 : cocOf(td);
        acc += texture2D(tDiffuse, uv).rgb * w;
        wsum += w;
      }
      vec3 blurred = acc / wsum;
      // ease in so the focus plane itself never shimmers
      gl_FragColor = vec4(mix(sharp.rgb, blurred, smoothstep(0.0, 0.35, coc)), sharp.a);
    }`,
};

// Film grain + a slight vignette, applied last, in display (post-tonemap sRGB) space.
// The grain is luminance-weighted — quiet in the highlights, alive in the mids — and
// the vignette is deliberately shallow because the page already runs a CSS one.
const GrainShader = {
  name: 'TheaterGrainShader',
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0.37 },             // frozen at this seed under prefers-reduced-motion
    amount: { value: TUNE.grain.amount },
    vigAmount: { value: TUNE.grain.vignette },
    resolution: { value: null },       // set in setSize (a Vector2)
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float time, amount, vigAmount;
    uniform vec2 resolution;
    varying vec2 vUv;

    float hash(vec2 p) {
      p = mod(p, 1024.0);
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 px = vUv * resolution;
      float n = hash(px + vec2(fract(time * 1.31) * 331.0, fract(time * 0.79) * 173.0)) - 0.5;
      float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
      c.rgb += n * amount * (0.35 + 0.65 * (1.0 - luma));
      vec2 q = vUv - 0.5;
      q.x *= 1.18;
      float v = smoothstep(0.42, 0.85, length(q));
      c.rgb *= 1.0 - v * vigAmount;
      gl_FragColor = c;
    }`,
};

/* ============================== the chain ============================== */

export function initPost(ctx) {
  if (!ctx || !ctx.THREE || !ctx.renderer || !ctx.scene || !ctx.camera) return null;
  const { Q } = ctx;

  if (Q && Q.mobile) return null;

  try {
    return buildChain(ctx);
  } catch (e) {
    console.warn('[theater3d-post] chain failed to construct, plain render path stays', e);
    return null;
  }
}

function buildChain(ctx) {
  const { THREE, renderer, scene, camera, Q } = ctx;
  const reduced = !!(Q && Q.reduced);

  const size = renderer.getSize(new THREE.Vector2());
  const dpr = renderer.getPixelRatio();
  const dw = Math.max(1, Math.round(size.x * dpr));
  const dh = Math.max(1, Math.round(size.y * dpr));

  const composer = new EffectComposer(renderer);   // half-float targets by default in r169
  composer.setPixelRatio(dpr);
  composer.setSize(size.x, size.y);

  /* ---- 1 · beauty ---- */
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  /* ---- 2 · ambient occlusion (GTAO, r169) ---- */
  const gtao = new GTAOPass(scene, camera, dw, dh);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 1.0;
  gtao.updateGtaoMaterial(TUNE.ao);
  gtao.updatePdMaterial(TUNE.aoDenoise);

  // Warm the occlusion. The stock blend multiplies by neutral grey; here the multiplier
  // loses blue faster than red, so enclosed corners fall toward the room's own palette.
  {
    const w = TUNE.aoWarmth;
    gtao.blendMaterial.fragmentShader = /* glsl */`
      uniform float intensity;
      uniform sampler2D tDiffuse;
      varying vec2 vUv;
      void main() {
        vec4 texel = texture2D(tDiffuse, vUv);
        float ao = texel.r;
        vec3 mult = vec3(
          max(0.0, mix(1.0, ao, intensity * ${w.r.toFixed(3)})),
          max(0.0, mix(1.0, ao, intensity * ${w.g.toFixed(3)})),
          max(0.0, mix(1.0, ao, intensity * ${w.b.toFixed(3)}))
        );
        gl_FragColor = vec4(mult, texel.a);
      }`;
    gtao.blendMaterial.needsUpdate = true;
  }

  // Keep fakes out of the G-buffer. The stock pass hides only points and lines; this
  // scene is full of transparent card — the baked contact shadows, the additive light
  // beam and glare stripes, the alpha-cut valance, the rug floating 8mm above the
  // boards. Rendered into the normal/depth buffer as solid planes they would each
  // print a false occlusion halo (the rug alone would shade half the floor).
  gtao.overrideVisibility = function () {
    const cache = this._visibilityCache;
    this.scene.traverse((o) => {
      cache.set(o, o.visible);
      if (o.isPoints || o.isLine) { o.visible = false; return; }
      // An opaque surface can still be wrong to occlude with. The curtain halves are
      // mirrored geometry, so one of them stores upstage-facing normals and relies on the
      // DoubleSide front-facing flip in the fragment shader, which this pass does not do.
      // Left in, it read the cloth as a wall and printed the whole room onto it.
      if (o.userData && o.userData.noAO) { o.visible = false; return; }
      if (o.isMesh && o.material && !Array.isArray(o.material)) {
        const m = o.material;
        if (m.transparent === true || m.depthWrite === false) o.visible = false;
      }
    });
  };
  composer.addPass(gtao);

  /* ---- 3 · bloom, held to the metals ---- */
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(dw, dh),
    TUNE.bloom.strength, TUNE.bloom.radius, TUNE.bloom.threshold
  );
  composer.addPass(bloom);

  /* ---- 4 · depth of field, focused on the case ---- */
  const dof = new ShaderPass(DofShader);
  dof.material.uniforms.tDepth.value = gtao.depthTexture;   // reuse — no third scene render
  dof.material.uniforms.cameraNear.value = camera.near;
  dof.material.uniforms.cameraFar.value = camera.far;
  dof.material.uniforms.aspect.value = dh / dw;
  composer.addPass(dof);

  /* ---- 5 · tone map (ACES, live exposure) + sRGB, exactly once ---- */
  const output = new OutputPass();
  composer.addPass(output);

  /* ---- 6 · SMAA — the composer bypasses canvas MSAA, and the gold serifs and
          hairline brass plates crawl without it. Post-tonemap, where SMAA belongs. ---- */
  const smaa = new SMAAPass(dw, dh);
  composer.addPass(smaa);

  /* ---- 7 · grain + vignette, last so the AA cannot soften the grain ---- */
  const grain = new ShaderPass(GrainShader);
  grain.material.uniforms.resolution.value = new THREE.Vector2(dw, dh);
  composer.addPass(grain);

  /* ---- focus management ---- */
  // Default focus tracks the bookcase (it moves between layouts). Setting .focus pulls
  // focus to a distance in world units — e.g. toward a presented copy — and the pull
  // glides at TUNE.dof.focusLerp. Setting .focus = null hands it back to the case.
  const v3a = new THREE.Vector3();
  const v3b = new THREE.Vector3();
  let focusOverride = null;
  let focusCurrent = 9.4;

  function autoFocusDistance() {
    camera.getWorldPosition(v3a);
    // Until the curtain is open, the curtain *is* the subject (and it carries the
    // load-progress braid): keep it in focus. When the stage opens, focus glides
    // upstage to the case — a rack focus, timed by the curtain itself.
    if (ctx.state && ctx.state.phase !== 'open') {
      v3b.set(0, 2.0, 2.2);                    // the curtain plane
      return v3a.distanceTo(v3b);
    }
    // shelf sits at (2.44, ·, -0.30) in landscape, (0, ·, -2.05) portrait — read live
    const shelf = ctx.groups && ctx.groups.shelf;
    if (shelf) shelf.getWorldPosition(v3b); else v3b.set(2.44, 0, -0.30);
    v3b.y = 1.9;
    return v3a.distanceTo(v3b);
  }
  focusCurrent = autoFocusDistance();

  /* ---- the public object ---- */
  const api = {
    enabled: true,
    composer,
    passes: { renderPass, gtao, bloom, dof, output, smaa, grain },

    get focus() { return focusOverride !== null ? focusOverride : focusCurrent; },
    set focus(d) { focusOverride = (d == null) ? null : +d; },

    render(dt, t) {
      if (!api.enabled) { renderer.render(scene, camera); return; }
      if (!reduced) grain.material.uniforms.time.value = t % 64.0;
      const target = focusOverride !== null ? focusOverride : autoFocusDistance();
      const k = reduced ? 1 : Math.min(1, (dt || 0.016) * TUNE.dof.focusLerp);
      focusCurrent += (target - focusCurrent) * k;
      dof.material.uniforms.focusDist.value = focusCurrent;
      composer.render(dt);
    },

    setSize(w, h) {
      const pr = renderer.getPixelRatio();
      composer.setPixelRatio(pr);                 // re-sizes every pass at device pixels
      composer.setSize(w, h);
      const W = Math.max(1, Math.round(w * pr)), H = Math.max(1, Math.round(h * pr));
      grain.material.uniforms.resolution.value.set(W, H);
      dof.material.uniforms.aspect.value = H / W;
    },

    dispose() {
      for (const p of [gtao, bloom, output, smaa]) { if (p.dispose) try { p.dispose(); } catch (e) { /* already gone */ } }
      for (const p of [dof, grain]) { if (p.material) p.material.dispose(); if (p.fsQuad && p.fsQuad.dispose) p.fsQuad.dispose(); }
      if (composer.dispose) composer.dispose();
    },
  };

  // Defensive: if the host forgets to wire setSize into layout(), ride the shared hook.
  // Calling setSize twice with the same numbers is a no-op (render targets early-return).
  if (Array.isArray(ctx.layoutFns)) {
    ctx.layoutFns.push(() => api.setSize(innerWidth, innerHeight));
  }

  return api;
}
