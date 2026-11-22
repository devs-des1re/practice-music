package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"practice-music/api/logger"
	"practice-music/api/protocol"
)

func TestMain(m *testing.M) {
	if os.Getenv("PM_FAKE_ENGINE") != "" {
		runFake()
		return
	}
	logger.SetOutput(os.Stderr)
	os.Exit(m.Run())
}

func runFake() {
	mode := os.Getenv("PM_FAKE_MODE")
	if counter := os.Getenv("PM_FAKE_COUNT"); counter != "" {
		f, err := os.OpenFile(counter, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err == nil {
			_, _ = f.Write([]byte("x"))
			_ = f.Close()
		}
	}
	if mode == "crash_always" {
		os.Exit(1)
	}
	crashFirst := false
	if state := os.Getenv("PM_FAKE_STATE"); state != "" {
		if _, err := os.Stat(state); err != nil {
			_ = os.WriteFile(state, []byte("seen"), 0o600)
			crashFirst = mode == "crash_once"
		}
	}
	out := bufio.NewWriter(os.Stdout)
	send := func(b []byte) {
		_, _ = out.Write(b)
		_ = out.Flush()
	}
	ready, _ := protocol.EncodeEvent("ready", map[string]any{})
	send(ready)
	r := protocol.NewReader(os.Stdin)
	for {
		line, err := r.Next()
		if err != nil {
			return
		}
		m, err := protocol.Decode(line)
		if err != nil || m.Kind != protocol.KindRequest {
			continue
		}
		switch m.Method {
		case "hello":
			switch mode {
			case "hang":
				continue
			case "reject":
				send(protocol.EncodeError(m.ID, "unsupported_version", "engine speaks protocol 9"))
				continue
			case "badversion":
				resp, _ := protocol.EncodeResponse(m.ID, map[string]any{"protocol": 2, "version": "9.9.9"})
				send(resp)
				continue
			}
			if crashFirst {
				os.Exit(3)
			}
			resp, _ := protocol.EncodeResponse(m.ID, map[string]any{
				"protocol": protocol.Version, "engine": "fake", "version": "0.0.1",
				"os": "test", "arch": "test", "pid": os.Getpid(), "features": []string{"fake"},
			})
			send(resp)
		case "echo":
			var v any
			_ = json.Unmarshal(m.Params, &v)
			resp, _ := protocol.EncodeResponse(m.ID, v)
			send(resp)
		case "hang":
		case "die":
			os.Exit(4)
		case "emit":
			ev, _ := protocol.EncodeEvent("tick", map[string]int{"n": 1})
			send(ev)
			resp, _ := protocol.EncodeResponse(m.ID, map[string]bool{"sent": true})
			send(resp)
		case "fail":
			send(protocol.EncodeError(m.ID, "nope", "refused on purpose"))
		case "shutdown":
			resp, _ := protocol.EncodeResponse(m.ID, map[string]bool{"bye": true})
			send(resp)
			return
		default:
			send(protocol.EncodeError(m.ID, "unknown_method", m.Method))
		}
	}
}

type harness struct {
	sup   *Supervisor
	dir   string
	count string
}

func newHarness(t *testing.T, mode string, tweak func(*Config)) *harness {
	t.Helper()
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{dir: dir, count: filepath.Join(dir, "spawns")}
	cfg := Config{
		Path: func() (string, error) { return exe, nil },
		Env: []string{
			"PM_FAKE_ENGINE=1",
			"PM_FAKE_MODE=" + mode,
			"PM_FAKE_COUNT=" + h.count,
			"PM_FAKE_STATE=" + filepath.Join(dir, "state"),
		},
		HandshakeWait:  500 * time.Millisecond,
		CallTimeout:    time.Second,
		BackoffInitial: 20 * time.Millisecond,
		BackoffMax:     80 * time.Millisecond,
		StableAfter:    time.Hour,
		StopGrace:      time.Second,
	}
	if tweak != nil {
		tweak(&cfg)
	}
	h.sup = New(cfg)
	t.Cleanup(h.sup.Stop)
	return h
}

func (h *harness) spawns() int {
	data, err := os.ReadFile(h.count)
	if err != nil {
		return 0
	}
	return len(data)
}

func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func (h *harness) waitState(t *testing.T, want State) Status {
	t.Helper()
	var got Status
	waitFor(t, "state "+string(want), 5*time.Second, func() bool {
		got = h.sup.Status()
		return got.State == want
	})
	return got
}

func TestStartsAndCompletesHandshake(t *testing.T) {
	h := newHarness(t, "ok", nil)
	h.sup.Start()
	st := h.waitState(t, StateRunning)
	if st.EngineVersion != "0.0.1" || st.Protocol != protocol.Version || st.Pid == 0 {
		t.Fatalf("unexpected status %+v", st)
	}
	if len(st.Features) != 1 || st.Features[0] != "fake" {
		t.Fatalf("features lost: %+v", st.Features)
	}
	var echoed map[string]int
	if err := h.sup.Call(context.Background(), "echo", map[string]int{"a": 7}, &echoed); err != nil || echoed["a"] != 7 {
		t.Fatalf("echo failed: %v %v", echoed, err)
	}
}

func TestCallBeforeStartIsRejected(t *testing.T) {
	h := newHarness(t, "ok", nil)
	if err := h.sup.Call(context.Background(), "echo", nil, nil); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("want ErrNotRunning, got %v", err)
	}
}

