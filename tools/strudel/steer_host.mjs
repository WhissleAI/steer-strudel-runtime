// Steer's Strudel host (docs/MUSIC_COMPOSE.md): the page Compose runs in a WKWebView. Bundled with the pinned
// @strudel/* packages by tools/build_strudel.sh into Resources/strudel/strudel.js (one classic script, no network).
//
// window.steer is the bridge Swift calls (StrudelHost.swift): every entry returns plain JSON-able values; errors come
// back as {ok:false, error}. Layers are a program's labelled blocks (`drums: s("bd*4")`, as strudel.cc's `$:`): each
// can be muted or soloed from Swift, rendered alone (stems), and queried with its name (MIDI per layer).
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import * as sd from 'superdough';
import { evaluate as transpileEvaluate } from '@strudel/transpiler';
import { makeViz, snapshot as vizSnapshot, bench as vizBench, videoBegin, videoFrame, videoFrames, videoEnd, videoOpen, VIEW_NAMES, PALETTES } from './viz.mjs';

const { Pattern, evalScope, stack, silence, noteToMidi } = core;

// superdough pools filter nodes across audio contexts (module-wide, held by WeakRef): a node from another context (the
// live one, or an earlier render) cannot be connected in this one, so it is never handed out here. While a render runs
// no pooled node is handed out at all: its notes are scheduled as it goes (renderOffline), and a filter reused from a
// note that ended earlier in the render would carry that note's state, so a stem would no longer sum to its mix. The
// pool pops every entry it cannot use, so it is emptied as the render asks for nodes (bounded, never carried on).
if (typeof WeakRef !== 'undefined') {
  const NativeWeakRef = WeakRef;
  globalThis.WeakRef = class extends NativeWeakRef {
    deref() {
      const n = super.deref();
      if (n && typeof AudioNode !== 'undefined' && n instanceof AudioNode && (rendering || n.context !== sd.getAudioContext())) return undefined;
      return n;
    }
  };
}

