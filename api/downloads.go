package api

import (
	"context"
	"errors"
	"time"

	"github.com/kratejs/krate/packages/native/krate"

	"practice-music/api/downloads"
	"practice-music/api/tools"
)

type ToolsState struct {
	YtDlp      tools.YtDlpStatus `json:"ytDlp"`
	FFmpeg     string            `json:"ffmpeg"`
	FFprobe    string            `json:"ffprobe"`
	LibraryDir string            `json:"libraryDir"`
}

var DownloadList = krate.NewSignal([]downloads.Job{})

var ToolsInfo = krate.NewSignal(ToolsState{})

func currentTools() ToolsState {
	st := ToolsState{}
	if tm != nil {
		st.YtDlp = tm.Status()
		if st.YtDlp.Source == "" {
			path, source := tm.Locate()
			st.YtDlp.Source = source
			st.YtDlp.Path = path
		}
	}
	t := mediaTools()
	st.FFmpeg = t.FFmpeg
	st.FFprobe = t.FFprobe
	if dir, err := downloadDir(); err == nil {
		st.LibraryDir = dir
	}
	return st
}

func publishTools() {
	ToolsInfo.Set(currentTools())
}

func EnqueueDownload(url, format, quality string) (downloads.Job, error) {
	boot()
	if dl == nil {
		return downloads.Job{}, errLibrary()
	}
	if _, err := downloadDir(); err != nil {
		return downloads.Job{}, err
	}
	return dl.Enqueue(downloads.Request{URL: url, Format: format, Quality: quality})
}

func CancelDownload(id int64) error {
	boot()
	if dl == nil {
		return errLibrary()
	}
	return dl.Cancel(id)
}

func RetryDownload(id int64) error {
	boot()
	if dl == nil {
		return errLibrary()
	}
	return dl.Retry(id)
}

func RemoveDownload(id int64) error {
	boot()
	if dl == nil {
		return errLibrary()
	}
	return dl.Remove(id)
}

func ClearDownloads() error {
	boot()
	if dl == nil {
		return errLibrary()
	}
	return dl.ClearFinished()
}

func CheckTools() (ToolsState, error) {
	boot()
	if tm == nil {
		return ToolsState{}, errors.New("tools are not ready")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	_, err := tm.Check(ctx)
	publishTools()
	return currentTools(), err
}

func InstallYtDlp() (ToolsState, error) {
	boot()
	if tm == nil {
		return ToolsState{}, errors.New("tools are not ready")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	_, err := tm.Install(ctx)
	publishTools()
	return currentTools(), err
}

func ToolStatus() ToolsState {
	boot()
	return currentTools()
}
