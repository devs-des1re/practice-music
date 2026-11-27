package refusal

import (
	"errors"
	"fmt"
	"io/fs"
	"testing"

	"github.com/kratejs/krate/packages/native/krate"
)

func crossing(err error) (code, message string) {
	var coded *krate.Error
	if errors.As(err, &coded) {
		return coded.Code, coded.Message
	}
	return "internal", err.Error()
}

func TestARefusalReachesTheAppWithItsOwnCode(t *testing.T) {
	err := New("open a song first")
	if code, message := crossing(err); code != "refused" || message != "open a song first" {
		t.Fatalf("%q %q", code, message)
	}
	if err.Error() != "open a song first" {
		t.Fatalf("text shown elsewhere must not change: %q", err.Error())
	}
}

func TestAFormattedRefusalKeepsItsTextAndCause(t *testing.T) {
	err := Errorf("that file cannot be used: %w", fs.ErrNotExist)
	if code, message := crossing(err); code != "refused" || message != "that file cannot be used: file does not exist" {
		t.Fatalf("%q %q", code, message)
	}
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("the cause must still be found")
	}
}

func TestARealFailureStaysAFailure(t *testing.T) {
	for _, err := range []error{errors.New("disk full"), fmt.Errorf("write settings: %w", fs.ErrPermission)} {
		if code, _ := crossing(err); code != "internal" {
			t.Fatalf("%v became %q", err, code)
		}
	}
}
