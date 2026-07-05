// Audio/visual sync compensation.
//
// alphaTab places the beat/bar cursor from "samples consumed by the audio
// graph", which ignores everything after the WebAudio destination (OS mixer,
// Bluetooth, ...). With a laggy output chain the cursor runs AHEAD of what
// you hear. This module wraps alphaTab's default cursor handler:
//   offset > 0  -> every cursor placement is postponed by that many ms
//                  (cursor waits for late audio)
//   offset < 0  -> the animated sweep is pre-advanced along its own
//                  interpolation (cursor runs ahead, for when the sound
//                  feels early relative to the cursor)

export const AV_SYNC_KEY = 'tabvault-av-sync-ms';
export const AV_SYNC_MIN = -200;
export const AV_SYNC_MAX = 500;

export function loadAvSync() {
  try {
    const v = parseInt(localStorage.getItem(AV_SYNC_KEY), 10);
    if (Number.isFinite(v)) return Math.max(AV_SYNC_MIN, Math.min(AV_SYNC_MAX, v));
  } catch (e) {}
  return 0;
}

export function saveAvSync(ms) {
  try { localStorage.setItem(AV_SYNC_KEY, String(ms)); } catch (e) {}
}

// Reads the audio output latency the browser reports for this device.
// Chrome/Firefox expose outputLatency (the post-WebAudio chain); Safari only
// baseLatency. Returns milliseconds, or null if nothing is reported.
export async function detectOutputLatency() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  try {
    await ctx.resume().catch(() => {});
    await new Promise(r => setTimeout(r, 150)); // outputLatency settles after start
    const seconds = (ctx.baseLatency || 0) + (ctx.outputLatency || 0);
    const ms = Math.round(seconds * 1000);
    return ms > 0 ? Math.min(AV_SYNC_MAX, ms) : null;
  } finally {
    ctx.close().catch(() => {});
  }
}

const TO_NEXT_BEAT = 1; // MidiTickLookupFindBeatResultCursorMode.ToNextBext

// Replicates alphaTab's ToNextBeatAnimatingCursorHandler with a time shift.
// getOffset() is read at call time so the slider applies immediately;
// isPlaying() gates the delay so seeks while paused stay instant.
export function createSyncedCursorHandler(getOffset, isPlaying) {
  const timers = new Set();

  const schedule = (fn) => {
    const off = getOffset();
    if (off <= 0 || !isPlaying()) { fn(); return; }
    const id = setTimeout(() => { timers.delete(id); fn(); }, off);
    timers.add(id);
  };

  return {
    // cancel queued placements (call on pause/stop/seek so stale positions
    // don't land after the final immediate placement)
    clearPending() {
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
    onAttach() {},
    onDetach() { this.clearPending(); },
    placeBarCursor(barCursor, beatBounds) {
      schedule(() => {
        const b = beatBounds.barBounds.masterBarBounds.visualBounds;
        barCursor.setBounds(b.x, b.y, b.w, b.h);
      });
    },
    placeBeatCursor(beatCursor, beatBounds, startBeatX) {
      schedule(() => {
        const b = beatBounds.barBounds.masterBarBounds.visualBounds;
        beatCursor.transitionToX(0, startBeatX);
        beatCursor.setBounds(startBeatX, b.y, 1, b.h);
      });
    },
    transitionBeatCursor(beatCursor, beatBounds, startBeatX, nextBeatX, duration, cursorMode) {
      const factor = cursorMode === TO_NEXT_BEAT ? 2 : 1;
      const targetX = startBeatX + (nextBeatX - startBeatX) * factor;
      const dur = duration * factor;
      const off = getOffset();

      if (off < 0 && isPlaying() && dur > 0) {
        // jump forward along the sweep by |off| ms, then finish the rest
        const adv = Math.min(-off, dur);
        const jumpX = startBeatX + (targetX - startBeatX) * (adv / dur);
        beatCursor.transitionToX(0, jumpX);
        beatCursor.transitionToX(dur - adv, targetX);
        return;
      }
      schedule(() => beatCursor.transitionToX(dur, targetX));
    },
  };
}
