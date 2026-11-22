package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/kratejs/krate/packages/native/krate"

	"practice-music/api/clock"
	"practice-music/api/engine"
	"practice-music/api/latency"
	"practice-music/api/logger"
	"practice-music/api/settings"
)

type AudioState struct {
	Running               bool                  `json:"running"`
	Device                string                `json:"device"`
	DeviceID              string                `json:"deviceId"`
	SampleRate            int                   `json:"sampleRate"`
	Channels              int                   `json:"channels"`
	BufferFramesRequested int                   `json:"bufferFramesRequested"`
	BufferRange           *engine.BufferRange   `json:"bufferRange"`
	Mode                  string                `json:"mode"`
	BufferFrames          int                   `json:"bufferFrames"`
	PeriodFrames          int                   `json:"periodFrames"`
	PeriodMs              float64               `json:"periodMs"`
	StreamLatencyMs       float64               `json:"streamLatencyMs"`
	Format                string                `json:"format"`
	Notice                string                `json:"notice"`
	Error                 string                `json:"error"`
	Metronome             engine.MetronomeState `json:"metronome"`
	Capture               *engine.LinkInfo      `json:"capture"`
	Monitor               *engine.LinkInfo      `json:"monitor"`
}

type LatencyState struct {
	Snapshot           latency.Snapshot `json:"snapshot"`
	EngineClockErrorMs float64          `json:"engineClockErrorMs"`
}

type ClickResult struct {
	ID uint64 `json:"id"`
}

var AudioStream = krate.NewSignal(AudioState{
	Metronome: engine.MetronomeState{Bpm: 120, Volume: 0.5, BeatsPerBar: 4},
})

var Latency = krate.NewSignal(LatencyState{Snapshot: latency.NewTracker().Snapshot()})

var (
	audioMu     sync.Mutex
	wantAudio   bool
	audioParams engine.AudioParams
	tracker     = latency.NewTracker()
	eventsOnce  sync.Once
)

func paramsFrom(s settings.Settings) engine.AudioParams {
	mode := s.Audio.Mode
	if runtime.GOOS != "windows" {
		mode = "shared"
	}
	return engine.AudioParams{
		Mode:          mode,
		Host:          s.Audio.Host,
		OutputDevice:  s.Audio.OutputDevice,
		MonitorDevice: s.Audio.MonitorDevice,
		InputDevice:   s.Audio.InputDevice,
		SampleRate:    s.Audio.SampleRate,
		BufferFrames:  s.Audio.BufferFrames,
	}
}

func setAudio(change func(*AudioState)) {
	st := AudioStream.Get()
	change(&st)
	AudioStream.Set(st)
}

func publishLatency() {
	st := LatencyState{Snapshot: tracker.Snapshot()}
	if est, ok := sup.ClockEstimate(); ok {
		st.EngineClockErrorMs = float64(est.ErrorUs()) / 1000
	}
	Latency.Set(st)
}

func startEvents() {
	eventsOnce.Do(func() {
		events, _ := sup.Subscribe(256)
		go func() {
			for ev := range events {
				handleEvent(ev)
			}
		}()
		sup.OnStatus(onEngineStatus)
	})
}

func handleEvent(ev engine.Event) {
	switch ev.Name {
	case "click_report":
		rep, err := engine.DecodeClickReport(ev.Data)
		if err != nil {
			logger.Warnf("bad click report: %v", err)
			return
		}
		est, ok := sup.ClockEstimate()
		if !ok {
			return
		}
		if _, done := tracker.AddReport(latency.Report{
			ID:           rep.ID,
			EngineRecvUs: est.ToLocal(rep.EngineRecvUs),
			CallbackUs:   est.ToLocal(rep.CallbackUs),
			PlaybackNs:   rep.PlaybackNs,
			BufferFrames: rep.BufferFrames,
			SampleRate:   rep.SampleRate,
		}); done {
			publishLatency()
		}
	case "player":
		if pev, err := engine.DecodePlayerEvent(ev.Data); err == nil {
			handlePlayerEvent(pev)
		}
	case "meters":
		if frame, err := engine.DecodeMeters(ev.Data); err == nil {
			MeterStream.Set(frame)
		}
	case "beat":
		if frame, err := engine.DecodeBeat(ev.Data); err == nil {
			BeatStream.Set(frame)
		}
	case "audio_error":
		var data struct {
			Message string `json:"message"`
		}
		if err := json.Unmarshal(ev.Data, &data); err == nil {
			logger.Errorf("audio stream error: %s", data.Message)
			setAudio(func(a *AudioState) { a.Running = false; a.Error = data.Message })
		}
	}
}

var lastRunningPid int

func onEngineStatus(st engine.Status) {
	if st.State != engine.StateRunning {
		if st.State != engine.StateStarting {
			setAudio(func(a *AudioState) { a.Running = false })
		}
		return
	}
	audioMu.Lock()
	want := wantAudio
	pid := st.Pid
	fresh := pid != lastRunningPid
	lastRunningPid = pid
	audioMu.Unlock()
	if want && fresh {
		go func() {
			if _, err := startAudioNow(); err != nil {
				logger.Warnf("audio did not restart after the engine came back: %v", err)
			}
		}()
	}
}

