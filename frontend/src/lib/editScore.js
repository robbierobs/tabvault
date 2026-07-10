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
  // trim trailing rests while the bar overflows — even the last one, since
  // the padding below always refills an emptied voice (e.g. a whole rest in
  // a bar that just became 3/4 shrinks to half + quarter rests)
  while (sum > capacity && voice.beats.length > 0) {
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

// Mid-array bar operations. CRITICAL: score.finish() does NOT re-derive bar
// indexes or prev/next chains for spliced elements (addMasterBar/addBar set
// them at append time, and Voice._chain navigates via nextBar.voices[i]), so
// every splice must be followed by this reindex pass — and inserted bars must
// mirror their neighbours' voice count.
export function reindexBars(score) {
  score.masterBars.forEach((mb, i) => {
    mb.index = i;
    mb.previousMasterBar = score.masterBars[i - 1] ?? null;
    mb.nextMasterBar = score.masterBars[i + 1] ?? null;
  });
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      staff.bars.forEach((bar, i) => {
        bar.index = i;
        bar.previousBar = staff.bars[i - 1] ?? null;
        bar.nextBar = staff.bars[i + 1] ?? null;
      });
    }
  }
}

// Insert a rest-filled bar at an exact index, copying the time signature,
// clef, key and voice count from the bar currently at that position.
export function insertRestBar(at, score, index) {
  const ref = score.masterBars[Math.min(index, score.masterBars.length - 1)];
  const masterBar = new at.model.MasterBar();
  masterBar.timeSignatureNumerator = ref.timeSignatureNumerator;
  masterBar.timeSignatureDenominator = ref.timeSignatureDenominator;
  masterBar.score = score;
  score.masterBars.splice(index, 0, masterBar);
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const refBar = staff.bars[Math.min(index, staff.bars.length - 1)];
      const bar = new at.model.Bar();
      bar.staff = staff;
      if (refBar) {
        bar.clef = refBar.clef;
        bar.clefOttava = refBar.clefOttava;
        bar.keySignature = refBar.keySignature;
        bar.keySignatureType = refBar.keySignatureType;
      }
      staff.bars.splice(index, 0, bar);
      const voiceCount = Math.max(1, refBar?.voices.length ?? 1);
      for (let vi = 0; vi < voiceCount; vi++) {
        const voice = new at.model.Voice();
        bar.addVoice(voice);
        for (const d of restDurationsFor(barCapacityTicks(bar))) appendRestBeat(at, voice, d);
      }
    }
  }
  reindexBars(score);
  return masterBar;
}

// Remove the bar at an index everywhere. Deleting bar 0 moves its tempo
// automations onto the new first bar so the song keeps its tempo.
export function removeBarAt(score, index) {
  if (score.masterBars.length <= 1) return false;
  const [removed] = score.masterBars.splice(index, 1);
  for (const track of score.tracks) {
    for (const staff of track.staves) staff.bars.splice(index, 1);
  }
  if (index === 0 && removed.tempoAutomations.length && !score.masterBars[0].tempoAutomations.length) {
    for (const a of removed.tempoAutomations) score.masterBars[0].tempoAutomations.push(a);
  }
  reindexBars(score);
  return true;
}

// Full snapshot of one bar across the whole score (master-bar props + every
// staff's voice contents) so a bar deletion can be undone exactly.
export function serializeFullBar(score, index) {
  const mb = score.masterBars[index];
  return {
    masterBar: {
      timeSignatureNumerator: mb.timeSignatureNumerator,
      timeSignatureDenominator: mb.timeSignatureDenominator,
      isRepeatStart: mb.isRepeatStart,
      repeatCount: mb.repeatCount,
      tempoAutomations: mb.tempoAutomations.map(a => ({ value: a.value, ratioPosition: a.ratioPosition })),
    },
    staves: score.tracks.flatMap(track => track.staves.map(staff =>
      staff.bars[index].voices.map(serializeVoice))),
  };
}

