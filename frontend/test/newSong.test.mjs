// Unit tests for lib/newSong.js — the blank score must survive a Gp7 export
// round-trip and be editable afterwards (it feeds straight into edit mode).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createEmptyScore, suggestFilename, DEFAULT_BARS } from '../src/lib/newSong.js';
import { exportScoreGp } from '../src/lib/editing.js';
import { setFret, finalizeEdit } from '../src/lib/editScore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../package.json'));
const at = require('@coderline/alphatab');
if (at.Logger && at.LogLevel) at.Logger.logLevel = at.LogLevel.Error;
const settings = new at.Settings();

test('createEmptyScore round-trips through Gp7 export', () => {
  const score = createEmptyScore(at, { title: 'Riff Idea', artist: 'Sean', tempo: 140 });
  const re = at.importer.ScoreLoader.loadScoreFromBytes(
    new Uint8Array(exportScoreGp(at, score, settings)), settings);

  assert.equal(re.title, 'Riff Idea');
  assert.equal(re.artist, 'Sean');
  assert.equal(re.tempo, 140);
  assert.equal(re.masterBars.length, DEFAULT_BARS);
  assert.equal(re.tracks.length, 1);
  assert.equal(re.masterBars[0].timeSignatureNumerator, 4);
  const staff = re.tracks[0].staves[0];
  assert.equal(staff.stringTuning.tunings.length, 6);
  // every bar holds exactly one whole-rest beat
  for (const bar of staff.bars) {
    assert.equal(bar.voices[0].beats.length, 1);
    assert.equal(bar.voices[0].beats[0].isRest, true);
  }
});

test('a freshly created score is editable (fret entry + re-export)', () => {
  const score = createEmptyScore(at, { title: 'x' });
  const re = at.importer.ScoreLoader.loadScoreFromBytes(
    new Uint8Array(exportScoreGp(at, score, settings)), settings);
  const beat = re.tracks[0].staves[0].bars[0].voices[0].beats[0];
  setFret(at, beat, 1, 3);
  finalizeEdit(re, settings);
  const re2 = at.importer.ScoreLoader.loadScoreFromBytes(
    new Uint8Array(exportScoreGp(at, re, settings)), settings);
  const b2 = re2.tracks[0].staves[0].bars[0].voices[0].beats[0];
  assert.equal(b2.isRest, false);
  assert.equal(b2.notes.find(n => n.string === 1)?.fret, 3);
});

test('tempo clamps and filename slugs are sane', () => {
  assert.equal(createEmptyScore(at, { title: 'x', tempo: 9999 }).tempo, 400);
  assert.equal(createEmptyScore(at, { title: 'x', tempo: 1 }).tempo, 20);
  assert.equal(suggestFilename('My New Song!'), 'my-new-song.gp');
  assert.equal(suggestFilename('  ***  '), 'untitled.gp');
  assert.equal(suggestFilename(''), 'untitled.gp');
});
