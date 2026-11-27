package kit

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
)

var wanted = map[string]string{
	"Snare/1-Snare-OHL.flac": "left",
	"Tom1/1-Tom1-Tom1.flac":  "tom",
}

func archive(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range files {
		f, err := w.Create("kit-abc123/" + name)
		if err != nil {
			t.Fatal(err)
		}
		f.Write([]byte(body))
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func fullArchive(t *testing.T) []byte {
	files := map[string]string{"LICENSE": "licence text", "README.md": "read me", "Other/skip.bin": "unused", samplesPrefix + "Snare/99-extra.flac": "unused"}
	for name, body := range wanted {
		files[samplesPrefix+name] = body
	}
	return archive(t, files)
}

func digestOf(files map[string]string, order ...string) string {
	h := sha256.New()
	for _, name := range order {
		sum := sha256.Sum256([]byte(files[name]))
		fmt.Fprintf(h, "%s\n%s\n", name, hex.EncodeToString(sum[:]))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func installer(t *testing.T, body []byte) (*Installer, *int) {
	t.Helper()
	hits := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Write(body)
	}))
	t.Cleanup(server.Close)
	i := New(filepath.Join(t.TempDir(), "kits", "muldjord"))
	i.URL = server.URL
	i.ValidateURL = func(*url.URL) error { return nil }
	i.Files = []string{"Tom1/1-Tom1-Tom1.flac", "Snare/1-Snare-OHL.flac"}
	i.Digest = digestOf(wanted, "Snare/1-Snare-OHL.flac", "Tom1/1-Tom1-Tom1.flac")
	return i, &hits
}

func leftovers(t *testing.T, i *Installer) []string {
	t.Helper()
	found, err := filepath.Glob(filepath.Join(filepath.Dir(i.Dir), stagingPattern))
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func TestNothingIsDownloadedUntilInstallIsAsked(t *testing.T) {
	i, hits := installer(t, fullArchive(t))
	if i.Installed() || *hits != 0 {
		t.Fatal("creating the installer must not touch the network or claim a kit")
	}
	if _, err := os.Stat(filepath.Dir(i.Dir)); err == nil {
		t.Fatal("no folder should be made before installing")
	}
}

func TestInstallKeepsOnlyTheNeededRecordingsAndTheCredit(t *testing.T) {
	i, hits := installer(t, fullArchive(t))
	var phases []string
	i.OnProgress = func(p Progress) {
		if len(phases) == 0 || phases[len(phases)-1] != p.Phase {
			phases = append(phases, p.Phase)
		}
	}
	if err := i.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !i.Installed() || *hits != 1 {
		t.Fatalf("installed=%v hits=%d", i.Installed(), *hits)
	}
	for name, body := range wanted {
		got, err := os.ReadFile(filepath.Join(i.Root(), filepath.FromSlash(name)))
		if err != nil || string(got) != body {
			t.Fatalf("%s: %q %v", name, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(i.Root(), "Snare", "99-extra.flac")); err == nil {
		t.Fatal("unused recordings must not be kept")
	}
	credit, err := os.ReadFile(filepath.Join(i.Dir, "ATTRIBUTION.txt"))
	if err != nil || !bytes.Contains(credit, []byte("Lars Muldjord")) || !bytes.Contains(credit, []byte("CC BY 4.0")) {
		t.Fatalf("credit: %s %v", credit, err)
	}
	if _, err := os.Stat(filepath.Join(i.Dir, "LICENSE")); err != nil {
		t.Fatal("the licence must travel with the recordings")
	}
	if len(leftovers(t, i)) != 0 {
		t.Fatal("temporary files were left behind")
	}
	if fmt.Sprint(phases) != "[downloading unpacking]" {
		t.Fatalf("phases %v", phases)
	}
	if err := i.Remove(); err != nil || i.Installed() {
		t.Fatalf("remove: %v", err)
	}
	if _, err := os.Stat(i.Dir); err == nil {
		t.Fatal("the kit folder is still there")
	}
}

func TestAChangedRecordingIsRefused(t *testing.T) {
	files := map[string]string{samplesPrefix + "Snare/1-Snare-OHL.flac": "tampered", samplesPrefix + "Tom1/1-Tom1-Tom1.flac": "tom"}
	i, _ := installer(t, archive(t, files))
	err := i.Install(context.Background())
	if err == nil || i.Installed() {
		t.Fatalf("expected refusal, got %v", err)
	}
	if _, statErr := os.Stat(i.Dir); statErr == nil || len(leftovers(t, i)) != 0 {
		t.Fatal("nothing may be left behind")
	}
}

func TestAMissingRecordingAndABrokenArchiveFail(t *testing.T) {
	i, _ := installer(t, archive(t, map[string]string{samplesPrefix + "Tom1/1-Tom1-Tom1.flac": "tom"}))
	if err := i.Install(context.Background()); err == nil {
		t.Fatal("a missing recording must fail")
	}
	i, _ = installer(t, []byte("not a zip"))
	if err := i.Install(context.Background()); err == nil {
		t.Fatal("a broken archive must fail")
	}
}

func TestCancellingLeavesNothingBehind(t *testing.T) {
	i, _ := installer(t, fullArchive(t))
	ctx, cancel := context.WithCancel(context.Background())
	i.OnProgress = func(Progress) { cancel() }
	if err := i.Install(ctx); err == nil || i.Installed() {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if len(leftovers(t, i)) != 0 {
		t.Fatal("temporary files were left behind")
	}
}

func TestOnlyGitHubOverHTTPSIsAccepted(t *testing.T) {
	for raw, ok := range map[string]bool{
		ArchiveURL:                           true,
		"http://codeload.github.com/x":       false,
		"https://codeload.github.com.evil/x": false,
		"https://example.com/kit.zip":        false,
	} {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := requireGitHub(u) == nil; got != ok {
			t.Fatalf("%s accepted=%v", raw, got)
		}
	}
}

func TestTheRealDownloadMatchesTheShippedFingerprint(t *testing.T) {
	path := os.Getenv("PM_KIT_ARCHIVE_TEST")
	if path == "" {
		t.Skip("set PM_KIT_ARCHIVE_TEST to a downloaded archive to run this")
	}
	i := New(filepath.Join(t.TempDir(), "kits", "muldjord"))
	i.Archive = path
	if err := i.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !i.Installed() {
		t.Fatal("not installed")
	}
}