func startAudioNow() (AudioState, error) {
	audioMu.Lock()
	params := audioParams
	audioMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	info, err := sup.AudioStart(ctx, params)
	notice := ""
	if err != nil && params.Mode == "lowlatency" {
		logger.Warnf("low-latency mode failed (%v), falling back to shared mode", err)
		notice = fmt.Sprintf("Low-latency mode failed (%v). Using the standard shared mode instead.", err)
		params.Mode = "shared"
		info, err = sup.AudioStart(ctx, params)
	}
	if err != nil {
		setAudio(func(a *AudioState) { a.Running = false; a.Error = err.Error(); a.Notice = "" })
		return AudioStream.Get(), err
	}
	engineMetro, err := pushSession(ctx, false)
	if err != nil {
		logger.Warnf("mixer and metronome settings were not applied: %v", err)
	}
	setAudio(func(a *AudioState) {
		a.Running = true
		a.Error = ""
		a.Device = info.Device
		a.DeviceID = info.DeviceID
		a.SampleRate = info.SampleRate
		a.Channels = info.Channels
		a.BufferFramesRequested = info.BufferFramesRequested
		a.BufferRange = info.BufferRange
		a.Mode = info.Mode
		a.BufferFrames = info.BufferFrames
		a.PeriodFrames = info.PeriodFrames
		a.PeriodMs = deref(info.PeriodMs)
		a.StreamLatencyMs = deref(info.StreamLatencyMs)
		a.Format = info.Format
		a.Notice = notice
		a.Metronome = engineMetro
		a.Capture = info.Capture
		a.Monitor = info.Monitor
	})
	tracker.Reset()
	publishLatency()
	if !suppressReload.Load() {
		go reloadPlayer()
	}
	logger.Infof("audio started on %s at %d Hz (%s)", info.Device, info.SampleRate, info.Mode)
	return AudioStream.Get(), nil
}

func StartAudio() (AudioState, error) {
	boot()
	doc, _, err := store.Load()
	if err != nil {
		return AudioState{}, err
	}
	audioMu.Lock()
	wantAudio = true
	audioParams = paramsFrom(doc)
	audioMu.Unlock()
	return startAudioNow()
}

func StopAudio() (AudioState, error) {
	boot()
	audioMu.Lock()
	wantAudio = false
	audioMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := sup.AudioStop(ctx)
	setAudio(func(a *AudioState) {
		a.Running = false
		a.Metronome.Running = false
	})
	return AudioStream.Get(), err
}

func ClockProbe() float64 {
	boot()
	return float64(clock.MonoUs())
}

func Click(uiPressUs float64, uiOffsetUs float64) (ClickResult, error) {
	boot()
	hostRecv := clock.MonoUs()
	if _, ok := sup.ClockEstimate(); !ok {
		return ClickResult{}, errors.New("engine clock is not synchronised yet")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	hostSend := clock.MonoUs()
	ack, err := sup.Click(ctx)
	if err != nil {
		return ClickResult{}, err
	}
	if _, done := tracker.AddRequest(latency.Request{
		ID:         ack.ID,
		UIPressUs:  int64(uiPressUs + uiOffsetUs),
		HostRecvUs: hostRecv,
		HostSendUs: hostSend,
	}); done {
		publishLatency()
	}
	return ClickResult{ID: ack.ID}, nil
}

func ResetLatency() LatencyState {
	boot()
	tracker.Reset()
	publishLatency()
	return Latency.Get()
}

func SetMetronome(bpm float64, volume float64, beatsPerBar int, running bool) (engine.MetronomeState, error) {
	boot()
	st := GetMetronome()
	st.Bpm = bpm
	st.Volume = volume
	st.BeatsPerBar = beatsPerBar
	if _, err := SetMetronomeState(st); err != nil {
		return engine.MetronomeState{}, err
	}
	if running {
		return startMetronome()
	}
	return stopMetronome()
}

func MeasureLoopback(inputDevice string, count int) (engine.LoopbackResult, error) {
	boot()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	return sup.Loopback(ctx, inputDevice, count)
}

func applyAudioSettings(saved settings.Settings) {
	next := paramsFrom(saved)
	audioMu.Lock()
	changed := wantAudio && next != audioParams
	if changed {
		audioParams = next
	}
	audioMu.Unlock()
	if changed {
		go func() {
			if _, err := startAudioNow(); err != nil {
				logger.Warnf("audio did not restart with the new settings: %v", err)
			}
		}()
	}
}

func deref(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

type AudioStats struct {
	Callbacks int64 `json:"callbacks"`
	LateWakes int64 `json:"lateWakes"`
}

func GetAudioStats() (AudioStats, error) {
	boot()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	st, err := sup.AudioStatus(ctx)
	if err != nil {
		return AudioStats{}, err
	}
	return AudioStats{Callbacks: st.Callbacks, LateWakes: st.LateWakes}, nil
}

func LowLatencyDevices() ([]engine.WasapiDevice, error) {
	boot()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	return sup.WasapiProbe(ctx)
}

var suppressReload atomic.Bool
