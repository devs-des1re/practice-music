package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"practice-music/api/logger"
	"practice-music/api/protocol"
)

type State string

const (
	StateStopped  State = "stopped"
	StateStarting State = "starting"
	StateRunning  State = "running"
	StateBackoff  State = "backoff"
	StateFailed   State = "failed"
)

var (
	ErrNotRunning = errors.New("engine is not running")
	ErrEngineDown = errors.New("engine exited")
	ErrTimeout    = errors.New("engine request timed out")
	ErrStopped    = errors.New("supervisor stopped")
)

type Hello struct {
	Protocol int      `json:"protocol"`
	Engine   string   `json:"engine"`
	Version  string   `json:"version"`
	OS       string   `json:"os"`
	Arch     string   `json:"arch"`
	Pid      int      `json:"pid"`
	Features []string `json:"features"`
}

type Status struct {
	State         State    `json:"state"`
	Pid           int      `json:"pid"`
	Restarts      int      `json:"restarts"`
	LastError     string   `json:"lastError"`
	EngineVersion string   `json:"engineVersion"`
	Protocol      int      `json:"protocol"`
	Features      []string `json:"features"`
	StartedAtMs   int64    `json:"startedAtMs"`
	RetryInMs     int64    `json:"retryInMs"`
	Path          string   `json:"path"`
}

type Event struct {
	Name string
	Data json.RawMessage
}

type Config struct {
	Path           func() (string, error)
	Args           []string
	Env            []string
	HandshakeWait  time.Duration
	CallTimeout    time.Duration
	BackoffInitial time.Duration
	BackoffMax     time.Duration
	StableAfter    time.Duration
	StopGrace      time.Duration
}

func (c *Config) defaults() {
	if c.HandshakeWait <= 0 {
		c.HandshakeWait = 5 * time.Second
	}
	if c.CallTimeout <= 0 {
		c.CallTimeout = 10 * time.Second
	}
	if c.BackoffInitial <= 0 {
		c.BackoffInitial = 250 * time.Millisecond
	}
	if c.BackoffMax <= 0 {
		c.BackoffMax = 5 * time.Second
	}
	if c.StableAfter <= 0 {
		c.StableAfter = 10 * time.Second
	}
	if c.StopGrace <= 0 {
		c.StopGrace = 2 * time.Second
	}
}

type process struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	wmu     sync.Mutex
	pmu     sync.Mutex
	pending map[uint64]chan protocol.Message
	closed  bool
	exited  chan struct{}
	waitErr error
}

type Supervisor struct {
	cfg Config

	mu         sync.Mutex
	status     Status
	proc       *process
	started    bool
	cancel     context.CancelFunc
	done       chan struct{}
	subs       map[int]chan Event
	nextSub    int
	statusSubs []func(Status)

	nextID     atomic.Uint64
	restartReq atomic.Bool
	kick       chan struct{}
}

func New(cfg Config) *Supervisor {
	cfg.defaults()
	return &Supervisor{
		cfg:    cfg,
		status: Status{State: StateStopped},
		subs:   map[int]chan Event{},
		kick:   make(chan struct{}, 1),
		done:   make(chan struct{}),
	}
}

func (s *Supervisor) Start() {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.mu.Unlock()
	go s.run(ctx)
}

func (s *Supervisor) Stop() {
	s.mu.Lock()
	if !s.started || s.cancel == nil {
		s.mu.Unlock()
		return
	}
	cancel := s.cancel
	s.mu.Unlock()
	cancel()
	if p := s.current(); p != nil {
		s.terminate(p)
	}
	<-s.done
}

func (s *Supervisor) Restart() {
	s.restartReq.Store(true)
	select {
	case s.kick <- struct{}{}:
	default:
	}
	if p := s.current(); p != nil {
		s.terminate(p)
	}
}

func (s *Supervisor) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.copyStatus()
}

func (s *Supervisor) copyStatus() Status {
	st := s.status
	st.Features = append([]string(nil), s.status.Features...)
	return st
}

func (s *Supervisor) OnStatus(fn func(Status)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statusSubs = append(s.statusSubs, fn)
}

func (s *Supervisor) Subscribe(buffer int) (<-chan Event, func()) {
	if buffer < 1 {
		buffer = 64
	}
	ch := make(chan Event, buffer)
	s.mu.Lock()
	id := s.nextSub
	s.nextSub++
	s.subs[id] = ch
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		if c, ok := s.subs[id]; ok {
			delete(s.subs, id)
			close(c)
		}
		s.mu.Unlock()
	}
}

