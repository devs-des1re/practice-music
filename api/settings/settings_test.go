package settings

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func abs(t *testing.T, parts ...string) string {
	t.Helper()
	return filepath.Join(append([]string{t.TempDir()}, parts...)...)
}

func TestFreshStoreReturnsDefaultsWithALibraryFolder(t *testing.T) {
	home := t.TempDir()
	s := NewStore(t.TempDir(), home)
	got, note, err := s.Load()
	if err != nil || note != "" {
		t.Fatalf("load: %v %q", err, note)
	}
	want := filepath.Join(home, "Music", "PracticeMusic")
	if len(got.Library.Folders) != 1 || got.Library.Folders[0] != want {
		t.Fatalf("default library folder %v, want %s", got.Library.Folders, want)
	}
	if got.Appearance.UIScale != 100 || got.Version != Version {
		t.Fatalf("unexpected defaults %+v", got)
	}
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	s := NewStore(t.TempDir(), "")
	in := Defaults("")
	in.Audio = Audio{Host: "wasapi", OutputDevice: "wasapi:out", MonitorDevice: "wasapi:mon", InputDevice: "wasapi:in", SampleRate: 48000, BufferFrames: 128}
	in.Library.Folders = []string{abs(t, "songs")}
	in.Library.NormalizeOnImport = true
	in.Appearance.UIScale = 110
	saved, err := s.Save(in)
	if err != nil {
		t.Fatal(err)
	}
	got, note, err := s.Load()
	if err != nil || note != "" {
		t.Fatalf("load: %v %q", err, note)
	}
	if got.Audio != saved.Audio || got.Appearance != saved.Appearance || got.Library.NormalizeOnImport != true {
		t.Fatalf("round trip mismatch:\n saved %+v\n loaded %+v", saved, got)
	}
	if len(got.Library.Folders) != 1 || got.Library.Folders[0] != saved.Library.Folders[0] {
		t.Fatalf("folders lost: %v", got.Library.Folders)
	}
}

func TestSaveLeavesNoTempFilesBehind(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "")
	if _, err := s.Save(Defaults("")); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 || entries[0].Name() != FileName {
		t.Fatalf("expected only %s, found %v", FileName, entries)
	}
}

func TestValidationRejectsBadValuesAndDoesNotTouchTheFile(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "")
	good := Defaults("")
	if _, err := s.Save(good); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(s.Path())
	cases := map[string]func(*Settings){
		"scale too small":    func(x *Settings) { x.Appearance.UIScale = 10 },
		"scale too large":    func(x *Settings) { x.Appearance.UIScale = 400 },
		"odd sample rate":    func(x *Settings) { x.Audio.SampleRate = 12345 },
		"tiny buffer":        func(x *Settings) { x.Audio.BufferFrames = 4 },
		"huge buffer":        func(x *Settings) { x.Audio.BufferFrames = 1 << 20 },
		"relative folder":    func(x *Settings) { x.Library.Folders = []string{"songs/here"} },
		"negative buffer":    func(x *Settings) { x.Audio.BufferFrames = -1 },
		"negative samplerat": func(x *Settings) { x.Audio.SampleRate = -48000 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			bad := good
			bad.Library.Folders = append([]string(nil), good.Library.Folders...)
			mutate(&bad)
			if _, err := s.Save(bad); err == nil {
				t.Fatal("expected a validation error")
			}
		})
	}
	after, _ := os.ReadFile(s.Path())
	if string(before) != string(after) {
		t.Fatal("a rejected save must not modify the stored file")
	}
}

func TestFoldersAreCleanedAndDeduplicated(t *testing.T) {
	base := t.TempDir()
	in := Defaults("")
	in.Library.Folders = []string{
		filepath.Join(base, "a", "..", "songs"),
		filepath.Join(base, "songs"),
		"  ",
		filepath.Join(base, "other"),
	}
	out, err := Normalize(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Library.Folders) != 2 {
		t.Fatalf("want 2 folders, got %v", out.Library.Folders)
	}
	if out.Library.Folders[0] != filepath.Join(base, "songs") {
		t.Fatalf("first folder not cleaned: %s", out.Library.Folders[0])
	}
}

func TestCorruptFileIsQuarantinedNotLost(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "")
	s.now = func() time.Time { return time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC) }
	if err := os.WriteFile(s.Path(), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, note, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.Appearance.UIScale != 100 {
		t.Fatalf("expected defaults, got %+v", got)
	}
	if !strings.Contains(note, "settings.invalid-20260304T050607.json") {
		t.Fatalf("note should name the backup, got %q", note)
	}
	if _, err := os.Stat(filepath.Join(dir, "settings.invalid-20260304T050607.json")); err != nil {
		t.Fatalf("backup missing: %v", err)
	}
	if _, err := os.Stat(s.Path()); !os.IsNotExist(err) {
		t.Fatal("the corrupt file should have been moved aside")
	}
}

func TestSettingsFromANewerVersionAreNotOverwrittenSilently(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "")
	if err := os.WriteFile(s.Path(), []byte(`{"version":99}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, note, err := s.Load()
	if err != nil || !strings.Contains(note, "newer version") {
		t.Fatalf("want a newer-version note, got %q %v", note, err)
	}
}

func TestPartialFilesGetDefaultsForMissingFields(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()
	s := NewStore(dir, home)
	if err := os.WriteFile(s.Path(), []byte(`{"version":1,"audio":{"host":"wasapi"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, note, err := s.Load()
	if err != nil || note != "" {
		t.Fatalf("load: %v %q", err, note)
	}
	if got.Audio.Host != "wasapi" || got.Appearance.UIScale != 100 || len(got.Library.Folders) != 1 {
		t.Fatalf("defaults not merged: %+v", got)
	}
}
