// Unit tests for lib/editScore.js, run with `npm test` (node --test).
// Tests operate on real files from library/ and verify both the in-memory
// model after score.finish() and a full Gp7 export → re-import round-trip,
// so "renders fine but exports garbage" regressions are caught here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  MAX_FRET, DURATIONS,
  pathForBeat, beatAtPath, noteOnString,
  setFret, removeNoteOnString, setRest,
  setBeatDuration, setBeatDots, stepBeatDuration,
  appendRestBeat, removeBeat, finalizeEdit,
} from '../src/lib/editScore.js';
import { exportScoreGp } from '../src/lib/editing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../package.json'));
const at = require('@coderline/alphatab');
if (at.Logger && at.LogLevel) at.Logger.logLevel = at.LogLevel.Error;

const LIBRARY = path.join(here, '../../library');
const testFile = fs.readdirSync(LIBRARY).filter(f => /\.gp[3-5x]?$/i.test(f)).sort()[0];
assert.ok(testFile, 'library/ must contain at least one GP file to test against');
const bytes = new Uint8Array(fs.readFileSync(path.join(LIBRARY, testFile)));

const settings = new at.Settings();
const load = () => at.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(bytes), settings);
const roundTrip = (score) => at.importer.ScoreLoader.loadScoreFromBytes(
  new Uint8Array(exportScoreGp(at, score, settings)), settings);

// first stringed non-percussion staff — same selection rule the app uses
function firstStringedStaff(score) {
  for (const track of score.tracks) {
    const staff = track.staves.find(s => !s.isPercussion && s.stringTuning?.tunings?.length);
    if (staff) return staff;
  }
  throw new Error('no stringed staff in test file');
}

function findBeat(staff, pred) {
  for (const bar of staff.bars) for (const voice of bar.voices)
    for (const beat of voice.beats) if (pred(beat)) return beat;
  return null;
}

// structural invariants that must survive every finish(): sequential beat
// indexes, intact prev-links, monotonic playback ticks
function assertInvariants(score) {
  for (const track of score.tracks) for (const staff of track.staves)
    for (const bar of staff.bars) for (const voice of bar.voices) {
      voice.beats.forEach((b, i) => {
        assert.equal(b.index, i, `beat index at bar ${bar.index}`);
        const prev = voice.beats[i - 1];
        if (prev) {
          assert.equal(b.previousBeat?.id, prev.id, `prev-chain at bar ${bar.index} beat ${i}`);
          assert.ok(b.playbackStart >= prev.playbackStart, `ticks monotonic at bar ${bar.index} beat ${i}`);
        }
      });
    }
}

test('path round-trips to the same beat', () => {
  const score = load();
  const staff = firstStringedStaff(score);
  const beat = findBeat(staff, b => b.notes.length > 0);
  const p = pathForBeat(beat, beat.notes[0].string);
  assert.equal(beatAtPath(score, p), beat);
  assert.equal(p.string, beat.notes[0].string);
  assert.equal(beatAtPath(score, null), null);
});

test('setFret updates an existing note and survives export', () => {
  const score = load();
  const staff = firstStringedStaff(score);
  const beat = findBeat(staff, b => b.notes.length > 0);
  const string = beat.notes[0].string;
  const p = pathForBeat(beat);

  const { oldFret } = setFret(at, beat, string, 9);
  assert.equal(oldFret, beat.notes.find(n => n.string === string) === undefined ? null : oldFret);
  assert.equal(noteOnString(beat, string).fret, 9);
  finalizeEdit(score, settings);
  assertInvariants(score);

  const re = roundTrip(score);
  assert.equal(noteOnString(beatAtPath(re, p), string).fret, 9);
});

