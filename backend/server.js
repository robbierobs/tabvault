const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractGPMeta, META_VERSION } = require('./gpMeta');

const app = express();
const PORT = process.env.PORT || 3001;
const LIBRARY_PATH = process.env.LIBRARY_PATH || '/library';

app.use(cors());
app.use(express.json());

// Ensure library directory exists
if (!fs.existsSync(LIBRARY_PATH)) {
  fs.mkdirSync(LIBRARY_PATH, { recursive: true });
}


// ---- Nested library helpers ---------------------------------------------
// The library may be nested (Artist/Album/file.gp7). Every API path below is
// a *relative* path inside LIBRARY_PATH, so nested files are addressed the
// same way flat files were: /api/file/Down/Welcome%20Gold.gp7
const GP_EXT = /\.(gp|gp3|gp4|gp5|gpx|gp6|gp7)$/i;

function walkLibrary(dir = LIBRARY_PATH, base = '') {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;           // .versions, .cache, dotfiles
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...walkLibrary(path.join(dir, e.name), rel));
    else if (GP_EXT.test(e.name)) out.push(rel);
  }
  return out;
}

// Artist names are inconsistent in the wild: "The Haunted", "Haunted, The",
// "the haunted". Group on a normalised key, display the most common spelling.
function artistKey(name) {
  if (!name) return '';
  let n = String(name).trim().replace(/\s+/g, ' ');
  const trailing = n.match(/^(.*?)[,]\s*(the|a|an)$/i) || n.match(/^(.*?)\s*\((the|a|an)\)$/i);
  if (trailing && trailing[1]) n = `${trailing[2]} ${trailing[1]}`;
  n = n.replace(/^\((the|a|an)\)$/i, '$1');
  return n.toLowerCase();
}

function niceCase(n) {
  return n.replace(/\b(the|a|an)\b/gi, m => m[0].toUpperCase() + m.slice(1))
          .replace(/^[a-z]/, c => c.toUpperCase());
}

// rel path -> display shelf name, computed once per scan
function buildShelves() {
  const counts = {};   // key -> { display -> count }
  for (const rel of walkLibrary()) {
    const meta = getFileMeta(rel);
    const key = artistKey(meta.artist) || artistKey(rel.split('/')[0]);
    if (!key) continue;
    counts[key] = counts[key] || {};
    const disp = meta.artist || rel.split('/')[0];
    counts[key][disp] = (counts[key][disp] || 0) + 1;
  }
  const shelves = {};
  for (const [key, variants] of Object.entries(counts)) {
    const sorted = Object.entries(variants).sort((a, b) => b[1] - a[1]);
    shelves[key] = sorted[0][0];
  }
  return shelves;
}

function shelfOf(rel, meta, shelves) {
  const key = artistKey(meta.artist) || artistKey(rel.split('/')[0]);
  return (shelves && shelves[key]) || niceCase(key) || 'Unfiled';
}


// Move a library file (and its sidecar, version index and version blobs)
// into a shelf folder. Returns the new relative path, or null on failure.
function moveFileToShelf(rel, folder) {
  const src = path.join(LIBRARY_PATH, rel);
  const dir = path.join(LIBRARY_PATH, folder);
  const target = path.join(dir, path.basename(rel));
  if (path.resolve(target) === path.resolve(src)) return rel;
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(target)) return null;          // don't overwrite, leave in place
  fs.renameSync(src, target);
  try { fs.renameSync(src + '.meta.json', target + '.meta.json'); } catch (e) {}
  try { fs.renameSync(src + '.versions.json', target + '.versions.json'); } catch (e) {}
  const vblob = path.join(LIBRARY_PATH, '.versions', rel);
  if (fs.existsSync(vblob)) {
    fs.mkdirSync(path.join(LIBRARY_PATH, '.versions', folder), { recursive: true });
    try { fs.renameSync(vblob, path.join(LIBRARY_PATH, '.versions', folder, path.basename(rel))); } catch (e) {}
  }
  return folder + '/' + path.basename(rel);
}

