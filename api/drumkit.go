package api

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/kratejs/krate/packages/native/krate"

	"practice-music/api/drums"
	"practice-music/api/engine"
	"practice-music/api/kit"
	"practice-music/api/logger"
	"practice-music/api/persist"
	"practice-music/api/refusal"
)

const (
	drumLoadIdle    = "idle"
	drumLoadRunning = "loading"
	drumLoadFailed  = "failed"
	kitRemoving     = "removing"
)

type DrumKitState struct {
	Installed bool   `json:"installed"`
	Phase     string `json:"phase"`
	Done      int64  `json:"done"`
	Total     int64  `json:"total"`
	Error     string `json:"error"`
}

type DrumLoadState struct {
	State string `json:"state"`
	Done  int    `json:"done"`
	Total int    `json:"total"`
	Bytes int64  `json:"bytes"`
	Error string `json:"error"`
}

type DrumState struct {
	Ports     []string      `json:"ports"`
	Open      string        `json:"open"`
	PortError string        `json:"portError"`
	Kit       DrumKitState  `json:"kit"`
	Load      DrumLoadState `json:"load"`
}

type DrumInfo struct {
	Settings       drums.Settings    `json:"settings"`
	Defaults       drums.Settings    `json:"defaults"`
	Sounds         []drums.SoundInfo `json:"sounds"`
	KitName        string            `json:"kitName"`
	KitCredit      string            `json:"kitCredit"`
	KitLicense     string            `json:"kitLicense"`
	KitSource      string            `json:"kitSource"`
	DownloadBytes  int64             `json:"downloadBytes"`
	InstalledBytes int64             `json:"installedBytes"`
	Notice         string            `json:"notice"`
}

func emptyDrumState() DrumState {
	return DrumState{Ports: []string{}, Load: DrumLoadState{State: drumLoadIdle}}
}

var DrumStream = krate.NewSignal(emptyDrumState())

var MidiStream = krate.NewSignal(engine.MidiFrame{})

var (
	drumMu       sync.Mutex
	drumApply    sync.Mutex
	drumPath     string
	drumSettings = drums.Default()
	drumStatus   = emptyDrumState()
	drumNotice   string
	drumToken    uint64
	kitInstaller *kit.Installer
	kitCancel    context.CancelFunc
)

func drumUpdate(change func(*DrumState)) DrumState {
	drumMu.Lock()
	defer drumMu.Unlock()
	change(&drumStatus)
	next := drumStatus
	next.Ports = slices.Clone(next.Ports)
	DrumStream.Set(next)
	return next
}

func drumSnapshot() drums.Settings {
	drumMu.Lock()
	defer drumMu.Unlock()
	return drums.Clone(drumSettings)
}

func loadDrums(dir string) {
	installer := kit.New(filepath.Join(dir, "kits", "muldjord"))
	installer.Archive = os.Getenv("PM_KIT_ARCHIVE")
	installer.OnProgress = func(p kit.Progress) {
		drumUpdate(func(s *DrumState) {
			if s.Kit.Phase != "" {
				s.Kit.Phase, s.Kit.Done, s.Kit.Total = p.Phase, p.Done, p.Total
			}
		})
	}
	settings := drums.Default()
	notice := ""
	path := filepath.Join(dir, "drums.json")
	var saved drums.Settings
	if found, err := persist.Load(path, &saved); err != nil {
		logger.Warnf("drum settings were not loaded: %v", err)
		notice = "The saved drum settings could not be read, so the defaults are shown."
	} else if found {
		settings = drums.Normalize(saved)
	}
	drumMu.Lock()
	drumPath, drumSettings, drumNotice, kitInstaller = path, settings, notice, installer
	drumStatus = emptyDrumState()
	drumStatus.Kit.Installed = installer.Installed()
	next := drumStatus
	drumMu.Unlock()
	DrumStream.Set(next)
}

func kitRoot() string {
	drumMu.Lock()
	installer, installed := kitInstaller, drumStatus.Kit.Installed
	drumMu.Unlock()
	if installer == nil || !installed {
		return ""
	}
	return installer.Root()
}

func drumCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

func engineReady() bool {
	return sup != nil && sup.Status().State == engine.StateRunning
}

