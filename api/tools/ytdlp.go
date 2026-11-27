package tools

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"practice-music/api/refusal"
)

const (
	DefaultAPIBase = "https://api.github.com/repos/yt-dlp/yt-dlp"
	maxBinaryBytes = 120 << 20
)

type Source string

const (
	SourceManaged Source = "managed"
	SourcePath    Source = "path"
	SourceMissing Source = "missing"
)

type YtDlpStatus struct {
	Source          Source `json:"source"`
	Path            string `json:"path"`
	Version         string `json:"version"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"updateAvailable"`
	Busy            string `json:"busy"`
	Error           string `json:"error"`
	CheckedAt       int64  `json:"checkedAt"`
}

type Manager struct {
	Dir         string
	Client      *http.Client
	APIBase     string
	AssetName   func() string
	ValidateURL func(*url.URL) error
	RunVersion  func(ctx context.Context, path string) (string, error)
	LookPath    func(string) (string, error)
	OnStatus    func(YtDlpStatus)
	Now         func() time.Time

	mu     sync.Mutex
	status YtDlpStatus
	busy   bool
}

func New(dir string) *Manager {
	return &Manager{
		Dir:         dir,
		Client:      &http.Client{Timeout: 5 * time.Minute},
		APIBase:     DefaultAPIBase,
		AssetName:   DefaultAssetName,
		ValidateURL: requireGitHub,
		RunVersion:  runVersion,
		LookPath:    exec.LookPath,
		Now:         time.Now,
	}
}

func DefaultAssetName() string {
	switch runtime.GOOS {
	case "windows":
		if runtime.GOARCH == "arm64" {
			return "yt-dlp_arm64.exe"
		}
		return "yt-dlp.exe"
	case "darwin":
		return "yt-dlp_macos"
	default:
		if runtime.GOARCH == "arm64" {
			return "yt-dlp_linux_aarch64"
		}
		return "yt-dlp_linux"
	}
}

func binaryName() string {
	if runtime.GOOS == "windows" {
		return "yt-dlp.exe"
	}
	return "yt-dlp"
}

func requireGitHub(u *url.URL) error {
	host := strings.ToLower(u.Hostname())
	ok := host == "github.com" || host == "api.github.com" || strings.HasSuffix(host, ".githubusercontent.com")
	if u.Scheme != "https" || !ok {
		return fmt.Errorf("refusing to download from %s", u.Redacted())
	}
	return nil
}

func runVersion(ctx context.Context, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "--version")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func (m *Manager) managedPath() string {
	return filepath.Join(m.Dir, binaryName())
}

func (m *Manager) Locate() (string, Source) {
	if info, err := os.Stat(m.managedPath()); err == nil && !info.IsDir() {
		return m.managedPath(), SourceManaged
	}
	if p, err := m.LookPath("yt-dlp"); err == nil {
		return p, SourcePath
	}
	return "", SourceMissing
}

func (m *Manager) Status() YtDlpStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.status
}

func (m *Manager) set(change func(*YtDlpStatus)) YtDlpStatus {
	m.mu.Lock()
	change(&m.status)
	st := m.status
	m.mu.Unlock()
	if m.OnStatus != nil {
		m.OnStatus(st)
	}
	return st
}

func (m *Manager) Refresh(ctx context.Context) YtDlpStatus {
	path, source := m.Locate()
	version := ""
	var verr error
	if path != "" {
		version, verr = m.RunVersion(ctx, path)
	}
	return m.set(func(s *YtDlpStatus) {
		s.Path = path
		s.Source = source
		s.Version = version
		s.UpdateAvailable = s.Latest != "" && version != "" && CompareVersions(version, s.Latest) < 0
		if verr != nil {
			s.Error = "yt-dlp did not start: " + verr.Error()
		} else if s.Busy == "" {
			s.Error = ""
		}
	})
}

type release struct {
	Tag    string `json:"tag_name"`
	Assets []struct {
		Name string `json:"name"`
		URL  string `json:"browser_download_url"`
		Size int64  `json:"size"`
	} `json:"assets"`
}

