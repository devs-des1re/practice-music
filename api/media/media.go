package media

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"practice-music/api/library"
)

var ErrMissingTool = errors.New("ffmpeg is not installed")

type Tools struct {
	FFmpeg  string
	FFprobe string
}

func exeName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func Locate(managedDir, name string) string {
	if managedDir != "" {
		candidate := filepath.Join(managedDir, exeName(name))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	if path, err := exec.LookPath(name); err == nil {
		return path
	}
	return ""
}

func LocateTools(managedDir string) Tools {
	return Tools{FFmpeg: Locate(managedDir, "ffmpeg"), FFprobe: Locate(managedDir, "ffprobe")}
}

func (t Tools) Available() bool {
	return t.FFmpeg != "" && t.FFprobe != ""
}

func run(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		tail := strings.TrimSpace(stderr.String())
		if len(tail) > 400 {
			tail = tail[len(tail)-400:]
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("%s timed out", filepath.Base(name))
		}
		return nil, fmt.Errorf("%s failed: %v: %s", filepath.Base(name), err, tail)
	}
	return stdout.Bytes(), nil
}

type probeOutput struct {
	Format struct {
		Duration string            `json:"duration"`
		Tags     map[string]string `json:"tags"`
	} `json:"format"`
	Streams []struct {
		CodecType   string `json:"codec_type"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
	} `json:"streams"`
}

func ParseProbe(data []byte) (library.Meta, error) {
	var out probeOutput
	if err := json.Unmarshal(data, &out); err != nil {
		return library.Meta{}, fmt.Errorf("unreadable ffprobe output: %w", err)
	}
	meta := library.Meta{Kind: "audio"}
	if seconds, err := strconv.ParseFloat(out.Format.Duration, 64); err == nil && seconds > 0 && !math.IsInf(seconds, 0) {
		meta.DurationMs = int64(math.Round(seconds * 1000))
	}
	tags := map[string]string{}
	for k, v := range out.Format.Tags {
		tags[strings.ToLower(k)] = strings.TrimSpace(v)
	}
	meta.Title = tags["title"]
	meta.Artist = tags["artist"]
	if meta.Artist == "" {
		meta.Artist = tags["album_artist"]
	}
	meta.Album = tags["album"]
	for _, s := range out.Streams {
		if s.CodecType == "video" && s.Disposition.AttachedPic == 0 {
			meta.Kind = "video"
		}
	}
	return meta, nil
}

func (t Tools) Probe(path string) (library.Meta, error) {
	if t.FFprobe == "" {
		return library.Meta{}, ErrMissingTool
	}
	out, err := run(context.Background(), 30*time.Second, t.FFprobe,
		"-v", "error", "-print_format", "json", "-show_format", "-show_streams", path)
	if err != nil {
		return library.Meta{}, err
	}
	return ParseProbe(out)
}

var sidecarExtensions = []string{".jpg", ".jpeg", ".png", ".webp"}

func Sidecar(path string) string {
	base := strings.TrimSuffix(path, filepath.Ext(path))
	for _, ext := range sidecarExtensions {
		if info, err := os.Stat(base + ext); err == nil && !info.IsDir() {
			return base + ext
		}
	}
	return ""
}

func thumbName(path string) string {
	sum := sha1.Sum([]byte(path))
	return hex.EncodeToString(sum[:8]) + ".jpg"
}

func ThumbArgs(input, output string, video bool) []string {
	args := []string{"-y", "-v", "error"}
	if video {
		args = append(args, "-ss", "1")
	}
	return append(args, "-i", input, "-an", "-frames:v", "1",
		"-vf", "scale='min(320,iw)':-2", "-q:v", "4", output)
}

func (t Tools) MakeThumb(song library.Song, outDir string) (string, error) {
	if t.FFmpeg == "" {
		return "", ErrMissingTool
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return "", err
	}
	name := thumbName(song.Path)
	output := filepath.Join(outDir, name)
	tried := []struct {
		input string
		video bool
	}{}
	if side := Sidecar(song.Path); side != "" {
		tried = append(tried, struct {
			input string
			video bool
		}{side, false})
	}
	tried = append(tried, struct {
		input string
		video bool
	}{song.Path, song.Kind == "video"})
	var last error
	for _, attempt := range tried {
		_ = os.Remove(output)
		if _, err := run(context.Background(), 30*time.Second, t.FFmpeg, ThumbArgs(attempt.input, output, attempt.video)...); err != nil {
			last = err
			continue
		}
		if info, err := os.Stat(output); err == nil && info.Size() > 0 {
			return name, nil
		}
	}
	if last == nil {
		last = errors.New("no thumbnail could be made")
	}
	return "", last
}

func NormaliseArgs(input, output string) []string {
	args := []string{"-y", "-v", "error", "-i", input, "-vn", "-map_metadata", "0", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11"}
	switch strings.ToLower(filepath.Ext(output)) {
	case ".mp3":
		args = append(args, "-c:a", "libmp3lame", "-q:a", "2")
	case ".m4a":
		args = append(args, "-c:a", "aac", "-b:a", "192k")
	case ".flac":
		args = append(args, "-c:a", "flac")
	case ".wav":
		args = append(args, "-c:a", "pcm_s16le")
	case ".ogg":
		args = append(args, "-c:a", "libvorbis", "-q:a", "6")
	case ".opus":
		args = append(args, "-c:a", "libopus", "-b:a", "160k")
	}
	return append(args, output)
}

func NormalisedExtension(ext string) string {
	switch strings.ToLower(ext) {
	case ".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus":
		return strings.ToLower(ext)
	}
	return ".mp3"
}

func (t Tools) Normalise(ctx context.Context, input string) (string, error) {
	if t.FFmpeg == "" {
		return "", ErrMissingTool
	}
	ext := NormalisedExtension(filepath.Ext(input))
	dir := filepath.Dir(input)
	base := strings.TrimSuffix(filepath.Base(input), filepath.Ext(input))
	tmp := filepath.Join(dir, ".norm-"+base+ext)
	final := filepath.Join(dir, base+ext)
	if _, err := run(ctx, 10*time.Minute, t.FFmpeg, NormaliseArgs(input, tmp)...); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if final != input {
		if _, err := os.Stat(final); err == nil {
			_ = os.Remove(tmp)
			return "", fmt.Errorf("%s already exists", filepath.Base(final))
		}
	}
	if err := os.Rename(tmp, final); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	if final != input {
		_ = os.Remove(input)
	}
	return final, nil
}