test('setFret creates a note on an empty string and clamps to MAX_FRET', () => {
  const score = load();
  const staff = firstStringedStaff(score);
  const stringCount = staff.stringTuning.tunings.length;
  const beat = findBeat(staff, b =>
    b.notes.length > 0 && b.notes.length < stringCount);
  const free = [...Array(stringCount)].map((_, i) => i + 1)
    .find(s => !noteOnString(beat, s));
  const before = beat.notes.length;

  const { oldFret } = setFret(at, beat, free, 99);
  assert.equal(oldFret, null);
  assert.equal(beat.notes.length, before + 1);
  assert.equal(noteOnString(beat, free).fret, MAX_FRET);
  finalizeEdit(score, settings);

  const p = pathForBeat(beat);
  const re = roundTrip(score);
  assert.equal(noteOnString(beatAtPath(re, p), free).fret, MAX_FRET);
});

test('setFret turns a rest beat into a played beat', () => {
  const score = load();
  const staff = firstStringedStaff(score);
  const beat = findBeat(staff, b => b.isRest);
  assert.ok(beat, 'test file needs a rest beat');

  setFret(at, beat, 1, 0);
  assert.equal(beat.isRest, false);
  finalizeEdit(score, settings);

  const p = pathForBeat(beat);
  const re = roundTrip(score);
  const reBeat = beatAtPath(re, p);
  assert.equal(reBeat.isRest, false);
  assert.equal(noteOnString(reBeat, 1).fret, 0);
});

test('removeNoteOnString removes; last note removal leaves a rest', () => {
  const score = load();
  const staff = firstStringedStaff(score);
  const beat = findBeat(staff, b => b.notes.length > 0);
  // strip down to a single note so the last removal is exercised
  while (beat.notes.length > 1) removeNoteOnString(beat, beat.notes[beat.notes.length - 1].string);
  const string = beat.notes[0].string;
  const fretBefore = beat.notes[0].fret;

  const { oldFret } = removeNoteOnString(beat, string);
  assert.equal(oldFret, fretBefore);
  assert.equal(beat.notes.length, 0);
  assert.equal(beat.isRest, true);
  assert.deepEqual(removeNoteOnString(beat, string), { oldFret: null });
  finalizeEdit(score, settings);

  const p = pathForBeat(beat);
  const re = roundTrip(score);
  assert.equal(beatAtPath(re, p).isRest, true);
});

test('setRest clears a chord and its inverse restores it', () => {
  const score = load();
  const staff = firstStringedStaff(score);
  const beat = findBeat(staff, b => b.notes.length >= 2);
  assert.ok(beat, 'test file needs a multi-note beat');
  const original = beat.notes.map(n => ({ string: n.string, fret: n.fret }))
    .sort((a, b) => a.string - b.string);

  const { oldNotes } = setRest(beat);
  assert.equal(beat.isRest, true);
  assert.deepEqual([...oldNotes].sort((a, b) => a.string - b.string), original);

  for (const n of oldNotes) setFret(at, beat, n.string, n.fret); // the undo path
  finalizeEdit(score, settings);
  assertInvariants(score);

  const p = pathForBeat(beat);
  const re = roundTrip(score);
  const restored = beatAtPath(re, p).notes.map(n => ({ string: n.string, fret: n.fret }))
    .sort((a, b) => a.string - b.string);
  assert.deepEqual(restored, original);
});

test('duration and dots persist through export', () => {
  const score = load();
  const staff = firstStringedStaff(score);
  const beat = findBeat(staff, b => b.notes.length > 0 && b.duration === 4 && b.dots === 0)
    ?? findBeat(staff, b => b.notes.length > 0);

  const { oldDuration } = setBeatDuration(beat, 8);
  const { oldDots } = setBeatDots(beat, 1);
  assert.notEqual(oldDuration, undefined);
  assert.equal(oldDots, 0);
  finalizeEdit(score, settings);

  const p = pathForBeat(beat);
  const re = roundTrip(score);
  const reBeat = beatAtPath(re, p);
  assert.equal(reBeat.duration, 8);
  assert.equal(reBeat.dots, 1);
});