func openDrumPort() {
	if !engineReady() {
		return
	}
	drumApply.Lock()
	defer drumApply.Unlock()
	wanted := drumSnapshot().Port
	ctx, cancel := drumCtx()
	defer cancel()
	found, err := sup.MidiPorts(ctx)
	if err != nil {
		drumUpdate(func(s *DrumState) { s.PortError = err.Error(); s.Open = "" })
		return
	}
	open, problem := "", ""
	switch {
	case wanted == "":
		err = sup.MidiOpen(ctx, "")
	case !slices.Contains(found.Ports, wanted):
		_ = sup.MidiOpen(ctx, "")
		problem = fmt.Sprintf("%s is not connected.", wanted)
	default:
		if err = sup.MidiOpen(ctx, wanted); err == nil {
			open = wanted
		}
	}
	if err != nil {
		problem = err.Error()
		logger.Warnf("the MIDI device could not be opened: %v", err)
	}
	drumUpdate(func(s *DrumState) { s.Ports = found.Ports; s.Open = open; s.PortError = problem })
}

func pushDrumConfig() error {
	if !engineReady() {
		return nil
	}
	drumApply.Lock()
	defer drumApply.Unlock()
	ctx, cancel := drumCtx()
	defer cancel()
	return sup.DrumsConfig(ctx, drums.BuildConfig(drumSnapshot()))
}

func withoutMissingFiles(s drums.Settings) (drums.Settings, []string) {
	missing := []string{}
	for i := range s.Pads {
		s.Pads[i].Files = slices.DeleteFunc(s.Pads[i].Files, func(path string) bool {
			info, err := os.Stat(path)
			gone := err != nil || info.IsDir()
			if gone && s.Pads[i].Sound == drums.SoundCustom {
				missing = append(missing, filepath.Base(path))
			}
			return gone
		})
	}
	return s, missing
}

func missingText(missing []string) string {
	if len(missing) == 0 {
		return ""
	}
	return "These sound files were not found: " + strings.Join(missing, ", ")
}

func loadDrumKit() {
	if !engineReady() || !audioRunning() {
		drumUpdate(func(s *DrumState) { s.Load = DrumLoadState{State: drumLoadIdle} })
		return
	}
	drumApply.Lock()
	defer drumApply.Unlock()
	settings, missing := withoutMissingFiles(drumSnapshot())
	root := kitRoot()
	drumMu.Lock()
	drumToken++
	request := drums.BuildLoad(settings, root, drumToken)
	drumMu.Unlock()
	next := DrumLoadState{State: drumLoadIdle, Error: missingText(missing)}
	if !request.Empty() {
		next.State = drumLoadRunning
	}
	drumUpdate(func(s *DrumState) { s.Load = next })
	ctx, cancel := drumCtx()
	defer cancel()
	if err := sup.DrumsLoad(ctx, request); err != nil {
		logger.Warnf("the drum sounds could not be loaded: %v", err)
		drumUpdate(func(s *DrumState) { s.Load = DrumLoadState{State: drumLoadFailed, Error: err.Error()} })
	}
}

func drumEngineGone() {
	drumUpdate(func(s *DrumState) {
		s.Open = ""
		s.Load = DrumLoadState{State: drumLoadIdle}
	})
}

func handleDrumKitEvent(ev engine.DrumKitEvent) {
	drumUpdate(func(s *DrumState) {
		if ev.Token != drumToken {
			return
		}
		state := ev.State
		if state == "ready" && ev.Total == 0 {
			state = drumLoadIdle
		}
		problem := ev.Error
		if problem == "" {
			problem = s.Load.Error
		}
		s.Load = DrumLoadState{State: state, Done: ev.Done, Total: ev.Total, Bytes: ev.Bytes, Error: problem}
	})
}

func pushDrums() {
	if err := pushDrumConfig(); err != nil {
		logger.Warnf("the drum settings were not applied: %v", err)
	}
	openDrumPort()
	loadDrumKit()
}

func DrumsGet() DrumInfo {
	boot()
	drumMu.Lock()
	notice := drumNotice
	drumMu.Unlock()
	return DrumInfo{
		Settings: drumSnapshot(), Defaults: drums.Default(), Sounds: drums.Sounds(),
		KitName: kit.Name, KitCredit: kit.Credit, KitLicense: kit.License, KitSource: kit.Source,
		DownloadBytes: kit.ArchiveBytes, InstalledBytes: kit.InstalledBytes, Notice: notice,
	}
}

func DrumStatusNow() DrumState {
	boot()
	return drumUpdate(func(*DrumState) {})
}

func sameSounds(a, b drums.Settings) bool {
	first, errA := json.Marshal(drums.BuildLoad(a, "kit", 0))
	second, errB := json.Marshal(drums.BuildLoad(b, "kit", 0))
	return errA == nil && errB == nil && string(first) == string(second)
}