func (m *Manager) latest(ctx context.Context) (release, error) {
	var rel release
	target := strings.TrimRight(m.APIBase, "/") + "/releases/latest"
	u, err := url.Parse(target)
	if err != nil {
		return rel, err
	}
	if err := m.ValidateURL(u); err != nil {
		return rel, err
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "PracticeMusic")
	resp, err := m.Client.Do(req)
	if err != nil {
		return rel, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return rel, fmt.Errorf("release lookup returned %s", resp.Status)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(&rel); err != nil {
		return rel, fmt.Errorf("unreadable release data: %w", err)
	}
	if rel.Tag == "" {
		return rel, errors.New("release data had no version")
	}
	return rel, nil
}

func (m *Manager) Check(ctx context.Context) (YtDlpStatus, error) {
	m.Refresh(ctx)
	m.set(func(s *YtDlpStatus) { s.Busy = "checking" })
	rel, err := m.latest(ctx)
	st := m.set(func(s *YtDlpStatus) {
		s.Busy = ""
		s.CheckedAt = m.Now().UnixMilli()
		if err != nil {
			s.Error = "could not check for updates: " + err.Error()
			return
		}
		s.Error = ""
		s.Latest = rel.Tag
		s.UpdateAvailable = s.Version != "" && CompareVersions(s.Version, rel.Tag) < 0
	})
	return st, err
}

func (m *Manager) Install(ctx context.Context) (YtDlpStatus, error) {
	m.mu.Lock()
	if m.busy {
		m.mu.Unlock()
		return m.Status(), refusal.New("an install is already running")
	}
	m.busy = true
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.busy = false
		m.mu.Unlock()
	}()
	m.set(func(s *YtDlpStatus) { s.Busy = "installing"; s.Error = "" })
	err := m.install(ctx)
	if err != nil {
		st := m.set(func(s *YtDlpStatus) { s.Busy = ""; s.Error = "install failed: " + err.Error() })
		return st, err
	}
	m.set(func(s *YtDlpStatus) { s.Busy = "" })
	st := m.Refresh(ctx)
	return st, nil
}

func (m *Manager) fetch(ctx context.Context, rawURL string, limit int64, dst io.Writer) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return err
	}
	if err := m.ValidateURL(u); err != nil {
		return err
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	req.Header.Set("User-Agent", "PracticeMusic")
	client := *m.Client
	client.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return errors.New("too many redirects")
		}
		return m.ValidateURL(r.URL)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned %s", resp.Status)
	}
	n, err := io.Copy(dst, io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return err
	}
	if n > limit {
		return errors.New("download is larger than expected")
	}
	return nil
}

func ParseChecksums(data string) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(data))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) != 2 {
			continue
		}
		out[strings.TrimPrefix(fields[1], "*")] = strings.ToLower(fields[0])
	}
	return out
}

func (m *Manager) install(ctx context.Context) error {
	rel, err := m.latest(ctx)
	if err != nil {
		return err
	}
	assetName := m.AssetName()
	var assetURL, sumsURL string
	for _, a := range rel.Assets {
		switch a.Name {
		case assetName:
			assetURL = a.URL
		case "SHA2-256SUMS":
			sumsURL = a.URL
		}
	}
	if assetURL == "" {
		return fmt.Errorf("release %s has no %s download", rel.Tag, assetName)
	}
	if sumsURL == "" {
		return fmt.Errorf("release %s has no checksum file", rel.Tag)
	}
	var sums strings.Builder
	if err := m.fetch(ctx, sumsURL, 1<<20, &sums); err != nil {
		return fmt.Errorf("checksums: %w", err)
	}
	want, ok := ParseChecksums(sums.String())[assetName]
	if !ok {
		return fmt.Errorf("no checksum listed for %s", assetName)
	}
	if err := os.MkdirAll(m.Dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(m.Dir, ".yt-dlp-*.download")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := func() { tmp.Close(); os.Remove(tmpName) }
	hash := sha256.New()
	if err := m.fetch(ctx, assetURL, maxBinaryBytes, io.MultiWriter(tmp, hash)); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != want {
		os.Remove(tmpName)
		return fmt.Errorf("checksum mismatch for %s", assetName)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		os.Remove(tmpName)
		return err
	}
	if _, err := m.RunVersion(ctx, tmpName); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("the downloaded file does not run: %w", err)
	}
	return replaceFile(tmpName, m.managedPath())
}

func replaceFile(src, dst string) error {
	old := dst + ".old"
	_ = os.Remove(old)
	hadOld := false
	if _, err := os.Stat(dst); err == nil {
		if err := os.Rename(dst, old); err != nil {
			os.Remove(src)
			return fmt.Errorf("could not replace the current yt-dlp: %w", err)
		}
		hadOld = true
	}
	if err := os.Rename(src, dst); err != nil {
		if hadOld {
			_ = os.Rename(old, dst)
		}
		os.Remove(src)
		return err
	}
	if hadOld {
		_ = os.Remove(old)
	}
	return nil
}

func versionParts(v string) []int {
	var parts []int
	for _, p := range strings.FieldsFunc(v, func(r rune) bool { return r == '.' || r == '-' || r == '+' }) {
		n, err := strconv.Atoi(p)
		if err != nil {
			break
		}
		parts = append(parts, n)
	}
	return parts
}

func CompareVersions(a, b string) int {
	pa, pb := versionParts(a), versionParts(b)
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}
