package engine

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"practice-music/api/clock"
	"practice-music/api/logger"
)

const syncRounds = 12

type AudioParams struct {
	Mode          string `json:"mode"`
	Host          string `json:"host"`
	OutputDevice  string `json:"outputDevice"`
	MonitorDevice string `json:"monitorDevice"`
	InputDevice   string `json:"inputDevice"`
	SampleRate    int    `json:"sampleRate"`
	BufferFrames  int    `json:"bufferFrames"`
}

type LinkInfo struct {
	Mode         string `json:"mode"`
	Running      bool   `json:"running"`
	Device       string `json:"device"`
	Channels     int    `json:"channels"`
	SampleRate   int    `json:"sampleRate"`
	RateMismatch bool   `json:"rateMismatch"`
	Error        string `json:"error"`
}

type AudioInfo struct {
	Device                string       `json:"device"`
	DeviceID              string       `json:"deviceId"`
	SampleRate            int          `json:"sampleRate"`
	Channels              int          `json:"channels"`
	BufferFramesRequested int          `json:"bufferFramesRequested"`
	BufferRange           *BufferRange `json:"bufferRange"`
	Mode                  string       `json:"mode"`
	BufferFrames          int          `json:"bufferFrames"`
	PeriodFrames          int          `json:"periodFrames"`
	PeriodMs              *float64     `json:"periodMs"`
	StreamLatencyMs       *float64     `json:"streamLatencyMs"`
	Format                string       `json:"format"`
	Capture               *LinkInfo    `json:"capture"`
	Monitor               *LinkInfo    `json:"monitor"`
}

type MetronomeState struct {
	Running     bool    `json:"running"`
	Bpm         float64 `json:"bpm"`
	Volume      float64 `json:"volume"`
	BeatsPerBar int     `json:"beatsPerBar"`
	Subdivision int     `json:"subdivision"`
	SubLevel    float64 `json:"subLevel"`
	Accents     []int   `json:"accents"`
	PolyBeats   int     `json:"polyBeats"`
	PolyLevel   float64 `json:"polyLevel"`
	PlayBars    int     `json:"playBars"`
	SilentBars  int     `json:"silentBars"`
}

type MetronomeParams struct {
	Bpm         *float64 `json:"bpm,omitempty"`
	Volume      *float64 `json:"volume,omitempty"`
	BeatsPerBar *int     `json:"beatsPerBar,omitempty"`
	Subdivision *int     `json:"subdivision,omitempty"`
	SubLevel    *float64 `json:"subLevel,omitempty"`
	Accents     []int    `json:"accents,omitempty"`
	PolyBeats   *int     `json:"polyBeats,omitempty"`
	PolyLevel   *float64 `json:"polyLevel,omitempty"`
	PlayBars    *int     `json:"playBars,omitempty"`
	SilentBars  *int     `json:"silentBars,omitempty"`
	Sound       *string  `json:"sound,omitempty"`
	Running     *bool    `json:"running,omitempty"`
}

type AudioStatus struct {
	Running         bool           `json:"running"`
	Callbacks       int64          `json:"callbacks"`
	LateWakes       int64          `json:"lateWakes"`
	LastBufferFrame int            `json:"lastBufferFrames"`
	Metronome       MetronomeState `json:"metronome"`
	Info            AudioInfo      `json:"info"`
}

type ClickAck struct {
	ID           uint64 `json:"id"`
	EngineRecvUs int64  `json:"engineRecvUs"`
}

type ClickReport struct {
	ID           uint64 `json:"id"`
	EngineRecvUs int64  `json:"engineRecvUs"`
	CallbackUs   int64  `json:"callbackUs"`
	PlaybackNs   int64  `json:"playbackNs"`
	BufferFrames int    `json:"bufferFrames"`
	SampleRate   int    `json:"sampleRate"`
}

type LoopbackResult struct {
	Detected  int       `json:"detected"`
	Missed    int       `json:"missed"`
	NoisePeak float64   `json:"noisePeak"`
	Threshold float64   `json:"threshold"`
	RoundTrip []float64 `json:"roundTripMs"`
	MedianMs  *float64  `json:"medianMs"`
	MinMs     *float64  `json:"minMs"`
	MaxMs     *float64  `json:"maxMs"`
	InputRate int       `json:"inputSampleRate"`
}

