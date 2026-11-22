package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUniquePathNumbersDuplicates(t *testing.T) {
	dir := t.TempDir()
	first := uniquePath(dir, "song.mp3")
	if first != filepath.Join(dir, "song.mp3") {
		t.Fatalf("got %s", first)
	}
	os.WriteFile(first, []byte("a"), 0o644)
	second := uniquePath(dir, "song.mp3")
	if filepath.Base(second) != "song (2).mp3" {
		t.Fatalf("got %s", second)
	}
	os.WriteFile(second, []byte("b"), 0o644)
	if filepath.Base(uniquePath(dir, "song.mp3")) != "song (3).mp3" {
		t.Fatal("third copy should be numbered 3")
	}
}

func TestCopyFileNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.mp3")
	dst := filepath.Join(dir, "dst.mp3")
	os.WriteFile(src, []byte("new"), 0o644)
	os.WriteFile(dst, []byte("old"), 0o644)
	if err := copyFile(src, dst); err == nil {
		t.Fatal("copy must refuse to overwrite an existing file")
	}
	data, _ := os.ReadFile(dst)
	if string(data) != "old" {
		t.Fatalf("existing file was modified: %q", data)
	}
	dst2 := filepath.Join(dir, "other.mp3")
	if err := copyFile(src, dst2); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(dst2)
	if string(data) != "new" {
		t.Fatalf("%q", data)
	}
	if err := copyFile(filepath.Join(dir, "missing"), filepath.Join(dir, "x")); err == nil {
		t.Fatal("a missing source must fail")
	}
	if _, err := os.Stat(filepath.Join(dir, "x")); err == nil {
		t.Fatal("a failed copy must not leave a file")
	}
}

func TestThumbDataURL(t *testing.T) {
	thumbDir = t.TempDir()
	if thumbDataURL("") != "" || thumbDataURL("missing.jpg") != "" {
		t.Fatal("no thumbnail should give an empty string")
	}
	os.WriteFile(filepath.Join(thumbDir, "a.jpg"), []byte{0xff, 0xd8, 0xff}, 0o644)
	got := thumbDataURL("a.jpg")
	if !strings.HasPrefix(got, "data:image/jpeg;base64,") || !strings.HasSuffix(got, "/9j/") {
		t.Fatalf("%q", got)
	}
}
