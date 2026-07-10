import React, { useEffect, useRef, useState } from 'react';
import styles from './EditToolbar.module.css';
import { DURATIONS } from '../lib/editScore.js';

const DURATION_LABELS = { 1: '1', 2: '1/2', 4: '1/4', 8: '1/8', 16: '1/16', 32: '1/32', 64: '1/64' };

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

export default function EditToolbar({ ed, editor, saving, saveError, onSaveVersion, onDiscard, onExit }) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [label, setLabel] = useState('edited');
  const saveWrapRef = useRef(null);

  useEffect(() => {
    if (!saveOpen) return;
    const onDown = (e) => {
      if (saveWrapRef.current && !saveWrapRef.current.contains(e.target)) setSaveOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [saveOpen]);

  const hasSel = !!ed.selection;
  const info = ed.beatInfo;
  const status = draftStatusText(ed);

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