func TestEngineErrorsSurfaceAsProtocolErrors(t *testing.T) {
	h := newHarness(t, "ok", nil)
	h.sup.Start()
	h.waitState(t, StateRunning)
	err := h.sup.Call(context.Background(), "fail", nil, nil)
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Code != "nope" {
		t.Fatalf("want protocol error nope, got %v", err)
	}
}

func TestCrashDuringHandshakeIsRetriedAndRecovers(t *testing.T) {
	h := newHarness(t, "crash_once", nil)
	h.sup.Start()
	st := h.waitState(t, StateRunning)
	if st.Restarts != 1 {
		t.Fatalf("want 1 restart, got %d", st.Restarts)
	}
	if h.spawns() != 2 {
		t.Fatalf("want 2 spawns, got %d", h.spawns())
	}
}

func TestCrashWhileRunningRestartsWithNewPid(t *testing.T) {
	h := newHarness(t, "ok", nil)
	h.sup.Start()
	first := h.waitState(t, StateRunning)
	err := h.sup.Call(context.Background(), "die", nil, nil)
	if !errors.Is(err, ErrEngineDown) {
		t.Fatalf("pending call should fail with ErrEngineDown, got %v", err)
	}
	waitFor(t, "restart", 5*time.Second, func() bool {
		st := h.sup.Status()
		return st.State == StateRunning && st.Pid != first.Pid
	})
	st := h.sup.Status()
	if st.Restarts != 1 {
		t.Fatalf("want 1 restart, got %d", st.Restarts)
	}
	if err := h.sup.Call(context.Background(), "echo", 1, nil); err != nil {
		t.Fatalf("engine should answer after restart: %v", err)
	}
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	h := newHarness(t, "crash_always", nil)
	var mu sync.Mutex
	var waits []int64
	h.sup.OnStatus(func(st Status) {
		if st.State == StateBackoff {
			mu.Lock()
			waits = append(waits, st.RetryInMs)
			mu.Unlock()
		}
	})
	h.sup.Start()
	waitFor(t, "five backoffs", 5*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(waits) >= 5
	})
	mu.Lock()
	defer mu.Unlock()
	want := []int64{20, 40, 80, 80, 80}
	for i, w := range want {
		if waits[i] != w {
			t.Fatalf("backoff sequence %v, want prefix %v", waits, want)
		}
	}
}

func TestBackoffResetsAfterAStableRun(t *testing.T) {
	h := newHarness(t, "ok", func(c *Config) { c.StableAfter = 10 * time.Millisecond })
	var mu sync.Mutex
	var waits []int64
	h.sup.OnStatus(func(st Status) {
		if st.State == StateBackoff {
			mu.Lock()
			waits = append(waits, st.RetryInMs)
			mu.Unlock()
		}
	})
	h.sup.Start()
	for i := 0; i < 3; i++ {
		h.waitState(t, StateRunning)
		time.Sleep(30 * time.Millisecond)
		_ = h.sup.Call(context.Background(), "die", nil, nil)
		want := i + 1
		waitFor(t, "backoff recorded", 5*time.Second, func() bool {
			mu.Lock()
			defer mu.Unlock()
			return len(waits) >= want
		})
	}
	mu.Lock()
	defer mu.Unlock()
	for _, w := range waits {
		if w != 20 {
			t.Fatalf("a stable run should reset the backoff, got %v", waits)
		}
	}
}

func TestCallTimeout(t *testing.T) {
	h := newHarness(t, "ok", func(c *Config) { c.CallTimeout = 100 * time.Millisecond })
	h.sup.Start()
	h.waitState(t, StateRunning)
	err := h.sup.Call(context.Background(), "hang", nil, nil)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("want ErrTimeout, got %v", err)
	}
	if err := h.sup.Call(context.Background(), "echo", 1, nil); err != nil {
		t.Fatalf("engine should still answer after a timed-out call: %v", err)
	}
}