// Remove a directory if it is empty (including one left with only dot files)
function pruneEmpty(dir) {
  try {
    const entries = fs.readdirSync(dir).filter(n => !n.startsWith('.'));
    if (!entries.length) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
}

function deleteFile(rel) {
  const filePath = path.join(LIBRARY_PATH, rel);
  try { fs.unlinkSync(filePath); } catch (e) { return false; }
  try { fs.unlinkSync(filePath + '.meta.json'); } catch (e) {}
  try { fs.unlinkSync(filePath + '.versions.json'); } catch (e) {}
  try { fs.rmSync(path.join(LIBRARY_PATH, '.versions', rel), { recursive: true, force: true }); } catch (e) {}
  // an artist folder under .versions that now holds nothing is dead weight
  if (rel.includes('/')) {
    const top = path.join(LIBRARY_PATH, '.versions', rel.split('/')[0]);
    try { if (fs.existsSync(top) && fs.readdirSync(top).length === 0) fs.rmdirSync(top); } catch (e) {}
  }
  return true;
}

// Read or generate metadata sidecar for a file. Sidecars older than
// META_VERSION are re-extracted (adds tuning etc.) while keeping any
// manually edited title/artist/album.
function getFileMeta(filename) {
  const metaPath = path.join(LIBRARY_PATH, filename + '.meta.json');
  let existing = null;
  if (fs.existsSync(metaPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {}
    if (existing && existing.v >= META_VERSION) return existing;
  }

  const filePath = path.join(LIBRARY_PATH, filename);
  const meta = extractGPMeta(filePath)
    || { v: META_VERSION, title: '', artist: '', album: '', tuning: null, trackCount: 0 };
  if (existing) {
    // older sidecars may carry manual edits — those win over re-extraction
    if (existing.title) meta.title = existing.title;
    if (existing.artist) meta.artist = existing.artist;
    if (existing.album) meta.album = existing.album;
  }
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  } catch (e) {}
  return meta;
}

// Scan all files on startup and generate missing meta
function scanLibrary() {
  try {
    const files = walkLibrary();

    for (const f of files) {
      const metaPath = path.join(LIBRARY_PATH, f + '.meta.json');
      if (!fs.existsSync(metaPath)) {
        console.log(`Scanning metadata: ${f}`);
        getFileMeta(f);
      }
    }
    console.log(`Library scan complete: ${files.length} files`);
  } catch (e) {
    console.error('Library scan error:', e.message);
  }
}

// Multer config for GP file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LIBRARY_PATH),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\- ]/g, '_');
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.gp6', '.gp7'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only Guitar Pro files are allowed'));
  }
});

// Scan for any files missing metadata sidecars
function scanMissing() {
  try {
    const files = walkLibrary();
    for (const f of files) {
      const metaPath = path.join(LIBRARY_PATH, f + '.meta.json');
      if (!fs.existsSync(metaPath)) {
        setImmediate(() => {
          console.log(`Scanning metadata: ${f}`);
          getFileMeta(f);
        });
      }
    }
  } catch (e) {}
}

// Sound banks: each is downloaded once from its source URL, cached inside
// the library volume so it survives container updates, then served locally.
// SF2 and SF3 (vorbis-compressed) both use the RIFF container alphaTab reads.
const SOUNDFONTS = {
  hq: {
    url: process.env.HQ_SOUNDFONT_URL
      || 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2',
    file: 'hq.sf2',
  },
  musescore: {
    url: process.env.MUSESCORE_SOUNDFONT_URL
      || 'https://ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/MuseScore_General.sf3',
    file: 'musescore.sf3',
  },
  // alphaSynth (through 1.9.0-alpha.1860) renders pure NaN from Arachno's
  // stereo-linked PCM sample pairs (shdr types 2/4 + sampleLink). Rewriting
  // the pairs as mono samples fixes playback — the L/R zones and their pan
  // generators are untouched, so the stereo image survives via panning.
  arachno: {
    url: process.env.ARACHNO_SOUNDFONT_URL
      || 'https://archive.org/download/free-soundfonts-sf2-2019-04/Arachno_SoundFont_Version_1.0.sf2',
    file: 'arachno.sf2',
    sanitize: monoizeStereoSamples,
  },
};

