package kit

import (
	"archive/zip"
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
	"slices"
	"strings"
	"time"

	"practice-music/api/drums"
)

const (
	Name    = "MuldjordKit"
	Credit  = "Drum recordings: MuldjordKit by Lars Muldjord (drumgizmo.org). SFZ edition by kinwie."
	License = "Creative Commons Attribution 4.0 (CC BY 4.0)"
	Source  = "https://github.com/sfzinstruments/DrumGizmo.MuldjordKit"
	Commit  = "fc165714974aa843125ce88597f341b31376e1d5"

	ArchiveURL     = "https://codeload.github.com/sfzinstruments/DrumGizmo.MuldjordKit/zip/" + Commit
	ArchiveBytes   = 346255411
	InstalledBytes = 146651146

	contentDigest = "af11323a8babca407585344f91fa7d22600385b212612294b42f55550628794d"
	samplesPrefix = "DrumGizmo/MuldjordKit/Samples/"

	maxArchiveBytes = 420 << 20
	maxFileBytes    = 8 << 20
	markerName      = "installed.json"
	stagingPattern  = ".muldjord-*"
)

const (
	PhaseDownloading = "downloading"
	PhaseUnpacking   = "unpacking"
)

type Progress struct {
	Phase string `json:"phase"`
	Done  int64  `json:"done"`
	Total int64  `json:"total"`
}

type marker struct {
	Commit string `json:"commit"`
	Digest string `json:"digest"`
}

type Installer struct {
	Dir          string
	URL          string
	Archive      string
	Files        []string
	Digest       string
	ArchiveBytes int64
	Client       *http.Client
	ValidateURL  func(*url.URL) error
	OnProgress   func(Progress)
}

func New(dir string) *Installer {
	return &Installer{
		Dir:          dir,
		URL:          ArchiveURL,
		Files:        drums.KitFiles(),
		Digest:       contentDigest,
		ArchiveBytes: ArchiveBytes,
		Client:       &http.Client{Timeout: 30 * time.Minute},
		ValidateURL:  requireGitHub,
	}
}

func requireGitHub(u *url.URL) error {
	host := strings.ToLower(u.Hostname())
	if u.Scheme != "https" || (host != "codeload.github.com" && host != "github.com") {
		return fmt.Errorf("refusing to download from %s", u.Redacted())
	}
	return nil
}

func (i *Installer) Root() string {
	return filepath.Join(i.Dir, "Samples")
}

func (i *Installer) Installed() bool {
	data, err := os.ReadFile(filepath.Join(i.Dir, markerName))
	if err != nil {
		return false
	}
	var found marker
	if json.Unmarshal(data, &found) != nil || found.Digest != i.Digest {
		return false
	}
	info, err := os.Stat(i.Root())
	return err == nil && info.IsDir()
}

func (i *Installer) Remove() error {
	if err := os.Remove(filepath.Join(i.Dir, markerName)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.RemoveAll(i.Dir)
}

func (i *Installer) report(phase string, done, total int64) {
	if i.OnProgress != nil {
		i.OnProgress(Progress{Phase: phase, Done: done, Total: total})
	}
}

func (i *Installer) clearLeftovers() {
	found, err := filepath.Glob(filepath.Join(filepath.Dir(i.Dir), stagingPattern))
	if err != nil {
		return
	}
	for _, path := range found {
		_ = os.RemoveAll(path)
	}
}

type counter struct {
	ctx    context.Context
	reader io.Reader
	done   int64
	last   time.Time
	notify func(int64)
}

func (c *counter) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := c.reader.Read(p)
	c.done += int64(n)
	if time.Since(c.last) >= 200*time.Millisecond || err != nil {
		c.last = time.Now()
		c.notify(c.done)
	}
	return n, err
}

