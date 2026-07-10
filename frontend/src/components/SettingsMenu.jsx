import React, { useState, useRef, useEffect } from 'react';
import styles from './SettingsMenu.module.css';
import { AV_SYNC_MIN, AV_SYNC_MAX, detectOutputLatency } from '../lib/avSync.js';
import { TUNING_DEFAULTS } from '../lib/audioTuning.js';
import { SOUND_BANKS } from './Player.jsx';

// Practice settings live behind one gear button: they're set-and-forget
// toggles, not things flipped mid-song, so they don't earn header space.
export default function SettingsMenu({
  soundBank, soundLoading, onSoundBank,
  tuning, onTuning,
  metronome, onMetronome,
  countIn, onCountIn,
  avSync, onAvSync,
}) {
  const [open, setOpen] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detected, setDetected] = useState(null);
  const [mixOpen, setMixOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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
      if (ms !== null) onAvSync(ms);
    } finally {
      setDetecting(false);
    }
  };

  // the gear lights up when any setting is away from its default
  const active = soundBank !== 'standard' || metronome || countIn || avSync !== 0;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        className={`${styles.btn} ${active ? styles.btnActive : ''} ${open ? styles.btnOpen : ''}`}
        onClick={() => setOpen(o => !o)}
        title="Sound & practice settings"
      >
        <GearIcon />
        <span>Sound</span>
      </button>

      {open && (
        <div className={styles.panel}>
          <div className={styles.title}>Sound &amp; practice</div>

          <div className={styles.subTitle}>Sound bank{soundLoading ? ' — loading…' : ''}</div>
          <div className={styles.bankList} role="radiogroup">
            {Object.entries(SOUND_BANKS).map(([id, bank]) => (
              <button
                key={id}
                className={`${styles.bankRow} ${soundBank === id ? styles.bankActive : ''}`}
                disabled={soundLoading}
                onClick={() => onSoundBank(id)}
                role="radio"
                aria-checked={soundBank === id}
              >
                <span className={styles.bankRadio} />
                <span className={styles.toggleText}>
                  <span className={styles.toggleLabel}>{bank.label}</span>
                  <span className={styles.toggleHint}>{bank.detail}</span>
                </span>
              </button>
            ))}
          </div>

          <div className={styles.divider} />

          <ToggleRow
            label="Metronome click"
            hint="Click track during playback"
            checked={metronome}
            onChange={onMetronome}
          />
          <ToggleRow
            label="Count-in"
            hint="One bar of clicks before playback starts"
            checked={countIn}
            onChange={onCountIn}
          />

          <div className={styles.divider} />

          <button className={styles.disclosure} onClick={() => setMixOpen(o => !o)}>
            <span className={styles.subTitle}>Mixing &amp; compression</span>
            <span className={styles.disclosureArrow}>{mixOpen ? '▾' : '▸'}</span>
          </button>
          {mixOpen && (
            <>
              <MixSlider label="Master" min={50} max={120} value={tuning.master}
                onChange={v => onTuning({ master: v })} />
              <MixSlider label="Guitars" min={25} max={200} value={tuning.guitars}
                onChange={v => onTuning({ guitars: v })} />
              <MixSlider label="Bass" min={25} max={200} value={tuning.bass}
                onChange={v => onTuning({ bass: v })} />
              <MixSlider label="Drums" min={25} max={200} value={tuning.drums}
                onChange={v => onTuning({ drums: v })} />
              <MixSlider label="Other" min={25} max={200} value={tuning.other}
                onChange={v => onTuning({ other: v })} />
              <MixSlider label="Boost amt" min={100} max={200} value={tuning.boost}
                onChange={v => onTuning({ boost: v })} />

              <ToggleRow
                label="Compressor"
                hint="Evens out loud/quiet peaks on the master output"
                checked={tuning.compressor.enabled}
                onChange={() => onTuning({ compressor: { enabled: !tuning.compressor.enabled } })}
              />
              {tuning.compressor.enabled && (
                <>
                  <div className={styles.mixRow}>
                    <span className={styles.mixLabel}>Threshold</span>
                    <input type="range" className={styles.slider} min={-40} max={0} step={1}
                      value={tuning.compressor.threshold}
                      onChange={e => onTuning({ compressor: { threshold: Number(e.target.value) } })} />
                    <span className={styles.mixValue}>{tuning.compressor.threshold} dB</span>
                  </div>
                  <div className={styles.mixRow}>
                    <span className={styles.mixLabel}>Ratio</span>
                    <input type="range" className={styles.slider} min={1} max={12} step={0.5}
                      value={tuning.compressor.ratio}
                      onChange={e => onTuning({ compressor: { ratio: Number(e.target.value) } })} />
                    <span className={styles.mixValue}>{tuning.compressor.ratio}:1</span>
                  </div>
                </>
              )}

              <div className={styles.buttons}>
                <button
                  className={styles.smallBtn}
                  onClick={async () => {
                    const json = JSON.stringify(tuning, null, 2);
                    try { await navigator.clipboard.writeText(json); } catch (e) {
                      try { prompt('Copy your mixing settings:', JSON.stringify(tuning)); } catch (e2) {}
                    }
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? 'Copied!' : 'Copy settings'}
                </button>
                <button
                  className={styles.smallBtn}
                  onClick={() => onTuning({ ...TUNING_DEFAULTS, compressor: { ...TUNING_DEFAULTS.compressor } })}
                >
                  Reset defaults
                </button>
              </div>
              <div className={styles.hint}>
                Tweak while a song plays — changes apply live. Copy the settings
                to share the mix you've dialed in.
              </div>
            </>
          )}

          <div className={styles.divider} />

          <div className={styles.subTitle}>Audio / visual sync</div>
          <div className={styles.sliderRow}>
            <input
              type="range"
              className={styles.slider}
              min={AV_SYNC_MIN}
              max={AV_SYNC_MAX}
              step={5}
              value={avSync}
              onChange={e => onAvSync(parseInt(e.target.value, 10))}
            />
            <span className={styles.value}>{avSync > 0 ? '+' : ''}{avSync} ms</span>
          </div>
          <div className={styles.scaleLabels}>
            <span>cursor sooner</span>
            <span>cursor later</span>
          </div>
          <div className={styles.buttons}>
            <button className={styles.smallBtn} onClick={handleAuto} disabled={detecting}>
              {detecting ? 'Measuring…' : 'Auto-detect'}
            </button>
            <button className={styles.smallBtn} onClick={() => onAvSync(0)} disabled={avSync === 0}>
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
            the slider right until they line up.
          </div>
        </div>
      )}
    </div>
  );
}

// Sliders edit linear gain factors but display percentages (100% = ×1)
function MixSlider({ label, min, max, value, onChange }) {
  const pct = Math.round(value * 100);
  return (
    <div className={styles.mixRow}>
      <span className={styles.mixLabel}>{label}</span>
      <input
        type="range"
        className={styles.slider}
        min={min}
        max={max}
        step={1}
        value={pct}
        onChange={e => onChange(Number(e.target.value) / 100)}
      />
      <span className={styles.mixValue}>{pct}%</span>
    </div>
  );
}

function ToggleRow({ label, hint, checked, disabled, onChange }) {
  return (
    <button
      className={styles.toggleRow}
      disabled={disabled}
      onClick={onChange}
      role="switch"
      aria-checked={checked}
    >
      <span className={styles.toggleText}>
        <span className={styles.toggleLabel}>{label}</span>
        <span className={styles.toggleHint}>{hint}</span>
      </span>
      <span className={`${styles.switch} ${checked ? styles.switchOn : ''}`}>
        <span className={styles.knob} />
      </span>
    </button>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
