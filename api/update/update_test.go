package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustVersion(t *testing.T, text string) Version {
	t.Helper()
	v, ok := ParseVersion(text)
	if !ok {
		t.Fatalf("%q did not parse", text)
	}
	return v
}

func TestVersionsAreOrderedAsSemanticVersions(t *testing.T) {
	ordered := []string{
		"0.1.0-alpha.1", "0.1.0-alpha.3", "0.1.0-alpha.10", "0.1.0-beta", "0.1.0-beta.2",
		"0.1.0", "0.1.1-alpha.1", "0.2.0", "1.0.0",
	}
	for i := 1; i < len(ordered); i++ {
		low, high := mustVersion(t, ordered[i-1]), mustVersion(t, "v"+ordered[i])
		if Compare(low, high) >= 0 || Compare(high, low) <= 0 {
			t.Fatalf("%s should come before %s", ordered[i-1], ordered[i])
		}
	}
	if Compare(mustVersion(t, "v1.2.3+build.5"), mustVersion(t, "1.2.3")) != 0 {
		t.Fatal("build metadata does not change the order")
	}
	for _, bad := range []string{"", "latest", "1.2", "1.2.x", "1.2.3-", "1.2.3-a..b", "1.2.3-../x", "-1.2.3"} {
		if _, ok := ParseVersion(bad); ok {
			t.Fatalf("%q should not parse", bad)
		}
	}
}