export function restoreFullBar(at, score, index, snapshot) {
  insertRestBar(at, score, index);
  const mb = score.masterBars[index];
  mb.timeSignatureNumerator = snapshot.masterBar.timeSignatureNumerator;
  mb.timeSignatureDenominator = snapshot.masterBar.timeSignatureDenominator;
  mb.isRepeatStart = snapshot.masterBar.isRepeatStart;
  mb.repeatCount = snapshot.masterBar.repeatCount;
  mb.tempoAutomations.length = 0;
  for (const data of snapshot.masterBar.tempoAutomations) {
    const a = new at.model.Automation();
    a.type = at.model.AutomationType.Tempo;
    a.value = data.value;
    if (data.ratioPosition !== undefined) a.ratioPosition = data.ratioPosition;
    mb.tempoAutomations.push(a);
  }
  let flat = 0;
  for (const track of score.tracks) {
    for (const staff of track.staves) {
      const bar = staff.bars[index];
      const voiceSnapshots = snapshot.staves[flat++];
      bar.voices.length = 0;
      voiceSnapshots.forEach((beats) => {
        const voice = new at.model.Voice();
        bar.addVoice(voice);
        restoreVoice(at, voice, beats);
      });
    }
  }
}

// Change the time signature from a bar through its contiguous run of bars
// sharing the same signature (the musical "from here onward" expectation),
// re-normalizing every voice of every staff in the affected bars. Returns a
// snapshot for undo: the bars' signatures + voice contents beforehand.
export function setTimeSignatureRun(at, score, startIndex, numerator, denominator) {
  const origNum = score.masterBars[startIndex].timeSignatureNumerator;
  const origDen = score.masterBars[startIndex].timeSignatureDenominator;
  const before = [];
  for (let i = startIndex; i < score.masterBars.length; i++) {
    const mb = score.masterBars[i];
    if (mb.timeSignatureNumerator !== origNum || mb.timeSignatureDenominator !== origDen) break;
    before.push({
      index: i,
      numerator: origNum,
      denominator: origDen,
      staves: score.tracks.flatMap(track => track.staves.map(staff =>
        staff.bars[i].voices.map(serializeVoice))),
    });
    mb.timeSignatureNumerator = numerator;
    mb.timeSignatureDenominator = denominator;
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        for (const voice of staff.bars[i].voices) normalizeVoice(at, voice);
      }
    }
  }
  return before;
}

export function restoreTimeSignatureRun(at, score, before) {
  for (const entry of before) {
    const mb = score.masterBars[entry.index];
    mb.timeSignatureNumerator = entry.numerator;
    mb.timeSignatureDenominator = entry.denominator;
    let flat = 0;
    for (const track of score.tracks) {
      for (const staff of track.staves) {
        const bar = staff.bars[entry.index];
        const voiceSnapshots = entry.staves[flat++];
        bar.voices.forEach((voice, vi) => {
          if (voiceSnapshots[vi]) restoreVoice(at, voice, voiceSnapshots[vi]);
        });
      }
    }
  }
}

// ---- track management (Phase 4) ---------------------------------------------

// Each track occupies two MIDI channels; channel 9 is reserved for drums.
export function allocateChannels(score) {
  const used = new Set(score.tracks.flatMap(t =>
    [t.playbackInfo.primaryChannel, t.playbackInfo.secondaryChannel]));
  let ch = 0;
  const next = () => {
    while (used.has(ch) || ch === 9) ch++;
    used.add(ch);
    return ch;
  };
  return { primary: next(), secondary: next() };
}

// Add a stringed track at the end of the score, rest-filled to match every
// existing bar. Appending keeps all existing track indexes (and therefore
// selection paths and undo entries) valid.
export function addTrack(at, score, { name, program = 25, strings = 6 }) {
  const track = new at.model.Track();
  track.name = name || `Track ${score.tracks.length + 1}`;
  track.ensureStaveCount(1);
  track.playbackInfo.program = program;
  const channels = allocateChannels(score);
  track.playbackInfo.primaryChannel = channels.primary;
  track.playbackInfo.secondaryChannel = channels.secondary;
  score.addTrack(track); // first: bar capacity below resolves via track.score
  const staff = track.staves[0];
  staff.showTablature = true;
  staff.stringTuning = at.model.Tuning.getDefaultTuningFor(strings);
  for (let i = 0; i < score.masterBars.length; i++) {
    const bar = new at.model.Bar();
    staff.addBar(bar);
    const voice = new at.model.Voice();
    bar.addVoice(voice);
    for (const d of restDurationsFor(barCapacityTicks(bar))) appendRestBeat(at, voice, d);
  }
  return track;
}

// Remove a track. Destructive across the undo model (all selection paths
// shift), so the editor clears its history around this.
export function removeTrackAt(score, index) {
  if (score.tracks.length <= 1 || !score.tracks[index]) return false;
  score.tracks.splice(index, 1);
  score.tracks.forEach((t, i) => { t.index = i; });
  return true;
}

// Rebuild all derived state after a batch of mutations.
export function finalizeEdit(score, settings) {
  score.finish(settings);
}