func storeDrums(change func(drums.Settings) (drums.Settings, error)) (drums.Settings, error) {
	drumMu.Lock()
	before := drums.Clone(drumSettings)
	next, err := change(drums.Clone(drumSettings))
	if err != nil {
		drumMu.Unlock()
		return before, err
	}
	next = drums.Normalize(next)
	if drumPath != "" {
		if err := persist.Save(drumPath, next); err != nil {
			drumMu.Unlock()
			return before, fmt.Errorf("the drum settings were not saved: %w", err)
		}
	}
	drumSettings = next
	drumNotice = ""
	drumMu.Unlock()
	pushErr := pushDrumConfig()
	if before.Port != next.Port {
		openDrumPort()
	}
	if !sameSounds(before, next) {
		loadDrumKit()
	}
	return drums.Clone(next), pushErr
}

func DrumsSave(in drums.Settings) (drums.Settings, error) {
	boot()
	return storeDrums(func(drums.Settings) (drums.Settings, error) { return in, nil })
}

func DrumsReset() (drums.Settings, error) {
	boot()
	return storeDrums(func(current drums.Settings) (drums.Settings, error) {
		next := drums.Default()
		next.Port, next.Kit, next.Enabled = current.Port, current.Kit, current.Enabled
		return next, nil
	})
}

func DrumsLearn(padID string, note int) (drums.Settings, error) {
	boot()
	return storeDrums(func(current drums.Settings) (drums.Settings, error) {
		next, ok := drums.Learn(current, padID, note)
		if !ok {
			return current, refusal.New("that note could not be given to the pad")
		}
		return next, nil
	})
}

func DrumsScan() DrumState {
	boot()
	openDrumPort()
	return DrumStatusNow()
}

func DrumsPlay(padID string, velocity int) error {
	boot()
	if !audioRunning() {
		return refusal.New("start the audio engine first")
	}
	settings := drumSnapshot()
	at := drums.PadIndex(settings, padID)
	if at < 0 {
		return fmt.Errorf("there is no pad %q", padID)
	}
	ctx, cancel := drumCtx()
	defer cancel()
	return sup.DrumsTrigger(ctx, at, min(127, max(1, velocity)))
}

func DrumsKitDownload() error {
	boot()
	drumMu.Lock()
	installer := kitInstaller
	if installer == nil || drumStatus.Kit.Phase != "" {
		drumMu.Unlock()
		return refusal.New("the kit is already being changed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	kitCancel = cancel
	drumStatus.Kit.Phase, drumStatus.Kit.Done, drumStatus.Kit.Total = kit.PhaseDownloading, 0, installer.ArchiveBytes
	drumStatus.Kit.Error = ""
	next := drumStatus
	drumMu.Unlock()
	DrumStream.Set(next)
	logger.Infof("downloading the %s drum kit", kit.Name)
	go func() {
		defer cancel()
		err := installer.Install(ctx)
		installed := installer.Installed()
		problem := ""
		if err != nil && ctx.Err() == nil {
			problem = "The kit was not installed: " + err.Error()
			logger.Warnf("%s", problem)
		}
		drumUpdate(func(s *DrumState) { s.Kit = DrumKitState{Installed: installed, Error: problem} })
		if err == nil {
			logger.Infof("%s installed", kit.Name)
			loadDrumKit()
		}
	}()
	return nil
}

func DrumsKitCancel() {
	boot()
	drumMu.Lock()
	cancel := kitCancel
	drumMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func DrumsKitRemove() (drums.Settings, error) {
	boot()
	drumMu.Lock()
	installer := kitInstaller
	if installer == nil || drumStatus.Kit.Phase != "" {
		drumMu.Unlock()
		return drums.Settings{}, refusal.New("the kit is already being changed")
	}
	drumStatus.Kit.Phase = kitRemoving
	drumStatus.Kit.Error = ""
	drumMu.Unlock()
	err := installer.Remove()
	installed := installer.Installed()
	drumUpdate(func(s *DrumState) { s.Kit = DrumKitState{Installed: installed} })
	if err != nil {
		return drumSnapshot(), fmt.Errorf("the kit could not be removed: %w", err)
	}
	logger.Infof("%s removed", kit.Name)
	saved, saveErr := storeDrums(func(current drums.Settings) (drums.Settings, error) {
		current.Kit = drums.KitNone
		return current, nil
	})
	loadDrumKit()
	return saved, saveErr
}
