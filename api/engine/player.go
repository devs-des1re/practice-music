package engine

import (
	"context"
	"encoding/json"
	"time"
)

type PlayerLoaded struct {
	Path       string    `json:"path"`
	Rate       int       `json:"rate"`
	Frames     int64     `json:"frames"`
	DurationMs float64   `json:"durationMs"`
	Peaks      []float32 `json:"peaks"`
}

type GridResult struct {
	Found       bool    `json:"found"`
	Bpm         float64 `json:"bpm"`
	OffsetMs    float64 `json:"offsetMs"`
	BeatsPerBar int     `json:"beatsPerBar"`
	Downbeat    int     `json:"downbeat"`
	Confidence  float64 `json:"confidence"`
}

type LoopParams struct {
	StartMs float64 `json:"startMs"`
	EndMs   float64 `json:"endMs"`
	Enabled bool    `json:"enabled"`
}

type CountInParams struct {
	Beats     int     `json:"beats"`
	SpacingMs float64 `json:"spacingMs"`
}

type GuideParams struct {
	Enabled     bool    `json:"enabled"`
	Bpm         float64 `json:"bpm"`
	OffsetMs    float64 `json:"offsetMs"`
	BeatsPerBar int     `json:"beatsPerBar"`
	Downbeat    int     `json:"downbeat"`
}

type PlayerControl struct {
	Action  string         `json:"action,omitempty"`
	SeekMs  *float64       `json:"seekMs,omitempty"`
	Speed   *float64       `json:"speed,omitempty"`
	Pitch   *float64       `json:"pitch,omitempty"`
	Volume  *float64       `json:"volume,omitempty"`
	Loop    *LoopParams    `json:"loop,omitempty"`
	CountIn *CountInParams `json:"countIn,omitempty"`
	Guide   *GuideParams   `json:"guide,omitempty"`
}

type PlayerEvent struct {
	PositionMs float64 `json:"positionMs"`
	Playing    bool    `json:"playing"`
	Loops      int64   `json:"loops"`
}

func (s *Supervisor) PlayerLoad(ctx context.Context, path string) (PlayerLoaded, error) {
	var out PlayerLoaded
	err := s.CallTimeout(ctx, 60*time.Second, "player_load", map[string]string{"path": path}, &out)
	return out, err
}

func (s *Supervisor) PlayerAnalyze(ctx context.Context) (GridResult, error) {
	var out GridResult
	err := s.CallTimeout(ctx, 60*time.Second, "player_analyze", nil, &out)
	return out, err
}

func (s *Supervisor) PlayerControl(ctx context.Context, p PlayerControl) error {
	return s.Call(ctx, "player_control", p, nil)
}

func DecodePlayerEvent(data json.RawMessage) (PlayerEvent, error) {
	var ev PlayerEvent
	err := json.Unmarshal(data, &ev)
	return ev, err
}