// ---------------------------------------------------------------- deterministic randomness
// Strudel's own randomness ("?", rand, degrade) is seeded by the cycle; superdough's (reverb impulses, noise) uses
// Math.random. A render reseeds it, so the same code renders the same audio (stems sum to the mix).
const nativeRandom = Math.random;
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Reverb impulses: superdough draws each one from Math.random and renders it asynchronously. Here each is seeded by
// its settings (the same room sounds the same in a stem and in the mix), and a render waits for them.
const waitingImpulses = new Set();   // convolvers whose impulse is still being rendered
function hashOf(...a) {
  let h = 2166136261;
  for (const ch of JSON.stringify(a)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
if (typeof BaseAudioContext !== 'undefined' && BaseAudioContext.prototype.createReverb) {
  const createReverb = BaseAudioContext.prototype.createReverb;
  const bufferProp = Object.getOwnPropertyDescriptor(ConvolverNode.prototype, 'buffer');
  const createConvolver = BaseAudioContext.prototype.createConvolver;
  BaseAudioContext.prototype.createReverb = function (...args) {
    // the convolver createReverb makes: watched from birth, so its first impulse counts too
    this.createConvolver = function () {
      const c = createConvolver.call(this);
      if (bufferProp) {
        Object.defineProperty(c, 'buffer', {
          get() { return bufferProp.get.call(this); },
          set(v) { bufferProp.set.call(this, v); if (v) waitingImpulses.delete(c); },
          configurable: true,
        });
      }
      let generate;
      Object.defineProperty(c, 'generate', {
        get() { return generate; },
        set(f) {
          generate = (...g) => {
            waitingImpulses.add(c);
            const before = Math.random;
            Math.random = seeded(hashOf(g.slice(0, 4)));
            try { return f(...g); } finally { Math.random = before; }
          };
        },
        configurable: true,
      });
      return c;
    };
    try { return createReverb.apply(this, args); } finally { delete this.createConvolver; }
  };
}
// Noise buffers (and impulses) are filled from Math.random right after createBuffer: during a render each buffer's
// randomness is seeded by its shape, so a sound's noise is the same in every render whatever played before it.
let rendering = false;
if (typeof BaseAudioContext !== 'undefined') {
  const createBuffer = BaseAudioContext.prototype.createBuffer;
  BaseAudioContext.prototype.createBuffer = function (channels, length, rate) {
    if (rendering) Math.random = seeded(hashOf(channels, length, rate));
    return createBuffer.call(this, channels, length, rate);
  };
}
async function impulsesReady(context, ms = 3000) {
  const t0 = Date.now();
  const mine = () => [...waitingImpulses].some((c) => c.context === context);
  while (mine() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 2));
  // one that never came is given up on (the room stays dry), not waited for again nor held with its context
  for (const c of [...waitingImpulses]) if (c.context === context) waitingImpulses.delete(c);
}

// ---------------------------------------------------------------- evaluating a program into layers
let collecting = null;          // the layers of the program being evaluated
let collectingCps = null;
let anon = 0;
let scopeReady = null;

function installPatternMethods() {
  Pattern.prototype.p = function (id) {
    id = String(id);
    if (!collecting) return this;
    if (id.startsWith('_') || id.endsWith('_')) {
      collecting.muted.push(id.replace(/^_+|_+$/g, ''));
      return silence;
    }
    let solo = false;
    if (id.startsWith('S$')) { solo = true; id = id.slice(1); }   // strudel.cc's solo: S$: ...
    if (id.includes('$')) id = `${id.replace(/\$/g, '') || 'layer'}${++anon}`;
    collecting.layers.push({ name: id, pattern: this, solo });
    return this;
  };
  Pattern.prototype.q = function () { return silence; };
  for (let i = 1; i < 10; ++i) {
    try {
      Object.defineProperty(Pattern.prototype, `d${i}`, { get() { return this.p(`d${i}`); }, configurable: true });
      Object.defineProperty(Pattern.prototype, `p${i}`, { get() { return this.p(`p${i}`); }, configurable: true });
    } catch (e) { /* already there */ }
  }
}

function ensureScope() {
  if (!scopeReady) {
    scopeReady = (async () => {
      mini.miniAllStrings?.();
      installPatternMethods();
      const setCps = (c) => { collectingCps = Number(c); return silence; };
      const setCpm = (c) => { collectingCps = Number(c) / 60; return silence; };
      await evalScope(core, mini, tonal, webaudio, sd, {
        setcps: setCps, setCps, setcpm: setCpm, setCpm,
        hush: () => silence, all: () => silence, each: () => silence,
        samples: async (...a) => { try { return await sd.samples(...a); } catch (e) { return undefined; } },
      });
      // cpm as a pattern method, against the program's tempo (the repl's)
      core.register('cpm', function (cpm, pat) { return pat._fast(cpm / 60 / (collectingCps ?? state.cps)); });
      // the stereo image (docs/MUSIC_COMPOSE.md § Stereo): double-tracking and a ping-pong echo, as plan lanes use them
      core.register('wide', function (w, pat) { return widened(pat, Number(w)); });
      core.register('pingpong', function (amount, spread, pat) { return pingponged(pat, Number(amount), Number(spread)); });
      await sd.registerSynthSounds();
    })();
  }
  return scopeReady;
}

// ---------------------------------------------------------------- the stereo image (docs/MUSIC_COMPOSE.md § Stereo)
// A sound's pan, −1 … 1 (Strudel's pan is 0 … 1, 0.5 the centre).
function panOf(v) { return typeof v.pan === 'number' ? 2 * v.pan - 1 : 0; }
// A voice of a sound: detuned by `cents` (a note, or a sample's speed), panned to `p` (−1 … 1), at `g` of its level.
// `centre` (−1 … 1) is the sound's own place (MIDI's pan), `dbl` marks a voice that is not a note of its own (a double,
// an echo: never a MIDI note).
function voice(v, cents, p, g, centre, dbl) {
  if (typeof v !== 'object' || v === null) return v;
  const o = { ...v };
  if (cents) {
    let m = typeof o.note === 'number' ? o.note : typeof o.note === 'string' ? (() => { try { return noteToMidi(o.note); } catch (e) { return null; } })() : null;
    if (m !== null && Number.isFinite(m)) o.note = m + cents / 100;
    else if (o.note === undefined && o.freq === undefined) o.speed = (o.speed ?? 1) * Math.pow(2, cents / 1200);
  }
  o.pan = (Math.max(-1, Math.min(1, p)) + 1) / 2;
  o.postgain = (o.postgain ?? 1) * g;
  o.steerPan = centre;
  if (dbl) o.dbl = 1;
  return o;
}
// Double-tracked: two voices detuned ±7 cents, the second 8 ms late, panned `w` either side of the sound's own place,
// each at −3 dB (the pair has the sound's power). Mono-compatible: no voice is out of phase.
// each voice at −3 dB: the pair has the sound's power (the voices, detuned and apart, do not line up)
const DOUBLE = Math.SQRT1_2;
function widened(pat, w) {
  if (!(w > 0)) return pat;
  const half = Math.min(1, w);
  const late = new Pattern((st) => pat.late(0.01 * (st.controls?._cps ?? state.cps)).query(st));
  return stack(
    pat.withValue((v) => { const c = panOf(v); return voice(v, -8, c - half, DOUBLE, c, false); }),
    late.withValue((v) => { const c = panOf(v); return voice(v, 8, c + half, DOUBLE, c, true); }),
  );
}
// A ping-pong echo: the sound, then its echo a dotted eighth later on the left and again a dotted quarter later on the
// right, at `amount` and `amount`² of its level, `spread` (0 … 1) to either side.
function pingponged(pat, amount, spread = 0.7) {
  if (!(amount > 0)) return pat;
  const a = Math.min(0.9, amount), sp = Math.max(0, Math.min(1, Number.isFinite(spread) ? spread : 0.7));
  return stack(
    pat,
    pat.late(3 / 16).withValue((v) => voice(v, 0, -sp, a, panOf(v), true)),
    pat.late(3 / 8).withValue((v) => voice(v, 0, sp, a * a, panOf(v), true)),
  );
}

// The master's stereo (every render and the live output): mid/side, the side high-passed under 150 Hz (the low end mono)
// and lifted 2 dB over 2.5 kHz (air at the sides). Linear: the stems still sum to the mix.
const mastered = new WeakSet();
function masterStereo(controller) {
  try {
    const out = controller?.output;
    const dg = out?.destinationGain;
    if (!dg || mastered.has(dg)) return;
    mastered.add(dg);
    const ac = dg.context;
    const split = new ChannelSplitterNode(ac, { numberOfOutputs: 2 });
    const merge = new ChannelMergerNode(ac, { numberOfInputs: 2 });
    const g = (x) => new GainNode(ac, { gain: x, channelCount: 1, channelCountMode: 'explicit' });
    const mid = g(1), side = g(1);
    split.connect(g(0.5), 0).connect(mid); split.connect(g(0.5), 1).connect(mid);
    split.connect(g(0.5), 0).connect(side); split.connect(g(-0.5), 1).connect(side);
    const hp1 = new BiquadFilterNode(ac, { type: 'highpass', frequency: 150, Q: Math.SQRT1_2 });
    const hp2 = new BiquadFilterNode(ac, { type: 'highpass', frequency: 150, Q: Math.SQRT1_2 });
    const air = new BiquadFilterNode(ac, { type: 'highshelf', frequency: 2500, gain: 2 });
    side.connect(hp1).connect(hp2).connect(air);
    // left = mid + side, right = mid − side
    mid.connect(merge, 0, 0); mid.connect(merge, 0, 1);
    air.connect(merge, 0, 0); air.connect(g(-1)).connect(merge, 0, 1);
    dg.disconnect();
    dg.connect(split);
    merge.connect(ac.destination);
  } catch (e) { report(e); }
}

// A program evaluated: { layers: [{name, pattern}], cps|null }. The last expression is a layer "main" when the code
// has no labelled blocks.
async function compile(code) {
  await ensureScope();
  collecting = { layers: [], muted: [] };
  collectingCps = null;
  anon = 0;
  try {
    const { pattern } = await transpileEvaluate(code);
    const out = collecting;
    if (out.layers.some((l) => l.solo)) out.layers = out.layers.filter((l) => l.solo);
    if (!out.layers.length && pattern && pattern instanceof Pattern) out.layers.push({ name: 'main', pattern });
    if (!out.layers.length) throw new Error('the code made no pattern');
    return { layers: out.layers, muted: out.muted, cps: collectingCps };
  } finally {
    collecting = null;
  }
}

// ---------------------------------------------------------------- state
const state = {
  cps: 0.5,
  gain: 1,                 // master (linear), applied to every note's postgain
  program: null,           // { layers, cps }
  pending: null,           // a program to swap in on the next cycle
  mute: new Set(),
  solo: new Set(),
  layerGain: new Map(),
  playing: false,
  anchorTime: 0,           // audio time at anchorCycle
  anchorCycle: 0,
  queried: 0,              // the cycle up to which notes are scheduled
  timer: null,
  muted: false,            // the whole output silent (tests, dev copies)
  log: [],
};

function selected(program, only) {
  if (!program) return silence;
  let layers = program.layers;
  if (only) layers = layers.filter((l) => only.includes(l.name));
  else {
    if (state.solo.size) layers = layers.filter((l) => state.solo.has(l.name));
    layers = layers.filter((l) => !state.mute.has(l.name));
  }
  if (!layers.length) return silence;
  // each layer on its own orbit (its own reverb and delay), unless the code chose one: a stem is then exactly the
  // layer's part of the mix
  return stack(...layers.map((l) => {
    const orbit = program.layers.indexOf(l) + 1;
    const g = only ? 1 : (state.layerGain.get(l.name) ?? 1);   // the mixer's gain (live only; stems take theirs)
    return l.pattern.withValue((v) => (typeof v === 'object' && v !== null
      ? (g === 1 ? { orbit, ...v } : { orbit, ...v, postgain: (v.postgain ?? 1) * g }) : v));
  }));
}

function valueOf(hap, gain) {
  hap.ensureObjectValue();
  const v = { ...hap.value };
  // Steer's pan law: superdough's panner takes a mono sound 3 dB down at the centre against the same sound unpanned
  // (copied to both sides): a panned sound keeps its level wherever it sits
  v.postgain = (v.postgain ?? 1) * gain * (typeof v.pan === 'number' ? Math.SQRT2 : 1);
  return v;
}

// ---------------------------------------------------------------- live playback (own scheduler)
const LOOKAHEAD = 0.15;
// The live context. superdough has one current context, and a render swaps in its OfflineAudioContext for its length:
// the live side never takes that one (1.6.28: a piece started while its level check rendered called resume() on the
// render's context, "Cannot resume an offline audio context that has not started", shown as a toast on every new piece).
let liveContext = null;
function ctx() {
  if (!rendering) liveContext = sd.getAudioContext();
  return liveContext ?? sd.getAudioContext();
}
// Renders one at a time (each swaps superdough's context), and the transport waits for the one under way.
let renderChain = Promise.resolve();
function serial(f) {
  const run = renderChain.then(f);
  renderChain = run.catch(() => {});
  return run;
}
function cycleAt(t) { return state.anchorCycle + (t - state.anchorTime) * state.cps; }
function timeAt(c) { return state.anchorTime + (c - state.anchorCycle) / state.cps; }

function schedule(pattern, from, to, gain) {
  if (to <= from) return;
  let haps;
  try { haps = pattern.queryArc(from, to, { _cps: state.cps }); } catch (e) { report(e); return; }
  for (const hap of haps) {
    if (!hap.hasOnset()) continue;
    const t = timeAt(hap.whole.begin.valueOf());
    try { sd.superdough(valueOf(hap, gain), t, hap.duration.valueOf() / state.cps, state.cps, hap.whole.begin.valueOf()); }
    catch (e) { report(e); }
  }
}

function report(e) {
  const m = String(e?.message ?? e);
  if (state.log[state.log.length - 1] !== m) state.log.push(m);
  if (state.log.length > 20) state.log.shift();
}

function tick() {
  // while a render has superdough's context, nothing is scheduled (it would go into the render); the next tick catches
  // up (an offline render pauses the live scheduler for its length, as before)
  if (rendering) return;
  const now = ctx().currentTime;
  const to = cycleAt(now + LOOKAHEAD);
  let from = Math.max(state.queried, cycleAt(now));
  const g = state.muted ? 0 : state.gain;
  if (state.pending) {
    const at = state.pending.at;
    if (to > at) {
      schedule(selected(state.program), from, at, g);
      state.program = state.pending.program;
      if (state.program.cps) setCpsAt(at, state.program.cps);
      state.pending = null;
      from = at;
    }
  }
  schedule(selected(state.program), from, cycleAt(now + LOOKAHEAD), g);
  state.queried = cycleAt(now + LOOKAHEAD);
}

function setCpsAt(cycle, cps) {
  const t = timeAt(cycle);
  state.anchorTime = t;
  state.anchorCycle = cycle;
  state.cps = cps;
}

// ---------------------------------------------------------------- offline render
// The page's health (docs/MUSIC_COMPOSE.md § The page's health): renders done, and what a render leaves behind.
let lastRender = null;          // the last render's samples, kept only when asked for (withSamples) until taken
const health = { renders: 0, renderMs: 0, frames: 0, contexts: 0, contextsFreed: 0 };
// each render's context is counted when made and when the garbage collector frees it: the difference is what the page
// still holds of earlier renders (their graphs, worklets and buffers)
const contextGone = typeof FinalizationRegistry !== 'undefined' ? new FinalizationRegistry(() => { health.contextsFreed += 1; }) : null;

// Notes are handed to superdough a little ahead of the render's position, not all before it starts. superdough builds
// every note's graph when it is scheduled (sources, filters, envelope and LFO worklets) and gives each a silent
// ConstantSourceNode from time 0 to the note's end that frees it on 'ended' (webAudioTimeout(ac, …, 0, end)). Scheduled
// up front, every note of a long render is processed in every 128-frame quantum from the start: the cost grows with
// notes × length (a 300 s bed: thousands of live graphs and worklets at once) and so does the page's memory. Ahead of the
// position, a note lives from about a step before it sounds until it ends: the cost is linear and the live graphs are
// bounded by the music's own polyphony. What is heard is the same: each note is still started at its own time.
async function renderOffline(program, { cycles, from = 0, sampleRate = 48000, only = null, gain = 1, tail = 0, seed = 1, keep = true }) {
  const cps = program.cps || state.cps;
  const seconds = cycles / cps;
  const frames = Math.ceil((seconds + tail) * sampleRate);
  const live = sd.getAudioContext();
  const liveController = sd.getSuperdoughAudioController();
  const offline = new OfflineAudioContext(2, frames, sampleRate);
  health.contexts += 1;
  contextGone?.register(offline, 0);
  const t0 = Date.now();
  lastRender = null;   // a render's samples are never kept past the next render
  sd.setAudioContext(offline);
  sd.setSuperdoughAudioController(null);
  Math.random = seeded(seed);
  rendering = true;
  try {
    await sd.initAudio({ maxPolyphony: 256 });
    masterStereo(sd.getSuperdoughAudioController());
    const pattern = selected(program, only);
    const haps = pattern.queryArc(from, from + cycles, { _cps: cps })
      .filter((h) => h.hasOnset())
      .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf());
    // superdough cleans up after each note on its 'ended' events (webAudioTimeout): rendering in steps, and letting
    // those events run between steps, makes a render the same every time (OfflineAudioContext otherwise races them)
    const STEP = 8192;
    const ahead = (2 * STEP) / sampleRate + 0.05;   // seconds: always more than one step past the position
    let next = 0, waiting = 0, waited = 0;
    const scheduleUntil = async (until) => {
      while (next < haps.length) {
        const hap = haps[next];
        const t = (hap.whole.begin.valueOf() - from) / cps;
        if (t >= until) break;
        ++next;
        try { await sd.superdough(valueOf(hap, gain), t, hap.duration.valueOf() / cps, cps, hap.whole.begin.valueOf()); }
        catch (e) { report(e); }
      }
      // a reverb's impulse is rendered asynchronously when its orbit first plays: ready before the audio gets there
      waiting += [...waitingImpulses].filter((c) => c.context === offline).length;
      const w0 = Date.now();
      await impulsesReady(offline);
      waited += Date.now() - w0;
    };
    await scheduleUntil(ahead);
    for (let f = STEP; f < frames; f += STEP) {
      offline.suspend(f / sampleRate).then(async () => {
        await scheduleUntil(f / sampleRate + ahead);
        await yieldTask();
        await yieldTask();
        offline.resume();
      });
    }
    const buf = await offline.startRendering();
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    let peak = 0, sum = 0;
    for (let i = 0; i < L.length; ++i) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
      sum += 0.5 * (L[i] * L[i] + R[i] * R[i]);
    }
    // the rendered buffer itself is the context's; only a copy is kept, and only when the samples will be taken
    if (keep) lastRender = { L: new Float32Array(L), R: new Float32Array(R) };
    health.renders += 1;
    health.renderMs += Date.now() - t0;
    health.frames += frames;
    return { frames: L.length, sampleRate, peak, rms: Math.sqrt(sum / Math.max(1, L.length)), events: haps.length, cps, waiting, waited,
             ms: Date.now() - t0 };
  } finally {
    rendering = false;
    Math.random = nativeRandom;
    sd.setAudioContext(live);
    sd.setSuperdoughAudioController(liveController);
  }
}

