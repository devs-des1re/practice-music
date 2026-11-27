export interface Command {
  id: string;
  scope: string;
  group: string;
  label: string;
  keys: string[];
  show?: string;
}

export interface CommandHit {
  id: string;
  at: number;
}

export interface HelpRow {
  label: string;
  keys: string[];
}

export interface HelpGroup {
  title: string;
  rows: HelpRow[];
}

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type FocusKind = "text" | "slider" | "check" | "button" | "none";

export const KEYMAP: Command[] = [
  { id: "app.workspace", scope: "global", group: "Anywhere", label: "Workspace", keys: ["Ctrl+1"] },
  { id: "app.drums", scope: "global", group: "Anywhere", label: "Drums", keys: ["Ctrl+2"] },
  { id: "app.latency", scope: "global", group: "Anywhere", label: "Latency tools", keys: ["Ctrl+3"] },
  { id: "app.settings", scope: "global", group: "Anywhere", label: "Settings", keys: ["Ctrl+4", "Ctrl+,"] },
  { id: "app.help", scope: "global", group: "Anywhere", label: "Show this list", keys: ["Shift+/", "F1"] },

  { id: "player.play", scope: "workspace", group: "Transport", label: "Play or pause", keys: ["Space"] },
  { id: "player.stop", scope: "workspace", group: "Transport", label: "Stop and return", keys: ["Enter"] },
  { id: "player.start", scope: "workspace", group: "Transport", label: "Back to the start", keys: ["Home"] },
  { id: "player.back", scope: "workspace", group: "Transport", label: "Step back", keys: ["Left"] },
  { id: "player.forward", scope: "workspace", group: "Transport", label: "Step forward", keys: ["Right"] },
  { id: "player.back-big", scope: "workspace", group: "Transport", label: "Large step back", keys: ["Shift+Left"] },
  {
    id: "player.forward-big",
    scope: "workspace",
    group: "Transport",
    label: "Large step forward",
    keys: ["Shift+Right"],
  },
  { id: "player.previous", scope: "workspace", group: "Transport", label: "Previous song", keys: ["P"] },
  { id: "player.next", scope: "workspace", group: "Transport", label: "Next song", keys: ["N"] },
  { id: "player.click", scope: "workspace", group: "Transport", label: "Metronome with the song", keys: ["K"] },

  { id: "player.select", scope: "workspace", group: "Loops and sections", label: "Select a loop", keys: ["S"] },
  { id: "player.loop", scope: "workspace", group: "Loops and sections", label: "Loop on or off", keys: ["L"] },
  { id: "player.save-loop", scope: "workspace", group: "Loops and sections", label: "Save loop", keys: ["Shift+L"] },
  { id: "player.clear-loop", scope: "workspace", group: "Loops and sections", label: "Clear loop", keys: ["X"] },
  {
    id: "player.section",
    scope: "workspace",
    group: "Loops and sections",
    label: "Play a saved section",
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    show: "1 to 9",
  },

  { id: "player.slower", scope: "workspace", group: "Song speed and sound", label: "Slower", keys: ["-"] },
  { id: "player.faster", scope: "workspace", group: "Song speed and sound", label: "Faster", keys: ["=", "Shift+="] },
  {
    id: "player.reset",
    scope: "workspace",
    group: "Song speed and sound",
    label: "Reset speed and pitch",
    keys: ["0"],
  },
  { id: "player.pitch-down", scope: "workspace", group: "Song speed and sound", label: "Pitch down", keys: ["["] },
  { id: "player.pitch-up", scope: "workspace", group: "Song speed and sound", label: "Pitch up", keys: ["]"] },
  { id: "player.quieter", scope: "workspace", group: "Song speed and sound", label: "Song volume down", keys: [","] },
  { id: "player.louder", scope: "workspace", group: "Song speed and sound", label: "Song volume up", keys: ["."] },
  { id: "player.count-in", scope: "workspace", group: "Song speed and sound", label: "Change count-in", keys: ["C"] },
  { id: "player.snap", scope: "workspace", group: "Song speed and sound", label: "Change snapping", keys: ["Q"] },
  {
    id: "player.tab",
    scope: "workspace",
    group: "Song speed and sound",
    label: "Sections, beat grid or tempo tab",
    keys: ["V"],
  },
  { id: "player.detect", scope: "workspace", group: "Song speed and sound", label: "Detect the tempo", keys: ["D"] },
  { id: "player.beat-one", scope: "workspace", group: "Song speed and sound", label: "Beat one here", keys: ["B"] },
  { id: "player.grid", scope: "workspace", group: "Song speed and sound", label: "Edit beat grid", keys: ["G"] },

  { id: "metro.run", scope: "workspace", group: "Metronome", label: "Start or stop", keys: ["M"] },
  { id: "metro.tap", scope: "workspace", group: "Metronome", label: "Tap tempo", keys: ["T"] },
  { id: "metro.faster", scope: "workspace", group: "Metronome", label: "Tempo up", keys: ["Up"] },
  { id: "metro.slower", scope: "workspace", group: "Metronome", label: "Tempo down", keys: ["Down"] },
  { id: "metro.faster-big", scope: "workspace", group: "Metronome", label: "Large tempo step up", keys: ["Shift+Up"] },
  {
    id: "metro.slower-big",
    scope: "workspace",
    group: "Metronome",
    label: "Large tempo step down",
    keys: ["Shift+Down"],
  },
  { id: "metro.quieter", scope: "workspace", group: "Metronome", label: "Click volume down", keys: ["Shift+,"] },
  { id: "metro.louder", scope: "workspace", group: "Metronome", label: "Click volume up", keys: ["Shift+."] },
  { id: "metro.fewer", scope: "workspace", group: "Metronome", label: "One beat fewer", keys: ["Shift+["] },
  { id: "metro.more", scope: "workspace", group: "Metronome", label: "One beat more", keys: ["Shift+]"] },
  { id: "metro.subdivision", scope: "workspace", group: "Metronome", label: "Change subdivision", keys: ["U"] },
  {
    id: "metro.accent",
    scope: "workspace",
    group: "Metronome",
    label: "Change the accent of a beat",
    keys: ["Shift+1", "Shift+2", "Shift+3", "Shift+4", "Shift+5", "Shift+6", "Shift+7", "Shift+8", "Shift+9"],
    show: "Shift+1 to 9",
  },
  { id: "metro.large", scope: "workspace", group: "Metronome", label: "Large display", keys: ["F"] },
  { id: "metro.view", scope: "workspace", group: "Metronome", label: "Click, time or setup view", keys: ["Shift+V"] },
  { id: "metro.silent", scope: "workspace", group: "Metronome", label: "Edit silent bars", keys: ["Shift+B"] },

  { id: "mixer.previous", scope: "workspace", group: "Mixer", label: "Previous channel", keys: ["Alt+Left"] },
  { id: "mixer.next", scope: "workspace", group: "Mixer", label: "Next channel", keys: ["Alt+Right"] },
  { id: "mixer.up", scope: "workspace", group: "Mixer", label: "Channel level up", keys: ["Alt+Up"] },
  { id: "mixer.down", scope: "workspace", group: "Mixer", label: "Channel level down", keys: ["Alt+Down"] },
  { id: "mixer.unity", scope: "workspace", group: "Mixer", label: "Channel level to 0 dB", keys: ["Alt+Backspace"] },
  { id: "mixer.mute", scope: "workspace", group: "Mixer", label: "Mute", keys: ["Alt+M"] },
  { id: "mixer.solo", scope: "workspace", group: "Mixer", label: "Solo", keys: ["Alt+S"] },
  { id: "mixer.listen", scope: "workspace", group: "Mixer", label: "Listen", keys: ["Alt+L"] },
  { id: "mixer.pan-left", scope: "workspace", group: "Mixer", label: "Pan left", keys: ["Alt+["] },
  { id: "mixer.pan-right", scope: "workspace", group: "Mixer", label: "Pan right", keys: ["Alt+]"] },
  { id: "mixer.pan-centre", scope: "workspace", group: "Mixer", label: "Centre the pan", keys: ["Alt+P"] },
  { id: "mixer.send-down", scope: "workspace", group: "Mixer", label: "Monitor send down", keys: ["Alt+,"] },
  { id: "mixer.send-up", scope: "workspace", group: "Mixer", label: "Monitor send up", keys: ["Alt+."] },
  { id: "mixer.rename", scope: "workspace", group: "Mixer", label: "Rename input channel", keys: ["Alt+R"] },

  { id: "mixer.main-up", scope: "workspace", group: "Master and scenes", label: "Main level up", keys: ["Alt+PageUp"] },
  {
    id: "mixer.main-down",
    scope: "workspace",
    group: "Master and scenes",
    label: "Main level down",
    keys: ["Alt+PageDown"],
  },
  {
    id: "mixer.monitor-up",
    scope: "workspace",
    group: "Master and scenes",
    label: "Monitor level up",
    keys: ["Alt+Shift+PageUp"],
  },
  {
    id: "mixer.monitor-down",
    scope: "workspace",
    group: "Master and scenes",
    label: "Monitor level down",
    keys: ["Alt+Shift+PageDown"],
  },
  { id: "mixer.limiter", scope: "workspace", group: "Master and scenes", label: "Limiter on or off", keys: ["Alt+K"] },
  { id: "mixer.inspector", scope: "workspace", group: "Master and scenes", label: "Show inspector", keys: ["Alt+I"] },
  {
    id: "mixer.inspector-tab",
    scope: "workspace",
    group: "Master and scenes",
    label: "Next inspector tab",
    keys: ["Alt+T"],
  },
  { id: "mixer.clear", scope: "workspace", group: "Master and scenes", label: "Clear clip lights", keys: ["Alt+C"] },
  {
    id: "mixer.reset",
    scope: "workspace",
    group: "Master and scenes",
    label: "Reset the mixer",
    keys: ["Alt+Shift+Backspace"],
  },
  { id: "mixer.scene-save", scope: "workspace", group: "Master and scenes", label: "Save new scene", keys: ["Alt+N"] },
  { id: "mixer.scene-update", scope: "workspace", group: "Master and scenes", label: "Update scene", keys: ["Alt+U"] },
  { id: "mixer.scene-rename", scope: "workspace", group: "Master and scenes", label: "Rename scene", keys: ["Alt+E"] },
  {
    id: "mixer.scene-delete",
    scope: "workspace",
    group: "Master and scenes",
    label: "Delete scene",
    keys: ["Alt+Delete"],
  },
  {
    id: "mixer.scene",
    scope: "workspace",
    group: "Master and scenes",
    label: "Recall a scene",
    keys: [
      "Alt+Shift+1",
      "Alt+Shift+2",
      "Alt+Shift+3",
      "Alt+Shift+4",
      "Alt+Shift+5",
      "Alt+Shift+6",
      "Alt+Shift+7",
      "Alt+Shift+8",
      "Alt+Shift+9",
    ],
    show: "Alt+Shift+1 to 9",
  },

  { id: "library.search", scope: "workspace", group: "Library", label: "Search", keys: ["/"] },
  { id: "library.list", scope: "workspace", group: "Library", label: "Go to the song list", keys: ["J"] },
  { id: "library.import", scope: "workspace", group: "Library", label: "Import songs", keys: ["Ctrl+O"] },
  { id: "library.rescan", scope: "workspace", group: "Library", label: "Rescan the folder", keys: ["Ctrl+Shift+O"] },
  { id: "library.sort", scope: "workspace", group: "Library", label: "Change sort order", keys: ["O"] },
  { id: "library.list-previous", scope: "workspace", group: "Library", label: "Previous playlist", keys: ["Ctrl+Up"] },
  { id: "library.list-next", scope: "workspace", group: "Library", label: "Next playlist", keys: ["Ctrl+Down"] },
  { id: "library.list-new", scope: "workspace", group: "Library", label: "New playlist", keys: ["Shift+N"] },
  { id: "library.list-rename", scope: "workspace", group: "Library", label: "Rename playlist", keys: ["Shift+R"] },
  {
    id: "library.list-delete",
    scope: "workspace",
    group: "Library",
    label: "Delete playlist",
    keys: ["Shift+Delete"],
  },

  { id: "library.edit", scope: "workspace", group: "Selected song", label: "Edit details", keys: ["F2"] },
  { id: "library.menu", scope: "workspace", group: "Selected song", label: "Song actions and playlists", keys: ["A"] },
  {
    id: "library.up",
    scope: "workspace",
    group: "Selected song",
    label: "Move up in the playlist",
    keys: ["Ctrl+Shift+Up"],
  },
  {
    id: "library.down",
    scope: "workspace",
    group: "Selected song",
    label: "Move down in the playlist",
    keys: ["Ctrl+Shift+Down"],
  },
  { id: "library.remove", scope: "workspace", group: "Selected song", label: "Remove", keys: ["Delete"] },
  {
    id: "library.erase",
    scope: "workspace",
    group: "Selected song",
    label: "Delete the file from disk",
    keys: ["Ctrl+Delete"],
  },

  { id: "downloads.new", scope: "workspace", group: "Downloads and browser", label: "New download", keys: ["Ctrl+D"] },
  {
    id: "downloads.clear",
    scope: "workspace",
    group: "Downloads and browser",
    label: "Clear finished downloads",
    keys: ["Ctrl+Shift+D"],
  },
  {
    id: "downloads.check",
    scope: "workspace",
    group: "Downloads and browser",
    label: "Check download tools",
    keys: ["Ctrl+Shift+Y"],
  },
  {
    id: "browser.address",
    scope: "workspace",
    group: "Downloads and browser",
    label: "Browser address",
    keys: ["Ctrl+B"],
  },
  { id: "browser.home", scope: "workspace", group: "Downloads and browser", label: "Browser home", keys: ["Alt+Home"] },
  { id: "browser.reload", scope: "workspace", group: "Downloads and browser", label: "Reload page", keys: ["Ctrl+R"] },
  {
    id: "browser.download",
    scope: "workspace",
    group: "Downloads and browser",
    label: "Download this page",
    keys: ["Ctrl+S"],
  },

  { id: "workspace.library", scope: "workspace", group: "Panels", label: "Library", keys: ["Alt+1"] },
  { id: "workspace.mixer", scope: "workspace", group: "Panels", label: "Mixer", keys: ["Alt+2"] },
  { id: "workspace.downloads", scope: "workspace", group: "Panels", label: "Downloads", keys: ["Alt+3"] },
  { id: "workspace.browser", scope: "workspace", group: "Panels", label: "Browser", keys: ["Alt+4"] },
  { id: "workspace.practice", scope: "workspace", group: "Panels", label: "Practice layout", keys: ["Alt+5"] },
  { id: "workspace.mixing", scope: "workspace", group: "Panels", label: "Mixing layout", keys: ["Alt+6"] },
  { id: "workspace.reset", scope: "workspace", group: "Panels", label: "Reset panels", keys: ["Alt+7"] },
  {
    id: "workspace.fold",
    scope: "workspace",
    group: "Panels",
    label: "Fold a panel: player, metronome, library, mixer, downloads, browser",
    keys: ["Shift+F1", "Shift+F2", "Shift+F3", "Shift+F4", "Shift+F5", "Shift+F6"],
    show: "Shift+F1 to F6",
  },

  { id: "drums.previous", scope: "drums", group: "Pads", label: "Previous pad", keys: ["Left", "Up"] },
  { id: "drums.next", scope: "drums", group: "Pads", label: "Next pad", keys: ["Right", "Down"] },
  { id: "drums.play", scope: "drums", group: "Pads", label: "Play the pad", keys: ["Space", "Enter"] },
  { id: "drums.play-soft", scope: "drums", group: "Pads", label: "Play it softly", keys: ["Shift+Space"] },
  { id: "drums.learn", scope: "drums", group: "Pads", label: "Learn from a hit", keys: ["L"] },
  { id: "drums.files", scope: "drums", group: "Pads", label: "Add sound files", keys: ["A"] },
  { id: "drums.pad-down", scope: "drums", group: "Pads", label: "Pad volume down", keys: ["["] },
  { id: "drums.pad-up", scope: "drums", group: "Pads", label: "Pad volume up", keys: ["]"] },
  { id: "drums.pad-reset", scope: "drums", group: "Pads", label: "Reset the pad", keys: ["R"] },
  { id: "drums.mute", scope: "drums", group: "Drums", label: "Mute the Drums channel", keys: ["M"] },
  { id: "drums.quieter", scope: "drums", group: "Drums", label: "Drums level down", keys: [","] },
  { id: "drums.louder", scope: "drums", group: "Drums", label: "Drums level up", keys: ["."] },
  { id: "drums.enable", scope: "drums", group: "Drums", label: "Drum sounds on or off", keys: ["E"] },
  { id: "drums.listen", scope: "drums", group: "Drums", label: "Stop hearing the line input", keys: ["X"] },
  { id: "drums.clear", scope: "drums", group: "Drums", label: "Clear the hit monitor", keys: ["C"] },
  { id: "drums.download", scope: "drums", group: "Drums", label: "Download the kit", keys: ["D"] },
  { id: "drums.remove", scope: "drums", group: "Drums", label: "Remove the downloaded kit", keys: ["Shift+D"] },
  { id: "drums.reset", scope: "drums", group: "Drums", label: "Reset drum settings", keys: ["Shift+R"] },

  {
    id: "settings.section",
    scope: "settings",
    group: "Settings",
    label: "Open a section",
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    show: "1 to 9",
  },
  { id: "settings.devices", scope: "settings", group: "Settings", label: "Rescan audio devices", keys: ["R"] },
  { id: "settings.engine", scope: "settings", group: "Settings", label: "Restart the audio engine", keys: ["Shift+E"] },
  { id: "settings.folder", scope: "settings", group: "Settings", label: "Add a library folder", keys: ["A"] },
  { id: "settings.export", scope: "settings", group: "Settings", label: "Export settings", keys: ["Ctrl+E"] },
  { id: "settings.import", scope: "settings", group: "Settings", label: "Import settings", keys: ["Ctrl+O"] },
  { id: "settings.reset", scope: "settings", group: "Settings", label: "Reset preferences", keys: ["Shift+0"] },

  { id: "latency.audio", scope: "latency", group: "Latency tools", label: "Start or stop audio", keys: ["A"] },
  { id: "latency.press", scope: "latency", group: "Latency tools", label: "Send a test click", keys: ["Space"] },
  { id: "latency.batch", scope: "latency", group: "Latency tools", label: "Run 20 test clicks", keys: ["B"] },
  { id: "latency.reset", scope: "latency", group: "Latency tools", label: "Reset measurements", keys: ["R"] },
  { id: "latency.metronome", scope: "latency", group: "Latency tools", label: "Metronome on or off", keys: ["M"] },
  { id: "latency.loopback", scope: "latency", group: "Latency tools", label: "Measure loopback", keys: ["L"] },
];

