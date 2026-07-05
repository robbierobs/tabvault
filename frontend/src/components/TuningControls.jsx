import React, { useState, useRef, useEffect } from 'react';
import styles from './TuningControls.module.css';
import { presetsFor, sameTuning, tuningLetters, semitoneShift } from '../lib/tuning.js';

export default function TuningControls({
  originalTunings, // the visible track's tuning as stored in the file
  originalLabel,   // friendly name for it
  currentLabel,    // effective tuning after any transform (shown on the button)
  target,          // active preset or null
  mode,            // 'refinger' | 'shift'
  outOfRange,      // clamped note count from the last re-finger
  onApply,         // (preset|null, mode) => void
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!originalTunings || originalTunings.length === 0) return null;

  const presets = presetsFor(originalTunings);
  const active = !!target;
  const semis = target ? semitoneShift(originalTunings, target.tunings) : 0;
  const semisLabel = `${semis > 0 ? '+' : ''}${semis} semitone${Math.abs(semis) === 1 ? '' : 's'}`;

  const handleSelect = (e) => {
    const name = e.target.value;
    const preset = presets.find(p => p.name === name);
    // Picking the file's own tuning is the same as resetting
    if (!preset || sameTuning(preset.tunings, originalTunings)) {
      onApply(null, mode);
    } else {
      onApply(preset, mode);
    }
  };

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        className={`${styles.btn} ${active ? styles.btnActive : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Change tuning"
      >
        <TuningForkIcon />
        <span>{currentLabel || 'Tuning'}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className={styles.panel}>
          <div className={styles.row}>
            <span className={styles.rowLabel}>Play in</span>
            <select
              className={styles.select}
              value={target ? target.name : '__original'}
              onChange={handleSelect}
            >
              <option value="__original">Original — {originalLabel}</option>
              {presets.map(p => (
                <option key={p.name} value={p.name}>
                  {p.name}{sameTuning(p.tunings, originalTunings) ? ' (original)' : ''}
                </option>
              ))}
            </select>
          </div>

          {active && (
            <div className={styles.modes}>
              <label className={styles.mode}>
                <input
                  type="radio"
                  name="tuning-mode"
                  checked={mode === 'refinger'}
                  onChange={() => onApply(target, 'refinger')}
                />
                <span className={styles.modeText}>
                  <strong>Re-finger tabs</strong>
                  <span>Sounds like the original — fret numbers rewritten for {target.name}</span>
                </span>
              </label>
              <label className={styles.mode}>
                <input
                  type="radio"
                  name="tuning-mode"
                  checked={mode === 'shift'}
                  onChange={() => onApply(target, 'shift')}
                />
                <span className={styles.modeText}>
                  <strong>Shift pitch</strong>
                  <span>Tab stays as written — all audio moves {semisLabel}</span>
                </span>
              </label>
            </div>
          )}

          {active && mode === 'refinger' && outOfRange > 0 && (
            <div className={styles.warn}>
              {outOfRange} note{outOfRange === 1 ? '' : 's'} can't be played in this
              tuning and got clamped — try Shift pitch instead
            </div>
          )}

          {active && (
            <button className={styles.reset} onClick={() => onApply(null, mode)}>
              Reset to original ({originalLabel})
            </button>
          )}

          <div className={styles.hint}>
            {tuningLetters(originalTunings)} (file) — changes are playback-only, the file is never modified
          </div>
        </div>
      )}
    </div>
  );
}

function TuningForkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M8 2v8a4 4 0 0 0 8 0V2" />
      <path d="M12 14v8" />
      <path d="M9 22h6" />
    </svg>
  );
}
