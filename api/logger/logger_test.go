package logger

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestFormatMatchesTheSharedShape(t *testing.T) {
	now = func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 6000000, time.UTC) }
	defer func() { now = time.Now }()
	SetColor(false)
	got := Format(Warn, "engine slow")
	want := "2026-01-02T03:04:05.006Z WARN  engine slow"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestColorWrapsOnlyTheLevel(t *testing.T) {
	SetColor(true)
	defer SetColor(false)
	got := Format(Error, "x")
	if !strings.Contains(got, "\x1b[31mERROR\x1b[0m") {
		t.Fatalf("level not coloured: %q", got)
	}
}

func TestWriteGoesToTheConfiguredOutput(t *testing.T) {
	var buf bytes.Buffer
	SetOutput(&buf)
	SetColor(false)
	Infof("hello %d", 3)
	if !strings.HasSuffix(strings.TrimSpace(buf.String()), "INFO  hello 3") {
		t.Fatalf("unexpected output %q", buf.String())
	}
}
