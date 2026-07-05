// Tuning presets, detection, and score transforms for the tuning feature.
//
// Midi arrays follow alphaTab's Staff.stringTuning.tunings ordering:
// index 0 = highest string (top tablature line), last index = lowest string.
// Note.string is the opposite: 1 = lowest string, so a note's tuning index
// is tunings.length - note.string.

export const TUNING_PRESETS = {
  6: [
    { name: 'E Standard', tunings: [64, 59, 55, 50, 45, 40] },
    { name: 'Eb Standard', tunings: [63, 58, 54, 49, 44, 39] },
    { name: 'D Standard', tunings: [62, 57, 53, 48, 43, 38] },
    { name: 'C# Standard', tunings: [61, 56, 52, 47, 42, 37] },
    { name: 'C Standard', tunings: [60, 55, 51, 46, 41, 36] },
    { name: 'B Standard', tunings: [59, 54, 50, 45, 40, 35] },
    { name: 'Drop D', tunings: [64, 59, 55, 50, 45, 38] },
    { name: 'Drop C#', tunings: [63, 58, 54, 49, 44, 37] },
    { name: 'Drop C', tunings: [62, 57, 53, 48, 43, 36] },
    { name: 'Drop B', tunings: [61, 56, 52, 47, 42, 35] },
    { name: 'Drop A#', tunings: [60, 55, 51, 46, 41, 34] },
    { name: 'Drop A', tunings: [59, 54, 50, 45, 40, 33] },
    { name: 'Double Drop D', tunings: [62, 59, 55, 50, 45, 38] },
    { name: 'DADGAD', tunings: [62, 57, 55, 50, 45, 38] },
    { name: 'Open G', tunings: [62, 59, 55, 50, 43, 38] },
    { name: 'Open D', tunings: [62, 57, 54, 50, 45, 38] },
  ],
  7: [
    { name: 'B Standard', tunings: [64, 59, 55, 50, 45, 40, 35] },
    { name: 'A# Standard', tunings: [63, 58, 54, 49, 44, 39, 34] },
    { name: 'A Standard', tunings: [62, 57, 53, 48, 43, 38, 33] },
    { name: 'Drop A', tunings: [64, 59, 55, 50, 45, 40, 33] },
    { name: 'Drop G#', tunings: [63, 58, 54, 49, 44, 39, 32] },
    { name: 'Drop G', tunings: [62, 57, 53, 48, 43, 38, 31] },
  ],
  4: [
    { name: 'E Standard', tunings: [43, 38, 33, 28] },
    { name: 'Eb Standard', tunings: [42, 37, 32, 27] },
    { name: 'D Standard', tunings: [41, 36, 31, 26] },
    { name: 'C# Standard', tunings: [40, 35, 30, 25] },
    { name: 'C Standard', tunings: [39, 34, 29, 24] },
    { name: 'Drop D', tunings: [43, 38, 33, 26] },
    { name: 'Drop C#', tunings: [42, 37, 32, 25] },
    { name: 'Drop C', tunings: [41, 36, 31, 24] },
  ],
  5: [
    { name: 'B Standard', tunings: [43, 38, 33, 28, 23] },
    { name: 'A Standard', tunings: [41, 36, 31, 26, 21] },
    { name: 'Drop A', tunings: [43, 38, 33, 28, 21] },
  ],
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function sameTuning(a, b) {
  return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}

// "D A D G B E" — low string first, the way guitarists write tunings
export function tuningLetters(tunings) {
  return [...tunings].reverse().map(m => NOTE_NAMES[((m % 12) + 12) % 12]).join(' ');
}

// Friendly preset name if known, note letters otherwise
export function tuningLabel(tunings) {
  if (!tunings || tunings.length === 0) return null;
  const preset = (TUNING_PRESETS[tunings.length] || []).find(p => sameTuning(p.tunings, tunings));
  return preset ? preset.name : tuningLetters(tunings);
}

export function presetsFor(tunings) {
  if (!tunings) return [];
  return TUNING_PRESETS[tunings.length] || [];
}

// Semitone difference between two tunings, measured on the lowest string
export function semitoneShift(fromTunings, toTunings) {
  return toTunings[toTunings.length - 1] - fromTunings[fromTunings.length - 1];
}

const MAX_FRET = 30;

// "Re-finger" transform: the song keeps sounding exactly as written, but the
// tab is rewritten for newTuning. Applies to every staff whose tuning matches
// refTuning (e.g. both rhythm and lead guitar); other instruments are left
// alone since their sound doesn't change. Notes whose compensated fret falls
// off the fretboard are clamped and counted.
export function refingerScore(score, refTuning, newTuning) {
  let outOfRange = 0;
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      const tunings = staff.stringTuning?.tunings;
      if (!sameTuning(tunings, refTuning)) continue;
      const deltas = refTuning.map((v, i) => v - newTuning[i]);
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              if (!note.isStringed) continue;
              const idx = tunings.length - note.string;
              const fret = note.fret + deltas[idx];
              if (fret < 0 || fret > MAX_FRET) outOfRange++;
              note.fret = Math.max(0, Math.min(MAX_FRET, fret));
            }
          }
        }
      }
      staff.stringTuning.tunings = [...newTuning];
      staff.stringTuning.finish?.();
    }
  }
  return { outOfRange };
}

// "Pitch shift" transform: every fret stays as written, the whole score's
// audio moves by `semitones`. Stringed staves get their tuning moved (which
// shifts the generated MIDI and updates the displayed tuning); other pitched
// staves are transposed directly. Percussion is untouched.
export function shiftScorePitch(score, semitones) {
  if (!semitones) return;
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      if (staff.isPercussion) continue;
      const tunings = staff.stringTuning?.tunings;
      if (tunings && tunings.length > 0) {
        staff.stringTuning.tunings = tunings.map(v => v + semitones);
        staff.stringTuning.finish?.();
      } else {
        // alphaTab: a positive transpositionPitch lowers the sounding pitch
        staff.transpositionPitch -= semitones;
      }
    }
  }
}
