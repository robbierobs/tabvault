import React, { useState, useRef, useEffect } from 'react';
import styles from './AvSyncControls.module.css';
import { AV_SYNC_MIN, AV_SYNC_MAX, detectOutputLatency } from '../lib/avSync.js';

export default function AvSyncControls({ offset, onChange }) {
  const [open, setOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const handleAuto = async () => {
    setDetecting(true);
    try {
      const ms = await detectOutputLatency();
      setDetected(ms);
      if (ms !== null) onChange(ms);
    } finally {
      setDetecting(false);
    }
  };

  const active = offset !== 0;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        className={`${styles.btn} ${active ? styles.btnActive : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Audio/visual sync — align the cursor with what you hear"
      >
        <SyncIcon />
        <span>{active ? `Sync ${offset > 0 ? '+' : ''}${offset}ms` : 'Sync'}</span>
      </button>

      {open && (
        <div className={styles.panel}>
          <div className={styles.title}>Audio / visual sync</div>
          <div className={styles.sliderRow}>
            <input
              type="range"
              className={styles.slider}
              min={AV_SYNC_MIN}
              max={AV_SYNC_MAX}
              step={5}
              value={offset}
              onChange={e => onChange(parseInt(e.target.value, 10))}
            />
            <span className={styles.value}>{offset > 0 ? '+' : ''}{offset} ms</span>
          </div>
          <div className={styles.scaleLabels}>
            <span>cursor sooner</span>
            <span>cursor later</span>
          </div>
          <div className={styles.buttons}>
            <button className={styles.smallBtn} onClick={handleAuto} disabled={detecting}>
              {detecting ? 'Measuring…' : 'Auto-detect'}
            </button>
            <button className={styles.smallBtn} onClick={() => onChange(0)} disabled={offset === 0}>
              Reset
            </button>
          </div>
          {detected !== null && (
            <div className={styles.detected}>
              Reported output latency: ~{detected} ms
            </div>
          )}
          <div className={styles.hint}>
            If the sound arrives after the cursor (common with Bluetooth), move
            the slider right until they line up. Move it left if the cursor
            feels behind the music.
          </div>
        </div>
      )}
    </div>
  );
}

function SyncIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
