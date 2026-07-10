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

const MENU_WIDTH = 280; // keep in sync with .menuPanel width

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

  // Bar ▾ / Track ▾ menus. Their triggers live inside the horizontal scroll
  // area, whose overflow would clip an absolutely-positioned panel — so the
  // panels are position:fixed at coordinates captured when the menu opens.
  const [menu, setMenu] = useState(null); // 'bar' | 'track' | null
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const barWrapRef = useRef(null);
  const trackWrapRef = useRef(null);

  const [tsNum, setTsNum] = useState('4');
  const [tsDen, setTsDen] = useState('4');
  const [renameDraft, setRenameDraft] = useState('');
  const [newName, setNewName] = useState('');
  const [newProgram, setNewProgram] = useState('25');
  const [newStrings, setNewStrings] = useState('6');

  useEffect(() => {
    if (!saveOpen && !menu) return;
    const onDown = (e) => {
      if (saveOpen && saveWrapRef.current && !saveWrapRef.current.contains(e.target)) setSaveOpen(false);
      if (menu === 'bar' && barWrapRef.current && !barWrapRef.current.contains(e.target)) setMenu(null);
      if (menu === 'track' && trackWrapRef.current && !trackWrapRef.current.contains(e.target)) setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [saveOpen, menu]);

  const hasSel = !!ed.selection;
  const info = ed.beatInfo;
  const bar = ed.barInfo;
  const track = ed.trackInfo;
  const status = draftStatusText(ed);

  const toggleMenu = (which) => (e) => {
    if (menu === which) { setMenu(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setMenuPos({
      top: Math.round(r.bottom + 8),
      left: Math.round(Math.min(r.left, window.innerWidth - MENU_WIDTH - 12)),
    });
    if (which === 'bar' && bar) {
      setTsNum(String(bar.numerator));
      setTsDen(String(bar.denominator));
    }
    if (which === 'track') {
      setRenameDraft(track?.name ?? '');
      setNewName('');
    }
    setMenu(which);
  };

  const applyTs = () => {
    const n = Math.max(1, Math.min(32, parseInt(tsNum, 10) || 4));
    setMenu(null);
    editor.setTimeSignature(n, parseInt(tsDen, 10));
  };

  const addTrack = () => {
    setMenu(null);
    editor.addNewTrack({
      name: newName.trim() || undefined,
      program: parseInt(newProgram, 10),
      strings: parseInt(newStrings, 10),
    });
  };

  const renameTrack = () => {
    setMenu(null);
    editor.renameTrack(renameDraft);
  };

  const menuStyle = { top: menuPos.top, left: menuPos.left };

  return (
    <div className={styles.toolbar}>
      <div className={styles.scroll}>
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
          <span className={styles.menuWrap} ref={barWrapRef}>
            <button
              className={`${styles.btn} ${menu === 'bar' ? styles.active : ''}`}
              disabled={!hasSel}
              onClick={toggleMenu('bar')}
              title={hasSel ? 'Bar operations — insert, delete, time signature, repeats' : 'Select a beat first'}
            >
              Bar ▾
            </button>
            {menu === 'bar' && (
              <div className={styles.menuPanel} style={menuStyle}>
                <div className={styles.menuTitle}>
                  Bar {bar ? bar.index + 1 : ''}{bar ? ` of ${bar.count}` : ''}
                </div>
                <div className={styles.menuRow}>
                  <button className={styles.menuBtn} onClick={() => { setMenu(null); editor.insertBar('before'); }} title="Insert an empty bar before this one">
                    + Before
                  </button>
                  <button className={styles.menuBtn} onClick={() => { setMenu(null); editor.insertBar('after'); }} title="Insert an empty bar after this one">
                    + After
                  </button>
                  <button
                    className={`${styles.menuBtn} ${styles.danger}`}
                    disabled={!bar || bar.count <= 1}
                    onClick={() => { setMenu(null); editor.deleteSelectedBar(); }}
                    title="Delete this bar from every track"
                  >
                    Delete
                  </button>
                </div>
                <div className={styles.menuSubTitle}>Time signature</div>
                <div className={styles.menuRow}>
                  <input
                    className={styles.menuInput}
                    type="number" min="1" max="32"
                    value={tsNum}
                    onChange={e => setTsNum(e.target.value)}
                  />
                  <span>/</span>
                  <select className={styles.menuInput} value={tsDen} onChange={e => setTsDen(e.target.value)}>
                    {[1, 2, 4, 8, 16, 32].map(d => <option key={d} value={d}>{d}</option>)}
                  </select>
                  <button className={styles.saveBtn} onClick={applyTs}>Apply</button>
                </div>
                <div className={styles.menuHint}>
                  Applies to this bar and the following bars that share its current
                  signature. Bars are re-padded with rests to fit.
                </div>
                <div className={styles.menuSubTitle}>Repeats</div>
                <div className={styles.menuRow}>
                  <button
                    className={`${styles.menuBtn} ${bar?.repeatStart ? styles.active : ''}`}
                    onClick={() => editor.toggleRepeat('start')}
                    title="Repeat start ‖:"
                  >
                    ‖: Start
                  </button>
                  <button
                    className={`${styles.menuBtn} ${bar?.repeatEnd ? styles.active : ''}`}
                    onClick={() => editor.toggleRepeat('end')}
                    title="Repeat end :‖ (×2)"
                  >
                    :‖ End
                  </button>
                </div>
              </div>
            )}
          </span>

          <span className={styles.menuWrap} ref={trackWrapRef}>
            <button
              className={`${styles.btn} ${menu === 'track' ? styles.active : ''}`}
              onClick={toggleMenu('track')}
              title="Track operations — instrument, rename, add, delete"
            >
              Track ▾
            </button>
            {menu === 'track' && (
              <div className={styles.menuPanel} style={menuStyle}>
                <div className={styles.menuTitle}>{track ? track.name : 'Track'}</div>
                <div className={styles.menuRow}>
                  <select
                    className={styles.menuInput}
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
                </div>
                <div className={styles.menuRow}>
                  <input
                    className={styles.menuInput}
                    disabled={!track}
                    value={renameDraft}
                    onChange={e => setRenameDraft(e.target.value)}
                    placeholder="Track name"
                    onKeyDown={e => { if (e.key === 'Enter') renameTrack(); }}
                  />
                  <button className={styles.menuBtn} disabled={!track} onClick={renameTrack}>
                    Rename
                  </button>
                </div>
                <div className={styles.menuDivider} />
                <div className={styles.menuSubTitle}>Add track</div>
                <div className={styles.menuRow}>
                  <input
                    className={styles.menuInput}
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    placeholder="Name (optional)"
                    onKeyDown={e => { if (e.key === 'Enter') addTrack(); }}
                  />
                </div>
                <div className={styles.menuRow}>
                  <select className={styles.menuInput} value={newProgram} onChange={e => setNewProgram(e.target.value)}>
                    {INSTRUMENTS.map(([p, label]) => <option key={p} value={p}>{label}</option>)}
                  </select>
                  <select className={styles.menuInput} value={newStrings} onChange={e => setNewStrings(e.target.value)} title="Strings">
                    {[4, 5, 6, 7].map(s => <option key={s} value={s}>{s} str</option>)}
                  </select>
                  <button className={styles.saveBtn} onClick={addTrack}>Add</button>
                </div>
                <div className={styles.menuDivider} />
                <div className={styles.menuRow}>
                  <button
                    className={`${styles.menuBtn} ${styles.danger}`}
                    disabled={!track || track.count <= 1}
                    onClick={() => { setMenu(null); onRemoveTrack(); }}
                    title="Delete the current track (cannot be undone)"
                  >
                    Delete track…
                  </button>
                </div>
              </div>
            )}
          </span>
        </div>

        <span className={styles.hint}>
          {hasSel
            ? (ed.digitPending != null ? `Fret: ${ed.digitPending}…` : 'Type frets · arrows move · Enter inserts a beat')
            : 'Click a string in the tab to start editing'}
        </span>
      </div>

      {/* pinned outside the scroll area so undo/save/exit never leave the screen */}
      <div className={styles.right}>
        <button className={styles.btn} disabled={!ed.canUndo} onClick={() => editor.undo()} title="Undo (Cmd/Ctrl+Z)">↶</button>
        <button className={styles.btn} disabled={!ed.canRedo} onClick={() => editor.redo()} title="Redo (Cmd/Ctrl+Shift+Z)">↷</button>
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
              <div className={styles.menuTitle}>Save edits as a new version</div>
              <div className={styles.menuRow}>
                <input
                  className={styles.menuInput}
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
              <div className={styles.menuHint}>
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