func (s *Supervisor) Call(ctx context.Context, method string, params any, out any) error {
	p := s.current()
	if p == nil {
		return ErrNotRunning
	}
	if s.Status().State != StateRunning {
		return ErrNotRunning
	}
	return s.callOn(ctx, p, method, params, out)
}

func (s *Supervisor) current() *process {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.proc
}

func (s *Supervisor) update(fn func(*Status)) {
	s.mu.Lock()
	fn(&s.status)
	snapshot := s.copyStatus()
	subs := append([]func(Status){}, s.statusSubs...)
	s.mu.Unlock()
	for _, sub := range subs {
		sub(snapshot)
	}
}

func (s *Supervisor) publish(ev Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ch := range s.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

func (s *Supervisor) run(ctx context.Context) {
	defer close(s.done)
	backoff := s.cfg.BackoffInitial
	for {
		if ctx.Err() != nil {
			s.setStopped()
			return
		}
		began := time.Now()
		outcome := s.runOnce(ctx)
		if ctx.Err() != nil {
			s.setStopped()
			return
		}
		if s.restartReq.Swap(false) {
			select {
			case <-s.kick:
			default:
			}
			backoff = s.cfg.BackoffInitial
			continue
		}
		if outcome.fatal {
			s.update(func(st *Status) {
				st.State = StateFailed
				st.Pid = 0
				st.LastError = outcome.err.Error()
				st.RetryInMs = 0
			})
			logger.Errorf("engine unavailable: %v", outcome.err)
			select {
			case <-ctx.Done():
				s.setStopped()
				return
			case <-s.kick:
				s.restartReq.Store(false)
				backoff = s.cfg.BackoffInitial
				continue
			}
		}
		if time.Since(began) >= s.cfg.StableAfter {
			backoff = s.cfg.BackoffInitial
		}
		wait := backoff
		s.update(func(st *Status) {
			st.State = StateBackoff
			st.Pid = 0
			st.Restarts++
			st.LastError = outcome.err.Error()
			st.RetryInMs = wait.Milliseconds()
		})
		logger.Warnf("engine stopped (%v), restarting in %s", outcome.err, wait)
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			s.setStopped()
			return
		case <-s.kick:
			timer.Stop()
			s.restartReq.Store(false)
			backoff = s.cfg.BackoffInitial
		case <-timer.C:
			backoff = min(backoff*2, s.cfg.BackoffMax)
		}
	}
}

func (s *Supervisor) setStopped() {
	s.update(func(st *Status) {
		st.State = StateStopped
		st.Pid = 0
		st.RetryInMs = 0
	})
}

type outcome struct {
	err   error
	fatal bool
}

func (s *Supervisor) runOnce(ctx context.Context) outcome {
	path, err := s.cfg.Path()
	if err != nil {
		return outcome{err: err, fatal: true}
	}
	s.update(func(st *Status) {
		st.State = StateStarting
		st.Path = path
		st.RetryInMs = 0
	})
	p, err := s.spawn(path)
	if err != nil {
		return outcome{err: err, fatal: true}
	}
	s.mu.Lock()
	s.proc = p
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.proc == p {
			s.proc = nil
		}
		s.mu.Unlock()
	}()

	hello, err := s.handshake(ctx, p)
	if err != nil {
		s.terminate(p)
		<-p.exited
		fatal := errors.Is(err, protocol.ErrVersion) || errors.Is(err, errIncompatible)
		return outcome{err: err, fatal: fatal}
	}
	s.update(func(st *Status) {
		st.State = StateRunning
		st.Pid = p.cmd.Process.Pid
		st.EngineVersion = hello.Version
		st.Protocol = hello.Protocol
		st.Features = hello.Features
		st.StartedAtMs = time.Now().UnixMilli()
		st.LastError = ""
		st.RetryInMs = 0
	})
	logger.Infof("engine %s running (pid %d, protocol %d)", hello.Version, p.cmd.Process.Pid, hello.Protocol)

	select {
	case <-p.exited:
	case <-ctx.Done():
		s.terminate(p)
		<-p.exited
		return outcome{err: ErrStopped}
	}
	if p.waitErr != nil {
		return outcome{err: fmt.Errorf("%w: %v", ErrEngineDown, p.waitErr)}
	}
	return outcome{err: ErrEngineDown}
}

var errIncompatible = errors.New("engine protocol is incompatible with this host")

