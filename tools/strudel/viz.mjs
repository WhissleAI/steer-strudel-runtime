// Steer's music visuals (docs/MUSIC_VIZ.md), in the same offline page as the Strudel runtime and drawn from the events
// the player is actually playing. Pattern views use Strudel's own drawing code (@strudel/draw, AGPL-3.0-or-later, the
// same 1.2.x line as the runtime): Piano roll (pianoroll), Pulse (punchcard) and Spiral (spiral), each lane in its own
// colour, plus Scope (the master's waveform and spectrum). The Scene layer is our own Three.js scenes (scene3d.mjs →
// scene.js, loaded only when a scene is shown), driven by onsets per lane group, bar and section lines, with the
// master's AnalyserNode as a secondary source. Budgets (the host passes the frame cap and shows the panel only while it
// is visible): no frames while hidden or stopped (one still frame), the GPU and the analyser released on hide.
import { pure, noteToMidi } from '@strudel/core';
import { __pianoroll, getPunchcardPainter } from '@strudel/draw';

// ---------------------------------------------------------------- palettes: curated, three or four per mood (VizPlan's
// `palette(forMood:seed:)` picks one); saturation and lightness still follow the look's colourfulness and brightness
export const PALETTES = {
  // happy: warm golds and corals
  gold:     ['#FFC857', '#FF9F43', '#FFE29A', '#F7B267', '#FFD166', '#E9A03B'],
  coral:    ['#FF6F61', '#FFA07A', '#FFC3A0', '#FF8C69', '#F67280', '#FFB088'],
  warm:     ['#FF8A3D', '#FFB347', '#FF5E5B', '#FFD166', '#FF7B54', '#F9A03F'],
  sunset:   ['#FF5E78', '#FF9A5A', '#C850C0', '#FFC371', '#F45C8A', '#FF7E5F'],
  // sad / dark: deep blues
  midnight: ['#3A7BFF', '#5AA9FF', '#7F5CFF', '#2DD4FF', '#4458FF', '#A0C4FF'],
  deepsea:  ['#0FA3B1', '#1E6FD9', '#4CC9F0', '#5A3CF0', '#4361EE', '#7DE2FC'],
  dusk:     ['#8E7CFF', '#C77DFF', '#5E8BFF', '#FF7AB6', '#7B61FF', '#56CCF2'],
  // dreamy: lavender haze
  lavender: ['#C3A6FF', '#E0C3FC', '#9D8DF1', '#F1C0E8', '#B8C0FF', '#CDB4DB'],
  haze:     ['#D4C1EC', '#F2D7EE', '#A9DEF9', '#E4C1F9', '#D3F8E2', '#F6C6EA'],
  pastel:   ['#F8B5C8', '#B5D8F8', '#C8F0C0', '#FBE3A7', '#D7C2F5', '#FFCBA4'],
  // party: saturated neon
  neon:     ['#FF2BD6', '#00F0FF', '#B6FF00', '#FFE600', '#FF3D7F', '#3D8BFF'],
  electric: ['#7CFF00', '#00E5FF', '#FF00E5', '#FFEA00', '#00FF9C', '#A04CFF'],
  // calm
  ocean:    ['#29B6F6', '#26C6DA', '#1DE9B6', '#5C9DFF', '#00ACC1', '#80DEEA'],
  mist:     ['#A8DADC', '#CDE7E8', '#89C2D9', '#B8E0D2', '#D6EADF', '#95B8D1'],
  forest:   ['#66BB6A', '#9CCC65', '#26A69A', '#D4E157', '#43A047', '#A5D6A7'],
  cool:     ['#4FC3F7', '#4DD0C9', '#7986CB', '#9575CD', '#64B5F6', '#5C6BC0'],
  mono:     ['#E8EEF6', '#C9D3E0', '#AAB6C6', '#8C99AC', '#D8E0EA', '#B8C3D2'],
  // the redesign's own: mint, gold and Steer's greens on the green-black stage (Android's build adds the same entry)
  steer:    ['#7FD9C2', '#E7A93A', '#4FB89E', '#ACEDDC', '#F1F0F0', '#1C9AA2'],
};

const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
const hsl = (h, s, l, a = 1) => `hsl(${Math.round(((h % 360) + 360) % 360)} ${Math.round(clamp01(s) * 100)}% ${Math.round(clamp01(l) * 100)}%${a < 1 ? ` / ${a.toFixed(3)}` : ''})`;

/** The colours of a look: background, ink, grid, glass, and one colour per lane (cycled). `shift`: degrees of hue the
 *  section moves the palette by (eased by the caller). */
export function colours(look, shift = 0) {
  const p = PALETTES[look.palette] ?? PALETTES.cool;
  const dark = look.dark !== false;
  const sat = 0.3 + 0.85 * clamp01(look.colorfulness ?? 0.6);
  const lift = (clamp01(look.brightness ?? 0.5) - 0.5) * 0.36;
  const hs = p.map(hexToHsl);
  const L = (l) => (dark ? Math.min(0.72, l) + lift : Math.min(l, 0.58) - 0.08 + lift);
  const lanes = hs.map(([h, s, l]) => hsl(h + shift, s * sat, L(l)));
  const [h0, s0] = hs[0];
  const bgL = dark ? 0.045 + 0.05 * clamp01(look.brightness ?? 0.5) : 0.965 - 0.04 * (1 - clamp01(look.brightness ?? 0.5));
  return {
    bg: hsl(h0 + shift, Math.min(0.22, s0 * 0.25), bgL),
    ink: dark ? 'rgba(255,255,255,0.88)' : 'rgba(12,14,22,0.85)',
    soft: dark ? 'rgba(255,255,255,0.55)' : 'rgba(12,14,22,0.5)',
    grid: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)',
    strong: dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.16)',
    glass: dark ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.55)',
    glassEdge: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
    lanes, laneHsl: hs.map(([h, s, l]) => [h + shift, s * sat, L(l)]), dark,
  };
}

// ---------------------------------------------------------------- lanes → the five groups the Scene reacts to

export const GROUPS = ['kick', 'snare', 'hats', 'bass', 'keys'];
const DRUM_GROUP = { bd: 'kick', kick: 'kick', sd: 'snare', snare: 'snare', cp: 'snare', clap: 'snare', rim: 'snare', hh: 'hats',
  oh: 'hats', sh: 'hats', cr: 'hats', rd: 'hats', cb: 'hats', perc: 'hats', lt: 'snare', mt: 'snare', ht: 'snare', tom: 'snare' };
const ROLE_GROUP = { kick: 'kick', snare: 'snare', hats: 'hats', perc: 'hats', bass: 'bass', chords: 'keys', pad: 'keys', lead: 'keys', arp: 'keys' };

function groupOf(e, roles) {
  const r = roles?.[e.layer];
  if (r && ROLE_GROUP[r]) return ROLE_GROUP[r];
  const s = e.v.s ?? e.v.sound;
  if (typeof s === 'string' && DRUM_GROUP[s.split(':')[0]]) return DRUM_GROUP[s.split(':')[0]];
  const n = e.layer.toLowerCase();
  if (/kick|bd/.test(n)) return 'kick';
  if (/snare|clap|sd/.test(n)) return 'snare';
  if (/hat|hh|perc|shaker/.test(n)) return 'hats';
  if (/bass|sub|808/.test(n)) return 'bass';
  return 'keys';
}

// ---------------------------------------------------------------- the events a frame shows (cached per bar window)