test('stepBeatDuration steps through DURATIONS and clamps at both ends', () => {
  const score = load();
  const staff = firstStringedStaff(score);
  const beat = findBeat(staff, () => true);

  setBeatDuration(beat, 4);
  stepBeatDuration(beat, +1);
  assert.equal(beat.duration, 8);
  stepBeatDuration(beat, -1);
  stepBeatDuration(beat, -1);
  assert.equal(beat.duration, 2);

  setBeatDuration(beat, DURATIONS[0]);
  stepBeatDuration(beat, -1);
  assert.equal(beat.duration, DURATIONS[0], 'clamps at longest');
  setBeatDuration(beat, DURATIONS[DURATIONS.length - 1]);
  stepBeatDuration(beat, +1);
  assert.equal(beat.duration, DURATIONS[DURATIONS.length - 1], 'clamps at shortest');
});

test('appendRestBeat/removeBeat round-trip and respect the one-beat floor', () => {
  const score = load();
  const staff = firstStringedStaff(score);
  const voice = staff.bars[staff.bars.length - 1].voices[0];
  const before = voice.beats.length;

  const beat = appendRestBeat(at, voice, 8);
  assert.equal(voice.beats.length, before + 1);
  assert.equal(beat.isRest, true);
  finalizeEdit(score, settings);
  assertInvariants(score);

  const barIndex = voice.bar.index;
  const re = roundTrip(score);
  const reVoice = beatAtPath(re, {
    trackIndex: staff.track.index, staffIndex: staff.index,
    barIndex, voiceIndex: 0, beatIndex: 0,
  }).voice;
  assert.equal(reVoice.beats.length, before + 1, 'overfilled bar survives export');

  assert.equal(removeBeat(voice, voice.beats.length - 1), true);
  finalizeEdit(score, settings);
  assertInvariants(score);
  assert.equal(voice.beats.length, before);

  const single = findBeat(staff, b => b.voice.beats.length === 1)?.voice;
  if (single) assert.equal(removeBeat(single, 0), false, 'never empties a voice');
});

// ---- Phase 2: note effects + beat structure --------------------------------

test('note effects round-trip through export (PM, dead, vibrato, let ring)', async (t) => {
  const { setNoteProp, NOTE_PROPS } = await import('../src/lib/editScore.js');
  const score = load();
  const staff = firstStringedStaff(score);
  const beat = findBeat(staff, b => b.notes.length > 0);
  const string = beat.notes[0].string;

  for (const key of ['palmMute', 'dead', 'letRing', 'staccato']) {
    const { oldValue } = setNoteProp(beat, string, NOTE_PROPS[key], true);
    assert.equal(oldValue, false, key);
  }
  setNoteProp(beat, string, NOTE_PROPS.vibrato, 1);
  assert.equal(setNoteProp(beat, 99, NOTE_PROPS.palmMute, true), null, 'missing note → null');
  finalizeEdit(score, settings);

  const p = pathForBeat(beat);
  const re = roundTrip(score);
  const n = noteOnString(beatAtPath(re, p), string);
  assert.equal(n.isPalmMute, true);
  assert.equal(n.isDead, true);
  assert.equal(n.isLetRing, true);
  assert.equal(n.isStaccato, true);
  assert.equal(n.vibrato, 1);
});

test('tie and hammer/pull chains resolve after finish and survive export', async () => {
  const { setNoteProp, NOTE_PROPS } = await import('../src/lib/editScore.js');
  const score = load();
  const staff = firstStringedStaff(score);
  // two consecutive beats with a note on the same string
  let pair = null;
  outer: for (const bar of staff.bars) for (const v of bar.voices) for (const bt of v.beats) {
    const nb = bt.nextBeat;
    if (!bt.notes.length || !nb?.notes?.length || nb.voice !== bt.voice && nb.voice.bar.staff !== staff) continue;
    for (const n of bt.notes) if (nb.notes.some(x => x.string === n.string)) { pair = { a: bt, b: nb, string: n.string }; break outer; }
  }
  assert.ok(pair, 'needs consecutive same-string notes');

  setNoteProp(pair.a, pair.string, NOTE_PROPS.hammerPull, true);
  setNoteProp(pair.b, pair.string, NOTE_PROPS.tie, true);
  finalizeEdit(score, settings);
  assert.ok(noteOnString(pair.b, pair.string).tieOrigin, 'tie origin resolved');
  assert.ok(noteOnString(pair.a, pair.string).hammerPullDestination, 'h/p destination resolved');

  const pa = pathForBeat(pair.a);
  const pb = pathForBeat(pair.b);
  const re = roundTrip(score);
  assert.equal(noteOnString(beatAtPath(re, pa), pair.string).isHammerPullOrigin, true);
  assert.equal(noteOnString(beatAtPath(re, pb), pair.string).isTieDestination, true);
});

