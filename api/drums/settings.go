package drums

import (
	"math"
	"path/filepath"
	"slices"
	"strings"
)

const (
	KitNone     = "none"
	KitMuldjord = "muldjord"

	SoundNone   = "none"
	SoundCustom = "custom"

	CurveSoft   = "soft"
	CurveLinear = "linear"
	CurveHard   = "hard"

	MaxFiles = 32
	MaxNotes = 8
)

type Pad struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Notes       []int    `json:"notes"`
	Sound       string   `json:"sound"`
	Files       []string `json:"files"`
	GainDb      float64  `json:"gainDb"`
	Pan         float64  `json:"pan"`
	Tune        float64  `json:"tune"`
	Sensitivity float64  `json:"sensitivity"`
	Choke       int      `json:"choke"`
}

type Settings struct {
	Enabled        bool    `json:"enabled"`
	Port           string  `json:"port"`
	Kit            string  `json:"kit"`
	Room           float64 `json:"room"`
	Overheads      float64 `json:"overheads"`
	Curve          string  `json:"curve"`
	Threshold      int     `json:"threshold"`
	PedalFollows   bool    `json:"pedalFollows"`
	PedalThreshold int     `json:"pedalThreshold"`
	PedalReversed  bool    `json:"pedalReversed"`
	Pads           []Pad   `json:"pads"`
}

func pad(id, label, sound string, pan float64, choke int, notes ...int) Pad {
	return Pad{
		ID: id, Label: label, Sound: sound, Notes: notes, Files: []string{},
		Pan: pan, Sensitivity: 1, Choke: choke,
	}
}

func DefaultPads() []Pad {
	pedal := pad("hihat_pedal", "Hi-hat pedal", "hh_closed", 0, 1, 44)
	pedal.GainDb = -9
	return []Pad{
		pad("kick", "Kick", "kick_r", 0, 0, 36, 35),
		pad("snare", "Snare", "snare", 0, 0, 38, 40),
		pad("snare_rim", "Snare rim", "snare_rest", 0, 0, 37),
		pad("hihat_closed", "Hi-hat closed", "hh_closed", 0, 1, 42, 22),
		pad("hihat_open", "Hi-hat open", "hh_open", 0, 1, 46, 26),
		pedal,
		pad("tom1", "Tom 1", "tom1", 0, 0, 48, 50),
		pad("tom2", "Tom 2", "tom2", 0, 0, 45, 47),
		pad("floor_tom", "Floor tom", "tom4", 0, 0, 43, 58),
		pad("tom3", "Extra tom", "tom3", 0, 0, 41),
		pad("crash1", "Crash 1", "crash_l", 0, 0, 49, 55),
		pad("crash2", "Crash 2", "crash_r", 0, 0, 57),
		pad("ride", "Ride", "ride_r", 0, 0, 51, 59),
		pad("ride_bell", "Ride bell", "ride_r_bell", 0, 0, 53),
		pad("china", "China", "china", 0, 0, 52),
	}
}

func Default() Settings {
	return Settings{
		Enabled:        true,
		Kit:            KitNone,
		Room:           0.6,
		Overheads:      1,
		Curve:          CurveLinear,
		Threshold:      5,
		PedalThreshold: 80,
		Pads:           DefaultPads(),
	}
}

func clamp(v, lo, hi, fallback float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return fallback
	}
	return math.Min(hi, math.Max(lo, v))
}

func cleanNotes(in []int) []int {
	out := []int{}
	for _, n := range in {
		if n >= 0 && n <= 127 && !slices.Contains(out, n) && len(out) < MaxNotes {
			out = append(out, n)
		}
	}
	return out
}

func IsSoundFile(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".wav", ".flac", ".ogg", ".mp3", ".aif", ".aiff":
		return true
	}
	return false
}

func cleanFiles(in []string) []string {
	out := []string{}
	for _, f := range in {
		if filepath.IsAbs(f) && IsSoundFile(f) && !slices.Contains(out, f) && len(out) < MaxFiles {
			out = append(out, f)
		}
	}
	return out
}

func normalizePad(saved, base Pad) Pad {
	out := base
	if saved.Notes != nil {
		out.Notes = cleanNotes(saved.Notes)
	}
	out.Files = cleanFiles(saved.Files)
	switch {
	case saved.Sound == SoundNone || KnownSound(saved.Sound):
		out.Sound = saved.Sound
	case saved.Sound == SoundCustom && len(out.Files) > 0:
		out.Sound = SoundCustom
	}
	out.GainDb = clamp(saved.GainDb, -24, 12, base.GainDb)
	out.Pan = clamp(saved.Pan, -1, 1, 0)
	out.Tune = clamp(saved.Tune, -12, 12, 0)
	if saved.Sensitivity != 0 {
		out.Sensitivity = clamp(saved.Sensitivity, 0.25, 4, 1)
	}
	out.Choke = min(8, max(0, saved.Choke))
	return out
}

func Normalize(in Settings) Settings {
	def := Default()
	out := in
	if out.Kit != KitMuldjord {
		out.Kit = KitNone
	}
	out.Port = strings.TrimSpace(out.Port)
	out.Room = clamp(in.Room, 0, 2, def.Room)
	out.Overheads = clamp(in.Overheads, 0, 2, def.Overheads)
	switch out.Curve {
	case CurveSoft, CurveLinear, CurveHard:
	default:
		out.Curve = def.Curve
	}
	out.Threshold = min(60, max(1, in.Threshold))
	if in.PedalThreshold == 0 {
		out.PedalThreshold = def.PedalThreshold
	}
	out.PedalThreshold = min(127, max(1, out.PedalThreshold))
	used := map[int]bool{}
	out.Pads = make([]Pad, len(def.Pads))
	for i, base := range def.Pads {
		next := base
		if at := slices.IndexFunc(in.Pads, func(p Pad) bool { return p.ID == base.ID }); at >= 0 {
			next = normalizePad(in.Pads[at], base)
		}
		notes := []int{}
		for _, n := range next.Notes {
			if !used[n] {
				used[n] = true
				notes = append(notes, n)
			}
		}
		next.Notes = notes
		out.Pads[i] = next
	}
	return out
}

func PadIndex(s Settings, id string) int {
	return slices.IndexFunc(s.Pads, func(p Pad) bool { return p.ID == id })
}

func Learn(s Settings, id string, note int) (Settings, bool) {
	at := PadIndex(s, id)
	if at < 0 || note < 0 || note > 127 {
		return s, false
	}
	pads := make([]Pad, len(s.Pads))
	for i, p := range s.Pads {
		p.Notes = slices.DeleteFunc(slices.Clone(p.Notes), func(n int) bool { return n == note })
		pads[i] = p
	}
	notes := append(pads[at].Notes, note)
	if len(notes) > MaxNotes {
		notes = notes[len(notes)-MaxNotes:]
	}
	pads[at].Notes = notes
	s.Pads = pads
	return s, true
}

func Clone(s Settings) Settings {
	pads := make([]Pad, len(s.Pads))
	for i, p := range s.Pads {
		p.Notes = append([]int{}, p.Notes...)
		p.Files = append([]string{}, p.Files...)
		pads[i] = p
	}
	s.Pads = pads
	return s
}
