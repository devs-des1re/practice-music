package engine

import (
	"encoding/json"
	"testing"
)

func TestMeterFramesDecode(t *testing.T) {
	raw := json.RawMessage(`{"strips":[{"l":0.5,"r":0.25,"clip":true,"gr":3.5},{"l":0,"r":0,"clip":false,"gr":0}],"main":{"l":0.9,"r":0.8,"clip":false,"gr":0},"monitor":{"l":0,"r":0,"clip":false,"gr":0}}`)
	f, err := DecodeMeters(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.Strips) != 2 || f.Strips[0].L != 0.5 || !f.Strips[0].Clip || f.Strips[0].GR != 3.5 {
		t.Fatalf("frame %+v", f)
	}
	if f.Main.R != 0.8 {
		t.Fatalf("main %+v", f.Main)
	}
}

func TestMeterFramesAlwaysHaveAStripList(t *testing.T) {
	f, err := DecodeMeters(json.RawMessage(`{}`))
	if err != nil || f.Strips == nil {
		t.Fatalf("frame %+v err %v", f, err)
	}
	if _, err := DecodeMeters(json.RawMessage(`[`)); err == nil {
		t.Fatal("broken JSON accepted")
	}
}

func TestBeatFramesDecode(t *testing.T) {
	f, err := DecodeBeat(json.RawMessage(`{"seq":42,"beat":2,"bar":7,"beatsPerBar":4,"level":3,"silent":true}`))
	if err != nil {
		t.Fatal(err)
	}
	if f.Seq != 42 || f.Beat != 2 || f.Bar != 7 || f.BeatsPerBar != 4 || f.Level != 3 || !f.Silent {
		t.Fatalf("frame %+v", f)
	}
}

func TestMetronomeParamsOnlySendWhatIsSet(t *testing.T) {
	bpm := 90.0
	sound := "wood"
	data, err := json.Marshal(MetronomeParams{Bpm: &bpm, Sound: &sound, Accents: []int{3, 2}})
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if len(raw) != 3 || raw["bpm"] != 90.0 || raw["sound"] != "wood" {
		t.Fatalf("params %v", raw)
	}
	empty, _ := json.Marshal(MetronomeParams{})
	if string(empty) != "{}" {
		t.Fatalf("empty params %s", empty)
	}
}
