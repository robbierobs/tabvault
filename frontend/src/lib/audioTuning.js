// User-adjustable mixing/compression settings, layered on top of the
// per-bank calibration in Player.jsx:
//
//   synth channel volume = slider × bankProgramGain × familyTrim(tuning) × boost(tuning)
//   synth master volume  = slider × bankMaster × tuning.master
//   WebAudio output      = alphaTab output [→ compressor] → destination
//
// The compressor needs a real node between alphaTab's output and the
// destination. alphaTab doesn't expose its AudioContext or output node (and
// creates a fresh output node per play/pause cycle), so we intercept
// AudioNode.connect(destination) and keep a per-context list of sources we
// can re-route through the compressor. This is the same interception the
// audio-measurement rig uses; alphaTab is the only audio producer in the app.

export const TUNING_KEY = 'tabvault-audio-tuning';

export const TUNING_DEFAULTS = {
  v: 1,
  master: 0.9,   // overall headroom (1 = old level; 0.9 ≈ −1dB)
  guitars: 1,    // GM 24-31
  bass: 0.65,    // GM 32-39 (measured: mixes 4-13dB above guitars at 1.0)
  drums: 0.7,    // percussion channel (measured: 5-9dB above guitars at 1.0)
  other: 1,      // everything else
  boost: 1.5,    // "Boost selected" gain (+3.5dB)
  compressor: {
    enabled: false,
    threshold: -18, // dB
    ratio: 3,
    knee: 24,       // fixed in UI
    attack: 0.003,  // fixed in UI
    release: 0.25,  // fixed in UI
  },
};

export function loadTuning() {
  try {
    const raw = JSON.parse(localStorage.getItem(TUNING_KEY));
    if (raw && raw.v === 1) {
      return {
        ...TUNING_DEFAULTS,
        ...raw,
        compressor: { ...TUNING_DEFAULTS.compressor, ...(raw.compressor || {}) },
      };
    }
  } catch (e) {}
  return { ...TUNING_DEFAULTS, compressor: { ...TUNING_DEFAULTS.compressor } };
}

export function saveTuning(t) {
  try { localStorage.setItem(TUNING_KEY, JSON.stringify(t)); } catch (e) {}
}

// family trim for a score track under the current tuning
export function tuningTrim(tuning, track) {
  const isDrum = track.staves?.some(s => s.isPercussion) || track.playbackInfo?.primaryChannel === 9;
  if (isDrum) return tuning.drums;
  const p = track.playbackInfo?.program ?? -1;
  if (p >= 24 && p <= 31) return tuning.guitars;
  if (p >= 32 && p <= 39) return tuning.bass;
  return tuning.other;
}

// ---- output chain (compressor) ---------------------------------------------

const chains = new Map(); // AudioContext -> { comp, sources: Set<AudioNode> }
let current = { ...TUNING_DEFAULTS.compressor };
let installed = false;

function applyParams(comp) {
  const t = comp.context.currentTime;
  comp.threshold.setValueAtTime(current.threshold, t);
  comp.ratio.setValueAtTime(current.ratio, t);
  comp.knee.setValueAtTime(current.knee, t);
  comp.attack.setValueAtTime(current.attack, t);
  comp.release.setValueAtTime(current.release, t);
}

function chainFor(ctx) {
  let c = chains.get(ctx);
  if (!c) {
    const comp = ctx.createDynamicsCompressor();
    applyParams(comp);
    comp.__tabvaultChain = true;
    c = { comp, sources: new Set(), wired: false };
    chains.set(ctx, c);
  }
  return c;
}

function rewire(c, ctx) {
  const wantComp = current.enabled;
  if (wantComp && !c.wired) {
    c.comp.connect(ctx.destination);
    c.wired = true;
  }
  for (const src of c.sources) {
    try { src.disconnect(ctx.destination); } catch (e) {}
    try { src.disconnect(c.comp); } catch (e) {}
    try { src.connect(wantComp ? c.comp : ctx.destination); } catch (e) {}
  }
}

// Install once at app start, before alphaTab ever plays.
export function installOutputChain(initial) {
  current = { ...initial };
  if (installed) return;
  installed = true;
  if (import.meta.env.DEV) {
    window.__tabvaultAudioChain = {
      chains,
      get current() { return current; },
    };
  }
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (...args) {
    if (args[0] instanceof AudioDestinationNode && !this.__tabvaultChain) {
      const ctx = this.context;
      const c = chainFor(ctx);
      c.sources.add(this);
      if (current.enabled) {
        if (!c.wired) { c.comp.connect(ctx.destination); c.wired = true; }
        return orig.call(this, c.comp);
      }
    }
    return orig.apply(this, args);
  };
}

// Live-update compressor settings (toggle rewires existing sources).
export function updateOutputChain(compressor) {
  const wasEnabled = current.enabled;
  current = { ...compressor };
  for (const [ctx, c] of chains) {
    applyParams(c.comp);
    if (wasEnabled !== current.enabled) rewire(c, ctx);
  }
}
