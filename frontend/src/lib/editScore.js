// Score editing helpers (Phase 1: note entry). All transforms mutate a live
// score in place and return the previous values an inverse command needs for
// undo. After a batch of mutations call finalizeEdit() so alphaTab rebuilds
// derived state (beat indexes, next/prev chains, ties, playback ticks).

export const MAX_FRET = 30; // matches lib/tuning.js

// Durations selectable in the editor, longest to shortest. alphaTab's
// Duration enum values are note denominators: 1 = whole … 64 = sixty-fourth.
export const DURATIONS = [1, 2, 4, 8, 16, 32, 64];

// ---- selection paths ------------------------------------------------------
// The editor stores its selection as an index path instead of object
// references so it survives re-renders and undo restores (alphaTab hands out
// fresh objects; only indexes are stable).

export function pathForBeat(beat, string = null) {
  const voice = beat.voice;
  const bar = voice.bar;
  const staff = bar.staff;
  return {
    trackIndex: staff.track.index,
    staffIndex: staff.index,
    barIndex: bar.index,
    voiceIndex: voice.index,
    beatIndex: beat.index,
    string,
  };
}

export function beatAtPath(score, path) {
  if (!path) return null;
  return score.tracks[path.trackIndex]
    ?.staves[path.staffIndex]
    ?.bars[path.barIndex]
    ?.voices[path.voiceIndex]
    ?.beats[path.beatIndex] ?? null;
}

export function noteOnString(beat, string) {
  return beat.notes.find(n => n.string === string) ?? null;
}

// ---- note transforms ------------------------------------------------------

// Set the fret of (beat, string), creating the note if the string is empty.
// Returns the previous fret (null = no note existed) for undo.
export function setFret(at, beat, string, fret) {
  const clamped = Math.max(0, Math.min(MAX_FRET, fret));
  const existing = noteOnString(beat, string);
  if (existing) {
    const oldFret = existing.fret;
    existing.fret = clamped;
    return { oldFret };
  }
  const note = new at.model.Note();
  note.string = string;
  note.fret = clamped;
  beat.addNote(note);
  beat.isEmpty = false; // a rest/empty beat becomes a played beat
  return { oldFret: null };
}

// Remove the note on a string. Returns its fret (null if none existed).
export function removeNoteOnString(beat, string) {
  const note = noteOnString(beat, string);
  if (!note) return { oldFret: null };
  const oldFret = note.fret;
  beat.removeNote(note);
  return { oldFret };
}

// Turn a beat into a rest. Returns the removed notes for undo.
export function setRest(beat) {
  const oldNotes = beat.notes.map(n => ({ string: n.string, fret: n.fret }));
  for (const n of [...beat.notes]) beat.removeNote(n);
  return { oldNotes };
}

// ---- rhythm transforms ----------------------------------------------------

export function setBeatDuration(beat, duration) {
  const oldDuration = beat.duration;
  beat.duration = duration;
  return { oldDuration };
}

export function setBeatDots(beat, dots) {
  const oldDots = beat.dots;
  beat.dots = dots;
  return { oldDots };
}

// Step to the next longer (dir -1) or shorter (dir +1) editor duration.
export function stepBeatDuration(beat, dir) {
  const at = DURATIONS.indexOf(beat.duration);
  const from = at === -1 ? DURATIONS.indexOf(4) : at;
  const next = DURATIONS[Math.max(0, Math.min(DURATIONS.length - 1, from + dir))];
  return setBeatDuration(beat, next);
}

// ---- note effects -----------------------------------------------------------
// Toggleable per-note properties (Phase 2). All are plain model assignments;
// tie/hammer chains (tieOrigin, hammerPullDestination) are resolved by
// score.finish(). vibrato is numeric (VibratoType: 0 none, 1 slight).

export const NOTE_PROPS = {
  palmMute: 'isPalmMute',
  letRing: 'isLetRing',
  dead: 'isDead',
  staccato: 'isStaccato',
  hammerPull: 'isHammerPullOrigin',
  tie: 'isTieDestination',
  vibrato: 'vibrato',
};

export function setNoteProp(beat, string, prop, value) {
  const note = noteOnString(beat, string);
  if (!note) return null;
  const oldValue = note[prop];
  note[prop] = value;
  return { oldValue };
}

// ---- structure transforms -------------------------------------------------

// Append a rest beat at the end of a voice (continuous entry past the last
// beat). Bars may overfill — Guitar Pro semantics, no auto-reflow.
export function appendRestBeat(at, voice, duration = 4) {
  const beat = new at.model.Beat();
  beat.duration = duration;
  voice.addBeat(beat);
  return beat;
}

// Inverse of appendRestBeat. Refuses to empty a voice — alphaTab expects
// every voice to hold at least one beat.
export function removeBeat(voice, beatIndex) {
  if (voice.beats.length <= 1) return false;
  voice.beats.splice(beatIndex, 1);
  return true;
}

// Insert a rest beat at an exact index (0..length). Splice + parent ref is
// enough: score.finish() rebuilds indexes and next/prev chains.
export function insertRestBeatAt(at, voice, index, duration = 4) {
  const beat = new at.model.Beat();
  beat.duration = duration;
  beat.voice = voice;
  voice.beats.splice(index, 0, beat);
  return beat;
}

// Snapshot a beat's editable content so a deletion can be undone exactly.
export function serializeBeat(beat) {
  return {
    duration: beat.duration,
    dots: beat.dots,
    notes: beat.notes.map(n => {
      const data = { string: n.string, fret: n.fret };
      for (const prop of Object.values(NOTE_PROPS)) {
        if (n[prop]) data[prop] = n[prop];
      }
      return data;
    }),
  };
}

// Delete a beat, returning its snapshot for undo (null = refused, last beat).
export function deleteBeat(voice, beatIndex) {
  const beat = voice.beats[beatIndex];
  if (!beat || voice.beats.length <= 1) return null;
  const snapshot = serializeBeat(beat);
  voice.beats.splice(beatIndex, 1);
  return snapshot;
}

// Inverse of deleteBeat: rebuild the beat from its snapshot at its old index.
export function restoreBeat(at, voice, index, snapshot) {
  const beat = insertRestBeatAt(at, voice, index, snapshot.duration);
  beat.dots = snapshot.dots;
  for (const data of snapshot.notes) {
    const note = new at.model.Note();
    note.string = data.string;
    note.fret = data.fret;
    for (const prop of Object.values(NOTE_PROPS)) {
      if (data[prop] !== undefined) note[prop] = data[prop];
    }
    beat.addNote(note);
  }
  if (snapshot.notes.length) beat.isEmpty = false;
  return beat;
}

// Rebuild all derived state after a batch of mutations.
export function finalizeEdit(score, settings) {
  score.finish(settings);
}
