package persist

import (
	"os"
	"path/filepath"
	"testing"
)

type sample struct {
	Name  string  `json:"name"`
	Level float64 `json:"level"`
}

func TestSaveThenLoadRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "state.json")
	if err := Save(path, sample{Name: "kit", Level: -3.5}); err != nil {
		t.Fatal(err)
	}
	var got sample
	found, err := Load(path, &got)
	if err != nil || !found {
		t.Fatalf("found=%v err=%v", found, err)
	}
	if got.Name != "kit" || got.Level != -3.5 {
		t.Fatalf("got %+v", got)
	}
}

func TestLoadingAMissingFileIsNotAnError(t *testing.T) {
	var got sample
	found, err := Load(filepath.Join(t.TempDir(), "nothing.json"), &got)
	if err != nil || found {
		t.Fatalf("found=%v err=%v", found, err)
	}
}

func TestLoadingBrokenJSONIsReported(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(path, []byte("{nope"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got sample
	found, err := Load(path, &got)
	if err == nil || found {
		t.Fatalf("found=%v err=%v", found, err)
	}
}

func TestSaveReplacesAnExistingFileWithoutLeavingTempFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	for i := 0; i < 3; i++ {
		if err := Save(path, sample{Name: "v", Level: float64(i)}); err != nil {
			t.Fatal(err)
		}
	}
	var got sample
	if _, err := Load(path, &got); err != nil || got.Level != 2 {
		t.Fatalf("got %+v err %v", got, err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("expected one file, found %d", len(entries))
	}
}
