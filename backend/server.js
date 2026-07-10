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
    const files = fs.readdirSync(LIBRARY_PATH)
      .filter(f => /\.(gp|gp3|gp4|gp5|gpx|gp6|gp7)$/i.test(f));

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
    const files = fs.readdirSync(LIBRARY_PATH)
      .filter(f => /\.(gp|gp3|gp4|gp5|gpx|gp6|gp7)$/i.test(f));
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
  // Arachno 1.0 was evaluated and rejected: alphaSynth renders NaN from it.
};
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
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 4 || buf.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('downloaded file is not a soundfont');
      }
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
app.get('/api/versions/:filename', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.filename);
  if (!filePath) return;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.json({ versions: readVersions(req.params.filename) });
});

// Save a new version (raw GP bytes in the body). Version numbers start at 2
// ("v1" is the original file itself).
app.post('/api/version/:filename', express.raw({ type: 'application/octet-stream', limit: '32mb' }), (req, res) => {
  const filePath = safeLibraryPath(res, req.params.filename);
  if (!filePath) return;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!req.body || req.body.length < 4) return res.status(400).json({ error: 'Empty body' });
  // Gp7Exporter output is a zip container
  if (req.body.toString('ascii', 0, 2) !== 'PK') {
    return res.status(400).json({ error: 'Body is not a .gp file' });
  }
  const versions = readVersions(req.params.filename);
  const v = versions.length ? Math.max(...versions.map(x => x.v)) + 1 : 2;
  const dir = versionsDir(req.params.filename);
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
  writeVersions(req.params.filename, versions);
  res.json(entry);
});

// Delete one version
app.delete('/api/version/:filename/:v', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.filename);
  if (!filePath) return;
  const versions = readVersions(req.params.filename);
  const v = Number(req.params.v);
  const entry = versions.find(x => x.v === v);
  if (!entry) return res.status(404).json({ error: 'Version not found' });
  const vPath = safeLibraryPath(res, '.versions', req.params.filename, entry.file);
  if (!vPath) return;
  try { fs.unlinkSync(vPath); } catch (e) {}
  writeVersions(req.params.filename, versions.filter(x => x.v !== v));
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

app.post('/api/draft/:filename', express.raw({ type: 'application/octet-stream', limit: '32mb' }), (req, res) => {
  const filePath = safeLibraryPath(res, req.params.filename);
  if (!filePath) return;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  if (!req.body || req.body.length < 4) return res.status(400).json({ error: 'Empty body' });
  if (req.body.toString('ascii', 0, 2) !== 'PK') {
    return res.status(400).json({ error: 'Body is not a .gp file' });
  }
  fs.mkdirSync(versionsDir(req.params.filename), { recursive: true });
  // tmp+rename so an interrupted autosave never truncates the previous draft
  const target = draftPath(req.params.filename);
  fs.writeFileSync(target + '.tmp', req.body);
  fs.renameSync(target + '.tmp', target);
  const meta = {
    base: Number(req.query.base) || 0,
    updatedAt: new Date().toISOString(),
    size: req.body.length,
  };
  fs.writeFileSync(draftMetaPath(req.params.filename), JSON.stringify(meta));
  res.json(meta);
});

app.get('/api/draft/:filename/meta', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.filename);
  if (!filePath) return;
  if (!fs.existsSync(draftPath(req.params.filename))) {
    return res.status(404).json({ error: 'No draft' });
  }
  try {
    res.json(JSON.parse(fs.readFileSync(draftMetaPath(req.params.filename), 'utf8')));
  } catch (e) {
    res.status(404).json({ error: 'No draft' });
  }
});

app.get('/api/draft/:filename', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.filename);
  if (!filePath) return;
  const draft = draftPath(req.params.filename);
  if (!fs.existsSync(draft)) return res.status(404).json({ error: 'No draft' });
  res.sendFile(draft);
});

app.delete('/api/draft/:filename', (req, res) => {
  const filePath = safeLibraryPath(res, req.params.filename);
  if (!filePath) return;
  try { fs.unlinkSync(draftPath(req.params.filename)); } catch (e) {}
  try { fs.unlinkSync(draftMetaPath(req.params.filename)); } catch (e) {}
  res.json({ success: true });
});

// List all GP files in library with metadata
app.get('/api/library', (req, res) => {
  scanMissing();
  try {
    const files = fs.readdirSync(LIBRARY_PATH)
      .filter(f => /\.(gp|gp3|gp4|gp5|gpx|gp6|gp7)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(LIBRARY_PATH, f));
        const meta = getFileMeta(f);
        const versions = readVersions(f);
        return {
          name: f,
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

// Serve a specific GP file; ?v=N serves a saved version instead
app.get('/api/file/:filename', (req, res) => {
  const v = Number(req.query.v) || 0;
  if (v > 0) {
    const entry = readVersions(req.params.filename).find(x => x.v === v);
    if (!entry) return res.status(404).json({ error: 'Version not found' });
    const vPath = safeLibraryPath(res, '.versions', req.params.filename, entry.file);
    if (!vPath) return;
    if (!fs.existsSync(vPath)) return res.status(404).json({ error: 'Version file missing' });
    return res.sendFile(vPath);
  }
  const filePath = path.join(LIBRARY_PATH, req.params.filename);
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
app.post('/api/file/:filename', express.raw({ type: 'application/octet-stream', limit: '32mb' }), (req, res) => {
  const filename = req.params.filename.replace(/[^a-zA-Z0-9._\- ]/g, '_');
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
app.post('/api/meta/:filename', (req, res) => {
  const filePath = path.join(LIBRARY_PATH, req.params.filename);
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
  const meta = getFileMeta(req.params.filename);
  meta.title = title || '';
  meta.artist = artist || '';
  if (album !== undefined) meta.album = album || '';
  const metaPath = filePath + '.meta.json';
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  res.json(meta);
});

// Delete a GP file and its metadata sidecar
app.delete('/api/file/:filename', (req, res) => {
  const filePath = path.join(LIBRARY_PATH, req.params.filename);
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
  try { fs.rmSync(versionsDir(req.params.filename), { recursive: true, force: true }); } catch (e) {}
  try { fs.unlinkSync(versionsSidecar(req.params.filename)); } catch (e) {}
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
