import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { EnqueueDownload } from "../../api/downloads.go";
import { OpenBrowser, BrowserGo, CloseBrowser, BrowserState } from "../../api/browser.go";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Notice } from "../components/ui/notice";
import { normaliseAddress } from "../lib/format";
import { logger } from "../lib/logger";
import type { BrowserInfo } from "../lib/types";

const HOME = "https://duckduckgo.com/";

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function BrowserPage() {
  const [address, setAddress] = createSignal(HOME);
  const [current, setCurrent] = createSignal(HOME);
  const [pane, setPane] = createSignal<BrowserInfo>({ open: false, view: "", url: "", error: "" });
  const [format, setFormat] = createSignal("mp3");
  const [quality, setQuality] = createSignal("best");
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");
  onCleanup(() => {
    CloseBrowser().catch(() => undefined);
  });

  createEffect(() => {
    const next = BrowserState();
    if (next) setPane(next);
  });

  createEffect(() => {
    const url = pane().url;
    if (url) {
      setCurrent(url);
      setAddress(url);
    }
  });

  onMount(async () => {
    try {
      await OpenBrowser(HOME);
    } catch (e) {
      logger.error("browser pane failed", e);
      setError(describe(e));
    }
  });

  async function go(target: string) {
    const next = normaliseAddress(target);
    if (!next) return;
    setError("");
    try {
      await BrowserGo(next);
      setAddress(next);
    } catch (e) {
      setError(describe(e));
    }
  }

  async function download() {
    setError("");
    setInfo("");
    try {
      await EnqueueDownload(current(), format(), quality());
      setInfo("Added to the download queue. Open the Downloads page to follow it.");
    } catch (e) {
      setError(describe(e));
    }
  }

  return (
    <main class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">Browser</h1>
          <p class="page-sub">Find a song on any site, then send the page you are on to the downloader.</p>
        </div>
      </div>

      <div showIf={!!error()}>
        <Notice tone="bad" title="Browser" text={error()} />
      </div>
      <div showIf={!!info()}>
        <Notice tone="ok" title="Downloads" text={info()} />
      </div>
      <div showIf={!pane().open && !error()}>
        <Notice tone="info" title="Opening the browser pane">
          The pane appears on the right of the window.
        </Notice>
      </div>

      <Panel>
        <PanelHead title="Address" />
        <PanelBody>
          <div class="address-bar">
            <button class="krate-button krate-button-ghost krate-button-icon" type="button" aria-label="Home" disabled={!pane().open} onClick={() => go(HOME)}>
              <Icon name="lucide:house" />
            </button>
            <button class="krate-button krate-button-ghost krate-button-icon" type="button" aria-label="Reload" disabled={!pane().open} onClick={() => go(current())}>
              <Icon name="lucide:rotate-cw" />
            </button>
            <input
              class="krate-input grow"
              type="text"
              aria-label="Address"
              placeholder="Search or enter a site"
              value={address()}
              onInput={(e: Event) => setAddress((e.target as HTMLInputElement).value)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter") go(address());
              }}
            />
            <button class="krate-button krate-button-secondary" type="button" disabled={!pane().open} onClick={() => go(address())}>
              Go
            </button>
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHead title="Download this page" />
        <PanelBody>
          <div class="field-row">
            <Field label="Format" htmlFor="br-format">
              <Select
                id="br-format"
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
            </Field>
            <Field label="Quality" htmlFor="br-quality">
              <Select
                id="br-quality"
                value={quality()}
                options={
                  format() === "mp4"
                    ? [
                        { value: "best", label: "Best" },
                        { value: "1080", label: "1080p" },
                        { value: "720", label: "720p" },
                        { value: "480", label: "480p" },
                      ]
                    : [
                        { value: "best", label: "Best" },
                        { value: "320", label: "320 kbps" },
                        { value: "192", label: "192 kbps" },
                        { value: "128", label: "128 kbps" },
                      ]
                }
                onChange={(v) => setQuality(v)}
              />
            </Field>
          </div>
          <p class="field-hint mono">{current()}</p>
          <div class="actions">
            <button class="krate-button krate-button-primary" type="button" disabled={!pane().open} onClick={download}>
              <Icon name="lucide:download" />
              Download
            </button>
          </div>
          <p class="field-hint">
            Only https pages open in the pane. Links to other schemes open in your system browser. Download only what you have the right to keep.
          </p>
        </PanelBody>
      </Panel>
    </main>
  );
}
