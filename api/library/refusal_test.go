package library

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/kratejs/krate/packages/native/krate"
)

func codeOf(err error) string {
	var coded *krate.Error
	if errors.As(err, &coded) {
		return coded.Code
	}
	return "internal"
}

func TestANameProblemIsARefusalButABrokenDatabaseIsNot(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreatePlaylist("test"); err != nil {
		t.Fatal(err)
	}
	_, duplicate := db.CreatePlaylist("TEST")
	if codeOf(duplicate) != "refused" || duplicate.Error() != `a playlist named "TEST" already exists` {
		t.Fatalf("%q %v", codeOf(duplicate), duplicate)
	}
	if _, blank := db.CreatePlaylist("   "); codeOf(blank) != "refused" {
		t.Fatalf("%v", blank)
	}
	db.Close()
	if _, broken := db.CreatePlaylist("another"); broken == nil || codeOf(broken) != "internal" {
		t.Fatalf("a broken database must stay a failure: %v", broken)
	}
}
