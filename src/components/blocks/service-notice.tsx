import { createSignal, createEffect, onMount, onCleanup } from "@krate/runtime";
import { AudioStream } from "../../../api/audio.go";
import { Engine, Health } from "../../../api/host.go";
import { LiveText } from "../ui/live-text";
import { countdownText } from "../../lib/errors";
import { noteAudioRunning, reportOnline, requestAudio, retryAudio, serviceState, subscribeService, type ServiceState } from "../../lib/service";

const PROBE_FIRST_MS = 1000;
const PROBE_MAX_MS = 10000;

export function ServiceNotice() {
  const [snap, setSnap] = createSignal<ServiceState>(serviceState());
  const [text, setText] = createSignal("");
  const [shown, setShown] = createSignal(false);
  const [tone, setTone] = createSignal("warn");
  const [audioIssue, setAudioIssue] = createSignal(false);
  const [dismissed, setDismissed] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    const stop = subscribeService((s) => setSnap(s));
    const tick = window.setInterval(() => setSnap({ ...serviceState() }), 1000);
    onCleanup(() => {
      stop();
      window.clearInterval(tick);
    });
  });

  createEffect(() => {
    const s = snap();
    let message = "";
    let kind = "warn";
    let audio = false;
    if (s.offline) {
      message = "Lost contact with the PracticeMusic host. Reconnecting automatically.";
      kind = "bad";
    } else if (s.audio === "failed") {
      message = "Audio output is unavailable. " + s.message + " " + countdownText(s.retryAt, Date.now());
      audio = true;
    } else if (s.audio === "paused") {
      message = "Audio output is unavailable. " + s.message + " Automatic retries have stopped.";
      audio = true;
    }
    setText(message.trim());
    setTone(kind);
    setAudioIssue(audio);
    setShown(message !== "" && dismissed() !== s.audio + s.message + s.offline);
  });

  createEffect(() => {
    const audio = AudioStream();
    const engine = Engine();
    const running = !!audio && audio.running;
    noteAudioRunning(running);
    if (engine && engine.state === "running" && !running) requestAudio();
  });

  createEffect(() => {
    if (!snap().offline) return;
    let attempt = 0;
    let timer = 0;
    const probe = async () => {
      try {
        await Health();
        reportOnline();
      } catch {
        attempt += 1;
        timer = window.setTimeout(probe, Math.min(PROBE_MAX_MS, PROBE_FIRST_MS * 2 ** attempt));
      }
    };
    timer = window.setTimeout(probe, PROBE_FIRST_MS);
    onCleanup(() => window.clearTimeout(timer));
  });

  async function retry() {
    setBusy(true);
    try {
      if (snap().offline) {
        await Health();
        reportOnline();
      } else {
        await retryAudio();
      }
    } catch {
      return;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="service-bar" role="status" data-tone={tone()} data-on={shown() ? "true" : "false"}>
      <LiveText class="service-text" text={text()} />
      <div class="service-actions">
        <button class="krate-button krate-button-secondary krate-button-sm" type="button" disabled={busy()} onClick={retry}>
          <Icon name="lucide:rotate-cw" />
          Retry now
        </button>
        <Link class="krate-button krate-button-secondary krate-button-sm" href="/settings" showIf={audioIssue()}>
          Audio settings
        </Link>
        <button
          class="krate-button krate-button-ghost krate-button-icon krate-button-sm"
          type="button"
          aria-label="Dismiss this message"
          data-tip="Hide until something changes"
          onClick={() => setDismissed(snap().audio + snap().message + snap().offline)}
        >
          <Icon name="lucide:x" />
        </button>
      </div>
    </div>
  );
}
