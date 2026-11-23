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
} from "../../../api/downloads.go";
import { Select } from "../ui/select";
import { Notice } from "../ui/notice";
import { StatusDot } from "../ui/status-dot";
import { jobTone } from "../../lib/format";
import { logger } from "../../lib/logger";
import type { Job, ToolsState } from "../../lib/types";

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

export function DownloadsPanel() {
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
    <section class="panel ws-panel" data-hue="downloads" data-panel="downloads" aria-label="Downloads">
      <header class="panel-head" data-drag="true">
        <h2 class="panel-title">
          <Icon name="lucide:download" />
          Downloads
        </h2>
        <div class="panel-tools">
          <button class="krate-button krate-button-ghost krate-button-sm" type="button" onClick={() => guard(() => ClearDownloads())}>
            <Icon name="lucide:eraser" />
            Clear finished
          </button>
        </div>
      </header>

      <div class="dl-form">
        <input
          class="krate-input"
          type="url"
          placeholder="Paste a link"
          aria-label="Link to download"
          value={url()}
          onInput={(e: Event) => setUrl((e.target as HTMLInputElement).value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === "Enter") add();
          }}
        />
        <Select id="dl-format" label="Format" value={format()} options={FORMATS} onChange={(v) => chooseFormat(v)} />
        <Select id="dl-quality" label="Quality" value={quality()} options={qualityOptions()} onChange={(v) => setQuality(v)} />
        <button class="krate-button krate-button-primary" type="button" onClick={add}>
          <Icon name="lucide:download" />
          Download
        </button>
      </div>

      <div class="panel-notices">
        <div showIf={!!error()}>
          <Notice tone="bad" text={error()} />
        </div>
        <div showIf={!!info() && !error()}>
          <Notice tone="ok" text={info()} />
        </div>
        <div showIf={tools().ytDlp.source === "missing"}>
          <Notice tone="warn" title="yt-dlp is not installed" text="Install it below. The release is checked against its SHA-256 before use." />
        </div>
        <div showIf={!tools().ffmpeg}>
          <Notice tone="warn" title="ffmpeg was not found" text="MP3 conversion and video merging need ffmpeg on your PATH." />
        </div>
      </div>

      <div class="dl-body">
        <div class="dl-queue">
          <div class="empty-state" showIf={jobs().length === 0}>
            <span class="empty-icon">
              <Icon name="lucide:download" />
            </span>
            <span>No downloads yet</span>
          </div>
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
                {(j.state === "queued" || j.state === "running") && (
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => guard(() => CancelDownload(j.id))}>
                    Cancel
                  </button>
                )}
                {(j.state === "failed" || j.state === "cancelled") && (
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => guard(() => RetryDownload(j.id))}>
                    <Icon name="lucide:rotate-cw" />
                    Retry
                  </button>
                )}
                {(j.state === "done" || j.state === "failed" || j.state === "cancelled") && (
                  <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Remove from the list" onClick={() => guard(() => RemoveDownload(j.id))}>
                    <Icon name="lucide:x" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <aside class="dl-tools" aria-label="Download tools">
          <span class="setup-title">Tools</span>
          <div class="kv">
            <span class="kv-key">yt-dlp</span>
            <span class="kv-value mono">{ytVersion()}</span>
            <span class="kv-key">Latest</span>
            <span class="kv-value mono">{ytLatest()}</span>
            <span class="kv-key">Source</span>
            <span class="kv-value">{ytSource()}</span>
            <span class="kv-key">ffmpeg</span>
            <span class="kv-value mono" title={ffmpegText()}>{ffmpegText()}</span>
            <span class="kv-key">Saves to</span>
            <span class="kv-value mono" title={libDir()}>{libDir()}</span>
          </div>
          <div showIf={!!ytError()}>
            <Notice tone="bad" title="yt-dlp" text={ytError()} />
          </div>
          <div class="detail-actions">
            <button
              class="krate-button krate-button-secondary krate-button-sm"
              type="button"
              disabled={!!ytBusy() || (tools().ytDlp.source === "managed" && !tools().ytDlp.updateAvailable)}
              onClick={() => guard(() => InstallYtDlp())}
            >
              <Icon name="lucide:package" />
              {ytBusy() === "installing" ? "Installing" : installLabel()}
            </button>
            <button class="krate-button krate-button-ghost krate-button-sm" type="button" disabled={!!ytBusy()} onClick={() => guard(() => CheckTools())}>
              <Icon name="lucide:refresh-cw" />
              {ytBusy() === "checking" ? "Checking" : "Check"}
            </button>
          </div>
          <p class="field-hint" showIf={tools().ytDlp.source === "path"}>
            This copy comes from your PATH, so it is not updated here.
          </p>
        </aside>
      </div>
    </section>
  );
}
