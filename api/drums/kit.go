package drums

import (
	"fmt"
	"math"
	"path"
	"path/filepath"
	"slices"
)

type run struct {
	first int
	count int
}

type instrument struct {
	folder string
	close  []string
	pan    float64
	layers []run
}

type SoundInfo struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type namedSound struct {
	id    string
	label string
	instrument
}

var sounds = []namedSound{
	{"kick_r", "Kick, right drum", instrument{"KdrumR", []string{"KdrumR"}, 0, []run{{1, 1}, {2, 2}, {4, 6}, {10, 9}, {20, 8}}}},
	{"kick_l", "Kick, left drum", instrument{"KdrumL", []string{"KdrumL"}, 0, []run{{1, 1}, {2, 5}, {7, 5}, {12, 5}, {17, 9}}}},
	{"snare", "Snare", instrument{"Snare", []string{"Snare_top", "Snare_bottom"}, 0, []run{{1, 9}, {10, 10}, {20, 14}, {34, 16}, {50, 7}}}},
	{"snare_rest", "Snare rest", instrument{"SnareRest", []string{"Snare_top", "Snare_bottom"}, 0, []run{{1, 1}, {2, 2}, {4, 2}, {6, 2}}}},
	{"hh_closed", "Hi-hat closed", instrument{"HihatClosed", []string{"Hihat"}, -0.3, []run{{1, 5}, {6, 5}, {11, 4}, {15, 5}, {20, 3}}}},
	{"hh_open", "Hi-hat open", instrument{"HihatOpen", []string{"Hihat"}, -0.3, []run{{2, 2}, {4, 4}, {8, 2}, {10, 5}, {15, 4}}}},
	{"tom1", "Tom 1, high", instrument{"Tom1", []string{"Tom1"}, -0.4, []run{{1, 2}, {3, 2}, {5, 2}, {7, 3}}}},
	{"tom2", "Tom 2", instrument{"Tom2", []string{"Tom2"}, -0.15, []run{{1, 1}, {2, 3}, {5, 3}, {8, 3}}}},
	{"tom3", "Tom 3", instrument{"Tom3", []string{"Tom3"}, 0.15, []run{{1, 2}, {3, 2}, {5, 3}, {8, 3}}}},
	{"tom4", "Tom 4, floor", instrument{"Tom4", []string{"Tom4"}, 0.4, []run{{1, 2}, {3, 3}, {6, 3}, {9, 3}}}},
	{"crash_l", "Crash, left", instrument{"CrashL", nil, 0, []run{{1, 2}, {3, 2}, {5, 2}, {7, 3}}}},
	{"crash_r", "Crash, right", instrument{"CrashR", nil, 0, []run{{1, 2}, {3, 3}, {6, 3}, {9, 2}}}},
	{"ride_r", "Ride, right", instrument{"RideR", []string{"RideR"}, 0.35, []run{{1, 1}, {2, 3}, {5, 2}, {7, 3}}}},
	{"ride_r_bell", "Ride bell, right", instrument{"RideRBell", []string{"RideR"}, 0.35, []run{{1, 2}, {3, 2}, {5, 2}, {7, 2}}}},
	{"ride_l", "Ride, left", instrument{"RideL", []string{"RideL"}, -0.35, []run{{1, 1}, {2, 3}, {5, 5}, {10, 2}}}},
	{"ride_l_bell", "Ride bell, left", instrument{"RideLBell", []string{"RideL"}, -0.35, []run{{1, 3}}}},
	{"china", "China", instrument{"China", nil, 0, []run{{1, 2}, {3, 2}, {5, 3}, {8, 3}}}},
}

var roomMics = []string{"OHL", "OHR", "AmbL", "AmbR"}

const (
	closeLevel     = 1.0
	secondMicLevel = 0.5
)

func findSound(id string) (namedSound, bool) {
	at := slices.IndexFunc(sounds, func(s namedSound) bool { return s.id == id })
	if at < 0 {
		return namedSound{}, false
	}
	return sounds[at], true
}

func KnownSound(id string) bool {
	_, ok := findSound(id)
	return ok
}

func Sounds() []SoundInfo {
	out := make([]SoundInfo, len(sounds))
	for i, s := range sounds {
		out[i] = SoundInfo{ID: s.id, Label: s.label}
	}
	return out
}

func sampleName(folder string, hit int, mic string) string {
	return path.Join(folder, fmt.Sprintf("%d-%s-%s.flac", hit, folder, mic))
}

