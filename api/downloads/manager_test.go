package downloads

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type memStore struct {
	mu   sync.Mutex
	next int64
	rows map[int64][]byte
}

func newStore() *memStore {
	return &memStore{rows: map[int64][]byte{}}
}

func (s *memStore) Insert(data []byte) (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	s.rows[s.next] = data
	return s.next, nil
}

func (s *memStore) Update(id int64, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows[id] = data
	return nil
}

func (s *memStore) Delete(id int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rows, id)
	return nil
}

func (s *memStore) All() ([]StoredJob, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []StoredJob
	for id := int64(1); id <= s.next; id++ {
		if data, ok := s.rows[id]; ok {
			out = append(out, StoredJob{ID: id, Data: data})
		}
	}
	return out, nil
}

func (s *memStore) state(t *testing.T, id int64) State {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	var j Job
	if err := json.Unmarshal(s.rows[id], &j); err != nil {
		t.Fatal(err)
	}
	return j.State
}

type gate struct {
	release chan error
	started chan struct{}
}

type fakeRunner struct {
	mu      sync.Mutex
	gates   map[int64]*gate
	running int
	peak    int
	runs    map[int64]int
}

func newRunner() *fakeRunner {
	return &fakeRunner{gates: map[int64]*gate{}, runs: map[int64]int{}}
}

func (f *fakeRunner) gateFor(id int64) *gate {
	f.mu.Lock()
	defer f.mu.Unlock()
	g, ok := f.gates[id]
	if !ok {
		g = &gate{release: make(chan error, 4), started: make(chan struct{}, 4)}
		f.gates[id] = g
	}
	return g
}

