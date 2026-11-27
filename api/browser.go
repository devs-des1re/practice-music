package api

import (
	"sync"

	"github.com/kratejs/krate/packages/native/krate"
	"github.com/kratejs/krate/packages/native/sdk/remote"
	"github.com/kratejs/krate/packages/native/sdk/window"

	"practice-music/api/logger"
	"practice-music/api/refusal"
)

type BrowserInfo struct {
	Open  bool   `json:"open"`
	View  string `json:"view"`
	URL   string `json:"url"`
	Error string `json:"error"`
}

var BrowserState = krate.NewSignal(BrowserInfo{})

var (
	browserMu     sync.Mutex
	browserView   string
	browserPane   *window.View
	browserCancel func()
)

func setBrowser(change func(*BrowserInfo)) {
	st := BrowserState.Get()
	change(&st)
	BrowserState.Set(st)
}

func OpenBrowser(url string) (BrowserInfo, error) {
	boot()
	browserMu.Lock()
	defer browserMu.Unlock()
	if browserView != "" {
		return BrowserState.Get(), nil
	}
	view, err := remote.AddView("main", remote.ViewOptions{
		Options: remote.Options{
			URL:           url,
			Partition:     "persist:browser",
			AllowAnyHTTPS: true,
			Blocked:       "external",
		},
		Side:     "right",
		Size:     0.5,
		MinWidth: 360,
	})
	if err != nil {
		setBrowser(func(b *BrowserInfo) { b.Open = false; b.Error = err.Error() })
		return BrowserState.Get(), err
	}
	browserView = view.ID
	browserPane = view
	cancel, err := remote.OnEvent(func(ev remote.Event) {
		if ev.View != view.ID || ev.Kind != "loaded" {
			return
		}
		setBrowser(func(b *BrowserInfo) { b.URL = ev.URL })
	})
	if err != nil {
		logger.Warnf("browser events unavailable: %v", err)
	}
	browserCancel = cancel
	setBrowser(func(b *BrowserInfo) { b.Open = true; b.View = view.ID; b.URL = url; b.Error = "" })
	logger.Infof("browser pane opened as %s", view.ID)
	return BrowserState.Get(), nil
}

func BrowserGo(url string) error {
	boot()
	browserMu.Lock()
	id := browserView
	browserMu.Unlock()
	if id == "" {
		return refusal.New("the browser pane is not open")
	}
	return remote.Navigate(id, url)
}

func CloseBrowser() error {
	browserMu.Lock()
	defer browserMu.Unlock()
	if browserView == "" {
		return nil
	}
	if browserCancel != nil {
		browserCancel()
		browserCancel = nil
	}
	pane := browserPane
	browserView = ""
	browserPane = nil
	setBrowser(func(b *BrowserInfo) { b.Open = false; b.View = "" })
	if pane == nil {
		return nil
	}
	return pane.Remove()
}
