package update

import (
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
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	Repository  = "devs-des1re/practice-music"
	FeedURL     = "https://api.github.com/repos/" + Repository + "/releases?per_page=30"
	PagePrefix  = "https://github.com/" + Repository + "/releases/"
	AssetPrefix = PagePrefix + "download/"

	maxFeedBytes  = 4 << 20
	maxAssetBytes = 500 << 20
	maxNotes      = 4000
)

var assetName = regexp.MustCompile(`^practicemusic[-_][0-9A-Za-z._~-]+\.(exe|dmg|deb|rpm)$`)

type System struct {
	OS     string
	Arch   string
	Family string
}

func (s System) suffix() string {
	switch {
	case s.OS == "windows" && s.Arch == "amd64":
		return "-windows-amd64-setup.exe"
	case s.OS == "darwin":
		return "-darwin-universal.dmg"
	case s.OS == "linux" && s.Arch == "amd64" && s.Family == "deb":
		return "_amd64.deb"
	case s.OS == "linux" && s.Arch == "amd64" && s.Family == "rpm":
		return ".x86_64.rpm"
	}
	return ""
}

type Asset struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
}

type release struct {
	Tag    string  `json:"tag_name"`
	Notes  string  `json:"body"`
	Page   string  `json:"html_url"`
	Draft  bool    `json:"draft"`
	Assets []Asset `json:"assets"`
}

type Found struct {
	Version   string
	Notes     string
	Page      string
	Installer *Asset
}

type Client struct {
	Feed    string
	HTTP    *http.Client
	Allowed func(*url.URL) error
	Assets  string
	Pages   string
}

func NewClient() *Client {
	c := &Client{Feed: FeedURL, Allowed: requireGitHub, Assets: AssetPrefix, Pages: PagePrefix}
	c.HTTP = &http.Client{
		Timeout: 30 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("GitHub redirected too many times")
			}
			return c.Allowed(req.URL)
		},
	}
	return c
}

func requireGitHub(u *url.URL) error {
	hosts := []string{"api.github.com", "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"}
	if u.Scheme != "https" || !slices.Contains(hosts, u.Host) {
		return fmt.Errorf("updates are only fetched from GitHub, not %s", u.Host)
	}
	return nil
}

func (c *Client) get(ctx context.Context, address, accept string) (*http.Response, error) {
	parsed, err := url.Parse(address)
	if err != nil {
		return nil, err
	}
	if err := c.Allowed(parsed); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "PracticeMusic")
	req.Header.Set("Accept", accept)
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GitHub could not be reached: %w", err)
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("GitHub answered %s", res.Status)
	}
	return res, nil
}

func (c *Client) Newest(ctx context.Context, current string, system System) (*Found, error) {
	running, ok := ParseVersion(current)
	if !ok {
		return nil, fmt.Errorf("this build has no usable version number (%q)", current)
	}
	res, err := c.get(ctx, c.Feed, "application/vnd.github+json")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var releases []release
	if err := json.NewDecoder(io.LimitReader(res.Body, maxFeedBytes)).Decode(&releases); err != nil {
		return nil, fmt.Errorf("the release list could not be read: %w", err)
	}
	best := running
	var chosen *release
	for i := range releases {
		v, ok := ParseVersion(releases[i].Tag)
		if releases[i].Draft || !ok || Compare(v, best) <= 0 {
			continue
		}
		best, chosen = v, &releases[i]
	}
	if chosen == nil {
		return nil, nil
	}
	found := &Found{Version: best.String(), Notes: chosen.Notes}
	if len(found.Notes) > maxNotes {
		found.Notes = strings.ToValidUTF8(found.Notes[:maxNotes], "")
	}
	if strings.HasPrefix(chosen.Page, c.Pages) {
		found.Page = chosen.Page
	}
	suffix := system.suffix()
	for _, asset := range chosen.Assets {
		if suffix != "" && strings.HasSuffix(asset.Name, suffix) && c.check(asset) == nil {
			found.Installer = &asset
			break
		}
	}
	return found, nil
}

func (c *Client) check(asset Asset) error {
	if !assetName.MatchString(asset.Name) || filepath.Base(asset.Name) != asset.Name {
		return fmt.Errorf("the file name %q is not an installer of this app", asset.Name)
	}
	if !strings.HasPrefix(asset.URL, c.Assets) || strings.Contains(asset.URL, "..") {
		return errors.New("the installer is not a file of this app's releases")
	}
	if asset.Size <= 0 || asset.Size > maxAssetBytes {
		return fmt.Errorf("the installer size %d is not believable", asset.Size)
	}
	sum, ok := strings.CutPrefix(asset.Digest, "sha256:")
	if raw, err := hex.DecodeString(sum); !ok || err != nil || len(raw) != sha256.Size {
		return errors.New("GitHub gave no SHA-256 for the installer, so it cannot be checked")
	}
	return nil
}

func Verify(path string, asset Asset) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return err
	}
	if size != asset.Size || "sha256:"+hex.EncodeToString(hash.Sum(nil)) != strings.ToLower(asset.Digest) {
		return errors.New("the downloaded installer does not match GitHub's SHA-256")
	}
	return nil
}

type counter struct {
	done   int64
	report func(int64)
	last   time.Time
}

func (c *counter) Write(p []byte) (int, error) {
	c.done += int64(len(p))
	if time.Since(c.last) >= 200*time.Millisecond {
		c.last = time.Now()
		c.report(c.done)
	}
	return len(p), nil
}

func (c *Client) Download(ctx context.Context, asset Asset, dir string, report func(done int64)) (string, error) {
	if err := c.check(asset); err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	target := filepath.Join(dir, asset.Name)
	if Verify(target, asset) == nil {
		return target, nil
	}
	res, err := c.get(ctx, asset.URL, "application/octet-stream")
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	part := target + ".part"
	file, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return "", err
	}
	_, err = io.Copy(file, io.TeeReader(io.LimitReader(res.Body, asset.Size+1), &counter{report: report}))
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = Verify(part, asset)
	}
	if err == nil {
		_ = os.Remove(target)
		err = os.Rename(part, target)
	}
	if err != nil {
		_ = os.Remove(part)
		return "", err
	}
	return target, nil
}