func KitFiles() []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range sounds {
		mics := append(slices.Clone(roomMics), s.close...)
		for _, r := range s.layers {
			for hit := r.first; hit < r.first+r.count; hit++ {
				for _, mic := range mics {
					name := sampleName(s.folder, hit, mic)
					if !seen[name] {
						seen[name] = true
						out = append(out, name)
					}
				}
			}
		}
	}
	slices.Sort(out)
	return out
}

type Mic struct {
	Path  string  `json:"path"`
	Left  float64 `json:"left"`
	Right float64 `json:"right"`
}

type PadSource struct {
	Layers [][][]Mic `json:"layers,omitempty"`
	Files  []string  `json:"files,omitempty"`
}

type LoadRequest struct {
	Token uint64      `json:"token"`
	Pads  []PadSource `json:"pads"`
}

func round3(v float64) float64 {
	return math.Round(v*1000) / 1000
}

func (s namedSound) mix(root string, hit int, room, overheads float64) []Mic {
	at := func(mic string) string {
		return filepath.Join(root, filepath.FromSlash(sampleName(s.folder, hit, mic)))
	}
	take := []Mic{}
	add := func(mic string, left, right float64) {
		if left > 0 || right > 0 {
			take = append(take, Mic{Path: at(mic), Left: round3(left), Right: round3(right)})
		}
	}
	for i, mic := range s.close {
		level := closeLevel
		if i > 0 {
			level = secondMicLevel
		}
		add(mic, level*math.Min(1, 1-s.pan), level*math.Min(1, 1+s.pan))
	}
	add("OHL", overheads, 0)
	add("OHR", 0, overheads)
	add("AmbL", room, 0)
	add("AmbR", 0, room)
	return take
}

func (s Settings) padSource(p Pad, root string) PadSource {
	if p.Sound == SoundCustom {
		return PadSource{Files: slices.Clone(p.Files)}
	}
	found, ok := findSound(p.Sound)
	if !ok || s.Kit != KitMuldjord || root == "" {
		return PadSource{}
	}
	layers := make([][][]Mic, 0, len(found.layers))
	for _, r := range found.layers {
		takes := [][]Mic{}
		for hit := r.first; hit < r.first+r.count; hit++ {
			if take := found.mix(root, hit, s.Room, s.Overheads); len(take) > 0 {
				takes = append(takes, take)
			}
		}
		layers = append(layers, takes)
	}
	return PadSource{Layers: layers}
}

func BuildLoad(s Settings, root string, token uint64) LoadRequest {
	req := LoadRequest{Token: token, Pads: make([]PadSource, len(s.Pads))}
	if !s.Enabled {
		return req
	}
	for i, p := range s.Pads {
		req.Pads[i] = s.padSource(p, root)
	}
	return req
}

func (r LoadRequest) Empty() bool {
	return !slices.ContainsFunc(r.Pads, func(p PadSource) bool {
		return len(p.Layers) > 0 || len(p.Files) > 0
	})
}

type EnginePad struct {
	Notes       []int   `json:"notes"`
	GainDb      float64 `json:"gainDb"`
	Pan         float64 `json:"pan"`
	Tune        float64 `json:"tune"`
	Choke       int     `json:"choke"`
	Sensitivity float64 `json:"sensitivity"`
}

type EnginePedal struct {
	Threshold int  `json:"threshold"`
	Reversed  bool `json:"reversed"`
	OpenPad   int  `json:"openPad"`
	ClosedPad int  `json:"closedPad"`
}

type EngineConfig struct {
	Enabled   bool         `json:"enabled"`
	Curve     float64      `json:"curve"`
	Threshold int          `json:"threshold"`
	Pads      []EnginePad  `json:"pads"`
	Pedal     *EnginePedal `json:"pedal"`
}

func curveExponent(name string) float64 {
	switch name {
	case CurveSoft:
		return 0.6
	case CurveHard:
		return 1.6
	}
	return 1
}

func BuildConfig(s Settings) EngineConfig {
	cfg := EngineConfig{
		Enabled:   s.Enabled,
		Curve:     curveExponent(s.Curve),
		Threshold: s.Threshold,
		Pads:      make([]EnginePad, len(s.Pads)),
	}
	for i, p := range s.Pads {
		cfg.Pads[i] = EnginePad{
			Notes: append([]int{}, p.Notes...), GainDb: p.GainDb, Pan: p.Pan,
			Tune: p.Tune, Choke: p.Choke, Sensitivity: p.Sensitivity,
		}
	}
	open, closed := PadIndex(s, "hihat_open"), PadIndex(s, "hihat_closed")
	if s.PedalFollows && open >= 0 && closed >= 0 {
		cfg.Pedal = &EnginePedal{
			Threshold: s.PedalThreshold, Reversed: s.PedalReversed,
			OpenPad: open, ClosedPad: closed,
		}
	}
	return cfg
}