type rig struct {
	client *Client
	body   []byte
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func newRig(t *testing.T, releases func(base string, body []byte) []release) rig {
	t.Helper()
	body := []byte(strings.Repeat("installer ", 4000))
	var base string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/feed" {
			_ = json.NewEncoder(w).Encode(releases(base, body))
			return
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(server.Close)
	base = server.URL
	return rig{
		body: body,
		client: &Client{
			Feed:    base + "/feed",
			HTTP:    server.Client(),
			Allowed: func(*url.URL) error { return nil },
			Assets:  base + "/download/",
			Pages:   base + "/",
		},
	}
}

func windowsRelease(base, tag string, body []byte) release {
	name := "practicemusic-" + strings.TrimPrefix(tag, "v") + "-windows-amd64-setup.exe"
	return release{
		Tag:  tag,
		Page: base + "/tag/" + tag,
		Assets: []Asset{{
			Name: name, Size: int64(len(body)), URL: base + "/download/" + tag + "/" + name, Digest: digest(body),
		}},
	}
}

var windows = System{OS: "windows", Arch: "amd64"}

func TestTheNewestPublishedReleaseIsOffered(t *testing.T) {
	r := newRig(t, func(base string, body []byte) []release {
		draft := windowsRelease(base, "v0.9.0", body)
		draft.Draft = true
		return []release{
			windowsRelease(base, "v0.1.0-alpha.4", body),
			windowsRelease(base, "v0.1.0-alpha.10", body),
			windowsRelease(base, "nightly", body),
			draft,
		}
	})
	found, err := r.client.Newest(context.Background(), "0.1.0-alpha.3", windows)
	if err != nil || found == nil {
		t.Fatalf("%v %v", found, err)
	}
	if found.Version != "0.1.0-alpha.10" || found.Installer == nil || !strings.HasSuffix(found.Page, "/tag/v0.1.0-alpha.10") {
		t.Fatalf("%+v", found)
	}
	for _, current := range []string{"0.1.0-alpha.10", "0.1.0"} {
		if again, err := r.client.Newest(context.Background(), current, windows); err != nil || again != nil {
			t.Fatalf("%s: %v %v", current, again, err)
		}
	}
}

func TestEachSystemGetsItsOwnInstaller(t *testing.T) {
	names := []string{
		"practicemusic-0.2.0-darwin-universal.dmg",
		"practicemusic-0.2.0-windows-amd64-setup.exe",
		"practicemusic-0.2.0-1.x86_64.rpm",
		"practicemusic_0.2.0_amd64.deb",
	}
	r := newRig(t, func(base string, body []byte) []release {
		out := release{Tag: "v0.2.0"}
		for _, name := range names {
			out.Assets = append(out.Assets, Asset{Name: name, Size: 10, URL: base + "/download/" + name, Digest: digest(body)})
		}
		return []release{out}
	})
	cases := map[System]string{
		{OS: "darwin", Arch: "arm64"}: names[0],
		windows:                       names[1],
		{OS: "linux", Arch: "amd64", Family: "rpm"}: names[2],
		{OS: "linux", Arch: "amd64", Family: "deb"}: names[3],
		{OS: "linux", Arch: "amd64"}:                "",
		{OS: "windows", Arch: "arm64"}:              "",
		{OS: "linux", Arch: "arm64", Family: "deb"}: "",
	}
	for system, want := range cases {
		found, err := r.client.Newest(context.Background(), "0.1.0", system)
		if err != nil || found == nil {
			t.Fatalf("%v %v", found, err)
		}
		got := ""
		if found.Installer != nil {
			got = found.Installer.Name
		}
		if got != want {
			t.Fatalf("%+v: got %q, want %q", system, got, want)
		}
	}
}

func TestAnInstallerThatCannotBeTrustedIsNotOffered(t *testing.T) {
	changes := map[string]func(*Asset){
		"no digest":     func(a *Asset) { a.Digest = "" },
		"short digest":  func(a *Asset) { a.Digest = "sha256:abcd" },
		"other website": func(a *Asset) { a.URL = "https://example.com/" + a.Name },
		"climbing name": func(a *Asset) { a.Name = "../practicemusic-0.2.0-windows-amd64-setup.exe" },
		"other program": func(a *Asset) { a.Name = "tool-0.2.0-windows-amd64-setup.exe" },
		"no size":       func(a *Asset) { a.Size = 0 },
		"absurd size":   func(a *Asset) { a.Size = maxAssetBytes + 1 },
		"climbing path": func(a *Asset) { a.URL = strings.Replace(a.URL, "/download/", "/download/../", 1) },
	}
	for label, change := range changes {
		r := newRig(t, func(base string, body []byte) []release {
			out := windowsRelease(base, "v0.2.0", body)
			change(&out.Assets[0])
			return []release{out}
		})
		found, err := r.client.Newest(context.Background(), "0.1.0", windows)
		if err != nil || found == nil || found.Installer != nil {
			t.Fatalf("%s: %+v %v", label, found, err)
		}
	}
}

func TestDownloadsAreCheckedBeforeTheyAreKept(t *testing.T) {
	r := newRig(t, func(base string, body []byte) []release { return []release{windowsRelease(base, "v0.2.0", body)} })
	found, err := r.client.Newest(context.Background(), "0.1.0", windows)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(t.TempDir(), "updates")
	path, err := r.client.Download(context.Background(), *found.Installer, dir, func(int64) {})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(path); string(got) != string(r.body) {
		t.Fatal("the installer was not saved whole")
	}
	wrong := map[string]Asset{}
	changed := *found.Installer
	changed.Digest = digest([]byte("something else"))
	wrong["digest"] = changed
	short := *found.Installer
	short.Size--
	wrong["longer than announced"] = short
	long := *found.Installer
	long.Size++
	wrong["shorter than announced"] = long
	for label, asset := range wrong {
		target := filepath.Join(t.TempDir(), "updates")
		if _, err := r.client.Download(context.Background(), asset, target, func(int64) {}); err == nil {
			t.Fatalf("%s: a wrong file must be refused", label)
		}
		if left, _ := os.ReadDir(target); len(left) != 0 {
			t.Fatalf("%s: a refused download left %v behind", label, left)
		}
	}
}

func TestOnlyGitHubIsContacted(t *testing.T) {
	for _, address := range []string{"http://github.com/x", "https://github.com.example.com/x", "https://example.com/x"} {
		u, _ := url.Parse(address)
		if requireGitHub(u) == nil {
			t.Fatalf("%s must be refused", address)
		}
	}
	u, _ := url.Parse("https://release-assets.githubusercontent.com/x")
	if err := requireGitHub(u); err != nil {
		t.Fatal(err)
	}
}

func TestTheLinuxPackageKindFollowsTheDistribution(t *testing.T) {
	has := func(wanted string) func(string) bool { return func(path string) bool { return path == wanted } }
	if linuxFamily(has("/etc/debian_version")) != "deb" || linuxFamily(has("/etc/fedora-release")) != "rpm" {
		t.Fatal("known distributions must be recognised")
	}
	if linuxFamily(has("/etc/arch-release")) != "" {
		t.Fatal("an unknown distribution gets no installer")
	}
}
