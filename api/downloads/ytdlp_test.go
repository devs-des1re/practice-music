package downloads

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv("PM_FAKE_YTDLP"); mode != "" {
		fakeYtdlp(mode)
		return
	}
	os.Exit(m.Run())
}

func fakeYtdlp(mode string) {
	args := os.Args[1:]
	if record := os.Getenv("PM_FAKE_ARGS"); record != "" {
		_ = os.WriteFile(record, []byte(strings.Join(args, "\n")), 0o600)
	}
	outDir := ""
	for i, a := range args {
		if a == "-P" && i+1 < len(args) {
			outDir = args[i+1]
		}
	}
	switch mode {
	case "ok":
		path := filepath.Join(outDir, "Song [abc].mp3")
		_ = os.WriteFile(path, []byte("audio"), 0o644)
		os.Stdout.WriteString("PMT Song Title\n")
		os.Stdout.WriteString("PMP 500 1000 NA 2048 4\n")
		os.Stdout.WriteString("PMP 1000 1000 NA 1048576 0\n")
		os.Stdout.WriteString("[ExtractAudio] noise line\n")
		os.Stdout.WriteString("PMF " + path + "\n")
	case "fail":
		os.Stderr.WriteString("WARNING: something\nERROR: [youtube] abc: Video unavailable\n")
		os.Exit(1)
	case "nofile":
	case "missingfile":
		os.Stdout.WriteString("PMF " + filepath.Join(outDir, "ghost.mp3") + "\n")
	case "hang":
		os.Stdout.WriteString("PMT Slow\n")
		time.Sleep(time.Minute)
	}
	os.Exit(0)
}

func runner(t *testing.T, mode string) (*YtdlpRunner, string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PM_FAKE_YTDLP", mode)
	dir := t.TempDir()
	return &YtdlpRunner{
		Binary: func() (string, error) { return exe, nil },
		OutDir: func() (string, error) { return filepath.Join(dir, "lib"), nil },
	}, dir
}

func TestBuildArgsForMp3(t *testing.T) {
	args := BuildArgs(Job{URL: "https://x.y/v", Format: "mp3", Quality: "best"}, "/out", "")
	joined := strings.Join(args, " ")
	for _, want := range []string{"-x", "--audio-format mp3", "--audio-quality 0", "-P /out", "--no-playlist", "--embed-metadata"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %s", want, joined)
		}
	}
	if args[len(args)-2] != "--" || args[len(args)-1] != "https://x.y/v" {
		t.Fatalf("the URL must come after --: %v", args[len(args)-3:])
	}
	if strings.Contains(joined, "--ffmpeg-location") {
		t.Fatal("no ffmpeg location was given")
	}
	args = BuildArgs(Job{URL: "https://x.y/v", Format: "mp3", Quality: "192"}, "/out", `C:\tools`)
	joined = strings.Join(args, " ")
	if !strings.Contains(joined, "--audio-quality 192K") || !strings.Contains(joined, `--ffmpeg-location C:\tools`) {
		t.Fatalf("%s", joined)
	}
}

func TestBuildArgsForMp4(t *testing.T) {
	joined := strings.Join(BuildArgs(Job{URL: "https://x.y/v", Format: "mp4", Quality: "720"}, "/out", ""), " ")
	for _, want := range []string{"-S res:720,vcodec:h264,acodec:aac", "--merge-output-format mp4"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %s", want, joined)
		}
	}
	if strings.Contains(joined, " -x ") {
		t.Fatal("video downloads must not extract audio")
	}
	joined = strings.Join(BuildArgs(Job{URL: "https://x.y/v", Format: "mp4", Quality: "best"}, "/out", ""), " ")
	if !strings.Contains(joined, "-S vcodec:h264,res,acodec:aac") {
		t.Fatalf("%s", joined)
	}
}

func TestDashLeadingUrlsCannotBecomeOptions(t *testing.T) {
	args := BuildArgs(Job{URL: "--exec evil", Format: "mp3"}, "/out", "")
	idx := -1
	for i, a := range args {
		if a == "--" {
			idx = i
		}
	}
	if idx < 0 || args[idx+1] != "--exec evil" || idx != len(args)-2 {
		t.Fatalf("%v", args)
	}
}

func TestParseLine(t *testing.T) {
	ev := ParseLine("PMP 500 1000 NA 2048 4")
	if ev.Progress == nil || ev.Progress.Percent != 50 || ev.Progress.Speed != "2.0 KB/s" || ev.Progress.ETA != "0:04" {
		t.Fatalf("%+v", ev.Progress)
	}
	ev = ParseLine("PMP 300 NA 600 NA NA")
	if ev.Progress == nil || ev.Progress.Percent != 50 || ev.Progress.Speed != "" || ev.Progress.ETA != "" {
		t.Fatalf("estimate fallback: %+v", ev.Progress)
	}
	ev = ParseLine("PMP 100 NA NA NA NA")
	if ev.Progress == nil || ev.Progress.Percent != 0 {
		t.Fatalf("unknown total: %+v", ev.Progress)
	}
	ev = ParseLine("PMP 1500 1000 NA 1 3700")
	if ev.Progress.Percent != 100 || ev.Progress.ETA != "1:01:40" {
		t.Fatalf("clamp: %+v", ev.Progress)
	}
	if ev := ParseLine("PMT  A Song  "); ev.Title != "A Song" {
		t.Fatalf("%+v", ev)
	}
	if ev := ParseLine(`PMF C:\lib\a b.mp3`); ev.File != `C:\lib\a b.mp3` {
		t.Fatalf("%+v", ev)
	}
	for _, junk := range []string{"", "[download] 10%", "PMP", "PMP x y", "PMP NA NA NA NA NA"} {
		if ev := ParseLine(junk); ev.Progress != nil || ev.Title != "" || ev.File != "" {
			t.Errorf("%q parsed as %+v", junk, ev)
		}
	}
}