func (s *Supervisor) handshake(ctx context.Context, p *process) (Hello, error) {
	hctx, cancel := context.WithTimeout(ctx, s.cfg.HandshakeWait)
	defer cancel()
	var hello Hello
	err := s.callOn(hctx, p, "hello", map[string]any{
		"protocol": protocol.Version,
		"client":   "practice-music-host",
	}, &hello)
	if err != nil {
		var pe *protocol.Error
		if errors.As(err, &pe) && pe.Code == "unsupported_version" {
			return Hello{}, fmt.Errorf("%w: %s", errIncompatible, pe.Message)
		}
		return Hello{}, fmt.Errorf("handshake failed: %w", err)
	}
	if hello.Protocol != protocol.Version {
		return Hello{}, fmt.Errorf("%w: engine speaks protocol %d, host speaks %d", errIncompatible, hello.Protocol, protocol.Version)
	}
	return hello, nil
}

func (s *Supervisor) spawn(path string) (*process, error) {
	cmd := exec.Command(path, s.cfg.Args...)
	cmd.Env = append(os.Environ(), s.cfg.Env...)
	applyProcAttr(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start engine: %w", err)
	}
	p := &process{
		cmd:     cmd,
		stdin:   stdin,
		pending: map[uint64]chan protocol.Message{},
		exited:  make(chan struct{}),
	}
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			logger.Warnf("engine: %s", sc.Text())
		}
	}()
	go s.readLoop(p, stdout)
	return p, nil
}

func (s *Supervisor) readLoop(p *process, stdout io.Reader) {
	r := protocol.NewReader(stdout)
	bad := 0
	for {
		line, err := r.Next()
		if err != nil {
			if errors.Is(err, protocol.ErrTooLarge) {
				logger.Warnf("engine sent an oversized frame, dropped")
				continue
			}
			break
		}
		m, err := protocol.Decode(line)
		if err != nil {
			bad++
			logger.Warnf("engine sent an unusable frame: %v", err)
			if bad >= 20 {
				_ = p.cmd.Process.Kill()
				break
			}
			continue
		}
		bad = 0
		switch m.Kind {
		case protocol.KindResponse:
			p.pmu.Lock()
			ch, ok := p.pending[m.ID]
			delete(p.pending, m.ID)
			p.pmu.Unlock()
			if ok {
				ch <- m
			}
		case protocol.KindEvent:
			s.publish(Event{Name: m.Event, Data: m.Data})
		}
	}
	p.waitErr = p.cmd.Wait()
	p.pmu.Lock()
	p.closed = true
	for id, ch := range p.pending {
		ch <- protocol.Message{Kind: protocol.KindResponse, ID: id, Err: &protocol.Error{Code: "engine_down", Message: ErrEngineDown.Error()}}
		delete(p.pending, id)
	}
	p.pmu.Unlock()
	close(p.exited)
}

func (s *Supervisor) callOn(ctx context.Context, p *process, method string, params any, out any) error {
	id := s.nextID.Add(1)
	ch := make(chan protocol.Message, 1)
	p.pmu.Lock()
	if p.closed {
		p.pmu.Unlock()
		return ErrEngineDown
	}
	p.pending[id] = ch
	p.pmu.Unlock()
	forget := func() {
		p.pmu.Lock()
		delete(p.pending, id)
		p.pmu.Unlock()
	}
	line, err := protocol.EncodeRequest(id, method, params)
	if err != nil {
		forget()
		return err
	}
	p.wmu.Lock()
	_, err = p.stdin.Write(line)
	p.wmu.Unlock()
	if err != nil {
		forget()
		return fmt.Errorf("%w: %v", ErrEngineDown, err)
	}
	timer := time.NewTimer(s.cfg.CallTimeout)
	defer timer.Stop()
	select {
	case m := <-ch:
		if m.Err != nil {
			if m.Err.Code == "engine_down" {
				return ErrEngineDown
			}
			return m.Err
		}
		if out != nil && len(m.Result) > 0 {
			if err := json.Unmarshal(m.Result, out); err != nil {
				return fmt.Errorf("decode %s result: %w", method, err)
			}
		}
		return nil
	case <-ctx.Done():
		forget()
		return ctx.Err()
	case <-timer.C:
		forget()
		return ErrTimeout
	}
}

func (s *Supervisor) terminate(p *process) {
	select {
	case <-p.exited:
		return
	default:
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.StopGrace/2)
	_ = s.callOn(ctx, p, "shutdown", nil, nil)
	cancel()
	_ = p.stdin.Close()
	select {
	case <-p.exited:
	case <-time.After(s.cfg.StopGrace):
		_ = p.cmd.Process.Kill()
	}
}
