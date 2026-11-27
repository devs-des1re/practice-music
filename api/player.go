package api

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/kratejs/krate/packages/native/krate"

	"practice-music/api/engine"
	"practice-music/api/library"
	"practice-music/api/logger"
)

type LoopRegion struct {
	StartMs float64 `json:"startMs"`
	EndMs   float64 `json:"endMs"`
	Enabled bool    `json:"enabled"`
}

type PlayerState struct {
	Loaded     bool          `json:"loaded"`
	SongID     int64         `json:"songId"`
	Title      string        `json:"title"`
	Artist     string        `json:"artist"`
	Path       string        `json:"path"`
	DurationMs float64       `json:"durationMs"`
	PositionMs float64       `json:"positionMs"`
	Playing    bool          `json:"playing"`
	Loops      int64         `json:"loops"`
	Speed      float64       `json:"speed"`
	Pitch      float64       `json:"pitch"`
	Volume     float64       `json:"volume"`
	Loop       LoopRegion    `json:"loop"`
	CountIn    int           `json:"countIn"`
	Click      bool          `json:"click"`
	Grid       library.Grid  `json:"grid"`
	Error      string        `json:"error"`
}

type PlayerOpened struct {
	DurationMs float64      `json:"durationMs"`
	Peaks      []float32    `json:"peaks"`
	Grid       library.Grid `json:"grid"`
}

func defaultPlayerState() PlayerState {
	return PlayerState{Speed: 1, Volume: 0.9}
}

var PlayerStream = krate.NewSignal(defaultPlayerState())

var (
	playerMu    sync.Mutex
	ps          = defaultPlayerState()
	playerPeaks []float32
)

func playerUpdate(change func(*PlayerState)) PlayerState {
	playerMu.Lock()
	change(&ps)
	snapshot := ps
	playerMu.Unlock()
	PlayerStream.Set(snapshot)
	return snapshot
}

func playerSnapshot() PlayerState {
	playerMu.Lock()
	defer playerMu.Unlock()
	return ps
}

func engineCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 8*time.Second)
}

func playerControl(p engine.PlayerControl) error {
	ctx, cancel := engineCtx()
	defer cancel()
	return sup.PlayerControl(ctx, p)
}

func f(v float64) *float64 { return &v }

func countInSpacing(st PlayerState) float64 {
	if st.Grid.Bpm <= 0 || st.Speed <= 0 {
		return 0
	}
	return 60000 / (st.Grid.Bpm * st.Speed)
}

func pushCountIn() {
	st := playerSnapshot()
	if err := playerControl(engine.PlayerControl{CountIn: &engine.CountInParams{Beats: st.CountIn, SpacingMs: countInSpacing(st)}}); err != nil {
		logger.Warnf("count-in was not applied: %v", err)
	}
}

func guideFor(st PlayerState) engine.GuideParams {
	beats := st.Grid.BeatsPerBar
	if beats <= 0 {
		beats = 4
	}
	return engine.GuideParams{
		Enabled:     st.Click && st.Loaded && st.Grid.Bpm > 0,
		Bpm:         st.Grid.Bpm,
		OffsetMs:    st.Grid.OffsetMs,
		BeatsPerBar: beats,
		Downbeat:    st.Grid.Downbeat,
	}
}

func pushGuide() error {
	guide := guideFor(playerSnapshot())
	return playerControl(engine.PlayerControl{Guide: &guide})
}

func PlayerSetClick(on bool) error {
	boot()
	st := playerSnapshot()
	if on && !st.Loaded {
		return errors.New("open a song first")
	}
	if on && st.Grid.Bpm <= 0 {
		return errors.New("set or detect the tempo first")
	}
	playerUpdate(func(p *PlayerState) { p.Click = on })
	return pushGuide()
}

func ensureAudio() error {
	if AudioStream.Get().Running {
		return nil
	}
	suppressReload.Store(true)
	defer suppressReload.Store(false)
	_, err := StartAudio()
	return err
}