export function chordOf(e: KeyLike): string {
  const code = e.code || "";
  let name = "";
  if (/^Key[A-Z]$/.test(code)) name = /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : code.slice(3);
  else if (/^(Digit|Numpad)[0-9]$/.test(code)) name = code.slice(-1);
  else {
    const byCode: Record<string, string> = {
      Minus: "-",
      NumpadSubtract: "-",
      Equal: "=",
      NumpadAdd: "=",
      BracketLeft: "[",
      BracketRight: "]",
      Comma: ",",
      Period: ".",
      Slash: "/",
      Space: "Space",
      NumpadEnter: "Enter",
    };
    const byKey: Record<string, string> = {
      " ": "Space",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Enter: "Enter",
      Escape: "Escape",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      Delete: "Delete",
      Backspace: "Backspace",
    };
    if (byCode[code]) name = byCode[code];
    else if (byKey[e.key]) name = byKey[e.key];
    else if (/^F([1-9]|1[0-2])$/.test(e.key)) name = e.key;
    else if (/^[a-z0-9]$/i.test(e.key)) name = e.key.toUpperCase();
    else if (e.key.length === 1 && "-=[],./".includes(e.key)) name = e.key;
  }
  if (e.key === "?") name = "/";
  if (!name) return "";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey || e.key === "?") parts.push("Shift");
  parts.push(name);
  return parts.join("+");
}

