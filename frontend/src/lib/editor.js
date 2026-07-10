// EditorController: owns all edit-mode state (selection, digit buffer,
// undo/redo, draft autosave) and mutates the live alphaTab score
// imperatively. React never owns the score — components render from the
// snapshot this controller publishes (see useEditor.js).
//
// Selection is an index path ({trackIndex, staffIndex, barIndex, voiceIndex,
// beatIndex, string}) rather than object references: alphaTab hands out
// fresh objects across re-renders, only indexes are stable.
import {
  MAX_FRET, DURATIONS, NOTE_PROPS, pathForBeat, beatAtPath, noteOnString,
  setFret, removeNoteOnString, setRest, setBeatDuration, setBeatDots, setNoteProp,
  appendRestBeat, removeBeat, insertRestBeatAt, deleteBeat, restoreBeat, finalizeEdit,
} from './editScore.js';
import { exportScoreGp } from './editing.js';

const UNDO_CAP = 100;
const DIGIT_COMMIT_MS = 600;   // multi-digit fret entry window (type 1 then 2 → 12)
const RENDER_DEBOUNCE_MS = 50; // batch paints behind rapid keystrokes (~130ms/render)
const AUTOSAVE_MS = 4000;

export class EditorController {
  constructor(opts) {
    // opts: { getApi, getAt, getContainer, getPristineBytes, beforeRender,
    //         fileName, getVersion }
    this.opts = opts;
    this._listeners = new Set();
    this._undo = [];
    this._redo = [];
    this._selection = null;      // index path + string
    this._digit = null;          // { value, timer } while a fret entry is open
    this._renderTimer = null;
    this._renderFromBar = Infinity;
    this._autosaveTimer = null;
    this._enabled = false;
    this._scoreDirty = false;    // score diverged from the pristine file bytes
    this._draftDirty = false;    // edits not yet autosaved to the server
    this._midiDirty = false;     // playback MIDI stale vs the visual score
    this._draftStatus = 'clean'; // clean | dirty | saving | saved | error
    this._draftSavedAt = null;
    this._saving = null;         // in-flight save promise
    this._onPointerDown = this._handlePointerDown.bind(this);
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onPostRender = () => this._emit();
    this._onPageHide = () => this._beaconDraft();
    this._snapshot = this._buildSnapshot();
    this.subscribe = (fn) => { this._listeners.add(fn); return () => this._listeners.delete(fn); };
    this.getSnapshot = () => this._snapshot;
  }

  get draftUrl() {
    return `/api/draft/${encodeURIComponent(this.opts.fileName)}`;
  }

  // ---- lifecycle ----------------------------------------------------------

  enable() {
    if (this._enabled) return;
    const api = this.opts.getApi();
    if (!api) return;
    this._enabled = true;
    // alphaTab's own click handling (seek, drag-select) competes with editor
    // clicks — turn it off and also swallow pointerdowns before they reach
    // the render surface (updateSettings alone doesn't detach live handlers)
    try {
      api.settings.player.enableUserInteraction = false;
      api.updateSettings();
    } catch (e) {}
    this.opts.getContainer()?.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    api.postRenderFinished?.on(this._onPostRender);
    window.addEventListener('pagehide', this._onPageHide);
    this._emit();
  }

  disable({ flush = true } = {}) {
    if (!this._enabled) return;
    this._enabled = false;
    const api = this.opts.getApi();
    try {
      if (api) {
        api.settings.player.enableUserInteraction = true;
        api.updateSettings();
      }
    } catch (e) {}
    this.opts.getContainer()?.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
    api?.postRenderFinished?.off(this._onPostRender);
    window.removeEventListener('pagehide', this._onPageHide);
    this._closeDigitBuffer();
    this._selection = null;
    if (flush) this.flushDraft().catch(() => {});
    this._emit();
  }

  dispose() {
    // unmount: best-effort flush, keep subscribers (StrictMode re-mounts)
    if (this._draftDirty) this.flushDraft().catch(() => {});
    this.disable({ flush: false });
  }

  // ---- selection ----------------------------------------------------------

