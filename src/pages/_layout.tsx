import "../globals.css";
import { createSignal, onMount } from "@krate/runtime";
import { Health, GetSettings } from "../../api/host.go";
import { Sidebar } from "../components/blocks/sidebar";
import { Topbar } from "../components/blocks/topbar";
import { applyScale } from "../lib/appearance";
import { logger } from "../lib/logger";

const COLLAPSE_KEY = "pm.sidebar.collapsed";

export default function Layout({ children }: { children?: any }) {
  const [collapsed, setCollapsed] = createSignal(false);
  const [drawer, setDrawer] = createSignal(false);

  onMount(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    Health().catch((e) => logger.error("host did not answer", e));
    GetSettings()
      .then((doc) => applyScale(doc.settings.appearance.uiScale))
      .catch((e) => logger.error("could not read settings", e));
  });

  function toggle() {
    const next = !collapsed();
    setCollapsed(next);
    localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
  }

  return (
    <div class="app" data-collapsed={collapsed() ? "true" : "false"} data-drawer={drawer() ? "open" : "closed"}>
      <Sidebar collapsed={collapsed()} onToggle={toggle} onNavigate={() => setDrawer(false)} />
      <div class="main">
        <Topbar onMenu={() => setDrawer(true)} />
        {children}
      </div>
      <div class="scrim" onClick={() => setDrawer(false)} />
    </div>
  );
}
