import React from 'react';
import styles from './TrackMixer.module.css';

export default function TrackMixer({ tracks, masterVolume, onMasterVolume, onTrackVolume, onTrackMute, onTrackSolo, visibleTrack, onSelectTrack, boostSelected, onToggleBoost }) {
  return (
    <div className={styles.mixer}>
      <div className={styles.header}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
          <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
          <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
          <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>
          <line x1="17" y1="16" x2="23" y2="16"/>
        </svg>
        <span>Mixer</span>
        {onToggleBoost && (
          <button
            className={`${styles.boostBtn} ${boostSelected ? styles.boostActive : ''}`}
            onClick={onToggleBoost}
            title={boostSelected
              ? 'Selected track boosted +10% — click to disable'
              : 'Boost the selected track +10% so it sits in front of the mix'}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 19V5M5 12l7-7 7 7"/>
            </svg>
            <span>Boost</span>
          </button>
        )}
      </div>

      {/* Master */}
      <div className={styles.masterRow}>
        <span className={styles.masterLabel}>Master</span>
        <input
          type="range"
          className={styles.masterSlider}
          min="0"
          max="100"
          value={masterVolume}
          onChange={e => onMasterVolume(Number(e.target.value))}
        />
        <span className={styles.masterVal}>{masterVolume}</span>
      </div>

      <div className={styles.divider} />

      {/* Tracks */}
      <div className={styles.tracks}>
        {tracks.map(track => {
          // drums are excluded from tab view (matches the header dropdown)
          const selectable = !track.isDrum && !!onSelectTrack;
          return (
          <div
            key={track.id}
            className={[
              styles.track,
              track.muted ? styles.muted : '',
              track.solo ? styles.soloed : '',
              selectable ? styles.selectable : '',
              visibleTrack === track.id ? styles.visible : '',
            ].join(' ')}
            onClick={selectable ? () => onSelectTrack(track.id) : undefined}
            title={selectable ? `Show ${track.name} tab` : undefined}
          >
            <div className={styles.trackTop}>
              <div className={styles.dot} style={{ background: track.color }} />
              <span className={styles.trackName}>{track.name}</span>
            </div>
            <div className={styles.trackControls}>
              <input
                type="range"
                className={styles.volSlider}
                min="0"
                max="100"
                value={track.volume}
                onChange={e => onTrackVolume(track.id, Number(e.target.value))}
                onClick={e => e.stopPropagation()}
                style={{ '--accent-color': track.color }}
              />
              <div className={styles.buttons}>
                <button
                  className={`${styles.trackBtn} ${styles.muteBtn} ${track.muted ? styles.btnActive : ''}`}
                  onClick={e => { e.stopPropagation(); onTrackMute(track.id); }}
                  title="Mute"
                >M</button>
                <button
                  className={`${styles.trackBtn} ${styles.soloBtn} ${track.solo ? styles.btnActive : ''}`}
                  onClick={e => { e.stopPropagation(); onTrackSolo(track.id); }}
                  title="Solo"
                >S</button>
              </div>
            </div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
