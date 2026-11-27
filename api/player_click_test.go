package api

import (
	"testing"

	"practice-music/api/library"
)

func TestTheSongClickFollowsTheSongGrid(t *testing.T) {
	st := PlayerState{Loaded: true, Click: true, Speed: 0.5, Grid: library.Grid{Bpm: 96.5, OffsetMs: 251, BeatsPerBar: 3, Downbeat: 2}}
	got := guideFor(st)
	if !got.Enabled || got.Bpm != 96.5 || got.OffsetMs != 251 || got.BeatsPerBar != 3 || got.Downbeat != 2 {
		t.Fatalf("unexpected guide %+v", got)
	}
}

func TestTheSongClickIsOffWithoutASongATempoOrTheSwitch(t *testing.T) {
	base := PlayerState{Loaded: true, Click: true, Grid: library.Grid{Bpm: 100}}
	if got := guideFor(base); !got.Enabled || got.BeatsPerBar != 4 {
		t.Fatalf("unexpected guide %+v", got)
	}
	for name, change := range map[string]func(*PlayerState){
		"switch": func(p *PlayerState) { p.Click = false },
		"song":   func(p *PlayerState) { p.Loaded = false },
		"tempo":  func(p *PlayerState) { p.Grid.Bpm = 0 },
	} {
		st := base
		change(&st)
		if guideFor(st).Enabled {
			t.Fatalf("enabled without the %s", name)
		}
	}
}
