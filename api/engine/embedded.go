package engine

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

//go:embed all:payload
var payload embed.FS

func embeddedBinary() []byte {
	data, err := payload.ReadFile("payload/" + binaryName())
	if err != nil || len(data) == 0 {
		return nil
	}
	return data
}

func Extract(data []byte, cacheDir string) (string, error) {
	if len(data) == 0 {
		return "", errors.New("no audio engine is embedded in this build")
	}
	sum := sha256.Sum256(data)
	version := hex.EncodeToString(sum[:])[:12]
	root := filepath.Join(cacheDir, "PracticeMusic")
	dir := filepath.Join(root, "engine-"+version)
	target := filepath.Join(dir, binaryName())
	if info, err := os.Stat(target); err == nil && !info.IsDir() && info.Size() == int64(len(data)) {
		return target, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create the engine folder: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "pm-engine-*.tmp")
	if err != nil {
		return "", fmt.Errorf("write the audio engine: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return "", fmt.Errorf("write the audio engine: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("write the audio engine: %w", err)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		os.Remove(tmpName)
		return "", fmt.Errorf("mark the audio engine runnable: %w", err)
	}
	if err := os.Rename(tmpName, target); err != nil {
		os.Remove(tmpName)
		if info, statErr := os.Stat(target); statErr == nil && !info.IsDir() {
			return target, nil
		}
		return "", fmt.Errorf("place the audio engine: %w", err)
	}
	pruneOld(root, "engine-"+version)
	return target, nil
}

func pruneOld(root string, keep string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() && e.Name() != keep && strings.HasPrefix(e.Name(), "engine-") {
			os.RemoveAll(filepath.Join(root, e.Name()))
		}
	}
}

func extractEmbedded() (string, bool) {
	data := embeddedBinary()
	if data == nil {
		return "", false
	}
	cache, err := os.UserCacheDir()
	if err != nil || cache == "" {
		cache = os.TempDir()
	}
	path, err := Extract(data, cache)
	if err != nil {
		return "", false
	}
	return path, true
}
