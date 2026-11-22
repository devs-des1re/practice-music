import { createSignal, createEffect, createMemo, onMount } from "@krate/runtime";
import {
  EnqueueDownload,
  CancelDownload,
  RetryDownload,
  RemoveDownload,
  ClearDownloads,
  CheckTools,
  InstallYtDlp,
  ToolStatus,
  DownloadList,
  ToolsInfo,
} from "../../api/downloads.go";
import { Panel, PanelHead, PanelBody } from "../components/ui/panel";
import { Field } from "../components/ui/field";
import { Select } from "../components/ui/select";
import { Readout } from "../components/ui/readout";
import { Notice } from "../components/ui/notice";
import { StatusDot } from "../components/ui/status-dot";
import { jobTone } from "../lib/format";
import { logger } from "../lib/logger";
import type { Job, ToolsState } from "../lib/types";

const FORMATS = [
  { value: "mp3", label: "MP3 audio" },
  { value: "mp4", label: "MP4 video" },
];

const MP3_QUALITY = [
  { value: "best", label: "Best" },
  { value: "320", label: "320 kbps" },
  { value: "256", label: "256 kbps" },
  { value: "192", label: "192 kbps" },
  { value: "128", label: "128 kbps" },
];

const MP4_QUALITY = [
  { value: "best", label: "Best" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
  { value: "480", label: "480p" },
  { value: "360", label: "360p" },
];

const emptyTools: ToolsState = {
  ytDlp: { source: "missing", path: "", version: "", latest: "", updateAvailable: false, busy: "", error: "", checkedAt: 0 },
  ffmpeg: "",
  ffprobe: "",
  libraryDir: "",
};

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function DownloadsPage() {
  const [jobs, setJobs] = createSignal<Job[]>([]);
  const [tools, setTools] = createSignal<ToolsState>(emptyTools);
  const [url, setUrl] = createSignal("");
  const [format, setFormat] = createSignal("mp3");
  const [quality, setQuality] = createSignal("best");
  const [error, setError] = createSignal("");
  const [info, setInfo] = createSignal("");

  createEffect(() => {
    const next = DownloadList();
    if (next) setJobs(next);
  });
  createEffect(() => {
    const next = ToolsInfo();
    if (next) setTools(next);
  });

  onMount(() => {
    ToolStatus()
      .then((st) => setTools(st))
      .catch((e) => logger.error("tool status failed", e));
    const savedFormat = localStorage.getItem("pm.download.format");
    const savedQuality = localStorage.getItem("pm.download.quality");
    if (savedFormat) setFormat(savedFormat);
    if (savedQuality) setQuality(savedQuality);
  });

  const qualityOptions = createMemo(() => (format() === "mp4" ? MP4_QUALITY : MP3_QUALITY));

  async function guard(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (e) {
      logger.error("download action failed", e);
      setError(describe(e));
    }
  }

  async function add() {
    const link = url().trim();
    if (!link) return;
    await guard(async () => {
      await EnqueueDownload(link, format(), quality());
      localStorage.setItem("pm.download.format", format());
      localStorage.setItem("pm.download.quality", quality());
      setUrl("");
      setInfo("Added to the queue.");
    });
  }

  function chooseFormat(value: string) {
    setFormat(value);
    setQuality("best");
  }

  const ytVersion = createMemo(() => tools().ytDlp.version || "-");
  const ytLatest = createMemo(() => tools().ytDlp.latest || "-");
  const ytSource = createMemo(() => (tools().ytDlp.source === "managed" ? "Managed by PracticeMusic" : tools().ytDlp.source === "path" ? "Found on PATH" : "Not installed"));
  const ffmpegText = createMemo(() => tools().ffmpeg || "Not found");
  const libDir = createMemo(() => tools().libraryDir || "No library folder set");
  const ytBusy = createMemo(() => tools().ytDlp.busy || "");
  const ytError = createMemo(() => tools().ytDlp.error || "");
  const installLabel = createMemo(() => (tools().ytDlp.source === "managed" ? "Update yt-dlp" : "Install yt-dlp"));

  return (
    <main class="page">
      <div class="page-head">
        <div>
          <h1 class="page-title">Downloads</h1>
          <p class="page-sub">Save songs to your library with yt-dlp.</p>
        </div>
      </div>

      <div showIf={!!error()}>
        <Notice tone="bad" title="Something went wrong">
          {error()}
        </Notice>
      </div>
      <div showIf={!!info() && !error()}>
        <Notice tone="ok" title="Downloads">
          {info()}
        </Notice>
      </div>
      <div showIf={tools().ytDlp.source === "missing"}>
        <Notice tone="warn" title="yt-dlp is not installed">
          Use the Install button in the tools panel. It downloads the official release from GitHub and checks its SHA-256 before using it.
        </Notice>
      </div>
      <div showIf={!tools().ffmpeg}>
        <Notice tone="warn" title="ffmpeg was not found">
          Converting to MP3, merging video and thumbnails need ffmpeg. Install it and make sure it is on your PATH.
        </Notice>
      </div>

      <div class="grid-2">
        <div class="stack">
          <Panel>
            <PanelHead title="New download" />
            <PanelBody>
              <Field label="Link" htmlFor="dl-url" hint="Any page yt-dlp supports. For one video, not a playlist.">
                <input
                  id="dl-url"
                  class="krate-input"
                  type="url"
                  placeholder="https://"
                  value={url()}
                  onInput={(e: Event) => setUrl((e.target as HTMLInputElement).value)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === "Enter") add();
                  }}
                />
              </Field>
              <div class="field-row">
                <Field label="Format" htmlFor="dl-format">
                  <Select id="dl-format" value={format()} options={FORMATS} onChange={(v) => chooseFormat(v)} />
                </Field>
                <Field label="Quality" htmlFor="dl-quality">
                  <Select id="dl-quality" value={quality()} options={qualityOptions()} onChange={(v) => setQuality(v)} />
                </Field>
              </div>
              <div class="actions">
                <button class="krate-button krate-button-primary" type="button" onClick={add}>
                  <Icon name="lucide:download" />
                  Download
                </button>
              </div>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHead title="Tools" />
            <PanelBody>
              <div class="readout-grid">
                <Readout label="yt-dlp" value={ytVersion()} />
                <Readout label="Latest" value={ytLatest()} />
              </div>
              <Readout label="Source" value={ytSource()} />
              <Readout label="ffmpeg" value={ffmpegText()} />
              <Readout label="Saves to" value={libDir()} />
              <div showIf={!!ytError()}>
                <Notice tone="bad" title="yt-dlp">
                  {ytError()}
                </Notice>
              </div>
              <div class="actions">
                <button
                  class="krate-button krate-button-secondary"
                  type="button"
                  disabled={!!ytBusy() || (tools().ytDlp.source === "managed" && !tools().ytDlp.updateAvailable)}
                  onClick={() => guard(() => InstallYtDlp())}
                >
                  <Icon name="lucide:package" />
                  {ytBusy() === "installing" ? "Installing" : installLabel()}
                </button>
                <button class="krate-button krate-button-ghost" type="button" disabled={!!ytBusy()} onClick={() => guard(() => CheckTools())}>
                  {ytBusy() === "checking" ? "Checking" : "Check for updates"}
                </button>
              </div>
              <p class="field-hint" showIf={tools().ytDlp.source === "path"}>
                This copy was found on your PATH, so PracticeMusic will not change it. Install the managed copy for automatic updates.
              </p>
            </PanelBody>
          </Panel>
        </div>

        <Panel>
          <PanelHead title="Queue">
            <button class="krate-button krate-button-ghost krate-button-sm" type="button" onClick={() => guard(() => ClearDownloads())}>
              Clear finished
            </button>
          </PanelHead>
          <p class="empty" showIf={jobs().length === 0}>
            No downloads yet.
          </p>
          <div>
            {jobs().map((j) => (
              <div class="job-row" key={j.id}>
                <div class="job-main">
                  <div class="job-line">
                    <StatusDot tone={jobTone(j.state)} label={j.state} />
                    <span class="job-title">{j.title || j.url}</span>
                    <span class="tag">{j.format + " " + j.quality}</span>
                  </div>
                  <div class="bar">
                    <div class="bar-fill" data-state={j.state} style={"width:" + Math.round(j.percent) + "%"} />
                  </div>
                  <span class="job-info">
                    {j.state === "failed"
                      ? j.error
                      : j.state === "running"
                        ? Math.round(j.percent) + "%  " + j.speed + "  " + (j.eta ? "ETA " + j.eta : "")
                        : j.state === "done"
                          ? "Saved to the library"
                          : j.state}
                  </span>
                </div>
                <div class="detail-actions">
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" showIf={j.state === "queued" || j.state === "running"} onClick={() => guard(() => CancelDownload(j.id))}>
                    Cancel
                  </button>
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" showIf={j.state === "failed" || j.state === "cancelled"} onClick={() => guard(() => RetryDownload(j.id))}>
                    Retry
                  </button>
                  <button class="krate-button krate-button-ghost krate-button-sm" type="button" showIf={j.state === "done" || j.state === "failed" || j.state === "cancelled"} aria-label="Remove from the list" onClick={() => guard(() => RemoveDownload(j.id))}>
                    <Icon name="lucide:x" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </main>
  );
}
