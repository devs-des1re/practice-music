package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"practice-music/api/update"
)

type flowRig struct {
	flow   *updateFlow
	opened []string
	phases []string
	refuse error
}

func newFlowRig(t *testing.T, current string, status int) *flowRig {
	t.Helper()
	body := []byte(strings.Repeat("setup ", 2000))
	sum := sha256.Sum256(body)
	var base string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/feed" {
			_, _ = w.Write(body)
			return
		}
		w.WriteHeader(status)
		name := "practicemusic-0.2.0-windows-amd64-setup.exe"
		fmt.Fprintf(w, `[{"tag_name":"v0.2.0","body":"Better","html_url":"%s/tag/v0.2.0","assets":[{"name":"%s","size":%d,"digest":"sha256:%s","browser_download_url":"%s/download/%s"}]}]`,
			base, name, len(body), hex.EncodeToString(sum[:]), base, name)
	}))
	t.Cleanup(server.Close)
	base = server.URL
	rig := &flowRig{}
	rig.flow = &updateFlow{
		client: &update.Client{
			Feed:    base + "/feed",
			HTTP:    server.Client(),
			Allowed: func(*url.URL) error { return nil },
			Assets:  base + "/download/",
			Pages:   base + "/",
		},
		system:  update.System{OS: "windows", Arch: "amd64"},
		current: current,
		dir:     t.TempDir(),
		open: func(path string) error {
			if rig.refuse != nil {
				return rig.refuse
			}
			rig.opened = append(rig.opened, path)
			return nil
		},
		publish: func(s UpdateState) { rig.phases = append(rig.phases, s.Phase) },
		state:   UpdateState{Phase: updateIdle, Current: current},
	}
	return rig
}

func TestAnUpdateIsDownloadedCheckedAndOpened(t *testing.T) {
	rig := newFlowRig(t, "0.1.0", http.StatusOK)
	if _, err := rig.flow.start(); err == nil {
		t.Fatal("nothing can be installed before a check")
	}
	state, err := rig.flow.check(context.Background(), false)
	if err != nil || state.Phase != updateAvailable || state.Latest != "0.2.0" || !state.CanInstall || state.Notes != "Better" {
		t.Fatalf("%+v %v", state, err)
	}
	work, err := rig.flow.start()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rig.flow.start(); err == nil {
		t.Fatal("a second download must be refused")
	}
	work()
	if got := rig.flow.snapshot(); got.Phase != updateOpened || got.Done != got.Size {
		t.Fatalf("%+v", got)
	}
	if len(rig.opened) != 1 {
		t.Fatalf("opened %v", rig.opened)
	}
	if _, err := os.Stat(rig.opened[0]); err != nil {
		t.Fatal(err)
	}
}

func TestARefusedInstallerLeavesTheUpdateOnOffer(t *testing.T) {
	rig := newFlowRig(t, "0.1.0", http.StatusOK)
	rig.refuse = errors.New("Windows did not give permission to run it")
	if _, err := rig.flow.check(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	work, err := rig.flow.start()
	if err != nil {
		t.Fatal(err)
	}
	work()
	got := rig.flow.snapshot()
	if got.Phase != updateAvailable || got.Error != rig.refuse.Error() {
		t.Fatalf("%+v", got)
	}
}

func TestACancelledDownloadOpensNothing(t *testing.T) {
	rig := newFlowRig(t, "0.1.0", http.StatusOK)
	if _, err := rig.flow.check(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	work, err := rig.flow.start()
	if err != nil {
		t.Fatal(err)
	}
	rig.flow.stop()
	work()
	if got := rig.flow.snapshot(); got.Phase != updateAvailable || got.Error != "" || len(rig.opened) != 0 {
		t.Fatalf("%+v %v", got, rig.opened)
	}
}

func TestAFailedCheckOnlySpeaksUpWhenAsked(t *testing.T) {
	rig := newFlowRig(t, "0.1.0", http.StatusForbidden)
	state, err := rig.flow.check(context.Background(), true)
	if err == nil || state.Phase != updateIdle || state.Error != "" {
		t.Fatalf("%+v %v", state, err)
	}
	state, err = rig.flow.check(context.Background(), false)
	if err == nil || state.Phase != updateFailed || !strings.Contains(state.Error, "403") {
		t.Fatalf("%+v %v", state, err)
	}
}

func TestTheNewestVersionReportsItselfUpToDate(t *testing.T) {
	rig := newFlowRig(t, "0.2.0", http.StatusOK)
	state, err := rig.flow.check(context.Background(), false)
	if err != nil || state.Phase != updateCurrent || state.Latest != "" {
		t.Fatalf("%+v %v", state, err)
	}
}
