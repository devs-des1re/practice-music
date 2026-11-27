package downloads

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"practice-music/api/refusal"
)

type State string

const (
	StateQueued    State = "queued"
	StateRunning   State = "running"
	StateDone      State = "done"
	StateFailed    State = "failed"
	StateCancelled State = "cancelled"
)

type Job struct {
	ID        int64   `json:"id"`
	URL       string  `json:"url"`
	Format    string  `json:"format"`
	Quality   string  `json:"quality"`
	State     State   `json:"state"`
	Percent   float64 `json:"percent"`
	Speed     string  `json:"speed"`
	ETA       string  `json:"eta"`
	Title     string  `json:"title"`
	Error     string  `json:"error"`
	FilePath  string  `json:"filePath"`
	Attempts  int     `json:"attempts"`
	CreatedAt int64   `json:"createdAt"`
	UpdatedAt int64   `json:"updatedAt"`
}

func (j Job) Finished() bool {
	return j.State == StateDone || j.State == StateFailed || j.State == StateCancelled
}

type Request struct {
	URL     string `json:"url"`
	Format  string `json:"format"`
	Quality string `json:"quality"`
}

type Progress struct {
	Percent float64
	Speed   string
	ETA     string
	Title   string
}

type Result struct {
	Path  string
	Title string
}

type Runner interface {
	Run(ctx context.Context, job Job, onProgress func(Progress)) (Result, error)
}

type StoredJob struct {
	ID   int64
	Data []byte
}

type Store interface {
	Insert(data []byte) (int64, error)
	Update(id int64, data []byte) error
	Delete(id int64) error
	All() ([]StoredJob, error)
}

type Options struct {
	Concurrency int
	OnChange    func([]Job)
	OnDone      func(Job)
	Now         func() time.Time
	ChangeEvery time.Duration
}

var qualities = map[string][]string{
	"mp3": {"best", "320", "256", "192", "128"},
	"mp4": {"best", "1080", "720", "480", "360"},
}

func Validate(req Request) (Request, error) {
	req.URL = strings.TrimSpace(req.URL)
	if req.URL == "" {
		return req, refusal.New("paste a link to download")
	}
	if len(req.URL) > 2048 {
		return req, refusal.New("that link is too long")
	}
	u, err := url.Parse(req.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return req, refusal.New("only http and https links can be downloaded")
	}
	req.Format = strings.ToLower(strings.TrimSpace(req.Format))
	if req.Format == "" {
		req.Format = "mp3"
	}
	allowed, ok := qualities[req.Format]
	if !ok {
		return req, fmt.Errorf("format %q is not supported, choose mp3 or mp4", req.Format)
	}
	req.Quality = strings.ToLower(strings.TrimSpace(req.Quality))
	if req.Quality == "" {
		req.Quality = "best"
	}
	if !slices.Contains(allowed, req.Quality) {
		return req, fmt.Errorf("quality %q is not available for %s", req.Quality, req.Format)
	}
	return req, nil
}

type Manager struct {
	store  Store
	runner Runner
	opts   Options

	mu       sync.Mutex
	jobs     []*Job
	cancels  map[int64]context.CancelFunc
	lastEmit time.Time
	wg       sync.WaitGroup
	closed   bool
	notify   chan []Job
	notified sync.WaitGroup
}

func NewManager(store Store, runner Runner, opts Options) *Manager {
	if opts.Concurrency < 1 {
		opts.Concurrency = 2
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.ChangeEvery <= 0 {
		opts.ChangeEvery = 200 * time.Millisecond
	}
	m := &Manager{store: store, runner: runner, opts: opts, cancels: map[int64]context.CancelFunc{}, notify: make(chan []Job, 1)}
	if opts.OnChange != nil {
		m.notified.Add(1)
		go func() {
			defer m.notified.Done()
			for snap := range m.notify {
				opts.OnChange(snap)
			}
		}()
	}
	return m
}

func (m *Manager) Load() error {
	rows, err := m.store.All()
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.jobs = nil
	for _, row := range rows {
		var job Job
		if err := json.Unmarshal(row.Data, &job); err != nil {
			continue
		}
		job.ID = row.ID
		if job.State == StateRunning {
			job.State = StateQueued
			job.Percent = 0
			job.Speed = ""
			job.ETA = ""
		}
		m.jobs = append(m.jobs, &job)
	}
	m.pumpLocked()
	return nil
}

func (m *Manager) snapshotLocked() []Job {
	out := make([]Job, len(m.jobs))
	for i, j := range m.jobs {
		out[i] = *j
	}
	return out
}

func (m *Manager) Jobs() []Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.snapshotLocked()
}

func (m *Manager) emitLocked(force bool) {
	if m.opts.OnChange == nil {
		return
	}
	now := m.opts.Now()
	if !force && now.Sub(m.lastEmit) < m.opts.ChangeEvery {
		return
	}
	m.lastEmit = now
	if m.notify == nil {
		return
	}
	select {
	case <-m.notify:
	default:
	}
	m.notify <- m.snapshotLocked()
}

