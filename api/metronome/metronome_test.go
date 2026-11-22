package metronome

import (
	"math"
	"slices"
	"testing"
)

func TestDefaultIsAlreadyNormal(t *testing.T) {
	d := Default()
	if !Same(Normalize(d), d) {
		t.Fatalf("normalising the default changed it: %+v", Normalize(d))
	}
	if !slices.Equal(d.Accents, []int{LevelAccent, LevelNormal, LevelNormal, LevelNormal}) {
		t.Fatalf("accents %v", d.Accents)
	}
}

func TestNormalizeOfAZeroStateGivesTheDefault(t *testing.T) {
	if !Same(Normalize(Setup{}), Default()) {
		t.Fatalf("zero state became %+v", Normalize(Setup{}))
	}
}

func TestNormalizeClampsEveryRange(t *testing.T) {
	got := Normalize(Setup{
		Bpm: 900, Volume: 3, BeatsPerBar: 99, Subdivision: 40, SubLevel: 9, PolyBeats: 99,
		PolyLevel: -1, PlayBars: 500, SilentBars: 500, Sound: "kazoo",
	})
	if got.Bpm != MaxBpm || got.Volume != 1 || got.BeatsPerBar != MaxBeats || got.Subdivision != MaxSubdivision {
		t.Fatalf("got %+v", got)
	}
	if got.SubLevel != 1.5 || got.PolyBeats != MaxPoly || got.PolyLevel != 0 || got.PlayBars != MaxBars || got.SilentBars != MaxBars {
		t.Fatalf("got %+v", got)
	}
	if got.Sound != "click" {
		t.Fatalf("sound %q", got.Sound)
	}
	low := Normalize(Setup{Bpm: 3})
	if low.Bpm != MinBpm {
		t.Fatalf("bpm %v", low.Bpm)
	}
}

func TestNotANumberIsNeverKept(t *testing.T) {
	got := Normalize(Setup{Bpm: math.NaN(), Volume: math.NaN()})
	if math.IsNaN(got.Bpm) || math.IsNaN(got.Volume) {
		t.Fatalf("got %+v", got)
	}
}

func TestAccentsFollowTheBarLength(t *testing.T) {
	grown := Normalize(Setup{BeatsPerBar: 6, Accents: []int{3, 1}})
	if !slices.Equal(grown.Accents, []int{3, 1, 2, 2, 2, 2}) {
		t.Fatalf("grown %v", grown.Accents)
	}
	shrunk := Normalize(Setup{BeatsPerBar: 2, Accents: []int{3, 0, 1, 1, 1}})
	if !slices.Equal(shrunk.Accents, []int{3, 0}) {
		t.Fatalf("shrunk %v", shrunk.Accents)
	}
	wild := Normalize(Setup{BeatsPerBar: 3, Accents: []int{9, -4, 2}})
	if !slices.Equal(wild.Accents, []int{3, 0, 2}) {
		t.Fatalf("wild %v", wild.Accents)
	}
}

func TestASingleBeatBarHasNoAccent(t *testing.T) {
	if got := DefaultAccents(1); !slices.Equal(got, []int{LevelNormal}) {
		t.Fatalf("got %v", got)
	}
}

func TestCustomSoundsKeepOnlyKnownRolesWithPaths(t *testing.T) {
	got := Normalize(Setup{Bpm: 100, CustomSounds: map[string]string{
		"accent": " C:/sounds/knock.wav ", "beat": "", "tuba": "C:/x.wav", "poly": "C:/p.wav",
	}})
	if len(got.CustomSounds) != 2 || got.CustomSounds["accent"] != "C:/sounds/knock.wav" || got.CustomSounds["poly"] != "C:/p.wav" {
		t.Fatalf("custom %v", got.CustomSounds)
	}
}

func TestSameNoticesDifferences(t *testing.T) {
	a := Default()
	b := Default()
	if !Same(a, b) {
		t.Fatal("equal")
	}
	b.Accents[2] = LevelMute
	if Same(a, b) {
		t.Fatal("accent change missed")
	}
	b = Default()
	b.CustomSounds = map[string]string{"beat": "x.wav"}
	if Same(a, b) {
		t.Fatal("custom sound change missed")
	}
}

func TestTapTempoNeedsTwoTaps(t *testing.T) {
	var tp Tapper
	if _, ok := tp.Tap(1_000_000); ok {
		t.Fatal("one tap is not a tempo")
	}
	bpm, ok := tp.Tap(1_500_000)
	if !ok || bpm != 120 {
		t.Fatalf("bpm %v ok %v", bpm, ok)
	}
}

func TestTapTempoAveragesSteadyTaps(t *testing.T) {
	var tp Tapper
	var bpm float64
	for i := 0; i < 6; i++ {
		bpm, _ = tp.Tap(int64(i) * 461_538)
	}
	if math.Abs(bpm-130) > 0.2 {
		t.Fatalf("bpm %v", bpm)
	}
}

func TestTapTempoSmoothsAJitteryHand(t *testing.T) {
	var tp Tapper
	jitter := []int64{0, 12_000, -9_000, 15_000, -14_000, 8_000, -6_000}
	var bpm float64
	for i, j := range jitter {
		bpm, _ = tp.Tap(int64(i)*600_000 + j)
	}
	if math.Abs(bpm-100) > 1.5 {
		t.Fatalf("bpm %v", bpm)
	}
}

func TestALongPauseStartsANewMeasurement(t *testing.T) {
	var tp Tapper
	tp.Tap(0)
	tp.Tap(500_000)
	if _, ok := tp.Tap(9_000_000); ok {
		t.Fatal("a tap after a long pause must start over")
	}
	bpm, ok := tp.Tap(9_750_000)
	if !ok || bpm != 80 {
		t.Fatalf("bpm %v ok %v", bpm, ok)
	}
	if tp.Count() != 2 {
		t.Fatalf("count %d", tp.Count())
	}
}

func TestTapTempoIsClamped(t *testing.T) {
	var tp Tapper
	tp.Tap(0)
	bpm, _ := tp.Tap(1000)
	if bpm != MaxBpm {
		t.Fatalf("bpm %v", bpm)
	}
	tp.Reset()
	tp.Tap(0)
	slow, _ := tp.Tap(2_400_000)
	if slow != 25 {
		t.Fatalf("slow %v", slow)
	}
}
