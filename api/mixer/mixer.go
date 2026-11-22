package mixer

import (
	"fmt"
	"math"
	"strings"
)

const (
	StripCount   = 6
	InputStrips  = 4
	StripSong    = 0
	StripClick   = 1
	StripInput0  = 2
	OffDB        = -60.0
	MaxGain      = 12.0
	MaxChannel   = 62
	MaxNameRunes = 24
)

type EQ struct {
	Low  float64 `json:"low"`
	Mid  float64 `json:"mid"`
	High float64 `json:"high"`
}

type Comp struct {
	On        bool    `json:"on"`
	Threshold float64 `json:"threshold"`
	Ratio     float64 `json:"ratio"`
	Attack    float64 `json:"attack"`
	Release   float64 `json:"release"`
	Makeup    float64 `json:"makeup"`
}

type Strip struct {
	Index   int     `json:"index"`
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Kind    string  `json:"kind"`
	Gain    float64 `json:"gain"`
	Pan     float64 `json:"pan"`
	Mute    bool    `json:"mute"`
	Solo    bool    `json:"solo"`
	Main    float64 `json:"main"`
	Monitor float64 `json:"monitor"`
	EQ      EQ      `json:"eq"`
	Comp    Comp    `json:"comp"`
	Source  int     `json:"source"`
	Stereo  bool    `json:"stereo"`
}

type Master struct {
	Main           float64 `json:"main"`
	Monitor        float64 `json:"monitor"`
	Limiter        bool    `json:"limiter"`
	Ceiling        float64 `json:"ceiling"`
	MainChannel    int     `json:"mainChannel"`
	MonitorChannel int     `json:"monitorChannel"`
}

type Board struct {
	Strips []Strip `json:"strips"`
	Master Master  `json:"master"`
}

func defaultComp() Comp {
	return Comp{Threshold: -18, Ratio: 3, Attack: 10, Release: 120}
}

func Default() Board {
	strips := make([]Strip, StripCount)
	strips[StripSong] = Strip{Index: StripSong, ID: "song", Name: "Song", Kind: "song", Main: 0, Monitor: OffDB, Comp: defaultComp()}
	strips[StripClick] = Strip{Index: StripClick, ID: "click", Name: "Click", Kind: "click", Main: 0, Monitor: OffDB, Comp: defaultComp()}
	for i := 0; i < InputStrips; i++ {
		idx := StripInput0 + i
		strips[idx] = Strip{
			Index: idx, ID: fmt.Sprintf("in%d", i+1), Name: fmt.Sprintf("Input %d", i+1), Kind: "input",
			Main: OffDB, Monitor: OffDB, Source: i, Comp: defaultComp(),
		}
	}
	return Board{Strips: strips, Master: Master{Limiter: true, Ceiling: -0.3}}
}

func clamp(v, lo, hi float64) float64 {
	if math.IsNaN(v) {
		return lo
	}
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func cleanName(name, fallback string) string {
	name = strings.Join(strings.Fields(name), " ")
	runes := []rune(name)
	if len(runes) > MaxNameRunes {
		runes = runes[:MaxNameRunes]
	}
	name = string(runes)
	if name == "" {
		return fallback
	}
	return name
}

func NormalizeStrip(index int, s Strip) Strip {
	base := Default().Strips[index]
	out := s
	out.Index = index
	out.ID = base.ID
	out.Kind = base.Kind
	out.Name = cleanName(s.Name, base.Name)
	out.Gain = clamp(s.Gain, OffDB, MaxGain)
	out.Pan = clamp(s.Pan, -1, 1)
	out.Main = clamp(s.Main, OffDB, MaxGain)
	out.Monitor = clamp(s.Monitor, OffDB, MaxGain)
	out.EQ = EQ{Low: clamp(s.EQ.Low, -15, 15), Mid: clamp(s.EQ.Mid, -15, 15), High: clamp(s.EQ.High, -15, 15)}
	c := s.Comp
	if c.Ratio == 0 && c.Threshold == 0 && c.Attack == 0 && c.Release == 0 {
		c = Comp{On: c.On, Threshold: -18, Ratio: 3, Attack: 10, Release: 120, Makeup: c.Makeup}
	}
	out.Comp = Comp{
		On:        c.On,
		Threshold: clamp(c.Threshold, -60, 0),
		Ratio:     clamp(c.Ratio, 1, 20),
		Attack:    clamp(c.Attack, 0.1, 200),
		Release:   clamp(c.Release, 5, 2000),
		Makeup:    clamp(c.Makeup, 0, 24),
	}
	if index >= StripInput0 {
		out.Source = clampInt(s.Source, 0, 15)
	} else {
		out.Source = 0
		out.Stereo = false
	}
	return out
}

func NormalizeMaster(m Master) Master {
	return Master{
		Main:           clamp(m.Main, OffDB, MaxGain),
		Monitor:        clamp(m.Monitor, OffDB, MaxGain),
		Limiter:        m.Limiter,
		Ceiling:        clamp(m.Ceiling, -12, 0),
		MainChannel:    clampInt(m.MainChannel, 0, MaxChannel),
		MonitorChannel: clampInt(m.MonitorChannel, 0, MaxChannel),
	}
}

func Normalize(in Board) Board {
	def := Default()
	out := Board{Strips: make([]Strip, StripCount), Master: NormalizeMaster(in.Master)}
	if len(in.Strips) == 0 {
		out.Master = def.Master
	}
	for i := 0; i < StripCount; i++ {
		if i < len(in.Strips) {
			out.Strips[i] = NormalizeStrip(i, in.Strips[i])
		} else {
			out.Strips[i] = def.Strips[i]
		}
	}
	return out
}

func Same(a, b Board) bool {
	if a.Master != b.Master || len(a.Strips) != len(b.Strips) {
		return false
	}
	for i := range a.Strips {
		if a.Strips[i] != b.Strips[i] {
			return false
		}
	}
	return true
}

func ChannelLabel(offset int) string {
	return fmt.Sprintf("%d-%d", offset+1, offset+2)
}
