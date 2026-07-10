import React from 'react';
import styles from './EditCaret.module.css';

// Edit-mode selection caret: an overlay box on the selected (beat, string)
// position. Rendered inside .scoreWrap, which shares the alphaTab render
// surface's coordinate space, so bounds map 1:1 and it scrolls with the tab.
export default function EditCaret({ caret }) {
  if (!caret) return null;
  return (
    <div
      className={styles.caret}
      style={{ left: caret.x, top: caret.y, width: caret.w, height: caret.h }}
    />
  );
}
