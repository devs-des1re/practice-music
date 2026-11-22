package downloads

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	markProgress = "PMP "
	markTitle    = "PMT "
	markFile     = "PMF "
)

type YtdlpRunner struct {
	Binary    func() (string, error)
	FFmpegDir func() string
	OutDir    func() (string, error)
	Env       []string
}

func BuildArgs(job Job, outDir, ffmpegDir string) []string {
	args := []string{
		"--newline", "--no-playlist", "--no-warnings", "--progress", "--windows-filenames",
		"--embed-metadata", "--write-thumbnail", "--convert-thumbnails", "jpg",
		"-P", outDir,
		"-o", "%(title).120B [%(id)s].%(ext)s",
		"--progress-template", "download:" + markProgress + "%(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s",
		"--print", "before_dl:" + markTitle + "%(title)s",
		"--print", "after_move:" + markFile + "%(filepath)s",
	}
	if ffmpegDir != "" {
		args = append(args, "--ffmpeg-location", ffmpegDir)
	}
	switch job.Format {
	case "mp4":
		sort := "vcodec:h264,res,acodec:aac"
		if job.Quality != "" && job.Quality != "best" {
			sort = "res:" + job.Quality + ",vcodec:h264,acodec:aac"
		}
		args = append(args, "-S", sort, "--merge-output-format", "mp4")
	default:
		quality := "0"
		if job.Quality != "" && job.Quality != "best" {
			quality = job.Quality + "K"
		}
		args = append(args, "-x", "--audio-format", "mp3", "--audio-quality", quality)
	}
	return append(args, "--", job.URL)
}

func formatSpeed(bytesPerSecond float64) string {
	units := []string{"B/s", "KB/s", "MB/s", "GB/s"}
	i := 0
	for bytesPerSecond >= 1024 && i < len(units)-1 {
		bytesPerSecond /= 1024
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%.0f %s", bytesPerSecond, units[i])
	}
	return fmt.Sprintf("%.1f %s", bytesPerSecond, units[i])
}

func formatETA(seconds float64) string {
	total := int(seconds)
	if total < 0 {
		return ""
	}
	h, m, s := total/3600, total%3600/60, total%60
	if h > 0 {
		return fmt.Sprintf("%d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%d:%02d", m, s)
}

func number(s string) (float64, bool) {
	if s == "" || s == "NA" || s == "None" {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	return v, err == nil
}

type LineEvent struct {
	Progress *Progress
	Title    string
	File     string
}

func ParseLine(line string) LineEvent {
	line = strings.TrimSpace(line)
	switch {
	case strings.HasPrefix(line, markProgress):
		fields := strings.Fields(strings.TrimPrefix(line, markProgress))
		if len(fields) < 5 {
			return LineEvent{}
		}
		downloaded, ok := number(fields[0])
		if !ok {
			return LineEvent{}
		}
		total, hasTotal := number(fields[1])
		if !hasTotal {
			total, hasTotal = number(fields[2])
		}
		p := &Progress{}
		if hasTotal && total > 0 {
			p.Percent = min(100, downloaded/total*100)
		}
		if speed, ok := number(fields[3]); ok {
			p.Speed = formatSpeed(speed)
		}
		if eta, ok := number(fields[4]); ok {
			p.ETA = formatETA(eta)
		}
		return LineEvent{Progress: p}
	case strings.HasPrefix(line, markTitle):
		return LineEvent{Title: strings.TrimSpace(strings.TrimPrefix(line, markTitle))}
	case strings.HasPrefix(line, markFile):
		return LineEvent{File: strings.TrimSpace(strings.TrimPrefix(line, markFile))}
	}
	return LineEvent{}
}

func errorFrom(stderr string) string {
	var last string
	for _, line := range strings.Split(stderr, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ERROR:") {
			last = strings.TrimSpace(strings.TrimPrefix(line, "ERROR:"))
		}
	}
	if last != "" {
		return last
	}
	lines := strings.Split(strings.TrimSpace(stderr), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func (r *YtdlpRunner) Run(ctx context.Context, job Job, onProgress func(Progress)) (Result, error) {
	bin, err := r.Binary()
	if err != nil {
		return Result{}, err
	}
	outDir, err := r.OutDir()
	if err != nil {
		return Result{}, err
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return Result{}, fmt.Errorf("cannot create the library folder: %w", err)
	}
	ffmpegDir := ""
	if r.FFmpegDir != nil {
		ffmpegDir = r.FFmpegDir()
	}
	cmd := exec.CommandContext(ctx, bin, BuildArgs(job, outDir, ffmpegDir)...)
	configure(cmd)
	cmd.WaitDelay = 3 * time.Second
	cmd.Env = append(os.Environ(), r.Env...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{}, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &tailWriter{buf: &stderr, max: 8 << 10}
	if err := cmd.Start(); err != nil {
		return Result{}, fmt.Errorf("could not start yt-dlp: %w", err)
	}
	var res Result
	title := ""
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		ev := ParseLine(sc.Text())
		switch {
		case ev.Progress != nil:
			ev.Progress.Title = title
			onProgress(*ev.Progress)
		case ev.Title != "":
			title = ev.Title
			onProgress(Progress{Title: title})
		case ev.File != "":
			res.Path = ev.File
		}
	}
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		return Result{}, ctx.Err()
	}
	if waitErr != nil {
		msg := errorFrom(stderr.String())
		if msg == "" {
			msg = waitErr.Error()
		}
		return Result{}, errors.New(msg)
	}
	if res.Path == "" {
		return Result{}, errors.New("yt-dlp finished but did not report a file")
	}
	if _, err := os.Stat(res.Path); err != nil {
		return Result{}, fmt.Errorf("the downloaded file is missing: %s", filepath.Base(res.Path))
	}
	res.Title = title
	onProgress(Progress{Percent: 100, Title: title})
	return res, nil
}

type tailWriter struct {
	buf *bytes.Buffer
	max int
}

func (t *tailWriter) Write(p []byte) (int, error) {
	t.buf.Write(p)
	if t.buf.Len() > t.max {
		rest := append([]byte(nil), t.buf.Bytes()[t.buf.Len()-t.max:]...)
		t.buf.Reset()
		t.buf.Write(rest)
	}
	return len(p), nil
}

var _ io.Writer = (*tailWriter)(nil)
