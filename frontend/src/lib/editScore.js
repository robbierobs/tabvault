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

// ---- bar-fill normalization (Guitar Pro semantics) --------------------------
// A bar holds exactly its time signature's worth of beats: four quarters in
// 4/4, etc. After any rhythm edit the edited voice is re-normalized —
// shortening a beat pads trailing rests, lengthening consumes them. Notes
// are never deleted: a bar overfull with real notes is left alone (legacy
// files carry those; alphaTab renders and exports them fine).

const WHOLE_TICKS = 3840; // alphaTab quarter = 960 ticks

export function beatTicks(beat) {
  let ticks = WHOLE_TICKS / beat.duration;
  if (beat.dots === 1) ticks *= 1.5;
  else if (beat.dots === 2) ticks *= 1.75;
  if (beat.tupletNumerator > 0 && beat.tupletDenominator > 0) {
    ticks = (ticks * beat.tupletDenominator) / beat.tupletNumerator;
  }
  return ticks;
}

export function barCapacityTicks(bar) {
  const mb = bar.masterBar;
  return mb.timeSignatureNumerator * (WHOLE_TICKS / mb.timeSignatureDenominator);
}

// largest-first rest durations that sum to (at most) the given tick count
export function restDurationsFor(ticks) {
  const out = [];
  for (const d of DURATIONS) {
    const t = WHOLE_TICKS / d;
    while (ticks >= t) {
      out.push(d);
      ticks -= t;
    }
  }
  return out;
}

// Returns { overfull } — true when real notes exceed the bar (left intact).
export function normalizeVoice(at, voice) {
  const capacity = barCapacityTicks(voice.bar);
  let sum = voice.beats.reduce((total, b) => total + beatTicks(b), 0);
  // trim trailing rests while the bar overflows
  while (sum > capacity && voice.beats.length > 1) {
    const last = voice.beats[voice.beats.length - 1];
    if (!last.isRest) break;
    sum -= beatTicks(last);
    voice.beats.pop();
  }
  // pad the remaining gap with rests
  for (const d of restDurationsFor(capacity - sum)) {
    appendRestBeat(at, voice, d);
    sum += WHOLE_TICKS / d;
  }
  return { overfull: sum > capacity };
}

// ---- voice snapshots ---------------------------------------------------------
// Rhythm edits + normalization can add/remove several rests at once; undo
// restores the whole voice content exactly from a snapshot.

export function serializeVoice(voice) {
  return voice.beats.map(serializeBeat);
}

export function restoreVoice(at, voice, snapshots) {
  voice.beats.length = 0;
  snapshots.forEach((snapshot, i) => restoreBeat(at, voice, i, snapshot));
}

// ---- bar structure -----------------------------------------------------------
// Append one bar at the end of the song: a MasterBar plus a Bar in EVERY
// staff of EVERY track (score.masterBars and staff.bars must stay parallel),
// each voice pre-filled with rests matching the time signature.

export function appendBar(at, score) {
  const last = score.masterBars[score.masterBars.length - 1];
  const masterBar = new at.model.MasterBar();
  masterBar.timeSignatureNumerator = last.timeSignatureNumerator;
  masterBar.timeSignatureDenominator = last.timeSignatureDenominator;
  score.addMasterBar(masterBar);
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const prev = staff.bars[staff.bars.length - 1];
      const bar = new at.model.Bar();
      if (prev) {
        bar.clef = prev.clef;
        bar.clefOttava = prev.clefOttava;
        bar.keySignature = prev.keySignature;
        bar.keySignatureType = prev.keySignatureType;
      }
      staff.addBar(bar);
      const voiceCount = Math.max(1, prev?.voices.length ?? 1);
      for (let i = 0; i < voiceCount; i++) {
        const voice = new at.model.Voice();
        bar.addVoice(voice);
        for (const d of restDurationsFor(barCapacityTicks(bar))) appendRestBeat(at, voice, d);
      }
    }
  }
  return masterBar;
}

// Inverse of appendBar. Refuses to delete the only bar of the song.
export function removeLastBar(score) {
  if (score.masterBars.length <= 1) return false;
  score.masterBars.pop();
  for (const track of score.tracks) {
    for (const staff of track.staves) staff.bars.pop();
  }
  return true;
}

// Rebuild all derived state after a batch of mutations.
export function finalizeEdit(score, settings) {
  score.finish(settings);
}
