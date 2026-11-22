package api

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"practice-music/api/downloads"
	"practice-music/api/library"
	"practice-music/api/logger"
	"practice-music/api/media"
	"practice-music/api/tools"
)

var (
	lib      *library.DB
	dl       *downloads.Manager
	tm       *tools.Manager
	thumbDir string
	toolsDir string
	importMu sync.Mutex
)

type libStore struct {
	db *library.DB
}

func (s libStore) Insert(data []byte) (int64, error)  { return s.db.InsertJob(data) }
func (s libStore) Update(id int64, data []byte) error { return s.db.UpdateJob(id, data) }
func (s libStore) Delete(id int64) error              { return s.db.DeleteJob(id) }
func (s libStore) All() ([]downloads.StoredJob, error) {
	rows, err := s.db.Jobs()
	if err != nil {
		return nil, err
	}
	out := make([]downloads.StoredJob, len(rows))
	for i, r := range rows {
		out[i] = downloads.StoredJob{ID: r.ID, Data: r.Data}
	}
	return out, nil
}

func errLibrary() error {
	return errors.New("the library database could not be opened")
}

func mediaTools() media.Tools {
	return media.LocateTools(toolsDir)
}

func libraryFolders() ([]string, bool, error) {
	doc, _, err := store.Load()
	if err != nil {
		return nil, false, err
	}
	return doc.Library.Folders, doc.Library.NormalizeOnImport, nil
}

func downloadDir() (string, error) {
	folders, _, err := libraryFolders()
	if err != nil {
		return "", err
	}
	if len(folders) == 0 {
		return "", errors.New("add a library folder in Settings first")
	}
	return folders[0], nil
}

func bootMedia(dir string) {
	toolsDir = filepath.Join(dir, "tools")
	thumbDir = filepath.Join(dir, "thumbs")
	tm = tools.New(toolsDir)
	tm.OnStatus = func(tools.YtDlpStatus) { publishTools() }
	db, err := library.Open(filepath.Join(dir, "library.db"))
	if err != nil {
		logger.Errorf("library database: %v", err)
		return
	}
	lib = db
	runner := &downloads.YtdlpRunner{
		Binary: func() (string, error) {
			path, _ := tm.Locate()
			if path == "" {
				return "", errors.New("yt-dlp is not installed. Install it from the Downloads page")
			}
			return path, nil
		},
		FFmpegDir: func() string {
			t := mediaTools()
			if t.FFmpeg == "" {
				return ""
			}
			return filepath.Dir(t.FFmpeg)
		},
		OutDir: downloadDir,
	}
	dl = downloads.NewManager(libStore{db}, runner, downloads.Options{
		Concurrency: 2,
		OnChange:    func(jobs []downloads.Job) { DownloadList.Set(jobs) },
		OnDone:      onDownloadDone,
	})
	if err := dl.Load(); err != nil {
		logger.Errorf("could not restore downloads: %v", err)
	}
	DownloadList.Set(dl.Jobs())
	go launchTasks()
}

func launchTasks() {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if _, err := rescan(); err != nil {
		logger.Warnf("initial library scan: %v", err)
	}
	tm.Refresh(ctx)
	st, err := tm.Check(ctx)
	if err != nil {
		logger.Warnf("yt-dlp update check: %v", err)
		return
	}
	doc, _, derr := store.Load()
	if derr != nil {
		return
	}
	if st.Source == tools.SourceManaged && st.UpdateAvailable && !doc.Library.DisableToolUpdates {
		logger.Infof("updating yt-dlp %s to %s", st.Version, st.Latest)
		if _, err := tm.Install(ctx); err != nil {
			logger.Warnf("yt-dlp update failed: %v", err)
		}
	}
}

func attachThumb(id int64) {
	song, err := lib.Get(id)
	if err != nil {
		return
	}
	t := mediaTools()
	if t.FFmpeg == "" {
		return
	}
	name, err := t.MakeThumb(song, thumbDir)
	if err == nil {
		_ = lib.SetThumb(id, name)
	}
	if side := media.Sidecar(song.Path); side != "" {
		_ = os.Remove(side)
	}
}

func finishNewFile(path, sourceURL string, normalise bool) (int64, error) {
	t := mediaTools()
	if kind, ok := library.KindOf(path); ok && kind == "audio" && normalise && t.FFmpeg != "" {
		normalised, err := t.Normalise(context.Background(), path)
		if err != nil {
			logger.Warnf("loudness normalisation failed for %s: %v", filepath.Base(path), err)
		} else if normalised != path {
			if old, ferr := lib.Files(); ferr == nil {
				if st, ok := old[path]; ok {
					_ = lib.RemoveIDs([]int64{st.ID})
				}
			}
			path = normalised
		}
	}
	id, err := lib.IndexFile(path, t, sourceURL)
	if id == 0 {
		return 0, err
	}
	attachThumb(id)
	return id, nil
}

func onDownloadDone(job downloads.Job) {
	if lib == nil {
		return
	}
	_, normalise, _ := libraryFolders()
	if _, err := finishNewFile(job.FilePath, job.URL, normalise && job.Format == "mp3"); err != nil {
		logger.Warnf("could not add %s to the library: %v", filepath.Base(job.FilePath), err)
		return
	}
	bumpLibrary()
}

func rescan() (library.ScanResult, error) {
	if lib == nil {
		return library.ScanResult{}, errLibrary()
	}
	folders, _, err := libraryFolders()
	if err != nil {
		return library.ScanResult{}, err
	}
	res, err := lib.Scan(folders, mediaTools(), nil)
	if err != nil {
		return res, err
	}
	for _, id := range res.Added {
		attachThumb(id)
	}
	if len(res.Added) > 0 || res.Removed > 0 || res.Updated > 0 {
		bumpLibrary()
	}
	return res, nil
}

func uniquePath(dir, name string) string {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	candidate := filepath.Join(dir, name)
	for i := 2; ; i++ {
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
		candidate = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(dst)
		return err
	}
	return out.Close()
}

func thumbDataURL(name string) string {
	if name == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(thumbDir, name))
	if err != nil {
		return ""
	}
	return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(data)
}
