package engine

import (
	"context"
	"encoding/json"
)

type MidiFrame struct {
	Seq   uint64 `json:"seq"`
	Kind  string `json:"kind"`
	Note  int    `json:"note"`
	Value int    `json:"value"`
}

type MidiPorts struct {
	Ports []string `json:"ports"`
	Open  string   `json:"open"`
}

type DrumKitEvent struct {
	Token uint64 `json:"token"`
	State string `json:"state"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
	Bytes int64  `json:"bytes"`
	Error string `json:"error"`
}

func (s *Supervisor) MidiPorts(ctx context.Context) (MidiPorts, error) {
	var out MidiPorts
	err := s.Call(ctx, "midi_ports", nil, &out)
	if out.Ports == nil {
		out.Ports = []string{}
	}
	return out, err
}

func (s *Supervisor) MidiOpen(ctx context.Context, port string) error {
	return s.Call(ctx, "midi_open", map[string]string{"port": port}, nil)
}

func (s *Supervisor) DrumsConfig(ctx context.Context, config any) error {
	return s.Call(ctx, "drums_config", config, nil)
}

func (s *Supervisor) DrumsLoad(ctx context.Context, request any) error {
	return s.Call(ctx, "drums_load", request, nil)
}

func (s *Supervisor) DrumsTrigger(ctx context.Context, pad, velocity int) error {
	return s.Call(ctx, "drums_trigger", map[string]int{"pad": pad, "velocity": velocity}, nil)
}

func DecodeMidi(data json.RawMessage) (MidiFrame, error) {
	var f MidiFrame
	err := json.Unmarshal(data, &f)
	return f, err
}

func DecodeDrumKit(data json.RawMessage) (DrumKitEvent, error) {
	var f DrumKitEvent
	err := json.Unmarshal(data, &f)
	return f, err
}
