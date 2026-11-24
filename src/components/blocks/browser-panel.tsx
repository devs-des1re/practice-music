import { createSignal, createEffect, onCleanup } from "@krate/runtime";
import { EnqueueDownload } from "../../../api/downloads.go";
import { OpenBrowser, BrowserGo, CloseBrowser, BrowserState } from "../../../api/browser.go";
import { Select } from "../ui/select";
import { FoldButton } from "../ui/fold-button";
import { Notice } from "../ui/notice";
import { normaliseAddress } from "../../lib/format";
import { handleError, logFailure } from "../../lib/service";
import type { BrowserInfo } from "../../lib/types";

const HOME = "https://duckduckgo.com/";

const MP3 = [
  { value: "best", label: "Best" },
  { value: "320", label: "320 kbps" },
  { value: "192", label: "192 kbps" },
  { value: "128", label: "128 kbps" },
];

const MP4 = [
  { value: "best", label: "Best" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
];

export interface BrowserPanelProps {
  open: boolean;
}

export function BrowserPanel(props: BrowserPanelProps) {
  const [address, setAddress] = createSignal(HOME);
  const [page, setPage] = createSignal(HOME);
  const [pane, setPane] = createSignal<BrowserInfo>({ open: false, view: "", url: "", error: "" });
  const [format, setFormat] = createSignal("mp3");
  const [quality, setQuality] = createSignal("best");
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");

  createEffect(() => {
    const next = BrowserState();
    if (next) setPane(next);
  });

  createEffect(() => {
    const url = pane().url;
    if (url) {
      setPage(url);
      setAddress(url);
    }
  });

  createEffect(() => {
    if (props.open) {
      setError("");
      OpenBrowser(HOME).catch((e) => {
        logFailure("browser pane failed", e);
        handleError(e, setError);
      });
    } else {
      CloseBrowser().catch(() => undefined);
    }
  });

  onCleanup(() => {
    CloseBrowser().catch(() => undefined);
  });

  async function go(target: string) {
    const next = normaliseAddress(target);
    if (!next) return;
    setError("");
    try {
      await BrowserGo(next);
      setAddress(next);
    } catch (e) {
      handleError(e, setError);
    }
  }

  async function download() {
    setError("");
    setInfo("");
    try {
      await EnqueueDownload(page(), format(), quality());
      setInfo("Added to the download queue.");
    } catch (e) {
      handleError(e, setError);
    }
  }

  return (
    <section class="panel ws-panel" data-panel="browser" aria-label="Browser">
      <header class="panel-head" data-drag="true">
        <h2 class="panel-title">
          <Icon name="lucide:globe" />
          Browser
        </h2>
        <div class="panel-tools">
          <FoldButton />
        </div>
      </header>

      <div class="browser-body">
        <div class="address-bar">
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Home" disabled={!pane().open} onClick={() => go(HOME)}>
            <Icon name="lucide:house" />
          </button>
          <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Reload" disabled={!pane().open} onClick={() => go(page())}>
            <Icon name="lucide:rotate-cw" />
          </button>
          <div class="search-box grow">
            <Icon name="lucide:globe" />
            <input
              class="krate-input"
              type="text"
              aria-label="Address"
              placeholder="Search or enter a site"
              value={address()}
              onInput={(e: Event) => setAddress((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") go(address());
              }}
            />
          </div>
        </div>

        <div class="panel-notices">
          <div showIf={!!error()}>
            <Notice tone="bad" text={error()} />
          </div>
          <div showIf={!!info() && !error()}>
            <Notice tone="ok" text={info()} />
          </div>
        </div>

        <span class="setup-title">Download this page</span>
        <p class="field-hint mono path">{page()}</p>
        <div class="browser-dl">
          <Select
            id="br-format"
            label="Format"
            value={format()}
            options={[
              { value: "mp3", label: "MP3 audio" },
              { value: "mp4", label: "MP4 video" },
            ]}
            onChange={(v) => {
              setFormat(v);
              setQuality("best");
            }}
          />
          <Select id="br-quality" label="Quality" value={quality()} options={format() === "mp4" ? MP4 : MP3} onChange={(v) => setQuality(v)} />
          <button class="krate-button krate-button-primary" type="button" disabled={!pane().open} onClick={download}>
            <Icon name="lucide:download" />
            Download
          </button>
        </div>
        <p class="field-hint">Download only what you have the right to keep.</p>
      </div>
    </section>
  );
}
