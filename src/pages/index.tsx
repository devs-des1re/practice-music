import { createSignal, createEffect, createMemo } from "@krate/runtime";
import { Engine, RestartEngine } from "../../api/host.go";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Readout } from "../components/ui/readout";
import { StatusDot } from "../components/ui/status-dot";
import { Notice } from "../components/ui/notice";
import { formatRates, stateLabel, stateTone } from "../lib/format";
import { emptyDevices, loadDevices } from "../lib/devices";
import { emptyEngine } from "../lib/engine";
import type { DeviceList, EngineStatus } from "../lib/types";

export default function Overview() {
  const [engine, setEngine] = createSignal<EngineStatus>(emptyEngine);
  const [list, setList] = createSignal<DeviceList>(emptyDevices);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  createEffect(() => {
    const next = Engine();
    if (next) setEngine(next);
  });
  const refresh = () => loadDevices({ setList, setLoaded, setError, setLoading });
  createEffect(() => {
    if (engine().state === "running") refresh();
  });

  const tone = createMemo(() => stateTone(engine().state));
  const label = createMemo(() => stateLabel(engine().state));
  const version = createMemo(() => engine().engineVersion || "-");
  const protocol = createMemo(() => (engine().protocol ? "v" + engine().protocol : "-"));
  const pid = createMemo(() => (engine().pid ? String(engine().pid) : "-"));
  const restarts = createMemo(() => String(engine().restarts || 0));
  const binary = createMemo(() => engine().path || "-");
  const lastError = createMemo(() => engine().lastError || "");
  const errorTone = createMemo(() => (engine().state === "failed" ? "bad" : "warn"));

  return (
    <main class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">Overview</h1>
          <p class="page-sub">Audio engine status and the devices it can see.</p>
        </div>
        <div class="actions">
          <button class="krate-button krate-button-secondary" type="button" onClick={() => RestartEngine()}>
            <Icon name="lucide:rotate-cw" />
            Restart engine
          </button>
        </div>
      </div>

      <Panel>
        <PanelHead title="Audio engine" />
        <PanelBody>
        <div class="status-line">
          <StatusDot tone={tone()} label={label()} />
          <span class="state-text">{stateLabel(engine().state)}</span>
        </div>
        <div class="readout-grid">
          <Readout label="Version" value={version()} />
          <Readout label="Protocol" value={protocol()} />
          <Readout label="Process" value={pid()} />
          <Readout label="Restarts" value={restarts()} />
        </div>
        <Readout label="Binary" value={binary()} />
        <div showIf={!!lastError()}>
          <Notice tone={errorTone()} title="Last engine error">
            {lastError()}
          </Notice>
        </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHead title="Audio devices">
          <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={loading()} onClick={refresh}>
            <Icon name="lucide:refresh-cw" />
            Refresh
          </button>
        </PanelHead>
        <div class="panel-body" showIf={!!error()}>
          <Notice tone="bad" title="Could not list devices">
            {error()}
          </Notice>
        </div>
        <p class="empty" showIf={!error() && engine().state !== "running"}>
          The audio engine is not running, so no devices can be listed.
        </p>
        <p class="empty" showIf={!error() && engine().state === "running" && loaded() && list().devices.length === 0}>
          The engine found no audio devices.
        </p>
        <table class="device-table" showIf={loaded() && list().devices.length > 0}>
          <thead>
            <tr>
              <th>Device</th>
              <th>Driver</th>
              <th>Direction</th>
              <th>Channels</th>
              <th>Sample rates</th>
            </tr>
          </thead>
          <tbody>
            {list().devices.map((d) => (
              <tr key={d.id + d.direction}>
                <td>
                  <div class="device-name">
                    <span>{d.name}</span>
                    <span class="device-id">{d.id}</span>
                  </div>
                </td>
                <td class="num">{d.host}</td>
                <td>
                  <span class="tag">{d.direction}</span>{d.isDefault && <span class="tag" data-tone="accent">default</span>}
                </td>
                <td class="num">{d.maxChannels}</td>
                <td class="num rates">{formatRates(d.sampleRates)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </main>
  );
}
