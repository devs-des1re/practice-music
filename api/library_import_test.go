package api

import (
	"os"
	"path/filepath"
	"testing"

	"practice-music/api/library"
)

func importRig(t *testing.T) (importJob, []string) {
	t.Helper()
	db, err := library.Open(filepath.Join(t.TempDir(), "library.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	from := t.TempDir()
	var paths []string
	for _, name := range []string{"first.mp3", "notes.txt", "second.wav"} {
		path := filepath.Join(from, name)
		if err := os.WriteFile(path, []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
		paths = append(paths, path)
	}
	return importJob{
		db:  db,
		dir: filepath.Join(t.TempDir(), "music"),
		index: func(path string) (int64, error) {
			return db.Upsert(library.Song{Path: path, Title: filepath.Base(path)})
		},
		progress: func(ImportProgress) {},
	}, paths
}

func titles(t *testing.T, db *library.DB, playlistID int64) []string {
	t.Helper()
	songs, err := db.List(library.Query{PlaylistID: playlistID, Sort: "title"})
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, song := range songs {
		out = append(out, song.Title)
	}
	return out
}

func TestImportingIntoAPlaylistAddsTheNewSongsToIt(t *testing.T) {
	job, paths := importRig(t)
	list, err := job.db.CreatePlaylist("Warm up")
	if err != nil {
		t.Fatal(err)
	}
	other, err := job.db.CreatePlaylist("Gig")
	if err != nil {
		t.Fatal(err)
	}
	job.playlistID = list.ID
	errs := job.run(paths)
	if len(errs) != 1 || errs[0] != "notes.txt: not a supported audio or video file" {
		t.Fatalf("errors %v", errs)
	}
	got := titles(t, job.db, list.ID)
	if len(got) != 2 || got[0] != "first.mp3" || got[1] != "second.wav" {
		t.Fatalf("playlist %v", got)
	}
	if len(titles(t, job.db, other.ID)) != 0 {
		t.Fatal("another playlist must stay empty")
	}
	if len(titles(t, job.db, 0)) != 2 {
		t.Fatal("the songs must also be in the library")
	}
}

func TestImportingWithNoPlaylistOpenOnlyFillsTheLibrary(t *testing.T) {
	job, paths := importRig(t)
	list, err := job.db.CreatePlaylist("Warm up")
	if err != nil {
		t.Fatal(err)
	}
	job.run(paths)
	if len(titles(t, job.db, list.ID)) != 0 || len(titles(t, job.db, 0)) != 2 {
		t.Fatalf("playlist %v library %v", titles(t, job.db, list.ID), titles(t, job.db, 0))
	}
}

func TestAPlaylistThatDisappearsIsReported(t *testing.T) {
	job, paths := importRig(t)
	job.playlistID = 99
	errs := job.run(paths[:1])
	if len(errs) != 1 || len(titles(t, job.db, 0)) != 1 {
		t.Fatalf("errors %v", errs)
	}
}
