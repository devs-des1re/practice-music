import { createSignal, createEffect, onMount } from "@krate/runtime";
import { AutoCheckForUpdate, CheckForUpdate, UpdateStream } from "../../../api/updates.go";
import { LiveText } from "../ui/live-text";
import { updateStatus, type UpdateView } from "../../lib/update-model";
import { logger } from "../../lib/logger";

export function UpdateCheck() {
  const [checkVersion, setCheckVersion] = createSignal("");
  const [checkText, setCheckText] = createSignal("Not checked yet.");
  const [checkBusy, setCheckBusy] = createSignal(false);

  function showUpdate(state: UpdateView) {
    setCheckVersion("PracticeMusic " + state.current);
    setCheckText(updateStatus(state));
    setCheckBusy(state.phase === "checking" || state.phase === "downloading");
  }

  createEffect(() => {
    const next = UpdateStream();
    if (next) showUpdate(next);
  });

  onMount(() => {
    AutoCheckForUpdate()
      .then((state) => showUpdate(state))
      .catch((e) => logger.warn("update status failed", e));
  });

  return (
    <div class="update-check">
      <LiveText class="update-version mono" text={checkVersion()} />
      <LiveText class="field-hint" text={checkText()} />
      <button
        class="krate-button krate-button-secondary krate-button-sm"
        type="button"
        disabled={checkBusy()}
        data-tip="Ask GitHub for the newest release"
        data-command="settings.updates"
        onClick={() => CheckForUpdate().catch((e) => logger.warn("update check failed", e))}
      >
        <Icon name="lucide:refresh-cw" />
        Check now
      </button>
    </div>
  );
}
