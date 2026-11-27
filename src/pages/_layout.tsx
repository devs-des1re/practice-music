import "../globals.css";
import { onMount } from "@krate/runtime";
import { Health, GetSettings } from "../../api/host.go";
import { TooltipHost } from "../components/ui/tooltip";
import { ModalHost } from "../components/blocks/modal-host";
import { applyScale } from "../lib/appearance";
import { logFailure } from "../lib/service";

export default function Layout({ children }: { children?: any }) {
  onMount(() => {
    Health().catch((e) => logFailure("host did not answer", e));
    GetSettings()
      .then((doc) => applyScale(doc.settings.appearance.uiScale))
      .catch((e) => logFailure("could not read settings", e));
  });

  return (
    <div class="shell">
      {children}
      <ModalHost />
      <TooltipHost />
    </div>
  );
}
