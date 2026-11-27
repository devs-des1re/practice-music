export interface ShortcutRow {
  label: string;
  keys: string[];
}

export interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Transport",
    rows: [
      { label: "Play or pause", keys: ["Space"] },
      { label: "Stop and return", keys: ["Enter"] },
      { label: "Back to the start", keys: ["Home"] },
      { label: "Step back or forward", keys: ["Left", "Right"] },
      { label: "Loop on or off", keys: ["L"] },
      { label: "Previous or next song", keys: ["P", "N"] },
    ],
  },
  {
    title: "Tempo and pitch",
    rows: [
      { label: "Slower or faster by one speed step", keys: ["-", "="] },
      { label: "Reset speed and pitch", keys: ["0"] },
      { label: "Metronome tempo", keys: ["Up", "Down"] },
      { label: "Metronome start or stop", keys: ["M"] },
      { label: "Tap tempo", keys: ["T"] },
    ],
  },
  {
    title: "Workspace",
    rows: [
      { label: "Library", keys: ["Alt", "1"] },
      { label: "Mixer", keys: ["Alt", "2"] },
      { label: "Downloads", keys: ["Alt", "3"] },
      { label: "Browser", keys: ["Alt", "4"] },
      { label: "Show this list", keys: ["?"] },
    ],
  },
  {
    title: "Library and mixer",
    rows: [
      { label: "Move through songs", keys: ["Up", "Down"] },
      { label: "Load the selected song", keys: ["Enter"] },
      { label: "Song actions", keys: ["Right click"] },
      { label: "Reset a fader or slider", keys: ["Double click"] },
    ],
  },
];