func (i *Installer) download(ctx context.Context, target string) error {
	u, err := url.Parse(i.URL)
	if err != nil {
		return err
	}
	if err := i.ValidateURL(u); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, i.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "PracticeMusic")
	client := *i.Client
	client.CheckRedirect = func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return errors.New("too many redirects")
		}
		return i.ValidateURL(r.URL)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned %s", resp.Status)
	}
	total := resp.ContentLength
	if total <= 0 {
		total = i.ArchiveBytes
	}
	out, err := os.Create(target)
	if err != nil {
		return err
	}
	body := &counter{ctx: ctx, reader: io.LimitReader(resp.Body, maxArchiveBytes+1), notify: func(done int64) {
		i.report(PhaseDownloading, done, total)
	}}
	written, err := io.Copy(out, body)
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if written > maxArchiveBytes {
		return errors.New("download is larger than expected")
	}
	return nil
}

func insideRoot(name string) string {
	_, rest, found := strings.Cut(name, "/")
	if !found {
		return ""
	}
	return rest
}

func readEntry(entry *zip.File) ([]byte, error) {
	in, err := entry.Open()
	if err != nil {
		return nil, err
	}
	defer in.Close()
	data, err := io.ReadAll(io.LimitReader(in, maxFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxFileBytes {
		return nil, fmt.Errorf("%s is larger than expected", entry.Name)
	}
	return data, nil
}

func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func (i *Installer) unpack(ctx context.Context, archive, target string) error {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return fmt.Errorf("the download is not a usable archive: %w", err)
	}
	defer reader.Close()
	entries := map[string]*zip.File{}
	for _, entry := range reader.File {
		if name := insideRoot(entry.Name); name != "" {
			entries[name] = entry
		}
	}
	files := slices.Clone(i.Files)
	slices.Sort(files)
	digest := sha256.New()
	for n, name := range files {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !filepath.IsLocal(filepath.FromSlash(name)) {
			return fmt.Errorf("unsafe file name %s", name)
		}
		entry, ok := entries[samplesPrefix+name]
		if !ok {
			return fmt.Errorf("the download is missing %s", name)
		}
		data, err := readEntry(entry)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		fmt.Fprintf(digest, "%s\n%s\n", name, hex.EncodeToString(sum[:]))
		if err := writeFile(filepath.Join(target, "Samples", filepath.FromSlash(name)), data); err != nil {
			return err
		}
		if n%25 == 0 || n == len(files)-1 {
			i.report(PhaseUnpacking, int64(n+1), int64(len(files)))
		}
	}
	if hex.EncodeToString(digest.Sum(nil)) != i.Digest {
		return errors.New("the recordings do not match the expected kit, so nothing was installed")
	}
	for _, name := range []string{"LICENSE", "README.md"} {
		if entry, ok := entries[name]; ok {
			data, err := readEntry(entry)
			if err != nil {
				return err
			}
			if err := writeFile(filepath.Join(target, name), data); err != nil {
				return err
			}
		}
	}
	attribution := strings.Join([]string{Credit, "Licence: " + License, "Source: " + Source + " (commit " + Commit + ")",
		"PracticeMusic mixes the microphone recordings of each hit into one stereo sound when it loads them.", ""}, "\n")
	return writeFile(filepath.Join(target, "ATTRIBUTION.txt"), []byte(attribution))
}

func (i *Installer) Install(ctx context.Context) error {
	parent := filepath.Dir(i.Dir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	i.clearLeftovers()
	staging, err := os.MkdirTemp(parent, stagingPattern)
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	archive := i.Archive
	if archive == "" {
		archive = filepath.Join(staging, "kit.zip")
		if err := i.download(ctx, archive); err != nil {
			return err
		}
	}
	unpacked := filepath.Join(staging, "kit")
	if err := i.unpack(ctx, archive, unpacked); err != nil {
		return err
	}
	data, err := json.Marshal(marker{Commit: Commit, Digest: i.Digest})
	if err != nil {
		return err
	}
	if err := writeFile(filepath.Join(unpacked, markerName), data); err != nil {
		return err
	}
	if err := i.Remove(); err != nil {
		return fmt.Errorf("the old copy of the kit could not be replaced: %w", err)
	}
	return os.Rename(unpacked, i.Dir)
}