// Rewrite stereo-linked sample headers (type 2 = right, 4 = left) as mono
// and clear their sampleLink. Walks the RIFF tree to find pdta/shdr —
// searching bytes would false-positive inside the PCM sample data.
function monoizeStereoSamples(buf) {
  let shdr = null;
  const walk = (off, end) => {
    while (off + 8 <= end) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'RIFF' || id === 'LIST') walk(body + 4, body + size);
      else if (id === 'shdr') shdr = { off: body, size };
      off = body + size + (size % 2);
    }
  };
  walk(0, buf.length);
  if (!shdr) return buf;
  let touched = 0;
  for (let o = shdr.off; o + 46 <= shdr.off + shdr.size; o += 46) {
    const type = buf.readUInt16LE(o + 44);
    if (type === 2 || type === 4) {
      buf.writeUInt16LE(0, o + 42); // sampleLink
      buf.writeUInt16LE(1, o + 44); // type -> mono
      touched++;
    }
  }
  if (touched) console.log(`Sanitized ${touched} stereo-linked samples to mono`);
  return buf;
}
const soundfontDownloads = {}; // id -> in-flight download guard

async function ensureSoundfont(id) {
  const bank = SOUNDFONTS[id];
  const cachePath = path.join(LIBRARY_PATH, '.cache', bank.file);
  if (fs.existsSync(cachePath)) return cachePath;
  if (!soundfontDownloads[id]) {
    soundfontDownloads[id] = (async () => {
      console.log(`Downloading soundfont ${id}: ${bank.url}`);
      const resp = await fetch(bank.url);
      if (!resp.ok) throw new Error(`download failed (${resp.status})`);
      let buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 4 || buf.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('downloaded file is not a soundfont');
      }
      if (bank.sanitize) buf = bank.sanitize(buf);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath + '.tmp', buf);
      fs.renameSync(cachePath + '.tmp', cachePath);
      console.log(`Soundfont ${id} cached (${(buf.length / 1e6).toFixed(1)} MB)`);
    })().finally(() => { soundfontDownloads[id] = null; });
  }
  await soundfontDownloads[id];
  return cachePath;
}

app.get('/api/soundfont/:id', async (req, res) => {
  const id = req.params.id;
  if (!SOUNDFONTS[id]) return res.status(404).json({ error: 'Unknown sound bank' });
  let cachePath;
  try {
    cachePath = await ensureSoundfont(id);
  } catch (e) {
    console.error(`Soundfont ${id} error:`, e.message);
    return res.status(502).json({ error: `Could not fetch soundfont: ${e.message}` });
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(path.resolve(cachePath));
});

// ---- File versions: edits (e.g. tempo changes) are saved as new .gp files
// under .versions/<original>/vN.gp; the original is never modified. A
// <original>.versions.json sidecar tracks the list (invisible to the
// library scan, like .meta.json).
function versionsDir(filename) {
  return path.join(LIBRARY_PATH, '.versions', filename);
}
function versionsSidecar(filename) {
  return path.join(LIBRARY_PATH, filename + '.versions.json');
}
function readVersions(filename) {
  try {
    const data = JSON.parse(fs.readFileSync(versionsSidecar(filename), 'utf8'));
    if (Array.isArray(data.versions)) return data.versions;
  } catch (e) {}
  return [];
}
function writeVersions(filename, versions) {
  fs.writeFileSync(versionsSidecar(filename), JSON.stringify({ versions }));
}
// resolve-and-contain check used by all version routes
function safeLibraryPath(res, ...parts) {
  const resolved = path.resolve(path.join(LIBRARY_PATH, ...parts));
  if (!resolved.startsWith(path.resolve(LIBRARY_PATH))) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return resolved;
}

// List versions of a file
app.get('/api/versions/:path(.*)', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.path);
  if (!filePath) return;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.json({ versions: readVersions(req.params.path) });
});

