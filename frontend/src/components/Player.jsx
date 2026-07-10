import React, { useEffect, useRef, useState, useCallback } from 'react';
import styles from './Player.module.css';
import TrackMixer from './TrackMixer.jsx';
import PlaybackControls from './PlaybackControls.jsx';
import LoopBar from './LoopBar.jsx';
import TuningControls from './TuningControls.jsx';
import SettingsMenu from './SettingsMenu.jsx';
import EditToolbar from './EditToolbar.jsx';
import EditCaret from './EditCaret.jsx';
import { useEditor } from '../lib/useEditor.js';
import { tuningLabel, refingerScore, shiftScorePitch, semitoneShift } from '../lib/tuning.js';
import { scaleScoreTempo, exportScoreGp } from '../lib/editing.js';
import { createSyncedCursorHandler, loadAvSync, saveAvSync } from '../lib/avSync.js';
import { loadSongState, saveSongState } from '../lib/songState.js';

const TRACK_COLORS = [
  '#e8673a', '#4a9eff', '#3acd7e', '#e8c13a',
  '#c97aff', '#ff7aaa', '#7acfff', '#ffaa4a',
];

// Sound banks: opt-in alternative soundfonts, downloaded once and cached by
// the backend (except the small built-in default). SF2 and SF3 both work —
// alphaTab bundles a vorbis decoder for SF3's compressed samples.
export const SOUND_BANKS = {
  standard: {
    label: 'Standard',
    detail: 'Built-in (1 MB) — instant',
    url: 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@latest/dist/soundfont/sonivox.sf2',
  },
  hq: {
    label: 'HQ · GeneralUser GS',
    detail: '32 MB, downloaded once',
    url: '/api/soundfont/hq',
  },
  musescore: {
    label: 'MuseScore General',
    detail: '38 MB, downloaded once',
    url: '/api/soundfont/musescore',
  },
  // alphaSynth NaNs on Arachno's stereo-linked PCM samples (bug through
  // 1.9.0-alpha.1860) — the backend monoizes those headers at download time,
  // which is why this bank must come from /api and never a direct URL.
  arachno: {
    label: 'Arachno',
    detail: '148 MB, downloaded once',
    url: '/api/soundfont/arachno',
  },
};
const SOUND_BANK_KEY = 'tabvault-sound-bank';
const LEGACY_HQ_KEY = 'tabvault-hq-sound'; // pre-bank boolean toggle

function loadSoundBank() {
  try {
    const v = localStorage.getItem(SOUND_BANK_KEY);
    if (v && SOUND_BANKS[v]) return v;
    if (localStorage.getItem(LEGACY_HQ_KEY) === '1') return 'hq'; // migrate
  } catch (e) {}
  return 'standard';
}

// Per-bank level calibration, measured as live per-track RMS through the app
// (solo each track, compare against the standard font — see project notes,
// 2026-07-10). `master` aligns the bank's overall mix with sonivox; `program`
// returns a linear per-channel factor for presets that stray from parity.
const BANK_GAINS = {
  standard: { master: 1, program: () => 1 },
  // GeneralUser GS: distortion mastered way down, pick bass 6dB under; the
  // old blanket 24-31 boost made overdrive/clean guitars ~5-7dB too loud.
  hq: {
    master: 1.7,
    program: (p) => (p === 30 ? 3.0 : p === 34 ? 2.0 : 1),
  },
  // MuseScore General: guitars ~10dB under sonivox, finger bass 4dB under,
  // drum kit ~7dB hot (its snare/kick peak near clipping)
  musescore: {
    master: 1,
    program: (p, drum) => (drum ? 0.45 : p === 29 ? 3.5 : p === 30 ? 3.2 : p === 33 ? 1.6 : 1),
  },
  // Arachno: mastered hot across the board — overdrive +17dB over sonivox
  // (hard-clipping peaks), distortion +9dB, pick bass +5dB
  arachno: {
    master: 0.85,
    program: (p) => (p === 29 ? 0.17 : p === 30 ? 0.42 : p === 33 ? 1.15 : p === 34 ? 0.66 : 1),
  },
};

// Both soundfonts mix bass ~4-13dB and drums ~5-9dB above the rhythm guitars
// (measured per-track RMS), which buries the part being practiced. Trim those
// families at the synth channel in every font; the mixer UI stays 0-100.
function familyTrim(track) {
  if (track.staves?.some(s => s.isPercussion) || track.playbackInfo?.primaryChannel === 9) return 0.7; // drums ≈ −3dB
  const p = track.playbackInfo?.program ?? -1;
  if (p >= 32 && p <= 39) return 0.65; // basses ≈ −3.7dB
  return 1;
}

// "Boost selected": the track whose tab is on screen gets +3.5dB so it sits
// audibly in front of the backing tracks while practicing (the old ×1.1 was
// +0.8dB — below the level-difference threshold most ears can detect)
const BOOST_KEY = 'tabvault-boost-selected';
const BOOST_GAIN = 1.5;

// GP files often carry garbage bytes in track names
function sanitizeTrackName(name, i) {
  if (!name) return `Track ${i + 1}`;
  // strip the replacement character and non-printable ranges
  const cleaned = name.replace(new RegExp('[\\uFFFD\\u0000-\\u001F\\u0080-\\u009F]', 'g'), '').trim();
  if (!cleaned || /^[\d\s\W]+$/.test(cleaned)) return `Track ${i + 1}`;
  return cleaned;
}

const headerSelectStyle = {
  background: 'var(--bg4)',
  border: '1px solid var(--border2)',
  borderRadius: '6px',
  color: 'var(--text)',
  fontSize: '12px',
  padding: '4px 8px',
  fontFamily: 'var(--font-body)',
  cursor: 'pointer',
  maxWidth: '160px',
};

