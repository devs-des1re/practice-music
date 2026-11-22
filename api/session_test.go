package api

import (
	"os"
	"path/filepath"
	"testing"

	"practice-music/api/metronome"
	"practice-music/api/mixer"
	"practice-music/api/persist"
)

func resetSession(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	sessMu.Lock()
	mixState = mixer.Default()
	metroState = metronome.Default()
	sessionDir = dir
	sessMu.Unlock()
	return dir
}

func TestSavedSessionStateIsLoadedAgain(t *testing.T) {
	dir := resetSession(t)
	sessMu.Lock()
	mixState.Strips[2].Name = "Kick"
	mixState.Strips[2].Main = -3
	mixState.Master.MonitorChannel = 2
	metroState.Bpm = 88
	metroState.Subdivision = 3
	sessMu.Unlock()
	saveSessionNow()
	for _, name := range []string{"mixer.json", "metronome.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatalf("%s was not written: %v", name, err)
		}
	}
	sessMu.Lock()
	mixState = mixer.Default()
	metroState = metronome.Default()
	sessMu.Unlock()
	loadSession(dir)
	got := GetMixerForTest()
	if got.Strips[2].Name != "Kick" || got.Strips[2].Main != -3 || got.Master.MonitorChannel != 2 {
		t.Fatalf("mixer %+v", got)
	}
	sessMu.Lock()
	defer sessMu.Unlock()
	if metroState.Bpm != 88 || metroState.Subdivision != 3 {
		t.Fatalf("metronome %+v", metroState)
	}
}

func GetMixerForTest() mixer.Board {
	sessMu.Lock()
	defer sessMu.Unlock()
	return copyMixer(mixState)
}

func TestLoadingClampsWhatTheFileSays(t *testing.T) {
	dir := resetSession(t)
	bad := mixer.Default()
	bad.Strips[0].Gain = 500
	if err := persist.Save(filepath.Join(dir, "mixer.json"), bad); err != nil {
		t.Fatal(err)
	}
	if err := persist.Save(filepath.Join(dir, "metronome.json"), metronome.Setup{Bpm: 9000, BeatsPerBar: 3, Volume: 0.5}); err != nil {
		t.Fatal(err)
	}
	loadSession(dir)
	if got := GetMixerForTest(); got.Strips[0].Gain != mixer.MaxGain {
		t.Fatalf("gain %v", got.Strips[0].Gain)
	}
	sessMu.Lock()
	defer sessMu.Unlock()
	if metroState.Bpm != metronome.MaxBpm || len(metroState.Accents) != 3 {
		t.Fatalf("metronome %+v", metroState)
	}
}

func TestABrokenFileFallsBackToDefaults(t *testing.T) {
	dir := resetSession(t)
	if err := os.WriteFile(filepath.Join(dir, "mixer.json"), []byte("{oops"), 0o600); err != nil {
		t.Fatal(err)
	}
	loadSession(dir)
	if !mixer.Same(GetMixerForTest(), mixer.Default()) {
		t.Fatal("a broken file must leave the defaults in place")
	}
}

func TestCopiesDoNotShareMemoryWithTheLiveState(t *testing.T) {
	resetSession(t)
	m := GetMixerForTest()
	m.Strips[0].Gain = -20
	if GetMixerForTest().Strips[0].Gain != 0 {
		t.Fatal("changing a copy changed the live mixer")
	}
	sessMu.Lock()
	met := copyMetronome(metroState)
	sessMu.Unlock()
	met.Accents[0] = 0
	met.CustomSounds["beat"] = "x.wav"
	sessMu.Lock()
	defer sessMu.Unlock()
	if metroState.Accents[0] != metronome.LevelAccent || len(metroState.CustomSounds) != 0 {
		t.Fatal("changing a copy changed the live metronome")
	}
}

func TestMetronomeParamsCarryEverythingTheEngineNeeds(t *testing.T) {
	st := metronome.Default()
	st.Bpm = 77
	st.PolyBeats = 3
	running := true
	p := metronomeParams(st, true, &running)
	if *p.Bpm != 77 || *p.PolyBeats != 3 || p.Sound == nil || *p.Sound != "click" || !*p.Running {
		t.Fatalf("params %+v", p)
	}
	if len(p.Accents) != 4 {
		t.Fatalf("accents %v", p.Accents)
	}
	if q := metronomeParams(st, false, nil); q.Sound != nil || q.Running != nil {
		t.Fatalf("sound and running must be left out: %+v", q)
	}
}
