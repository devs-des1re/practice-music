package mixer

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

func TestDefaultHasSixNamedStrips(t *testing.T) {
	st := Default()
	if len(st.Strips) != StripCount {
		t.Fatalf("strips = %d", len(st.Strips))
	}
	ids := []string{"song", "click", "in1", "in2", "in3", "in4"}
	for i, id := range ids {
		if st.Strips[i].ID != id || st.Strips[i].Index != i {
			t.Fatalf("strip %d = %+v", i, st.Strips[i])
		}
	}
	if st.Strips[StripSong].Main != 0 || st.Strips[StripSong].Monitor != OffDB {
		t.Fatalf("song sends = %v/%v", st.Strips[StripSong].Main, st.Strips[StripSong].Monitor)
	}
	if st.Strips[StripInput0].Main != OffDB {
		t.Fatalf("inputs must start off the main bus, got %v", st.Strips[StripInput0].Main)
	}
	if !st.Master.Limiter || st.Master.Ceiling != -0.3 {
		t.Fatalf("master = %+v", st.Master)
	}
}

func TestDefaultIsAlreadyNormal(t *testing.T) {
	d := Default()
	if !Same(Normalize(d), d) {
		t.Fatal("normalising the default must not change it")
	}
}

func TestNormalizeClampsEveryRange(t *testing.T) {
	st := Default()
	st.Strips[2].Gain = 99
	st.Strips[2].Pan = -5
	st.Strips[2].Main = -400
	st.Strips[2].Monitor = 50
	st.Strips[2].EQ = EQ{Low: 40, Mid: -40, High: 15.5}
	st.Strips[2].Comp = Comp{On: true, Threshold: -90, Ratio: 99, Attack: 0, Release: 9000, Makeup: 90}
	st.Strips[2].Source = 99
	st.Master = Master{Main: 30, Monitor: -99, Ceiling: 5, MainChannel: -3, MonitorChannel: 400}
	got := Normalize(st)
	s := got.Strips[2]
	if s.Gain != MaxGain || s.Pan != -1 || s.Main != OffDB || s.Monitor != MaxGain {
		t.Fatalf("levels %+v", s)
	}
	if s.EQ.Low != 15 || s.EQ.Mid != -15 || s.EQ.High != 15 {
		t.Fatalf("eq %+v", s.EQ)
	}
	if s.Comp.Threshold != -60 || s.Comp.Ratio != 20 || s.Comp.Attack != 0.1 || s.Comp.Release != 2000 || s.Comp.Makeup != 24 {
		t.Fatalf("comp %+v", s.Comp)
	}
	if s.Source != 15 {
		t.Fatalf("source %d", s.Source)
	}
	m := got.Master
	if m.Main != MaxGain || m.Monitor != OffDB || m.Ceiling != 0 || m.MainChannel != 0 || m.MonitorChannel != MaxChannel {
		t.Fatalf("master %+v", m)
	}
}

func TestNormalizeRejectsNotANumber(t *testing.T) {
	st := Default()
	st.Strips[0].Gain = math.NaN()
	got := Normalize(st)
	if math.IsNaN(got.Strips[0].Gain) {
		t.Fatal("NaN must not survive")
	}
}

func TestNormalizeRepairsAShortOrEmptyList(t *testing.T) {
	short := Normalize(Board{Strips: []Strip{{Gain: -3}}, Master: Master{Limiter: true, Ceiling: -1}})
	if len(short.Strips) != StripCount || short.Strips[0].Gain != -3 || short.Strips[5].ID != "in4" {
		t.Fatalf("short list not repaired: %+v", short.Strips)
	}
	empty := Normalize(Board{})
	if !Same(empty, Default()) {
		t.Fatal("an empty state must become the default")
	}
	long := Default()
	long.Strips = append(long.Strips, Strip{Index: 9})
	if len(Normalize(long).Strips) != StripCount {
		t.Fatal("extra strips must be dropped")
	}
}

func TestIdentityAndKindCannotBeChanged(t *testing.T) {
	s := NormalizeStrip(1, Strip{ID: "hacked", Kind: "input", Index: 4, Source: 5, Stereo: true})
	if s.ID != "click" || s.Kind != "click" || s.Index != 1 {
		t.Fatalf("identity %+v", s)
	}
	if s.Source != 0 || s.Stereo {
		t.Fatal("only input strips have a source")
	}
}

func TestNamesAreTrimmedShortenedAndNeverEmpty(t *testing.T) {
	s := NormalizeStrip(2, Strip{Name: "   Kick   drum  "})
	if s.Name != "Kick drum" {
		t.Fatalf("name %q", s.Name)
	}
	s = NormalizeStrip(2, Strip{Name: strings.Repeat("x", 80)})
	if len([]rune(s.Name)) != MaxNameRunes {
		t.Fatalf("name length %d", len([]rune(s.Name)))
	}
	s = NormalizeStrip(3, Strip{Name: "   "})
	if s.Name != "Input 2" {
		t.Fatalf("name %q", s.Name)
	}
}

func TestAnUnsetCompressorGetsUsableDefaults(t *testing.T) {
	s := NormalizeStrip(0, Strip{Comp: Comp{On: true}})
	if s.Comp.Ratio != 3 || s.Comp.Threshold != -18 || s.Comp.Attack != 10 || s.Comp.Release != 120 || !s.Comp.On {
		t.Fatalf("comp %+v", s.Comp)
	}
}

func TestJSONRoundTripKeepsTheEngineFieldNames(t *testing.T) {
	data, err := json.Marshal(Default())
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	strip := raw["strips"].([]any)[2].(map[string]any)
	for _, key := range []string{"index", "gain", "pan", "mute", "solo", "main", "monitor", "eq", "comp", "source", "stereo"} {
		if _, ok := strip[key]; !ok {
			t.Fatalf("missing %q", key)
		}
	}
	master := raw["master"].(map[string]any)
	for _, key := range []string{"main", "monitor", "limiter", "ceiling", "mainChannel", "monitorChannel"} {
		if _, ok := master[key]; !ok {
			t.Fatalf("missing master %q", key)
		}
	}
	var back Board
	if err := json.Unmarshal(data, &back); err != nil {
		t.Fatal(err)
	}
	if !Same(back, Default()) {
		t.Fatal("round trip changed the state")
	}
}

func TestSameNoticesAnyDifference(t *testing.T) {
	a := Default()
	b := Default()
	if !Same(a, b) {
		t.Fatal("equal states")
	}
	b.Strips[3].Comp.Ratio = 4
	if Same(a, b) {
		t.Fatal("compressor change missed")
	}
	b = Default()
	b.Master.MonitorChannel = 2
	if Same(a, b) {
		t.Fatal("master change missed")
	}
}

func TestChannelLabelsAreOneBased(t *testing.T) {
	if ChannelLabel(0) != "1-2" || ChannelLabel(2) != "3-4" {
		t.Fatalf("%s %s", ChannelLabel(0), ChannelLabel(2))
	}
}
