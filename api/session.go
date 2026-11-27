package api

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/kratejs/krate/packages/native/krate"

	"practice-music/api/clock"
	"practice-music/api/engine"
	"practice-music/api/logger"
	"practice-music/api/metronome"
	"practice-music/api/mixer"
	"practice-music/api/persist"
	"practice-music/api/refusal"
)

type TapResult struct {
	Bpm   float64 `json:"bpm"`
	Taps  int     `json:"taps"`
	Found bool    `json:"found"`
}

type SceneStatus struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Modified bool   `json:"modified"`
}

var SessionEpoch = krate.NewSignal(0)

var MeterStream = krate.NewSignal(engine.MeterFrame{Strips: []engine.MeterLevel{}})

var BeatStream = krate.NewSignal(engine.BeatFrame{})

var MetronomeRevision = krate.NewSignal(0)

var metronomeRev int

var ActiveScene = krate.NewSignal(SceneStatus{})

var (
	sessMu       sync.Mutex
	sessionDir   string
	mixState     = mixer.Default()
	metroState   = metronome.Default()
	metroRunning bool
	tapper       metronome.Tapper
	saveTimer    *time.Timer
)

const saveDelay = 400 * time.Millisecond

func mixerPath() string {
	return filepath.Join(sessionDir, "mixer.json")
}

func metronomePath() string {
	return filepath.Join(sessionDir, "metronome.json")
}

func loadSession(dir string) {
	sessMu.Lock()
	defer sessMu.Unlock()
	sessionDir = dir
	var m mixer.Board
	if found, err := persist.Load(mixerPath(), &m); err != nil {
		logger.Warnf("mixer settings were not loaded: %v", err)
	} else if found {
		mixState = mixer.Normalize(m)
	}
	var met metronome.Setup
	if found, err := persist.Load(metronomePath(), &met); err != nil {
		logger.Warnf("metronome settings were not loaded: %v", err)
	} else if found {
		metroState = metronome.Normalize(met)
	}
}

func copyMixer(m mixer.Board) mixer.Board {
	m.Strips = slices.Clone(m.Strips)
	return m
}

func copyMetronome(m metronome.Setup) metronome.Setup {
	m.Accents = slices.Clone(m.Accents)
	custom := make(map[string]string, len(m.CustomSounds))
	for k, v := range m.CustomSounds {
		custom[k] = v
	}
	m.CustomSounds = custom
	return m
}

func scheduleSave() {
	sessMu.Lock()
	defer sessMu.Unlock()
	if saveTimer != nil {
		saveTimer.Stop()
	}
	saveTimer = time.AfterFunc(saveDelay, saveSessionNow)
}

func saveSessionNow() {
	sessMu.Lock()
	m := copyMixer(mixState)
	met := copyMetronome(metroState)
	dir := sessionDir
	sessMu.Unlock()
	if dir == "" {
		return
	}
	if err := persist.Save(mixerPath(), m); err != nil {
		logger.Warnf("mixer settings were not saved: %v", err)
	}
	if err := persist.Save(metronomePath(), met); err != nil {
		logger.Warnf("metronome settings were not saved: %v", err)
	}
}

func markModified() {
	ActiveScene.Update(func(s SceneStatus) SceneStatus {
		if s.ID != 0 {
			s.Modified = true
		}
		return s
	})
}

func audioRunning() bool {
	return AudioStream.Get().Running
}

func mixCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 3*time.Second)
}

func GetMixer() mixer.Board {
	boot()
	sessMu.Lock()
	defer sessMu.Unlock()
	return copyMixer(mixState)
}

func SetMixerStrip(index int, s mixer.Strip) (mixer.Strip, error) {
	boot()
	if index < 0 || index >= mixer.StripCount {
		return mixer.Strip{}, fmt.Errorf("there is no mixer channel %d", index)
	}
	clean := mixer.NormalizeStrip(index, s)
	sessMu.Lock()
	mixState.Strips[index] = clean
	sessMu.Unlock()
	markModified()
	scheduleSave()
	if audioRunning() {
		ctx, cancel := mixCtx()
		defer cancel()
		if err := sup.MixerSet(ctx, map[string]any{"strips": []mixer.Strip{clean}}); err != nil {
			return clean, err
		}
	}
	return clean, nil
}

