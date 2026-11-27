# PracticeMusic

![License](https://img.shields.io/badge/license-MIT-555555)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux-3d3d44)
![Status](https://img.shields.io/badge/status-early%20development-3d3d44)

A practice workstation for drummers. Download songs, loop the tricky parts, slow them down, play along with a click and mix everything out to your drum amp.

The interface is built with Krate Native, the host layer is Go, and the audio runs in a separate Rust engine process so a crash in audio never takes the window down.

## Planned features

- Browser pane with a yt-dlp powered downloader
- Library with tags, playlists and loudness normalisation
- Waveform player with beat-snapped loops, tempo and pitch control
- Drum removal and drums-only through stem separation
- Metronome with polyrhythms, silent bars and a separate output
- Mixer with per-channel EQ, compression, meters and a master limiter
- MIDI timing analysis for e-kits
- Footswitch and keyboard control, plus saved scenes
- Right-click menus on the timeline, mixer channels, metronome, songs and text boxes

## Current state

In place so far:

- App shell, settings and audio device pickers, with a supervised audio engine process
- Low-latency audio output on Windows (about 6 ms from button to output) and a metronome with sample-accurate clicks
- Library with search, tags, playlists, thumbnails and optional loudness normalisation
- Downloader built on yt-dlp with a queue, progress, retry and cancel
- Browser pane that sends the current page to the downloader
- Waveform player with beat-snapped loops, tempo and pitch control, and saved sections
- A metronome click that follows the loaded song on its own beat grid, through speed changes, loops and skips
- Mixer with song, click and input channels, EQ, compressor, meters, a master limiter, and separate main and monitor mixes
- Metronome with accents, subdivisions, polyrhythms, silent bars, custom sounds and a large beat display
- Scenes that restore routing, levels and metronome settings, and settings export and import
- One workstation workspace where every panel can be dragged by its header, docked against another panel's edge, resized with the dividers and collapsed to a header bar or a side rail; the layout is remembered, and the Layout menu switches between a practice and a mixing arrangement
- Transport bar with play, stop, previous and next song, loop, a time and bar display, and speed, pitch and volume sliders, above a waveform timeline with a time ruler and clickable section flags
- Console style mixer with a colour coded channel strip per source, a live level inside each fader with peak readouts, a Listen button that sends a channel to your speakers, pan, mute, solo, a headphone monitor send, a master section with its own limiter, and an adjustable inspector for EQ, compressor and routing
- Metronome that can collapse into a compact control bar or switch to a large display for playing along
- Library table with sortable columns, a playlist and tag rail, keyboard browsing and a right click menu for song actions
- Keyboard shortcuts for the transport, metronome and panels (press ? in the app for the full list) and tooltips on every control

## Requirements

- Node.js LTS and npm
- Go (the build uses the Go 1.26.1 toolchain and downloads it automatically when needed)
- ffmpeg and ffprobe on your PATH
- Rust stable
- Windows with the WebView2 runtime, or Linux with WebKitGTK 4.1 and the ALSA development headers

## Install

Every tagged release has a Windows installer attached. It contains the app and the audio engine in one executable. Downloading songs also needs ffmpeg and ffprobe on your PATH.

## Getting started

```sh
npm install
npm run build:engine
npm run dev
```

Run the checks the same way CI does:

```sh
npm run typecheck
npm run lint
npm test
```

Build the app:

```sh
npm run build
```

Build the installer (on Windows this needs NSIS on your PATH):

```sh
npm run package
```

## Configuration

The engine binary is located automatically. To use a specific build, set `PM_ENGINE_PATH`:

```sh
PM_ENGINE_PATH=/path/to/pm-engine npm run dev
```

To hear a drum kit or instrument along with the music, choose its input under Settings, Audio, then press Listen on that input channel. Inputs start with Listen off so that a microphone cannot feed back through the speakers.

Settings are stored as JSON in the per-user config folder. Changes made on the Settings screen save automatically, and cover audio devices, the library, appearance, the mixer, the player, the metronome and downloads.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues are covered in [SECURITY.md](SECURITY.md).

## License

MIT
