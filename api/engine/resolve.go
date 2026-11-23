package engine

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

const EnvPath = "PM_ENGINE_PATH"

func binaryName() string {
	if runtime.GOOS == "windows" {
		return "pm-engine.exe"
	}
	return "pm-engine"
}

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func Resolve(env func(string) string, exe string, cwd string) (string, error) {
	if explicit := env(EnvPath); explicit != "" {
		if !isFile(explicit) {
			return "", fmt.Errorf("%s points to %s, which is not a file", EnvPath, explicit)
		}
		return explicit, nil
	}
	name := binaryName()
	if exe != "" {
		dir := filepath.Dir(exe)
		for _, c := range []string{
			filepath.Join(dir, "engine", name),
			filepath.Join(dir, name),
			filepath.Join(dir, "..", "engine", name),
		} {
			if isFile(c) {
				return filepath.Clean(c), nil
			}
		}
	}
	starts := []string{cwd}
	if exe != "" {
		starts = append(starts, filepath.Dir(exe))
	}
	for _, start := range starts {
		if start == "" || start == "." {
			continue
		}
		dir := start
		for i := 0; i < 8; i++ {
			for _, profile := range []string{"release", "debug"} {
				c := filepath.Join(dir, "engine", "target", profile, name)
				if isFile(c) {
					return c, nil
				}
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", errors.New("audio engine binary " + name + " not found; build it with npm run build:engine or set " + EnvPath)
}

func ResolveDefault() (string, error) {
	exe, _ := os.Executable()
	cwd, _ := os.Getwd()
	if os.Getenv(EnvPath) == "" {
		if path, ok := extractEmbedded(); ok {
			return path, nil
		}
	}
	return Resolve(os.Getenv, exe, cwd)
}
