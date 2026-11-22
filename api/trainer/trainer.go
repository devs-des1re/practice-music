package trainer

import (
	"errors"
	"math"
	"sync"
)

type Config struct {
	StartBpm    float64 `json:"startBpm"`
	TargetBpm   float64 `json:"targetBpm"`
	StepBpm     float64 `json:"stepBpm"`
	RepsPerStep int     `json:"repsPerStep"`
	AutoClean   bool    `json:"autoClean"`
}

type State struct {
	Active     bool    `json:"active"`
	Done       bool    `json:"done"`
	CurrentBpm float64 `json:"currentBpm"`
	TargetBpm  float64 `json:"targetBpm"`
	Clean      int     `json:"clean"`
	Needed     int     `json:"needed"`
	Steps      int     `json:"steps"`
	Passes     int     `json:"passes"`
	AutoClean  bool    `json:"autoClean"`
	LastEvent  string  `json:"lastEvent"`
}

func (c Config) Validate() error {
	if c.StartBpm < 20 || c.StartBpm > 400 || c.TargetBpm < 20 || c.TargetBpm > 400 {
		return errors.New("tempos must be between 20 and 400 BPM")
	}
	if c.TargetBpm < c.StartBpm {
		return errors.New("the target tempo must not be lower than the starting tempo")
	}
	if c.StepBpm < 0.5 || c.StepBpm > 60 {
		return errors.New("the step must be between 0.5 and 60 BPM")
	}
	if c.RepsPerStep < 1 || c.RepsPerStep > 50 {
		return errors.New("clean repetitions per step must be between 1 and 50")
	}
	return nil
}

type Trainer struct {
	mu    sync.Mutex
	cfg   Config
	state State
}

func New() *Trainer {
	return &Trainer{}
}

func round(v float64) float64 {
	return math.Round(v*100) / 100
}

func (t *Trainer) Start(cfg Config) (State, error) {
	if err := cfg.Validate(); err != nil {
		return State{}, err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.cfg = cfg
	t.state = State{
		Active:     true,
		CurrentBpm: round(cfg.StartBpm),
		TargetBpm:  round(cfg.TargetBpm),
		Needed:     cfg.RepsPerStep,
		AutoClean:  cfg.AutoClean,
		LastEvent:  "started",
	}
	if cfg.StartBpm >= cfg.TargetBpm {
		t.state.Done = true
		t.state.LastEvent = "already at target"
	}
	return t.state, nil
}

func (t *Trainer) Stop() State {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.state.Active = false
	t.state.LastEvent = "stopped"
	return t.state
}

func (t *Trainer) State() State {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.state
}

func (t *Trainer) advance() {
	t.state.Clean = 0
	next := t.state.CurrentBpm + t.cfg.StepBpm
	if next >= t.cfg.TargetBpm {
		next = t.cfg.TargetBpm
		t.state.Done = true
		t.state.LastEvent = "target reached"
	} else {
		t.state.LastEvent = "stepped up"
	}
	t.state.CurrentBpm = round(next)
	t.state.Steps++
}

func (t *Trainer) count() (State, bool) {
	t.state.Clean++
	if t.state.Clean >= t.state.Needed {
		t.advance()
		return t.state, true
	}
	t.state.LastEvent = "clean repetition"
	return t.state, false
}

func (t *Trainer) OnLoop() (State, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.state.Active || t.state.Done {
		return t.state, false
	}
	t.state.Passes++
	if !t.cfg.AutoClean {
		return t.state, false
	}
	return t.count()
}

func (t *Trainer) Clean() (State, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.state.Active || t.state.Done {
		return t.state, false
	}
	if t.cfg.AutoClean {
		return t.state, false
	}
	return t.count()
}

func (t *Trainer) Miss() State {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.state.Active && !t.state.Done {
		t.state.Clean = 0
		t.state.LastEvent = "missed, count reset"
	}
	return t.state
}

func (t *Trainer) Speed(songBpm float64) float64 {
	t.mu.Lock()
	defer t.mu.Unlock()
	if songBpm <= 0 {
		return 1
	}
	return t.state.CurrentBpm / songBpm
}
