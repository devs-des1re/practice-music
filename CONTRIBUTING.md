# Contributing

Thanks for taking the time to help. This guide covers how to set up the project and what a good change looks like.

## Requirements

- Node.js LTS and npm
- Go 1.26 or newer
- Rust stable
- Krate CLI (installed through the project dependencies)
- Windows: the WebView2 runtime. Linux: WebKitGTK 4.1 and the ALSA development headers.

## Setup

```sh
npm install
npm run build:engine
npm run dev
```

`npm run dev` starts the Krate Native dev loop. The audio engine is a separate Rust process and is found in `engine/target` after `npm run build:engine`, or through the `PM_ENGINE_PATH` environment variable.

## Checks

Run these before opening a pull request. CI runs the same commands.

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

## Conventions

- TypeScript for the UI, Go for the host, Rust for the audio engine.
- Styles are vanilla CSS in `src/globals.css`. Every colour, spacing and font value is a token defined in `:root`.
- Hover effects change colour only.
- No comments in source files. Prefer clear names.
- Real-time rule for the engine: no allocation, locks or I/O inside the audio callback.
- Commits follow Conventional Commits, for example `feat:`, `fix:` or `docs:`.

## Pull requests

- Keep each pull request focused on one change.
- Add or update tests for engine timing, the IPC protocol and the download queue when you touch them.
- Describe what changed and how you checked it.
