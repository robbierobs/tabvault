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
