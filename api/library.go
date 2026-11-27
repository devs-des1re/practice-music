package api

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/kratejs/krate/packages/native/krate"

	"practice-music/api/library"
	"practice-music/api/logger"
	"practice-music/api/refusal"
)

type ImportProgress struct {
	Running bool     `json:"running"`
	Total   int      `json:"total"`
	Done    int      `json:"done"`
	Current string   `json:"current"`
	Errors  []string `json:"errors"`
}

var LibraryRevision = krate.NewSignal(0)

var ImportState = krate.NewSignal(ImportProgress{Errors: []string{}})

func bumpLibrary() {
	LibraryRevision.Update(func(n int) int { return n + 1 })
}

func Songs(q library.Query) ([]library.Song, error) {
	boot()
	if lib == nil {
		return nil, errLibrary()
	}
	return lib.List(q)
}

func SetSongMeta(id int64, title, artist, album string) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	if err := lib.UpdateMeta(id, title, artist, album); err != nil {
		return err
	}
	bumpLibrary()
	return nil
}

func AddSongTag(id int64, name string) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	if err := lib.AddTag(id, name); err != nil {
		return err
	}
	bumpLibrary()
	return nil
}

func RemoveSongTag(id int64, name string) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	if err := lib.RemoveTag(id, name); err != nil {
		return err
	}
	bumpLibrary()
	return nil
}

func AllTags() ([]library.TagCount, error) {
	boot()
	if lib == nil {
		return nil, errLibrary()
	}
	return lib.Tags()
}

func Playlists() ([]library.Playlist, error) {
	boot()
	if lib == nil {
		return nil, errLibrary()
	}
	return lib.Playlists()
}

func CreatePlaylist(name string) (library.Playlist, error) {
	boot()
	if lib == nil {
		return library.Playlist{}, errLibrary()
	}
	p, err := lib.CreatePlaylist(name)
	if err == nil {
		bumpLibrary()
	}
	return p, err
}

func RenamePlaylist(id int64, name string) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	if err := lib.RenamePlaylist(id, name); err != nil {
		return err
	}
	bumpLibrary()
	return nil
}

func DeletePlaylist(id int64) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	if err := lib.DeletePlaylist(id); err != nil {
		return err
	}
	bumpLibrary()
	return nil
}

func AddToPlaylist(playlistID int64, songIDs []int64) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	if err := lib.AddToPlaylist(playlistID, songIDs); err != nil {
		return err
	}
	bumpLibrary()
	return nil
}

func RemoveFromPlaylist(playlistID, songID int64) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	if err := lib.RemoveFromPlaylist(playlistID, songID); err != nil {
		return err
	}
	bumpLibrary()
	return nil
}

func MoveInPlaylist(playlistID, songID int64, position int) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	if err := lib.MoveInPlaylist(playlistID, songID, position); err != nil {
		return err
	}
	bumpLibrary()
	return nil
}

func RescanLibrary() (library.ScanResult, error) {
	boot()
	return rescan()
}

func Thumbnail(id int64) (string, error) {
	boot()
	if lib == nil {
		return "", errLibrary()
	}
	song, err := lib.Get(id)
	if err != nil {
		return "", err
	}
	return thumbDataURL(song.Thumb), nil
}

func DeleteSong(id int64, deleteFile bool) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	song, err := lib.Get(id)
	if err != nil {
		return err
	}
	if deleteFile {
		if err := os.Remove(song.Path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	if err := lib.Delete(id); err != nil {
		return err
	}
	if song.Thumb != "" {
		_ = os.Remove(filepath.Join(thumbDir, song.Thumb))
	}
	bumpLibrary()
	return nil
}

func ImportFiles(paths []string, playlistID int64) error {
	boot()
	if lib == nil {
		return errLibrary()
	}
	dir, err := downloadDir()
	if err != nil {
		return err
	}
	_, normalise, err := libraryFolders()
	if err != nil {
		return err
	}
	if playlistID != 0 {
		if err := lib.AddToPlaylist(playlistID, nil); err != nil {
			return refusal.New("that playlist no longer exists")
		}
	}
	importMu.Lock()
	if ImportState.Get().Running {
		importMu.Unlock()
		return refusal.New("an import is already running")
	}
	ImportState.Set(ImportProgress{Running: true, Total: len(paths), Errors: []string{}})
	importMu.Unlock()
	job := importJob{
		db:         lib,
		dir:        dir,
		playlistID: playlistID,
		index:      func(path string) (int64, error) { return finishNewFile(path, "", normalise) },
		progress:   func(p ImportProgress) { ImportState.Set(p) },
	}
	go func() {
		errs := job.run(paths)
		ImportState.Set(ImportProgress{Running: false, Total: len(paths), Done: len(paths), Errors: errs})
		bumpLibrary()
		logger.Infof("import finished: %d files, %d problems", len(paths), len(errs))
	}()
	return nil
}

type importJob struct {
	db         *library.DB
	dir        string
	playlistID int64
	index      func(path string) (int64, error)
	progress   func(ImportProgress)
}

func (j importJob) run(paths []string) []string {
	errs := []string{}
	for i, src := range paths {
		name := filepath.Base(src)
		j.progress(ImportProgress{Running: true, Total: len(paths), Done: i, Current: name, Errors: errs})
		if err := j.one(src); err != nil {
			errs = append(errs, name+": "+err.Error())
		}
	}
	return errs
}

func (j importJob) one(src string) error {
	if _, ok := library.KindOf(src); !ok {
		return errors.New("not a supported audio or video file")
	}
	if err := os.MkdirAll(j.dir, 0o755); err != nil {
		return err
	}
	dst := uniquePath(j.dir, filepath.Base(src))
	if err := copyFile(src, dst); err != nil {
		return err
	}
	id, err := j.index(dst)
	if err != nil {
		return err
	}
	if j.playlistID == 0 {
		return nil
	}
	if err := j.db.AddToPlaylist(j.playlistID, []int64{id}); err != nil {
		return fmt.Errorf("added to the library but not to the playlist: %w", err)
	}
	return nil
}
