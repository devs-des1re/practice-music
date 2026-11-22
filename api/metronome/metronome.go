package metronome

import (
	"math"
	"slices"
	"strings"
)

const (
	MinBpm         = 20.0
	MaxBpm         = 400.0
	MaxBeats       = 32
	MaxSubdivision = 8
	MaxPoly        = 32
	MaxBars        = 64

	LevelMute   = 0
	LevelSoft   = 1
	LevelNormal = 2
	LevelAccent = 3
)

var Presets = []string{"click", "wood", "beep", "hat", "cowbell"}

var Roles = []string{"accent", "beat", "sub", "poly"}

type State struct {
	Bpm          float64           `json:"bpm"`
	Volume       float64           `json:"volume"`
	BeatsPerBar  int               `json:"beatsPerBar"`
	Subdivision  int               `json:"subdivision"`
	SubLevel     float64           `json:"subLevel"`
	Accents      []int             `json:"accents"`
	PolyBeats    int               `json:"polyBeats"`
	PolyLevel    float64           `json:"polyLevel"`
	PlayBars     int               `json:"playBars"`
	SilentBars   int               `json:"silentBars"`
	Sound        string            `json:"sound"`
	CustomSounds map[string]string `json:"customSounds"`
}

func DefaultAccents(beats int) []int {
	out := make([]int, beats)
	for i := range out {
		out[i] = LevelNormal
	}
	if beats > 1 {
		out[0] = LevelAccent
	}
	return out
}

func Default() State {
	return State{
		Bpm:          120,
		Volume:       0.5,
		BeatsPerBar:  4,
		Subdivision:  1,
		SubLevel:     0.55,
		Accents:      DefaultAccents(4),
		PolyBeats:    0,
		PolyLevel:    0.8,
		PlayBars:     1,
		SilentBars:   0,
		Sound:        "click",
		CustomSounds: map[string]string{},
	}
}

func clamp(v, lo, hi float64) float64 {
	if math.IsNaN(v) {
		return lo
	}
	return math.Min(math.Max(v, lo), hi)
}

func clampInt(v, lo, hi int) int {
	return min(max(v, lo), hi)
}

func Normalize(in State) State {
	def := Default()
	if in.Bpm == 0 && in.Volume == 0 && in.BeatsPerBar == 0 && in.SubLevel == 0 && in.PolyLevel == 0 {
		return def
	}
	out := in
	if out.Bpm == 0 {
		out.Bpm = def.Bpm
	}
	out.Bpm = math.Round(clamp(out.Bpm, MinBpm, MaxBpm)*100) / 100
	out.Volume = clamp(out.Volume, 0, 1)
	if out.BeatsPerBar == 0 {
		out.BeatsPerBar = def.BeatsPerBar
	}
	out.BeatsPerBar = clampInt(out.BeatsPerBar, 1, MaxBeats)
	if out.Subdivision == 0 {
		out.Subdivision = 1
	}
	out.Subdivision = clampInt(out.Subdivision, 1, MaxSubdivision)
	out.SubLevel = clamp(out.SubLevel, 0, 1.5)
	out.PolyBeats = clampInt(out.PolyBeats, 0, MaxPoly)
	out.PolyLevel = clamp(out.PolyLevel, 0, 1.5)
	if out.PlayBars == 0 {
		out.PlayBars = 1
	}
	out.PlayBars = clampInt(out.PlayBars, 1, MaxBars)
	out.SilentBars = clampInt(out.SilentBars, 0, MaxBars)
	if !slices.Contains(Presets, out.Sound) {
		out.Sound = def.Sound
	}
	accents := make([]int, out.BeatsPerBar)
	fallback := DefaultAccents(out.BeatsPerBar)
	for i := range accents {
		if i < len(in.Accents) {
			accents[i] = clampInt(in.Accents[i], LevelMute, LevelAccent)
		} else {
			accents[i] = fallback[i]
		}
	}
	out.Accents = accents
	custom := map[string]string{}
	for role, path := range in.CustomSounds {
		path = strings.TrimSpace(path)
		if path != "" && slices.Contains(Roles, role) {
			custom[role] = path
		}
	}
	out.CustomSounds = custom
	return out
}

func Same(a, b State) bool {
	if a.Bpm != b.Bpm || a.Volume != b.Volume || a.BeatsPerBar != b.BeatsPerBar ||
		a.Subdivision != b.Subdivision || a.SubLevel != b.SubLevel || a.PolyBeats != b.PolyBeats ||
		a.PolyLevel != b.PolyLevel || a.PlayBars != b.PlayBars || a.SilentBars != b.SilentBars ||
		a.Sound != b.Sound || !slices.Equal(a.Accents, b.Accents) || len(a.CustomSounds) != len(b.CustomSounds) {
		return false
	}
	for k, v := range a.CustomSounds {
		if b.CustomSounds[k] != v {
			return false
		}
	}
	return true
}

type Tapper struct {
	taps []int64
}

const (
	tapResetGapUs = 2_500_000
	tapWindow     = 7
)

func (t *Tapper) Reset() {
	t.taps = t.taps[:0]
}

func (t *Tapper) Tap(nowUs int64) (float64, bool) {
	if n := len(t.taps); n > 0 && nowUs-t.taps[n-1] > tapResetGapUs {
		t.taps = t.taps[:0]
	}
	t.taps = append(t.taps, nowUs)
	if len(t.taps) > tapWindow {
		t.taps = t.taps[len(t.taps)-tapWindow:]
	}
	if len(t.taps) < 2 {
		return 0, false
	}
	span := float64(t.taps[len(t.taps)-1] - t.taps[0])
	if span <= 0 {
		return 0, false
	}
	interval := span / float64(len(t.taps)-1)
	bpm := 60_000_000 / interval
	return math.Round(clamp(bpm, MinBpm, MaxBpm)*10) / 10, true
}

func (t *Tapper) Count() int {
	return len(t.taps)
}
