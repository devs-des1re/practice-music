package settings

import (
	"fmt"
	"slices"
)

type Preferences struct {
	Glass               string  `json:"glass"`
	Corners             string  `json:"corners"`
	Tooltips            bool    `json:"tooltips"`
	TooltipDelayMs      int     `json:"tooltipDelayMs"`
	PeakHoldMs          int     `json:"peakHoldMs"`
	ReductionBars       bool    `json:"reductionBars"`
	FaderStepDb         float64 `json:"faderStepDb"`
	SeekSeconds         int     `json:"seekSeconds"`
	SeekLargeSeconds    int     `json:"seekLargeSeconds"`
	SpeedStep           int     `json:"speedStep"`
	RestartAfterSeconds int     `json:"restartAfterSeconds"`
	DefaultSnap         string  `json:"defaultSnap"`
	BeatGrid            bool    `json:"beatGrid"`
	TempoStep           float64 `json:"tempoStep"`
	TempoStepLarge      float64 `json:"tempoStepLarge"`
	LibrarySort         string  `json:"librarySort"`
	Artwork             bool    `json:"artwork"`
	PlayOnLoad          bool    `json:"playOnLoad"`
	DownloadChoice      string  `json:"downloadChoice"`
	CheckUpdates        bool    `json:"checkUpdates"`
}

var (
	allowedGlass    = []string{"full", "subtle", "off"}
	allowedCorners  = []string{"rounded", "slight", "square"}
	allowedSnaps    = []string{"beat", "bar", "off"}
	allowedSorts    = []string{"added", "title", "artist", "duration"}
	allowedFaderDb  = []float64{0.1, 0.5, 1}
	allowedDownload = []string{"last", "mp3:best", "mp3:320", "mp3:256", "mp3:192", "mp3:128", "mp4:best", "mp4:1080", "mp4:720", "mp4:480", "mp4:360"}
)

func DefaultPreferences() Preferences {
	return Preferences{
		Glass:               "full",
		Corners:             "rounded",
		Tooltips:            true,
		TooltipDelayMs:      450,
		PeakHoldMs:          1200,
		ReductionBars:       true,
		FaderStepDb:         0.5,
		SeekSeconds:         5,
		SeekLargeSeconds:    15,
		SpeedStep:           5,
		RestartAfterSeconds: 3,
		DefaultSnap:         "beat",
		BeatGrid:            true,
		TempoStep:           1,
		TempoStepLarge:      5,
		LibrarySort:         "added",
		Artwork:             true,
		PlayOnLoad:          false,
		DownloadChoice:      "last",
		CheckUpdates:        true,
	}
}

func within[T int | float64](name string, value, low, high T) error {
	if value < low || value > high {
		return fmt.Errorf("%s must be between %v and %v", name, low, high)
	}
	return nil
}

func oneOf[T comparable](name string, value T, allowed []T) error {
	if !slices.Contains(allowed, value) {
		return fmt.Errorf("%s %v is not supported", name, value)
	}
	return nil
}

func normalizePreferences(in Preferences) (Preferences, error) {
	if in == (Preferences{}) {
		return DefaultPreferences(), nil
	}
	checks := []error{
		oneOf("glass style", in.Glass, allowedGlass),
		oneOf("corner style", in.Corners, allowedCorners),
		within("tooltip delay", in.TooltipDelayMs, 0, 3000),
		within("peak hold time", in.PeakHoldMs, 0, 10000),
		oneOf("fader step", in.FaderStepDb, allowedFaderDb),
		within("seek step in seconds", in.SeekSeconds, 1, 60),
		within("large seek step in seconds", in.SeekLargeSeconds, 1, 300),
		within("speed step", in.SpeedStep, 1, 25),
		within("restart time in seconds", in.RestartAfterSeconds, 0, 30),
		oneOf("default snapping", in.DefaultSnap, allowedSnaps),
		within("tempo step", in.TempoStep, 0.1, 10),
		within("large tempo step", in.TempoStepLarge, 0.1, 50),
		oneOf("library sort", in.LibrarySort, allowedSorts),
		oneOf("download format", in.DownloadChoice, allowedDownload),
	}
	for _, err := range checks {
		if err != nil {
			return Preferences{}, err
		}
	}
	return in, nil
}