export function commandFor(chord: string, scope: string): CommandHit | null {
  for (const command of KEYMAP) {
    if (command.scope !== scope && command.scope !== "global") continue;
    const at = command.keys.indexOf(chord);
    if (at >= 0) return { id: command.id, at };
  }
  return null;
}

export function keyText(chord: string): string {
  if (chord === "Shift+/") return "?";
  return chord.replace("Escape", "Esc").replace("PageUp", "Page Up").replace("PageDown", "Page Down");
}

export function commandKeys(id: string): string {
  const command = KEYMAP.find((c) => c.id === id);
  if (!command) return "";
  return command.show || keyText(command.keys[0]);
}

export function helpGroups(scope: string): HelpGroup[] {
  const groups: HelpGroup[] = [];
  const ordered = KEYMAP.filter((c) => c.scope === scope).concat(KEYMAP.filter((c) => c.scope === "global"));
  for (const command of ordered) {
    let group = groups.find((g) => g.title === command.group);
    if (!group) {
      group = { title: command.group, rows: [] };
      groups.push(group);
    }
    group.rows.push({ label: command.label, keys: command.show ? [command.show] : command.keys.map(keyText) });
  }
  if (scope === "workspace") {
    groups.push({
      title: "Mouse and lists",
      rows: [
        { label: "Move through songs in the list", keys: ["Up", "Down"] },
        { label: "Load the selected song", keys: ["Enter"] },
        { label: "Move a focused fader", keys: ["Up", "Down", "Page Up", "Page Down"] },
        { label: "Cancel a selection or close a popup", keys: ["Esc"] },
        { label: "Reset a fader or slider", keys: ["Double click"] },
      ],
    });
  }
  return groups;
}

