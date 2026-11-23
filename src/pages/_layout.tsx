import "../globals.css";
import { onMount } from "@krate/runtime";
import { Health, GetSettings } from "../../api/host.go";
import { applyScale } from "../lib/appearance";
import { logger } from "../lib/logger";

export default function Layout({ children }: { children?: any }) {
  onMount(() => {
    Health().catch((e) => logger.error("host did not answer", e));
    GetSettings()
      .then((doc) => applyScale(doc.settings.appearance.uiScale))
      .catch((e) => logger.error("could not read settings", e));
  });

  return <div class="shell">{children}</div>;
}
