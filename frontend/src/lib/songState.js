// Per-song practice state, persisted per browser. One localStorage entry per
// file: speed, loop region, ramp config, tuning override, mixer, visible track.

const keyFor = (fileName) => `tabvault-song:${fileName}`;

export function loadSongState(fileName) {
  try {
    const raw = localStorage.getItem(keyFor(fileName));
    if (!raw) return null;
    const state = JSON.parse(raw);
    return state && typeof state === 'object' ? state : null;
  } catch (e) {
    return null;
  }
}

export function saveSongState(fileName, state) {
  try {
    localStorage.setItem(keyFor(fileName), JSON.stringify(state));
  } catch (e) {}
}
