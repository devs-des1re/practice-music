package tools

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
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCompareVersionsHandlesDatesAndNightlySuffixes(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"2025.01.15", "2025.01.15", 0},
		{"2025.01.15", "2025.02.01", -1},
		{"2025.10.01", "2025.9.30", 1},
		{"2025.01.15", "2025.01.15.232917", -1},
		{"2025.01.15.232917", "2025.01.15", 1},
		{"", "2025.01.15", -1},
		{"2025.01.15-nightly", "2025.01.15", 0},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("%q vs %q: got %d want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestParseChecksumsHandlesBinaryMarkersAndNoise(t *testing.T) {
	got := ParseChecksums("ABC123  yt-dlp.exe\ndef456 *yt-dlp_linux\nnot a valid line\n\n")
	if got["yt-dlp.exe"] != "abc123" || got["yt-dlp_linux"] != "def456" || len(got) != 2 {
		t.Fatalf("%v", got)
	}
}

func TestRequireGitHubOnlyAllowsHTTPSGitHubHosts(t *testing.T) {
	ok := []string{"https://github.com/yt-dlp/yt-dlp/releases/download/x/y", "https://api.github.com/repos/a/b", "https://objects.githubusercontent.com/x"}
	bad := []string{"http://github.com/x", "https://evil.example.com/yt-dlp.exe", "https://github.com.evil.com/x", "ftp://github.com/x"}
	for _, raw := range ok {
		u, _ := url.Parse(raw)
		if err := requireGitHub(u); err != nil {
			t.Errorf("%s rejected: %v", raw, err)
		}
	}
	for _, raw := range bad {
		u, _ := url.Parse(raw)
		if err := requireGitHub(u); err == nil {
			t.Errorf("%s accepted", raw)
		}
	}
}

type fakeRelease struct {
	tag      string
	binary   []byte
	sums     string
	hits     atomic.Int32
	noSums   bool
	redirect string
}

func (f *fakeRelease) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		assets := fmt.Sprintf(`{"name":"asset.bin","browser_download_url":"%s/dl/asset.bin"}`, srv.URL)
		if !f.noSums {
			assets += fmt.Sprintf(`,{"name":"SHA2-256SUMS","browser_download_url":"%s/dl/sums"}`, srv.URL)
		}
		fmt.Fprintf(w, `{"tag_name":%q,"assets":[%s]}`, f.tag, assets)
	})
	mux.HandleFunc("/dl/asset.bin", func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		if f.redirect != "" {
			http.Redirect(w, r, f.redirect, http.StatusFound)
			return
		}
		w.Write(f.binary)
	})
	mux.HandleFunc("/dl/sums", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(f.sums))
	})
	srv = httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func sumLine(data []byte, name string) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:]) + "  " + name + "\n"
}

func testManager(t *testing.T, srv *httptest.Server, version string) *Manager {
	t.Helper()
	m := New(filepath.Join(t.TempDir(), "tools"))
	m.APIBase = srv.URL
	m.Client = srv.Client()
	m.AssetName = func() string { return "asset.bin" }
	m.ValidateURL = func(*url.URL) error { return nil }
	m.LookPath = func(string) (string, error) { return "", errors.New("not on PATH") }
	m.RunVersion = func(ctx context.Context, path string) (string, error) {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		if strings.HasPrefix(string(data), "BROKEN") {
			return "", errors.New("exec format error")
		}
		return version + strings.TrimSpace(strings.TrimPrefix(string(data), "VERSION")), nil
	}
	return m
}

func TestInstallDownloadsVerifiesAndReportsTheVersion(t *testing.T) {
	bin := []byte("VERSION")
	f := &fakeRelease{tag: "2026.02.01", binary: bin}
	f.sums = sumLine(bin, "asset.bin")
	m := testManager(t, f.server(t), "v")
	if st := m.Refresh(context.Background()); st.Source != SourceMissing {
		t.Fatalf("fresh manager should find nothing: %+v", st)
	}
	st, err := m.Install(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Source != SourceManaged || st.Version != "v" || st.Busy != "" || st.Error != "" {
		t.Fatalf("%+v", st)
	}
	if _, err := os.Stat(m.managedPath()); err != nil {
		t.Fatalf("binary not installed: %v", err)
	}
	left, _ := filepath.Glob(filepath.Join(m.Dir, ".yt-dlp-*"))
	if len(left) != 0 {
		t.Fatalf("temp files left: %v", left)
	}
}

func TestInstallRejectsAChecksumMismatchAndKeepsTheOldBinary(t *testing.T) {
	f := &fakeRelease{tag: "2026.02.01", binary: []byte("VERSION-new")}
	f.sums = sumLine([]byte("something else"), "asset.bin")
	m := testManager(t, f.server(t), "v")
	os.MkdirAll(m.Dir, 0o755)
	os.WriteFile(m.managedPath(), []byte("VERSION-old"), 0o755)
	st, err := m.Install(context.Background())
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("want checksum error, got %v", err)
	}
	if !strings.Contains(st.Error, "install failed") {
		t.Fatalf("status should explain: %+v", st)
	}
	data, _ := os.ReadFile(m.managedPath())
	if string(data) != "VERSION-old" {
		t.Fatalf("old binary was replaced: %q", data)
	}
}

