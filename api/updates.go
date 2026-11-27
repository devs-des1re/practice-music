package api

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/kratejs/krate/packages/native/krate"

	"practice-music/api/logger"
	"practice-music/api/update"
)

type UpdateState struct {
	Phase      string `json:"phase"`
	Current    string `json:"current"`
	Latest     string `json:"latest"`
	Notes      string `json:"notes"`
	Page       string `json:"page"`
	Size       int64  `json:"size"`
	Done       int64  `json:"done"`
	CanInstall bool   `json:"canInstall"`
	Hidden     bool   `json:"hidden"`
	Error      string `json:"error"`
}

const (
	updateIdle        = "idle"
	updateChecking    = "checking"
	updateCurrent     = "current"
	updateAvailable   = "available"
	updateDownloading = "downloading"
	updateOpened      = "opened"
	updateFailed      = "failed"

	updateCheckTimeout = 30 * time.Second
)

var UpdateStream = krate.NewSignal(UpdateState{Phase: updateIdle, Current: Version})

type updateFlow struct {
	mu      sync.Mutex
	client  *update.Client
	system  update.System
	current string
	dir     string
	open    func(string) error
	publish func(UpdateState)
	state   UpdateState
	found   *update.Found
	cancel  context.CancelFunc
}

func newUpdateFlow(dir string) *updateFlow {
	return &updateFlow{
		client:  update.NewClient(),
		system:  update.ThisSystem(),
		current: Version,
		dir:     dir,
		open:    update.Open,
		publish: func(s UpdateState) { UpdateStream.Set(s) },
		state:   UpdateState{Phase: updateIdle, Current: Version},
	}
}

func (f *updateFlow) set(change func(*UpdateState)) UpdateState {
	f.mu.Lock()
	change(&f.state)
	snapshot := f.state
	f.mu.Unlock()
	f.publish(snapshot)
	return snapshot
}

func (f *updateFlow) snapshot() UpdateState {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *updateFlow) check(ctx context.Context, quiet bool) (UpdateState, error) {
	f.mu.Lock()
	busy := f.state.Phase == updateChecking || f.state.Phase == updateDownloading
	f.mu.Unlock()
	if busy {
		return f.snapshot(), nil
	}
	f.set(func(s *UpdateState) { *s = UpdateState{Phase: updateChecking, Current: f.current} })
	found, err := f.client.Newest(ctx, f.current, f.system)
	if err != nil {
		return f.set(func(s *UpdateState) {
			if quiet {
				s.Phase = updateIdle
				return
			}
			s.Phase, s.Error = updateFailed, err.Error()
		}), err
	}
	f.mu.Lock()
	f.found = found
	f.mu.Unlock()
	return f.set(func(s *UpdateState) {
		if found == nil {
			s.Phase = updateCurrent
			return
		}
		s.Phase, s.Latest, s.Notes, s.Page = updateAvailable, found.Version, found.Notes, found.Page
		if found.Installer != nil {
			s.CanInstall, s.Size = true, found.Installer.Size
		}
	}), nil
}

func (f *updateFlow) start() (func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state.Phase == updateDownloading {
		return nil, errors.New("the update is already downloading")
	}
	if f.found == nil || f.found.Installer == nil {
		return nil, errors.New("there is no installer to download for this computer")
	}
	version, installer := f.found.Version, *f.found.Installer
	ctx, cancel := context.WithCancel(context.Background())
	f.cancel = cancel
	f.state.Phase, f.state.Done, f.state.Error, f.state.Hidden = updateDownloading, 0, "", false
	return func() {
		defer cancel()
		f.publish(f.snapshot())
		path, err := f.client.Download(ctx, installer, filepath.Join(f.dir, version), func(done int64) {
			f.set(func(s *UpdateState) { s.Done = done })
		})
		if err == nil {
			err = update.Verify(path, installer)
		}
		if err == nil {
			err = ctx.Err()
		}
		if err == nil {
			err = f.open(path)
		}
		f.set(func(s *UpdateState) {
			switch {
			case err == nil:
				s.Phase, s.Done = updateOpened, installer.Size
			case errors.Is(err, context.Canceled):
				s.Phase, s.Done = updateAvailable, 0
			default:
				s.Phase, s.Done, s.Error = updateAvailable, 0, err.Error()
			}
		})
		if err != nil && !errors.Is(err, context.Canceled) {
			logger.Warnf("the update was not installed: %v", err)
		}
	}, nil
}

func (f *updateFlow) stop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.cancel != nil {
		f.cancel()
	}
}

var (
	updatesOnce sync.Once
	updates     *updateFlow
	autoCheck   sync.Once
)

func updater() *updateFlow {
	boot()
	updatesOnce.Do(func() { updates = newUpdateFlow(filepath.Join(configDir(), "updates")) })
	return updates
}

func AutoCheckForUpdate() UpdateState {
	flow := updater()
	autoCheck.Do(func() {
		doc, _, err := store.Load()
		if err != nil || !doc.Preferences.CheckUpdates {
			return
		}
		go func() {
			_ = os.RemoveAll(flow.dir)
			ctx, cancel := context.WithTimeout(context.Background(), updateCheckTimeout)
			defer cancel()
			if _, err := flow.check(ctx, true); err != nil {
				logger.Infof("update check skipped: %v", err)
			}
		}()
	})
	return flow.snapshot()
}

func CheckForUpdate() (UpdateState, error) {
	ctx, cancel := context.WithTimeout(context.Background(), updateCheckTimeout)
	defer cancel()
	return updater().check(ctx, false)
}

func InstallUpdate() error {
	work, err := updater().start()
	if err != nil {
		return err
	}
	go work()
	return nil
}

func CancelUpdate() {
	updater().stop()
}

func HideUpdate() UpdateState {
	return updater().set(func(s *UpdateState) { s.Hidden = true })
}

func OpenReleasePage() error {
	page := updater().snapshot().Page
	if !strings.HasPrefix(page, update.PagePrefix) {
		return errors.New("there is no release page to open")
	}
	return update.Open(page)
}
