import React, { useEffect, useRef, useState, useCallback } from 'react';
import styles from './Player.module.css';
import TrackMixer from './TrackMixer.jsx';
import PlaybackControls from './PlaybackControls.jsx';
import LoopBar from './LoopBar.jsx';
import TuningControls from './TuningControls.jsx';
import AvSyncControls from './AvSyncControls.jsx';
import { tuningLabel, refingerScore, shiftScorePitch, semitoneShift } from '../lib/tuning.js';
import { createSyncedCursorHandler, loadAvSync, saveAvSync } from '../lib/avSync.js';
import { loadSongState, saveSongState } from '../lib/songState.js';

const TRACK_COLORS = [
  '#e8673a', '#4a9eff', '#3acd7e', '#e8c13a',
  '#c97aff', '#ff7aaa', '#7acfff', '#ffaa4a',
];

const SOUNDFONTS = {
  standard: 'https://cdn.jsdelivr.net/npm/@coderline/alphatab@latest/dist/soundfont/sonivox.sf2',
  hq: '/api/soundfont/hq', // GeneralUser GS, downloaded+cached by the backend
};
const HQ_SOUND_KEY = 'tabvault-hq-sound';

export default function Player({ file, onMetaLoaded, onToggleSidebar }) {
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
  const [hqSound, setHqSound] = useState(() => {
    try { return localStorage.getItem(HQ_SOUND_KEY) === '1'; } catch (e) { return false; }
  });
  const [soundLoading, setSoundLoading] = useState(false);
  const [mixerOpen, setMixerOpen] = useState(false); // mobile bottom-sheet mixer

  const soundfontSwapRef = useRef(null); // {wasPlaying} while a user-initiated soundfont swap is in flight

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
          soundFont: hqSound ? SOUNDFONTS.hq : SOUNDFONTS.standard,
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
      });

      // (lives on the synth, not the api facade)
      api.player?.soundFontLoadFailed?.on((err) => {
        console.error('Soundfont load failed', err);
        setSoundLoading(false);
        const failedSwap = soundfontSwapRef.current;
        soundfontSwapRef.current = null;
        // the synth still has the previous font — flip the toggle back
        if (failedSwap) {
          setHqSound(h => {
            const reverted = !h;
            try { localStorage.setItem(HQ_SOUND_KEY, reverted ? '1' : '0'); } catch (e2) {}
            return reverted;
          });
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
          setTempo(mb.tempo);
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
            if (t.volume !== 100) api.changeTrackVolume([tr], t.volume / 100);
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
      const url = `/api/file/${encodeURIComponent(file.name)}`;
      console.log('Loading URL:', url);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch file (${resp.status})`);
      if (gen !== initGenRef.current) return; // unmounted while fetching
      bytesRef.current = new Uint8Array(await resp.arrayBuffer());
      api.load(bytesRef.current);

    } catch (e) {
      console.error('Init error', e);
      setError('Failed to initialize player: ' + (e?.message || String(e)));
      setLoading(false);
    }
  }, [file]);

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
    if (apiRef.current) apiRef.current.masterVolume = val / 100;
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
    if (apiRef.current?.score?.tracks?.[trackId]) {
      apiRef.current.changeTrackVolume([apiRef.current.score.tracks[trackId]], vol / 100);
    }
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
          if (s.volume !== undefined && s.volume !== 100) api.changeTrackVolume([tr], s.volume / 100);
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
      });
    }, 500);
    return () => clearTimeout(id);
  }, [speed, loopEnabled, loopStart, loopEnd, rampEnabled, rampStep, rampTarget, tuningTarget, tuningMode, tracks, visibleTrack, file.name]);

  const handleVisibleTrack = (trackId) => {
    setVisibleTrack(trackId);
    if (apiRef.current?.score?.tracks?.[trackId]) {
      apiRef.current.renderTracks([apiRef.current.score.tracks[trackId]]);
    }
  };

  // Hot-swap the synthesizer soundfont; playback keeps the score, only the
  // instrument samples change
  const handleHqSound = () => {
    const next = !hqSound;
    setHqSound(next);
    try { localStorage.setItem(HQ_SOUND_KEY, next ? '1' : '0'); } catch (e) {}
    if (apiRef.current) {
      setSoundLoading(true);
      soundfontSwapRef.current = { wasPlaying: playingRef.current };
      apiRef.current.loadSoundFontFromUrl(next ? SOUNDFONTS.hq : SOUNDFONTS.standard, false);
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
        {onToggleSidebar && (
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
            {tempo && <span className={styles.badge}>{tempo} BPM</span>}
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
          <TuningControls
            originalTunings={originalTuning}
            originalLabel={originalTuningLabel}
            currentLabel={currentTuningLabel}
            target={tuningTarget}
            mode={tuningMode}
            outOfRange={tuningOutOfRange}
            onApply={applyTuning}
          />
          {tracks.length > 1 && (
            <select
              style={{
                background: 'var(--bg4)',
                border: '1px solid var(--border2)',
                borderRadius: '6px',
                color: 'var(--text)',
                fontSize: '12px',
                padding: '4px 8px',
                fontFamily: 'var(--font-body)',
                cursor: 'pointer',
                maxWidth: '160px',
              }}
              value={visibleTrack}
              onChange={e => handleVisibleTrack(Number(e.target.value))}
            >
              {tracks.filter(t => !t.isDrum).map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          )}
          {tracks.length > 0 && (
            <button
              className={`${styles.iconBtn} ${styles.mobileOnly} ${mixerOpen ? styles.active : ''}`}
              onClick={() => setMixerOpen(o => !o)}
              title="Mixer"
            >
              <MixerIcon /><span>Mixer</span>
            </button>
          )}
          <AvSyncControls offset={avSync} onChange={handleAvSync} />
          <button
            className={`${styles.iconBtn} ${hqSound ? styles.active : ''}`}
            onClick={handleHqSound}
            disabled={soundLoading}
            title={hqSound
              ? 'HQ sound on (GeneralUser GS soundfont) — click for standard'
              : 'Switch to HQ sound — richer instrument samples (~32MB, downloaded once)'}
          >
            <HqSoundIcon /><span>{soundLoading ? 'Loading…' : 'HQ Sound'}</span>
          </button>
          <button className={`${styles.iconBtn} ${metronome ? styles.active : ''}`} onClick={handleMetronome} title="Metronome">
            <MetronomeIcon /><span>Click</span>
          </button>
          <button className={`${styles.iconBtn} ${countIn ? styles.active : ''}`} onClick={handleCountIn} title="Count in">
            <CountInIcon /><span>Count In</span>
          </button>
        </div>
      </div>

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
        </div>
        {tracks.length > 0 && (
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

function HqSoundIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12h2l2-7 3 14 3-10 2 5 2-2h6" />
    </svg>
  );
}

function MetronomeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="12 2 2 19.8 22 19.8"/>
      <line x1="12" y1="2" x2="17" y2="13"/>
      <line x1="12" y1="19.8" x2="12" y2="14"/>
    </svg>
  );
}

function CountInIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10"/>
      <path d="M12 6v6l4 2"/>
    </svg>
  );
}