func TestErrorFromPrefersTheLastErrorLine(t *testing.T) {
	if got := errorFrom("WARNING: x\nERROR: first\nERROR: [youtube] abc: Video unavailable\n"); got != "[youtube] abc: Video unavailable" {
		t.Fatalf("%q", got)
	}
	if got := errorFrom("something broke\nlast line"); got != "last line" {
		t.Fatalf("%q", got)
	}
}

func TestRunnerReportsProgressAndTheFinalFile(t *testing.T) {
	r, _ := runner(t, "ok")
	argsFile := filepath.Join(t.TempDir(), "args.txt")
	t.Setenv("PM_FAKE_ARGS", argsFile)
	var updates []Progress
	res, err := r.Run(context.Background(), Job{URL: "https://x.y/v", Format: "mp3", Quality: "192"}, func(p Progress) { updates = append(updates, p) })
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(res.Path) != "Song [abc].mp3" || res.Title != "Song Title" {
		t.Fatalf("%+v", res)
	}
	var sawHalf, sawDone bool
	for _, u := range updates {
		if u.Percent == 50 && u.Title == "Song Title" {
			sawHalf = true
		}
		if u.Percent == 100 {
			sawDone = true
		}
	}
	if !sawHalf || !sawDone {
		t.Fatalf("progress updates %+v", updates)
	}
	recorded, _ := os.ReadFile(argsFile)
	if !strings.Contains(string(recorded), "192K") {
		t.Fatalf("args not passed: %s", recorded)
	}
}

func TestRunnerTurnsYtdlpErrorsIntoReadableMessages(t *testing.T) {
	r, _ := runner(t, "fail")
	_, err := r.Run(context.Background(), Job{URL: "https://x.y/v", Format: "mp3"}, func(Progress) {})
	if err == nil || err.Error() != "[youtube] abc: Video unavailable" {
		t.Fatalf("got %v", err)
	}
}

func TestRunnerRejectsSuccessWithoutAFile(t *testing.T) {
	for _, mode := range []string{"nofile", "missingfile"} {
		r, _ := runner(t, mode)
		if _, err := r.Run(context.Background(), Job{URL: "https://x.y/v", Format: "mp3"}, func(Progress) {}); err == nil {
			t.Errorf("%s: expected an error", mode)
		}
	}
}

func TestRunnerReportsAMissingBinary(t *testing.T) {
	r := &YtdlpRunner{
		Binary: func() (string, error) { return "", os.ErrNotExist },
		OutDir: func() (string, error) { return t.TempDir(), nil },
	}
	if _, err := r.Run(context.Background(), Job{URL: "https://x.y/v"}, func(Progress) {}); err == nil {
		t.Fatal("expected an error")
	}
}

func TestCancellingKillsTheProcessQuickly(t *testing.T) {
	r, _ := runner(t, "hang")
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{}, 1)
	errc := make(chan error, 1)
	go func() {
		_, err := r.Run(ctx, Job{URL: "https://x.y/v", Format: "mp3"}, func(p Progress) {
			if p.Title == "Slow" {
				select {
				case started <- struct{}{}:
				default:
				}
			}
		})
		errc <- err
	}()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("the fake process never started")
	}
	begin := time.Now()
	cancel()
	select {
	case err := <-errc:
		if err == nil {
			t.Fatal("a cancelled run must return an error")
		}
		if time.Since(begin) > 8*time.Second {
			t.Fatalf("cancel took %s", time.Since(begin))
		}
	case <-time.After(15 * time.Second):
		t.Fatal("the process was not killed")
	}
}

func TestManagerWithTheRealRunnerEndToEnd(t *testing.T) {
	r, dir := runner(t, "ok")
	store := newStore()
	done := make(chan Job, 1)
	m := NewManager(store, r, Options{Concurrency: 1, OnDone: func(j Job) { done <- j }})
	t.Cleanup(m.Close)
	if _, err := m.Enqueue(Request{URL: "https://example.com/v", Format: "mp3", Quality: "best"}); err != nil {
		t.Fatal(err)
	}
	select {
	case j := <-done:
		if j.State != StateDone || !strings.HasPrefix(j.FilePath, filepath.Join(dir, "lib")) {
			t.Fatalf("%+v", j)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("download did not finish")
	}
}
