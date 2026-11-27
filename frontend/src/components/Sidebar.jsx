import React, { useState, useEffect, useRef } from 'react';
import styles from './Sidebar.module.css';
import { tuningLabel } from '../lib/tuning.js';
import { createEmptyScore, suggestFilename } from '../lib/newSong.js';
import { exportScoreGp } from '../lib/editing.js';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatName(name) {
  return name.replace(/\.(gp|gp3|gp4|gp5|gpx|gp6|gp7)$/i, '');
}

function getDisplayTitle(file, metaCache) {
  // Prefer backend metadata, then frontend cache, then filename
  if (file.title) return file.title;
  if (metaCache[file.path]?.title) return metaCache[file.path].title;
  return formatName(file.basename || file.name);
}

function getDisplayArtist(file, metaCache) {
  if (file.artist) return file.artist;
  if (metaCache[file.path]?.artist) return metaCache[file.path].artist;
  return null;
}

export default function Sidebar({ open, onToggle, selectedFile, onFileSelect, metaCache = {} }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef();
  const firstLoadRef = useRef(true);

  // Artist shelves: 'artist' groups by artist, 'flat' is the plain list
  const [view, setView] = useState('artist');
  const [selected, setSelected] = useState(() => new Set());
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [organizing, setOrganizing] = useState(false);
  const [editingFile, setEditingFile] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editArtist, setEditArtist] = useState('');

  // "New song": build a blank score client-side and save it to the library
  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newArtist, setNewArtist] = useState('');
  const [newTempo, setNewTempo] = useState('120');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const handleCreateSong = async () => {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    setCreateError(null);
    try {
      const mod = await import('@coderline/alphatab');
      const at = mod.alphaTab ?? mod.default ?? mod;
      const score = createEmptyScore(at, {
        title,
        artist: newArtist.trim(),
        tempo: parseInt(newTempo, 10) || 120,
      });
      const bytes = exportScoreGp(at, score, new at.Settings());
      const resp = await fetch(`/api/file/${encodeURIComponent(suggestFilename(title))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Create failed (${resp.status})`);
      }
      const entry = await resp.json();
      setNewOpen(false);
      setNewTitle('');
      setNewArtist('');
      await fetchLibrary();
      onFileSelect(entry);
    } catch (e) {
      setCreateError(e.message || String(e));
    } finally {
      setCreating(false);
    }
  };

  const fetchLibrary = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/library');
      if (!res.ok) throw new Error('Failed to load library');
      const data = await res.json();
      setFiles(data);
      // Artist view opens folded: scan the artist names, then open one.
      if (firstLoadRef.current) {
        firstLoadRef.current = false;
        if (view === 'artist') {
          setCollapsed(new Set(data.map(f => f.group || f.artist || 'Unfiled')));
        }
      }
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchLibrary(); }, []);

  // Artist view starts with every shelf folded flat — the headers carry the
  // counts, so you scan the artists first and open the one you want.
  const shelfNames = () =>
    Array.from(new Set(files.map(f => f.group || f.artist || 'Unfiled')));

  const switchView = (mode) => {
    setView(mode);
    setCollapsed(mode === 'artist' ? new Set(shelfNames()) : new Set());
  };

  const collapseAll = () => setCollapsed(new Set(shelfNames()));
  const expandAll = () => setCollapsed(new Set());

  const handleUpload = async (fileList) => {
    const gpFiles = Array.from(fileList).filter(f =>
      /\.(gp|gp3|gp4|gp5|gpx|gp6|gp7)$/i.test(f.name)
    );
    if (!gpFiles.length) return;
    setUploading(true);
    try {
      await Promise.all(gpFiles.map(f => {
        const fd = new FormData();
        fd.append('file', f);
        return fetch('/api/upload', { method: 'POST', body: fd });
      }));
      await fetchLibrary();
    } catch (e) {
      console.error('Upload failed', e);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (e, file) => {
    e.stopPropagation();
    const title = getDisplayTitle(file, metaCache);
    if (!confirm(`Delete "${title}"?`)) return;
    await fetch(`/api/file/${encodeURIComponent(file.name)}`, { method: 'DELETE' });
    if (selectedFile?.name === file.name) onFileSelect(null);
    fetchLibrary();
  };

  const handleEditSave = async (file) => {
    try {
      const res = await fetch(`/api/meta/${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: editTitle, artist: editArtist }),
      });
      if (res.ok) {
        const saved = await res.json().catch(() => ({}));
        // the backend may have moved the file into the artist's folder
        if (saved.path && saved.path !== (file.path || file.name)) {
          if (selectedFile && (selectedFile.path || selectedFile.name) === file.name) {
            onFileSelect({ ...selectedFile, name: saved.path, path: saved.path,
                           title: saved.title, artist: saved.artist });
          }
          fetchLibrary();
        } else {
          setFiles(fs => fs.map(f => (f.path || f.name) === (file.path || file.name)
            ? { ...f, title: editTitle, artist: editArtist }
            : f
          ));
        }
      }
    } catch (e) {
      console.error('Save meta failed', e);
    }
    setEditingFile(null);
  };

  const toggleSelect = (key) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
    setBulkConfirm(false);
  };

  const selectShelf = (shelfFiles) => {
    const keys = shelfFiles.map(f => f.path || f.name);
    setSelected(prev => {
      const next = new Set(prev);
      const allSelected = keys.every(k => next.has(k));
      if (allSelected) keys.forEach(k => next.delete(k));
      else keys.forEach(k => next.add(k));
      return next;
    });
    setBulkConfirm(false);
  };

  const handleOrganize = async () => {
    setOrganizing(true);
    try {
      const res = await fetch('/api/organize', { method: 'POST' });
      const data = await res.json();
      console.log('organize:', data);
      await fetchLibrary();
    } catch (e) {
      console.error('Organize failed', e);
    }
    setOrganizing(false);
  };

  const handleBulkDelete = async () => {
    // two-click confirm: first click arms, second deletes
    if (!bulkConfirm) {
      setBulkConfirm(true);
      setTimeout(() => setBulkConfirm(false), 5000);
      return;
    }
    const paths = [...selected];
    setBulkConfirm(false);
    try {
      const res = await fetch('/api/files/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: paths }),
      });
      const data = await res.json();
      console.log('bulk delete:', data);
      setSelected(new Set());
      if (selectedFile && paths.includes(selectedFile.path || selectedFile.name)) onFileSelect(null);
      await fetchLibrary();
    } catch (e) {
      console.error('Bulk delete failed', e);
    }
  };

  const filtered = files.filter(f => {
    const q = search.toLowerCase();
    const title = getDisplayTitle(f, metaCache).toLowerCase();
    const artist = (getDisplayArtist(f, metaCache) || '').toLowerCase();
    const tuning = (f.tuning ? tuningLabel(f.tuning) || '' : '').toLowerCase();
    return (
      f.name.toLowerCase().includes(q) ||
      title.includes(q) ||
      artist.includes(q) ||
      tuning.includes(q)
    );
  });

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    handleUpload(e.dataTransfer.files);
  };

  const renderFile = (file) => {
    const title = getDisplayTitle(file, metaCache);
    const artist = getDisplayArtist(file, metaCache);
    const key = file.path || file.name;
    return (
      <div key={key}>
        {editingFile === key ? (
          <div className={styles.editForm}>
            <input className={styles.editInput} value={editTitle} onChange={e => setEditTitle(e.target.value)} placeholder="Title" autoFocus />
            <input className={styles.editInput} value={editArtist} onChange={e => setEditArtist(e.target.value)} placeholder="Artist" />
            <div className={styles.editButtons}>
              <button className={styles.editSave} onClick={() => handleEditSave(file)}>Save</button>
              <button className={styles.editCancel} onClick={() => setEditingFile(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div
            className={`${styles.fileItem} ${selectedFile?.name === file.name ? styles.active : ''} ${selected.has(key) ? styles.selectedRow : ''}`}
            onClick={() => onFileSelect(file)}
          >
            <input
              type="checkbox"
              className={styles.selectCheck}
              checked={selected.has(key)}
              onClick={e => { e.stopPropagation(); toggleSelect(key); }}
              aria-label={`Select ${title}`}
            />
            <div className={styles.fileIcon}>
              <svg width="12" height="14" viewBox="0 0 12 14" fill="none">
                <path d="M1 1h7l3 3v9H1V1z" stroke="currentColor" strokeWidth="1.2"/>
                <path d="M8 1v3h3" stroke="currentColor" strokeWidth="1.2"/>
              </svg>
            </div>
            <div className={styles.fileMeta}>
              <span className={styles.fileName}>{title}</span>
              <span className={styles.fileSize}>
                {artist || formatSize(file.size)}
                {file.tuning && tuningLabel(file.tuning) && (
                  <span className={styles.fileTuning}> · {tuningLabel(file.tuning)}</span>
                )}
              </span>
            </div>
            <button
              className={styles.editBtn}
              onClick={e => {
                e.stopPropagation();
                setEditingFile(key);
                setEditTitle(title);
                setEditArtist(artist || '');
              }}
              title="Edit metadata"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button className={styles.deleteBtn} onClick={e => handleDelete(e, file)} title="Delete">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14H6L5 6"/>
                <path d="M10 11v6M14 11v6"/>
                <path d="M9 6V4h6v2"/>
              </svg>
            </button>
          </div>
        )}
      </div>
    );
  };

  if (!open) {
    return (
      <div className={styles.collapsed}>
        <button className={styles.toggleBtn} onClick={onToggle} title="Open library">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 6h18M3 12h18M3 18h18"/>
          </svg>
        </button>
      </div>
    );
  }

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <div className={styles.logo}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/>
            <circle cx="18" cy="16" r="3"/>
          </svg>
          <span>TabVault</span>
        </div>
        <button className={styles.toggleBtn} onClick={onToggle} title="Close library">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div className={styles.searchRow}>
        <div className={styles.searchWrap}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
          </svg>
          <input
            className={styles.search}
            placeholder="Search title, artist..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div
        className={`${styles.dropZone} ${dragOver ? styles.dragActive : ''}`}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".gp,.gp3,.gp4,.gp5,.gpx,.gp6,.gp7"
          multiple
          style={{ display: 'none' }}
          onChange={e => handleUpload(e.target.files)}
        />
        {uploading ? (
          <span className={styles.uploading}>Uploading...</span>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <span>Drop GP files or click to upload</span>
          </>
        )}
      </div>

      <button className={styles.newSongBtn} onClick={() => { setNewOpen(o => !o); setCreateError(null); }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14"/>
        </svg>
        <span>New song</span>
      </button>
      {newOpen && (
        <div className={styles.newSongForm}>
          <input
            className={styles.editInput}
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder="Title"
            autoFocus
            onKeyDown={e => { if (e.key === 'Enter') handleCreateSong(); }}
          />
          <input
            className={styles.editInput}
            value={newArtist}
            onChange={e => setNewArtist(e.target.value)}
            placeholder="Artist (optional)"
          />
          <div className={styles.newSongRow}>
            <input
              className={styles.editInput}
              type="number"
              min="20"
              max="400"
              value={newTempo}
              onChange={e => setNewTempo(e.target.value)}
              title="Tempo (BPM)"
            />
            <button
              className={styles.editSave}
              disabled={creating || !newTitle.trim()}
              onClick={handleCreateSong}
            >
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button className={styles.editCancel} onClick={() => setNewOpen(false)}>Cancel</button>
          </div>
          {createError && <div className={styles.error}>{createError}</div>}
          <div className={styles.hint} style={{ padding: 0 }}>
            One guitar track, 8 empty 4/4 bars — open it and hit Edit to write the tab.
          </div>
        </div>
      )}


      <div className={styles.listHeader}>
        <span>LIBRARY</span>
        <span className={styles.count}>{files.length}</span>
        <div className={styles.viewToggle}>
          <button className={`${styles.viewBtn} ${view === 'artist' ? styles.viewActive : ''}`} onClick={() => switchView('artist')} title="Group by artist (folders start collapsed)">Artist</button>
          <button className={`${styles.viewBtn} ${view === 'flat' ? styles.viewActive : ''}`} onClick={() => switchView('flat')} title="One flat list, every file expanded">Flat</button>
        </div>
      </div>

      {view === 'artist' && (
        <div className={styles.shelfControls}>
          <button className={styles.organizeBtn} onClick={handleOrganize} disabled={organizing}>
            {organizing ? 'Shelving…' : 'Shelve loose files by artist'}
          </button>
          <button className={styles.foldBtn} onClick={collapsed.size ? expandAll : collapseAll}>
            {collapsed.size ? 'Expand all' : 'Collapse all'}
          </button>
        </div>
      )}

      {selected.size > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>{selected.size} selected</span>
          <button className={`${styles.bulkDelete} ${bulkConfirm ? styles.confirming : ''}`} onClick={handleBulkDelete}>
            {bulkConfirm ? `CONFIRM DELETE ${selected.size}` : `DELETE ${selected.size}`}
          </button>
          <button className={styles.bulkClear} onClick={() => { setSelected(new Set()); setBulkConfirm(false); }}>Clear</button>
        </div>
      )}

      <div className={styles.fileList}>
        {loading && <div className={styles.hint}>Loading...</div>}
        {error && <div className={styles.error}>{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className={styles.hint}>
            {search ? 'No matches' : 'No files yet — upload some Guitar Pro files above'}
          </div>
        )}
        {(() => {
          // A search is a drill-down: ignore the folded state so hits always show.
          const folded = search ? new Set() : collapsed;
          const shelves = view === 'artist'
            ? Object.values(filtered.reduce((acc, f) => {
                const g = f.group || f.artist || 'Unfiled';
                acc[g] = acc[g] || { name: g, files: [] };
                acc[g].files.push(f);
                return acc;
              }, {})).sort((a, b) => a.name.localeCompare(b.name))
            : [{ name: null, files: filtered }];
          return shelves.map(shelf => {
            if (shelf.name === null) return shelf.files.map(renderFile);
            const paths = shelf.files.map(f => f.path || f.name);
            const allSelected = paths.every(p => selected.has(p));
            return (
              <div key={shelf.name} className={styles.shelf}>
                <div className={styles.groupHeader}>
                  <button
                    className={styles.groupToggle}
                    onClick={() => setCollapsed(c => { const n = new Set(c); if (n.has(shelf.name)) n.delete(shelf.name); else n.add(shelf.name); return n; })}
                  >
                    {folded.has(shelf.name) ? '▸' : '▾'} {shelf.name}
                    <span className={styles.groupCount}>{shelf.files.length}</span>
                  </button>
                  <button className={styles.groupSelectAll} onClick={() => selectShelf(shelf.files)}>
                    {allSelected ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                {!folded.has(shelf.name) && shelf.files.map(renderFile)}
              </div>
            );
          });
        })()}
      </div>
    </aside>
  );
}
