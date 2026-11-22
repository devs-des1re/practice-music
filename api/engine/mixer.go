package engine

import (
	"context"
	"encoding/json"
)

type MeterLevel struct {
	L    float64 `json:"l"`
	R    float64 `json:"r"`
	Clip bool    `json:"clip"`
	GR   float64 `json:"gr"`
}

type MeterFrame struct {
	Strips  []MeterLevel `json:"strips"`
	Main    MeterLevel   `json:"main"`
	Monitor MeterLevel   `json:"monitor"`
}

type BeatFrame struct {
	Seq         uint64 `json:"seq"`
	Beat        int    `json:"beat"`
	Bar         int    `json:"bar"`
	BeatsPerBar int    `json:"beatsPerBar"`
	Level       int    `json:"level"`
	Silent      bool   `json:"silent"`
}

func (s *Supervisor) MixerSet(ctx context.Context, state any) error {
	return s.Call(ctx, "mixer_set", state, nil)
}

func (s *Supervisor) MetersReset(ctx context.Context) error {
	return s.Call(ctx, "meters_reset", nil, nil)
}

func (s *Supervisor) MetronomeSound(ctx context.Context, role, path string) error {
	return s.Call(ctx, "metronome_sound", map[string]string{"role": role, "path": path}, nil)
}

func DecodeMeters(data json.RawMessage) (MeterFrame, error) {
	var f MeterFrame
	err := json.Unmarshal(data, &f)
	if f.Strips == nil {
		f.Strips = []MeterLevel{}
	}
	return f, err
}

func DecodeBeat(data json.RawMessage) (BeatFrame, error) {
	var f BeatFrame
	err := json.Unmarshal(data, &f)
	return f, err
}
