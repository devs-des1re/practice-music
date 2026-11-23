import { createSignal, onMount } from "@krate/runtime";
import { Topbar } from "../components/blocks/topbar";
import { PlayerDeck } from "../components/blocks/player-deck";
import { MetronomeDeck } from "../components/blocks/metronome-deck";
import { LibraryPanel } from "../components/blocks/library-panel";
import { MixerPanel } from "../components/blocks/mixer-panel";
import { DownloadsPanel } from "../components/blocks/downloads-panel";
import { BrowserPanel } from "../components/blocks/browser-panel";
import { defaultPanels, loadPanels, lowerCount, savePanels, type PanelKey, type PanelSet } from "../lib/workspace";

export default function Workspace() {
  const [panels, setPanels] = createSignal<PanelSet>(defaultPanels);

  onMount(() => {
    setPanels(loadPanels());
  });

  function setPanel(key: PanelKey, value: boolean) {
    const next = { ...panels(), [key]: value };
    setPanels(next);
    savePanels(next);
  }

  return (
    <div class="screen">
      <Topbar panels={panels()} onToggle={(key) => setPanel(key, !panels()[key])} />
      <main class="ws" data-mixer={panels().mixer ? "true" : "false"} data-lower={lowerCount(panels()) > 0 ? "open" : "closed"} data-count={String(lowerCount(panels()))}>
        <div class="ws-player">
          <PlayerDeck onShowLibrary={() => setPanel("library", true)} />
        </div>
        <div class="ws-metro">
          <MetronomeDeck />
        </div>
        <div class="ws-lower">
          <div class="ws-slot" data-slot="library" showIf={panels().library}>
            <LibraryPanel />
          </div>
          <div class="ws-slot" data-slot="mixer" showIf={panels().mixer}>
            <MixerPanel />
          </div>
          <div class="ws-slot" data-slot="downloads" showIf={panels().downloads}>
            <DownloadsPanel />
          </div>
          <div class="ws-slot" data-slot="browser" showIf={panels().browser}>
            <BrowserPanel open={panels().browser} />
          </div>
        </div>
      </main>
    </div>
  );
}
