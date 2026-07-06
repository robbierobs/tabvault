# TabVault

**A self-hosted Guitar Pro file player for Unraid and Docker.**

Load your Guitar Pro files, play them back with MIDI, loop sections with draggable handles, slow down for practice, and mix individual tracks — all from your browser, running entirely on your own hardware.

---

## Features

- Plays Guitar Pro files — .gp, .gp3, .gp4, .gp5, .gpx, .gp6, .gp7
- MIDI playback with built-in SoundFont synthesizer
- Draggable loop region — click and drag handles on the timeline to set loop points
- Speed control — presets from 50-100%, manual input up to 200%
- Speed ramp — auto-increases tempo each loop for progressive practice
- Tuning display — the current tuning (e.g. Drop D) shown in the header
- Play in any tuning — re-finger the tab for your tuning (same sound), or shift the audio pitch to your tuning (same tab); never modifies the file
- Tuning presets for 4/5-string bass and 6/7/8-string guitar, plus fully custom tunings with a per-string editor
- Track selector — switch which track's notation is displayed (drums excluded automatically)
- Per-track mixer — volume, mute, and solo per instrument
- HQ Sound toggle — swap the synth to the GeneralUser GS soundfont for noticeably richer, more realistic playback (downloaded once, cached on your server)
- A/V sync — nudge the cursor earlier/later (±ms slider with auto-detect) to compensate for audio output latency, e.g. Bluetooth headphones
- Metronome and count-in
- Auto-scrolling tab notation that follows playback
- Beat cursor and bar highlight that move with the music
- Per-song practice memory — speed, loop region, ramp, tuning, and mixer are remembered per song (per browser)
- Keyboard shortcuts — Space play/pause, L loop, ←/→ seek by bar, +/- speed
- Touch friendly — loop handles drag on tablets and phones
- Library metadata — title, artist, album, and tuning extracted automatically from GP files (all formats, including GP6); search by tuning to find songs matching your current setup
- Inline metadata editor — edit title/artist for any file directly in the sidebar
- Search across title, artist, and filename
- Drag-and-drop upload directly in the browser
- Dark UI

---

## Attribution

TabVault is built on top of **[alphaTab](https://alphatab.net/)** by Daniel Kuschny and contributors, licensed under the [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/). alphaTab handles Guitar Pro file parsing, score rendering, and MIDI playback. Without it, this project would not exist.

---

## Quick Start

### Docker

```bash
docker run -d \
  --name tabvault \
  -p 3000:3000 \
  -v /path/to/your/gp/files:/library \
  --restart unless-stopped \
  lumbeecheraw75/tabvault:latest
```

Open http://localhost:3000

### docker-compose

```bash
git clone https://github.com/lumbeecheraw75/tabvault.git
cd tabvault
mkdir library
docker compose up --build
```

---

## Unraid Setup

### Via Community Applications

Search for TabVault in the Community Applications plugin.

### Manual

1. In Unraid UI go to Docker, Add Container
2. Set Repository to lumbeecheraw75/tabvault:latest
3. Add port mapping: 3000 to 3000
4. Add volume mapping: /mnt/user/appdata/tabvault/library to /library
5. Apply and start

Access at http://your-unraid-ip:3000

---

## Uploading Files

Two ways to add Guitar Pro files:

1. Via the browser — drag and drop files onto the upload zone in the sidebar
2. Via file share — copy files directly into your mapped library folder

Metadata (title, artist) is extracted automatically on upload. Click the pencil icon next to any file to edit metadata manually.

---

## Usage Guide

### Looping

**Option 1 — Timeline handles:**
1. Click **Loop** to enable loop mode
2. Drag the green handles on the timeline bar to set start and end bars
3. Drag the green highlighted region to slide the entire loop window
4. Hit play — playback loops the selected range

**Option 2 — Score selection:**
- Click and drag directly on the tab notation to highlight notes or bars
- This selection automatically overrides the timeline handles
- To go back to timeline handles, click on the score without dragging to clear the selection

### Speed Ramp
1. Set your starting speed (e.g. 70%)
2. Enable **Speed Ramp**
3. Set the step size (e.g. +5%) and target tempo (e.g. 100%)
4. Speed increases automatically each loop restart until the target is reached
5. Click **Step now** to advance manually at any time


### Playing in a Different Tuning
The song's tuning is shown as a badge in the header. Click the **Tuning** button (tuning fork icon) and pick the tuning you want to play in, then choose a mode:

- **Re-finger tabs** — the song sounds exactly like the original, but fret numbers are rewritten for your tuning (e.g. an E Standard song re-fingered for Drop D). If some notes can't be reached in the chosen tuning you'll see a warning with a count of clamped notes.
- **Shift pitch** — the tab stays exactly as written, but all audio (every track, including bass) moves to your tuning (e.g. hear a Drop C song in Drop D so you can play along without retuning).

Both are playback-only: the file on disk is never modified, and **Reset to original** puts everything back instantly.

Presets cover common tunings for 4/5-string bass and 6/7/8-string guitar. Pick **Custom…** to define your own tuning — step each string up or down a semitone with the per-string editor, then hit Apply.

### Track Mixer
- Use sliders on the right panel to balance track volumes
- M = mute, S = solo
- Use the dropdown in the header to switch which track's tab is displayed

---

## Building from Source

```bash
cd frontend && npm install && npm run build && cd ..
cd backend && npm install && cd ..
mkdir library
cd backend
LIBRARY_PATH=../library node server.js
```

Open http://localhost:3000

---

## Tech Stack

- [alphaTab](https://alphatab.net/) (MPL-2.0) — Guitar Pro parsing, score rendering, MIDI playback
- React 18 + Vite — Frontend
- Express — Backend
- Docker — Containerization

---

## Sound Quality

The **HQ Sound** button in the player header switches the synthesizer from the default SONiVOX soundfont (~1.3MB) to [GeneralUser GS](https://schristiancollins.com/generaluser.php) (~32MB) — much better guitar, bass, and drum samples. The soundfont is downloaded once by the backend, cached in `library/.cache/`, and served locally from then on (works offline afterwards). The preference is remembered per browser.

To use a different soundfont, set the `HQ_SOUNDFONT_URL` environment variable to any SF2 URL and delete `library/.cache/hq.sf2`.

### A/V Sync

If the beat cursor and the audio don't line up (typical with Bluetooth headphones, which add 100–300ms of latency the browser can't see), open **Sync** in the player header. Move the slider right if the sound arrives after the cursor, left if the cursor feels behind the music, or press **Auto-detect** to start from the latency your browser reports. The setting is remembered per browser.

---

## Notes

- The standard SoundFont (~1.3MB) loads from jsDelivr CDN on first use and is cached by the browser
- Metadata is extracted with alphaTab's own parsers, so every playable format (including GP6/GP7/GP8) gets title/artist/album/tuning automatically; manual edits via the pencil icon always win over re-extraction
- Drum tracks are automatically excluded from the track display selector

---

## License

MIT — see LICENSE

alphaTab is licensed under the Mozilla Public License 2.0.
