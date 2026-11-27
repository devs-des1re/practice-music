package settings

import (
	"os"
	"testing"
)

func TestAFileWithoutPreferencesGetsTheDefaults(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir, "")
	old := `{"version":1,"library":{"folders":[]},"audio":{"mode":"shared"},"appearance":{"uiScale":110}}`
	if err := os.WriteFile(s.Path(), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	got, note, err := s.Load()
	if err != nil || note != "" {
		t.Fatalf("load: %v %q", err, note)
	}
	if got.Preferences != DefaultPreferences() || got.Appearance.UIScale != 110 {
		t.Fatalf("unexpected settings %+v", got)
	}
}

func TestAPartialPreferencesBlockKeepsTheOtherDefaults(t *testing.T) {
	s := NewStore(t.TempDir(), "")
	partial := `{"version":1,"library":{"folders":[]},"audio":{"mode":"shared"},"appearance":{"uiScale":100},"preferences":{"tooltips":false,"seekSeconds":10}}`
	if err := os.WriteFile(s.Path(), []byte(partial), 0o600); err != nil {
		t.Fatal(err)
	}
	got, note, err := s.Load()
	if err != nil || note != "" {
		t.Fatalf("load: %v %q", err, note)
	}
	want := DefaultPreferences()
	want.Tooltips = false
	want.SeekSeconds = 10
	if got.Preferences != want {
		t.Fatalf("got %+v, want %+v", got.Preferences, want)
	}
}

func TestChangedPreferencesSurviveASave(t *testing.T) {
	s := NewStore(t.TempDir(), "")
	in := Defaults("")
	in.Preferences.PeakHoldMs = 0
	in.Preferences.BeatGrid = false
	in.Preferences.TempoStep = 0.5
	if _, err := s.Save(in); err != nil {
		t.Fatal(err)
	}
	got, note, err := s.Load()
	if err != nil || note != "" {
		t.Fatalf("load: %v %q", err, note)
	}
	if got.Preferences != in.Preferences {
		t.Fatalf("got %+v, want %+v", got.Preferences, in.Preferences)
	}
}

func TestOutOfRangePreferencesAreRejected(t *testing.T) {
	for name, change := range map[string]func(*Preferences){
		"glass":  func(p *Preferences) { p.Glass = "frosted" },
		"seek":   func(p *Preferences) { p.SeekSeconds = 0 },
		"speed":  func(p *Preferences) { p.SpeedStep = 90 },
		"fader":  func(p *Preferences) { p.FaderStepDb = 0.3 },
		"tempo":  func(p *Preferences) { p.TempoStep = 0 },
		"format": func(p *Preferences) { p.DownloadChoice = "wav:best" },
	} {
		in := Defaults("")
		change(&in.Preferences)
		if _, err := Normalize(in); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}
