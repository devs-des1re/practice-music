import { createSignal, createEffect, onMount } from "@krate/runtime";
import { quit } from "@krate/app/app";
import {
  AutoCheckForUpdate,
  CancelUpdate,
  HideUpdate,
  InstallUpdate,
  OpenReleasePage,
  UpdateStream,
} from "../../../api/updates.go";
import { LiveText } from "../ui/live-text";
import { askConfirm } from "../../lib/modal";
import { installQuestion, updateBanner, type UpdateView } from "../../lib/update-model";
import { logger } from "../../lib/logger";

const CLOSE_DELAY_MS = 1500;

const noUpdate: UpdateView = {
  phase: "idle",
  current: "",
  latest: "",
  size: 0,
  done: 0,
  canInstall: false,
  hidden: false,
  error: "",
};

export function UpdateNotice() {
  const [updateInfo, setUpdateInfo] = createSignal<UpdateView>(noUpdate);
  const [updateShown, setUpdateShown] = createSignal(false);
  const [updateText, setUpdateText] = createSignal("");
  const [updateOffer, setUpdateOffer] = createSignal(false);
  const [updateBusy, setUpdateBusy] = createSignal(false);
  const [updatePage, setUpdatePage] = createSignal(false);
  const closing = { started: false };

  const updateProblem = (e: unknown) => logger.warn("update action failed", e);

  createEffect(() => {
    const next = UpdateStream();
    if (next) setUpdateInfo(next);
  });

  createEffect(() => {
    const state = updateInfo();
    const banner = updateBanner(state);
    setUpdateShown(banner.shown);
    setUpdateText(banner.text);
    setUpdateOffer(banner.offer);
    setUpdateBusy(banner.busy);
    setUpdatePage(state.phase === "available");
    if (state.phase !== "opened" || closing.started) return;
    closing.started = true;
    window.setTimeout(() => quit().catch(updateProblem), CLOSE_DELAY_MS);
  });

  onMount(() => {
    AutoCheckForUpdate()
      .then((state) => setUpdateInfo(state))
      .catch(updateProblem);
  });

  async function install() {
    const yes = await askConfirm({
      title: "Update PracticeMusic",
      message: installQuestion(updateInfo()),
      confirmLabel: "Download and install",
    });
    if (yes) await InstallUpdate().catch(updateProblem);
  }

  return (
    <div class="service-bar update-bar" role="status" data-on={updateShown() ? "true" : "false"}>
      <LiveText class="service-text" text={updateText()} />
      <div class="service-actions">
        <button
          class="krate-button krate-button-primary krate-button-sm"
          type="button"
          showIf={updateOffer()}
          onClick={install}
        >
          <Icon name="lucide:download" />
          Update
        </button>
        <button
          class="krate-button krate-button-secondary krate-button-sm"
          type="button"
          showIf={updatePage()}
          onClick={() => OpenReleasePage().catch(updateProblem)}
        >
          <Icon name="lucide:external-link" />
          Release notes
        </button>
        <button
          class="krate-button krate-button-secondary krate-button-sm"
          type="button"
          showIf={updateBusy()}
          onClick={() => CancelUpdate().catch(updateProblem)}
        >
          Cancel
        </button>
        <button
          class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
          type="button"
          showIf={updatePage()}
          aria-label="Hide the update message"
          data-tip="Hide until the app is started again"
          onClick={() =>
            HideUpdate()
              .then((state) => setUpdateInfo(state))
              .catch(updateProblem)
          }
        >
          <Icon name="lucide:x" />
        </button>
      </div>
    </div>
  );
}