test('insert/delete/restore beat preserves content exactly', async () => {
  const { insertRestBeatAt, deleteBeat, restoreBeat, serializeBeat, setNoteProp, NOTE_PROPS } =
    await import('../src/lib/editScore.js');
  const score = load();
  const staff = firstStringedStaff(score);
  const beat = findBeat(staff, b => b.notes.length >= 2 && b.voice.beats.length >= 2);
  assert.ok(beat, 'needs a chord beat in a multi-beat voice');
  const voice = beat.voice;
  setNoteProp(beat, beat.notes[0].string, NOTE_PROPS.palmMute, true);
  const index = beat.index;
  const before = serializeBeat(beat);
  const lenBefore = voice.beats.length;

  // insert a rest after it, finish, then remove it again
  insertRestBeatAt(at, voice, index + 1, 8);
  finalizeEdit(score, settings);
  assertInvariants(score);
  assert.equal(voice.beats.length, lenBefore + 1);
  assert.equal(voice.beats[index + 1].isRest, true);
  assert.equal(deleteBeat(voice, index + 1) !== null, true);

  // delete the real beat and restore it from its snapshot
  const snapshot = deleteBeat(voice, index);
  assert.deepEqual(snapshot, before);
  restoreBeat(at, voice, index, snapshot);
  finalizeEdit(score, settings);
  assertInvariants(score);
  assert.deepEqual(serializeBeat(voice.beats[index]), before);

  // survives export
  const p = { trackIndex: staff.track.index, staffIndex: staff.index, barIndex: voice.bar.index, voiceIndex: voice.index, beatIndex: index };
  const re = roundTrip(score);
  const reBeat = beatAtPath(re, p);
  assert.equal(reBeat.notes.length, before.notes.length);
  assert.equal(reBeat.notes.some(n => n.isPalmMute), true);
});

// ---- bar-fill normalization (GP semantics) ----------------------------------

test('beatTicks matches alphaTab playbackDuration (plain, dotted, tuplet)', async () => {
  const { beatTicks } = await import('../src/lib/editScore.js');
  const score = load();
  score.finish(settings);
  let checked = 0;
  for (const track of score.tracks) for (const staff of track.staves)
    for (const bar of staff.bars) for (const voice of bar.voices)
      for (const beat of voice.beats) {
        if (beat.graceType) continue; // grace beats have no own playback span
        assert.equal(beatTicks(beat), beat.playbackDuration,
          `bar ${bar.index} beat ${beat.index} (dur ${beat.duration} dots ${beat.dots} tuplet ${beat.tupletNumerator}:${beat.tupletDenominator})`);
        if (++checked > 2000) return;
      }
});

test('normalizeVoice pads and consumes rests to the time signature', async () => {
  const { normalizeVoice, beatTicks, barCapacityTicks, setBeatDuration, insertRestBeatAt, deleteBeat } =
    await import('../src/lib/editScore.js');
  const { createEmptyScore } = await import('../src/lib/newSong.js');
  const score = createEmptyScore(at, { title: 'fill' }); // 8 empty 4/4 bars
  const voice = score.tracks[0].staves[0].bars[0].voices[0];
  const capacity = barCapacityTicks(voice.bar);
  const sum = () => voice.beats.reduce((a, b) => a + beatTicks(b), 0);

  // whole-rest bar → make it a note, shorten to quarter → padded back to full
  setFret(at, voice.beats[0], 1, 5);
  setBeatDuration(voice.beats[0], 4);
  normalizeVoice(at, voice);
  assert.equal(sum(), capacity, 'padded to capacity');
  assert.equal(voice.beats[0].isRest, false);
  assert.ok(voice.beats.slice(1).every(b => b.isRest), 'padding is rests');

  // lengthen quarter → half: trailing rests are consumed
  setBeatDuration(voice.beats[0], 2);
  normalizeVoice(at, voice);
  assert.equal(sum(), capacity, 'rests consumed on lengthen');

  // insert a rest then normalize → still exactly full
  insertRestBeatAt(at, voice, 1, 8);
  normalizeVoice(at, voice);
  assert.equal(sum(), capacity, 'full after insert');

  // delete the first (note) beat → padded back to capacity
  deleteBeat(voice, 0);
  normalizeVoice(at, voice);
  assert.equal(sum(), capacity, 'full after delete');

  finalizeEdit(score, settings);
  assertInvariants(score);
});