func TestInstallRefusesABinaryThatDoesNotRun(t *testing.T) {
	bin := []byte("BROKEN")
	f := &fakeRelease{tag: "2026.02.01", binary: bin}
	f.sums = sumLine(bin, "asset.bin")
	m := testManager(t, f.server(t), "v")
	if _, err := m.Install(context.Background()); err == nil || !strings.Contains(err.Error(), "does not run") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(m.managedPath()); err == nil {
		t.Fatal("a broken binary must not be installed")
	}
}

func TestInstallNeedsAChecksumFile(t *testing.T) {
	f := &fakeRelease{tag: "2026.02.01", binary: []byte("VERSION"), noSums: true}
	m := testManager(t, f.server(t), "v")
	if _, err := m.Install(context.Background()); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("got %v", err)
	}
}

func TestInstallRefusesRedirectsToOtherHosts(t *testing.T) {
	bin := []byte("VERSION")
	f := &fakeRelease{tag: "2026.02.01", binary: bin, redirect: "https://evil.example.com/yt-dlp.exe"}
	f.sums = sumLine(bin, "asset.bin")
	m := testManager(t, f.server(t), "v")
	m.ValidateURL = func(u *url.URL) error {
		if u.Hostname() != "127.0.0.1" {
			return fmt.Errorf("refusing %s", u.Hostname())
		}
		return nil
	}
	if _, err := m.Install(context.Background()); err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("got %v", err)
	}
}

func TestInstallReplacesAnExistingBinaryAndLeavesNoOldFile(t *testing.T) {
	bin := []byte("VERSION")
	f := &fakeRelease{tag: "2026.02.01", binary: bin}
	f.sums = sumLine(bin, "asset.bin")
	m := testManager(t, f.server(t), "v")
	os.MkdirAll(m.Dir, 0o755)
	os.WriteFile(m.managedPath(), []byte("VERSION-old"), 0o755)
	if _, err := m.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(m.managedPath())
	if string(data) != "VERSION" {
		t.Fatalf("not replaced: %q", data)
	}
	if _, err := os.Stat(m.managedPath() + ".old"); err == nil {
		t.Fatal(".old file left behind")
	}
}

func TestCheckFlagsAvailableUpdatesOnlyWhenNewer(t *testing.T) {
	f := &fakeRelease{tag: "2026.02.01"}
	m := testManager(t, f.server(t), "2026.01.01")
	os.MkdirAll(m.Dir, 0o755)
	os.WriteFile(m.managedPath(), []byte("VERSION"), 0o755)
	st, err := m.Check(context.Background())
	if err != nil || !st.UpdateAvailable || st.Latest != "2026.02.01" || st.CheckedAt == 0 {
		t.Fatalf("%+v %v", st, err)
	}
	m.RunVersion = func(context.Context, string) (string, error) { return "2026.02.01", nil }
	st, _ = m.Check(context.Background())
	if st.UpdateAvailable {
		t.Fatalf("an up to date install must not flag an update: %+v", st)
	}
}

func TestCheckFailureIsReportedWithoutLosingTheInstalledVersion(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Error(w, "nope", 500) }))
	defer srv.Close()
	m := testManager(t, srv, "2026.01.01")
	os.MkdirAll(m.Dir, 0o755)
	os.WriteFile(m.managedPath(), []byte("VERSION"), 0o755)
	st, err := m.Check(context.Background())
	if err == nil || st.Version != "2026.01.01" || !strings.Contains(st.Error, "could not check") {
		t.Fatalf("%+v %v", st, err)
	}
}

func TestLocatePrefersTheManagedCopyOverPath(t *testing.T) {
	m := New(t.TempDir())
	m.LookPath = func(string) (string, error) { return "/usr/bin/yt-dlp", nil }
	if p, src := m.Locate(); src != SourcePath || p != "/usr/bin/yt-dlp" {
		t.Fatalf("%s %s", p, src)
	}
	os.WriteFile(m.managedPath(), []byte("x"), 0o755)
	if _, src := m.Locate(); src != SourceManaged {
		t.Fatalf("managed copy should win, got %s", src)
	}
}

func TestStatusCallbacksFire(t *testing.T) {
	bin := []byte("VERSION")
	f := &fakeRelease{tag: "2026.02.01", binary: bin}
	f.sums = sumLine(bin, "asset.bin")
	m := testManager(t, f.server(t), "v")
	var busy []string
	m.OnStatus = func(s YtDlpStatus) { busy = append(busy, s.Busy) }
	if _, err := m.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(busy) == 0 || busy[0] != "installing" {
		t.Fatalf("busy sequence %v", busy)
	}
}

func TestOnlyOneInstallRunsAtATime(t *testing.T) {
	m := New(t.TempDir())
	m.busy = true
	if _, err := m.Install(context.Background()); err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatalf("got %v", err)
	}
}