func SetMixerMaster(m mixer.Master) (mixer.Master, error) {
	boot()
	clean := mixer.NormalizeMaster(m)
	sessMu.Lock()
	mixState.Master = clean
	sessMu.Unlock()
	markModified()
	scheduleSave()
	if audioRunning() {
		ctx, cancel := mixCtx()
		defer cancel()
		if err := sup.MixerSet(ctx, map[string]any{"master": clean}); err != nil {
			return clean, err
		}
	}
	return clean, nil
}

func ResetMixer() (mixer.Board, error) {
	boot()
	sessMu.Lock()
	mixState = mixer.Default()
	out := copyMixer(mixState)
	sessMu.Unlock()
	markModified()
	scheduleSave()
	if audioRunning() {
		ctx, cancel := mixCtx()
		defer cancel()
		if err := sup.MixerSet(ctx, out); err != nil {
			return out, err
		}
	}
	SessionEpoch.Update(func(n int) int { return n + 1 })
	return out, nil
}

func ResetMeters() error {
	boot()
	if !audioRunning() {
		return nil
	}
	ctx, cancel := mixCtx()
	defer cancel()
	return sup.MetersReset(ctx)
}

func GetMetronome() metronome.Setup {
	boot()
	sessMu.Lock()
	defer sessMu.Unlock()
	return copyMetronome(metroState)
}

func metronomeParams(st metronome.Setup, includeSound bool, running *bool) engine.MetronomeParams {
	p := engine.MetronomeParams{
		Bpm:         &st.Bpm,
		Volume:      &st.Volume,
		BeatsPerBar: &st.BeatsPerBar,
		Subdivision: &st.Subdivision,
		SubLevel:    &st.SubLevel,
		Accents:     st.Accents,
		PolyBeats:   &st.PolyBeats,
		PolyLevel:   &st.PolyLevel,
		PlayBars:    &st.PlayBars,
		SilentBars:  &st.SilentBars,
		Running:     running,
	}
	if includeSound {
		p.Sound = &st.Sound
	}
	return p
}

func applyCustomSounds(ctx context.Context, custom map[string]string, only map[string]bool) {
	for _, role := range metronome.Roles {
		path, ok := custom[role]
		if !ok || (only != nil && !only[role]) {
			continue
		}
		if err := sup.MetronomeSound(ctx, role, path); err != nil {
			logger.Warnf("custom %s sound %s could not be loaded: %v", role, path, err)
		}
	}
}

func pushSession(ctx context.Context, keepRunning bool) (engine.MetronomeState, error) {
	sessMu.Lock()
	m := copyMixer(mixState)
	met := copyMetronome(metroState)
	if !keepRunning {
		metroRunning = false
	}
	running := metroRunning
	sessMu.Unlock()
	var firstErr error
	if err := sup.MixerSet(ctx, m); err != nil {
		firstErr = err
	}
	state, err := sup.MetronomeSet(ctx, metronomeParams(met, true, &running))
	if err != nil && firstErr == nil {
		firstErr = err
	}
	applyCustomSounds(ctx, met.CustomSounds, nil)
	return state, firstErr
}

