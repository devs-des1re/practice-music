package bundle

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"practice-music/api/metronome"
	"practice-music/api/mixer"
	"practice-music/api/settings"
)

var home = filepath.Join(os.TempDir(), "drummer")

func sample(t *testing.T) Bundle {
	t.Helper()
	s := settings.Defaults(home)
	s.Audio.OutputDevice = "wasapi:{out-1}"
	s.Audio.MonitorDevice = "wasapi:{phones}"
	s.Audio.InputDevice = "wasapi:{kit}"
	s.Audio.BufferFrames = 128
	m := mixer.Default()
	m.Strips[2].Name = "Kick"
	m.Strips[2].Main = 0
	m.Master.MonitorChannel = 2
	met := metronome.Default()
	met.Bpm = 96
	met.Subdivision = 2
	scene := ScenePayload{Version: 1, Mixer: m, Metronome: met}
	raw, err := json.Marshal(scene)
	if err != nil {
		t.Fatal(err)
	}
	return Build("PracticeMusic 0.1.0", s, m, met, []SceneEntry{{Name: "Lesson", Data: raw}}, time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC))
}

func encode(t *testing.T, b Bundle) []byte {
	t.Helper()
	data, err := Encode(b)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestAnExportDecodesBackToTheSameThing(t *testing.T) {
	b := sample(t)
	got, err := Decode(bytes.NewReader(encode(t, b)), home)
	if err != nil {
		t.Fatal(err)
	}
	if got.Settings.Audio != b.Settings.Audio {
		t.Fatalf("audio %+v", got.Settings.Audio)
	}
	if !mixer.Same(got.Mixer, b.Mixer) || !metronome.Same(got.Metronome, b.Metronome) {
		t.Fatal("mixer or metronome changed")
	}
	if len(got.Scenes) != 1 || got.Scenes[0].Name != "Lesson" {
		t.Fatalf("scenes %+v", got.Scenes)
	}
	if got.ExportedAt != "2026-11-22T10:00:00Z" || got.Format != Format {
		t.Fatalf("header %+v", got)
	}
}

func TestOtherFilesAreRefused(t *testing.T) {
	for _, body := range []string{
		`{}`,
		`not json`,
		`{"format":"something-else","version":1}`,
		`[1,2,3]`,
		``,
	} {
		if _, err := Decode(strings.NewReader(body), ""); err == nil {
			t.Fatalf("accepted %q", body)
		}
	}
}

func TestANewerFormatIsRefusedWithAClearMessage(t *testing.T) {
	b := sample(t)
	b.Version = Version + 1
	_, err := Decode(bytes.NewReader(encode(t, b)), "")
	if err == nil || !strings.Contains(err.Error(), "newer version") {
		t.Fatalf("err %v", err)
	}
	b.Version = 0
	if _, err := Decode(bytes.NewReader(encode(t, b)), ""); err == nil {
		t.Fatal("version 0 accepted")
	}
}

func TestHugeFilesAreRefused(t *testing.T) {
	big := strings.Repeat(" ", MaxBytes+10)
	if _, err := Decode(strings.NewReader(big), ""); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("err %v", err)
	}
}

func TestInvalidSettingsAreRefusedNotRepaired(t *testing.T) {
	b := sample(t)
	b.Settings.Audio.SampleRate = 12345
	if _, err := Decode(bytes.NewReader(encode(t, b)), ""); err == nil || !strings.Contains(err.Error(), "not valid") {
		t.Fatalf("err %v", err)
	}
}

func TestMixerAndMetronomeValuesAreClampedOnTheWayIn(t *testing.T) {
	b := sample(t)
	b.Mixer.Strips[0].Gain = 80
	b.Metronome.Bpm = 9000
	got, err := Decode(bytes.NewReader(encode(t, b)), "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Mixer.Strips[0].Gain != mixer.MaxGain || got.Metronome.Bpm != metronome.MaxBpm {
		t.Fatalf("not clamped: %v %v", got.Mixer.Strips[0].Gain, got.Metronome.Bpm)
	}
}

func TestScenesAreCleanedAndDeduplicated(t *testing.T) {
	b := sample(t)
	b.Scenes = append(b.Scenes,
		SceneEntry{Name: "  lesson ", Data: b.Scenes[0].Data},
		SceneEntry{Name: "Warm  up", Data: json.RawMessage(`{"mixer":{"strips":[]},"metronome":{"bpm":77,"beatsPerBar":3}}`)},
	)
	got, err := Decode(bytes.NewReader(encode(t, b)), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Scenes) != 2 {
		t.Fatalf("scenes %d", len(got.Scenes))
	}
	if got.Scenes[1].Name != "Warm up" {
		t.Fatalf("name %q", got.Scenes[1].Name)
	}
	var payload ScenePayload
	if err := json.Unmarshal(got.Scenes[1].Data, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Metronome.Bpm != 77 || payload.Metronome.BeatsPerBar != 3 || len(payload.Mixer.Strips) != mixer.StripCount {
		t.Fatalf("payload %+v", payload)
	}
}

func TestBrokenScenesAreRefused(t *testing.T) {
	b := sample(t)
	b.Scenes = []SceneEntry{{Name: "Bad", Data: json.RawMessage(`"just a string"`)}}
	if _, err := Decode(bytes.NewReader(encode(t, b)), ""); err == nil || !strings.Contains(err.Error(), "damaged") {
		t.Fatalf("err %v", err)
	}
	b.Scenes = []SceneEntry{{Name: "   ", Data: json.RawMessage(`{}`)}}
	if _, err := Decode(bytes.NewReader(encode(t, b)), ""); err == nil {
		t.Fatal("blank scene name accepted")
	}
}

func TestTooManyScenesAreRefused(t *testing.T) {
	b := sample(t)
	b.Scenes = nil
	for i := 0; i < maxScenes+1; i++ {
		b.Scenes = append(b.Scenes, SceneEntry{Name: strings.Repeat("a", 1+i%30) + string(rune('A'+i%26)), Data: json.RawMessage(`{}`)})
	}
	if _, err := Decode(bytes.NewReader(encode(t, b)), ""); err == nil || !strings.Contains(err.Error(), "more than") {
		t.Fatalf("err %v", err)
	}
}

func TestMissingDevicesAreDroppedAndNamed(t *testing.T) {
	s := sample(t).Settings
	known := map[string]bool{"wasapi:{out-1}": true}
	got, dropped := DropMissingDevices(s, known)
	if got.Audio.OutputDevice != "wasapi:{out-1}" {
		t.Fatalf("output %q", got.Audio.OutputDevice)
	}
	if got.Audio.MonitorDevice != "" || got.Audio.InputDevice != "" {
		t.Fatalf("audio %+v", got.Audio)
	}
	if len(dropped) != 2 || dropped[0] != "monitor device" || dropped[1] != "input device" {
		t.Fatalf("dropped %v", dropped)
	}
	again, none := DropMissingDevices(got, known)
	if len(none) != 0 || again.Audio != got.Audio {
		t.Fatal("a second pass must change nothing")
	}
}

func TestAnExportWithoutScenesStillDecodes(t *testing.T) {
	b := sample(t)
	b.Scenes = nil
	data := encode(t, b)
	if !bytes.Contains(data, []byte(`"scenes": []`)) {
		t.Fatal("scenes should be an empty list, not null")
	}
	got, err := Decode(bytes.NewReader(data), "")
	if err != nil || len(got.Scenes) != 0 {
		t.Fatalf("err %v scenes %d", err, len(got.Scenes))
	}
}