// Save a new version (raw GP bytes in the body). Version numbers start at 2
// ("v1" is the original file itself).
app.post('/api/version/:path(.*)', express.raw({ type: 'application/octet-stream', limit: '32mb' }), (req, res) => {
  const filePath = safeLibraryPath(res, req.params.path);
  if (!filePath) return;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!req.body || req.body.length < 4) return res.status(400).json({ error: 'Empty body' });
  // Gp7Exporter output is a zip container
  if (req.body.toString('ascii', 0, 2) !== 'PK') {
    return res.status(400).json({ error: 'Body is not a .gp file' });
  }
  const versions = readVersions(req.params.path);
  const v = versions.length ? Math.max(...versions.map(x => x.v)) + 1 : 2;
  const dir = versionsDir(req.params.path);
  fs.mkdirSync(dir, { recursive: true });
  const file = `v${v}.gp`;
  fs.writeFileSync(path.join(dir, file), req.body);
  const entry = {
    v,
    file,
    label: (req.query.label || `v${v}`).toString().slice(0, 80),
    tempo: req.query.tempo ? Number(req.query.tempo) : undefined,
    createdAt: new Date().toISOString(),
    size: req.body.length,
  };
  versions.push(entry);
  writeVersions(req.params.path, versions);
  res.json(entry);
});

// Delete one version
// DELETE /api/version/<path>/<v>  — the trailing segment is the version number
app.delete('/api/version/:path(.*)', (req, res) => {
  const segments = String(req.params.path).split('/');
  const v = Number(segments.pop());
  const rel = segments.join('/');
  const filePath = safeLibraryPath(res, rel);
  if (!filePath) return;
  const versions = readVersions(rel);
  const entry = versions.find(x => x.v === v);
  if (!entry) return res.status(404).json({ error: 'Version not found' });
  const vPath = safeLibraryPath(res, '.versions', rel, entry.file);
  if (!vPath) return;
  try { fs.unlinkSync(vPath); } catch (e) {}
  writeVersions(rel, versions.filter(x => x.v !== v));
  res.json({ success: true });
});

// ---- Draft slot: edit mode autosaves the in-progress score here. One draft
// per file, stored inside .versions/<file>/ so it's invisible to the library
// scan and cleaned up by DELETE /api/file. Promoting a draft to a permanent
// version goes through the normal POST /api/version.
function draftPath(filename) {
  return path.join(versionsDir(filename), 'draft.gp');
}
function draftMetaPath(filename) {
  return path.join(versionsDir(filename), 'draft.json');
}

app.post('/api/draft/:path(.*)', express.raw({ type: 'application/octet-stream', limit: '32mb' }), (req, res) => {
  const filePath = safeLibraryPath(res, req.params.path);
  if (!filePath) return;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!req.body || req.body.length < 4) return res.status(400).json({ error: 'Empty body' });
  if (req.body.toString('ascii', 0, 2) !== 'PK') {
    return res.status(400).json({ error: 'Body is not a .gp file' });
  }
  fs.mkdirSync(versionsDir(req.params.path), { recursive: true });
  // tmp+rename so an interrupted autosave never truncates the previous draft
  const target = draftPath(req.params.path);
  fs.writeFileSync(target + '.tmp', req.body);
  fs.renameSync(target + '.tmp', target);
  const meta = {
    base: Number(req.query.base) || 0,
    updatedAt: new Date().toISOString(),
    size: req.body.length,
  };
  fs.writeFileSync(draftMetaPath(req.params.path), JSON.stringify(meta));
  res.json(meta);
});

app.get('/api/draft/:path(.*)/meta', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.path);
  if (!filePath) return;
  if (!fs.existsSync(draftPath(req.params.path))) {
    return res.status(404).json({ error: 'No draft' });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(draftMetaPath(req.params.path), 'utf8')));
  } catch (e) {
    res.status(404).json({ error: 'No draft' });
  }
});

app.get('/api/draft/:path(.*)', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.path);
  if (!filePath) return;
  const draft = draftPath(req.params.path);
  if (!fs.existsSync(draft)) return res.status(404).json({ error: 'No draft' });
  res.sendFile(draft);
});

app.delete('/api/draft/:path(.*)', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.path);
  if (!filePath) return;
  try { fs.unlinkSync(draftPath(req.params.path)); } catch (e) {}
  try { fs.unlinkSync(draftMetaPath(req.params.path)); } catch (e) {}
  res.json({ success: true });
});

