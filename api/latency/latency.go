package latency

import (
	"math"
	"slices"
	"sync"
)

const (
	maxPending = 256
	maxHistory = 200
	recentKept = 24
)

type Request struct {
	ID         uint64
	UIPressUs  int64
	HostRecvUs int64
	HostSendUs int64
}

type Report struct {
	ID           uint64
	EngineRecvUs int64
	CallbackUs   int64
	PlaybackNs   int64
	BufferFrames int
	SampleRate   int
}

type Breakdown struct {
	ID             uint64  `json:"id"`
	UIToHostMs     float64 `json:"uiToHostMs"`
	HostToEngineMs float64 `json:"hostToEngineMs"`
	EngineQueueMs  float64 `json:"engineQueueMs"`
	OutputMs       float64 `json:"outputMs"`
	TotalMs        float64 `json:"totalMs"`
	BufferFrames   int     `json:"bufferFrames"`
	SampleRate     int     `json:"sampleRate"`
	BufferPeriodMs float64 `json:"bufferPeriodMs"`
}

func ms(us int64) float64 {
	return float64(us) / 1000
}

func Compute(req Request, rep Report) Breakdown {
	b := Breakdown{
		ID:             req.ID,
		UIToHostMs:     ms(req.HostRecvUs - req.UIPressUs),
		HostToEngineMs: ms(rep.EngineRecvUs - req.HostSendUs),
		EngineQueueMs:  ms(rep.CallbackUs - rep.EngineRecvUs),
		OutputMs:       float64(rep.PlaybackNs) / 1e6,
		BufferFrames:   rep.BufferFrames,
		SampleRate:     rep.SampleRate,
	}
	if rep.SampleRate > 0 {
		b.BufferPeriodMs = float64(rep.BufferFrames) / float64(rep.SampleRate) * 1000
	}
	b.TotalMs = b.UIToHostMs + b.HostToEngineMs + b.EngineQueueMs + b.OutputMs
	return b
}

type Stats struct {
	Count    int     `json:"count"`
	MinMs    float64 `json:"minMs"`
	MedianMs float64 `json:"medianMs"`
	P95Ms    float64 `json:"p95Ms"`
	MaxMs    float64 `json:"maxMs"`
}

func Summarize(values []float64) Stats {
	if len(values) == 0 {
		return Stats{}
	}
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	rank := func(p float64) float64 {
		idx := int(math.Ceil(p*float64(len(sorted)))) - 1
		return sorted[max(0, min(idx, len(sorted)-1))]
	}
	return Stats{
		Count:    len(sorted),
		MinMs:    sorted[0],
		MedianMs: rank(0.5),
		P95Ms:    rank(0.95),
		MaxMs:    sorted[len(sorted)-1],
	}
}

type Snapshot struct {
	HasLast    bool        `json:"hasLast"`
	Last       Breakdown   `json:"last"`
	Recent     []Breakdown `json:"recent"`
	Total      Stats       `json:"total"`
	UIToHost   Stats       `json:"uiToHost"`
	HostEngine Stats       `json:"hostToEngine"`
	Queue      Stats       `json:"engineQueue"`
	Output     Stats       `json:"output"`
}

type half struct {
	req *Request
	rep *Report
}

type Tracker struct {
	mu      sync.Mutex
	pending map[uint64]*half
	order   []uint64
	history []Breakdown
}

func NewTracker() *Tracker {
	return &Tracker{pending: map[uint64]*half{}}
}

func (t *Tracker) slot(id uint64) *half {
	h, ok := t.pending[id]
	if !ok {
		h = &half{}
		t.pending[id] = h
		t.order = append(t.order, id)
		for len(t.order) > maxPending {
			delete(t.pending, t.order[0])
			t.order = t.order[1:]
		}
	}
	return h
}

func (t *Tracker) finish(id uint64, h *half) (Breakdown, bool) {
	if h.req == nil || h.rep == nil {
		return Breakdown{}, false
	}
	delete(t.pending, id)
	if i := slices.Index(t.order, id); i >= 0 {
		t.order = slices.Delete(t.order, i, i+1)
	}
	b := Compute(*h.req, *h.rep)
	t.history = append(t.history, b)
	if len(t.history) > maxHistory {
		t.history = t.history[len(t.history)-maxHistory:]
	}
	return b, true
}

func (t *Tracker) AddRequest(req Request) (Breakdown, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	h := t.slot(req.ID)
	h.req = &req
	return t.finish(req.ID, h)
}

func (t *Tracker) AddReport(rep Report) (Breakdown, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	h := t.slot(rep.ID)
	h.rep = &rep
	return t.finish(rep.ID, h)
}

func (t *Tracker) Reset() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.pending = map[uint64]*half{}
	t.order = nil
	t.history = nil
}

func (t *Tracker) Snapshot() Snapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	snap := Snapshot{Recent: []Breakdown{}}
	if len(t.history) == 0 {
		return snap
	}
	snap.HasLast = true
	snap.Last = t.history[len(t.history)-1]
	from := max(0, len(t.history)-recentKept)
	snap.Recent = slices.Clone(t.history[from:])
	pick := func(f func(Breakdown) float64) Stats {
		values := make([]float64, len(t.history))
		for i, b := range t.history {
			values[i] = f(b)
		}
		return Summarize(values)
	}
	snap.Total = pick(func(b Breakdown) float64 { return b.TotalMs })
	snap.UIToHost = pick(func(b Breakdown) float64 { return b.UIToHostMs })
	snap.HostEngine = pick(func(b Breakdown) float64 { return b.HostToEngineMs })
	snap.Queue = pick(func(b Breakdown) float64 { return b.EngineQueueMs })
	snap.Output = pick(func(b Breakdown) float64 { return b.OutputMs })
	return snap
}
