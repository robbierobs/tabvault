// New-song factory (editing Phase 5): builds a minimal valid score — one
// guitar track, N empty 4/4 bars, a tempo automation on the first bar —
// mirroring what alphaTab's importer produces for a default score. The
// caller exports it via exportScoreGp and POSTs it to /api/file.

export const DEFAULT_BARS = 8;

export function createEmptyScore(at, { title, artist = '', tempo = 120, bars = DEFAULT_BARS, strings = 6 }) {
  const score = new at.model.Score();
  score.title = title;
  score.artist = artist;

  const track = new at.model.Track();
  track.name = 'Guitar';
  track.ensureStaveCount(1);
  track.playbackInfo.program = 25; // steel-string acoustic; changeable in Phase 4
  track.playbackInfo.primaryChannel = 0;
  track.playbackInfo.secondaryChannel = 1;

  const staff = track.staves[0];
  staff.showTablature = true;
  staff.stringTuning = at.model.Tuning.getDefaultTuningFor(strings);

  for (let i = 0; i < bars; i++) {
    const masterBar = new at.model.MasterBar();
    masterBar.timeSignatureNumerator = 4;
    masterBar.timeSignatureDenominator = 4;
    if (i === 0) {
      const automation = new at.model.Automation();
      automation.type = at.model.AutomationType.Tempo;
      automation.value = Math.max(20, Math.min(400, tempo));
      masterBar.tempoAutomations.push(automation);
    }
    score.addMasterBar(masterBar);

    const bar = new at.model.Bar();
    staff.addBar(bar);
    const voice = new at.model.Voice();
    bar.addVoice(voice);
    const beat = new at.model.Beat();
    beat.duration = at.model.Duration.Whole; // empty bar = whole rest
    voice.addBeat(beat);
  }

  score.addTrack(track);
  score.finish(new at.Settings());
  return score;
}

// "My New Song" → "my-new-song.gp" (exporter output is always GP7 format)
export function suggestFilename(title) {
  const slug = (title || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
  return `${slug}.gp`;
}
