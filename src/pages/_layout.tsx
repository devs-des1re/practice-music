import "../globals.css";
import { createSignal, onMount } from "@krate/runtime";
import { Health, GetSettings } from "../../api/host.go";
import { Appbar } from "../components/blocks/appbar";
import { Dock } from "../components/blocks/dock";
import { applyScale } from "../lib/appearance";
import { logger } from "../lib/logger";

export default function Layout({ children }: { children?: any }) {
  const [menu, setMenu] = createSignal(false);

  onMount(() => {
    Health().catch((e) => logger.error("host did not answer", e));
    GetSettings()
      .then((doc) => applyScale(doc.settings.appearance.uiScale))
      .catch((e) => logger.error("could not read settings", e));
  });

  return (
    <div class="shell" data-menu={menu() ? "open" : "closed"}>
      <Appbar onToggle={() => setMenu(!menu())} onNavigate={() => setMenu(false)} />
      <div class="viewport">{children}</div>
      <Dock />
    </div>
  );
}
