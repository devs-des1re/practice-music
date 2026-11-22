package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"
)

const Version = 1

const FileName = "settings.json"

type Library struct {
	Folders           []string `json:"folders"`
	NormalizeOnImport bool     `json:"normalizeOnImport"`
}

type Audio struct {
	Mode          string `json:"mode"`
	Host          string `json:"host"`
	OutputDevice  string `json:"outputDevice"`
	MonitorDevice string `json:"monitorDevice"`
	InputDevice   string `json:"inputDevice"`
	SampleRate    int    `json:"sampleRate"`
	BufferFrames  int    `json:"bufferFrames"`
}

type Appearance struct {
	UIScale int `json:"uiScale"`
}

type Settings struct {
	Version    int        `json:"version"`
	Library    Library    `json:"library"`
	Audio      Audio      `json:"audio"`
	Appearance Appearance `json:"appearance"`
}

var allowedModes = []string{"shared", "lowlatency", "exclusive"}

var allowedSampleRates = []int{0, 22050, 32000, 44100, 48000, 88200, 96000, 176400, 192000}

const (
	MinUIScale      = 80
	MaxUIScale      = 150
	MinBufferFrames = 32
	MaxBufferFrames = 8192
)

func DefaultMode() string {
	if runtime.GOOS == "windows" {
		return "lowlatency"
	}
	return "shared"
}

func Defaults(home string) Settings {
	folders := []string{}
	if home != "" {
		folders = append(folders, filepath.Join(home, "Music", "PracticeMusic"))
	}
	return Settings{
		Version:    Version,
		Library:    Library{Folders: folders, NormalizeOnImport: false},
		Audio:      Audio{Mode: DefaultMode(), SampleRate: 0, BufferFrames: 0},
		Appearance: Appearance{UIScale: 100},
	}
}

func Normalize(in Settings) (Settings, error) {
	out := in
	out.Version = Version
	if out.Appearance.UIScale < MinUIScale || out.Appearance.UIScale > MaxUIScale {
		return Settings{}, fmt.Errorf("UI scale must be between %d and %d percent", MinUIScale, MaxUIScale)
	}
	if !slices.Contains(allowedSampleRates, out.Audio.SampleRate) {
		return Settings{}, fmt.Errorf("sample rate %d is not supported", out.Audio.SampleRate)
	}
	if b := out.Audio.BufferFrames; b != 0 && (b < MinBufferFrames || b > MaxBufferFrames) {
		return Settings{}, fmt.Errorf("buffer size must be 0 (device default) or between %d and %d frames", MinBufferFrames, MaxBufferFrames)
	}
	if out.Audio.Mode == "" {
		out.Audio.Mode = DefaultMode()
	}
	if !slices.Contains(allowedModes, out.Audio.Mode) {
		return Settings{}, fmt.Errorf("output mode %q is not supported", out.Audio.Mode)
	}
	seen := map[string]bool{}
	folders := make([]string, 0, len(in.Library.Folders))
	for _, f := range in.Library.Folders {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		if !filepath.IsAbs(f) {
			return Settings{}, fmt.Errorf("library folder %q must be an absolute path", f)
		}
		f = filepath.Clean(f)
		key := f
		if os.PathSeparator == '\\' {
			key = strings.ToLower(f)
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		folders = append(folders, f)
	}
	out.Library.Folders = folders
	out.Audio.Host = strings.TrimSpace(out.Audio.Host)
	out.Audio.OutputDevice = strings.TrimSpace(out.Audio.OutputDevice)
	out.Audio.MonitorDevice = strings.TrimSpace(out.Audio.MonitorDevice)
	out.Audio.InputDevice = strings.TrimSpace(out.Audio.InputDevice)
	return out, nil
}

type Store struct {
	dir  string
	home string
	mu   sync.Mutex
	now  func() time.Time
}

func NewStore(dir, home string) *Store {
	return &Store{dir: dir, home: home, now: time.Now}
}

func (s *Store) Path() string {
	return filepath.Join(s.dir, FileName)
}

func (s *Store) Load() (Settings, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(s.Path())
	if errors.Is(err, os.ErrNotExist) {
		return Defaults(s.home), "", nil
	}
	if err != nil {
		return Settings{}, "", fmt.Errorf("read settings: %w", err)
	}
	var raw Settings
	if err := json.Unmarshal(data, &raw); err != nil {
		return s.quarantine(fmt.Sprintf("settings file is not valid JSON: %v", err))
	}
	if raw.Version > Version {
		return s.quarantine(fmt.Sprintf("settings were written by a newer version (%d)", raw.Version))
	}
	merged := withDefaults(raw, Defaults(s.home))
	clean, err := Normalize(merged)
	if err != nil {
		return s.quarantine(err.Error())
	}
	return clean, "", nil
}

func withDefaults(raw Settings, defaults Settings) Settings {
	if raw.Appearance.UIScale == 0 {
		raw.Appearance.UIScale = defaults.Appearance.UIScale
	}
	if raw.Library.Folders == nil {
		raw.Library.Folders = defaults.Library.Folders
	}
	return raw
}

func (s *Store) quarantine(reason string) (Settings, string, error) {
	backup := filepath.Join(s.dir, fmt.Sprintf("settings.invalid-%s.json", s.now().UTC().Format("20060102T150405")))
	if err := os.Rename(s.Path(), backup); err != nil {
		return Settings{}, "", fmt.Errorf("settings are invalid (%s) and could not be moved aside: %w", reason, err)
	}
	return Defaults(s.home), fmt.Sprintf("%s; the old file was kept as %s", reason, filepath.Base(backup)), nil
}

func (s *Store) Save(in Settings) (Settings, error) {
	clean, err := Normalize(in)
	if err != nil {
		return Settings{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return Settings{}, fmt.Errorf("create settings folder: %w", err)
	}
	data, err := json.MarshalIndent(clean, "", "  ")
	if err != nil {
		return Settings{}, err
	}
	tmp, err := os.CreateTemp(s.dir, "settings-*.tmp")
	if err != nil {
		return Settings{}, fmt.Errorf("write settings: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return Settings{}, fmt.Errorf("write settings: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return Settings{}, fmt.Errorf("write settings: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return Settings{}, fmt.Errorf("write settings: %w", err)
	}
	if err := os.Rename(tmpName, s.Path()); err != nil {
		os.Remove(tmpName)
		return Settings{}, fmt.Errorf("replace settings: %w", err)
	}
	return clean, nil
}
