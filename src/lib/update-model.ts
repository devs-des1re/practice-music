export interface UpdateView {
  phase: string;
  current: string;
  latest: string;
  size: number;
  done: number;
  canInstall: boolean;
  hidden: boolean;
  error: string;
}

export interface UpdateBanner {
  shown: boolean;
  text: string;
  offer: boolean;
  busy: boolean;
}

export function sizeText(bytes: number): string {
  return (bytes / 1048576).toFixed(1) + " MB";
}

export function updateBanner(state: UpdateView): UpdateBanner {
  const offered = state.phase === "available";
  const busy = state.phase === "downloading";
  const opened = state.phase === "opened";
  let text = "";
  if (offered) {
    text = "PracticeMusic " + state.latest + " is available. You have " + state.current + ".";
    if (!state.canInstall) text += " Get it from the release page.";
    if (state.error) text += " The last try failed: " + state.error + ".";
  } else if (busy) {
    const percent = state.size > 0 ? Math.min(100, Math.floor((state.done / state.size) * 100)) : 0;
    text = "Downloading PracticeMusic " + state.latest + ", " + percent + "% of " + sizeText(state.size) + ".";
  } else if (opened) {
    text = "The installer is open. PracticeMusic is closing so it can be replaced.";
  }
  return {
    shown: text !== "" && (!state.hidden || busy || opened),
    text,
    offer: offered && state.canInstall,
    busy,
  };
}

export function updateStatus(state: UpdateView): string {
  if (state.phase === "checking") return "Checking GitHub for a newer release.";
  if (state.phase === "current") return "You have the newest version.";
  if (state.phase === "failed") return "The check failed: " + state.error + ".";
  if (state.phase === "idle") return "Not checked yet.";
  return updateBanner({ ...state, hidden: false }).text;
}

export function installQuestion(state: UpdateView): string {
  return (
    "This downloads the " +
    sizeText(state.size) +
    " installer from GitHub, checks it against GitHub's SHA-256, opens it and closes PracticeMusic. " +
    "Finish the steps in the installer. Your system may ask for permission or warn that the app is not signed."
  );
}