func TestCallHonoursContextCancellation(t *testing.T) {
	h := newHarness(t, "ok", nil)
	h.sup.Start()
	h.waitState(t, StateRunning)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := h.sup.Call(ctx, "hang", nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want deadline exceeded, got %v", err)
	}
}

func TestHandshakeTimeoutIsRetried(t *testing.T) {
	h := newHarness(t, "hang", func(c *Config) { c.HandshakeWait = 80 * time.Millisecond })
	h.sup.Start()
	waitFor(t, "two spawns", 5*time.Second, func() bool { return h.spawns() >= 2 })
	st := h.sup.Status()
	if st.State == StateRunning || st.State == StateFailed {
		t.Fatalf("a silent engine must never be reported running or failed, got %s", st.State)
	}
}

func TestIncompatibleProtocolFailsWithoutRetryLoop(t *testing.T) {
	for _, mode := range []string{"badversion", "reject"} {
		t.Run(mode, func(t *testing.T) {
			h := newHarness(t, mode, nil)
			h.sup.Start()
			st := h.waitState(t, StateFailed)
			if st.LastError == "" {
				t.Fatal("failed state needs an explanation")
			}
			time.Sleep(200 * time.Millisecond)
			if h.spawns() != 1 {
				t.Fatalf("an incompatible engine must not be respawned, spawns=%d", h.spawns())
			}
		})
	}
}

func TestMissingBinaryFailsThenRestartPicksItUp(t *testing.T) {
	exe, _ := os.Executable()
	var mu sync.Mutex
	available := false
	h := newHarness(t, "ok", func(c *Config) {
		c.Path = func() (string, error) {
			mu.Lock()
			defer mu.Unlock()
			if !available {
				return "", errors.New("engine binary not found")
			}
			return exe, nil
		}
	})
	h.sup.Start()
	st := h.waitState(t, StateFailed)
	if st.LastError != "engine binary not found" {
		t.Fatalf("unexpected error %q", st.LastError)
	}
	mu.Lock()
	available = true
	mu.Unlock()
	h.sup.Restart()
	h.waitState(t, StateRunning)
}

func TestManualRestartIsNotCountedAsACrash(t *testing.T) {
	h := newHarness(t, "ok", nil)
	h.sup.Start()
	first := h.waitState(t, StateRunning)
	h.sup.Restart()
	waitFor(t, "new pid", 5*time.Second, func() bool {
		st := h.sup.Status()
		return st.State == StateRunning && st.Pid != first.Pid
	})
	if st := h.sup.Status(); st.Restarts != 0 {
		t.Fatalf("manual restart must not count as a crash, got %d", st.Restarts)
	}
}

func TestEventsReachSubscribersAndUnsubscribeCloses(t *testing.T) {
	h := newHarness(t, "ok", nil)
	events, cancel := h.sup.Subscribe(8)
	h.sup.Start()
	h.waitState(t, StateRunning)
	if err := h.sup.Call(context.Background(), "emit", nil, nil); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(2 * time.Second)
	for {
		select {
		case ev := <-events:
			if ev.Name == "tick" {
				cancel()
				if _, open := <-events; open {
					t.Fatal("channel should be closed after cancel")
				}
				return
			}
		case <-deadline:
			t.Fatal("no tick event received")
		}
	}
}

func TestStopShutsTheEngineDownAndIsIdempotent(t *testing.T) {
	h := newHarness(t, "ok", nil)
	h.sup.Start()
	h.waitState(t, StateRunning)
	p := h.sup.current()
	h.sup.Stop()
	select {
	case <-p.exited:
	case <-time.After(3 * time.Second):
		t.Fatal("engine process still alive after Stop")
	}
	if st := h.sup.Status(); st.State != StateStopped {
		t.Fatalf("want stopped, got %s", st.State)
	}
	h.sup.Stop()
	if err := h.sup.Call(context.Background(), "echo", 1, nil); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("want ErrNotRunning after stop, got %v", err)
	}
}

func TestStatusSubscribersSeeTheWholeLifecycle(t *testing.T) {
	h := newHarness(t, "ok", nil)
	var mu sync.Mutex
	seen := map[State]bool{}
	h.sup.OnStatus(func(st Status) {
		mu.Lock()
		seen[st.State] = true
		mu.Unlock()
	})
	h.sup.Start()
	h.waitState(t, StateRunning)
	h.sup.Stop()
	mu.Lock()
	defer mu.Unlock()
	for _, s := range []State{StateStarting, StateRunning, StateStopped} {
		if !seen[s] {
			t.Fatalf("never saw state %s, saw %v", s, seen)
		}
	}
}