func SetMetronomeState(in metronome.Setup) (metronome.Setup, error) {
	boot()
	clean := metronome.Normalize(in)
	sessMu.Lock()
	prev := copyMetronome(metroState)
	if clean.Sound != prev.Sound {
		clean.CustomSounds = map[string]string{}
	}
	metroState = copyMetronome(clean)
	metronomeRev++
	rev := metronomeRev
	sessMu.Unlock()
	MetronomeRevision.Set(rev)
	markModified()
	scheduleSave()
	if !audioRunning() {
		return clean, nil
	}
	ctx, cancel := mixCtx()
	defer cancel()
	soundChanged := clean.Sound != prev.Sound
	removed := false
	changed := map[string]bool{}
	for role, path := range prev.CustomSounds {
		if clean.CustomSounds[role] != path {
			removed = removed || clean.CustomSounds[role] == ""
		}
	}
	for role, path := range clean.CustomSounds {
		if prev.CustomSounds[role] != path {
			changed[role] = true
		}
	}
	state, err := sup.MetronomeSet(ctx, metronomeParams(clean, soundChanged || removed, nil))
	if err != nil {
		return clean, err
	}
	if soundChanged || removed {
		applyCustomSounds(ctx, clean.CustomSounds, nil)
	} else if len(changed) > 0 {
		applyCustomSounds(ctx, clean.CustomSounds, changed)
	}
	setAudio(func(a *AudioState) { a.Metronome = state })
	return clean, nil
}

func LoadMetronomeSound(role, path string) (metronome.Setup, error) {
	boot()
	roles := []string{role}
	if role == "all" {
		roles = metronome.Roles
	} else if !slices.Contains(metronome.Roles, role) {
		return metronome.Setup{}, fmt.Errorf("unknown click sound slot %q", role)
	}
	if !filepath.IsAbs(path) {
		return metronome.Setup{}, refusal.New("choose a sound file with a full path")
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return metronome.Setup{}, refusal.New("that sound file cannot be read")
	}
	if !audioRunning() {
		return metronome.Setup{}, refusal.New("start the audio engine before choosing a custom sound")
	}
	ctx, cancel := mixCtx()
	defer cancel()
	if err := sup.MetronomeSound(ctx, role, path); err != nil {
		return metronome.Setup{}, err
	}
	sessMu.Lock()
	for _, r := range roles {
		metroState.CustomSounds[r] = path
	}
	out := copyMetronome(metroState)
	sessMu.Unlock()
	markModified()
	scheduleSave()
	return out, nil
}

func ClearMetronomeSound(role string) (metronome.Setup, error) {
	boot()
	st := GetMetronome()
	if role == "all" {
		st.CustomSounds = map[string]string{}
	} else {
		if !slices.Contains(metronome.Roles, role) {
			return metronome.Setup{}, fmt.Errorf("unknown click sound slot %q", role)
		}
		delete(st.CustomSounds, role)
	}
	return SetMetronomeState(st)
}

func setMetronomeRunning(running bool) (engine.MetronomeState, error) {
	boot()
	if !audioRunning() {
		return engine.MetronomeState{}, refusal.New("start the audio engine first")
	}
	ctx, cancel := mixCtx()
	defer cancel()
	state, err := sup.MetronomeSet(ctx, engine.MetronomeParams{Running: &running})
	if err != nil {
		return engine.MetronomeState{}, err
	}
	sessMu.Lock()
	metroRunning = running
	sessMu.Unlock()
	setAudio(func(a *AudioState) { a.Metronome = state })
	return state, nil
}

func startMetronome() (engine.MetronomeState, error) {
	return setMetronomeRunning(true)
}

func stopMetronome() (engine.MetronomeState, error) {
	return setMetronomeRunning(false)
}

func MetronomeStart() (engine.MetronomeState, error) {
	return startMetronome()
}

func MetronomeStop() (engine.MetronomeState, error) {
	return stopMetronome()
}

func TapTempo() (TapResult, error) {
	boot()
	now := clock.MonoUs()
	sessMu.Lock()
	bpm, ok := tapper.Tap(now)
	taps := tapper.Count()
	st := copyMetronome(metroState)
	sessMu.Unlock()
	if !ok {
		return TapResult{Taps: taps}, nil
	}
	st.Bpm = bpm
	if _, err := SetMetronomeState(st); err != nil {
		return TapResult{Bpm: bpm, Taps: taps, Found: true}, err
	}
	return TapResult{Bpm: bpm, Taps: taps, Found: true}, nil
}
