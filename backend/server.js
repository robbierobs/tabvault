const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { extractGPMeta } = require('./gpMeta');

const app = express();
const PORT = process.env.PORT || 3001;
const LIBRARY_PATH = process.env.LIBRARY_PATH || '/library';

app.use(cors());
app.use(express.json());

// Ensure library directory exists
if (!fs.existsSync(LIBRARY_PATH)) {
  fs.mkdirSync(LIBRARY_PATH, { recursive: true });
}

// Read or generate metadata sidecar for a file
function getFileMeta(filename) {
  const metaPath = path.join(LIBRARY_PATH, filename + '.meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (e) {}
  }

  // Parse and cache
  const filePath = path.join(LIBRARY_PATH, filename);
  const meta = extractGPMeta(filePath);
  if (meta) {
    try {
      fs.writeFileSync(metaPath, JSON.stringify(meta));
    } catch (e) {}
    return meta;
  }
  return { title: '', artist: '', album: '' };
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

// HQ soundfont: downloaded once from the source URL, cached inside the
// library volume so it survives container updates, then served locally.
const SOUNDFONT_CACHE = path.join(LIBRARY_PATH, '.cache', 'hq.sf2');
const HQ_SOUNDFONT_URL = process.env.HQ_SOUNDFONT_URL
  || 'https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2';
let soundfontDownload = null; // in-flight download guard

async function ensureHqSoundfont() {
  if (fs.existsSync(SOUNDFONT_CACHE)) return;
  if (!soundfontDownload) {
    soundfontDownload = (async () => {
      console.log(`Downloading HQ soundfont: ${HQ_SOUNDFONT_URL}`);
      const resp = await fetch(HQ_SOUNDFONT_URL);
      if (!resp.ok) throw new Error(`download failed (${resp.status})`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 4 || buf.toString('ascii', 0, 4) !== 'RIFF') {
        throw new Error('downloaded file is not a soundfont');
      }
      fs.mkdirSync(path.dirname(SOUNDFONT_CACHE), { recursive: true });
      fs.writeFileSync(SOUNDFONT_CACHE + '.tmp', buf);
      fs.renameSync(SOUNDFONT_CACHE + '.tmp', SOUNDFONT_CACHE);
      console.log(`HQ soundfont cached (${(buf.length / 1e6).toFixed(1)} MB)`);
    })().finally(() => { soundfontDownload = null; });
  }
  return soundfontDownload;
}

app.get('/api/soundfont/hq', async (req, res) => {
  try {
    await ensureHqSoundfont();
  } catch (e) {
    console.error('HQ soundfont error:', e.message);
    return res.status(502).json({ error: 'Could not fetch HQ soundfont: ' + e.message });
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.sendFile(path.resolve(SOUNDFONT_CACHE));
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
        return {
          name: f,
          size: stat.size,
          modified: stat.mtime,
          title: meta.title || '',
          artist: meta.artist || '',
          album: meta.album || '',
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

// Serve a specific GP file
app.get('/api/file/:filename', (req, res) => {
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
  const meta = { title: title || '', artist: artist || '', album: album || '' };
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