export default function Player({ file, version = 0, onVersionChange, onMetaLoaded, onToggleSidebar, onEditingChange }) {
  const containerRef = useRef(null);
  const apiRef = useRef(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTick, setCurrentTick] = useState(0);
  const [totalTicks, setTotalTicks] = useState(0);
  const [currentBar, setCurrentBar] = useState(0);
  const [totalBars, setTotalBars] = useState(0);
  const [speed, setSpeed] = useState(100);
  const [rampEnabled, setRampEnabled] = useState(false);
  const [rampTarget, setRampTarget] = useState(100);
  const [rampStep, setRampStep] = useState(5);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(100);
  const [tracks, setTracks] = useState([]);
  const [visibleTrack, setVisibleTrack] = useState(0);
  const [masterVolume, setMasterVolume] = useState(100);
  const [countIn, setCountIn] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loopCount, setLoopCount] = useState(0);
  const lastTickRef = useRef(0);
  const loopEnabledRef = useRef(false);
  const loopRangeTicksRef = useRef(null); // {startTick, endTick} of the active loop region
  const readyRef = useRef(false);
  const pendingLoopRangeRef = useRef(null); // loop bars waiting for playerReady
  const [error, setError] = useState(null);
  const [scoreTitle, setScoreTitle] = useState('');
  const [scoreArtist, setScoreArtist] = useState('');
  const [timeSignature, setTimeSignature] = useState('');
  const [tempo, setTempo] = useState(null);

  // Tuning feature: raw file bytes are kept so transforms can re-parse a
  // pristine score instead of mutating the loaded one back and forth.
  const atRef = useRef(null);            // alphaTab module
  const bytesRef = useRef(null);         // original file bytes
  const origTuningsRef = useRef({});     // track index -> tuning array from the file
  const reapplyMixerRef = useRef(false); // true while re-rendering for a tuning change
  const tracksRef = useRef([]);
  const [trackTunings, setTrackTunings] = useState({}); // current (possibly transformed)
  const [tuningTarget, setTuningTarget] = useState(null);
  const [tuningMode, setTuningMode] = useState('refinger');
  const [tuningOutOfRange, setTuningOutOfRange] = useState(0);
  const [soundBank, setSoundBank] = useState(loadSoundBank);
  const [soundLoading, setSoundLoading] = useState(false);
  const [mixerOpen, setMixerOpen] = useState(false); // mobile bottom-sheet mixer

  // Edit versions (Phase 0: tempo). Original file is never modified —
  // edits export a new .gp saved server-side; the dropdown switches them.
  const [versions, setVersions] = useState([]);
  const [tempoOpen, setTempoOpen] = useState(false);
  const [tempoDraft, setTempoDraft] = useState('');
  const [savingVersion, setSavingVersion] = useState(false);
  const [versionError, setVersionError] = useState(null);
  const tempoWrapRef = useRef(null);

  // Edit mode (Phase 1: note entry). The controller owns selection, undo and
  // draft-autosave state and mutates the live score; React only mirrors its
  // snapshot (ed) for the toolbar and caret.
  const [editMode, setEditMode] = useState(false);
  const [draftMeta, setDraftMeta] = useState(null); // server-side draft slot

  // Edit mode swaps the practice chrome (library, mixer, loop bar, sound
  // settings) for the editing chrome — App hides the sidebar off this signal.
  // The cleanup covers the save-as-version remount, which unmounts mid-edit.
  useEffect(() => {
    onEditingChange?.(editMode);
    return () => onEditingChange?.(false);
  }, [editMode]);
  const [savingEditVersion, setSavingEditVersion] = useState(false);
  const [editSaveError, setEditSaveError] = useState(null);
  const { editor, ed } = useEditor({
    getApi: () => apiRef.current,
    getAt: () => atRef.current,
    getContainer: () => containerRef.current,
    getPristineBytes: () => bytesRef.current,
    beforeRender: () => { reapplyMixerRef.current = true; },
    fileName: file.name,
    getVersion: () => version,
    getVisibleTrack: () => visibleTrackRef.current,
    onTracksChanged: (event) => refreshTracksRef.current?.(event),
  });

  useEffect(() => {
    let alive = true;
    fetch(`/api/versions/${encodeURIComponent(file.name)}`)
      .then(r => r.ok ? r.json() : { versions: [] })
      .then(d => { if (alive) setVersions(d.versions || []); })
      .catch(() => {});
    fetch(`/api/draft/${encodeURIComponent(file.name)}/meta`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (alive) setDraftMeta(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, [file.name]);

  useEffect(() => {
    if (!tempoOpen) return;
    const onDown = (e) => {
      if (tempoWrapRef.current && !tempoWrapRef.current.contains(e.target)) setTempoOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [tempoOpen]);
  const soundBankRef = useRef(soundBank);
  const [boostSelected, setBoostSelected] = useState(() => {
    try { return localStorage.getItem(BOOST_KEY) !== '0'; } catch (e) { return true; }
  });
  const boostRef = useRef(boostSelected);
  const visibleTrackRef = useRef(visibleTrack);

  // Single place that pushes a track's volume to the synth: mixer slider
  // (0-100) times the family trim times the bank's program compensation
  // times the selected-track boost
  const setTrackSynthVolume = (trackId, sliderVal) => {
    const tr = apiRef.current?.score?.tracks?.[trackId];
    if (!tr) return;
    const bank = BANK_GAINS[soundBankRef.current] ?? BANK_GAINS.standard;
    const isDrum = tr.staves?.some(s => s.isPercussion) || tr.playbackInfo?.primaryChannel === 9;
    const gain = bank.program(tr.playbackInfo?.program ?? -1, isDrum) * familyTrim(tr);
    apiRef.current.changeTrackVolume([tr], (sliderVal / 100) * gain *
      (boostRef.current && trackId === visibleTrackRef.current ? BOOST_GAIN : 1));
  };
  const setTrackSynthVolumeRef = useRef(null);
  setTrackSynthVolumeRef.current = setTrackSynthVolume;

  const applyMasterVolume = (sliderVal) => {
    if (!apiRef.current) return;
    const bank = BANK_GAINS[soundBankRef.current] ?? BANK_GAINS.standard;
    apiRef.current.masterVolume = (sliderVal / 100) * bank.master;
  };
  const masterVolumeRef = useRef(masterVolume);
  useEffect(() => { masterVolumeRef.current = masterVolume; }, [masterVolume]);
  const applyMasterVolumeRef = useRef(null);
  applyMasterVolumeRef.current = applyMasterVolume;

  // covers switch and the failed-load revert; volumes are independent of the
  // loaded font so this can run immediately
  useEffect(() => {
    soundBankRef.current = soundBank;
    for (const t of tracksRef.current) setTrackSynthVolume(t.id, t.volume);
    applyMasterVolume(masterVolumeRef.current);
  }, [soundBank]);

  // the boost follows the visible track — re-push volumes when either the
  // selection or the toggle changes
  useEffect(() => {
    boostRef.current = boostSelected;
    visibleTrackRef.current = visibleTrack;
    try { localStorage.setItem(BOOST_KEY, boostSelected ? '1' : '0'); } catch (e) {}
    for (const t of tracksRef.current) setTrackSynthVolume(t.id, t.volume);
  }, [boostSelected, visibleTrack]);

  const soundfontSwapRef = useRef(null); // {wasPlaying, prevBank} while a user-initiated soundfont swap is in flight

  // A/V sync: positive = cursor/UI delayed (audio arrives late, e.g.
  // Bluetooth), negative = cursor runs ahead
  const [avSync, setAvSync] = useState(loadAvSync);
  const avSyncRef = useRef(avSync);
  const playingRef = useRef(false);
  const cursorHandlerRef = useRef(null);
  const uiTimersRef = useRef(new Set());
  useEffect(() => { avSyncRef.current = avSync; }, [avSync]);

  // route our own UI updates (progress bar, bar counter) through the same delay
  const scheduleUi = (fn) => {
    const off = avSyncRef.current;
    if (off <= 0 || !playingRef.current) { fn(); return; }
    const id = setTimeout(() => { uiTimersRef.current.delete(id); fn(); }, off);
    uiTimersRef.current.add(id);
  };
  const clearUiTimers = () => {
    for (const id of uiTimersRef.current) clearTimeout(id);
    uiTimersRef.current.clear();
  };

  useEffect(() => { tracksRef.current = tracks; }, [tracks]);

  // Guards against overlapping async inits (React 18 StrictMode double-mounts
  // the effect; without this two live AlphaTabApi instances render into the
  // same container and the stale one covers the real one)
  const initGenRef = useRef(0);

  const initAlphaTab = useCallback(async () => {
    if (!containerRef.current) return;
    const gen = ++initGenRef.current;
    setLoading(true);
    setError(null);

    try {
      // Handle all possible export shapes from alphaTab
      const mod = await import('@coderline/alphatab');
      const at = mod.alphaTab ?? mod.default ?? mod;
      atRef.current = at;

      const LayoutMode = at.LayoutMode ?? { Page: 0, Horizontal: 1 };
      const StaveProfile = at.StaveProfile ?? { Tab: 1 };
      const ScrollMode = at.ScrollMode ?? { Continuous: 2 };
      const AlphaTabApi = at.AlphaTabApi ?? mod.AlphaTabApi;

      if (!AlphaTabApi) {
        throw new Error('Could not load AlphaTabApi from module');
      }

      const settings = {
        core: {
          fontDirectory: 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@latest/dist/font/',
          logLevel: 1,
        scriptFile: '/assets/alphaTab.mjs',
          // per-note bounds power edit-mode hit-testing (click → string)
          includeNoteBounds: true,
        },
        display: {
          layoutMode: LayoutMode.Page,
          staveProfile: StaveProfile.Tab,
          scale: 0.9,
          resources: {
            staffLineColor: '#666680',
            barSeperatorColor: '#ffffff',
            mainGlyphColor: '#e0e0ee',
            secondaryGlyphColor: '#9090a8',
            scoreInfoColor: '#c0c0d0',
            playHeadColor: '#e8673a',
            selectionColor: 'rgba(232, 103, 58, 0.25)',
          }
        },
        player: {
          enablePlayer: true,
          enableCursor: true,
          enableAnimatedBeatCursor: true,
          scrollMode: ScrollMode.Continuous,
          soundFont: (SOUND_BANKS[soundBank] ?? SOUND_BANKS.standard).url,
          scrollElement: containerRef.current.parentElement,
        }
      };

      console.log('AlphaTabApi found:', !!AlphaTabApi);
      const api = new AlphaTabApi(containerRef.current, settings);
      if (gen !== initGenRef.current) {
        // Effect was cleaned up (or re-run) while we were initializing
        try { api.destroy(); } catch (e) {}
        return;
      }
      console.log('API created:', !!api);
      apiRef.current = api;
      if (import.meta.env.DEV) window.__tabvaultApi = api; // e2e/debug handle

      // A/V sync: time-shifted cursor placement
      const cursorHandler = createSyncedCursorHandler(
        () => avSyncRef.current,
        () => playingRef.current
      );
      cursorHandlerRef.current = cursorHandler;
      api.customCursorHandler = cursorHandler;

      // Watch beat cursor and make it visible
      const cursorObserver = new MutationObserver(() => {
        const beat = document.querySelector('.at-cursor-beat');
        if (beat) {
          const t = beat.style.transform;
          const match = t && t.match(/scale\(([\d.e-]+),\s*([\d.e-]+)\)/);
          if (match) {
            const scaleX = parseFloat(match[1]);
            const scaleY = parseFloat(match[2]);
            // Replace scaleX to make it visible (target 2px wide from 300px element = 0.00667)
            beat.style.transform = t.replace(
              /scale\([\d.e-]+,/,
              'scale(0.039,'
            );
            beat.style.background = '#e8673a';
            beat.style.opacity = '1';
            beat.style.boxShadow = '0 0 8px 3px #e8673a';
          }
        }
        const bar = document.querySelector('.at-cursor-bar');
        if (bar) {
          bar.style.background = 'rgba(74, 158, 255, 0.15)';
        }
      });

      setTimeout(() => {
        const cursors = document.querySelector('.at-cursors');
        if (cursors) {
          cursorObserver.observe(cursors, { attributes: true, subtree: true, attributeFilter: ['style'] });
        }
      }, 2000);

      api.playerReady.on(() => {
        console.log('Player ready!');
        readyRef.current = true;
        setReady(true);
        setLoading(false);
        const pending = pendingLoopRangeRef.current;
        if (pending) {
          pendingLoopRangeRef.current = null;
          applyLoopRangeRef.current?.(pending.start, pending.end);
        }
        // volume commands sent before the synth instance exists are silently
        // dropped — this is the first moment they reliably stick, so push the
        // mixer volumes (and the HQ guitar compensation) here
        const list = tracksRef.current.length
          ? tracksRef.current
          : (api.score?.tracks || []).map((_, i) => ({ id: i, volume: 100 }));
        for (const t of list) setTrackSynthVolumeRef.current(t.id, t.volume);
        applyMasterVolumeRef.current?.(masterVolumeRef.current);
      });

      // (lives on the synth, not the api facade)
      api.player?.soundFontLoadFailed?.on((err) => {
        console.error('Soundfont load failed', err);
        setSoundLoading(false);
        const failedSwap = soundfontSwapRef.current;
        soundfontSwapRef.current = null;
        // the synth still has the previous font — flip the selection back
        if (failedSwap) {
          setSoundBank(failedSwap.prevBank);
          try { localStorage.setItem(SOUND_BANK_KEY, failedSwap.prevBank); } catch (e2) {}
        }
      });

      api.soundFontLoaded.on(() => {
        setSoundLoading(false);
        // After a soundfont swap the synth channels still hold preset indexes
        // resolved against the OLD font's preset ordering (alphaSynth only
        // re-resolves them when program-change events are processed, which a
        // paused seek skips). Rewind the sequencer and restore the position so
        // the channel setup replays against the new presets.
        const swap = soundfontSwapRef.current;
        if (swap) {
          soundfontSwapRef.current = null;
          const pos = api.tickPosition;
          try {
            api.stop();
            if (pos > 0) api.tickPosition = pos;
            // wasPlaying was captured at toggle time — the synth pauses itself
            // while loading, so playingRef is already false by now
            if (swap.wasPlaying) api.play();
          } catch (e) {}
        }
        // loading a font resets synth channel state — re-push mixer volumes
        // so the HQ guitar compensation survives the swap (and applies on
        // initial load when the font arrives after the score)
        for (const t of tracksRef.current) setTrackSynthVolumeRef.current(t.id, t.volume);
      });

      api.playerStateChanged.on((e) => {
        const isPlaying = e.state === 1;
        playingRef.current = isPlaying;
        setPlaying(isPlaying);
        if (!isPlaying) {
          // drop queued time-shifted updates so stale positions don't land
          // after the final placement
          cursorHandler.clearPending();
          clearUiTimers();
        }
      });

      // Exact bar tracking (position events carry only ticks in alphaTab 1.8)
      api.playedBeatChanged.on((beat) => {
        const idx = beat?.voice?.bar?.index;
        if (idx !== undefined) scheduleUi(() => setCurrentBar(idx));
      });

      api.playerPositionChanged.on((e) => {
        scheduleUi(() => {
          setCurrentTick(e.currentTick);
          setTotalTicks(e.endTick);
        });
        // Loop-wrap detection for the speed ramp (not delayed — the ramp
        // should trigger at the actual restart). Only count backward jumps
        // that leave from near the loop end and land near the loop start,
        // so manual rewinds/seeks don't bump the tempo.
        if (e.currentTick < lastTickRef.current - 1000 && loopEnabledRef.current) {
          const range = loopRangeTicksRef.current;
          const startTick = range ? range.startTick : 0;
          const endTick = range ? range.endTick : e.endTick;
          const margin = Math.max(1000, (endTick - startTick) * 0.1);
          if (e.currentTick <= startTick + margin && lastTickRef.current >= endTick - margin) {
            setLoopCount(c => c + 1);
          }
        }
        lastTickRef.current = e.currentTick;
      });

      api.scoreLoaded.on((score) => {
        if (!score) return;
        const title = score.title || file.name.replace(/\.(gp\w*)$/i, '');
        const artist = score.artist || '';
        setScoreTitle(title);
        setScoreArtist(artist);
        if (onMetaLoaded) onMetaLoaded(file.name, title, artist);
        setTotalBars(score.masterBars?.length || 0);
        setLoopEnd(score.masterBars?.length || 100);

        if (score.masterBars?.[0]) {
          const mb = score.masterBars[0];
          setTimeSignature(`${mb.timeSignatureNumerator}/${mb.timeSignatureDenominator}`);
          // masterBar.tempo doesn't exist in alphaTab 1.8 — the song tempo is
          // derived from the first bar's tempo automation via score.tempo
          setTempo(score.tempo || mb.tempoAutomations?.[0]?.value || null);
        }

        // Capture each track's tuning (first stringed staff) for the header
        // badge and the tuning controls
        const tunings = {};
        (score.tracks || []).forEach((t, i) => {
          const staff = (t.staves || []).find(s => !s.isPercussion && s.stringTuning?.tunings?.length);
          tunings[i] = staff ? [...staff.stringTuning.tunings] : null;
        });
        setTrackTunings(tunings);
        if (!reapplyMixerRef.current) {
          origTuningsRef.current = tunings;
        }

        // A tuning change re-renders the score; keep the mixer state instead
        // of rebuilding it, and push it back onto the fresh score
        if (reapplyMixerRef.current) {
          reapplyMixerRef.current = false;
          for (const t of tracksRef.current) {
            const tr = score.tracks?.[t.id];
            if (!tr) continue;
            setTrackSynthVolumeRef.current(t.id, t.volume);
            if (t.muted) api.changeTrackMute([tr], true);
            if (t.solo) api.changeTrackSolo([tr], true);
          }
          return;
        }

        const sanitizeName = (name, i) => {
          if (!name) return `Track ${i + 1}`;
          // Remove replacement characters and non-printable chars
          const cleaned = name.replace(/[\uFFFD\u0000-\u001F\u0080-\u009F]/g, '').trim();
          // If only numbers/symbols remain after stripping, use generic name
          if (!cleaned || /^[\d\s\W]+$/.test(cleaned)) return `Track ${i + 1}`;
          return cleaned;
        };

        const trackList = (score.tracks || []).map((t, i) => ({
          id: i,
          name: sanitizeName(t.name, i),
          volume: 100,
          muted: false,
          solo: false,
          color: TRACK_COLORS[i % TRACK_COLORS.length],
          isDrum: t.isPercussion || (t.playbackInfo && t.playbackInfo.program === 0 && t.playbackInfo.primaryChannel === 9),
        }));
        setTracks(trackList);

        // push initial volumes so the HQ guitar boost applies from first note
        trackList.forEach(t => setTrackSynthVolumeRef.current(t.id, t.volume));

        // Initial load complete — bring back this song's saved practice state
        restoreStateRef.current?.(api);
      });

      api.error.on((e) => {
        console.error('alphaTab error', e);
        setError('Failed to load file: ' + (e?.message || String(e)));
        setLoading(false);
      });

      // Load via raw bytes (rather than URL) so tuning changes can re-parse
      // a pristine copy of the score
      const url = `/api/file/${encodeURIComponent(file.name)}${version > 0 ? `?v=${version}` : ''}`;
      console.log('Loading URL:', url);
      const resp = await fetch(url);
      if (resp.status === 404 && version > 0) {
        // version was deleted elsewhere — fall back to the original
        onVersionChange?.(0);
        return;
      }
      if (!resp.ok) throw new Error(`Failed to fetch file (${resp.status})`);
      if (gen !== initGenRef.current) return; // unmounted while fetching
      bytesRef.current = new Uint8Array(await resp.arrayBuffer());
      api.load(bytesRef.current);

    } catch (e) {
      console.error('Init error', e);
      setError('Failed to initialize player: ' + (e?.message || String(e)));
      setLoading(false);
    }
  }, [file, version]);

  useEffect(() => {
    initAlphaTab();
    return () => {
      initGenRef.current++; // invalidate any in-flight init
      clearUiTimers();
      try { cursorHandlerRef.current?.clearPending(); } catch (e) {}
      if (apiRef.current) {
        try { apiRef.current.destroy(); } catch (e) {}
        apiRef.current = null;
      }
    };
  }, [initAlphaTab]);

  const handleAvSync = (ms) => {
    setAvSync(ms);
    avSyncRef.current = ms;
    saveAvSync(ms);
    // queued updates were scheduled with the old offset; drop them so the new
    // value applies cleanly from the next beat
    cursorHandlerRef.current?.clearPending();
    clearUiTimers();
  };

  const togglePlay = () => {
    if (!apiRef.current) return;
    // edits only re-render visually — regenerate the playback MIDI lazily
    editor.refreshMidiIfDirty();
    // alphaTab resumes its own suspended AudioContext on play (user gesture)
    apiRef.current.playPause();
  };
  const stop = () => { if (apiRef.current) { apiRef.current.stop(); setPlaying(false); } };

  const handleSpeedChange = (val) => {
    setSpeed(val);
    if (apiRef.current) apiRef.current.playbackSpeed = val / 100;
  };

  const handleMasterVolume = (val) => {
    setMasterVolume(val);
    applyMasterVolume(val);
  };

  // Exact tick position where a bar starts (bar index == masterBars.length
  // means "end of song"). Precise even with tempo/time-signature changes.
  const barStartTick = (barIdx) => {
    const mbs = apiRef.current?.score?.masterBars;
    if (!mbs || mbs.length === 0) return null;
    if (barIdx >= mbs.length) {
      const last = mbs[mbs.length - 1];
      return last.start + last.calculateDuration();
    }
    return mbs[Math.max(0, barIdx)].start;
  };

  const applyLoopRange = (start, end) => {
    const api = apiRef.current;
    if (!api) return;
    // Setting playbackRange before the player ever started throws inside
    // alphaTab's audio output — defer until playerReady
    if (!readyRef.current) {
      pendingLoopRangeRef.current = { start, end };
      return;
    }
    const startTick = barStartTick(start);
    const endTick = barStartTick(end);
    if (startTick === null || endTick === null || endTick <= startTick) return;
    api.playbackRange = { startTick, endTick };
    loopRangeTicksRef.current = { startTick, endTick };
  };
  const applyLoopRangeRef = useRef(null);
  applyLoopRangeRef.current = applyLoopRange;

  const handleLoopToggle = () => {
    const next = !loopEnabled;
    setLoopEnabled(next);
    loopEnabledRef.current = next;
    if (apiRef.current) {
      apiRef.current.isLooping = next;
      if (next) {
        applyLoopRange(loopStart, loopEnd);
      } else {
        // release the range so normal playback covers the whole song again
        apiRef.current.playbackRange = null;
        loopRangeTicksRef.current = null;
      }
    }
  };

  // live during drags: UI state only; the playback range is applied on commit
  const handleLoopRange = (start, end) => {
    setLoopStart(start);
    setLoopEnd(end);
  };

  const handleLoopRangeCommit = (start, end) => {
    setLoopStart(start);
    setLoopEnd(end);
    applyLoopRange(start, end);
  };

  const handleTrackVolume = (trackId, vol) => {
    setTracks(ts => ts.map(t => t.id === trackId ? { ...t, volume: vol } : t));
    setTrackSynthVolume(trackId, vol);
  };

  const handleTrackMute = (trackId) => {
    setTracks(ts => ts.map(t => {
      if (t.id !== trackId) return t;
      const next = !t.muted;
      if (apiRef.current?.score?.tracks?.[trackId]) {
        apiRef.current.changeTrackMute([apiRef.current.score.tracks[trackId]], next);
      }
      return { ...t, muted: next };
    }));
  };

  const handleTrackSolo = (trackId) => {
    setTracks(ts => {
      const isSolo = ts[trackId]?.solo;
      return ts.map(t => {
        const nextSolo = t.id === trackId ? !isSolo : false;
        if (apiRef.current?.score?.tracks?.[t.id]) {
          apiRef.current.changeTrackSolo([apiRef.current.score.tracks[t.id]], nextSolo);
        }
        return { ...t, solo: nextSolo };
      });
    });
  };

  // Apply (or clear) a temporary tuning change. Re-parses the original file
  // bytes, transforms the fresh score, and re-renders — the file on disk is
  // never touched.
  const applyTuning = (target, mode, trackIdx = visibleTrack) => {
    const api = apiRef.current;
    const at = atRef.current;
    if (!api || !at || !bytesRef.current) return;

    setTuningTarget(target);
    setTuningMode(mode);

    try { api.stop(); } catch (e) {}

    let score;
    try {
      score = at.importer.ScoreLoader.loadScoreFromBytes(bytesRef.current, api.settings);
    } catch (e) {
      console.error('Tuning re-parse failed', e);
      return;
    }

    let outOfRange = 0;
    const refTuning = origTuningsRef.current[trackIdx];
    if (target && refTuning) {
      if (mode === 'refinger') {
        outOfRange = refingerScore(score, refTuning, target.tunings).outOfRange;
      } else {
        shiftScorePitch(score, semitoneShift(refTuning, target.tunings));
      }
    }
    setTuningOutOfRange(outOfRange);

    reapplyMixerRef.current = true;
    api.renderScore(score, [trackIdx]);

    // Restore the loop region on the re-rendered score (same bar structure,
    // so the same bar indexes apply)
    if (loopEnabled) {
      applyLoopRange(loopStart, loopEnd);
    }
  };

  // Persist the chosen version alongside practice state, then remount via App.
  // Unsaved draft edits are flushed first so switching versions never loses work.
  const switchVersion = async (v) => {
    try { await editor.flushDraft(); } catch (e) {}
    try {
      const st = loadSongState(file.name) || {};
      saveSongState(file.name, { ...st, version: v });
    } catch (e) {}
    onVersionChange?.(v);
  };

  // Delete the currently selected version, then jump to the newest remaining
  const handleDeleteVersion = async () => {
    const entry = versions.find(x => x.v === version);
    if (!entry) return;
    if (!confirm(`Delete version v${entry.v} (${entry.label})? The original file is unaffected.`)) return;
    try {
      const resp = await fetch(`/api/version/${encodeURIComponent(file.name)}/${entry.v}`, { method: 'DELETE' });
      if (!resp.ok) throw new Error(`Delete failed (${resp.status})`);
      const remaining = versions.filter(x => x.v !== entry.v);
      setVersions(remaining);
      switchVersion(remaining.length ? Math.max(...remaining.map(x => x.v)) : 0);
    } catch (e) {
      console.error('Delete version failed', e);
    }
  };

  // Change the song's real tempo: re-parse the current version's pristine
  // bytes, scale every tempo automation, export as a new .gp version. The
  // file being played is never modified.
  const handleTempoSave = async () => {
    const api = apiRef.current;
    const at = atRef.current;
    const newTempo = Math.max(20, Math.min(400, parseInt(tempoDraft, 10) || 0));
    if (!api || !at || !bytesRef.current || !newTempo) return;
    setSavingVersion(true);
    setVersionError(null);
    try {
      const score = at.importer.ScoreLoader.loadScoreFromBytes(bytesRef.current, api.settings);
      scaleScoreTempo(score, newTempo);
      const bytes = exportScoreGp(at, score, api.settings);
      const resp = await fetch(
        `/api/version/${encodeURIComponent(file.name)}?label=${encodeURIComponent(newTempo + ' BPM')}&tempo=${newTempo}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }
      );
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Save failed (${resp.status})`);
      }
      const entry = await resp.json();
      setTempoOpen(false);
      switchVersion(entry.v);
    } catch (e) {
      setVersionError(e.message || String(e));
    } finally {
      setSavingVersion(false);
    }
  };

  // ---- edit mode ----------------------------------------------------------

  const toggleEdit = () => {
    if (editMode) {
      editor.disable(); // flushes any unsaved draft
      setEditMode(false);
      return;
    }
    // tuning overrides are a view transform on pristine bytes; editing works
    // on the file's actual notes, so the override must come off first
    if (tuningTarget) {
      if (!confirm("Editing changes the file's actual notes — reset the tuning view first?")) return;
      applyTuning(null, tuningMode);
    }
    setEditMode(true);
    editor.enable();
  };

  // load the server draft into the player and continue editing it
  const resumeDraft = async () => {
    const api = apiRef.current;
    if (!api) return;
    try {
      const resp = await fetch(`/api/draft/${encodeURIComponent(file.name)}`);
      if (!resp.ok) { setDraftMeta(null); return; }
      const draftBytes = new Uint8Array(await resp.arrayBuffer());
      try { api.stop(); } catch (e) {}
      api.load(draftBytes);
      editor.markDraftLoaded();
      setEditMode(true);
      editor.enable();
    } catch (e) {
      console.error('Draft resume failed', e);
    }
  };

  const discardDraft = async () => {
    if (!confirm('Discard all draft edits? This cannot be undone.')) return;
    await editor.discardDraft();
    setDraftMeta(null);
  };

  // promote the edited score to a permanent version, drop the draft slot,
  // and remount on the new version (which also exits edit mode)
  const handleSaveEditVersion = async (label) => {
    const api = apiRef.current;
    const at = atRef.current;
    if (!api?.score || !at) return;
    setSavingEditVersion(true);
    setEditSaveError(null);
    try {
      const bytes = exportScoreGp(at, api.score, api.settings);
      const resp = await fetch(
        `/api/version/${encodeURIComponent(file.name)}?label=${encodeURIComponent((label || 'edited').trim() || 'edited')}`,
        { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes }
      );
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Save failed (${resp.status})`);
      }
      const entry = await resp.json();
      editor.markSavedAsVersion();
      try { await fetch(`/api/draft/${encodeURIComponent(file.name)}`, { method: 'DELETE' }); } catch (e) {}
      switchVersion(entry.v);
    } catch (e) {
      setEditSaveError(e.message || String(e));
    } finally {
      setSavingEditVersion(false);
    }
  };

  // Restore saved practice state for this song. Called from scoreLoaded via a
  // ref so it always uses the current render's handlers.
  const restoredRef = useRef(false);
  const restoreStateRef = useRef(null);
  restoreStateRef.current = (api) => {
    const saved = loadSongState(file.name);
    if (!saved) { restoredRef.current = true; return; }
    try {
      if (saved.speed && saved.speed !== 100) handleSpeedChange(saved.speed);
      if (saved.ramp) {
        setRampEnabled(!!saved.ramp.enabled);
        setRampStep(saved.ramp.step || 5);
        setRampTarget(saved.ramp.target || 100);
      }

      const vt = saved.visibleTrack ?? 0;
      const hasTrack = !!api.score?.tracks?.[vt];
      if (saved.tuning?.tunings && hasTrack) {
        setVisibleTrack(vt);
        applyTuning(
          { name: saved.tuning.name, tunings: saved.tuning.tunings, custom: !!saved.tuning.custom },
          saved.tuning.mode || 'refinger',
          vt
        );
      } else if (vt !== 0 && hasTrack) {
        setVisibleTrack(vt);
        api.renderTracks([api.score.tracks[vt]]);
      }

      // mixer (applies to the possibly re-rendered score — api.score is current)
      if (Array.isArray(saved.tracks)) {
        setTracks(list => list.map((t, i) => saved.tracks[i] ? { ...t, ...saved.tracks[i] } : t));
        saved.tracks.forEach((s, i) => {
          const tr = api.score?.tracks?.[i];
          if (!s || !tr) return;
          if (s.volume !== undefined) setTrackSynthVolume(i, s.volume);
          if (s.muted) api.changeTrackMute([tr], true);
          if (s.solo) api.changeTrackSolo([tr], true);
        });
      }

      if (saved.loopStart != null && saved.loopEnd != null) {
        setLoopStart(saved.loopStart);
        setLoopEnd(saved.loopEnd);
      }
      if (saved.loopEnabled) {
        setLoopEnabled(true);
        loopEnabledRef.current = true;
        api.isLooping = true;
        if (saved.loopStart != null && saved.loopEnd != null) {
          applyLoopRange(saved.loopStart, saved.loopEnd);
        }
      }
    } catch (e) {
      console.error('Failed to restore song state', e);
    }
    restoredRef.current = true;
  };

  // Persist practice state (debounced); only after restore ran, so defaults
  // never clobber a saved setup during load
  useEffect(() => {
    if (!restoredRef.current) return;
    const id = setTimeout(() => {
      saveSongState(file.name, {
        v: 1,
        speed,
        loopEnabled,
        loopStart,
        loopEnd,
        ramp: { enabled: rampEnabled, step: rampStep, target: rampTarget },
        tuning: tuningTarget
          ? { name: tuningTarget.name, tunings: tuningTarget.tunings, custom: !!tuningTarget.custom, mode: tuningMode }
          : null,
        tracks: tracks.map(t => ({ volume: t.volume, muted: t.muted, solo: t.solo })),
        visibleTrack,
        version,
      });
    }, 500);
    return () => clearTimeout(id);
  }, [speed, loopEnabled, loopStart, loopEnd, rampEnabled, rampStep, rampTarget, tuningTarget, tuningMode, tracks, visibleTrack, file.name, version]);

  const handleVisibleTrack = (trackId) => {
    setVisibleTrack(trackId);
    visibleTrackRef.current = trackId;
    if (editMode) {
      editor.clearSelection(); // the selection's staff is leaving the screen
      editor.refresh(); // toolbar trackInfo follows the visible track
    }
    if (apiRef.current?.score?.tracks?.[trackId]) {
      apiRef.current.renderTracks([apiRef.current.score.tracks[trackId]]);
    }
  };

  // Edit-mode track ops (add/remove/rename/instrument) change the score's
  // track list out from under React — rebuild the mixer/select state from
  // the live score, keeping existing volume/mute/solo where tracks survive.
  const refreshTracksFromScore = ({ added = null, removed = null } = {}) => {
    const api = apiRef.current;
    if (!api?.score) return;
    setTracks(prev => api.score.tracks.map((t, i) => {
      // map new index -> old index so surviving tracks keep their mixer state
      const oldIndex = removed !== null ? (i < removed ? i : i + 1) : i;
      const existing = prev[oldIndex];
      return {
        id: i,
        name: sanitizeTrackName(t.name, i),
        volume: existing?.volume ?? 100,
        muted: existing?.muted ?? false,
        solo: existing?.solo ?? false,
        color: TRACK_COLORS[i % TRACK_COLORS.length],
        isDrum: t.isPercussion || (t.playbackInfo && t.playbackInfo.program === 0 && t.playbackInfo.primaryChannel === 9),
      };
    }));
    if (added !== null) {
      // jump to the new track so the user can write on it right away
      setTrackSynthVolume(added, 100);
      setVisibleTrack(added);
      if (editMode) editor.clearSelection();
      api.renderTracks([api.score.tracks[added]]);
    } else if (removed !== null) {
      const current = visibleTrackRef.current;
      const next = Math.min(current === removed ? removed : current - (current > removed ? 1 : 0),
        api.score.tracks.length - 1);
      setVisibleTrack(Math.max(0, next));
      api.renderTracks([api.score.tracks[Math.max(0, next)]]);
    }
  };
  const refreshTracksRef = useRef(null);
  refreshTracksRef.current = refreshTracksFromScore;

  const handleRemoveTrack = () => {
    const api = apiRef.current;
    const idx = visibleTrack;
    const track = api?.score?.tracks?.[idx];
    if (!track || api.score.tracks.length <= 1) return;
    if (!confirm(`Delete track "${track.name}" and all its notes? This cannot be undone.`)) return;
    editor.removeTrack(idx);
  };

  // Hot-swap the synthesizer soundfont; playback keeps the score, only the
  // instrument samples change
  const handleSoundBank = (id) => {
    if (!SOUND_BANKS[id] || id === soundBank || soundLoading) return;
    const prevBank = soundBank;
    setSoundBank(id);
    try {
      localStorage.setItem(SOUND_BANK_KEY, id);
      localStorage.removeItem(LEGACY_HQ_KEY);
    } catch (e) {}
    if (apiRef.current) {
      setSoundLoading(true);
      soundfontSwapRef.current = { wasPlaying: playingRef.current, prevBank };
      apiRef.current.loadSoundFontFromUrl(SOUND_BANKS[id].url, false);
    }
  };

  const handleCountIn = () => {
    const next = !countIn;
    setCountIn(next);
    if (apiRef.current) apiRef.current.countInVolume = next ? 1 : 0;
  };

  const handleMetronome = () => {
    const next = !metronome;
    setMetronome(next);
    if (apiRef.current) apiRef.current.metronomeVolume = next ? 1 : 0;
  };

  // Keyboard shortcuts: Space play/pause, L loop, arrows seek a bar, +/- speed.
  // No deps array on purpose — re-registering each render keeps closures fresh.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'l':
        case 'L':
          handleLoopToggle();
          break;
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const next = Math.max(0, Math.min(totalBars - 1, currentBar + (e.key === 'ArrowRight' ? 1 : -1)));
          const tick = barStartTick(next);
          if (tick !== null && apiRef.current) {
            apiRef.current.tickPosition = tick;
            // playedBeatChanged only fires during playback — keep the bar
            // counter (and the next arrow press) in sync while paused
            setCurrentBar(next);
          }
          break;
        }
        case '+':
        case '=':
          handleSpeedChange(Math.min(200, speed + 5));
          break;
        case '-':
        case '_':
          handleSpeedChange(Math.max(25, speed - 5));
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const progress = totalTicks > 0 ? currentTick / totalTicks : 0;

  const currentTuning = trackTunings[visibleTrack];
  const originalTuning = origTuningsRef.current[visibleTrack];
  const currentTuningLabel = tuningLabel(currentTuning);
  const originalTuningLabel = tuningLabel(originalTuning);

  return (
    <div className={styles.player}>
      <div className={styles.header}>
        {onToggleSidebar && !editMode && (
          <button className={styles.menuBtn} onClick={onToggleSidebar} title="Library">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M3 12h18M3 18h18"/>
            </svg>
          </button>
        )}
        <div className={styles.songInfo}>
          <h1 className={styles.title}>{scoreTitle || file.name.replace(/\.(gp\w*)$/i, '')}</h1>
          <div className={styles.meta}>
            {scoreArtist && <span className={styles.artist}>{scoreArtist}</span>}
            {tempo && (
              <span className={styles.tempoWrap} ref={tempoWrapRef}>
                <button
                  className={`${styles.badge} ${styles.badgeBtn}`}
                  disabled={editMode || ed.scoreDirty}
                  onClick={() => {
                    setTempoDraft(String(tempo));
                    setVersionError(null);
                    setTempoOpen(o => !o);
                  }}
                  title={editMode || ed.scoreDirty
                    ? 'Tempo changes are unavailable while the song has draft edits'
                    : "Change the song's tempo (saved as a new version)"}
                >
                  {tempo} BPM ✎
                </button>
                {tempoOpen && (
                  <div className={styles.tempoPanel}>
                    <div className={styles.tempoTitle}>Song tempo</div>
                    <div className={styles.tempoRow}>
                      <input
                        className={styles.tempoInput}
                        type="number"
                        min="20"
                        max="400"
                        value={tempoDraft}
                        onChange={e => setTempoDraft(e.target.value)}
                        autoFocus
                      />
                      <span className={styles.tempoUnit}>BPM</span>
                      <button
                        className={styles.tempoSave}
                        onClick={handleTempoSave}
                        disabled={savingVersion || !parseInt(tempoDraft, 10) || parseInt(tempoDraft, 10) === tempo}
                      >
                        {savingVersion ? 'Saving…' : 'Save as version'}
                      </button>
                    </div>
                    {versionError && <div className={styles.tempoError}>{versionError}</div>}
                    <div className={styles.tempoHint}>
                      Mid-song tempo changes scale proportionally. The original file is kept —
                      switch versions with the dropdown.
                    </div>
                  </div>
                )}
              </span>
            )}
            {timeSignature && <span className={styles.badge}>{timeSignature}</span>}
            {totalBars > 0 && <span className={styles.badge}>{totalBars} bars</span>}
            {currentTuningLabel && (
              <span
                className={`${styles.badge} ${tuningTarget ? styles.badgeAccent : ''}`}
                title={tuningTarget
                  ? `Tuning (file is in ${originalTuningLabel})`
                  : `Tuning: ${currentTuningLabel}`}
              >
                {currentTuningLabel}
              </span>
            )}
          </div>
        </div>
        <div className={styles.headerRight}>
          {!editMode && versions.length > 0 && (
            <>
              <select
                style={headerSelectStyle}
                value={version}
                onChange={e => switchVersion(Number(e.target.value))}
                title="Switch between saved versions of this song"
              >
                <option value={0}>Original</option>
                {versions.map(v => (
                  <option key={v.v} value={v.v}>{`v${v.v} · ${v.label}`}</option>
                ))}
              </select>
              {version > 0 && (
                <button
                  className={styles.versionDelete}
                  onClick={handleDeleteVersion}
                  title={`Delete version v${version}`}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14H6L5 6"/>
                    <path d="M10 11v6M14 11v6"/>
                    <path d="M9 6V4h6v2"/>
                  </svg>
                </button>
              )}
            </>
          )}
          <button
            className={`${styles.iconBtn} ${styles.editToggle} ${editMode ? styles.active : ''}`}
            onClick={toggleEdit}
            title={editMode ? 'Leave edit mode (draft is kept)' : 'Edit the tab — notes, durations, rests'}
          >
            <EditIcon /><span>Edit</span>
          </button>
          {/* tuning is a view transform over pristine bytes — it would wipe
              draft edits, so it hides while the score has any */}
          {!editMode && !ed.scoreDirty && (
            <TuningControls
              originalTunings={originalTuning}
              originalLabel={originalTuningLabel}
              currentLabel={currentTuningLabel}
              target={tuningTarget}
              mode={tuningMode}
              outOfRange={tuningOutOfRange}
              onApply={applyTuning}
            />
          )}
          {tracks.length > 1 && (
            <select
              style={headerSelectStyle}
              value={visibleTrack}
              onChange={e => handleVisibleTrack(Number(e.target.value))}
            >
              {tracks.filter(t => !t.isDrum).map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
          {!editMode && tracks.length > 0 && (
            <button
              className={`${styles.iconBtn} ${styles.mobileOnly} ${mixerOpen ? styles.active : ''}`}
              onClick={() => setMixerOpen(o => !o)}
              title="Mixer"
            >
              <MixerIcon /><span>Mixer</span>
            </button>
          )}
          {!editMode && (
            <SettingsMenu
              soundBank={soundBank}
              soundLoading={soundLoading}
              onSoundBank={handleSoundBank}
              metronome={metronome}
              onMetronome={handleMetronome}
              countIn={countIn}
              onCountIn={handleCountIn}
              avSync={avSync}
              onAvSync={handleAvSync}
            />
          )}
        </div>
      </div>

      {editMode && (
        <EditToolbar
          ed={ed}
          editor={editor}
          saving={savingEditVersion}
          saveError={editSaveError}
          onSaveVersion={handleSaveEditVersion}
          onDiscard={discardDraft}
          onExit={toggleEdit}
          onRemoveTrack={handleRemoveTrack}
        />
      )}

      {draftMeta && !editMode && !ed.scoreDirty && (
        <div className={styles.draftBanner}>
          <span className={styles.draftText}>
            Unsaved draft edits from {new Date(draftMeta.updatedAt).toLocaleString()}
            {draftMeta.base > 0 ? ` (based on v${draftMeta.base})` : ''}
          </span>
          <button className={styles.draftResume} onClick={resumeDraft}>Resume editing</button>
          <button className={styles.draftDismiss} onClick={discardDraft}>Discard</button>
        </div>
      )}

      {!editMode && (
        <LoopBar
          enabled={loopEnabled}
          onToggle={handleLoopToggle}
          start={loopStart}
          end={loopEnd}
          total={totalBars}
          currentBar={currentBar}
          progress={progress}
          onRangeChange={handleLoopRange}
          onRangeCommit={handleLoopRangeCommit}
        />
      )}

      <div className={styles.body}>
        <div className={styles.scoreWrap}>
          {loading && (
            <div className={styles.loadOverlay}>
              <div className={styles.spinner} />
              <span>Loading score...</span>
            </div>
          )}
          {error && (
            <div className={styles.errorOverlay}>
              <span>{error}</span>
            </div>
          )}
          <div ref={containerRef} className={styles.atContainer} />
          {editMode && <EditCaret caret={ed.caret} />}
        </div>
        {tracks.length > 0 && !editMode && (
          <>
            {mixerOpen && (
              <div className={styles.mixerBackdrop} onClick={() => setMixerOpen(false)} />
            )}
            {/* desktop: transparent wrapper in the flex row; mobile: bottom sheet */}
            <div className={`${styles.mixerWrap} ${mixerOpen ? styles.mixerOpen : ''}`}>
              <TrackMixer
                tracks={tracks}
                masterVolume={masterVolume}
                onMasterVolume={handleMasterVolume}
                onTrackVolume={handleTrackVolume}
                onTrackMute={handleTrackMute}
                onTrackSolo={handleTrackSolo}
                visibleTrack={visibleTrack}
                onSelectTrack={handleVisibleTrack}
                boostSelected={boostSelected}
                onToggleBoost={() => setBoostSelected(b => !b)}
              />
            </div>
          </>
        )}
      </div>

      <PlaybackControls
        playing={playing}
        ready={ready}
        speed={speed}
        onPlayPause={togglePlay}
        onStop={stop}
        onSpeedChange={handleSpeedChange}
        progress={progress}
        currentBar={currentBar}
        totalBars={totalBars}
        loopCount={loopCount}
        rampEnabled={rampEnabled}
        rampTarget={rampTarget}
        rampStep={rampStep}
        onRampEnabled={setRampEnabled}
        onRampTarget={setRampTarget}
        onRampStep={setRampStep}
      />
    </div>
  );
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
    </svg>
  );
}

function MixerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
      <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
      <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
      <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>
      <line x1="17" y1="16" x2="23" y2="16"/>
    </svg>
  );
}

