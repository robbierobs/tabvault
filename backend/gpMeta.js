/**
 * Guitar Pro file metadata extractor, backed by alphaTab's importers.
 * Handles every format alphaTab plays (.gp3/.gp4/.gp5, GP6 BCFz, GP7/8 zip)
 * with the same parser the player itself uses.
 */

const fs = require('fs');
const at = require('@coderline/alphatab');

// keep library scans quiet (alphaTab warns about odd bends etc.)
if (at.Logger && at.LogLevel) at.Logger.logLevel = at.LogLevel.Error;

// bump when the sidecar shape changes so old files get re-extracted
const META_VERSION = 2;

function extractGPMeta(filePath) {
  try {
    const bytes = new Uint8Array(fs.readFileSync(filePath));
    const score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, new at.Settings());

    // representative tuning: the first stringed, non-percussion staff
    let tuning = null;
    for (const track of score.tracks || []) {
      const staff = (track.staves || []).find(
        s => !s.isPercussion && s.stringTuning && s.stringTuning.tunings && s.stringTuning.tunings.length > 0
      );
      if (staff) {
        tuning = Array.from(staff.stringTuning.tunings);
        break;
      }
    }

    return {
      v: META_VERSION,
      title: (score.title || '').trim(),
      artist: (score.artist || '').trim(),
      album: (score.album || '').trim(),
      tuning,
      trackCount: (score.tracks || []).length,
    };
  } catch (e) {
    console.error(`Metadata extraction failed for ${filePath}: ${e.message}`);
    return null;
  }
}

module.exports = { extractGPMeta, META_VERSION };
