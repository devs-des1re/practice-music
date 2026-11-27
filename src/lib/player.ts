import type { PlayerState } from "./types";

export const emptyPlayer: PlayerState = {
  loaded: false,
  songId: 0,
  title: "",
  artist: "",
  path: "",
  durationMs: 0,
  positionMs: 0,
  playing: false,
  loops: 0,
  speed: 1,
  pitch: 0,
  volume: 0.9,
  loop: { startMs: 0, endMs: 0, enabled: false },
  countIn: 0,
  click: false,
  grid: { bpm: 0, offsetMs: 0, beatsPerBar: 4, downbeat: 0, confidence: 0, userEdited: false, found: false },
  error: "",
};
