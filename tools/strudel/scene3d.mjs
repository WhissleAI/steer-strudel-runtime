// Steer's Scene layer (docs/MUSIC_VIZ.md): five scenes of our own on Three.js (MIT, pinned in package.json), bundled
// offline by tools/build_strudel.sh into Resources/strudel/scene.js and loaded only when a scene is shown. Three's
// WebGPURenderer runs on WebGPU where the browser has it and on its WebGL 2 backend otherwise (one code path: node
// materials + TSL). Every frame: the scene → half-resolution bloom → ACES tone mapping, a vignette and fine grain (no
// banding), with exponential fog for depth. Each scene is driven by the same small vector (VizPlan › VizLook: palette,
// energy, motion, density, glow, drift, per-lane reactivity, transition) and by Strudel's event stream (onsets per lane
// group, bar and section lines) that viz.mjs hands in; the master's analyser is only a secondary source.
import * as THREE from 'three/webgpu';
import { Fn, uniform, uv, vec2, vec3, float, sin, cos, mix, smoothstep, length, exp, clamp, pass, screenUV, rand, positionLocal,
         transformNormalToView, normalize } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

export const SCENES = ['aurora', 'particles', 'waves', 'tunnel', 'grid'];
const GROUPS = ['kick', 'snare', 'hats', 'bass', 'keys'];
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
const ease = (k, dt, rate) => 1 - Math.exp(-dt * rate);   // exponential easing toward a target