func (f *fakeRunner) Run(ctx context.Context, job Job, onProgress func(Progress)) (Result, error) {
	g := f.gateFor(job.ID)
	f.mu.Lock()
	f.running++
	f.peak = max(f.peak, f.running)
	f.runs[job.ID]++
	f.mu.Unlock()
	defer func() {
		f.mu.Lock()
		f.running--
		f.mu.Unlock()
	}()
	g.started <- struct{}{}
	onProgress(Progress{Percent: 42, Speed: "1 MB/s", ETA: "0:10", Title: "Song"})
	select {
	case err := <-g.release:
		if err != nil {
			return Result{}, err
		}
		return Result{Path: "/lib/song-" + job.URL[len(job.URL)-1:] + ".mp3", Title: "Song"}, nil
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func stateOf(m *Manager, id int64) State {
	for _, j := range m.Jobs() {
		if j.ID == id {
			return j.State
		}
	}
	return ""
}

func newManager(t *testing.T, concurrency int, opts Options) (*Manager, *fakeRunner, *memStore) {
	t.Helper()
	store := newStore()
	runner := newRunner()
	opts.Concurrency = concurrency
	m := NewManager(store, runner, opts)
	t.Cleanup(m.Close)
	return m, runner, store
}

func enqueue(t *testing.T, m *Manager, suffix string) Job {
	t.Helper()
	j, err := m.Enqueue(Request{URL: "https://example.com/v" + suffix, Format: "mp3"})
	if err != nil {
		t.Fatal(err)
	}
	return j
}

func TestValidateAcceptsDefaultsAndRejectsBadInput(t *testing.T) {
	good, err := Validate(Request{URL: "  https://example.com/watch?v=1  "})
	if err != nil || good.Format != "mp3" || good.Quality != "best" || good.URL != "https://example.com/watch?v=1" {
		t.Fatalf("%+v %v", good, err)
	}
	if _, err := Validate(Request{URL: "https://a.b/x", Format: "MP4", Quality: "720"}); err != nil {
		t.Fatal(err)
	}
	bad := []Request{
		{URL: ""},
		{URL: "file:///c:/secret.mp3"},
		{URL: "javascript:alert(1)"},
		{URL: "--exec rm -rf"},
		{URL: "https:///nohost"},
		{URL: "https://a.b/x", Format: "wav"},
		{URL: "https://a.b/x", Format: "mp3", Quality: "720"},
		{URL: "https://a.b/x", Format: "mp4", Quality: "999"},
		{URL: "https://a.b/" + strings.Repeat("x", 3000)},
	}
	for _, r := range bad {
		if _, err := Validate(r); err == nil {
			t.Errorf("%+v should be rejected", r)
		}
	}
}

func TestJobsRunToCompletionAndNotifyOnDone(t *testing.T) {
	var mu sync.Mutex
	var done []Job
	m, runner, store := newManager(t, 2, Options{OnDone: func(j Job) {
		mu.Lock()
		done = append(done, j)
		mu.Unlock()
	}})
	job := enqueue(t, m, "1")
	g := runner.gateFor(job.ID)
	<-g.started
	waitUntil(t, "progress", func() bool {
		for _, j := range m.Jobs() {
			if j.ID == job.ID && j.Percent == 42 && j.Title == "Song" && j.Speed == "1 MB/s" {
				return true
			}
		}
		return false
	})
	g.release <- nil
	waitUntil(t, "done", func() bool { return stateOf(m, job.ID) == StateDone })
	got := m.Jobs()[0]
	if got.Percent != 100 || got.FilePath != "/lib/song-1.mp3" || got.Speed != "" {
		t.Fatalf("%+v", got)
	}
	mu.Lock()
	n := len(done)
	mu.Unlock()
	if n != 1 {
		t.Fatalf("OnDone calls %d", n)
	}
	if store.state(t, job.ID) != StateDone {
		t.Fatal("final state not persisted")
	}
}

func TestConcurrencyLimitIsRespectedAndQueuedJobsStartInOrder(t *testing.T) {
	m, runner, _ := newManager(t, 2, Options{})
	a, b, c := enqueue(t, m, "1"), enqueue(t, m, "2"), enqueue(t, m, "3")
	<-runner.gateFor(a.ID).started
	<-runner.gateFor(b.ID).started
	if stateOf(m, c.ID) != StateQueued {
		t.Fatalf("third job should wait, state %s", stateOf(m, c.ID))
	}
	runner.gateFor(a.ID).release <- nil
	<-runner.gateFor(c.ID).started
	runner.gateFor(b.ID).release <- nil
	runner.gateFor(c.ID).release <- nil
	waitUntil(t, "all done", func() bool {
		for _, j := range m.Jobs() {
			if j.State != StateDone {
				return false
			}
		}
		return true
	})
	runner.mu.Lock()
	peak := runner.peak
	runner.mu.Unlock()
	if peak != 2 {
		t.Fatalf("peak concurrency %d", peak)
	}
}

func TestFailureIsRecordedAndRetryRunsAgain(t *testing.T) {
	m, runner, _ := newManager(t, 1, Options{})
	job := enqueue(t, m, "1")
	g := runner.gateFor(job.ID)
	<-g.started
	g.release <- errors.New("Video unavailable")
	waitUntil(t, "failed", func() bool { return stateOf(m, job.ID) == StateFailed })
	if got := m.Jobs()[0]; got.Error != "Video unavailable" || got.Attempts != 1 {
		t.Fatalf("%+v", got)
	}
	if err := m.Retry(job.ID); err != nil {
		t.Fatal(err)
	}
	<-g.started
	g.release <- nil
	waitUntil(t, "done", func() bool { return stateOf(m, job.ID) == StateDone })
	if got := m.Jobs()[0]; got.Attempts != 2 || got.Error != "" {
		t.Fatalf("%+v", got)
	}
	if err := m.Retry(job.ID); err == nil {
		t.Fatal("a finished download cannot be retried")
	}
}

func TestCancellingARunningJobStopsItAndStartsTheNext(t *testing.T) {
	m, runner, _ := newManager(t, 1, Options{})
	a, b := enqueue(t, m, "1"), enqueue(t, m, "2")
	<-runner.gateFor(a.ID).started
	if err := m.Cancel(a.ID); err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "cancelled", func() bool { return stateOf(m, a.ID) == StateCancelled })
	<-runner.gateFor(b.ID).started
	if got := m.Jobs()[0]; got.Error != "" {
		t.Fatalf("a cancel is not an error: %+v", got)
	}
	runner.gateFor(b.ID).release <- nil
	waitUntil(t, "b done", func() bool { return stateOf(m, b.ID) == StateDone })
	if err := m.Retry(a.ID); err != nil {
		t.Fatal(err)
	}
	<-runner.gateFor(a.ID).started
	runner.gateFor(a.ID).release <- nil
	waitUntil(t, "a done", func() bool { return stateOf(m, a.ID) == StateDone })
}

func TestCancellingAQueuedJobNeverRunsIt(t *testing.T) {
	m, runner, _ := newManager(t, 1, Options{})
	a, b := enqueue(t, m, "1"), enqueue(t, m, "2")
	<-runner.gateFor(a.ID).started
	if err := m.Cancel(b.ID); err != nil {
		t.Fatal(err)
	}
	runner.gateFor(a.ID).release <- nil
	waitUntil(t, "a done", func() bool { return stateOf(m, a.ID) == StateDone })
	time.Sleep(30 * time.Millisecond)
	runner.mu.Lock()
	runs := runner.runs[b.ID]
	runner.mu.Unlock()
	if runs != 0 || stateOf(m, b.ID) != StateCancelled {
		t.Fatalf("queued cancel ran=%d state=%s", runs, stateOf(m, b.ID))
	}
	if err := m.Cancel(a.ID); err == nil {
		t.Fatal("a finished job cannot be cancelled")
	}
	if err := m.Cancel(9999); err == nil {
		t.Fatal("unknown id must error")
	}
}

func TestLoadRequeuesInterruptedJobsAndKeepsFinishedOnes(t *testing.T) {
	store := newStore()
	mk := func(state State) {
		data, _ := json.Marshal(Job{URL: "https://example.com/v1", Format: "mp3", Quality: "best", State: state, Percent: 55})
		store.Insert(data)
	}
	mk(StateRunning)
	mk(StateDone)
	mk(StateFailed)
	runner := newRunner()
	m := NewManager(store, runner, Options{Concurrency: 1})
	t.Cleanup(m.Close)
	if err := m.Load(); err != nil {
		t.Fatal(err)
	}
	<-runner.gateFor(1).started
	jobs := m.Jobs()
	if jobs[0].State != StateRunning || jobs[0].Attempts != 1 || jobs[0].Percent == 55 {
		t.Fatalf("interrupted job should restart from the beginning: %+v", jobs[0])
	}
	if jobs[1].State != StateDone || jobs[2].State != StateFailed {
		t.Fatalf("finished jobs must be kept: %+v", jobs)
	}
	runner.gateFor(1).release <- nil
	waitUntil(t, "done", func() bool { return stateOf(m, 1) == StateDone })
}

func TestRemoveAndClearOnlyAffectFinishedJobs(t *testing.T) {
	m, runner, store := newManager(t, 1, Options{})
	a, b := enqueue(t, m, "1"), enqueue(t, m, "2")
	<-runner.gateFor(a.ID).started
	if err := m.Remove(a.ID); err == nil {
		t.Fatal("a running job must not be removable")
	}
	runner.gateFor(a.ID).release <- errors.New("boom")
	waitUntil(t, "a failed", func() bool { return stateOf(m, a.ID) == StateFailed })
	if err := m.Remove(a.ID); err != nil {
		t.Fatal(err)
	}
	if len(m.Jobs()) != 1 {
		t.Fatalf("jobs %+v", m.Jobs())
	}
	<-runner.gateFor(b.ID).started
	if err := m.ClearFinished(); err != nil || len(m.Jobs()) != 1 {
		t.Fatalf("clear must keep running jobs: %v %+v", err, m.Jobs())
	}
	runner.gateFor(b.ID).release <- nil
	waitUntil(t, "b done", func() bool { return stateOf(m, b.ID) == StateDone })
	m.ClearFinished()
	if len(m.Jobs()) != 0 {
		t.Fatal("finished jobs should be cleared")
	}
	rows, _ := store.All()
	if len(rows) != 0 {
		t.Fatalf("store still has %d rows", len(rows))
	}
}

func TestCloseCancelsRunningJobsAndRefusesNewOnes(t *testing.T) {
	store := newStore()
	runner := newRunner()
	m := NewManager(store, runner, Options{Concurrency: 2})
	a := enqueue(t, m, "1")
	<-runner.gateFor(a.ID).started
	done := make(chan struct{})
	go func() { m.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not return")
	}
	if _, err := m.Enqueue(Request{URL: "https://example.com/v2"}); err == nil {
		t.Fatal("enqueue after close must fail")
	}
}

func TestChangeNotificationsAlwaysEndWithTheLatestState(t *testing.T) {
	var mu sync.Mutex
	var last []Job
	m, runner, _ := newManager(t, 1, Options{ChangeEvery: time.Hour, OnChange: func(j []Job) {
		mu.Lock()
		last = j
		mu.Unlock()
	}})
	job := enqueue(t, m, "1")
	<-runner.gateFor(job.ID).started
	runner.gateFor(job.ID).release <- nil
	waitUntil(t, "latest snapshot says done", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(last) == 1 && last[0].State == StateDone
	})
}
