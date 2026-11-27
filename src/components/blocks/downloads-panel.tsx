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
import { FoldButton } from "../ui/fold-button";
import { Notice } from "../ui/notice";
import { StatusDot } from "../ui/status-dot";
import { jobTone } from "../../lib/format";
import { askConfirm, askForm } from "../../lib/modal";
import { handleError, logFailure } from "../../lib/service";
import type { Job, ToolsState } from "../../lib/types";

const CHOICES = [
  { value: "mp3:best", label: "MP3 audio, best quality" },
  { value: "mp3:320", label: "MP3 audio, 320 kbps" },
  { value: "mp3:256", label: "MP3 audio, 256 kbps" },
  { value: "mp3:192", label: "MP3 audio, 192 kbps" },
  { value: "mp3:128", label: "MP3 audio, 128 kbps" },
  { value: "mp4:best", label: "MP4 video, best quality" },
  { value: "mp4:1080", label: "MP4 video, 1080p" },
  { value: "mp4:720", label: "MP4 video, 720p" },
  { value: "mp4:480", label: "MP4 video, 480p" },
  { value: "mp4:360", label: "MP4 video, 360p" },
];

const CHOICE_KEY = "pm.download.choice";

const emptyTools: ToolsState = {
  ytDlp: { source: "missing", path: "", version: "", latest: "", updateAvailable: false, busy: "", error: "", checkedAt: 0 },
  ffmpeg: "",
  ffprobe: "",
  libraryDir: "",
};

export function DownloadsPanel() {
  const [jobs, setJobs] = createSignal<Job[]>([]);
  const [tools, setTools] = createSignal<ToolsState>(emptyTools);
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
      .catch((e) => logFailure("tool status failed", e));
  });

  async function guard(action: () => Promise<unknown>) {
    setError("");
    try {
      await action();
    } catch (e) {
      logFailure("download action failed", e);
      handleError(e, setError);
    }
  }

  async function add() {
    const saved = localStorage.getItem(CHOICE_KEY);
    const values = await askForm({
      title: "New download",
      confirmLabel: "Download",
      fields: [
        { key: "url", label: "Link", type: "url", placeholder: "Paste a link", required: true },
        { key: "choice", label: "Format and quality", type: "select", options: CHOICES, value: CHOICES.some((c) => c.value === saved) ? String(saved) : CHOICES[0].value },
      ],
    });
    if (!values) return;
    const [format, quality] = values.choice.split(":");
    await guard(async () => {
      await EnqueueDownload(values.url, format, quality);
      localStorage.setItem(CHOICE_KEY, values.choice);
      setInfo("Added to the queue.");
    });
  }

  async function clearFinished() {
    const yes = await askConfirm({ title: "Clear finished downloads", message: "Remove every finished download from this list? Saved files stay in your library.", confirmLabel: "Clear list", danger: true });
    if (yes) await guard(() => ClearDownloads());
  }

  async function cancelJob(job: Job) {
    const yes = await askConfirm({ title: "Cancel download", message: "Stop downloading " + (job.title || job.url) + "?", confirmLabel: "Stop download", danger: true });
    if (yes) await guard(() => CancelDownload(job.id));
  }

  async function removeJob(job: Job) {
    const yes = await askConfirm({ title: "Remove download", message: "Remove " + (job.title || job.url) + " from this list?", confirmLabel: "Remove", danger: true });
    if (yes) await guard(() => RemoveDownload(job.id));
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
    <section class="panel ws-panel" data-panel="downloads" aria-label="Downloads">
      <header class="panel-head" data-drag="true">
        <h2 class="panel-title">
          <Icon name="lucide:download" />
          Downloads
        </h2>
        <div class="panel-tools">
          <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={jobs().length === 0} onClick={clearFinished}>
            <Icon name="lucide:eraser" />
            Clear finished
          </button>
          <button class="krate-button krate-button-primary krate-button-sm" type="button" onClick={add}>
            <Icon name="lucide:plus" />
            New download
          </button>
          <FoldButton />
        </div>
      </header>

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
                  <button class="krate-button krate-button-secondary krate-button-sm" type="button" onClick={() => cancelJob(j)}>
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
                  <button class="krate-button krate-button-ghost krate-button-icon krate-button-sm" type="button" aria-label="Remove from the list" onClick={() => removeJob(j)}>
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
            <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={!!ytBusy()} onClick={() => guard(() => CheckTools())}>
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