// a macrotask turn without setTimeout's clamping (lets superdough's 'ended' handlers run between render steps)
const yieldChannel = new MessageChannel();
const yieldQueue = [];
yieldChannel.port1.onmessage = () => { const r = yieldQueue.shift(); if (r) r(); };
function yieldTask() { return new Promise((r) => { yieldQueue.push(r); yieldChannel.port2.postMessage(0); }); }

function base64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

// ---------------------------------------------------------------- the events of a program (MIDI, checks)
const DRUM_ALIASES = { bd: 'bd', kick: 'bd', sd: 'sd', snare: 'sd', hh: 'hh', ch: 'hh', oh: 'oh', cp: 'cp', clap: 'cp',
  rim: 'rim', rs: 'rim', sh: 'sh', lt: 'lt', mt: 'mt', ht: 'ht', cr: 'cr', rd: 'rd', cb: 'cb', perc: 'perc', tom: 'lt' };
const SYNTHS = new Set(['sine', 'sin', 'sawtooth', 'saw', 'square', 'sqr', 'triangle', 'tri', 'supersaw', 'pulse',
  'white', 'pink', 'brown', 'crackle', 'zzfx', 'bytebeat', 'user']);

function midiOf(v) {
  if (typeof v.note === 'number') return v.note;
  if (typeof v.note === 'string') { try { return noteToMidi(v.note); } catch (e) { return null; } }
  if (typeof v.freq === 'number') return Math.round(69 + 12 * Math.log2(v.freq / 440));
  const s = v.s ?? v.sound;
  if (typeof v.n === 'number' && (s === undefined || SYNTHS.has(s))) return v.n + 60 * (s === undefined ? 0 : 0);
  return null;
}

