package engine

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExtractWritesRunnableBinaryOnce(t *testing.T) {
	cache := t.TempDir()
	data := []byte("engine-bytes")
	first, err := Extract(data, cache)
	if err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(first)
	if err != nil || string(got) != string(data) {
		t.Fatalf("read back %q %v", got, err)
	}
	info, err := os.Stat(first)
	if err != nil {
		t.Fatal(err)
	}
	stamp := info.ModTime()
	second, err := Extract(data, cache)
	if err != nil || second != first {
		t.Fatalf("second extract %q %v", second, err)
	}
	info, _ = os.Stat(second)
	if !info.ModTime().Equal(stamp) {
		t.Fatal("an up to date engine was rewritten")
	}
}

func TestExtractRemovesOlderVersions(t *testing.T) {
	cache := t.TempDir()
	old, err := Extract([]byte("old engine"), cache)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := Extract([]byte("a newer engine build"), cache)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("old engine is still there: %v", err)
	}
	if filepath.Dir(old) == filepath.Dir(fresh) {
		t.Fatal("versions share a folder")
	}
}

func TestExtractRejectsEmptyPayload(t *testing.T) {
	if _, err := Extract(nil, t.TempDir()); err == nil {
		t.Fatal("expected an error")
	}
}
