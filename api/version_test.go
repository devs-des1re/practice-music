package api

import (
	"encoding/json"
	"os"
	"testing"
)

func TestVersionMatchesPackageJSON(t *testing.T) {
	data, err := os.ReadFile("../package.json")
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		t.Fatal(err)
	}
	if pkg.Version != Version {
		t.Fatalf("api.Version is %s but package.json says %s", Version, pkg.Version)
	}
}
