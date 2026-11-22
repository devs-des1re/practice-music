import { createSignal, createEffect, createMemo } from "@krate/runtime";
import { Engine, RestartEngine } from "../../api/host.go";
import { Songs, LibraryRevision } from "../../api/library.go";
import { PlayerStream } from "../../api/player.go";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Readout } from "../components/ui/readout";
import { StatusDot } from "../components/ui/status-dot";
import { Notice } from "../components/ui/notice";
import { LiveText } from "../components/ui/live-text";
import { formatDurationMs, formatRates, stateLabel, stateTone } from "../lib/format";
import { emptyDevices, loadDevices } from "../lib/devices";
import { emptyEngine } from "../lib/engine";
import { emptyPlayer } from "../lib/player";
import { logger } from "../lib/logger";
import type { DeviceList, EngineStatus, PlayerState, Song } from "../lib/types";

export default function Home() {
  const [engine, setEngine] = createSignal<EngineStatus>(emptyEngine);
  const [list, setList] = createSignal<DeviceList>(emptyDevices);
  const [loaded, setLoaded] = createSignal(false);
  const [error, setError] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [player, setPlayer] = createSignal<PlayerState>(emptyPlayer);
  const [recent, setRecent] = createSignal<Song[]>([]);
  const [nowTitle, setNowTitle] = createSignal("Nothing loaded");
  const [stateText, setStateText] = createSignal("Connecting");

  createEffect(() => {
    const next = Engine();
    if (next) setEngine(next);
  });
  createEffect(() => {
    const next = PlayerStream();
    if (next) setPlayer(next);
  });
  createEffect(() => {
    const p = player();
    setNowTitle(p.loaded ? p.title || "Untitled" : "Nothing loaded");
  });
  createEffect(() => {
    setStateText(stateLabel(engine().state));
  });
  createEffect(() => {
    LibraryRevision();
    Songs({ text: "", tag: "", playlistId: 0, sort: "added" })
      .then((songs) => setRecent(songs.slice(0, 6)))
      .catch((e) => logger.error("recent songs failed", e));
  });

  const refresh = () => loadDevices({ setList, setLoaded, setError, setLoading });
  createEffect(() => {
    if (engine().state === "running") refresh();
  });

  const version = createMemo(() => engine().engineVersion || "-");
  const protocol = createMemo(() => (engine().protocol ? "v" + engine().protocol : "-"));
  const pid = createMemo(() => (engine().pid ? String(engine().pid) : "-"));
  const restarts = createMemo(() => String(engine().restarts || 0));
  const lastError = createMemo(() => engine().lastError || "");
  const errorTone = createMemo(() => (engine().state === "failed" ? "bad" : "warn"));

  return (
    <main class="page">
      <header class="page-head">
        <h1 class="page-title">
          <Icon name="lucide:house" />
          Home
        </h1>
      </header>

      <div class="tiles">
        <Link class="tile" data-hue="library" href="/library">
          <span class="tile-icon">
            <Icon name="lucide:library-big" />
          </span>
          Library
        </Link>
        <Link class="tile" data-hue="player" href="/player">
          <span class="tile-icon">
            <Icon name="lucide:audio-waveform" />
          </span>
          Player
        </Link>
        <Link class="tile" data-hue="metronome" href="/metronome">
          <span class="tile-icon">
            <Icon name="lucide:metronome" />
          </span>
          Metronome
        </Link>
        <Link class="tile" data-hue="mixer" href="/mixer">
          <span class="tile-icon">
            <Icon name="lucide:sliders-vertical" />
          </span>
          Mixer
        </Link>
        <Link class="tile" data-hue="browser" href="/browser">
          <span class="tile-icon">
            <Icon name="lucide:globe" />
          </span>
          Browser
        </Link>
      </div>

      <div class="fill home-ws">
        <div class="col">
          <div class="now-card" data-hue="player">
            <span class="dock-art">
              <Icon name="lucide:music" />
            </span>
            <div class="now-main">
              <span class="now-label">Now loaded</span>
              <LiveText class="now-title" text={nowTitle()} />
            </div>
            <Link class="krate-button krate-button-primary" href="/player">
              <Icon name="lucide:audio-waveform" />
              Open player
            </Link>
          </div>

          <Panel hue="library" grow>
            <PanelHead title="Recently added">
              <Link class="krate-button krate-button-ghost krate-button-sm" href="/library">
                View all
              </Link>
            </PanelHead>
            <div class="empty-state" showIf={recent().length === 0}>
              <span class="empty-icon">
                <Icon name="lucide:list-music" />
              </span>
              <span class="empty-title">No songs yet</span>
              <Link class="krate-button krate-button-secondary" href="/library">
                <Icon name="lucide:file-plus" />
                Import songs
              </Link>
            </div>
            <div class="song-list">
              {recent().map((s) => (
                <Link class="song-row" href={"/player?song=" + s.id} key={s.id}>
                  <span class="thumb">
                    <Icon name="lucide:music" />
                  </span>
                  <span class="song-main">
                    <span class="song-title">{s.title}</span>
                    <span class="song-sub">{s.artist || "Unknown artist"}</span>
                  </span>
                  <span class="song-meta">{formatDurationMs(s.durationMs)}</span>
                </Link>
              ))}
            </div>
          </Panel>
        </div>

        <div class="col">
          <Panel hue="mixer">
            <PanelHead title="Audio engine">
              <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => RestartEngine()}>
                <Icon name="lucide:rotate-cw" />
                Restart
              </button>
            </PanelHead>
            <PanelBody>
              <div class="status-line">
                <StatusDot tone={stateTone(engine().state)} label={stateText()} />
                <LiveText class="state-text" text={stateText()} />
              </div>
              <div class="readout-grid">
                <Readout label="Version" value={version()} />
                <Readout label="Protocol" value={protocol()} />
                <Readout label="Process" value={pid()} />
                <Readout label="Restarts" value={restarts()} />
              </div>
              <div showIf={!!lastError()}>
                <Notice tone={errorTone()} title="Last engine error" text={lastError()} />
              </div>
            </PanelBody>
          </Panel>

          <Panel hue="browser" grow>
            <PanelHead title="Audio devices">
              <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={loading()} onClick={refresh}>
                <Icon name="lucide:refresh-cw" />
                Refresh
              </button>
            </PanelHead>
            <div class="panel-body fixed" showIf={!!error()}>
              <Notice tone="bad" title="Could not list devices" text={error()} />
            </div>
            <p class="empty" showIf={!error() && engine().state !== "running"}>
              The audio engine is not running.
            </p>
            <p class="empty" showIf={!error() && engine().state === "running" && loaded() && list().devices.length === 0}>
              No audio devices found.
            </p>
            <div class="scroll" showIf={loaded() && list().devices.length > 0}>
              <table class="device-table">
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
                        <span class="tag">{d.direction}</span>
                        {d.isDefault && <span class="tag" data-tone="accent">default</span>}
                      </td>
                      <td class="num">{d.maxChannels}</td>
                      <td class="num rates">{formatRates(d.sampleRates)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </main>
  );
}