// List all GP files in library with metadata
app.get('/api/library', (req, res) => {
  scanMissing();
  try {
    const shelves = buildShelves();
    const files = walkLibrary().map(rel => {
        const stat = fs.statSync(path.join(LIBRARY_PATH, rel));
        const meta = getFileMeta(rel);
        const versions = readVersions(rel);
        return {
          name: rel,          // full library-relative path (API key)
          path: rel,
          basename: path.basename(rel),
          folder: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '',
          group: shelfOf(rel, meta, shelves),
          size: stat.size,
          modified: stat.mtime,
          title: meta.title || '',
          artist: meta.artist || '',
          album: meta.album || '',
          tuning: meta.tuning || null,
          trackCount: meta.trackCount || 0,
          latestVersion: versions.length ? Math.max(...versions.map(x => x.v)) : 0,
        };
      })
      .sort((a, b) => {
        // Sort by title if available, otherwise filename
        const aName = a.title || a.name;
        const bName = b.title || b.name;
        return aName.localeCompare(bName);
      });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ---- Artist shelves --------------------------------------------------------
// Count of files per artist shelf, for the sidebar group headers.
app.get('/api/artists', (req, res) => {
  const shelves = buildShelves();
  const counts = {};
  for (const rel of walkLibrary()) {
    const g = shelfOf(rel, getFileMeta(rel), shelves);
    counts[g] = (counts[g] || 0) + 1;
  }
  res.json(Object.entries(counts)
    .map(([artist, count]) => ({ artist, count }))
    .sort((a, b) => a.artist.localeCompare(b.artist)));
});

// One-off (or repeated) pass that shelves every loose file into a folder
// named after its artist. Byte-identical collisions are merged, different
// content is kept side by side as "... (2).gp7".
app.post('/api/organize', (req, res) => {
  const moved = [], skipped = [], deduped = [];
  const crypto = require('crypto');
  const hash = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
  const shelves = buildShelves();
  const emptied = new Set();

  // Every file - flat at the root or already in a folder - should live in the
  // folder named after its artist. Re-shelve anything that drifted (e.g. the
  // artist was corrected in the metadata after the folder was created).
  for (const rel of walkLibrary()) {
    const meta = getFileMeta(rel);
    const folder = shelfOf(rel, meta, shelves);
    const current = rel.includes('/') ? rel.split('/')[0] : '';
    if (!folder) { skipped.push(rel); continue; }
    if (folder === current) continue;

    const target = path.join(LIBRARY_PATH, folder, path.basename(rel));
    if (fs.existsSync(target)) {
      if (hash(path.join(LIBRARY_PATH, rel)) === hash(target)) {
        deleteFile(rel);
        deduped.push(rel);
      } else {
        const alt = path.join(LIBRARY_PATH, folder,
          path.basename(rel).replace(/\.(gp\w*)$/i, ' (2).' + path.extname(rel)));
        if (fs.existsSync(alt)) { skipped.push(rel); continue; }
        fs.renameSync(path.join(LIBRARY_PATH, rel), alt);
        moved.push({ from: rel, to: folder + '/' + path.basename(alt) });
      }
    } else {
      const to = moveFileToShelf(rel, folder);
      if (to) moved.push({ from: rel, to });
      else skipped.push(rel);
    }
    if (current) emptied.add(current);
  }
  for (const d of emptied) pruneEmpty(path.join(LIBRARY_PATH, d));
  // metadata sidecars left at the root (from a flat library): file them under
  // their artist, merging into an existing sidecar rather than losing edits.
  for (const name of fs.readdirSync(LIBRARY_PATH)) {
    if (!name.endsWith('.meta.json') || name.startsWith('.')) continue;
    try {
      const rootMeta = JSON.parse(fs.readFileSync(path.join(LIBRARY_PATH, name), 'utf8'));
      const stem = name.replace(/\.meta\.json$/, '');
      const folder = shelfOf(stem, rootMeta, buildShelves());
      const dir = path.join(LIBRARY_PATH, folder);
      if (!fs.existsSync(dir) || !fs.existsSync(path.join(dir, stem))) continue;
      const target = path.join(dir, name);
      if (fs.existsSync(target)) {
        const cur = JSON.parse(fs.readFileSync(target, 'utf8'));
        for (const k of ['title', 'artist', 'album', 'notes', 'tags', 'favorite']) {
          if (!cur[k] && rootMeta[k]) cur[k] = rootMeta[k];
        }
        fs.writeFileSync(target, JSON.stringify(cur, null, 2));
      } else {
        fs.renameSync(path.join(LIBRARY_PATH, name), target);
      }
      fs.unlinkSync(path.join(LIBRARY_PATH, name));
    } catch (err) {}
  }
  // remove artist folders that ended up empty
  for (const e of fs.readdirSync(LIBRARY_PATH, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) {
      const leftover = walkLibrary(path.join(LIBRARY_PATH, e.name));
      const stray = fs.readdirSync(path.join(LIBRARY_PATH, e.name))
        .filter(n => GP_EXT.test(n));
      if (leftover.length === 0 && stray.length === 0) {
        try { fs.rmSync(path.join(LIBRARY_PATH, e.name), { recursive: true, force: true }); } catch (err) {}
      }
    }
  }
  res.json({ moved, deduped, skipped, folders: fs.readdirSync(LIBRARY_PATH).filter(n => !n.startsWith('.') && fs.statSync(path.join(LIBRARY_PATH, n)).isDirectory()) });
});

// Bulk delete: POST { paths: ["Down/Welcome Gold.gp7", "Crypta/Kali.gp7"] }
app.post('/api/files/delete', (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths
              : Array.isArray(req.body.files) ? req.body.files : [];
  const deleted = [], failed = [];
  for (const rel of paths) {
    const abs = safeLibraryPath(res, rel);
    if (!abs) return;
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { failed.push(rel); continue; }
    deleteFile(rel);
    deleted.push(rel);
  }
  // prune an artist folder left empty
  for (const rel of deleted) {
    if (rel.includes('/')) {
      const top = rel.split('/')[0];
      const dir = path.join(LIBRARY_PATH, top);
      const gp = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => GP_EXT.test(n)) : [];
      if (gp.length === 0) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
      }
    }
  }
  res.json({ deleted, failed, count: deleted.length });
});

// Serve a specific GP file; ?v=N serves a saved version instead
app.get('/api/file/:path(.*)', (req, res) => {
  const v = Number(req.query.v) || 0;
  if (v > 0) {
    const entry = readVersions(req.params.path).find(x => x.v === v);
    if (!entry) return res.status(404).json({ error: 'Version not found' });
    const vPath = safeLibraryPath(res, '.versions', req.params.path, entry.file);
    if (!vPath) return;
    if (!fs.existsSync(vPath)) return res.status(404).json({ error: 'Version file missing' });
    return res.sendFile(vPath);
  }
  const filePath = safeLibraryPath(res, req.params.path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const resolved = path.resolve(filePath);
  const libraryResolved = path.resolve(LIBRARY_PATH);
  if (!resolved.startsWith(libraryResolved)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  res.sendFile(resolved);
});

// Create a brand-new GP file (raw .gp bytes in the body) — the "new song"
// flow. Unlike /api/upload (multipart of an existing file) this refuses to
// overwrite: creating twice with the same name is a conflict.
app.post('/api/file/:path(.*)', express.raw({ type: 'application/octet-stream', limit: '32mb' }), (req, res) => {
  const filename = req.params.path.replace(/[^a-zA-Z0-9._\- ]/g, '_');
  if (!/\.(gp)$/i.test(filename)) {
    return res.status(400).json({ error: 'Filename must end in .gp' });
  }
  const filePath = safeLibraryPath(res, filename);
  if (!filePath) return;
  if (fs.existsSync(filePath)) return res.status(409).json({ error: 'File already exists' });
  if (!req.body || req.body.length < 4) return res.status(400).json({ error: 'Empty body' });
  if (req.body.toString('ascii', 0, 2) !== 'PK') {
    return res.status(400).json({ error: 'Body is not a .gp file' });
  }
  fs.writeFileSync(filePath + '.tmp', req.body);
  fs.renameSync(filePath + '.tmp', filePath);
  const meta = getFileMeta(filename);
  res.json({
    name: filename,
    size: req.body.length,
    modified: new Date().toISOString(),
    title: meta.title || '',
    artist: meta.artist || '',
    album: meta.album || '',
    tuning: meta.tuning || null,
    trackCount: meta.trackCount || 0,
    latestVersion: 0,
  });
});

// Upload a GP file and immediately extract metadata
app.post('/api/upload', upload.single('file'), (req, res) => {
  let rel = req.file.filename;
  const explicit = (req.body.artist || req.body.folder || '').trim();
  if (explicit) {
    const folder = niceCase(artistKey(explicit)) || explicit;
    const dest = path.join(LIBRARY_PATH, folder);
    fs.mkdirSync(dest, { recursive: true });
    const target = path.join(dest, req.file.filename);
    fs.renameSync(path.join(LIBRARY_PATH, req.file.filename), target);
    const sidecar = path.join(LIBRARY_PATH, req.file.filename + '.meta.json');
    if (fs.existsSync(sidecar)) fs.renameSync(sidecar, target + '.meta.json');
    rel = folder + '/' + req.file.filename;
  }

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  // Extract metadata right away
  const meta = getFileMeta(req.file.filename);
  res.json({
    name: req.file.filename,
    size: req.file.size,
    title: meta.title || '',
    artist: meta.artist || '',
    album: meta.album || '',
  });
});

// Update metadata for a file
app.post('/api/meta/:path(.*)', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.path);
  const resolved = path.resolve(filePath);
  const libraryResolved = path.resolve(LIBRARY_PATH);
  if (!resolved.startsWith(libraryResolved)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  const { title, artist, album } = req.body;
  // merge into the existing sidecar so extracted fields (tuning, ...) survive
  const meta = getFileMeta(req.params.path);
  // only overwrite fields the client actually sent, so a partial edit (artist
  // only) does not blank the title/album that were extracted from the tab
  if (title !== undefined) meta.title = title || '';
  if (artist !== undefined) meta.artist = artist || '';
  if (album !== undefined) meta.album = album || '';
  const metaPath = filePath + '.meta.json';
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  // keep the folder layout in sync with the artist we just wrote
  const shelves = buildShelves();
  const want = shelfOf(req.params.path, meta, shelves);
  const current = req.params.path.includes('/') ? req.params.path.split('/')[0] : '';
  let newPath = req.params.path;
  if (want && want !== current) {
    const moved = moveFileToShelf(req.params.path, want);
    if (moved) {
      pruneEmpty(path.join(LIBRARY_PATH, current || ''));
      newPath = moved;
    }
  }
  res.json({ ...meta, path: newPath });
});

// Delete a GP file and its metadata sidecar
app.delete('/api/file/:path(.*)', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.path);
  const resolved = path.resolve(filePath);
  const libraryResolved = path.resolve(LIBRARY_PATH);
  if (!resolved.startsWith(libraryResolved)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  fs.unlinkSync(filePath);
  // Also delete meta sidecar if exists
  const metaPath = filePath + '.meta.json';
  if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  // And any saved versions
  try { fs.rmSync(versionsDir(req.params.path), { recursive: true, force: true }); } catch (e) {}
  try { fs.unlinkSync(versionsSidecar(req.params.path)); } catch (e) {}
  res.json({ success: true });
});

// Serve frontend static files in production
app.use((req, res, next) => {
  if (req.path.endsWith('.mjs')) {
    res.setHeader('Content-Type', 'application/javascript');
  }
  next();
});
express.static.mime.define({ 'application/javascript': ['mjs'] });
app.use(express.static('/app/frontend/dist'));
app.get('*', (req, res) => {
  if (req.path.match(/\.(mjs|js|css|png|ico|svg|woff2?)$/)) {
    return res.status(404).send('Not found');
  }
  res.sendFile('/app/frontend/dist/index.html');
});

app.listen(PORT, () => {
  console.log(`GP Player server running on port ${PORT}`);
  console.log(`Library path: ${LIBRARY_PATH}`);
  // Scan library for metadata on startup
  scanLibrary();
});
