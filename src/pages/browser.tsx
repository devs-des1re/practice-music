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
      setInfo("Added to the download queue.");
    } catch (e) {
      setError(describe(e));
    }
  }

  return (
    <main class="page">
      <header class="page-head">
        <h1 class="page-title">
          <Icon name="lucide:globe" />
          Browser
        </h1>
      </header>

      <div showIf={!!error()}>
        <Notice tone="bad" text={error()} />
      </div>
      <div showIf={!!info()}>
        <Notice tone="ok" text={info()} />
      </div>
      <div showIf={!pane().open && !error()}>
        <Notice tone="info" text="Opening the browser pane on the right of the window." />
      </div>

      <Panel>
        <PanelBody>
          <div class="address-bar">
            <button class="krate-button krate-button-ghost krate-button-icon" type="button" aria-label="Home" disabled={!pane().open} onClick={() => go(HOME)}>
              <Icon name="lucide:house" />
            </button>
            <button class="krate-button krate-button-ghost krate-button-icon" type="button" aria-label="Reload" disabled={!pane().open} onClick={() => go(current())}>
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
            <button class="krate-button krate-button-secondary" type="button" disabled={!pane().open} onClick={() => go(address())}>
              <Icon name="lucide:arrow-right" />
              Go
            </button>
          </div>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHead title="Download this page" />
        <PanelBody>
          <p class="field-hint mono">{current()}</p>
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
          <div class="actions">
            <button class="krate-button krate-button-primary" type="button" disabled={!pane().open} onClick={download}>
              <Icon name="lucide:download" />
              Download
            </button>
          </div>
          <p class="field-hint">Download only what you have the right to keep.</p>
        </PanelBody>
      </Panel>
    </main>
  );
}