function eventsOf(program, from, to, only) {
  const cps = program.cps || state.cps;
  const out = [];
  for (const l of program.layers) {
    if (only && !only.includes(l.name)) continue;
    const haps = l.pattern.queryArc(from, to, { _cps: cps });
    for (const h of haps) {
      if (!h.hasOnset()) continue;
      const v = typeof h.value === 'object' && h.value !== null ? h.value : { value: h.value };
      if (v.dbl) continue;   // a double or an echo of a note, not a note of its own
      const s = v.s ?? v.sound;
      const base = typeof s === 'string' ? s.split(':')[0] : undefined;
      const e = { layer: l.name, begin: h.whole.begin.valueOf(), end: h.whole.end.valueOf(), velocity: Math.max(0, Math.min(1, (v.velocity ?? 1) * (v.gain ?? 1))) };
      const m = midiOf(v);
      if (m !== null && m !== undefined && Number.isFinite(m)) e.midi = Math.round(m);
      else if (base !== undefined) e.drum = DRUM_ALIASES[base] ?? base;
      if (base !== undefined) e.s = base;
      const pan = typeof v.steerPan === 'number' ? v.steerPan : typeof v.pan === 'number' ? 2 * v.pan - 1 : null;
      if (pan !== null && Number.isFinite(pan)) e.pan = Math.round(pan * 100) / 100;
      out.push(e);
    }
  }
  out.sort((a, b) => a.begin - b.begin || a.layer.localeCompare(b.layer));
  return { events: out, cps };
}