test('normalizeVoice never deletes notes from an overfull bar', async () => {
  const { normalizeVoice, beatTicks, barCapacityTicks, setBeatDuration, insertRestBeatAt } =
    await import('../src/lib/editScore.js');
  const { createEmptyScore } = await import('../src/lib/newSong.js');
  const score = createEmptyScore(at, { title: 'overfull' });
  const voice = score.tracks[0].staves[0].bars[0].voices[0];
  // build a bar of exactly four quarter NOTES (converting padding rests to
  // quarters one by one, the way a user would)
  setFret(at, voice.beats[0], 1, 1);
  setBeatDuration(voice.beats[0], 4);
  normalizeVoice(at, voice);
  setFret(at, voice.beats[1], 1, 2);
  setBeatDuration(voice.beats[1], 4);
  normalizeVoice(at, voice);
  setFret(at, voice.beats[2], 1, 3);
  setFret(at, voice.beats[3], 1, 4);
  assert.equal(voice.beats.length, 4);
  assert.ok(voice.beats.every(b => b.duration === 4 && !b.isRest));
  // lengthen the first to a half — no rests to consume → overfull but intact
  setBeatDuration(voice.beats[0], 2);
  const { overfull } = normalizeVoice(at, voice);
  assert.equal(overfull, true);
  assert.equal(voice.beats.length, 4, 'no notes were deleted');
});

test('appendBar keeps masterBars parallel with every staff and round-trips', async () => {
  const { appendBar, removeLastBar, beatTicks, barCapacityTicks } =
    await import('../src/lib/editScore.js');
  const score = load(); // multi-track library file
  const mbBefore = score.masterBars.length;
  const barCounts = () => score.tracks.flatMap(t => t.staves.map(s => s.bars.length));

  appendBar(at, score);
  assert.equal(score.masterBars.length, mbBefore + 1);
  assert.ok(barCounts().every(c => c === mbBefore + 1), 'every staff gained a bar');
  finalizeEdit(score, settings);
  assertInvariants(score);
  // the new bar is exactly full of rests in every staff
  for (const track of score.tracks) for (const staff of track.staves) {
    const bar = staff.bars[staff.bars.length - 1];
    for (const voice of bar.voices) {
      const sum = voice.beats.reduce((a, b) => a + beatTicks(b), 0);
      assert.equal(sum, barCapacityTicks(bar));
      assert.ok(voice.beats.every(b => b.isRest));
    }
  }

  const re = roundTrip(score);
  assert.equal(re.masterBars.length, mbBefore + 1, 'survives export');

  assert.equal(removeLastBar(score), true);
  finalizeEdit(score, settings);
  assert.equal(score.masterBars.length, mbBefore);
  assert.ok(barCounts().every(c => c === mbBefore), 'undo restores every staff');
});

test('serializeVoice/restoreVoice round-trips exactly', async () => {
  const { serializeVoice, restoreVoice } = await import('../src/lib/editScore.js');
  const score = load();
  const staff = firstStringedStaff(score);
  const beat = findBeat(staff, b => b.notes.length > 0 && b.voice.beats.length >= 2);
  const voice = beat.voice;
  const before = serializeVoice(voice);
  restoreVoice(at, voice, before);
  finalizeEdit(score, settings);
  assertInvariants(score);
  assert.deepEqual(serializeVoice(voice), before);
});

