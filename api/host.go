package api

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/kratejs/krate/packages/native/krate"

	"practice-music/api/engine"
	"practice-music/api/logger"
	"practice-music/api/settings"
)

const Version = "0.1.0"

var Engine = krate.NewSignal(engine.Status{State: engine.StateStopped})

var (
	bootOnce sync.Once
	sup      *engine.Supervisor
	store    *settings.Store
	bootedAt = time.Now()
)

type HealthInfo struct {
	Status        string        `json:"status"`
	UptimeSeconds float64       `json:"uptimeSeconds"`
	Version       string        `json:"version"`
	Engine        engine.Status `json:"engine"`
}

type SettingsDocument struct {
	Settings settings.Settings `json:"settings"`
	Notice   string            `json:"notice"`
	Path     string            `json:"path"`
}

func configDir() string {
	if dir := os.Getenv("PM_CONFIG_DIR"); dir != "" {
		return dir
	}
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "PracticeMusic")
	}
	return filepath.Join(os.TempDir(), "PracticeMusic")
}

func boot() {
	bootOnce.Do(func() {
		home, _ := os.UserHomeDir()
		store = settings.NewStore(configDir(), home)
		bootMedia(configDir())
		sup = engine.New(engine.Config{Path: engine.ResolveDefault})
		sup.OnStatus(func(st engine.Status) { Engine.Set(st) })
		startEvents()
		sup.Start()
		logger.Infof("host booted, settings at %s", store.Path())
	})
}

func Health() HealthInfo {
	boot()
	return HealthInfo{
		Status:        "ok",
		UptimeSeconds: time.Since(bootedAt).Seconds(),
		Version:       Version,
		Engine:        sup.Status(),
	}
}

func Devices() (engine.DeviceList, error) {
	boot()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	return sup.ListDevices(ctx)
}

func RestartEngine() {
	boot()
	sup.Restart()
}

func GetSettings() (SettingsDocument, error) {
	boot()
	s, notice, err := store.Load()
	if err != nil {
		return SettingsDocument{}, err
	}
	return SettingsDocument{Settings: s, Notice: notice, Path: store.Path()}, nil
}

func SaveSettings(in settings.Settings) (SettingsDocument, error) {
	boot()
	saved, err := store.Save(in)
	if err != nil {
		return SettingsDocument{}, err
	}
	logger.Infof("settings saved")
	applyAudioSettings(saved)
	return SettingsDocument{Settings: saved, Path: store.Path()}, nil
}
