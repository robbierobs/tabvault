import React, { useState, useCallback, useEffect } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Player from './components/Player.jsx';
import EmptyState from './components/EmptyState.jsx';
import { loadSongState } from './lib/songState.js';
import styles from './App.module.css';

// Load cache from localStorage on startup
function loadCache() {
  try {
    const stored = localStorage.getItem('gpplayer-metacache');
    return stored ? JSON.parse(stored) : {};
  } catch (e) {
    return {};
  }
}

// On phones the sidebar is a full-screen overlay, so it starts closed and
// closes itself after picking a song
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

export default function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => !isMobile());
  // edit mode takes over the screen: the library hides and comes back on exit
  const [editing, setEditing] = useState(false);
  const [metaCache, setMetaCache] = useState(loadCache);

  // Persist metaCache to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem('gpplayer-metacache', JSON.stringify(metaCache));
    } catch (e) {}
  }, [metaCache]);

  // 0 = original file; >0 = saved edit versions (.versions/<file>/vN.gp)
  const [version, setVersion] = useState(0);

  const handleFileSelect = useCallback((file) => {
    setSelectedFile(file);
    // an explicitly chosen version (including Original = 0) wins; with no
    // saved choice, open the newest version
    const saved = file ? loadSongState(file.name)?.version : undefined;
    setVersion(file ? (saved ?? file.latestVersion ?? 0) : 0);
    if (isMobile()) setSidebarOpen(false);
  }, []);

  const handleMetaLoaded = useCallback((filename, title, artist) => {
    setMetaCache(prev => {
      const next = { ...prev, [filename]: { title, artist } };
      return next;
    });
  }, []);

  return (
    <div className={styles.app}>
      <Sidebar
        open={sidebarOpen && !editing}
        onToggle={() => setSidebarOpen(o => !o)}
        selectedFile={selectedFile}
        onFileSelect={handleFileSelect}
        metaCache={metaCache}
      />
      <main className={`${styles.main} ${!sidebarOpen || editing ? styles.mainExpanded : ''}`}>
        {selectedFile
          ? <Player
              key={`${selectedFile.name}::v${version}`}
              file={selectedFile}
              version={version}
              onVersionChange={setVersion}
              onMetaLoaded={handleMetaLoaded}
              onToggleSidebar={() => setSidebarOpen(o => !o)}
              onEditingChange={setEditing}
            />
          : <EmptyState onToggleSidebar={() => setSidebarOpen(true)} />
        }
      </main>
    </div>
  );
}