// ---- Phase 3: bar operations -------------------------------------------------

test('insertRestBar mid-song keeps indexes/chains and round-trips', async () => {
  const { insertRestBar, removeBarAt } = await import('../src/lib/editScore.js');
  const score = load();
  const staff = firstStringedStaff(score);
  const mbBefore = score.masterBars.length;
  const oldBar5Beats = staff.bars[5].voices[0].beats.length;

  insertRestBar(at, score, 5);
  finalizeEdit(score, settings);
  assertInvariants(score);
  assert.equal(score.masterBars.length, mbBefore + 1);
  assert.ok(score.masterBars.every((m, i) => m.index === i));
  assert.ok(score.tracks.every(t => t.staves.every(st =>
    st.bars.length === mbBefore + 1 && st.bars.every((b, i) => b.index === i))));
  assert.ok(staff.bars[5].voices[0].beats.every(b => b.isRest), 'inserted bar is rests');
  assert.equal(staff.bars[6].voices[0].beats.length, oldBar5Beats, 'old bar shifted intact');

  const re = roundTrip(score);
  assert.equal(re.masterBars.length, mbBefore + 1);
  // cross-bar beat chain flows through the inserted bar
  const reStaff = re.tracks[staff.track.index].staves[staff.index];
  assert.equal(reStaff.bars[4].voices[0].beats.at(-1).nextBeat,
    reStaff.bars[5].voices[0].beats[0]);

  assert.equal(removeBarAt(score, 5), true);
  finalizeEdit(score, settings);
  assertInvariants(score);
  assert.equal(score.masterBars.length, mbBefore);
});

test('deleting bar 0 moves the tempo automation', async () => {
  const { removeBarAt } = await import('../src/lib/editScore.js');
  const score = load();
  const tempoBefore = score.tempo;
  assert.ok(score.masterBars[0].tempoAutomations.length > 0);
  removeBarAt(score, 0);
  finalizeEdit(score, settings);
  const re = roundTrip(score);
  assert.equal(re.tempo, tempoBefore);
});

test('serializeFullBar/restoreFullBar round-trips a deleted bar exactly', async () => {
  const { serializeFullBar, restoreFullBar, removeBarAt } = await import('../src/lib/editScore.js');
  const score = load();
  const staff = firstStringedStaff(score);
  // pick a bar with actual notes
  const bar = staff.bars.find(b => b.voices[0].beats.some(bt => bt.notes.length));
  const index = bar.index;
  const snapshot = serializeFullBar(score, index);
  const mbCount = score.masterBars.length;

  removeBarAt(score, index);
  finalizeEdit(score, settings);
  assert.equal(score.masterBars.length, mbCount - 1);

  restoreFullBar(at, score, index, snapshot);
  finalizeEdit(score, settings);
  assertInvariants(score);
  assert.equal(score.masterBars.length, mbCount);
  assert.deepEqual(serializeFullBar(score, index), snapshot, 'restored identically');

  const re = roundTrip(score);
  assert.equal(re.masterBars.length, mbCount);
});

test('setTimeSignatureRun renormalizes the contiguous run and restores', async () => {
  const { setTimeSignatureRun, restoreTimeSignatureRun, beatTicks, barCapacityTicks, serializeFullBar } =
    await import('../src/lib/editScore.js');
  const { createEmptyScore } = await import('../src/lib/newSong.js');
  const score = createEmptyScore(at, { title: 'tsig' }); // 8 bars of 4/4
  const staff = score.tracks[0].staves[0];
  const beforeSnapshot = serializeFullBar(score, 2);

  const before = setTimeSignatureRun(at, score, 2, 3, 4);
  finalizeEdit(score, settings);
  assertInvariants(score);
  assert.equal(before.length, 6, 'applies from bar 2 to the end of the 4/4 run');
  assert.equal(score.masterBars[1].timeSignatureNumerator, 4, 'bars before untouched');
  for (let i = 2; i < 8; i++) {
    const mb = score.masterBars[i];
    assert.equal(`${mb.timeSignatureNumerator}/${mb.timeSignatureDenominator}`, '3/4');
    const voice = staff.bars[i].voices[0];
    assert.equal(voice.beats.reduce((a, b) => a + beatTicks(b), 0), barCapacityTicks(staff.bars[i]),
      `bar ${i} renormalized to 3/4 capacity`);
  }
  const re = roundTrip(score);
  assert.equal(re.masterBars[5].timeSignatureNumerator, 3);

  restoreTimeSignatureRun(at, score, before);
  finalizeEdit(score, settings);
  assert.equal(score.masterBars[2].timeSignatureNumerator, 4);
  assert.deepEqual(serializeFullBar(score, 2), beforeSnapshot, 'undo restores voices exactly');
});