/** "hsl(18 80% 60%)" or "#rrggbb" → THREE.Color (linear). */
function colourOf(s, fallback = '#88aaff') {
  const c = new THREE.Color();
  const m = /hsl\(([\d.]+) ([\d.]+)% ([\d.]+)%/.exec(s ?? '');
  if (m) c.setHSL(Number(m[1]) / 360, Number(m[2]) / 100, Number(m[3]) / 100, THREE.SRGBColorSpace);
  else c.set(s && s.startsWith('#') ? s : fallback);
  return c;
}

function softDisc(alpha) {
  return Fn(() => clamp(float(1).sub(length(uv().sub(0.5)).mul(2)), 0, 1).pow(2.2).mul(alpha))();
}

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/**
 * A scene on `canvas`: {backend, kind, resize, setLook(look, colours), frame(drive), render(), dispose()}.
 * drive: {dt (s), t (cycles), env: {kick..keys} 0..1, onsets: {group: velocity} this frame, section (a section line now),
 * bands [3] (the analyser, or null)}.
 */
export async function createScene(canvas, { preferWebGPU = true } = {}) {
  const hasGPU = preferWebGPU && typeof navigator !== 'undefined' && !!navigator.gpu;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false, forceWebGL: !hasGPU, powerPreference: 'low-power' });
  await renderer.init();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const backend = renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';

  const scene = new THREE.Scene();
  const bg = new THREE.Color('#05060a');
  scene.background = bg;
  scene.fog = new THREE.FogExp2(bg, 0.035);
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 200);
  camera.position.set(0, 0, 10);
  scene.add(camera);

  const U = {
    c1: uniform(new THREE.Color('#ff8844')), c2: uniform(new THREE.Color('#44aaff')), c3: uniform(new THREE.Color('#ffee88')),
    energy: uniform(0.6), glow: uniform(0.5), time: uniform(0),
    kick: uniform(0), snare: uniform(0), hats: uniform(0), bass: uniform(0), keys: uniform(0),
    flash: uniform(0), fade: uniform(0), sweep: uniform(-1), bloom: uniform(0.8), grainT: uniform(0),
  };
  const target = { c1: new THREE.Color(), c2: new THREE.Color(), c3: new THREE.Color(), bg: new THREE.Color('#05060a') };

  // ---- post: bloom at half resolution, then vignette and grain; ACES and sRGB come with the pipeline's output transform
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const colour = scenePass.getTextureNode('output');
  const glowPass = bloom(colour, 0.8, 0.5, 0.32);
  glowPass.setResolutionScale(0.5);
  pipeline.outputNode = Fn(() => {
    const c = colour.add(glowPass.mul(U.bloom.div(0.8)));
    const d = length(screenUV.sub(0.5).mul(vec2(1.0, 1.2)));
    const vignette = smoothstep(0.95, 0.35, d).mul(0.55).add(0.45);
    const grain = rand(screenUV.mul(1777).add(U.grainT)).sub(0.5).mul(0.022);
    // the transition overlay: a burst of light, a fade to the background, a sweeping band
    const band = exp(screenUV.x.sub(U.sweep).mul(12).pow(2).negate()).mul(smoothstep(-0.2, 0, U.sweep));
    const lit = c.rgb.mul(vignette).mul(float(1).sub(U.fade)).add(vec3(U.flash.mul(0.35))).add(vec3(band.mul(0.4)));
    return vec3(lit).add(grain);
  })();

  let kind = null, current = null;
  let look = { energy: 0.6, motion: 0.5, density: 0.5, glow: 0.5, drift: 0.3, react: {}, transition: 'fade' };
  const state = { time: 0, sweepT: -1, beat: 0, travel: 0 };
  const lights = new THREE.Group();
  scene.add(lights);

  // ------------------------------------------------------------ the scenes (each: {group, update(drive), dispose})

  /** Aurora: three curtains of light that sway with the bass and brighten on the kick; keys shimmer at the top. */
  function aurora() {
    const mat = new THREE.MeshBasicNodeMaterial({ depthWrite: false, fog: false });
    mat.colorNode = Fn(() => {
      const p = uv();
      const t = U.time;
      const col = vec3(0, 0, 0).toVar();
      const cols = [U.c1, U.c2, U.c3];
      for (let k = 0; k < 3; ++k) {
        const wob = sin(p.x.mul(2.2 + k * 1.3).add(t.mul(0.35 + 0.17 * k)).add(k * 2.1)).mul(0.14)
          .add(sin(p.x.mul(5.3 + k).sub(t.mul(0.5))).mul(0.04).mul(U.bass.add(0.4)));
        const y0 = float(0.36 + 0.15 * k).add(wob);
        const width = float(9).sub(U.glow.mul(5)).add(k * 2);
        const curtain = exp(p.y.sub(y0).mul(width).pow(2).negate());
        const rays = sin(p.x.mul(23 + 7 * k).add(t.mul(0.6)).add(sin(p.x.mul(5).add(t)).mul(2))).mul(0.5).add(0.5).pow(2).mul(0.4).add(0.6);
        col.addAssign(cols[k].mul(curtain).mul(rays).mul(U.energy.mul(0.22).add(0.1)).mul(U.kick.mul(0.5).add(0.8)));
      }
      const stars = rand(p.mul(vec2(311, 173)).floor()).pow(60).mul(smoothstep(0.55, 0.95, p.y)).mul(U.hats.mul(0.6).add(0.4));
      col.addAssign(U.c3.mul(stars));
      return col;
    })();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false; quad.position.z = -1.2;
    const fit = () => { const h = 2 * Math.tan((camera.fov * Math.PI) / 360) * 1.2; quad.scale.set(h * camera.aspect / 2 * 1.06, h / 2 * 1.06, 1); };
    fit();
    camera.add(quad);
    return { group: new THREE.Group(), fit, update() {}, dispose() { camera.remove(quad); quad.geometry.dispose(); mat.dispose(); } };
  }

  /** soft additive sprites, positions written straight into the instance matrices (each faces the camera's z) */
  function sprites(max) {
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    mat.opacityNode = softDisc(U.glow.mul(0.5).add(0.5));
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    const col = new THREE.Color(1, 1, 1);
    for (let i = 0; i < max; ++i) mesh.setColorAt(i, col);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const set = (i, x, y, z, s) => {
      const a = mesh.instanceMatrix.array, o = i * 16;
      a[o] = s; a[o + 1] = 0; a[o + 2] = 0; a[o + 3] = 0; a[o + 4] = 0; a[o + 5] = s; a[o + 6] = 0; a[o + 7] = 0;
      a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = s; a[o + 11] = 0; a[o + 12] = x; a[o + 13] = y; a[o + 14] = z; a[o + 15] = 1;
    };
    const tint = (i, c, k) => { const a = mesh.instanceColor.array; a[i * 3] = c.r * k; a[i * 3 + 1] = c.g * k; a[i * 3 + 2] = c.b * k; };
    const done = (n) => { mesh.count = n; mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; };
    return { mesh, mat, set, tint, done, dispose() { mesh.geometry.dispose(); mat.dispose(); mesh.dispose(); } };
  }

  /** Particles: a slow curl-noise flow in depth; the kick pushes them out in a burst, the hats make them shimmer. */
  function particles() {
    const MAX = 3000;
    const sp = sprites(MAX);
    const g = new THREE.Group(); g.add(sp.mesh);
    const r = rng(11);
    const P = Array.from({ length: MAX }, (_, i) => ({ x: (r() - 0.5) * 14, y: (r() - 0.5) * 9, z: (r() - 0.5) * 12 - 2, vx: 0, vy: 0, vz: 0,
                                                      grp: i % 5, s: 0.04 + r() * 0.1, ph: r() * 6.28 }));
    const cols = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
    return {
      group: g,
      update(d) {
        cols[0].copy(U.c1.value); cols[1].copy(U.c2.value); cols[2].copy(U.c3.value);
        const n = Math.round(600 + 2400 * clamp01(look.density));
        const env = d.env, t = state.time, dt = d.dt;
        const kick = d.onsets?.kick ?? 0;
        const speed = 0.25 + 1.2 * look.motion;
        for (let i = 0; i < n; ++i) {
          const p = P[i];
          // a curl field: the curl of a smooth potential (divergence-free, so the particles swirl and never pile up)
          const k1 = 0.35, k2 = 0.27;
          const fx = Math.cos(p.y * k1 + t * 0.21) * Math.cos(p.z * k2 - t * 0.13) * k1;
          const fy = -Math.sin(p.x * k1 + t * 0.17) * Math.cos(p.z * k2 + t * 0.11) * k1 * 0.8;
          const fz = Math.sin(p.x * k2 - t * 0.19) * Math.sin(p.y * k2 + t * 0.09) * k2;
          p.vx += (fx * speed - p.vx) * Math.min(1, dt * 1.5);
          p.vy += (fy * speed - p.vy) * Math.min(1, dt * 1.5);
          p.vz += (fz * speed - p.vz) * Math.min(1, dt * 1.5);
          if (kick > 0) {   // a burst from the centre on the kick
            const rr = Math.hypot(p.x, p.y) + 0.3;
            p.vx += (p.x / rr) * kick * (1.5 + 2 * look.energy);
            p.vy += (p.y / rr) * kick * (1.5 + 2 * look.energy);
          }
          p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
          if (p.x > 8) p.x -= 16; if (p.x < -8) p.x += 16;
          if (p.y > 5.5) p.y -= 11; if (p.y < -5.5) p.y += 11;
          if (p.z > 4) p.z -= 14; if (p.z < -10) p.z += 14;
          const e = env[GROUPS[p.grp]] ?? 0;
          const shimmer = p.grp === 2 ? 0.5 + 0.5 * Math.sin(t * 25 + p.ph) * (env.hats ?? 0) : 0;
          sp.set(i, p.x, p.y, p.z, p.s * 1.8 * (1 + 1.6 * e + shimmer) * (0.7 + look.glow * 0.8));
          sp.tint(i, cols[p.grp % 3], (0.2 + 0.8 * e + shimmer * 0.6) * (0.35 + 0.65 * look.energy));
        }
        sp.done(n);
      },
      dispose() { sp.dispose(); },
    };
  }

  /** Waves: a lit, shaded surface (analytic normals, specular highlights from two coloured lights) that the bass heaves
   *  and the kick sends rings across. */
  function waves() {
    const geo = new THREE.PlaneGeometry(64, 26, 240, 100);   // wide enough for a portrait frame's field of view
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.42, metalness: 0.3 });
    const ripple = uniform(10), rippleA = uniform(0);
    // h(x, z) and its derivatives: two swells (bass), a fine chop (hats), a ring from the last kick
    const H = (x, z, t) => {
      const a = sin(x.mul(0.45).add(t.mul(0.9))).mul(U.bass.mul(0.9).add(0.35)).mul(0.55);
      const b = sin(z.mul(0.8).sub(t.mul(0.7)).add(x.mul(0.15))).mul(U.keys.mul(0.4).add(0.25)).mul(0.45);
      const c = sin(x.mul(2.1).add(z.mul(1.7)).add(t.mul(3.5))).mul(U.hats.mul(0.08));
      const r = length(vec2(x, z.add(2)));
      const ring = sin(r.mul(1.6).sub(ripple.mul(7))).mul(exp(r.sub(ripple.mul(4.5)).abs().negate())).mul(rippleA);
      return a.add(b).add(c).add(ring).mul(U.energy.mul(0.7).add(0.5));
    };
    mat.positionNode = Fn(() => {
      const p = positionLocal;
      return vec3(p.x, p.y.add(H(p.x, p.z, U.time)), p.z);
    })();
    mat.normalNode = Fn(() => {
      const p = positionLocal, e = 0.05;
      const h0 = H(p.x, p.z, U.time);
      const dx = H(p.x.add(e), p.z, U.time).sub(h0).div(e), dz = H(p.x, p.z.add(e), U.time).sub(h0).div(e);
      return transformNormalToView(normalize(vec3(dx.negate(), 1, dz.negate())));
    })();
    mat.colorNode = Fn(() => mix(U.c2.mul(0.55), U.c1.mul(0.9), smoothstep(-0.6, 0.9, H(positionLocal.x, positionLocal.z, U.time))))();
    mat.emissiveNode = Fn(() => U.c1.mul(smoothstep(0.4, 1.2, H(positionLocal.x, positionLocal.z, U.time))).mul(U.glow.mul(0.6).add(0.2)))();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, -1.6, -3);
    mesh.rotation.x = 0.12;
    const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(-3, 5, 2);
    const rim = new THREE.DirectionalLight(0xffffff, 1.6); rim.position.set(4, 1.5, -8);
    const amb = new THREE.HemisphereLight(0xffffff, 0x101020, 0.6);
    lights.add(key, rim, amb);
    const g = new THREE.Group(); g.add(mesh);
    let rt = 10;
    return {
      group: g,
      update(d) {
        key.color.copy(U.c3.value); rim.color.copy(U.c2.value);
        rim.intensity = 1.2 + 2.4 * (d.env.snare ?? 0);
        if ((d.onsets?.kick ?? 0) > 0) { rt = 0; rippleA.value = 0.5 + 0.6 * d.onsets.kick; }
        rt += d.dt; ripple.value = rt; rippleA.value *= Math.exp(-d.dt * 1.2);
      },
      dispose() { lights.remove(key, rim, amb); geo.dispose(); mat.dispose(); },
    };
  }

  /** Tunnel: a glowing tube the camera flies through (faster on the beat), its walls lit by rings and stripes in the
   *  palette, three ribbons spiralling along it. */
  function tunnel() {
    const geo = new THREE.CylinderGeometry(4.2, 4.2, 100, 96, 1, true);
    geo.rotateX(Math.PI / 2);
    const travel = uniform(0);
    const wall = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: true });
    wall.colorNode = Fn(() => {
      const p = uv();
      const z = p.y.mul(30).add(travel);
      const rings = smoothstep(0.975, 1.0, sin(z.mul(6.283)).mul(0.5).add(0.5)).mul(U.kick.mul(1.4).add(0.45));
      const stripes = smoothstep(0.96, 1.0, sin(p.x.mul(6.283 * 12).add(z.mul(0.7))).mul(0.5).add(0.5)).mul(U.hats.mul(0.8).add(0.2));
      const base = mix(U.c2, U.c1, sin(z.mul(0.5)).mul(0.5).add(0.5)).mul(0.05);
      return base.add(U.c1.mul(rings)).add(U.c3.mul(stripes).mul(0.6)).mul(U.energy.mul(0.4).add(0.35));
    })();
    const tube = new THREE.Mesh(geo, wall);
    tube.position.z = -30;
    const g = new THREE.Group(); g.add(tube);
    const ribbons = [];
    for (let k = 0; k < 3; ++k) {
      const pts = [];
      for (let i = 0; i <= 200; ++i) { const z = 5 - i * 0.45, a = i * 0.12 + k * 2.094; pts.push(new THREE.Vector3(Math.cos(a) * 2.2, Math.sin(a) * 2.2, z)); }
      const rg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 400, 0.05, 8, false);
      const rm = new THREE.MeshBasicNodeMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const cols = [U.c1, U.c2, U.c3];
      rm.colorNode = cols[k].mul(U.bass.mul(1.2).add(0.6)).mul(U.glow.add(0.5));
      const r = new THREE.Mesh(rg, rm);
      ribbons.push(r); g.add(r);
    }
    return {
      group: g,
      update(d) {
        const push = (d.onsets?.kick ?? 0) * 0.9;
        state.beat = Math.max(state.beat * Math.exp(-d.dt * 5), push);
        state.travel += d.dt * (0.6 + 2.4 * look.motion) * (1 + 1.6 * state.beat);
        travel.value = state.travel;
        ribbons.forEach((r, k) => { r.rotation.z = state.time * (0.15 + 0.07 * k) * (k % 2 ? -1 : 1); });
      },
      dispose() { geo.dispose(); wall.dispose(); ribbons.forEach((r) => { r.geometry.dispose(); r.material.dispose(); }); },
    };
  }

  /** Bloom grid: a floor of glowing columns, each column a lane group, rising with its hits and haloed by the bloom. */
  function grid() {
    const N = 14, MAX = N * N;
    const geo = new THREE.BoxGeometry(0.46, 1, 0.46);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicNodeMaterial();
    const mesh = new THREE.InstancedMesh(geo, mat, MAX);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    const c = new THREE.Color(1, 1, 1);
    for (let i = 0; i < MAX; ++i) mesh.setColorAt(i, c);
    const floorGeo = new THREE.PlaneGeometry(40, 40);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.15, metalness: 0.8, color: 0x0a0a12 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    const g = new THREE.Group(); g.add(mesh); g.add(floor);
    g.position.set(0, -3.4, -1);
    g.rotation.x = 0.36;
    g.scale.setScalar(1.9);
    const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(2, 8, 6);
    lights.add(key);
    const o = new THREE.Object3D();
    const cols = [new THREE.Color(), new THREE.Color(), new THREE.Color()];
    const h = new Float32Array(MAX);
    return {
      group: g,
      update(d) {
        cols[0].copy(U.c1.value); cols[1].copy(U.c2.value); cols[2].copy(U.c3.value);
        const n = clamp01(look.density) > 0.5 ? N : 9;
        let k = 0;
        for (let j = 0; j < n; ++j) for (let i = 0; i < n; ++i) {
          const grp = GROUPS[(i + j) % 5];
          const wave = 0.5 + 0.5 * Math.sin(i * 0.6 + j * 0.45 - state.time * (0.6 + look.motion));
          const tgt = 0.08 + (d.env[grp] ?? 0) * (0.9 + 2.6 * look.energy) * (0.45 + 0.55 * wave);
          h[k] += (tgt - h[k]) * ease(0, d.dt, h[k] < tgt ? 22 : 6);   // up fast, down slow
          o.position.set((i - (n - 1) / 2) * 0.62, 0, (j - (n - 1) / 2) * 0.62);
          o.scale.set(1, Math.max(0.03, h[k]), 1); o.updateMatrix();
          mesh.setMatrixAt(k, o.matrix);
          const lum = (0.12 + 1.3 * clamp01(h[k] / 2.2)) * (0.6 + 0.4 * look.energy);
          mesh.setColorAt(k, c.copy(cols[(i + j) % 3]).multiplyScalar(lum));
          k++;
        }
        mesh.count = k;
        mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
      },
      dispose() { lights.remove(key); geo.dispose(); mat.dispose(); mesh.dispose(); floorGeo.dispose(); floorMat.dispose(); },
    };
  }

  const MAKERS = { aurora, particles, waves, tunnel, grid };

  function use(k) {
    if (!MAKERS[k]) k = 'aurora';
    if (k === kind) return;
    if (current) { scene.remove(current.group); current.dispose(); }
    kind = k;
    current = MAKERS[k]();
    scene.add(current.group);
  }

  function resize(w, h, dpr) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(Math.max(1, w), Math.max(1, h), false);
    camera.aspect = Math.max(0.1, w / Math.max(1, h));
    // portrait (a phone video): pull back so the scene still fills the frame
    camera.fov = camera.aspect < 1 ? 75 : 55;
    camera.updateProjectionMatrix();
    current?.fit?.();
  }

  let first = true;
  return {
    backend,
    get kind() { return kind; },
    resize,
    setLook(l, colours) {
      look = { ...look, ...l, react: { ...look.react, ...(l.react ?? {}) } };
      use(l.scene && l.scene !== 'none' ? l.scene : 'aurora');
      const lanes = colours?.lanes ?? [];
      target.c1.copy(colourOf(lanes[0])); target.c2.copy(colourOf(lanes[1] ?? lanes[0])); target.c3.copy(colourOf(lanes[2] ?? lanes[0]));
      target.bg.copy(colourOf(colours?.bg ?? '#05060a')).multiplyScalar(0.6);
      if (first) { U.c1.value.copy(target.c1); U.c2.value.copy(target.c2); U.c3.value.copy(target.c3); bg.copy(target.bg); first = false; }
      U.energy.value = clamp01(look.energy); U.glow.value = clamp01(look.glow);
      scene.fog.density = 0.02 + 0.04 * (1 - clamp01(look.density));
    },
    /** One frame's motion from the music. */
    frame(d) {
      const reduce = !!look.reduceMotion;
      const motion = reduce ? 0.04 : clamp01(look.motion);
      state.time += d.dt * (0.15 + 1.6 * motion);
      U.time.value = state.time;
      U.grainT.value = (U.grainT.value + 0.618) % 97;
      const env = {};
      const b = d.bands ?? [0, 0, 0];
      for (const gname of GROUPS) {
        const r = clamp01(look.react?.[gname] ?? 0.6);
        const extra = gname === 'kick' || gname === 'bass' ? b[0] : gname === 'hats' ? b[2] : b[1];
        env[gname] = clamp01(((d.env?.[gname] ?? 0) + 0.3 * extra) * r * (reduce ? 0.3 : 1));
      }
      for (const gname of GROUPS) U[gname].value = env[gname];
      const onsets = {};
      for (const [k, v] of Object.entries(d.onsets ?? {})) onsets[k] = reduce ? 0 : v * clamp01(look.react?.[k] ?? 0.6);
      // colours ease to the look's (a section's colour shift, a palette change)
      const k = ease(0, d.dt, 2.5);
      U.c1.value.lerp(target.c1, k); U.c2.value.lerp(target.c2, k); U.c3.value.lerp(target.c3, k); bg.lerp(target.bg, k);
      scene.fog.color.copy(bg);
      // a section line: the look's transition and a bloom swell
      if (d.section) {
        const tr = reduce ? 'fade' : (look.transition ?? 'fade');
        if (tr === 'burst') U.flash.value = 1;
        else if (tr === 'fade') U.fade.value = reduce ? 0.4 : 0.8;
        else if (tr === 'sweep') state.sweepT = 0;
        if (!reduce) state.swell = 1;
      }
      state.swell = (state.swell ?? 0) * Math.exp(-d.dt * 1.5);
      U.bloom.value = (0.35 + 0.9 * clamp01(look.glow)) * (0.7 + 0.5 * clamp01(look.energy)) * (1 + 0.9 * state.swell + 0.25 * env.kick);
      U.flash.value *= Math.exp(-d.dt * 3.5);
      U.fade.value *= Math.exp(-d.dt * 2.5);
      if (state.sweepT >= 0) { state.sweepT += d.dt * 1.2; U.sweep.value = state.sweepT > 1.3 ? -1 : state.sweepT - 0.1; if (state.sweepT > 1.3) state.sweepT = -1; }
      const drift = reduce ? 0 : clamp01(look.drift);
      const tt = state.time;
      camera.position.set(Math.sin(tt * 0.13) * 1.4 * drift, Math.cos(tt * 0.11) * 0.8 * drift, 10 - 1.2 * drift * Math.sin(tt * 0.07));
      camera.lookAt(0, 0, -4);
      current?.update({ ...d, env, onsets });
    },
    render() { return pipeline.renderAsync ? pipeline.renderAsync() : pipeline.render(); },
    dispose() {
      if (current) { scene.remove(current.group); current.dispose(); current = null; kind = null; }
      try { glowPass.dispose?.(); scenePass.dispose?.(); pipeline.dispose?.(); } catch (e) { /* gone */ }
      const device = renderer.backend?.device;
      const gl = renderer.backend?.gl;
      renderer.dispose();
      try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch (e) { /* gone */ }
      try { device?.destroy?.(); } catch (e) { /* gone */ }
    },
  };
}

if (typeof window !== 'undefined') window.SteerScene3D = { createScene, SCENES };
