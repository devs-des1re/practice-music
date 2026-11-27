package drums

import (
	"encoding/json"
	"math"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestDefaultsAreNormalAndUseEachNoteOnce(t *testing.T) {
	d := Default()
	got := Normalize(d)
	a, _ := json.Marshal(d)
	b, _ := json.Marshal(got)
	if string(a) != string(b) {
		t.Fatalf("normalising the default changed it:\n%s\n%s", a, b)
	}
	if d.Kit != KitNone {
		t.Fatal("no kit may be chosen until the user picks one")
	}
	seen := map[int]string{}
	for _, p := range d.Pads {
		if p.Sound != SoundNone && !KnownSound(p.Sound) {
			t.Fatalf("pad %s has unknown sound %s", p.ID, p.Sound)
		}
		for _, n := range p.Notes {
			if other, dup := seen[n]; dup {
				t.Fatalf("note %d is on both %s and %s", n, other, p.ID)
			}
			seen[n] = p.ID
		}
	}
	if len(d.Pads) > 24 {
		t.Fatal("the engine takes at most 24 pads")
	}
}

func TestNormalizeRepairsBadValues(t *testing.T) {
	wav := filepath.Join(t.TempDir(), "hit.wav")
	in := Settings{
		Kit: "something", Room: 9, Overheads: math.NaN(), Curve: "bendy", Threshold: -4, PedalThreshold: 900,
		Pads: []Pad{
			{ID: "snare", Label: "Renamed", Notes: []int{38, 38, 300, 36}, Sound: "kazoo", GainDb: 90, Pan: -7, Tune: 40, Sensitivity: 100, Choke: 77},
			{ID: "kick", Notes: []int{36}, Sound: SoundCustom, Files: []string{wav, "relative.wav", filepath.Join(t.TempDir(), "notes.txt")}},
			{ID: "tom1", Sound: SoundCustom},
			{ID: "made_up", Notes: []int{1}},
		},
	}
	got := Normalize(in)
	if got.Kit != KitNone || got.Room != 2 || got.Overheads != 1 || got.Curve != CurveLinear || got.Threshold != 1 || got.PedalThreshold != 127 {
		t.Fatalf("settings %+v", got)
	}
	if len(got.Pads) != len(DefaultPads()) {
		t.Fatalf("pads = %d", len(got.Pads))
	}
	kick := got.Pads[PadIndex(got, "kick")]
	if kick.Sound != SoundCustom || !slices.Equal(kick.Files, []string{wav}) || !slices.Equal(kick.Notes, []int{36}) {
		t.Fatalf("kick %+v", kick)
	}
	snare := got.Pads[PadIndex(got, "snare")]
	if snare.Label != "Snare" || snare.Sound != "snare" || !slices.Equal(snare.Notes, []int{38}) {
		t.Fatalf("snare %+v", snare)
	}
	if snare.GainDb != 12 || snare.Pan != -1 || snare.Tune != 12 || snare.Sensitivity != 4 || snare.Choke != 8 {
		t.Fatalf("snare levels %+v", snare)
	}
	if tom := got.Pads[PadIndex(got, "tom1")]; tom.Sound != "tom1" {
		t.Fatalf("a custom pad without files keeps the kit sound, got %s", tom.Sound)
	}
	if PadIndex(got, "made_up") >= 0 {
		t.Fatal("unknown pads must be dropped")
	}
}

func TestAClearedNoteListStaysCleared(t *testing.T) {
	s := Default()
	s.Pads[PadIndex(s, "china")].Notes = []int{}
	got := Normalize(s)
	if len(got.Pads[PadIndex(got, "china")].Notes) != 0 {
		t.Fatal("cleared notes came back")
	}
}

func TestLearningMovesTheNoteToThatPad(t *testing.T) {
	s := Default()
	got, ok := Learn(s, "floor_tom", 38)
	if !ok {
		t.Fatal("learn failed")
	}
	if slices.Contains(got.Pads[PadIndex(got, "snare")].Notes, 38) {
		t.Fatal("the note must leave the old pad")
	}
	if !slices.Contains(got.Pads[PadIndex(got, "floor_tom")].Notes, 38) {
		t.Fatal("the note did not arrive")
	}
	if !slices.Contains(s.Pads[PadIndex(s, "snare")].Notes, 38) {
		t.Fatal("learn must not change its input")
	}
	if _, ok := Learn(s, "nope", 38); ok {
		t.Fatal("unknown pad accepted")
	}
	if _, ok := Learn(s, "kick", 200); ok {
		t.Fatal("bad note accepted")
	}
}

func TestTheKitListsEveryRecordingOnce(t *testing.T) {
	files := KitFiles()
	if len(files) != 1299 {
		t.Fatalf("kit files = %d", len(files))
	}
	if !slices.Contains(files, "KdrumR/27-KdrumR-KdrumR.flac") || slices.Contains(files, "KdrumR/19-KdrumR-KdrumR.flac") {
		t.Fatal("the velocity map has the wrong hits")
	}
}

func TestNothingIsLoadedUntilAKitIsChosen(t *testing.T) {
	s := Default()
	if !BuildLoad(s, "/kit", 1).Empty() {
		t.Fatal("no kit means no recordings")
	}
	s.Kit = KitMuldjord
	if !BuildLoad(s, "", 1).Empty() {
		t.Fatal("a kit that is not installed cannot be loaded")
	}
	if BuildLoad(s, "/kit", 1).Empty() {
		t.Fatal("expected recordings")
	}
	s.Enabled = false
	if !BuildLoad(s, "/kit", 1).Empty() {
		t.Fatal("switched off drums must not take memory")
	}
}

func TestOnlyChosenSoundsAreLoadedAndOwnFilesWorkWithoutAKit(t *testing.T) {
	s := Default()
	wav := filepath.Join(t.TempDir(), "hit.wav")
	s.Pads[0].Sound, s.Pads[0].Files = SoundCustom, []string{wav}
	req := BuildLoad(s, "", 3)
	if req.Empty() || !slices.Equal(req.Pads[0].Files, []string{wav}) || len(req.Pads[1].Layers) != 0 {
		t.Fatalf("%+v", req.Pads[:2])
	}
	s.Kit = KitMuldjord
	for i := 1; i < len(s.Pads); i++ {
		s.Pads[i].Sound = SoundNone
	}
	s.Pads[1].Sound = "snare"
	req = BuildLoad(s, "/kit", 4)
	if len(req.Pads[1].Layers) != 5 || len(req.Pads[1].Layers[0]) != 9 || len(req.Pads[2].Layers) != 0 {
		t.Fatalf("snare layers wrong")
	}
	body, err := json.Marshal(req)
	if err != nil || strings.Contains(string(body), "null") {
		t.Fatalf("the engine does not accept null lists: %v", err)
	}
}

func TestRoomAndOverheadLevelsShapeTheMix(t *testing.T) {
	s := Default()
	s.Kit = KitMuldjord
	snare := func() []Mic { return BuildLoad(s, "/kit", 1).Pads[1].Layers[0][0] }
	full := snare()
	if len(full) != 6 || full[0].Left != 1 || full[1].Left != 0.5 || full[4].Left != 0.6 || full[4].Right != 0 {
		t.Fatalf("%+v", full)
	}
	s.Room, s.Overheads = 0, 0
	if dry := snare(); len(dry) != 2 {
		t.Fatalf("silent microphones must not be read: %+v", dry)
	}
}

func TestTheEngineSettingsFollowTheChoices(t *testing.T) {
	s := Default()
	s.Curve = CurveSoft
	cfg := BuildConfig(s)
	if cfg.Curve != 0.6 || cfg.Pedal != nil || len(cfg.Pads) != len(s.Pads) {
		t.Fatalf("%+v", cfg)
	}
	s.PedalFollows, s.PedalReversed = true, true
	cfg = BuildConfig(s)
	if cfg.Pedal == nil || cfg.Pedal.OpenPad != PadIndex(s, "hihat_open") || cfg.Pedal.ClosedPad != PadIndex(s, "hihat_closed") || !cfg.Pedal.Reversed {
		t.Fatalf("pedal %+v", cfg.Pedal)
	}
	s.Pads[0].Notes = nil
	body, _ := json.Marshal(BuildConfig(s))
	if strings.Contains(string(body), `"notes":null`) {
		t.Fatal("notes must be a list")
	}
}
