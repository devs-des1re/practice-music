package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func touch(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
}

func noEnv(string) string { return "" }

func TestExplicitPathWinsAndMustExist(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "custom-engine")
	touch(t, good)
	got, err := Resolve(func(k string) string {
		if k == EnvPath {
			return good
		}
		return ""
	}, "", "")
	if err != nil || got != good {
		t.Fatalf("got %q %v", got, err)
	}
	_, err = Resolve(func(k string) string {
		if k == EnvPath {
			return filepath.Join(dir, "missing")
		}
		return ""
	}, "", "")
	if err == nil || !strings.Contains(err.Error(), EnvPath) {
		t.Fatalf("want an error naming %s, got %v", EnvPath, err)
	}
}

func TestFindsEngineNextToTheExecutable(t *testing.T) {
	dir := t.TempDir()
	want := filepath.Join(dir, "engine", binaryName())
	touch(t, want)
	got, err := Resolve(noEnv, filepath.Join(dir, "app.exe"), "")
	if err != nil || got != want {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestFindsDevBuildAboveTheWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	want := filepath.Join(root, "engine", "target", "debug", binaryName())
	touch(t, want)
	nested := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := Resolve(noEnv, "", nested)
	if err != nil || got != want {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestPrefersReleaseOverDebug(t *testing.T) {
	root := t.TempDir()
	release := filepath.Join(root, "engine", "target", "release", binaryName())
	touch(t, release)
	touch(t, filepath.Join(root, "engine", "target", "debug", binaryName()))
	got, err := Resolve(noEnv, "", root)
	if err != nil || got != release {
		t.Fatalf("got %q %v", got, err)
	}
}

func TestMissingEngineGivesAnActionableError(t *testing.T) {
	_, err := Resolve(noEnv, "", t.TempDir())
	if err == nil || !strings.Contains(err.Error(), "build:engine") {
		t.Fatalf("want a hint about building the engine, got %v", err)
	}
}