func analyseSong(songID int64) library.Grid {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	res, err := sup.PlayerAnalyze(ctx)
	if err != nil || !res.Found {
		return library.Grid{}
	}
	g := library.Grid{Bpm: res.Bpm, OffsetMs: res.OffsetMs, BeatsPerBar: res.BeatsPerBar, Downbeat: res.Downbeat, Confidence: res.Confidence, Found: true}
	if err := lib.SaveGrid(songID, g); err != nil {
		logger.Warnf("could not store the beat grid: %v", err)
	}
	return g
}

func openSong(songID int64) (PlayerOpened, error) {
	if lib == nil {
		return PlayerOpened{}, errLibrary()
	}
	song, err := lib.Get(songID)
	if err != nil {
		return PlayerOpened{}, err
	}
	if err := ensureAudio(); err != nil {
		return PlayerOpened{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	loaded, err := sup.PlayerLoad(ctx, song.Path)
	if err != nil {
		playerUpdate(func(p *PlayerState) { p.Error = err.Error() })
		return PlayerOpened{}, err
	}
	grid, gerr := lib.GetGrid(songID)
	if gerr != nil {
		grid = analyseSong(songID)
	}
	zero := 0.0
	if err := playerControl(engine.PlayerControl{Speed: f(1), Pitch: &zero, Volume: f(0.9), Loop: &engine.LoopParams{}, CountIn: &engine.CountInParams{}}); err != nil {
		logger.Warnf("player defaults were not applied: %v", err)
	}
	playerMu.Lock()
	playerPeaks = loaded.Peaks
	playerMu.Unlock()
	click := playerSnapshot().Click
	playerUpdate(func(p *PlayerState) {
		*p = defaultPlayerState()
		p.Click = click
		p.Loaded = true
		p.SongID = songID
		p.Title = song.Title
		p.Artist = song.Artist
		p.Path = song.Path
		p.DurationMs = loaded.DurationMs
		p.Grid = grid
	})
	if err := pushGuide(); err != nil {
		logger.Warnf("the song click was not applied: %v", err)
	}
	return PlayerOpened{DurationMs: loaded.DurationMs, Peaks: loaded.Peaks, Grid: grid}, nil
}

func PlayerOpen(songID int64) (PlayerOpened, error) {
	boot()
	return openSong(songID)
}

func PlayerCurrent() (PlayerOpened, error) {
	boot()
	playerMu.Lock()
	defer playerMu.Unlock()
	if !ps.Loaded {
		return PlayerOpened{Peaks: []float32{}}, nil
	}
	return PlayerOpened{DurationMs: ps.DurationMs, Peaks: playerPeaks, Grid: ps.Grid}, nil
}

func PlayerClose() error {
	boot()
	if !playerSnapshot().Loaded {
		return nil
	}
	_ = playerControl(engine.PlayerControl{Action: "pause"})
	playerMu.Lock()
	playerPeaks = nil
	playerMu.Unlock()
	playerUpdate(func(p *PlayerState) { *p = defaultPlayerState() })
	return nil
}

func PlayerPlay() error {
	boot()
	return playerControl(engine.PlayerControl{Action: "play"})
}

func PlayerPause() error {
	boot()
	return playerControl(engine.PlayerControl{Action: "pause"})
}

func leavesLoop(loop LoopRegion, ms float64) bool {
	return loop.Enabled && (ms < loop.StartMs-1 || ms >= loop.EndMs)
}

func PlayerSeek(ms float64) error {
	boot()
	if loop := playerSnapshot().Loop; leavesLoop(loop, ms) {
		if err := PlayerSetLoop(loop.StartMs, loop.EndMs, false); err != nil {
			return err
		}
	}
	return playerControl(engine.PlayerControl{SeekMs: f(ms)})
}

func applySpeed(v float64) error {
	if v < 0.25 || v > 2 {
		return errors.New("speed must be between 25% and 200%")
	}
	if err := playerControl(engine.PlayerControl{Speed: f(v)}); err != nil {
		return err
	}
	playerUpdate(func(p *PlayerState) { p.Speed = v })
	pushCountIn()
	return nil
}

func PlayerSetSpeed(v float64) error {
	boot()
	return applySpeed(v)
}

func PlayerSetPitch(semitones float64) error {
	boot()
	if semitones < -12 || semitones > 12 {
		return errors.New("pitch must be within 12 semitones")
	}
	if err := playerControl(engine.PlayerControl{Pitch: f(semitones)}); err != nil {
		return err
	}
	playerUpdate(func(p *PlayerState) { p.Pitch = semitones })
	return nil
}

func PlayerSetVolume(v float64) error {
	boot()
	if err := playerControl(engine.PlayerControl{Volume: f(v)}); err != nil {
		return err
	}
	playerUpdate(func(p *PlayerState) { p.Volume = v })
	return nil
}

func PlayerSetLoop(startMs, endMs float64, enabled bool) error {
	boot()
	st := playerSnapshot()
	if enabled && (endMs <= startMs || startMs < 0 || (st.DurationMs > 0 && endMs > st.DurationMs+1)) {
		return errors.New("the loop must end after it starts and stay inside the song")
	}
	if err := playerControl(engine.PlayerControl{Loop: &engine.LoopParams{StartMs: startMs, EndMs: endMs, Enabled: enabled}}); err != nil {
		return err
	}
	playerUpdate(func(p *PlayerState) { p.Loop = LoopRegion{StartMs: startMs, EndMs: endMs, Enabled: enabled} })
	return nil
}

func PlayerSetCountIn(beats int) error {
	boot()
	if beats < 0 || beats > 16 {
		return errors.New("the count-in can be 0 to 16 beats")
	}
	playerUpdate(func(p *PlayerState) { p.CountIn = beats })
	pushCountIn()
	return nil
}

func PlayerSetGrid(bpm, offsetMs float64, beatsPerBar, downbeat int) (library.Grid, error) {
	boot()
	st := playerSnapshot()
	if !st.Loaded {
		return library.Grid{}, errors.New("open a song first")
	}
	g := library.Grid{Bpm: bpm, OffsetMs: offsetMs, BeatsPerBar: beatsPerBar, Downbeat: downbeat, Confidence: st.Grid.Confidence, UserEdited: true, Found: true}
	if err := lib.SaveGrid(st.SongID, g); err != nil {
		return library.Grid{}, err
	}
	playerUpdate(func(p *PlayerState) { p.Grid = g })
	pushCountIn()
	if err := pushGuide(); err != nil {
		return library.Grid{}, err
	}
	return g, nil
}

func PlayerDetectGrid() (library.Grid, error) {
	boot()
	st := playerSnapshot()
	if !st.Loaded {
		return library.Grid{}, errors.New("open a song first")
	}
	g := analyseSong(st.SongID)
	if !g.Found {
		return library.Grid{}, errors.New("no steady beat was found in this song")
	}
	playerUpdate(func(p *PlayerState) { p.Grid = g })
	pushCountIn()
	if err := pushGuide(); err != nil {
		return library.Grid{}, err
	}
	return g, nil
}

func PlayerSections() ([]library.Section, error) {
	boot()
	st := playerSnapshot()
	if !st.Loaded || lib == nil {
		return []library.Section{}, nil
	}
	return lib.Sections(st.SongID)
}

func PlayerSaveSection(name string, startMs, endMs float64) (library.Section, error) {
	boot()
	st := playerSnapshot()
	if !st.Loaded {
		return library.Section{}, errors.New("open a song first")
	}
	return lib.SaveSection(st.SongID, name, startMs, endMs)
}

func PlayerRenameSection(id int64, name string) error {
	boot()
	return lib.RenameSection(id, name)
}

func PlayerDeleteSection(id int64) error {
	boot()
	return lib.DeleteSection(id)
}

func handlePlayerEvent(ev engine.PlayerEvent) {
	playerUpdate(func(p *PlayerState) {
		p.PositionMs = ev.PositionMs
		p.Playing = ev.Playing
		p.Loops = ev.Loops
	})
}

func reloadPlayer() {
	st := playerSnapshot()
	if !st.Loaded {
		return
	}
	if _, err := openSong(st.SongID); err != nil {
		logger.Warnf("the song could not be reloaded after the audio restart: %v", err)
		return
	}
	if st.Loop.Enabled {
		_ = PlayerSetLoop(st.Loop.StartMs, st.Loop.EndMs, true)
	}
	if st.Speed != 1 {
		_ = applySpeed(st.Speed)
	}
	if st.Pitch != 0 {
		_ = PlayerSetPitch(st.Pitch)
	}
	_ = PlayerSeek(st.PositionMs)
}