function queryEvents(program, from, to, cps, roles) {
  const out = [];
  if (!program) return out;
  program.layers.forEach((l, i) => {
    let haps;
    try { haps = l.pattern.queryArc(from, to, { _cps: cps }); } catch (e) { return; }
    for (const h of haps) {
      if (!h.hasOnset()) continue;
      const v = typeof h.value === 'object' && h.value !== null ? h.value : { value: h.value };
      const e = { layer: l.name, i, begin: h.whole.begin.valueOf(), end: h.whole.end.valueOf(), v, hap: h };
      e.group = groupOf(e, roles);
      const nv = v.note ?? v.n;
      if (typeof nv === 'number') e.midi = nv; else if (typeof nv === 'string') { try { e.midi = noteToMidi(nv); } catch (x) { /* not a note */ } }
      else if (typeof v.freq === 'number') e.midi = Math.round(69 + 12 * Math.log2(v.freq / 440));
      e.pitched = v.note !== undefined || v.freq !== undefined || (typeof v.n === 'number' && !(typeof (v.s ?? v.sound) === 'string' && DRUM_GROUP[(v.s ?? v.sound).split(':')[0]]));
      out.push(e);
    }
  });
  return out;
}

class EventCache {
  get(program, from, to, cps, roles) {
    const a = Math.floor(from) - 1, b = Math.ceil(to) + 1;
    const key = `${a}:${b}:${cps}`;
    if (this.program !== program || this.key !== key || this.roles !== roles) {
      this.program = program; this.key = key; this.roles = roles;
      this.events = queryEvents(program, a, b, cps, roles);
    }
    return this.events;
  }
}

// ---------------------------------------------------------------- lane emphasis: heard (mixer), and how much the look
// reacts to that lane's group ("sync it to the drums" raises the drums' reactivity and lowers the rest)

function emphasis(look, e, mix) {
  const heard = !(mix?.mute?.has(e.layer)) && !(mix?.solo?.size && !mix.solo.has(e.layer));
  const r = clamp01(look.react?.[e.group] ?? 0.6);
  return (heard ? 1 : 0.18) * (0.3 + 0.7 * r) * (0.45 + 0.55 * clamp01(look.energy ?? 0.6));
}

function coloured(look, c, ev, mix) {
  return ev.map((e) => e.hap.withValue(() => ({ ...e.v, color: c.lanes[e.i % c.lanes.length],
    velocity: emphasis(look, e, mix), gain: Math.max(0.5, Math.min(1, e.v.gain ?? 1)) })));
}

function barLines(ctx, W, H, c, from, to, x0 = 0, per = 4) {
  const px = (W - x0) / (to - from);
  ctx.lineWidth = 1;
  for (let k = Math.ceil(from * per) / per; k < to; k += 1 / per) {
    ctx.strokeStyle = Math.abs(k - Math.round(k)) < 1e-6 ? c.strong : c.grid;
    const x = Math.round(x0 + (k - from) * px) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
}

// ---------------------------------------------------------------- the pattern views (device pixels, identity transform)
// Notes and hits are drawn on a layer, and the layer's lit parts are blurred at quarter size and added back: a cheap,
// soft glow (canvas 2D, no filter on the full frame).

const FONT = '-apple-system, "SF Pro Display", "SF Pro Text", system-ui, Roboto, "Segoe UI", sans-serif';
const layers = new Map();
function layer(name, W, H) {
  let c = layers.get(name);
  if (!c) { c = document.createElement('canvas'); layers.set(name, c); }
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  return c;
}
/** Frees the views' layers (on hide). */
export function freeLayers() { for (const c of layers.values()) { c.width = 0; c.height = 0; } layers.clear(); spiralPainters.clear(); }

function glow(ctx, lit, W, H, strength) {
  if (strength <= 0.01) return;
  const w = Math.max(1, Math.round(W / 4)), h = Math.max(1, Math.round(H / 4));
  const s = layer('glow', w, h), sc = s.getContext('2d');
  sc.clearRect(0, 0, w, h);
  if ('filter' in sc) sc.filter = `blur(${Math.max(2, Math.round(Math.min(w, h) / 60))}px)`;
  sc.drawImage(lit, 0, 0, w, h);
  if ('filter' in sc) sc.filter = 'none';
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(1, strength);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s, 0, 0, W, H);
  ctx.drawImage(s, 0, 0, W, H);
  ctx.restore();
}

function rr(ctx, x, y, w, h, r) {
  if (w <= 0 || h <= 0) return;
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

function laneCol(c, i, a = 1, dl = 0) {
  const [h, s, l] = c.laneHsl[i % c.laneHsl.length];
  return hsl(h, s, l + dl, a);
}

/** A soft vertical light at x (the playhead). */
function playhead(ctx, x, top, h, W, c, k = 1) {
  const w = Math.max(12, W * 0.035);
  const g = ctx.createLinearGradient(x - w, 0, x + w, 0);
  const a = (c.dark ? 0.16 : 0.12) * k;
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, c.dark ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 0.6})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - w, top, 2 * w, h);
  ctx.fillStyle = c.dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)';
  ctx.fillRect(Math.round(x) - 1, top, 2, h);
}

/** The seconds since an event began (negative before), for decays in real time whatever the tempo. */
const since = (t, e, cps) => (t - e.begin) / Math.max(0.01, cps);

/** Piano roll: rounded, softly glowing notes on a pitch axis (the pitched lanes; the drums' own rows when there are
 *  none), a colour per lane; a note brightens and swells at its onset and stays lit while it sounds; a soft light for
 *  the playhead at a quarter of the width; bar lines faint behind. Reduce Motion: a still page, the playhead moving. */
