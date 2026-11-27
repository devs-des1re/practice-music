package api

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"practice-music/api/bundle"
	"practice-music/api/logger"
	"practice-music/api/metronome"
	"practice-music/api/mixer"
	"practice-music/api/refusal"
)

type TransferResult struct {
	Path   string   `json:"path"`
	Scenes int      `json:"scenes"`
	Notes  []string `json:"notes"`
}

func ExportSettings(path string) (TransferResult, error) {
	boot()
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return TransferResult{}, refusal.New("choose where to save the export")
	}
	if filepath.Ext(path) == "" {
		path += ".json"
	}
	doc, _, err := store.Load()
	if err != nil {
		return TransferResult{}, err
	}
	var entries []bundle.SceneEntry
	if lib != nil {
		scenes, err := lib.Scenes()
		if err != nil {
			return TransferResult{}, err
		}
		for _, sc := range scenes {
			if !json.Valid([]byte(sc.Data)) {
				continue
			}
			entries = append(entries, bundle.SceneEntry{Name: sc.Name, Data: json.RawMessage(sc.Data)})
		}
	}
	sessMu.Lock()
	m := copyMixer(mixState)
	met := copyMetronome(metroState)
	sessMu.Unlock()
	b := bundle.Build("PracticeMusic "+Version, doc, m, met, entries, time.Now())
	data, err := bundle.Encode(b)
	if err != nil {
		return TransferResult{}, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return TransferResult{}, fmt.Errorf("create the folder: %w", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return TransferResult{}, fmt.Errorf("write the export: %w", err)
	}
	logger.Infof("settings exported to %s", path)
	return TransferResult{Path: path, Scenes: len(entries), Notes: []string{}}, nil
}

func knownDevices() map[string]bool {
	list, err := Devices()
	if err != nil {
		return nil
	}
	known := make(map[string]bool, len(list.Devices))
	for _, d := range list.Devices {
		known[d.ID] = true
	}
	return known
}

func ImportSettings(path string) (TransferResult, error) {
	boot()
	path = strings.TrimSpace(path)
	if path == "" || !filepath.IsAbs(path) {
		return TransferResult{}, refusal.New("choose the file to import")
	}
	f, err := os.Open(path)
	if err != nil {
		return TransferResult{}, refusal.New("that file cannot be opened")
	}
	defer f.Close()
	home, _ := os.UserHomeDir()
	b, err := bundle.Decode(f, home)
	if err != nil {
		return TransferResult{}, err
	}
	notes := []string{}
	incoming := b.Settings
	if known := knownDevices(); known != nil {
		var dropped []string
		incoming, dropped = bundle.DropMissingDevices(incoming, known)
		for _, label := range dropped {
			notes = append(notes, fmt.Sprintf("The %s from that file is not connected here, so the system default is used.", label))
		}
	}
	saved, err := store.Save(incoming)
	if err != nil {
		return TransferResult{}, err
	}
	imported := 0
	if lib != nil {
		for _, sc := range b.Scenes {
			if _, err := lib.SaveScene(sc.Name, string(sc.Data)); err != nil {
				notes = append(notes, fmt.Sprintf("The scene %q was skipped: %v", sc.Name, err))
				continue
			}
			imported++
		}
	} else if len(b.Scenes) > 0 {
		notes = append(notes, "The library is not available, so scenes were not imported.")
	}
	sessMu.Lock()
	mixState = mixer.Normalize(b.Mixer)
	metroState = metronome.Normalize(b.Metronome)
	sessMu.Unlock()
	scheduleSave()
	applyAudioSettings(saved)
	if audioRunning() {
		ctx, cancel := mixCtx()
		if _, err := pushSession(ctx, true); err != nil {
			notes = append(notes, "The audio engine did not accept all of the imported mixer settings.")
		}
		cancel()
	}
	ActiveScene.Set(SceneStatus{})
	SessionEpoch.Update(func(n int) int { return n + 1 })
	bumpScenes()
	logger.Infof("settings imported from %s (%d scenes)", path, imported)
	return TransferResult{Path: path, Scenes: imported, Notes: notes}, nil
}