func (m *Manager) persistLocked(j *Job) {
	j.UpdatedAt = m.opts.Now().UnixMilli()
	data, err := json.Marshal(j)
	if err != nil {
		return
	}
	_ = m.store.Update(j.ID, data)
}

func (m *Manager) find(id int64) *Job {
	for _, j := range m.jobs {
		if j.ID == id {
			return j
		}
	}
	return nil
}

func (m *Manager) Enqueue(req Request) (Job, error) {
	req, err := Validate(req)
	if err != nil {
		return Job{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Job{}, errors.New("downloads are shutting down")
	}
	now := m.opts.Now().UnixMilli()
	job := &Job{URL: req.URL, Format: req.Format, Quality: req.Quality, State: StateQueued, CreatedAt: now, UpdatedAt: now}
	data, _ := json.Marshal(job)
	id, err := m.store.Insert(data)
	if err != nil {
		return Job{}, err
	}
	job.ID = id
	m.persistLocked(job)
	m.jobs = append(m.jobs, job)
	m.pumpLocked()
	m.emitLocked(true)
	return *job, nil
}

func (m *Manager) runningLocked() int {
	n := 0
	for _, j := range m.jobs {
		if j.State == StateRunning {
			n++
		}
	}
	return n
}

func (m *Manager) pumpLocked() {
	if m.closed {
		return
	}
	for _, j := range m.jobs {
		if m.runningLocked() >= m.opts.Concurrency {
			return
		}
		if j.State != StateQueued {
			continue
		}
		j.State = StateRunning
		j.Error = ""
		j.Percent = 0
		j.Speed = ""
		j.ETA = ""
		j.Attempts++
		m.persistLocked(j)
		ctx, cancel := context.WithCancel(context.Background())
		m.cancels[j.ID] = cancel
		m.wg.Add(1)
		go m.run(ctx, *j)
	}
}

func (m *Manager) run(ctx context.Context, job Job) {
	defer m.wg.Done()
	res, err := m.runner.Run(ctx, job, func(p Progress) {
		m.mu.Lock()
		defer m.mu.Unlock()
		cur := m.find(job.ID)
		if cur == nil || cur.State != StateRunning {
			return
		}
		cur.Percent = p.Percent
		cur.Speed = p.Speed
		cur.ETA = p.ETA
		if p.Title != "" {
			cur.Title = p.Title
		}
		m.emitLocked(false)
	})
	m.mu.Lock()
	cur := m.find(job.ID)
	delete(m.cancels, job.ID)
	if cur == nil {
		m.pumpLocked()
		m.mu.Unlock()
		return
	}
	switch {
	case cur.State == StateCancelled:
	case ctx.Err() != nil:
		cur.State = StateCancelled
		cur.Error = ""
	case err != nil:
		cur.State = StateFailed
		cur.Error = err.Error()
	default:
		cur.State = StateDone
		cur.Percent = 100
		cur.Speed = ""
		cur.ETA = ""
		cur.FilePath = res.Path
		if res.Title != "" {
			cur.Title = res.Title
		}
	}
	m.persistLocked(cur)
	finished := *cur
	m.pumpLocked()
	m.emitLocked(true)
	m.mu.Unlock()
	if finished.State == StateDone && m.opts.OnDone != nil {
		m.opts.OnDone(finished)
	}
}

func (m *Manager) Cancel(id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.find(id)
	if j == nil {
		return refusal.New("that download no longer exists")
	}
	switch j.State {
	case StateQueued:
		j.State = StateCancelled
		m.persistLocked(j)
	case StateRunning:
		j.State = StateCancelled
		m.persistLocked(j)
		if cancel := m.cancels[id]; cancel != nil {
			cancel()
		}
	default:
		return refusal.New("that download is not active")
	}
	m.emitLocked(true)
	return nil
}

func (m *Manager) Retry(id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.find(id)
	if j == nil {
		return refusal.New("that download no longer exists")
	}
	if j.State != StateFailed && j.State != StateCancelled {
		return refusal.New("only failed or cancelled downloads can be retried")
	}
	j.State = StateQueued
	j.Error = ""
	j.Percent = 0
	m.persistLocked(j)
	m.pumpLocked()
	m.emitLocked(true)
	return nil
}

func (m *Manager) Remove(id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	j := m.find(id)
	if j == nil {
		return nil
	}
	if !j.Finished() {
		return refusal.New("cancel the download before removing it")
	}
	if err := m.store.Delete(id); err != nil {
		return err
	}
	m.jobs = slices.DeleteFunc(m.jobs, func(x *Job) bool { return x.ID == id })
	m.emitLocked(true)
	return nil
}

func (m *Manager) ClearFinished() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var keep []*Job
	for _, j := range m.jobs {
		if j.Finished() {
			if err := m.store.Delete(j.ID); err != nil {
				return err
			}
			continue
		}
		keep = append(keep, j)
	}
	m.jobs = keep
	m.emitLocked(true)
	return nil
}

func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	for _, cancel := range m.cancels {
		cancel()
	}
	m.mu.Unlock()
	m.wg.Wait()
	m.mu.Lock()
	if m.notify != nil {
		close(m.notify)
		m.notify = nil
	}
	m.mu.Unlock()
	m.notified.Wait()
}