function pianoRoll(ctx, W, H, t, ev, look, c, mix, audio, fx) {
  const cps = fx.cps ?? 0.5;
  const cycles = 2 + Math.round(6 * clamp01(look.density ?? 0.5));
  const ph = 0.25;
  let from = t - cycles * ph, headX = ph * W;
  if (look.reduceMotion) { from = Math.floor(t / cycles) * cycles; headX = ((t - from) / cycles) * W; }
  const to = from + cycles;
  const inView = ev.filter((e) => e.end > from && e.begin < to);
  const pitched = inView.filter((e) => e.pitched);
  const notes = pitched.length ? pitched : inView;
  const key = (e) => (pitched.length ? Number(e.v.note ?? e.v.n ?? 0) : e.layer + ':' + (e.v.s ?? ''));
  let rows;
  if (pitched.length) {
    let lo = Infinity, hi = -Infinity;
    for (const e of pitched) { const m = e.midi ?? key(e); lo = Math.min(lo, m); hi = Math.max(hi, m); }
    lo -= 2; hi += 2;
    rows = { n: hi - lo + 1, of: (e) => hi - (e.midi ?? key(e)) };
  } else {
    const ks = [...new Set(notes.map(key))].sort();
    rows = { n: Math.max(1, ks.length), of: (e) => ks.indexOf(key(e)) };
  }
  const pad = H * 0.08, rh = (H - 2 * pad) / rows.n;
  const nh = Math.max(3, Math.min(rh * 0.78, H * 0.06));
  const px = W / cycles;
  // bar lines
  ctx.lineWidth = 1;
  for (let k = Math.ceil(from); k < to; k++) { ctx.strokeStyle = c.grid; const x = Math.round((k - from) * px) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  const lit = layer('lit', W, H), lc = lit.getContext('2d');
  lc.clearRect(0, 0, W, H);
  for (const e of notes) {
    const a = emphasis(look, e, mix);
    const x = (e.begin - from) * px, w = Math.max(nh, (e.end - e.begin) * px - 3);
    const s = since(t, e, cps);
    const on = e.begin <= t && e.end > t;
    const pulse = s >= 0 && s < 0.6 ? Math.exp(-s / 0.18) : 0;
    const h = nh * (1 + 0.35 * pulse);
    const y = pad + (rows.of(e) + 0.5) * rh - h / 2;
    ctx.globalAlpha = 1;
    rr(ctx, x + 1, y, w, h, h / 2);
    ctx.fillStyle = laneCol(c, e.i, (on ? 0.95 : s > 0 ? 0.42 : 0.6) * a, on ? 0.12 : 0);
    ctx.fill();
    if (on || pulse > 0.05) {
      rr(lc, x + 1, y, w, h, h / 2);
      lc.fillStyle = laneCol(c, e.i, Math.min(1, (0.55 + 0.45 * pulse) * a), 0.15);
      lc.fill();
    }
  }
  ctx.globalAlpha = 1;
  ctx.drawImage(lit, 0, 0);
  glow(ctx, lit, W, H, (0.6 + 0.9 * clamp01(look.glow ?? 0.5)) * (c.dark ? 1 : 0.5));
  playhead(ctx, headX, 0, H, W, c);
}

/** Pulse: the bar (two at high density) as a grid of rounded cells on a dark glass panel, one row per lane. A hit lights
 *  its cell with a glow that decays over ~150–400 ms; a sustained note is a pill that fills as it plays; the playhead is
 *  a soft sweep of light. Layout after Strudel's punchcard; drawn here (rounded, glowing). */
function pulse(ctx, W, H, t, ev, look, c, mix, audio, fx) {
  const cps = fx.cps ?? 0.5;
  const span = (look.density ?? 0.5) > 0.66 ? 2 : 1;
  const from = Math.floor(t / span) * span, to = from + span;
  const lanes = fx.lanes ?? [...new Set(ev.map((e) => e.layer))];
  const n = Math.max(1, lanes.length);
  const m = Math.round(Math.min(W, H) * 0.045);
  const labelW = Math.min(W * 0.16, 130 * (W / 960 + 0.4));
  const px0 = m, py0 = m, pw = W - 2 * m, phh = H - 2 * m;
  // the glass panel
  rr(ctx, px0, py0, pw, phh, Math.min(28, m * 0.9));
  ctx.fillStyle = c.glass; ctx.fill();
  const hi = ctx.createLinearGradient(0, py0, 0, py0 + phh * 0.5);
  hi.addColorStop(0, c.dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.5)'); hi.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hi; ctx.fill();
  ctx.strokeStyle = c.glassEdge; ctx.lineWidth = 1; ctx.stroke();
  const gx = px0 + labelW, gw = pw - labelW - m * 0.6, gy = py0 + m * 0.6, gh = phh - m * 1.2;
  const steps = 16 * span, cw = gw / steps, rh = gh / n;
  const cell = Math.min(cw, rh) * 0.72;
  const lit = layer('lit', W, H), lc = lit.getContext('2d');
  lc.clearRect(0, 0, W, H);
  ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.font = `600 ${Math.round(Math.max(10, Math.min(18, rh * 0.28)))}px ${FONT}`;
  lanes.forEach((lane, r) => {
    const cy = gy + (r + 0.5) * rh;
    const li = fx.laneIndex ? fx.laneIndex(lane) : r;
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.soft;
    ctx.fillText(lane.toUpperCase(), px0 + m * 0.6, cy);
    // the empty step cells
    ctx.fillStyle = c.grid;
    for (let k = 0; k < steps; k++) { rr(ctx, gx + k * cw + (cw - cell) / 2, cy - cell / 2, cell, cell, cell * 0.28); ctx.fill(); }
    for (const e of ev) {
      if (e.layer !== lane || e.end <= from || e.begin >= to) continue;
      const a = emphasis(look, e, mix);
      const s = since(t, e, cps);
      const x0 = gx + ((Math.max(e.begin, from) - from) / span) * gw;
      const len = ((Math.min(e.end, to) - Math.max(e.begin, from)) / span) * gw;
      const sustained = e.pitched && len > cw * 1.6;
      if (sustained) {
        // a pill that fills as it plays
        const ph = cell * 0.62, w = len - (cw - cell);
        const x = x0 + (cw - cell) / 2;
        rr(ctx, x, cy - ph / 2, w, ph, ph / 2);
        ctx.fillStyle = laneCol(c, li, 0.22 * a); ctx.fill();
        const f = clamp01((t - e.begin) / Math.max(1e-6, e.end - e.begin));
        if (f > 0) {
          rr(ctx, x, cy - ph / 2, w * f, ph, ph / 2);
          ctx.fillStyle = laneCol(c, li, (e.end > t ? 0.95 : 0.5) * a, e.end > t ? 0.1 : 0); ctx.fill();
          if (e.end > t) { rr(lc, x, cy - ph / 2, w * f, ph, ph / 2); lc.fillStyle = laneCol(c, li, 0.8 * a, 0.15); lc.fill(); }
        }
      } else {
        const x = x0 + (cw - cell) / 2;
        const g = s >= 0 ? Math.exp(-s / 0.22) : 0;   // ~150–400 ms of glow after the hit
        rr(ctx, x, cy - cell / 2, cell, cell, cell * 0.28);
        ctx.fillStyle = laneCol(c, li, (0.3 + 0.7 * g) * a * (s < 0 ? 0.8 : 1), 0.12 * g); ctx.fill();
        if (g > 0.03) {
          const grow = cell * 0.12 * g;
          rr(lc, x - grow, cy - cell / 2 - grow, cell + 2 * grow, cell + 2 * grow, cell * 0.32);
          lc.fillStyle = laneCol(c, li, g * a, 0.2); lc.fill();
        }
      }
    }
  });
  ctx.globalAlpha = 1;
  ctx.drawImage(lit, 0, 0);
  glow(ctx, lit, W, H, (0.7 + 0.9 * clamp01(look.glow ?? 0.5)) * (c.dark ? 1 : 0.5));
  playhead(ctx, gx + ((t - from) / span) * gw, gy - m * 0.3, gh + m * 0.6, W, c, 0.9);
}

/** Spiral: @strudel/draw's spiral (a cycle a turn, now at the top, the future winding out and fading), with glow. */
const spiralPainters = new Map();
function spiral(ctx, W, H, t, ev, look, c, mix) {
  const ahead = 1 + 3 * clamp01(look.density ?? 0.5);
  const inset = 1;
  const size = (Math.min(W, H) * 0.8) / (inset + ahead);
  const key = `${Math.round(size)}:${c.ink}:${look.reduceMotion ? 1 : 0}`;
  let paint = spiralPainters.get(key);
  if (!paint) {
    paint = pure(0).spiral({ size, thickness: size * 0.42, inset, steady: look.reduceMotion ? 1 : 0.94, playheadColor: c.ink,
                             playheadThickness: size * 0.1, playheadLength: 0.015, fade: 1, colorizeInactive: 1, cap: 'round' }).getPainters()[0];
    if (spiralPainters.size > 8) spiralPainters.clear();
    spiralPainters.set(key, paint);
  }
  const inView = ev.filter((e) => e.end > t - 0.5 && e.begin < t + ahead);
  // Strudel's spiral clears its whole canvas first: drawn on a layer of its own, then laid over the background
  const lay = layer('lit', W, H);
  paint(lay.getContext('2d'), t, coloured(look, c, inView, mix), [-0.5, ahead]);
  ctx.drawImage(lay, 0, 0);
  glow(ctx, lay, W, H, (0.12 + 0.25 * clamp01(look.glow ?? 0.5)) * (c.dark ? 1 : 0.4));
}

/** Scope (the redesign canvas's stage): three layered waves over a subtle grid, with glow: the lead (the pitched upper
 *  parts), the bass and the mix, each in its own palette colour. Playing: the mix wave is the master's waveform, the
 *  lead and bass waves follow their parts' notes and the master's level; silent (stopped, muted): all three follow the
 *  notes sounding now, so the view still moves with the pattern. Energy sets the height, motion the drift, density how
 *  many cycles cross the stage, glow the bloom. */
function scope(ctx, W, H, t, ev, look, c, mix, audio) {
  const mid = H * 0.5, energy = clamp01(look.energy ?? 0.6), motion = clamp01(look.motion ?? 0.5);
  const amp = H * (0.16 + 0.22 * energy);
  // the grid: quarter lines across, eighth lines down, very quiet
  ctx.save();
  ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 1; k < 8; ++k) { const x = Math.round((k / 8) * W) + 0.5; ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let k = 1; k < 4; ++k) { const y = Math.round((k / 4) * H) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  ctx.restore();
  const sounding = ev.filter((e) => e.begin <= t && e.end > t);
  const env = (group) => {   // how strongly a group sounds now (0…1)
    let v = 0;
    for (const e of sounding) if (group(e)) v = Math.max(v, Math.exp(-3 * Math.max(0, t - e.begin)) * Math.min(1, (e.v.gain ?? 1) * 1.2));
    return v;
  };
  const isBass = (e) => e.group === 'bass';
  const isLead = (e) => e.pitched && e.group !== 'bass';
  const live = audio && audio.level > 0.002;
  const level = live ? Math.min(1, audio.level * 6) : 0;
  const pitch = (group, dflt) => {   // the sounding notes' pitch class, as a wave's cycles across the stage
    const e = sounding.find(group);
    return e ? 1.2 + ((Number(e.v.note ?? e.v.n) || 0) % 12) / 6 : dflt;
  };
  const cycles = 2 + 3 * clamp01(look.density ?? 0.5);
  const drift = t * (0.6 + 1.6 * motion);
  const waves = [
    { col: 2, k: 0.55 + 0.45 * Math.max(env(isBass), level * 0.8), f: cycles * 0.5 * pitch(isBass, 1), ph: drift * 0.7, w: 1.0 },
    { col: 1, k: 0.5 + 0.5 * Math.max(env(isLead), level * 0.7), f: cycles * pitch(isLead, 1.4), ph: -drift * 1.1 + 1.3, w: 1.15 },
    { col: 0, k: 0.75 + 0.25 * Math.max(env(() => true), level), f: cycles * 0.75, ph: drift + 0.4, w: 1.4, master: live },
  ];
  const lit = layer('lit', W, H), lc = lit.getContext('2d');
  lc.clearRect(0, 0, W, H);
  const lw = Math.max(2, H / 110) * (1 + 0.6 * clamp01(look.glow ?? 0.5));
  for (const wv of waves) {
    lc.beginPath();
    if (wv.master) {
      const d = audio.time, N = d.length;
      let k0 = 0;
      for (let i = 1; i < N / 2; ++i) if (d[i - 1] < 0 && d[i] >= 0) { k0 = i; break; }
      const M = Math.min(N - k0, N / 2);
      for (let i = 0; i < M; ++i) {
        const x = (i / (M - 1)) * W, y = mid - (d[k0 + i] * 2.4 * 0.6 + 0.4 * Math.sin((i / M) * Math.PI * 2 * wv.f + wv.ph)) * amp * wv.k;
        i ? lc.lineTo(x, y) : lc.moveTo(x, y);
      }
    } else {
      const n = 240;
      for (let i = 0; i <= n; ++i) {
        const u = i / n;
        // a breathing envelope so the waves swell and cross rather than run as rails
        const swell = 0.75 + 0.25 * Math.sin(u * Math.PI * 2 * 0.5 + wv.ph * 0.3);
        const y = mid - Math.sin(u * Math.PI * 2 * wv.f + wv.ph) * amp * wv.k * swell * (wv.col === 0 ? 1 : wv.col === 1 ? 0.62 : 0.32);
        i ? lc.lineTo(u * W, y) : lc.moveTo(0, y);
      }
    }
    lc.strokeStyle = laneCol(c, wv.col, 1, -0.04);
    lc.lineWidth = lw * wv.w; lc.lineCap = 'round'; lc.lineJoin = 'round';
    lc.stroke();
  }
  ctx.drawImage(lit, 0, 0);
  // a soft bloom: the waves keep their colours (a strong 'lighter' glow washes them to white)
  glow(ctx, lit, W, H, (0.18 + 0.32 * clamp01(look.glow ?? 0.5)) * (c.dark ? 1 : 0.45));
  ctx.globalAlpha = 1;
}

const VIEWS = { pianoroll: pianoRoll, pulse, spiral, scope };
export const VIEW_NAMES = ['pianoroll', 'pulse', 'spiral', 'scope', 'scene'];

/** A pattern view (or nothing for the Scene) over the background (`opaque`) or a scene (transparent). fx: {cps, shift
 *  (the section's eased hue shift), labelAlpha (the section label's eased fade), lanes, laneIndex, parallax}. */
export function drawPattern(ctx, W, H, t, ev, look, mix, audio, opaque, transition, fx = {}) {
  const c = colours(look, fx.shift ?? 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (opaque) {
    ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H);
    // a little depth even without a scene: a soft pool of the palette's first colour
    const g = ctx.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, Math.max(W, H) * 0.7);
    g.addColorStop(0, laneCol(c, 0, c.dark ? 0.1 : 0.08)); g.addColorStop(1, laneCol(c, 0, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  } else ctx.clearRect(0, 0, W, H);
  const draw = VIEWS[look.view];
  if (draw) {
    if (!opaque) { ctx.fillStyle = c.dark ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.3)'; ctx.fillRect(0, 0, W, H); }
    // gentle parallax over a scene: the notes float a few pixels against the scene's drift
    const par = !opaque && !look.reduceMotion ? (fx.parallax ?? 0) : 0;
    if (par) ctx.translate(Math.sin(t * 0.37) * W * 0.006 * par, Math.cos(t * 0.29) * H * 0.006 * par);
    draw(ctx, W, H, t, ev, look, c, mix, audio, fx);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  // a section line in the 2D views: the look's transition, eased (the Scene draws its own)
  if (transition && draw) {
    const k = transition.k * transition.k * (3 - 2 * transition.k);   // smoothstep easing
    ctx.globalAlpha = 1;
    if (transition.kind === 'burst') { ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = laneCol(c, 0, 0.35 * k, 0.2); ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; }
    else if (transition.kind === 'fade') { ctx.fillStyle = c.bg; ctx.globalAlpha = 0.75 * k; ctx.fillRect(0, 0, W, H); }
    else if (transition.kind === 'sweep') { const x = (1 - k) * W * 1.2 - W * 0.1; const g = ctx.createLinearGradient(x - W * 0.1, 0, x + W * 0.1, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, `rgba(255,255,255,${0.35 * k})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
  }
  // the section's name, top right, fading in after a change
  if (look.section && H > 80) {
    ctx.globalAlpha = 0.75 * (fx.labelAlpha ?? 1);
    ctx.fillStyle = c.ink;
    ctx.font = `600 ${Math.round(Math.max(11, Math.min(34, H / 24)))}px ${FONT}`;
    ctx.textBaseline = 'top'; ctx.textAlign = 'right';
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.08em';
    ctx.fillText(look.section.toUpperCase(), W - Math.round(H * 0.035), Math.round(H * 0.035));
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }
  ctx.restore();
  return c;
}

// ---------------------------------------------------------------- the event stream → per-group envelopes

/** Onsets per group in (from, to] cycles; envelopes decay at `rate` per second. */
export function driveFrom(ev, from, to, env, dt, rate = 7) {
  const onsets = {};
  for (const g of GROUPS) env[g] = (env[g] ?? 0) * Math.exp(-dt * rate);
  for (const e of ev) {
    if (e.begin > from && e.begin <= to) {
      const v = Math.max(0.45, Math.min(1, (e.v.velocity ?? 1) * (e.v.gain ?? 1) * 1.6));
      env[e.group] = Math.max(env[e.group] ?? 0, v);
      onsets[e.group] = Math.max(onsets[e.group] ?? 0, v);
    }
  }
  return onsets;
}

// ---------------------------------------------------------------- Three.js (scene.js, loaded on first use)

let sceneModule = null;
function loadScene() {
  if (window.SteerScene3D) return Promise.resolve(window.SteerScene3D);
  if (!sceneModule) {
    sceneModule = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'scene.js';
      s.onload = () => (window.SteerScene3D ? resolve(window.SteerScene3D) : reject(new Error('scene.js loaded nothing')));
      s.onerror = () => { sceneModule = null; reject(new Error('scene.js is missing')); };
      document.head.appendChild(s);
    });
  }
  return sceneModule;
}

/** The hue shift a section gives the palette (a tasteful colour change at section lines, eased by the caller). */
export function sectionShift(section) {
  if (!section) return 0;
  let h = 0;
  for (const ch of String(section)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return [0, 14, -14, 8][h % 4];
}

const needsScene = (look) => look.view === 'scene' || (look.scene && look.scene !== 'none');

// ---------------------------------------------------------------- the live panel

export const DEFAULT_LOOK = { view: 'pianoroll', scene: 'none', palette: 'cool', energy: 0.6, motion: 0.5, density: 0.5, glow: 0.5,
  drift: 0.3, colorfulness: 0.6, brightness: 0.5, react: { kick: 0.6, snare: 0.6, hats: 0.6, bass: 0.6, keys: 0.6 }, transition: 'fade',
  section: '', dark: true, reduceMotion: false, fps: 30, lanes: {} };

function merge(a, b) { return { ...a, ...b, react: { ...(a.react ?? {}), ...(b.react ?? {}) } }; }

/** The visuals bound to a player: host gives the program playing, the cycle now, playing?, cps, the mixer and the master. */
export function makeViz(host) {
  const v = {
    look: { ...DEFAULT_LOOK }, shown: false, canvas: null, ctx: null, gl: null, scene3d: null, sceneLoading: null, raf: 0,
    last: 0, lastT: null, lastWall: 0, frames: 0, drawMs: 0, analyser: null, buffers: null, cache: new EventCache(),
    env: {}, transition: null, prevSection: null, dpr: 1, error: null, shift: 0, labelAlpha: 1,
  };

  // ---- the analyser on the master (made on show, released on hide)
  function tap() {
    if (v.analyser) return;
    try {
      const out = host.master();
      if (!out) return;
      const an = out.context.createAnalyser();
      an.fftSize = 1024; an.smoothingTimeConstant = 0.7;
      out.connect(an);
      v.analyser = an;
      v.buffers = { time: new Float32Array(an.fftSize), freq: new Uint8Array(an.frequencyBinCount) };
    } catch (e) { v.analyser = null; }
  }
  function untap() {
    if (!v.analyser) return;
    try { host.master()?.disconnect(v.analyser); } catch (e) { /* gone */ }
    v.analyser = null; v.buffers = null;
  }
  function audio() {
    if (!v.analyser || !host.playing()) return null;
    const b = v.buffers;
    v.analyser.getFloatTimeDomainData(b.time);
    v.analyser.getByteFrequencyData(b.freq);
    let s = 0; for (let i = 0; i < b.time.length; ++i) s += b.time[i] * b.time[i];
    const n = b.freq.length, band = (lo, hi) => { let x = 0; for (let i = lo; i < hi; ++i) x += b.freq[i]; return x / Math.max(1, hi - lo) / 255; };
    return { time: b.time, freq: b.freq, level: Math.sqrt(s / b.time.length),
             bands: [band(1, Math.floor(n * 0.03)), band(Math.floor(n * 0.03), Math.floor(n * 0.2)), band(Math.floor(n * 0.2), Math.floor(n * 0.6))] };
  }

  // ---- canvases: the scene's (WebGPU / WebGL, only while a scene shows) under the pattern's (2D)
  function mount() {
    if (v.canvas) return;
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';
    const cv = document.createElement('canvas');
    cv.id = 'steer-viz';
    cv.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;z-index:2';
    document.body.appendChild(cv);
    v.canvas = cv;
    v.ctx = cv.getContext('2d');
    v.resize = () => size();
    window.addEventListener('resize', v.resize);
    v.onVisibility = () => { if (hidden()) stopLoop(); else kick(); };
    document.addEventListener('visibilitychange', v.onVisibility);
    size();
  }
  function size() {
    if (!v.canvas) return;
    v.dpr = Math.min(window.devicePixelRatio || 1, v.look.fps > 30 ? 2 : 1.5);
    const W = Math.max(1, Math.round(window.innerWidth * v.dpr)), H = Math.max(1, Math.round(window.innerHeight * v.dpr));
    if (v.canvas.width !== W || v.canvas.height !== H) { v.canvas.width = W; v.canvas.height = H; }
    v.scene3d?.resize(window.innerWidth, window.innerHeight, v.dpr);
    paint();
  }
  function unmount() {
    if (!v.canvas) return;
    window.removeEventListener('resize', v.resize);
    document.removeEventListener('visibilitychange', v.onVisibility);
    v.canvas.width = 0; v.canvas.height = 0;   // the backing store goes now, not at the next GC
    v.canvas.remove();
    v.canvas = null; v.ctx = null;
  }
  async function ensureScene() {
    if (v.scene3d || v.sceneLoading) return v.sceneLoading;
    v.sceneLoading = (async () => {
      try {
        const mod = await loadScene();
        if (!v.shown || !needsScene(v.look)) return;
        const gl = document.createElement('canvas');
        gl.id = 'steer-scene';
        gl.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;z-index:1';
        document.body.insertBefore(gl, document.body.firstChild);
        const s = await mod.createScene(gl);
        if (!v.shown || !needsScene(v.look)) { s.dispose(); gl.remove(); return; }
        v.gl = gl; v.scene3d = s;
        s.resize(window.innerWidth, window.innerHeight, v.dpr);
        s.setLook(v.look, colours(v.look));
        v.error = null;
      } catch (e) { v.error = String(e?.message ?? e); }
      finally { v.sceneLoading = null; kick(); }
    })();
    return v.sceneLoading;
  }
  function dropScene() {
    if (!v.scene3d) return;
    v.scene3d.dispose();   // the renderer, its buffers and the WebGPU device / WebGL context
    v.gl.width = 0; v.gl.height = 0; v.gl.remove();
    v.scene3d = null; v.gl = null;
  }

  // ---- frames
  function paint() {
    if (!v.shown || !v.ctx) return;
    const t0 = performance.now();
    const program = host.program(), t = host.cycle(), look = v.look;
    const span = 10;
    const ev = v.cache.get(program, t - span, t + span, host.cps(), look.lanes);
    const wall = t0 / 1000, dt = v.lastWall ? Math.min(0.25, wall - v.lastWall) : 0;
    v.lastWall = wall;
    const from = v.lastT === null || t < v.lastT || t - v.lastT > 1 ? t - 1e-6 : v.lastT;
    const onsets = driveFrom(ev, from, t, v.env, dt);
    v.lastT = t;
    const sectionLine = v.prevSection !== null && look.section !== v.prevSection;
    v.prevSection = look.section;
    if (sectionLine) { v.transition = look.reduceMotion ? { kind: 'fade', k: 0.5 } : { kind: look.transition ?? 'fade', k: 1 }; v.labelAlpha = 0; }
    else if (v.transition) { v.transition.k *= Math.exp(-dt * 3); if (v.transition.k < 0.02 || v.transition.kind === 'cut') v.transition = null; }
    // the section's colour shift and its label, eased
    const ease = 1 - Math.exp(-dt * 2.2);
    v.shift += (sectionShift(look.section) - v.shift) * (dt ? ease : 1);
    v.labelAlpha += (1 - v.labelAlpha) * (dt ? 1 - Math.exp(-dt * 2.5) : 1);
    const a = audio();
    const scene = needsScene(look);
    if (scene && v.scene3d) {
      v.scene3d.frame({ dt, t, env: v.env, onsets, section: sectionLine, bands: a?.bands });
      v.scene3d.render();
    } else if (scene) ensureScene();
    const lanes = program ? program.layers.map((x) => x.name) : [];
    drawPattern(v.ctx, v.canvas.width, v.canvas.height, t, ev, look, host.mix(), a, !(scene && v.scene3d), v.transition,
                { cps: host.cps(), shift: v.shift, labelAlpha: v.labelAlpha, lanes, laneIndex: (n) => Math.max(0, lanes.indexOf(n)), parallax: 1 });
    v.frames++;
    v.drawMs = v.drawMs * 0.95 + (performance.now() - t0) * 0.05;
  }
  // hidden (occluded, off-screen): no frames, unless the look says to draw anyway (dev copies for films:
  // STEERTTS_IGNORE_OCCLUSION); WebKit runs no animation frames for a hidden page, so a timer drives them then
  function hidden() { return document.hidden && !v.look.drawHidden; }
  function next() {
    if (document.hidden && v.look.drawHidden) {
      const fps = v.look.reduceMotion ? Math.min(6, v.look.fps) : v.look.fps;
      v.timer = setTimeout(() => frame(performance.now()), 1000 / fps);
      return -1;
    }
    return requestAnimationFrame(frame);
  }
  function frame(ts) {
    v.raf = 0;
    if (!v.shown || hidden()) return;
    const fps = v.look.reduceMotion ? Math.min(6, v.look.fps) : v.look.fps;
    if (ts - v.last >= 1000 / fps - 2) { v.last = ts; paint(); }
    if (host.playing()) v.raf = next();
  }
  function stopLoop() { if (v.raf > 0) cancelAnimationFrame(v.raf); if (v.timer) clearTimeout(v.timer); v.timer = 0; v.raf = 0; }
  /** The frame loop while the music plays; one still frame while it doesn't. */
  function kick() {
    if (!v.shown) return;
    if (host.playing()) { if (!v.raf && !hidden()) v.raf = next(); }
    else { stopLoop(); v.lastWall = 0; paint(); }
  }

  return {
    kick,
    show(look = {}) {
      v.look = merge(merge(DEFAULT_LOOK, v.look), look);
      v.shown = true;
      mount();
      tap();
      if (needsScene(v.look)) ensureScene();
      kick();
      return { ok: true };
    },
    set(look = {}) {
      const before = v.look;
      v.look = merge(before, look);
      if (v.shown) {
        if (before.fps !== v.look.fps) size();
        if (needsScene(v.look)) { if (v.scene3d) v.scene3d.setLook(v.look, colours(v.look, sectionShift(v.look.section))); else ensureScene(); }
        else dropScene();
        kick();
      }
      return { ok: true };
    },
    hide() {
      v.shown = false;
      stopLoop();
      untap();
      dropScene();
      unmount();
      freeLayers();
      v.cache = new EventCache();
      v.env = {}; v.lastT = null; v.prevSection = null; v.transition = null;
      return { ok: true };
    },
    stats() {
      return { ok: true, shown: v.shown, looping: !!v.raf, frames: v.frames, drawMs: Math.round(v.drawMs * 100) / 100,
               analyser: !!v.analyser, scene: v.scene3d ? v.scene3d.kind : null, backend: v.scene3d?.backend ?? null,
               width: v.canvas?.width ?? 0, height: v.canvas?.height ?? 0, error: v.error, look: v.look };
    },
  };
}

// ---------------------------------------------------------------- offscreen frames (tests, previews)

function fxFor(program, cps, look) {
  const lanes = program ? program.layers.map((x) => x.name) : [];
  return { cps, shift: sectionShift(look.section), labelAlpha: 1, lanes, laneIndex: (n) => Math.max(0, lanes.indexOf(n)), parallax: 0 };
}

function measure(ctx, W, H, bgColour) {
  const data = ctx.getImageData(0, 0, W, H).data;
  const one = document.createElement('canvas'); one.width = 1; one.height = 1;
  const oc = one.getContext('2d', { willReadFrequently: true });
  oc.fillStyle = bgColour; oc.fillRect(0, 0, 1, 1);
  const bg = oc.getImageData(0, 0, 1, 1).data;
  let differ = 0, h = 2166136261;
  const cols = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]);
    if (d > 24) { differ++; cols.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4)); }
    if (((i >> 2) % 7) === 0) { h ^= (data[i] >> 3) ^ ((data[i + 1] >> 3) << 5) ^ ((data[i + 2] >> 3) << 10); h = Math.imul(h, 16777619) >>> 0; }
  }
  // a 32×18 luminance thumbnail (compared with a tolerance: GPU blur may round a level differently between runs)
  const tc = document.createElement('canvas'); tc.width = 32; tc.height = 18;
  const tx = tc.getContext('2d', { willReadFrequently: true }); tx.drawImage(ctx.canvas, 0, 0, 32, 18);
  const td = tx.getImageData(0, 0, 32, 18).data, thumb = [];
  for (let i = 0; i < td.length; i += 4) thumb.push(Math.round(0.2126 * td[i] + 0.7152 * td[i + 1] + 0.0722 * td[i + 2]));
  return { coverage: differ / (W * H), hash: (h >>> 0).toString(16), colours: cols.size, thumb };
}

/** Draws a program at a cycle into fresh canvases: coverage (share of pixels unlike the look's background), a hash of the frame,
 *  the colours seen and (on request) a PNG. No audio; a scene runs `frames` steps at 30 fps up to the cycle. */
export async function snapshot(program, cps, look, { width = 640, height = 360, cycle = 0.5, png = false, frames = 30 } = {}) {
  const l = merge(DEFAULT_LOOK, look);
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const ev = new EventCache().get(program, cycle - 12, cycle + 12, cps, l.lanes);
  const mix = { mute: new Set(), solo: new Set() };
  let backend = null, sceneKind = null;
  if (needsScene(l)) {
    const mod = await loadScene();
    const gl = document.createElement('canvas');
    const s = await mod.createScene(gl);
    backend = s.backend;
    try {
      s.resize(width, height, 1);
      s.setLook(l, colours(l, sectionShift(l.section)));
      sceneKind = s.kind;
      const env = {};
      const step = cps / 30;
      let t = cycle - frames * step;
      for (let f = 0; f < frames; ++f) {
        const onsets = driveFrom(ev, t, t + step, env, 1 / 30);
        t += step;
        s.frame({ dt: 1 / 30, t, env, onsets, section: false, bands: null });
      }
      await s.render();
      ctx.fillStyle = colours(l).bg; ctx.fillRect(0, 0, width, height);
      ctx.drawImage(gl, 0, 0, width, height);
    } finally { s.dispose(); gl.width = 0; gl.height = 0; }
    // the pattern view over it (nothing for the Scene view itself), drawn on a layer and composited
    if (l.view !== 'scene') {
      const layer = document.createElement('canvas'); layer.width = width; layer.height = height;
      drawPattern(layer.getContext('2d'), width, height, cycle, ev, l, mix, null, false, null, fxFor(program, cps, l));
      ctx.drawImage(layer, 0, 0);
      layer.width = 0;
    }
  } else {
    drawPattern(ctx, width, height, cycle, ev, l, mix, null, true, null, fxFor(program, cps, l));
  }
  const out = { ok: true, ...measure(ctx, width, height, colours(l).bg), events: ev.length, lanes: program.layers.map((x) => x.name),
                backend, scene: sceneKind, palette: colours(l).lanes };
  if (png) out.png = cv.toDataURL('image/png');
  cv.width = 0; cv.height = 0;
  return out;
}

/** The cost of drawing: `frames` frames of a program at 30 fps steps on fresh canvases (no audio), timed per frame on
 *  the main thread (ms: mean, p95). A scene's GPU work is submitted each frame and waited for at the end. */
export async function bench(program, cps, look, { width = 960, height = 540, frames = 120 } = {}) {
  const l = merge(DEFAULT_LOOK, look);
  const cv = document.createElement('canvas'); cv.width = width; cv.height = height;
  const ctx = cv.getContext('2d');
  const ev = new EventCache().get(program, -2, frames / 30 * cps + 12, cps, l.lanes);
  const mix = { mute: new Set(), solo: new Set() };
  let s = null, gl = null;
  if (needsScene(l)) {
    const mod = await loadScene();
    gl = document.createElement('canvas');
    s = await mod.createScene(gl);
    s.resize(width, height, 1);
    s.setLook(l, colours(l, sectionShift(l.section)));
  }
  const env = {}, times = [];
  const step = cps / 30;
  let t = 0;
  const t0 = performance.now();
  for (let f = 0; f < frames; ++f) {
    const a = performance.now();
    const onsets = driveFrom(ev, t, t + step, env, 1 / 30);
    t += step;
    if (s) { s.frame({ dt: 1 / 30, t, env, onsets, section: false, bands: null }); s.render(); }
    drawPattern(ctx, width, height, t, ev, l, mix, null, !s, null, fxFor(program, cps, l));
    times.push(performance.now() - a);
  }
  if (s) await s.render();
  const total = performance.now() - t0;
  const backend = s?.backend ?? null;
  if (s) { s.dispose(); gl.width = 0; }
  cv.width = 0;
  times.sort((x, y) => x - y);
  const mean = times.reduce((x, y) => x + y, 0) / times.length;
  return { ok: true, frames, mean: Math.round(mean * 100) / 100, p95: Math.round(times[Math.floor(times.length * 0.95)] * 100) / 100,
           total: Math.round(total), backend };
}

// ---------------------------------------------------------------- video frames (Share as video; docs/MUSIC_VIZ.md)

let video = null;
/** Whether a video is being made (videoBegin … videoEnd): the page is not recycled under it. */
export function videoOpen() { return video !== null; }

/** Starts a video: a virtual clock over the piece's loop (cycle = offset + (t·cps mod loopCycles), the cycles the bounced
 *  loop holds), its look (scene and palette) and the overlays (title, the Steer mark, the download line in the last 2 s).
 *  Deterministic: fixed seeds, a fixed 1/fps step, no audio. */
export async function videoBegin(program, cps, look, o = {}) {
  await videoEnd();
  const aspect = videoAspect(o);
  const width = o.width ?? VIDEO_SIZES[aspect][0], height = o.height ?? VIDEO_SIZES[aspect][1], fps = o.fps ?? 30;
  const L = VIDEO_LAYOUTS[aspect];
  const l = merge(DEFAULT_LOOK, { ...look, reduceMotion: false });
  const cv = document.createElement('canvas'); cv.width = width; cv.height = height;
  const ctx = cv.getContext('2d', { willReadFrequently: false });
  const layer = document.createElement('canvas'); layer.width = width; layer.height = height;
  const small = document.createElement('canvas'); small.width = VIDEO_THUMB[aspect][0]; small.height = VIDEO_THUMB[aspect][1];
  const loopCycles = o.loopCycles ?? 8, offset = o.cycleOffset ?? 0;
  const ev = new EventCache().get(program, offset - 2, offset + loopCycles + 12, cps, l.lanes);
  // the events repeat with the loop: one copy per pass, so onsets and views see the loop as it will sound
  let s = null, gl = null, backend = null;
  if (needsScene(l)) {
    const mod = await loadScene();
    gl = document.createElement('canvas');
    s = await mod.createScene(gl);
    s.resize(width, height, 1);
    s.setLook(l, colours(l, sectionShift(l.section)));
    backend = s.backend;
  }
  video = { cv, ctx, layer, small, s, gl, l, ev, cps, fps, width, height, aspect, L, loopCycles, offset, env: {}, lastCycle: null,
            frames: Math.round((o.duration ?? 15) * fps), title: o.title ?? '', mark: o.mark ?? 'made with Steer',
            url: o.url ?? 'whissle.ai/downloads', mix: { mute: new Set(o.muted ?? []), solo: new Set() }, fx: fxFor(program, cps, l),
            prevThumb: null };
  // a pre-roll (the hook): the scene runs the second before the first frame, so frame 1 is already in motion
  const pre = Math.round((o.preroll ?? 1) * fps);
  for (let k = pre; k >= 1; k--) {
    const cyc = cycleAt(video, -k / fps);
    const from = video.lastCycle === null || cyc < video.lastCycle ? cyc - 1e-6 : video.lastCycle;
    const onsets = driveFrom(ev, from, cyc, video.env, 1 / fps);
    video.lastCycle = cyc;
    if (s) s.frame({ dt: 1 / fps, t: cyc, env: video.env, onsets, section: false, bands: null });
  }
  return { ok: true, frames: video.frames, backend, events: ev.length, aspect, width, height, layout: L };
}

/** Where the overlays sit per aspect (Share video ratios; the Mac's ComposeVideo.Aspect and Android's MusicVideo.Aspect
 *  hold the same numbers). Bands are fractions of the height; safeLeft / safeRight fractions of the width. Inside the
 *  platforms' chrome: 9:16 (Reels, TikTok, Shorts, Stories) nothing in the top 14 % or the bottom 20 % (their captions
 *  and buttons); 1:1 (feed posts) the top 8 % and the bottom 10 % (the feed's caption and progress bar); 16:9 (YouTube,
 *  X, desktop players) the top 10 % (the player's title) and the bottom 15 % (its controls and progress bar). */
export const VIDEO_LAYOUTS = {
  portrait: { safeTop: 0.14, safeBottom: 0.8, safeLeft: 0.07, safeRight: 0.93, title: [0.155, 0.27], pattern: [0.3, 0.7], url: [0.705, 0.765], mark: [0.765, 0.795] },
  square: { safeTop: 0.08, safeBottom: 0.9, safeLeft: 0.07, safeRight: 0.93, title: [0.09, 0.25], pattern: [0.27, 0.71], url: [0.73, 0.81], mark: [0.835, 0.875] },
  landscape: { safeTop: 0.1, safeBottom: 0.85, safeLeft: 0.06, safeRight: 0.94, title: [0.11, 0.27], pattern: [0.29, 0.69], url: [0.71, 0.79], mark: [0.8, 0.84] },
};
export const VIDEO_LAYOUT = VIDEO_LAYOUTS.portrait;
/** The output size per aspect (the default when the caller gives none) and the downsampled copy hashed per frame. */
const VIDEO_SIZES = { portrait: [1080, 1920], square: [1080, 1080], landscape: [1920, 1080] };
const VIDEO_THUMB = { portrait: [90, 160], square: [120, 120], landscape: [160, 90] };
/** The aspect asked for (o.aspect), else the one the size implies; 9:16 when neither says. */
function videoAspect(o) {
  if (VIDEO_LAYOUTS[o.aspect]) return o.aspect;
  if (o.width && o.height) { const r = o.width / o.height; return r > 1.2 ? 'landscape' : r > 0.8 ? 'square' : 'portrait'; }
  return 'portrait';
}

function cycleAt(v, time) {
  const x = (time * v.cps) % v.loopCycles;
  return v.offset + (x < 0 ? x + v.loopCycles : x);
}

function wrapText(ctx, text, maxW) {
  const words = text.split(/\s+/), lines = [];
  let line = '';
  for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

/** Frame i: the picture as JPEG (base64, no prefix) and a hash of a downsampled copy (determinism checks). */
export async function videoFrame(i, quality = 0.9) {
  const v = video;
  if (!v) throw new Error('no video started');
  const time = i / v.fps, dt = 1 / v.fps;
  const cycle = cycleAt(v, time);
  const from = v.lastCycle === null || cycle < v.lastCycle ? cycle - 1e-6 : v.lastCycle;
  const onsets = driveFrom(v.ev, from, cycle, v.env, dt);
  v.lastCycle = cycle;
  const { ctx, width: W, height: H, l, L } = v;
  const u = Math.min(W, H);   // type and spacing follow the short side (the width in 9:16 and 1:1, the height in 16:9)
  const c = colours(l);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = c.bg; ctx.fillRect(0, 0, W, H);
  if (v.s) {
    v.s.frame({ dt, t: cycle, env: v.env, onsets, section: false, bands: null });
    await v.s.render();
    ctx.drawImage(v.gl, 0, 0, W, H);
  }
  if (l.view !== 'scene') {
    // the pattern view in the middle band of the portrait frame, over the scene
    const top = Math.round(H * L.pattern[0]), h = Math.round(H * (L.pattern[1] - L.pattern[0]));
    const lc = v.layer.getContext('2d');
    if (v.layer.height !== h) { v.layer.height = h; }
    drawPattern(lc, W, h, cycle, v.ev, { ...l, section: '' }, v.mix, null, !v.s, null, { ...v.fx, parallax: 0 });
    ctx.drawImage(v.layer, 0, top);
  }
  // overlays: the title, the mark, and the download line in the last 2 s
  const pad = Math.round(W * L.safeLeft);
  ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  ctx.fillStyle = c.dark ? 'rgba(255,255,255,0.95)' : 'rgba(10,12,20,0.9)';
  ctx.font = `700 ${Math.round(u * 0.072)}px ${FONT}`;
  wrapText(ctx, v.title, Math.round(W * L.safeRight) - pad).slice(0, 2).forEach((line, k) => ctx.fillText(line, pad, Math.round(H * L.title[0]) + k * Math.round(u * 0.085)));
  ctx.globalAlpha = 0.8;
  ctx.font = `500 ${Math.round(u * 0.034)}px ${FONT}`;
  ctx.textBaseline = 'bottom';
  ctx.fillText(v.mark, pad, Math.round(H * L.mark[1]));
  const left = v.frames / v.fps - time;
  if (left <= 2) {
    const a = Math.min(1, (2 - left) / 0.4);
    ctx.globalAlpha = 0.6 * a;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, H * L.url[0], W, H * (L.url[1] - L.url[0]));
    ctx.globalAlpha = a;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `700 ${Math.round(u * 0.055)}px ${FONT}`;
    ctx.fillText(v.url, W / 2, H * (L.url[0] + L.url[1]) / 2);
    ctx.textAlign = 'left';
  }
  ctx.globalAlpha = 1;
  // a hash of a downsampled copy
  const sc = v.small.getContext('2d', { willReadFrequently: true });
  sc.drawImage(v.cv, 0, 0, v.small.width, v.small.height);
  const d = sc.getImageData(0, 0, v.small.width, v.small.height).data;
  let h = 2166136261, lit = 0;
  const bg = c.bg;
  for (let k = 0; k < d.length; k += 4) { h ^= (d[k] >> 2) ^ ((d[k + 1] >> 2) << 6) ^ ((d[k + 2] >> 2) << 12); h = Math.imul(h, 16777619) >>> 0; }
  const one = document.createElement('canvas'); one.width = 1; one.height = 1;
  const oc = one.getContext('2d', { willReadFrequently: true }); oc.fillStyle = bg; oc.fillRect(0, 0, 1, 1);
  const b = oc.getImageData(0, 0, 1, 1).data;
  for (let k = 0; k < d.length; k += 4) if (Math.abs(d[k] - b[0]) + Math.abs(d[k + 1] - b[1]) + Math.abs(d[k + 2] - b[2]) > 24) lit++;
  // motion: how much the picture changed since the last frame (mean luminance difference, 0…255)
  const thumb = new Float32Array(d.length / 4);
  for (let k = 0; k < d.length; k += 4) thumb[k >> 2] = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
  let motion = 0;
  if (v.prevThumb) { for (let k = 0; k < thumb.length; k++) motion += Math.abs(thumb[k] - v.prevThumb[k]); motion /= thumb.length; }
  v.prevThumb = thumb;
  const url = v.cv.toDataURL('image/jpeg', quality);
  return { ok: true, i, cycle: Math.round(cycle * 1e6) / 1e6, hash: (h >>> 0).toString(16), coverage: lit / (d.length / 4),
           motion: Math.round(motion * 1000) / 1000, jpeg: url.slice(url.indexOf(',') + 1) };
}

/** Frames [from, from + count) in one call (Share as video: one bridge round trip per batch instead of per frame). Each
 *  is videoFrame(i) as it is, so a batched video is the same picture frame for frame. */
export async function videoFrames(from, count, quality = 0.9) {
  const out = [];
  const t0 = performance.now();
  for (let k = 0; k < count; k++) {
    if (!video || from + k >= video.frames) break;
    out.push(await videoFrame(from + k, quality));
  }
  return { ok: true, frames: out, ms: Math.round(performance.now() - t0) };
}

export async function videoEnd() {
  if (!video) return { ok: true };
  if (video.s) { video.s.dispose(); video.gl.width = 0; }
  video.cv.width = 0; video.layer.width = 0;
  video = null;
  return { ok: true };
}
