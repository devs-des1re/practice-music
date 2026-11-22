package api

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/kratejs/krate/packages/native/krate"

	"practice-music/api/bundle"
	"practice-music/api/library"
	"practice-music/api/logger"
	"practice-music/api/metronome"
	"practice-music/api/mixer"
)

type SceneInfo struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	UpdatedAt int64  `json:"updatedAt"`
}

var SceneRevision = krate.NewSignal(0)

func bumpScenes() {
	SceneRevision.Update(func(n int) int { return n + 1 })
}

func sceneInfo(s library.Scene) SceneInfo {
	return SceneInfo{ID: s.ID, Name: s.Name, UpdatedAt: s.UpdatedAt}
}

func Scenes() ([]SceneInfo, error) {
	boot()
	if lib == nil {
		return nil, errLibrary()
	}
	all, err := lib.Scenes()
	if err != nil {
		return nil, err
	}
	out := make([]SceneInfo, len(all))
	for i, s := range all {
		out[i] = sceneInfo(s)
	}
	return out, nil
}

func currentPayload() bundle.ScenePayload {
	sessMu.Lock()
	defer sessMu.Unlock()
	return bundle.ScenePayload{Version: 1, Mixer: copyMixer(mixState), Metronome: copyMetronome(metroState)}
}

func SaveScene(name string) (SceneInfo, error) {
	boot()
	if lib == nil {
		return SceneInfo{}, errLibrary()
	}
	data, err := json.Marshal(currentPayload())
	if err != nil {
		return SceneInfo{}, err
	}
	saved, err := lib.SaveScene(name, string(data))
	if err != nil {
		return SceneInfo{}, err
	}
	ActiveScene.Set(SceneStatus{ID: saved.ID, Name: saved.Name})
	bumpScenes()
	logger.Infof("scene %q saved", saved.Name)
	return sceneInfo(saved), nil
}

func RecallScene(id int64) (SceneInfo, error) {
	boot()
	if lib == nil {
		return SceneInfo{}, errLibrary()
	}
	sc, err := lib.Scene(id)
	if err != nil {
		if errors.Is(err, library.ErrNotFound) {
			return SceneInfo{}, errors.New("that scene no longer exists")
		}
		return SceneInfo{}, err
	}
	var payload bundle.ScenePayload
	if err := json.Unmarshal([]byte(sc.Data), &payload); err != nil {
		return SceneInfo{}, fmt.Errorf("the scene %q is damaged", sc.Name)
	}
	sessMu.Lock()
	mixState = mixer.Normalize(payload.Mixer)
	metroState = metronome.Normalize(payload.Metronome)
	sessMu.Unlock()
	scheduleSave()
	var pushErr error
	if audioRunning() {
		ctx, cancel := mixCtx()
		_, pushErr = pushSession(ctx, true)
		cancel()
	}
	ActiveScene.Set(SceneStatus{ID: sc.ID, Name: sc.Name})
	SessionEpoch.Update(func(n int) int { return n + 1 })
	logger.Infof("scene %q recalled", sc.Name)
	if pushErr != nil {
		return sceneInfo(sc), fmt.Errorf("the scene was loaded but the audio engine did not accept all of it: %w", pushErr)
	}
	return sceneInfo(sc), nil
}

func RenameScene(id int64, name string) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	if err := lib.RenameScene(id, name); err != nil {
		return err
	}
	if sc, err := lib.Scene(id); err == nil {
		ActiveScene.Update(func(s SceneStatus) SceneStatus {
			if s.ID == id {
				s.Name = sc.Name
			}
			return s
		})
	}
	bumpScenes()
	return nil
}

func DeleteScene(id int64) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	if err := lib.DeleteScene(id); err != nil {
		return err
	}
	ActiveScene.Update(func(s SceneStatus) SceneStatus {
		if s.ID == id {
			return SceneStatus{}
		}
		return s
	})
	bumpScenes()
	return nil
}
