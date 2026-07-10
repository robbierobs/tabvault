import React, { useEffect, useRef, useState } from 'react';
import styles from './EditToolbar.module.css';
import { DURATIONS } from '../lib/editScore.js';

const DURATION_LABELS = { 1: '1', 2: '1/2', 4: '1/4', 8: '1/8', 16: '1/16', 32: '1/32', 64: '1/64' };

// curated GM programs for new/edited tracks (full GM picker can come later)
const INSTRUMENTS = [
  [24, 'Nylon Guitar'],
  [25, 'Steel Guitar'],
  [26, 'Jazz Electric'],
  [27, 'Clean Electric'],
  [29, 'Overdrive Guitar'],
  [30, 'Distortion Guitar'],
  [33, 'Bass (finger)'],
  [34, 'Bass (pick)'],
];

function draftStatusText(ed) {
  switch (ed.draftStatus) {
    case 'dirty': return 'Unsaved changes';
    case 'saving': return 'Saving draft…';
    case 'saved': return ed.draftSavedAt
      ? `Draft saved ${new Date(ed.draftSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Draft saved';
    case 'error': return 'Draft save failed — retrying';
    default: return null;
  }
}

export default function EditToolbar({ ed, editor, saving, saveError, onSaveVersion, onDiscard, onExit, onRemoveTrack }) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [label, setLabel] = useState('edited');
  const saveWrapRef = useRef(null);
  const [tsOpen, setTsOpen] = useState(false);
  const [tsNum, setTsNum] = useState('4');
  const [tsDen, setTsDen] = useState('4');
  const tsWrapRef = useRef(null);
  const [trackOpen, setTrackOpen] = useState(false); // null-form: add; string: rename
  const [trackMode, setTrackMode] = useState('add');
  const [trackName, setTrackName] = useState('');
  const [trackProgram, setTrackProgram] = useState('25');
  const [trackStrings, setTrackStrings] = useState('6');
  const trackWrapRef = useRef(null);

  useEffect(() => {
    if (!saveOpen && !tsOpen && !trackOpen) return;
    const onDown = (e) => {
      if (saveOpen && saveWrapRef.current && !saveWrapRef.current.contains(e.target)) setSaveOpen(false);
      if (tsOpen && tsWrapRef.current && !tsWrapRef.current.contains(e.target)) setTsOpen(false);
      if (trackOpen && trackWrapRef.current && !trackWrapRef.current.contains(e.target)) setTrackOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [saveOpen, tsOpen, trackOpen]);

  const hasSel = !!ed.selection;
  const info = ed.beatInfo;
  const bar = ed.barInfo;
  const track = ed.trackInfo;
  const status = draftStatusText(ed);

  const submitTrackForm = () => {
    setTrackOpen(false);
    if (trackMode === 'add') {
      editor.addNewTrack({
        name: trackName.trim() || undefined,
        program: parseInt(trackProgram, 10),
        strings: parseInt(trackStrings, 10),
      });
    } else {
      editor.renameTrack(trackName);
    }
  };

  return (
    <div className={styles.toolbar}>
      <div className={styles.group} title="Beat duration ( [ longer / ] shorter )">
        {DURATIONS.map(d => (
          <button
            key={d}
            className={`${styles.btn} ${info?.duration === d ? styles.active : ''}`}
            disabled={!hasSel}
            onClick={() => editor.setDuration(d)}
          >
            {DURATION_LABELS[d]}
          </button>
        ))}
        <button
          className={`${styles.btn} ${info?.dots > 0 ? styles.active : ''}`}
          disabled={!hasSel}
          onClick={() => editor.cycleDots()}
          title="Dotted note ( . )"
        >
          {info?.dots === 2 ? '··' : '·'}
        </button>
      </div>

      <div className={styles.group}>
        <button
          className={`${styles.btn} ${info?.isRest ? styles.active : ''}`}
          disabled={!hasSel}
          onClick={() => editor.toggleRest()}
          title="Turn the beat into a rest ( R )"
        >
          Rest
        </button>
        <button
          className={styles.btn}
          disabled={!hasSel}
          onClick={() => editor.deleteNote()}
          title="Delete the note under the caret ( Del )"
        >
          Del
        </button>
        <button
          className={styles.btn}
          disabled={!hasSel}
          onClick={() => editor.insertBeatAfterSelection()}
          title="Insert a beat after this one ( Enter )"
        >
          +Beat
        </button>
        <button
          className={styles.btn}
          disabled={!hasSel || !info?.canDeleteBeat}
          onClick={() => editor.deleteSelectedBeat()}
          title="Delete this beat ( Shift+Del )"
        >
          −Beat
        </button>
      </div>

      <div className={styles.group}>
        {[
          ['palmMute', 'PM', 'Palm mute ( P )'],
          ['hammerPull', 'H/P', 'Hammer-on / pull-off to the next note ( H )'],
          ['tie', 'Tie', 'Tie to the previous note ( T )'],
          ['dead', '✕', 'Dead note ( X )'],
          ['vibrato', 'Vib', 'Vibrato ( V )'],
          ['letRing', 'Ring', 'Let ring ( G )'],
        ].map(([key, label, title]) => (
          <button
            key={key}
            className={`${styles.btn} ${info?.note?.[key] ? styles.active : ''}`}
            disabled={!info?.hasNote}
            onClick={() => editor.toggleNoteProp(key)}
            title={title}
          >
            {label}
          </button>
        ))}
      </div>

      <div className={styles.group}>
        <button className={styles.btn} disabled={!hasSel} onClick={() => editor.insertBar('before')} title="Insert an empty bar before this one">
          +Bar◂
        </button>
        <button className={styles.btn} disabled={!hasSel} onClick={() => editor.insertBar('after')} title="Insert an empty bar after this one">
          ▸Bar+
        </button>
        <button
          className={styles.btn}
          disabled={!hasSel || !bar || bar.count <= 1}
          onClick={() => editor.deleteSelectedBar()}
          title="Delete this bar from every track"
        >
          −Bar
        </button>
        <span className={styles.saveWrap} ref={tsWrapRef}>
          <button
            className={styles.btn}
            disabled={!hasSel}
            onClick={() => {
              if (bar) { setTsNum(String(bar.numerator)); setTsDen(String(bar.denominator)); }
              setTsOpen(o => !o);
            }}
            title="Time signature (applies from this bar through its matching run)"
          >
            {bar ? `${bar.numerator}/${bar.denominator}` : '4/4'}
          </button>
          {tsOpen && (
            <div className={styles.savePanel}>
              <div className={styles.saveTitle}>Time signature</div>
              <div className={styles.saveRow}>
                <input
                  className={styles.saveInput}
                  type="number" min="1" max="32"
                  value={tsNum}
                  onChange={e => setTsNum(e.target.value)}
                  autoFocus
                />
                <span>/</span>
                <select className={styles.saveInput} value={tsDen} onChange={e => setTsDen(e.target.value)}>
                  {[1, 2, 4, 8, 16, 32].map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <button
                  className={styles.saveBtn}
                  onClick={() => {
                    const n = Math.max(1, Math.min(32, parseInt(tsNum, 10) || 4));
                    setTsOpen(false);
                    editor.setTimeSignature(n, parseInt(tsDen, 10));
                  }}
                >
                  Apply
                </button>
              </div>
              <div className={styles.saveHint}>
                Applies to this bar and the following bars that share its current signature.
                Bars are re-padded with rests to fit.
              </div>
            </div>
          )}
        </span>
        <button
          className={`${styles.btn} ${bar?.repeatStart ? styles.active : ''}`}
          disabled={!hasSel}
          onClick={() => editor.toggleRepeat('start')}
          title="Repeat start ‖:"
        >
          ‖:
        </button>
        <button
          className={`${styles.btn} ${bar?.repeatEnd ? styles.active : ''}`}
          disabled={!hasSel}
          onClick={() => editor.toggleRepeat('end')}
          title="Repeat end :‖ (×2)"
        >
          :‖
        </button>
      </div>

      <div className={styles.group}>
        <span className={styles.saveWrap} ref={trackWrapRef}>
          <button
            className={styles.btn}
            onClick={() => {
              setTrackMode('add');
              setTrackName('');
              setTrackOpen(o => !o);
            }}
            title="Add a new track"
          >
            +Track
          </button>
          <button
            className={styles.btn}
            disabled={!track}
            onClick={() => {
              setTrackMode('rename');
              setTrackName(track?.name ?? '');
              setTrackOpen(o => !o);
            }}
            title="Rename the current track"
          >
            Ren
          </button>
          {trackOpen && (
            <div className={styles.savePanel}>
              <div className={styles.saveTitle}>
                {trackMode === 'add' ? 'Add track' : `Rename "${track?.name}"`}
              </div>
              <div className={styles.saveRow}>
                <input
                  className={styles.saveInput}
                  value={trackName}
                  onChange={e => setTrackName(e.target.value)}
                  placeholder={trackMode === 'add' ? 'Track name (optional)' : 'Track name'}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') submitTrackForm(); }}
                />
              </div>
              {trackMode === 'add' && (
                <div className={styles.saveRow}>
                  <select className={styles.saveInput} value={trackProgram} onChange={e => setTrackProgram(e.target.value)}>
                    {INSTRUMENTS.map(([p, label]) => <option key={p} value={p}>{label}</option>)}
                  </select>
                  <select className={styles.saveInput} value={trackStrings} onChange={e => setTrackStrings(e.target.value)} title="Strings">
                    {[4, 5, 6, 7].map(s => <option key={s} value={s}>{s} str</option>)}
                  </select>
                </div>
              )}
              <div className={styles.saveRow}>
                <button className={styles.saveBtn} onClick={submitTrackForm}>
                  {trackMode === 'add' ? 'Add' : 'Rename'}
                </button>
              </div>
            </div>
          )}
        </span>
        <select
          className={styles.btn}
          disabled={!track}
          value={track ? String(track.program) : '25'}
          onChange={e => editor.setTrackInstrument(parseInt(e.target.value, 10))}
          title="Instrument of the current track"
        >
          {INSTRUMENTS.map(([p, label]) => <option key={p} value={p}>{label}</option>)}
          {track && !INSTRUMENTS.some(([p]) => p === track.program) && (
            <option value={track.program}>{`Program ${track.program}`}</option>
          )}
        </select>
        <button
          className={styles.btn}
          disabled={!track || track.count <= 1}
          onClick={onRemoveTrack}
          title="Delete the current track (cannot be undone)"
        >
          −Track
        </button>
      </div>

      <div className={styles.group}>
        <button className={styles.btn} disabled={!ed.canUndo} onClick={() => editor.undo()} title="Undo (Cmd/Ctrl+Z)">↶</button>
        <button className={styles.btn} disabled={!ed.canRedo} onClick={() => editor.redo()} title="Redo (Cmd/Ctrl+Shift+Z)">↷</button>
      </div>

      <span className={styles.hint}>
        {hasSel
          ? (ed.digitPending != null ? `Fret: ${ed.digitPending}…` : 'Type frets · arrows move · Enter inserts a beat')
          : 'Click a string in the tab to start editing'}
      </span>

      <div className={styles.right}>
        {status && (
          <span className={`${styles.status} ${ed.draftStatus === 'error' ? styles.statusError : ''}`}>
            {status}
          </span>
        )}
        {ed.scoreDirty && (
          <button className={styles.btn} onClick={onDiscard} title="Throw away all draft edits and reload the file">
            Discard
          </button>
        )}
        <span className={styles.saveWrap} ref={saveWrapRef}>
          <button
            className={styles.saveBtn}
            disabled={!ed.scoreDirty || saving}
            onClick={() => setSaveOpen(o => !o)}
          >
            {saving ? 'Saving…' : 'Save as version'}
          </button>
          {saveOpen && (
            <div className={styles.savePanel}>
              <div className={styles.saveTitle}>Save edits as a new version</div>
              <div className={styles.saveRow}>
                <input
                  className={styles.saveInput}
                  value={label}
                  onChange={e => setLabel(e.target.value)}
                  maxLength={80}
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') { setSaveOpen(false); onSaveVersion(label); } }}
                />
                <button
                  className={styles.saveBtn}
                  disabled={saving}
                  onClick={() => { setSaveOpen(false); onSaveVersion(label); }}
                >
                  Save
                </button>
              </div>
              {saveError && <div className={styles.saveError}>{saveError}</div>}
              <div className={styles.saveHint}>
                The original file is never modified — versions live in the dropdown.
              </div>
            </div>
          )}
        </span>
        <button className={styles.btn} onClick={onExit} title="Leave edit mode (draft is kept)">
          Done
        </button>
      </div>
    </div>
  );
}
