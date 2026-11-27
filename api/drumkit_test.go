package api

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"practice-music/api/drums"
	"practice-music/api/engine"
)

func resetDrums(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	loadDrums(dir)
	return dir
}

func TestDrumsStartWithNoKitAndDownloadNothing(t *testing.T) {
	dir := resetDrums(t)
	if got := drumSnapshot(); got.Kit != drums.KitNone || got.Port != "" {
		t.Fatalf("%+v", got)
	}
	if drumStatus.Kit.Installed || kitRoot() != "" {
		t.Fatal("no kit may be reported as installed")
	}
	if _, err := os.Stat(filepath.Join(dir, "kits")); err == nil {
		t.Fatal("starting the app must not create or fetch a kit")
	}
}

func TestChoosingTheKitDoesNotDownloadIt(t *testing.T) {
	dir := resetDrums(t)
	saved, err := storeDrums(func(s drums.Settings) (drums.Settings, error) {
		s.Kit = drums.KitMuldjord
		return s, nil
	})
	if err != nil || saved.Kit != drums.KitMuldjord {
		t.Fatalf("%v %v", saved.Kit, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "kits")); err == nil {
		t.Fatal("choosing the kit must not fetch it")
	}
}

func TestDrumChoicesAreSavedAndLoadedAgain(t *testing.T) {
	dir := resetDrums(t)
	_, err := storeDrums(func(s drums.Settings) (drums.Settings, error) {
		s.Port, s.Curve, s.Threshold = "e-drum", drums.CurveSoft, 12
		s.Pads[drums.PadIndex(s, "snare")].GainDb = -4.5
		next, _ := drums.Learn(s, "floor_tom", 99)
		return next, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	loadDrums(dir)
	got := drumSnapshot()
	if got.Port != "e-drum" || got.Curve != drums.CurveSoft || got.Threshold != 12 {
		t.Fatalf("%+v", got)
	}
	if got.Pads[drums.PadIndex(got, "snare")].GainDb != -4.5 || !slices.Contains(got.Pads[drums.PadIndex(got, "floor_tom")].Notes, 99) {
		t.Fatalf("pads %+v", got.Pads)
	}
}

func TestADamagedDrumFileFallsBackToTheDefaults(t *testing.T) {
	dir := resetDrums(t)
	if err := os.WriteFile(filepath.Join(dir, "drums.json"), []byte("{broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	loadDrums(dir)
	if drumNotice == "" || drumSnapshot().Kit != drums.KitNone {
		t.Fatalf("notice %q", drumNotice)
	}
}

func TestMissingOwnFilesAreLeftOutAndNamed(t *testing.T) {
	here := filepath.Join(t.TempDir(), "here.wav")
	if err := os.WriteFile(here, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := drums.Default()
	s.Pads[0].Sound = drums.SoundCustom
	s.Pads[0].Files = []string{here, filepath.Join(t.TempDir(), "gone.wav")}
	got, missing := withoutMissingFiles(drums.Clone(s))
	if !slices.Equal(got.Pads[0].Files, []string{here}) || !slices.Equal(missing, []string{"gone.wav"}) {
		t.Fatalf("%v %v", got.Pads[0].Files, missing)
	}
	if len(s.Pads[0].Files) != 2 {
		t.Fatal("the saved choice must keep the missing file")
	}
}

func TestOnlyTheNewestLoadReportsProgress(t *testing.T) {
	resetDrums(t)
	drumMu.Lock()
	drumToken = 5
	drumMu.Unlock()
	handleDrumKitEvent(engine.DrumKitEvent{Token: 4, State: "failed", Error: "old"})
	if drumStatus.Load.State != drumLoadIdle {
		t.Fatalf("an old load changed the state: %+v", drumStatus.Load)
	}
	handleDrumKitEvent(engine.DrumKitEvent{Token: 5, State: "ready", Done: 214, Total: 214, Bytes: 7})
	if drumStatus.Load.State != "ready" || drumStatus.Load.Bytes != 7 {
		t.Fatalf("%+v", drumStatus.Load)
	}
	handleDrumKitEvent(engine.DrumKitEvent{Token: 5, State: "ready"})
	if drumStatus.Load.State != drumLoadIdle {
		t.Fatal("an empty kit is idle, not ready")
	}
}

func TestOnlyChangesToSoundsReloadTheKit(t *testing.T) {
	a := drums.Default()
	a.Kit = drums.KitMuldjord
	b := drums.Clone(a)
	b.Pads[1].GainDb, b.Pads[1].Pan, b.Pads[1].Notes, b.Curve, b.Port = -3, 0.2, []int{60}, drums.CurveHard, "x"
	if !sameSounds(a, b) {
		t.Fatal("level and mapping changes must not reload recordings")
	}
	b.Room = 1.2
	if sameSounds(a, b) {
		t.Fatal("a room level change mixes the recordings again")
	}
	c := drums.Clone(a)
	c.Pads[1].Sound = "tom1"
	if sameSounds(a, c) {
		t.Fatal("a new sound must load")
	}
}

func TestAMissingFileWarningSurvivesTheProgressReports(t *testing.T) {
	resetDrums(t)
	drumUpdate(func(s *DrumState) {
		s.Load = DrumLoadState{State: drumLoadRunning, Error: "These sound files were not found: gone.wav"}
	})
	drumMu.Lock()
	drumToken = 9
	drumMu.Unlock()
	handleDrumKitEvent(engine.DrumKitEvent{Token: 9, State: drumLoadRunning, Done: 1, Total: 2})
	handleDrumKitEvent(engine.DrumKitEvent{Token: 9, State: "ready", Done: 2, Total: 2})
	if drumStatus.Load.Error != "These sound files were not found: gone.wav" {
		t.Fatalf("the warning was lost: %+v", drumStatus.Load)
	}
}