// ---------------------------------------------------------------- the bridge
async function guard(f) {
  try { return { ok: true, ...(await f()) }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

const steer = {
  version: '1',
  async init({ kit = {}, gain = 1, muted = false } = {}) {
    return guard(async () => {
      await ensureScope();
      state.gain = gain;
      state.muted = muted;
      const names = Object.keys(kit);
      if (names.length) await sd.samples(kit);
      // warm up: the first render loads the worklets and the kit's samples, so every later render is the same
      const warm = `w: s("${names.length ? names.join(' ') : 'sine'}").room(0.2)\nx: note("c3").s("sawtooth").delay(0.2)`;
      const p = await compile(warm);
      p.cps = 1;
      await serial(() => renderOffline(p, { cycles: 1, sampleRate: 8000, keep: false }));
      return { sounds: Object.keys(sd.soundMap.get()).length };
    });
  },
  // the person's own samples (steer-sample://<id>/<file>, served by the app)
  async addSamples(map) {
    return guard(async () => { await sd.samples(map); return { sounds: Object.keys(sd.soundMap.get()).length }; });
  },
  // checks a program: its layers and tempo, or the error
  async check(code) {
    return guard(async () => {
      const p = await compile(code);
      return { layers: p.layers.map((l) => l.name), muted: p.muted, cps: p.cps };
    });
  },
  // a program to play: now when stopped, else from the next cycle
  async load(code) {
    return guard(async () => {
      const p = await compile(code);
      if (state.playing) {
        const at = Math.floor(cycleAt(ctx().currentTime + LOOKAHEAD)) + 1;
        state.pending = { program: p, at };
        return { layers: p.layers.map((l) => l.name), cps: p.cps, at };
      }
      state.program = p;
      if (p.cps) state.cps = p.cps;
      viz.kick();
      return { layers: p.layers.map((l) => l.name), cps: p.cps, at: 0 };
    });
  },
  async play() {
    return guard(async () => {
      if (!state.program) throw new Error('nothing loaded');
      // after any render under way (superdough's context is the render's until it ends), and in the same line as the
      // renders: superdough loads its worklets through one shared promise, so a render starting while the live
      // context's were loading got none of its own and rendered silent
      const ac = await serial(async () => {
        const live = ctx();
        if (typeof OfflineAudioContext !== 'undefined' && live instanceof OfflineAudioContext) throw new Error('the live audio context is not available');
        await sd.initAudio({ maxPolyphony: 128 });
        masterStereo(sd.getSuperdoughAudioController());
        return live;
      });
      if (ac.state !== 'running') await ac.resume();
      if (!state.playing) {
        state.anchorTime = ac.currentTime + 0.05;
        state.anchorCycle = 0;
        state.queried = 0;
        state.playing = true;
        state.timer = setInterval(tick, 25);
      }
      viz.kick();
      return {};
    });
  },
  async stop() {
    return guard(async () => {
      state.playing = false;
      clearInterval(state.timer);
      state.timer = null;
      state.pending = null;
      // never waits on a clock that never started (a resume still pending: no output device yet)
      try { await Promise.race([ctx().suspend(), new Promise((r) => setTimeout(r, 1000))]); } catch (e) { /* none */ }
      viz.kick();
      return {};
    });
  },
  hush() { state.program = null; state.pending = null; return steer.stop(); },
  setCps(c) {
    c = Number(c);
    if (!(c > 0)) return { ok: false, error: 'cps must be positive' };
    if (state.playing) setCpsAt(cycleAt(ctx().currentTime), c); else state.cps = c;
    if (state.program) state.program.cps = c;
    return { ok: true };
  },
  setGain(g) { state.gain = Math.max(0, Number(g)); return { ok: true }; },
  setMuted(m) { state.muted = !!m; return { ok: true }; },
  setLayer(name, { mute, solo, gain } = {}) {
    if (gain !== undefined) state.layerGain.set(name, Math.max(0, Number(gain)));
    if (mute !== undefined) mute ? state.mute.add(name) : state.mute.delete(name);
    if (solo !== undefined) solo ? state.solo.add(name) : state.solo.delete(name);
    return { ok: true, mute: [...state.mute], solo: [...state.solo] };
  },
  status() {
    const playing = state.playing;
    return { ok: true, playing, cycle: playing ? cycleAt(ctx().currentTime) : 0, cps: state.cps,
             layers: state.program ? state.program.layers.map((l) => l.name) : [], errors: state.log.slice(-5) };
  },
  async query(code, from = 0, to = 4, only = null) {
    return guard(async () => eventsOf(await compile(code), from, to, only));
  },
  async render(code, opts = {}) {
    return guard(async () => {
      const p = await compile(code);
      if (opts.cps) p.cps = opts.cps;
      return serial(() => renderOffline(p, opts));
    });
  },
  // the last render's samples: channel 0 / 1, frames [offset, offset + count), base64 little-endian float32
  take(channel, offset, count) {
    if (!lastRender) return { ok: false, error: 'nothing rendered' };
    const ch = channel ? lastRender.R : lastRender.L;
    const a = Math.max(0, offset | 0), b = Math.min(ch.length, a + (count | 0));
    return { ok: true, data: base64(ch.subarray(a, b)), count: b - a };
  },
  // the samples taken: the copy goes (a 5-minute bed is 110 MB of float32)
  drop() { lastRender = null; return { ok: true }; },
  // what the page holds (StrudelHost's health guard): renders done and their time, the kept samples, live state
  health() {
    return { ok: true, ...health, kept: lastRender ? lastRender.L.length * 8 : 0, waitingImpulses: waitingImpulses.size,
             playing: state.playing, loaded: !!state.program, viz: !!viz.stats().shown, video: videoOpen() };
  },
  sounds() { return { ok: true, sounds: Object.keys(sd.soundMap.get()).sort() }; },
  // the visuals (viz.mjs, docs/MUSIC_VIZ.md): show(look) / set(look) / hide() / stats(); snapshot(code, look, opts)
  // draws a program offscreen at a cycle (tests, previews: coverage, hash, PNG)
  viz: {
    views: VIEW_NAMES,
    palettes: Object.keys(PALETTES),
    show(look) { return viz.show(look); },
    set(look) { return viz.set(look); },
    hide() { return viz.hide(); },
    stats() { return viz.stats(); },
    async snapshot(code, look = {}, opts = {}) {
      return guard(async () => {
        const p = await compile(code);
        return vizSnapshot(p, p.cps || state.cps, look, opts);
      });
    },
    // Share as video: a virtual clock over the loop, frame by frame (JPEG + hash), then end (frees the canvases)
    async videoBegin(code, look = {}, opts = {}) {
      return guard(async () => {
        const p = await compile(code);
        return videoBegin(p, opts.cps || p.cps || state.cps, look, opts);
      });
    },
    async videoFrame(i, quality) { return guard(async () => videoFrame(i, quality)); },
    async videoFrames(from, count, quality) { return guard(async () => videoFrames(from, count, quality)); },
    async videoEnd() { return guard(async () => videoEnd()); },
    async bench(code, look = {}, opts = {}) {
      return guard(async () => {
        const p = await compile(code);
        return vizBench(p, p.cps || state.cps, look, opts);
      });
    },
  },
};

// the visuals see what plays: the program (the pending one from its cycle on), the music's cycle at the speakers (the
// output latency taken off, so a hit is drawn when it is heard), the mixer and superdough's master
const viz = makeViz({
  program: () => (state.pending && state.playing && cycleAt(ctx().currentTime) >= state.pending.at ? state.pending.program : state.program),
  cycle: () => {
    if (!state.playing) return 0;
    const ac = ctx();
    return Math.max(0, cycleAt(ac.currentTime - (ac.outputLatency || ac.baseLatency || 0)));
  },
  playing: () => state.playing,
  cps: () => state.cps,
  mix: () => ({ mute: state.mute, solo: state.solo }),
  master: () => { try { return sd.getSuperdoughAudioController().output.destinationGain; } catch (e) { return null; } },
});

window.steer = steer;
