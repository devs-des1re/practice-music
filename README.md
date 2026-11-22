# PracticeMusic

![License](https://img.shields.io/badge/license-MIT-e8a33d)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20Linux-3d3d44)
![Status](https://img.shields.io/badge/status-early%20development-3d3d44)

A practice workstation for drummers. Download songs, loop the tricky parts, slow them down, play along with a click and mix everything out to your drum amp.

The interface is built with Krate Native, the host layer is Go, and the audio runs in a separate Rust engine process so a crash in audio never takes the window down.

## Planned features

- Browser pane with a yt-dlp powered downloader
- Library with tags, playlists and loudness normalisation
- Waveform player with beat-snapped loops, tempo and pitch control
- Speed trainer that raises the tempo after clean repetitions
- Drum removal and drums-only through stem separation
- Metronome with polyrhythms, silent bars and a separate output
- Mixer with per-channel EQ, compression, meters and a master limiter
- MIDI timing analysis for e-kits
- Footswitch and keyboard control, plus saved scenes

## Current state

In place so far:

- App shell, settings and audio device pickers, with a supervised audio engine process
- Low-latency audio output on Windows (about 6 ms from button to output) and a metronome with sample-accurate clicks
- Library with search, tags, playlists, thumbnails and optional loudness normalisation
- Downloader built on yt-dlp with a queue, progress, retry and cancel
- Browser pane that sends the current page to the downloader

## Requirements

- Node.js LTS and npm
- Go (the build uses the Go 1.26.1 toolchain and downloads it automatically when needed)
- ffmpeg and ffprobe on your PATH
- Rust stable
- Windows with the WebView2 runtime, or Linux with WebKitGTK 4.1 and the ALSA development headers

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

## Configuration

The engine binary is located automatically. To use a specific build, set `PM_ENGINE_PATH`:

```sh
PM_ENGINE_PATH=/path/to/pm-engine npm run dev
```

Settings are stored as JSON in the per-user config folder and can be changed from the Settings screen.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues are covered in [SECURITY.md](SECURITY.md).

## License

MIT
