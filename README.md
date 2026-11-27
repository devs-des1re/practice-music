# PracticeMusic

![License](https://img.shields.io/badge/license-MIT-555555)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-3d3d44)
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
- Keyboard shortcuts on every page (press ? in the app for the list for that page) and tooltips on every control
- Volume numbers you can type into, and imports that join the playlist you have open
- Sampled drums played from an e-kit over MIDI, with velocity layers, choking, your own sound files, per-pad settings, a hit monitor and a Drums mixer channel

## Requirements

- Node.js LTS and npm
- Go (the build uses the Go 1.26.1 toolchain and downloads it automatically when needed)
- ffmpeg and ffprobe on your PATH
- Rust stable
- Windows with the WebView2 runtime, macOS 12 or later with the Xcode command line tools, or Linux with WebKitGTK 4.1 and the ALSA development headers

## Install

Each tagged release has these installers attached. Each one contains the app and the audio engine.

| System                                     | File         | Notes                                                  |
| ------------------------------------------ | ------------ | ------------------------------------------------------ |
| Windows 10 and 11, 64-bit                  | `-setup.exe` | Installs the WebView2 runtime if it is missing         |
| macOS 12 or later, Apple silicon and Intel | `.dmg`       | One universal app                                      |
| Debian, Ubuntu and similar, 64-bit         | `.deb`       | Needs WebKitGTK 4.1, for example Ubuntu 22.04 or later |
| Fedora and similar, 64-bit                 | `.rpm`       | Needs WebKitGTK 4.1                                    |

PracticeMusic is developed and tested on Windows. The macOS and Linux installers are built automatically and have not been tried on real machines yet, so treat them as experimental.

The installers are not signed. Windows may show a SmartScreen warning. macOS will refuse to open the app until you allow it under System Settings, Privacy and Security.

Downloading songs also needs ffmpeg and ffprobe on your PATH.

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

Build the installers for the system you are on: NSIS on Windows (needs NSIS on your PATH), a `.dmg` on macOS, and a `.deb` and `.rpm` on Linux. CI builds all of them on every push and keeps them as workflow artifacts.

```sh
npm run package
```

## Keyboard

Press `?` or `F1` on any page to see its shortcuts. Shortcuts pause while you type or while a popup is open.

| Keys               | What they do                                                                  |
| ------------------ | ----------------------------------------------------------------------------- |
| `Space`, `Enter`   | Play or pause, stop                                                           |
| `M`, `T`, up, down | Start the click, tap the tempo, change the tempo                              |
| `Alt` and arrows   | Choose a mixer channel and change its level                                   |
| `J`, `/`, `Ctrl+O` | Go to the song list, search, import                                           |
| `Ctrl+1` to `4`    | Workspace, Drums, Latency tools, Settings                                     |
| `Tab`              | Reach any other control, then press `Space` or `Enter`, or use the arrow keys |

## Drums over MIDI

Connect your drum module by USB or MIDI, then open Drums in the top bar.

1. Choose your module under MIDI input. Hit a drum and it appears in the hit monitor.
2. Pick a kit. MuldjordKit is not part of the app or the installer. Nothing is downloaded until you press Download and confirm. The download is about 346 MB and about 147 MB is kept.
3. If a drum plays the wrong pad, select the pad, press Learn and hit that drum.
4. Plug your headphones or speakers into the computer and turn the module's own volume down. If you also listen to the module on a line input, turn Listen off for that channel.

Each pad has its own sound, MIDI notes, volume, pan, pitch, sensitivity and choke group. A pad can play your own WAV, FLAC, OGG, MP3 or AIFF files, with or without a downloaded kit. Add several hits from soft to hard to get velocity layers. The Playing panel sets the velocity curve, the weakest hit that counts and how the hi-hat pedal behaves.

The engine reads the kit's recordings directly. It does not import other SFZ kits. Drum settings are not part of settings export.

## Configuration

The engine binary is located automatically. To use a specific build, set `PM_ENGINE_PATH`:

```sh
PM_ENGINE_PATH=/path/to/pm-engine npm run dev
```

To hear a drum kit or instrument along with the music, choose its input under Settings, Audio, then press Listen on that input channel. Inputs start with Listen off so that a microphone cannot feed back through the speakers.

Settings are stored as JSON in the per-user config folder. Changes made on the Settings screen save automatically, and cover audio devices, the library, appearance, the mixer, the player, the metronome and downloads.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues are covered in [SECURITY.md](SECURITY.md).

## Credits

The optional drum recordings are [MuldjordKit](https://github.com/sfzinstruments/DrumGizmo.MuldjordKit) by Lars Muldjord (drumgizmo.org), SFZ edition by kinwie, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). PracticeMusic mixes the microphone recordings of each hit into one stereo sound when it loads them.

## License

MIT
