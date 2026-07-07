// Score editing helpers (Phase 0: tempo). Edits work on a freshly parsed
// score and are persisted by exporting a new .gp version — the original
// file is never modified.

// Scale every tempo automation in the score so the song's base tempo becomes
// newTempo while mid-song tempo changes keep their relative ratios.
// Returns the number of automations touched.
export function scaleScoreTempo(score, newTempo) {
  const base = score.tempo; // derived from the first bar's automation
  if (!base || newTempo <= 0) return 0;
  const ratio = newTempo / base;
  let touched = 0;
  for (const mb of score.masterBars) {
    const autos = mb.tempoAutomations ?? (mb.tempoAutomation ? [mb.tempoAutomation] : []);
    for (const a of autos) {
      a.value = Math.max(1, Math.round(a.value * ratio));
      touched++;
    }
  }
  return touched;
}

// Export a score as GP7 (.gp) bytes via alphaTab's exporter.
export function exportScoreGp(at, score, settings) {
  const out = new at.exporter.Gp7Exporter().export(score, settings);
  return out instanceof Uint8Array ? out : new Uint8Array(out.buffer ?? out);
}
