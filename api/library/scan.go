package library

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type Meta struct {
	Title      string
	Artist     string
	Album      string
	DurationMs int64
	Kind       string
}

type Prober interface {
	Probe(path string) (Meta, error)
}

var mediaExtensions = map[string]string{
	".mp3": "audio", ".m4a": "audio", ".aac": "audio", ".flac": "audio", ".wav": "audio",
	".ogg": "audio", ".opus": "audio", ".wma": "audio",
	".mp4": "video", ".mkv": "video", ".webm": "video", ".mov": "video",
}

func KindOf(path string) (string, bool) {
	kind, ok := mediaExtensions[strings.ToLower(filepath.Ext(path))]
	return kind, ok
}

func TitleFromPath(path string) string {
	base := filepath.Base(path)
	return strings.TrimSpace(strings.TrimSuffix(base, filepath.Ext(base)))
}

type ScanResult struct {
	Added   []int64  `json:"added"`
	Updated int      `json:"updated"`
	Removed int      `json:"removed"`
	Errors  []string `json:"errors"`
}

func (d *DB) IndexFile(path string, prober Prober, sourceURL string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	kind, ok := KindOf(path)
	if !ok {
		return 0, &UnsupportedError{Path: path}
	}
	meta, perr := prober.Probe(path)
	song := Song{
		Path:       path,
		Title:      meta.Title,
		Artist:     meta.Artist,
		Album:      meta.Album,
		DurationMs: meta.DurationMs,
		Kind:       kind,
		Size:       info.Size(),
		Mtime:      info.ModTime().UnixMilli(),
		SourceURL:  sourceURL,
	}
	if meta.Kind != "" {
		song.Kind = meta.Kind
	}
	if strings.TrimSpace(song.Title) == "" {
		song.Title = TitleFromPath(path)
	}
	id, err := d.Upsert(song)
	if err != nil {
		return 0, err
	}
	return id, perr
}

type UnsupportedError struct {
	Path string
}

func (e *UnsupportedError) Error() string {
	return "unsupported media file " + filepath.Base(e.Path)
}

func (d *DB) Scan(folders []string, prober Prober, skipDir func(string) bool) (ScanResult, error) {
	known, err := d.Files()
	if err != nil {
		return ScanResult{}, err
	}
	res := ScanResult{Added: []int64{}, Errors: []string{}}
	seen := map[string]bool{}
	for _, root := range folders {
		if _, err := os.Stat(root); err != nil {
			continue
		}
		walkErr := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if entry.IsDir() {
				if path != root && (strings.HasPrefix(entry.Name(), ".") || (skipDir != nil && skipDir(path))) {
					return filepath.SkipDir
				}
				return nil
			}
			if _, ok := KindOf(path); !ok {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return nil
			}
			seen[path] = true
			state, exists := known[path]
			if exists && state.Size == info.Size() && state.Mtime == info.ModTime().UnixMilli() {
				return nil
			}
			id, err := d.IndexFile(path, prober, "")
			if err != nil && id == 0 {
				res.Errors = append(res.Errors, filepath.Base(path)+": "+err.Error())
				return nil
			}
			if exists {
				res.Updated++
			} else {
				res.Added = append(res.Added, id)
			}
			return nil
		})
		if walkErr != nil {
			return res, walkErr
		}
	}
	var gone []int64
	for path, st := range known {
		if seen[path] {
			continue
		}
		if _, err := os.Stat(path); err != nil && os.IsNotExist(err) && underAny(path, folders) {
			gone = append(gone, st.ID)
		}
	}
	if err := d.RemoveIDs(gone); err != nil {
		return res, err
	}
	res.Removed = len(gone)
	return res, nil
}

func underAny(path string, folders []string) bool {
	for _, f := range folders {
		rel, err := filepath.Rel(f, path)
		if err == nil && !strings.HasPrefix(rel, "..") {
			return true
		}
	}
	return false
}
