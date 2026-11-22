package logger

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

type Level string

const (
	Info  Level = "info"
	Warn  Level = "warn"
	Error Level = "error"
)

var colors = map[Level]string{
	Info:  "\x1b[36m",
	Warn:  "\x1b[33m",
	Error: "\x1b[31m",
}

const reset = "\x1b[0m"

var (
	mu       sync.Mutex
	out      io.Writer = os.Stderr
	useColor           = os.Getenv("NODE_ENV") != "production"
	now                = time.Now
)

func SetOutput(w io.Writer) {
	mu.Lock()
	defer mu.Unlock()
	out = w
}

func SetColor(on bool) {
	mu.Lock()
	defer mu.Unlock()
	useColor = on
}

func Format(level Level, message string, meta ...any) string {
	label := fmt.Sprintf("%-5s", strings.ToUpper(string(level)))
	tag := label
	if useColor {
		tag = colors[level] + label + reset
	}
	line := now().UTC().Format("2006-01-02T15:04:05.000Z") + " " + tag + " " + message
	if len(meta) > 0 {
		line += " " + fmt.Sprint(meta...)
	}
	return line
}

func write(level Level, message string, meta ...any) {
	mu.Lock()
	defer mu.Unlock()
	fmt.Fprintln(out, Format(level, message, meta...))
}

func Infof(format string, args ...any) { write(Info, fmt.Sprintf(format, args...)) }

func Warnf(format string, args ...any) { write(Warn, fmt.Sprintf(format, args...)) }

func Errorf(format string, args ...any) { write(Error, fmt.Sprintf(format, args...)) }