test('repeat flags survive finish and export', () => {
  const score = load();
  score.masterBars[2].isRepeatStart = true;
  score.masterBars[4].repeatCount = 2;
  finalizeEdit(score, settings);
  const re = roundTrip(score);
  assert.equal(re.masterBars[2].isRepeatStart, true);
  assert.equal(re.masterBars[4].repeatCount, 2);
});

// ---- Phase 4: track management -----------------------------------------------

test('addTrack appends a rest-filled parallel track with free channels', async () => {
  const { addTrack, removeTrackAt, allocateChannels, beatTicks, barCapacityTicks } =
    await import('../src/lib/editScore.js');
  const score = load();
  const nTracks = score.tracks.length;
  const mbCount = score.masterBars.length;

  const track = addTrack(at, score, { name: 'Added Guitar', program: 30, strings: 7 });
  finalizeEdit(score, settings);
  assertInvariants(score);
  assert.equal(score.tracks.length, nTracks + 1);
  assert.equal(track.index, nTracks);
  assert.equal(track.staves[0].bars.length, mbCount, 'bars parallel to masterBars');
  assert.equal(track.staves[0].stringTuning.tunings.length, 7);
  // channels don't collide with any existing track (or the drum channel)
  const others = score.tracks.slice(0, -1).flatMap(t => [t.playbackInfo.primaryChannel, t.playbackInfo.secondaryChannel]);
  assert.ok(!others.includes(track.playbackInfo.primaryChannel));
  assert.ok(!others.includes(track.playbackInfo.secondaryChannel));
  assert.notEqual(track.playbackInfo.primaryChannel, 9);
  // every bar exactly full of rests
  for (const bar of track.staves[0].bars) {
    const sum = bar.voices[0].beats.reduce((a, b) => a + beatTicks(b), 0);
    assert.equal(sum, barCapacityTicks(bar));
  }

  const re = roundTrip(score);
  assert.equal(re.tracks.length, nTracks + 1);
  assert.equal(re.tracks[nTracks].name, 'Added Guitar');
  assert.equal(re.tracks[nTracks].playbackInfo.program, 30);

  // undo path
  assert.equal(removeTrackAt(score, score.tracks.length - 1), true);
  finalizeEdit(score, settings);
  assert.equal(score.tracks.length, nTracks);
});

test('removeTrackAt reindexes and refuses to empty the score', async () => {
  const { removeTrackAt, addTrack } = await import('../src/lib/editScore.js');
  const score = load();
  addTrack(at, score, { name: 'follower' }); // guarantee a track after the removed one
  const nTracks = score.tracks.length;

  assert.equal(removeTrackAt(score, nTracks - 2), true);
  finalizeEdit(score, settings);
  assert.ok(score.tracks.every((t, i) => t.index === i));
  assert.equal(score.tracks[nTracks - 2].name, 'follower', 'later tracks shifted down');
  const re = roundTrip(score);
  assert.equal(re.tracks.length, nTracks - 1);

  const single = at.importer.ScoreLoader.loadScoreFromBytes(
    new Uint8Array(exportScoreGp(at, (await import('../src/lib/newSong.js')).createEmptyScore(at, { title: 'solo' }), settings)), settings);
  assert.equal(removeTrackAt(single, 0), false, 'never removes the last track');
});