  _handlePointerDown(e) {
    const api = this.opts.getApi();
    const container = this.opts.getContainer();
    if (!api?.boundsLookup || !container) return;
    // block alphaTab's own handlers deeper in the container
    e.stopPropagation();
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const beat = api.boundsLookup.getBeatAtPos(x, y);
    if (!beat) { this.clearSelection(); return; }
    const staff = beat.voice.bar.staff;
    if (staff.isPercussion || !staff.stringTuning?.tunings?.length) return;

    let string = api.boundsLookup.getNoteAtPos?.(beat, x, y)?.string ?? null;
    if (string == null) {
      // empty position: derive the string from the click's y on the tab
      // staff — bar bounds top/bottom are the outer string lines (verified
      // exact against note bounds, 0.5px median error)
      const geo = this._staffGeometry(beat);
      if (!geo) return;
      const lineIdx = Math.round((y - geo.top) / geo.spacing);
      string = Math.max(1, Math.min(geo.count, geo.count - lineIdx));
    }
    this._closeDigitBuffer();
    this._selection = pathForBeat(beat, string);
    this._emit();
  }

  clearSelection() {
    if (!this._selection) return;
    this._closeDigitBuffer();
    this._selection = null;
    this._emit();
  }

  selectedBeat() {
    const api = this.opts.getApi();
    return api?.score && this._selection ? beatAtPath(api.score, this._selection) : null;
  }

  // tab-staff line geometry for the bar a beat sits in (render coordinates)
  _staffGeometry(beat) {
    const api = this.opts.getApi();
    const bb = api?.boundsLookup?.findBeat(beat);
    if (!bb) return null;
    const count = beat.voice.bar.staff.stringTuning?.tunings?.length;
    if (!count || count < 2) return null;
    const bar = bb.barBounds.visualBounds;
    return { beatBounds: bb, top: bar.y, spacing: bar.h / (count - 1), count };
  }

  getCaretRect() {
    const beat = this.selectedBeat();
    if (!beat || !this._selection?.string) return null;
    const geo = this._staffGeometry(beat);
    if (!geo) return null;
    const vb = geo.beatBounds.visualBounds;
    const lineY = geo.top + (geo.count - this._selection.string) * geo.spacing;
    const w = Math.max(vb.w, 14);
    return {
      x: vb.x - 3,
      y: lineY - geo.spacing / 2,
      w: w + 6,
      h: geo.spacing,
    };
  }

  // ---- keyboard -----------------------------------------------------------

  _handleKeyDown(e) {
    if (!this._enabled) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    const meta = e.metaKey || e.ctrlKey;
    if (meta && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.shiftKey) this.redo(); else this.undo();
      return;
    }
    if (meta || e.altKey) return;

    if (e.key === 'Escape') { this.clearSelection(); return; }
    if (!this._selection) return; // unclaimed keys keep their player meaning

    const claim = () => { e.preventDefault(); e.stopImmediatePropagation(); };