func (s *Supervisor) AudioStart(ctx context.Context, p AudioParams) (AudioInfo, error) {
	var info AudioInfo
	err := s.Call(ctx, "audio_start", p, &info)
	return info, err
}

func (s *Supervisor) AudioStop(ctx context.Context) error {
	return s.Call(ctx, "audio_stop", nil, nil)
}

func (s *Supervisor) AudioStatus(ctx context.Context) (AudioStatus, error) {
	var st AudioStatus
	err := s.Call(ctx, "audio_status", nil, &st)
	return st, err
}

func (s *Supervisor) Click(ctx context.Context) (ClickAck, error) {
	var ack ClickAck
	err := s.Call(ctx, "click", nil, &ack)
	return ack, err
}

func (s *Supervisor) MetronomeSet(ctx context.Context, p MetronomeParams) (MetronomeState, error) {
	var st MetronomeState
	err := s.Call(ctx, "metronome_set", p, &st)
	return st, err
}

func (s *Supervisor) Loopback(ctx context.Context, inputDevice string, count int) (LoopbackResult, error) {
	var res LoopbackResult
	timeout := time.Duration(count)*900*time.Millisecond + 5*time.Second
	err := s.CallTimeout(ctx, timeout, "loopback_measure", map[string]any{
		"inputDevice": inputDevice,
		"count":       count,
		"volume":      0.8,
	}, &res)
	return res, err
}

func (s *Supervisor) ClockEstimate() (clock.Estimate, bool) {
	est := s.clockEst.Load()
	if est == nil {
		return clock.Estimate{}, false
	}
	return *est, true
}

func (s *Supervisor) SyncClock(ctx context.Context) (clock.Estimate, error) {
	samples := make([]clock.Sample, 0, syncRounds)
	for i := 0; i < syncRounds; i++ {
		var pong struct {
			NowUs int64 `json:"nowUs"`
		}
		sent := clock.MonoUs()
		if err := s.Call(ctx, "ping", nil, &pong); err != nil {
			return clock.Estimate{}, err
		}
		received := clock.MonoUs()
		if pong.NowUs == 0 {
			return clock.Estimate{}, errors.New("engine did not report its clock")
		}
		samples = append(samples, clock.Sample{SentUs: sent, RemoteUs: pong.NowUs, ReceivedUs: received})
	}
	est, ok := clock.Best(samples)
	if !ok {
		return clock.Estimate{}, errors.New("no usable clock samples")
	}
	s.clockEst.Store(&est)
	return est, nil
}

func (s *Supervisor) autoSync(p *process) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if s.current() != p {
		return
	}
	est, err := s.SyncClock(ctx)
	if err != nil {
		logger.Warnf("engine clock sync failed: %v", err)
		return
	}
	logger.Infof("engine clock synced, offset error within %d us", est.ErrorUs())
}

func DecodeClickReport(data json.RawMessage) (ClickReport, error) {
	var r ClickReport
	err := json.Unmarshal(data, &r)
	return r, err
}

type WasapiDevice struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	MixRate int    `json:"mixRate"`
	Shared  *struct {
		DefaultFrames     int     `json:"defaultFrames"`
		FundamentalFrames int     `json:"fundamentalFrames"`
		MinFrames         int     `json:"minFrames"`
		MaxFrames         int     `json:"maxFrames"`
		MinMs             float64 `json:"minMs"`
		DefaultMs         float64 `json:"defaultMs"`
	} `json:"shared"`
	Exclusive struct {
		Supported bool     `json:"supported"`
		Format    *string  `json:"format"`
		DefaultMs *float64 `json:"defaultMs"`
		MinMs     *float64 `json:"minMs"`
	} `json:"exclusive"`
}

func (s *Supervisor) WasapiProbe(ctx context.Context) ([]WasapiDevice, error) {
	var res struct {
		Devices []WasapiDevice `json:"devices"`
	}
	if err := s.Call(ctx, "wasapi_probe", nil, &res); err != nil {
		return nil, err
	}
	if res.Devices == nil {
		res.Devices = []WasapiDevice{}
	}
	return res.Devices, nil
}
