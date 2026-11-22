package bundle

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"practice-music/api/metronome"
	"practice-music/api/mixer"
	"practice-music/api/settings"
)

const (
	Format      = "practicemusic-settings"
	Version     = 1
	MaxBytes    = 2 * 1024 * 1024
	maxScenes   = 200
	maxSceneLen = 64 * 1024
)

type SceneEntry struct {
	Name string          `json:"name"`
	Data json.RawMessage `json:"data"`
}

type Bundle struct {
	Format     string            `json:"format"`
	Version    int               `json:"version"`
	ExportedAt string            `json:"exportedAt"`
	App        string            `json:"app"`
	Settings   settings.Settings `json:"settings"`
	Mixer      mixer.State       `json:"mixer"`
	Metronome  metronome.State   `json:"metronome"`
	Scenes     []SceneEntry      `json:"scenes"`
}

type ScenePayload struct {
	Version   int             `json:"version"`
	Mixer     mixer.State     `json:"mixer"`
	Metronome metronome.State `json:"metronome"`
}

func Build(app string, s settings.Settings, m mixer.State, met metronome.State, scenes []SceneEntry, now time.Time) Bundle {
	if scenes == nil {
		scenes = []SceneEntry{}
	}
	return Bundle{
		Format:     Format,
		Version:    Version,
		ExportedAt: now.UTC().Format(time.RFC3339),
		App:        app,
		Settings:   s,
		Mixer:      m,
		Metronome:  met,
		Scenes:     scenes,
	}
}

func Encode(b Bundle) ([]byte, error) {
	if b.Scenes == nil {
		b.Scenes = []SceneEntry{}
	}
	data, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return nil, err
	}
	return data, nil
}

func Decode(r io.Reader, home string) (Bundle, error) {
	data, err := io.ReadAll(io.LimitReader(r, MaxBytes+1))
	if err != nil {
		return Bundle{}, fmt.Errorf("read the settings file: %w", err)
	}
	if len(data) > MaxBytes {
		return Bundle{}, errors.New("that file is too large to be a PracticeMusic settings export")
	}
	var b Bundle
	if err := json.Unmarshal(data, &b); err != nil {
		return Bundle{}, errors.New("that file is not a PracticeMusic settings export")
	}
	if b.Format != Format {
		return Bundle{}, errors.New("that file is not a PracticeMusic settings export")
	}
	if b.Version < 1 {
		return Bundle{}, errors.New("that export has no version number")
	}
	if b.Version > Version {
		return Bundle{}, fmt.Errorf("that export was made by a newer version of PracticeMusic (format %d)", b.Version)
	}
	clean, err := settings.Normalize(settingsWithDefaults(b.Settings, home))
	if err != nil {
		return Bundle{}, fmt.Errorf("the settings in that file are not valid: %w", err)
	}
	b.Settings = clean
	b.Mixer = mixer.Normalize(b.Mixer)
	b.Metronome = metronome.Normalize(b.Metronome)
	if len(b.Scenes) > maxScenes {
		return Bundle{}, fmt.Errorf("that export has more than %d scenes", maxScenes)
	}
	seen := map[string]bool{}
	scenes := make([]SceneEntry, 0, len(b.Scenes))
	for _, sc := range b.Scenes {
		name := strings.Join(strings.Fields(sc.Name), " ")
		if name == "" || len([]rune(name)) > 40 {
			return Bundle{}, errors.New("a scene in that file has no usable name")
		}
		key := strings.ToLower(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		if len(sc.Data) > maxSceneLen {
			return Bundle{}, fmt.Errorf("the scene %q is too large", name)
		}
		var payload ScenePayload
		if err := json.Unmarshal(sc.Data, &payload); err != nil {
			return Bundle{}, fmt.Errorf("the scene %q is damaged", name)
		}
		payload.Version = 1
		payload.Mixer = mixer.Normalize(payload.Mixer)
		payload.Metronome = metronome.Normalize(payload.Metronome)
		fixed, err := json.Marshal(payload)
		if err != nil {
			return Bundle{}, err
		}
		scenes = append(scenes, SceneEntry{Name: name, Data: fixed})
	}
	b.Scenes = scenes
	return b, nil
}

func settingsWithDefaults(in settings.Settings, home string) settings.Settings {
	def := settings.Defaults(home)
	if in.Appearance.UIScale == 0 {
		in.Appearance.UIScale = def.Appearance.UIScale
	}
	if in.Library.Folders == nil {
		in.Library.Folders = def.Library.Folders
	}
	return in
}

func DropMissingDevices(s settings.Settings, known map[string]bool) (settings.Settings, []string) {
	var dropped []string
	check := func(label string, id *string) {
		if *id != "" && !known[*id] {
			dropped = append(dropped, label)
			*id = ""
		}
	}
	check("output device", &s.Audio.OutputDevice)
	check("monitor device", &s.Audio.MonitorDevice)
	check("input device", &s.Audio.InputDevice)
	return s, dropped
}