    if (/^[0-9]$/.test(e.key)) { claim(); this._enterDigit(Number(e.key)); return; }
    if (e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete')) {
      claim();
      this.deleteSelectedBeat();
      return;
    }
    switch (e.key) {
      case 'ArrowLeft': claim(); this._moveBeat(-1); return;
      case 'ArrowRight': claim(); this._moveBeat(1); return;
      case 'ArrowUp': claim(); this._moveString(1); return;
      case 'ArrowDown': claim(); this._moveString(-1); return;
      case '[': claim(); this.setDuration(this._stepDurationValue(-1)); return;
      case ']': claim(); this.setDuration(this._stepDurationValue(1)); return;
      case '.': claim(); this.cycleDots(); return;
      case 'r': case 'R': claim(); this.toggleRest(); return;
      case 'Delete': case 'Backspace': claim(); this.deleteNote(); return;
      case 'Enter': claim(); this.insertBeatAfterSelection(); return;
      case 'p': case 'P': claim(); this.toggleNoteProp('palmMute'); return;
      case 'h': case 'H': claim(); this.toggleNoteProp('hammerPull'); return;
      case 't': case 'T': claim(); this.toggleNoteProp('tie'); return;
      case 'x': case 'X': claim(); this.toggleNoteProp('dead'); return;
      case 'v': case 'V': claim(); this.toggleNoteProp('vibrato'); return;
      case 'g': case 'G': claim(); this.toggleNoteProp('letRing'); return;
    }
  }

  _moveString(dir) {
    const beat = this.selectedBeat();
    if (!beat) return;
    const count = beat.voice.bar.staff.stringTuning?.tunings?.length || 6;
    this._closeDigitBuffer();
    this._selection.string = Math.max(1, Math.min(count, (this._selection.string || 1) + dir));
    this._emit();
  }

  _moveBeat(dir) {
    const beat = this.selectedBeat();
    if (!beat) return;
    this._closeDigitBuffer();
    const next = dir > 0 ? beat.nextBeat : beat.previousBeat;
    if (next && next.voice.bar.staff === beat.voice.bar.staff) {
      this._selection = pathForBeat(next, this._selection.string);
      this._emit();
      return;
    }
    if (dir > 0) {
      // end of song: keep entering — append a rest beat to this voice
      this._apply({ kind: 'appendBeat', path: {
        ...this._selection,
        barIndex: beat.voice.bar.index,
        voiceIndex: beat.voice.index,
        beatIndex: beat.voice.beats.length,
      }, duration: beat.duration });
      this._selection = { ...this._selection, barIndex: beat.voice.bar.index, beatIndex: beat.voice.beats.length - 1 };
      this._emit();
    }
  }

  // ---- fret entry ---------------------------------------------------------

  _enterDigit(d) {
    if (!this._selection?.string) return;
    if (this._digit) {
      clearTimeout(this._digit.timer);
      const combined = this._digit.value * 10 + d;
      if (combined <= MAX_FRET) {
        // same undo entry: rewrite the open command's fret in place
        this._digit.value = combined;
        this._digit.timer = setTimeout(() => this._closeDigitBuffer(), DIGIT_COMMIT_MS);
        this._coalesceFret(combined);
        return;
      }
      this._closeDigitBuffer();
    }
    this._digit = { value: d, timer: setTimeout(() => this._closeDigitBuffer(), DIGIT_COMMIT_MS) };
    this._apply({ kind: 'setFret', path: { ...this._selection }, string: this._selection.string, fret: d });
  }

  _closeDigitBuffer() {
    if (!this._digit) return;
    clearTimeout(this._digit.timer);
    this._digit = null;
    this._emit();
  }

  _coalesceFret(fret) {
    const api = this.opts.getApi();
    const at = this.opts.getAt();
    const top = this._undo[this._undo.length - 1];
    const beat = this.selectedBeat();
    if (!api || !at || !beat || !top || top.kind !== 'setFret') return;
    setFret(at, beat, top.string, fret);
    top.fret = fret; // oldFret stays from the first digit
    this._afterMutation(top.path.barIndex);
  }

  // ---- commands -----------------------------------------------------------

  deleteNote() {
    const beat = this.selectedBeat();
    if (!beat || !this._selection?.string) return;
    if (!noteOnString(beat, this._selection.string)) return;
    this._apply({ kind: 'deleteNote', path: { ...this._selection }, string: this._selection.string });
  }

  toggleRest() {
    const beat = this.selectedBeat();
    if (!beat) return;
    if (beat.isRest) return; // a rest stays a rest until frets are typed
    this._apply({ kind: 'rest', path: { ...this._selection } });
  }

  setDuration(duration) {
    const beat = this.selectedBeat();
    if (!beat || beat.duration === duration) return;
    this._apply({ kind: 'duration', path: { ...this._selection }, duration });
  }

  _stepDurationValue(dir) {
    const beat = this.selectedBeat();
    const cur = DURATIONS.indexOf(beat?.duration ?? 4);
    const from = cur === -1 ? DURATIONS.indexOf(4) : cur;
    return DURATIONS[Math.max(0, Math.min(DURATIONS.length - 1, from + dir))];
  }

  cycleDots() {
    const beat = this.selectedBeat();
    if (!beat) return;
    this._apply({ kind: 'dots', path: { ...this._selection }, dots: (beat.dots + 1) % 3 });
  }

  // toggle a per-note effect (palm mute, tie, hammer/pull, …) on the
  // selected string's note; no-op when the position is empty
  toggleNoteProp(key) {
    const beat = this.selectedBeat();
    const string = this._selection?.string;
    if (!beat || !string) return;
    const note = noteOnString(beat, string);
    if (!note) return;
    const prop = NOTE_PROPS[key];
    // vibrato is an enum: cycle none (0) ↔ slight (1); the rest are booleans
    const value = key === 'vibrato' ? (note.vibrato ? 0 : 1) : !note[prop];
    this._apply({ kind: 'noteProp', path: { ...this._selection }, string, prop, value });
  }

  insertBeatAfterSelection() {
    const beat = this.selectedBeat();
    if (!beat) return;
    const index = this._selection.beatIndex + 1;
    this._apply({
      kind: 'insertBeat',
      path: { ...this._selection, beatIndex: index },
      duration: beat.duration,
    });
    this._selection = { ...this._selection, beatIndex: index };
    this._emit();
  }

  deleteSelectedBeat() {
    const beat = this.selectedBeat();
    if (!beat || beat.voice.beats.length <= 1) return;
    this._apply({ kind: 'deleteBeat', path: { ...this._selection } });
    this._clampSelection();
    this._emit();
  }

  _apply(cmd) {
    if (!this._runCommand(cmd)) return;
    this._undo.push(cmd);
    if (this._undo.length > UNDO_CAP) this._undo.shift();
    this._redo = [];
    this._afterMutation(cmd.path.barIndex);
  }

  // executes a command against the live score; records old values on the
  // command object the first time so undo/redo can replay in both directions
  _runCommand(cmd) {
    const api = this.opts.getApi();
    const at = this.opts.getAt();
    if (!api?.score || !at) return false;
    if (cmd.kind === 'appendBeat' || cmd.kind === 'insertBeat' || cmd.kind === 'deleteBeat') {
      const voice = api.score.tracks[cmd.path.trackIndex]
        ?.staves[cmd.path.staffIndex]?.bars[cmd.path.barIndex]?.voices[cmd.path.voiceIndex];
      if (!voice) return false;
      if (cmd.kind === 'appendBeat') {
        appendRestBeat(at, voice, cmd.duration);
        return true;
      }
      if (cmd.kind === 'insertBeat') {
        insertRestBeatAt(at, voice, cmd.path.beatIndex, cmd.duration);
        return true;
      }
      const snapshot = deleteBeat(voice, cmd.path.beatIndex);
      if (!snapshot) return false;
      if (!cmd.snapshot) cmd.snapshot = snapshot;
      return true;
    }
    const beat = beatAtPath(api.score, cmd.path);
    if (!beat) return false;
    switch (cmd.kind) {
      case 'setFret': {
        const { oldFret } = setFret(at, beat, cmd.string, cmd.fret);
        if (cmd.oldFret === undefined) cmd.oldFret = oldFret;
        return true;
      }
      case 'deleteNote': {
        const { oldFret } = removeNoteOnString(beat, cmd.string);
        if (cmd.oldFret === undefined) cmd.oldFret = oldFret;
        return cmd.oldFret !== null;
      }
      case 'rest': {
        const { oldNotes } = setRest(beat);
        if (!cmd.oldNotes) cmd.oldNotes = oldNotes;
        return true;
      }
      case 'duration': {
        const { oldDuration } = setBeatDuration(beat, cmd.duration);
        if (cmd.oldDuration === undefined) cmd.oldDuration = oldDuration;
        return true;
      }
      case 'dots': {
        const { oldDots } = setBeatDots(beat, cmd.dots);
        if (cmd.oldDots === undefined) cmd.oldDots = oldDots;
        return true;
      }
      case 'noteProp': {
        const result = setNoteProp(beat, cmd.string, cmd.prop, cmd.value);
        if (!result) return false;
        if (cmd.oldValue === undefined) cmd.oldValue = result.oldValue;
        return true;
      }
    }
    return false;
  }

  _invertCommand(cmd) {
    const api = this.opts.getApi();
    const at = this.opts.getAt();
    if (!api?.score || !at) return false;
    if (cmd.kind === 'appendBeat' || cmd.kind === 'insertBeat' || cmd.kind === 'deleteBeat') {
      const voice = api.score.tracks[cmd.path.trackIndex]
        ?.staves[cmd.path.staffIndex]?.bars[cmd.path.barIndex]?.voices[cmd.path.voiceIndex];
      if (!voice) return false;
      if (cmd.kind === 'deleteBeat') {
        restoreBeat(at, voice, cmd.path.beatIndex, cmd.snapshot);
        return true;
      }
      return removeBeat(voice, cmd.path.beatIndex);
    }
    const beat = beatAtPath(api.score, cmd.path);
    if (!beat) return false;
    switch (cmd.kind) {
      case 'setFret':
        if (cmd.oldFret === null) removeNoteOnString(beat, cmd.string);
        else setFret(at, beat, cmd.string, cmd.oldFret);
        return true;
      case 'deleteNote':
        if (cmd.oldFret !== null) setFret(at, beat, cmd.string, cmd.oldFret);
        return true;
      case 'rest':
        for (const n of cmd.oldNotes || []) setFret(at, beat, n.string, n.fret);
        return true;
      case 'duration':
        setBeatDuration(beat, cmd.oldDuration);
        return true;
      case 'dots':
        setBeatDots(beat, cmd.oldDots);
        return true;
      case 'noteProp':
        setNoteProp(beat, cmd.string, cmd.prop, cmd.oldValue);
        return true;
    }
    return false;
  }

  undo() {
    this._closeDigitBuffer();
    const cmd = this._undo.pop();
    if (!cmd) return;
    if (!this._invertCommand(cmd)) { this._emit(); return; }
    this._redo.push(cmd);
    this._selection = { ...cmd.path, string: cmd.string ?? this._selection?.string ?? cmd.path.string ?? 1 };
    this._clampSelection();
    this._afterMutation(cmd.path.barIndex);
  }

  redo() {
    this._closeDigitBuffer();
    const cmd = this._redo.pop();
    if (!cmd) return;
    if (!this._runCommand(cmd)) { this._emit(); return; }
    this._undo.push(cmd);
    this._selection = { ...cmd.path, string: cmd.string ?? this._selection?.string ?? cmd.path.string ?? 1 };
    this._clampSelection();
    this._afterMutation(cmd.path.barIndex);
  }

  // after undoing an append the selected beat may not exist anymore — walk
  // back to the nearest live beat in the voice, or drop the selection
  _clampSelection() {
    const api = this.opts.getApi();
    if (!api?.score || !this._selection) return;
    while (this._selection.beatIndex > 0 && !beatAtPath(api.score, this._selection)) {
      this._selection.beatIndex--;
    }
    if (!beatAtPath(api.score, this._selection)) this._selection = null;
  }

  // ---- finish + render + persistence pipeline -----------------------------

  _afterMutation(barIndex) {
    const api = this.opts.getApi();
    if (!api?.score) return;
    finalizeEdit(api.score, api.settings);
    this._scoreDirty = true;
    this._midiDirty = true;
    this._draftDirty = true;
    this._draftStatus = 'dirty';
    this._scheduleAutosave();
    this._scheduleRender(barIndex);
    this._emit();
  }

  _scheduleRender(barIndex) {
    this._renderFromBar = Math.min(this._renderFromBar, barIndex ?? 0);
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this._renderFromBar = Infinity;
      const api = this.opts.getApi();
      if (!api?.score) return;
      // scoreLoaded refires on every renderScore — arm Player's guard so the
      // mixer state is re-applied instead of rebuilt from scratch
      this.opts.beforeRender?.();
      const trackIndexes = (api.tracks || []).map(t => t.index);
      // NOTE: no RenderHints here. The 1.8.3 partial-update path
      // (firstChangedMasterBar) left the re-rendered systems blank (glyphs
      // gone, bounds fine); the plain full render is the same proven path
      // the tuning feature uses.
      api.renderScore(api.score, trackIndexes);
    }, RENDER_DEBOUNCE_MS);
  }

  // regenerate playback MIDI if edits happened since the last (re)load;
  // called by the Player right before starting playback
  refreshMidiIfDirty() {
    if (!this._midiDirty) return;
    const api = this.opts.getApi();
    if (!api) return;
    this._midiDirty = false;
    try {
      const pos = api.tickPosition;
      api.loadMidiForScore();
      if (pos > 0) api.tickPosition = pos;
    } catch (e) {}
  }

  // ---- draft persistence ---------------------------------------------------

  _scheduleAutosave() {
    clearTimeout(this._autosaveTimer);
    this._autosaveTimer = setTimeout(() => { this.saveDraft().catch(() => {}); }, AUTOSAVE_MS);
  }

  _exportBytes() {
    const api = this.opts.getApi();
    const at = this.opts.getAt();
    if (!api?.score || !at) return null;
    return exportScoreGp(at, api.score, api.settings);
  }

  async saveDraft() {
    if (!this._draftDirty || this._saving) return this._saving;
    const bytes = this._exportBytes();
    if (!bytes) return;
    this._draftStatus = 'saving';
    this._emit();
    this._saving = (async () => {
      try {
        const resp = await fetch(`${this.draftUrl}?base=${this.opts.getVersion()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes,
        });
        if (!resp.ok) throw new Error(`draft save failed (${resp.status})`);
        this._draftDirty = false;
        this._draftStatus = 'saved';
        this._draftSavedAt = Date.now();
      } catch (e) {
        this._draftStatus = 'error';
        this._scheduleAutosave(); // retry
      } finally {
        this._saving = null;
        this._emit();
      }
    })();
    return this._saving;
  }

  async flushDraft() {
    clearTimeout(this._autosaveTimer);
    if (this._saving) await this._saving;
    if (this._draftDirty) await this.saveDraft();
  }

  _beaconDraft() {
    if (!this._draftDirty) return;
    const bytes = this._exportBytes();
    if (!bytes) return;
    const url = `${this.draftUrl}?base=${this.opts.getVersion()}`;
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    // sendBeacon quota is ~64KB; larger scores fall back to keepalive fetch
    let ok = false;
    try { ok = navigator.sendBeacon(url, blob); } catch (e) {}
    if (!ok) {
      try { fetch(url, { method: 'POST', body: blob, keepalive: true }); } catch (e) {}
    }
  }

  // the visible score IS the server draft (resume flow) — nothing to save
  // until the next edit, but tuning/tempo guards apply
  markDraftLoaded() {
    this._scoreDirty = true;
    this._draftDirty = false;
    this._midiDirty = false;
    this._draftStatus = 'saved';
    this._draftSavedAt = Date.now();
    this._undo = [];
    this._redo = [];
    this._selection = null;
    this._emit();
  }

  // a version snapshot was just created from the current score — the draft
  // slot is gone and the Player is about to remount on the new version
  markSavedAsVersion() {
    clearTimeout(this._autosaveTimer);
    this._draftDirty = false;
    this._draftStatus = 'clean';
    this._emit();
  }

  // throw away the draft: delete the server slot and reload pristine bytes
  async discardDraft() {
    clearTimeout(this._autosaveTimer);
    this._draftDirty = false;
    try { await fetch(this.draftUrl, { method: 'DELETE' }); } catch (e) {}
    const api = this.opts.getApi();
    const bytes = this.opts.getPristineBytes();
    this._undo = [];
    this._redo = [];
    this._selection = null;
    this._scoreDirty = false;
    this._midiDirty = false;
    this._draftStatus = 'clean';
    this._draftSavedAt = null;
    if (api && bytes) api.load(bytes);
    this._emit();
  }

  get scoreDirty() { return this._scoreDirty; }
  get draftDirty() { return this._draftDirty; }

  // ---- React glue ----------------------------------------------------------

  _buildSnapshot() {
    const beat = this._enabled ? this.selectedBeat() : null;
    const note = beat && this._selection?.string ? noteOnString(beat, this._selection.string) : null;
    return {
      enabled: this._enabled,
      selection: this._selection ? { ...this._selection } : null,
      caret: this._enabled ? this.getCaretRect() : null,
      beatInfo: beat ? {
        duration: beat.duration,
        dots: beat.dots,
        isRest: beat.isRest,
        canDeleteBeat: beat.voice.beats.length > 1,
        hasNote: !!note,
        note: note ? {
          palmMute: !!note.isPalmMute,
          letRing: !!note.isLetRing,
          dead: !!note.isDead,
          staccato: !!note.isStaccato,
          hammerPull: !!note.isHammerPullOrigin,
          tie: !!note.isTieDestination,
          vibrato: !!note.vibrato,
        } : null,
      } : null,
      canUndo: this._undo.length > 0,
      canRedo: this._redo.length > 0,
      scoreDirty: this._scoreDirty,
      draftStatus: this._draftStatus,
      draftSavedAt: this._draftSavedAt,
      digitPending: this._digit ? this._digit.value : null,
    };
  }

  _emit() {
    this._snapshot = this._buildSnapshot();
    for (const fn of this._listeners) fn();
  }
}
