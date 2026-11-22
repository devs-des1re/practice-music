package media

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"

	"practice-music/api/library"
)

func TestParseProbeReadsDurationTagsAndKind(t *testing.T) {
	meta, err := ParseProbe([]byte(`{
		"format": {"duration": "183.456", "tags": {"TITLE": " Tom Sawyer ", "Artist": "Rush", "album": "Moving Pictures"}},
		"streams": [{"codec_type": "audio"}, {"codec_type": "video", "disposition": {"attached_pic": 1}}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	want := library.Meta{Title: "Tom Sawyer", Artist: "Rush", Album: "Moving Pictures", DurationMs: 183456, Kind: "audio"}
	if meta != want {
		t.Fatalf("got %+v want %+v", meta, want)
	}
}

func TestParseProbeDetectsRealVideoAndToleratesMissingFields(t *testing.T) {
	meta, err := ParseProbe([]byte(`{"format": {}, "streams": [{"codec_type": "video", "disposition": {"attached_pic": 0}}]}`))
	if err != nil || meta.Kind != "video" || meta.DurationMs != 0 || meta.Title != "" {
		t.Fatalf("%+v %v", meta, err)
	}
	meta, _ = ParseProbe([]byte(`{"format": {"duration": "N/A", "tags": {"album_artist": "Band"}}}`))
	if meta.Artist != "Band" || meta.DurationMs != 0 {
		t.Fatalf("%+v", meta)
	}
	if _, err := ParseProbe([]byte(`not json`)); err == nil {
		t.Fatal("garbage must be an error")
	}
}

func TestNormaliseArgsChooseTheCodecFromTheExtension(t *testing.T) {
	cases := map[string]string{".mp3": "libmp3lame", ".m4a": "aac", ".flac": "flac", ".wav": "pcm_s16le", ".ogg": "libvorbis", ".opus": "libopus"}
	for ext, codec := range cases {
		args := NormaliseArgs("in.x", "out"+ext)
		found := false
		for i, a := range args {
			if a == "-c:a" && args[i+1] == codec {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: no %s in %v", ext, codec, args)
		}
		if args[len(args)-1] != "out"+ext {
			t.Errorf("output must be last: %v", args)
		}
	}
	if NormalisedExtension(".webm") != ".mp3" || NormalisedExtension(".FLAC") != ".flac" {
		t.Fatal("extension mapping wrong")
	}
}

func TestThumbArgsSeekOnlyForVideo(t *testing.T) {
	if !reflect.DeepEqual(ThumbArgs("a.mp3", "o.jpg", false)[:3], []string{"-y", "-v", "error"}) {
		t.Fatal("unexpected prefix")
	}
	for _, a := range ThumbArgs("a.mp3", "o.jpg", false) {
		if a == "-ss" {
			t.Fatal("audio must not seek")
		}
	}
	found := false
	for _, a := range ThumbArgs("a.mp4", "o.jpg", true) {
		if a == "-ss" {
			found = true
		}
	}
	if !found {
		t.Fatal("video should seek past the first black frames")
	}
}

func TestSidecarFindsAnImageNextToTheFile(t *testing.T) {
	dir := t.TempDir()
	song := filepath.Join(dir, "a.mp3")
	os.WriteFile(song, []byte("x"), 0o644)
	if Sidecar(song) != "" {
		t.Fatal("no sidecar yet")
	}
	img := filepath.Join(dir, "a.webp")
	os.WriteFile(img, []byte("x"), 0o644)
	if Sidecar(song) != img {
		t.Fatalf("got %q", Sidecar(song))
	}
}

func TestMissingToolsAreReportedNotPanicked(t *testing.T) {
	var none Tools
	if none.Available() {
		t.Fatal("empty tools are not available")
	}
	if _, err := none.Probe("x.mp3"); err != ErrMissingTool {
		t.Fatalf("got %v", err)
	}
	if _, err := none.MakeThumb(library.Song{Path: "x.mp3"}, t.TempDir()); err != ErrMissingTool {
		t.Fatalf("got %v", err)
	}
	if _, err := none.Normalise(context.Background(), "x.mp3"); err != ErrMissingTool {
		t.Fatalf("got %v", err)
	}
}

func realTools(t *testing.T) Tools {
	t.Helper()
	tools := LocateTools("")
	if !tools.Available() {
		t.Skip("ffmpeg and ffprobe are not installed")
	}
	return tools
}

func makeTone(t *testing.T, tools Tools, path string, seconds string) {
	t.Helper()
	cmd := exec.Command(tools.FFmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration="+seconds,
		"-metadata", "title=Test Tone", "-metadata", "artist=Sine", path)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
}

func TestProbeRealFile(t *testing.T) {
	tools := realTools(t)
	path := filepath.Join(t.TempDir(), "tone.mp3")
	makeTone(t, tools, path, "2")
	meta, err := tools.Probe(path)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Title != "Test Tone" || meta.Artist != "Sine" || meta.Kind != "audio" {
		t.Fatalf("%+v", meta)
	}
	if meta.DurationMs < 1900 || meta.DurationMs > 2300 {
		t.Fatalf("duration %d", meta.DurationMs)
	}
	if _, err := tools.Probe(filepath.Join(t.TempDir(), "missing.mp3")); err == nil {
		t.Fatal("probing a missing file must fail")
	}
}

func TestNormaliseRealFileReplacesItInPlace(t *testing.T) {
	tools := realTools(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "tone.wav")
	makeTone(t, tools, path, "3")
	out, err := tools.Normalise(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if out != path {
		t.Fatalf("wav should stay wav, got %s", out)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
	meta, err := tools.Probe(out)
	if err != nil || meta.DurationMs < 2500 {
		t.Fatalf("normalised file unreadable: %+v %v", meta, err)
	}
}

func TestNormaliseConvertsUnknownContainersToMp3(t *testing.T) {
	tools := realTools(t)
	dir := t.TempDir()
	src := filepath.Join(dir, "tone.webm")
	cmd := exec.Command(tools.FFmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libopus", src)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("webm encode unavailable: %v %s", err, out)
	}
	out, err := tools.Normalise(context.Background(), src)
	if err != nil || filepath.Ext(out) != ".mp3" {
		t.Fatalf("got %q %v", out, err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatal("the original should be replaced")
	}
}

func TestMakeThumbFromACoverImage(t *testing.T) {
	tools := realTools(t)
	dir := t.TempDir()
	song := filepath.Join(dir, "tone.mp3")
	makeTone(t, tools, song, "1")
	cover := filepath.Join(dir, "tone.jpg")
	cmd := exec.Command(tools.FFmpeg, "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:d=1", "-frames:v", "1", cover)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, out)
	}
	name, err := tools.MakeThumb(library.Song{Path: song, Kind: "audio"}, filepath.Join(dir, ".thumbs"))
	if err != nil || name == "" {
		t.Fatalf("%q %v", name, err)
	}
	info, err := os.Stat(filepath.Join(dir, ".thumbs", name))
	if err != nil || info.Size() == 0 {
		t.Fatalf("thumbnail file: %v", err)
	}
}

func TestMakeThumbFailsCleanlyForAudioWithoutArtwork(t *testing.T) {
	tools := realTools(t)
	dir := t.TempDir()
	song := filepath.Join(dir, "plain.mp3")
	makeTone(t, tools, song, "1")
	if name, err := tools.MakeThumb(library.Song{Path: song, Kind: "audio"}, filepath.Join(dir, ".thumbs")); err == nil {
		t.Fatalf("expected no thumbnail, got %q", name)
	}
}