export function focusKeeps(kind: FocusKind, chord: string): boolean {
  if (kind === "text") return true;
  if (kind === "slider") return /^(Shift\+)?(Up|Down|Left|Right|Home|End|PageUp|PageDown)$/.test(chord);
  if (kind === "check") return chord === "Space";
  if (kind === "button") return chord === "Space" || chord === "Enter";
  return false;
}

function focusKind(target: EventTarget | null): FocusKind {
  if (!(target instanceof HTMLElement)) return "none";
  if (target instanceof HTMLInputElement) {
    if (target.type === "range") return "slider";
    if (target.type === "checkbox" || target.type === "radio") return "check";
    return "text";
  }
  if (target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) return "text";
  if (target.getAttribute("role") === "slider") return "slider";
  if (target.matches("button:focus-visible, a:focus-visible, [role='button']:focus-visible")) return "button";
  return "none";
}

export function popupOpen(): boolean {
  const popups = document.querySelectorAll('.dialog-scrim[data-on="true"], .menu[data-on="true"], .pm-modal-content');
  return Array.from(popups).some((el) => el.getClientRects().length > 0);
}

export function pressedCommand(e: KeyboardEvent, scope: string, area: string): CommandHit | null {
  if (e.defaultPrevented || e.isComposing || e.getModifierState("AltGraph")) return null;
  const chord = chordOf(e);
  if (!chord) return null;
  const hit = commandFor(chord, scope);
  if (!hit || !hit.id.startsWith(area + ".")) return null;
  if (popupOpen() || focusKeeps(focusKind(e.target), chord)) return null;
  e.preventDefault();
  return hit;
}
