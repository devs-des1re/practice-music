package library

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func open(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "lib.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func add(t *testing.T, db *DB, path, title, artist string) int64 {
	t.Helper()
	id, err := db.Upsert(Song{Path: path, Title: title, Artist: artist, DurationMs: 1000})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func titles(songs []Song) []string {
	out := []string{}
	for _, s := range songs {
		out = append(out, s.Title)
	}
	return out
}

func TestUpsertKeepsOneRowPerPathAndKeepsThumbAndSource(t *testing.T) {
	db := open(t)
	id, _ := db.Upsert(Song{Path: "/a.mp3", Title: "A", Thumb: "t.jpg", SourceURL: "https://x"})
	id2, _ := db.Upsert(Song{Path: "/a.mp3", Title: "A2"})
	if id != id2 {
		t.Fatalf("ids differ: %d %d", id, id2)
	}
	s, err := db.Get(id)
	if err != nil || s.Title != "A2" || s.Thumb != "t.jpg" || s.SourceURL != "https://x" {
		t.Fatalf("song %+v %v", s, err)
	}
	if _, err := db.Upsert(Song{}); err == nil {
		t.Fatal("empty path must be rejected")
	}
}

func TestSearchMatchesWordsAcrossFieldsAndTags(t *testing.T) {
	db := open(t)
	a := add(t, db, "/1.mp3", "Tom Sawyer", "Rush")
	add(t, db, "/2.mp3", "Limelight", "Rush")
	add(t, db, "/3.mp3", "Walking on the Moon", "Police")
	if err := db.AddTag(a, "Odd Time"); err != nil {
		t.Fatal(err)
	}
	cases := map[string][]string{
		"rush":         {"Limelight", "Tom Sawyer"},
		"tom rush":     {"Tom Sawyer"},
		"odd":          {"Tom Sawyer"},
		"nothing here": {},
		"police moon":  {"Walking on the Moon"},
		"100%":         {},
		"_":            {},
	}
	for text, want := range cases {
		got, err := db.List(Query{Text: text, Sort: "title"})
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(titles(got), want) {
			t.Errorf("%q: got %v want %v", text, titles(got), want)
		}
	}
}

func TestLikeWildcardsInSearchAreLiteral(t *testing.T) {
	db := open(t)
	add(t, db, "/1.mp3", "100% Pure", "")
	add(t, db, "/2.mp3", "Other", "")
	got, _ := db.List(Query{Text: "100%"})
	if !reflect.DeepEqual(titles(got), []string{"100% Pure"}) {
		t.Fatalf("got %v", titles(got))
	}
}

func TestSortOrders(t *testing.T) {
	db := open(t)
	n := 0
	db.now = func() time.Time { n++; return time.UnixMilli(int64(n) * 1000) }
	db.Upsert(Song{Path: "/b", Title: "bravo", Artist: "z", DurationMs: 300})
	db.Upsert(Song{Path: "/a", Title: "Alpha", Artist: "y", DurationMs: 100})
	db.Upsert(Song{Path: "/c", Title: "charlie", Artist: "x", DurationMs: 200})
	check := func(sort string, want []string) {
		got, err := db.List(Query{Sort: sort})
		if err != nil || !reflect.DeepEqual(titles(got), want) {
			t.Errorf("sort %q: got %v want %v (%v)", sort, titles(got), want, err)
		}
	}
	check("title", []string{"Alpha", "bravo", "charlie"})
	check("artist", []string{"charlie", "Alpha", "bravo"})
	check("duration", []string{"bravo", "charlie", "Alpha"})
	check("added", []string{"charlie", "Alpha", "bravo"})
	if _, err := db.List(Query{Sort: "1; DROP TABLE songs"}); err == nil {
		t.Fatal("an unknown sort must be refused")
	}
}

func TestTagsAreCaseInsensitiveDeduplicatedAndCleanedUp(t *testing.T) {
	db := open(t)
	a := add(t, db, "/1", "A", "")
	b := add(t, db, "/2", "B", "")
	db.AddTag(a, "Fills")
	db.AddTag(a, "  fills ")
	db.AddTag(b, "FILLS")
	db.AddTag(b, "Slow")
	tags, _ := db.Tags()
	if len(tags) != 2 || tags[0].Name != "Fills" || tags[0].Count != 2 || tags[1].Name != "Slow" {
		t.Fatalf("tags %+v", tags)
	}
	song, _ := db.Get(b)
	if !reflect.DeepEqual(song.Tags, []string{"Fills", "Slow"}) {
		t.Fatalf("song tags %v", song.Tags)
	}
	db.RemoveTag(b, "Slow")
	tags, _ = db.Tags()
	if len(tags) != 1 {
		t.Fatalf("unused tag should disappear: %+v", tags)
	}
	got, _ := db.List(Query{Tag: "Fills", Sort: "title"})
	if !reflect.DeepEqual(titles(got), []string{"A", "B"}) {
		t.Fatalf("tag filter %v", titles(got))
	}
	if err := db.AddTag(a, "   "); err == nil {
		t.Fatal("empty tag must be rejected")
	}
	if err := db.AddTag(9999, "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("tagging a missing song: %v", err)
	}
}

func TestPlaylistsKeepOrderAndSurviveSongDeletion(t *testing.T) {
	db := open(t)
	a := add(t, db, "/1", "A", "")
	b := add(t, db, "/2", "B", "")
	c := add(t, db, "/3", "C", "")
	pl, err := db.CreatePlaylist("Warm up")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.CreatePlaylist("warm UP"); err == nil {
		t.Fatal("duplicate names differing by case must be rejected")
	}
	db.AddToPlaylist(pl.ID, []int64{c, a, b, a})
	list := func() []string {
		got, _ := db.List(Query{PlaylistID: pl.ID})
		return titles(got)
	}
	if !reflect.DeepEqual(list(), []string{"C", "A", "B"}) {
		t.Fatalf("order %v", list())
	}
	db.MoveInPlaylist(pl.ID, b, 0)
	if !reflect.DeepEqual(list(), []string{"B", "C", "A"}) {
		t.Fatalf("after move %v", list())
	}
	db.RemoveFromPlaylist(pl.ID, c)
	if !reflect.DeepEqual(list(), []string{"B", "A"}) {
		t.Fatalf("after remove %v", list())
	}
	db.Delete(b)
	if !reflect.DeepEqual(list(), []string{"A"}) {
		t.Fatalf("deleting a song should drop it from playlists: %v", list())
	}
	pls, _ := db.Playlists()
	if len(pls) != 1 || pls[0].Count != 1 {
		t.Fatalf("playlists %+v", pls)
	}
	if err := db.RenamePlaylist(pl.ID, "Groove"); err != nil {
		t.Fatal(err)
	}
	if err := db.DeletePlaylist(pl.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.DeletePlaylist(pl.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestMovePositionIsClamped(t *testing.T) {
	db := open(t)
	a := add(t, db, "/1", "A", "")
	b := add(t, db, "/2", "B", "")
	pl, _ := db.CreatePlaylist("p")
	db.AddToPlaylist(pl.ID, []int64{a, b})
	if err := db.MoveInPlaylist(pl.ID, a, 99); err != nil {
		t.Fatal(err)
	}
	got, _ := db.List(Query{PlaylistID: pl.ID})
	if !reflect.DeepEqual(titles(got), []string{"B", "A"}) {
		t.Fatalf("got %v", titles(got))
	}
	if err := db.MoveInPlaylist(pl.ID, 12345, 0); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing song: %v", err)
	}
}

func TestUpdateMetaAndMissingRows(t *testing.T) {
	db := open(t)
	id := add(t, db, "/1", "Old", "")
	if err := db.UpdateMeta(id, "  New ", "Me", "LP"); err != nil {
		t.Fatal(err)
	}
	s, _ := db.Get(id)
	if s.Title != "New" || s.Artist != "Me" || s.Album != "LP" {
		t.Fatalf("%+v", s)
	}
	if err := db.UpdateMeta(999, "x", "", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
	if _, err := db.Get(999); !errors.Is(err, ErrNotFound) {
		t.Fatalf("got %v", err)
	}
}

func TestJobsRoundTrip(t *testing.T) {
	db := open(t)
	id, err := db.InsertJob([]byte(`{"a":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.UpdateJob(id, []byte(`{"a":2}`)); err != nil {
		t.Fatal(err)
	}
	rows, _ := db.Jobs()
	if len(rows) != 1 || string(rows[0].Data) != `{"a":2}` {
		t.Fatalf("%+v", rows)
	}
	db.DeleteJob(id)
	rows, _ = db.Jobs()
	if len(rows) != 0 {
		t.Fatal("job not deleted")
	}
}

type fakeProber struct {
	calls []string
}

func (f *fakeProber) Probe(path string) (Meta, error) {
	f.calls = append(f.calls, filepath.Base(path))
	return Meta{Title: "T-" + TitleFromPath(path), Artist: "Band", DurationMs: 5000}, nil
}

func write(t *testing.T, path string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScanAddsNewChangedAndRemovesMissingFiles(t *testing.T) {
	db := open(t)
	root := t.TempDir()
	write(t, filepath.Join(root, "one.mp3"))
	write(t, filepath.Join(root, "sub", "two.flac"))
	write(t, filepath.Join(root, "notes.txt"))
	write(t, filepath.Join(root, ".hidden", "skip.mp3"))
	write(t, filepath.Join(root, "thumbs", "skip.mp3"))
	prober := &fakeProber{}
	skip := func(p string) bool { return filepath.Base(p) == "thumbs" }

	res, err := db.Scan([]string{root}, prober, skip)
	if err != nil || len(res.Added) != 2 || res.Removed != 0 {
		t.Fatalf("first scan %+v %v", res, err)
	}
	prober.calls = nil
	res, _ = db.Scan([]string{root}, prober, skip)
	if len(res.Added) != 0 || len(prober.calls) != 0 {
		t.Fatalf("an unchanged library must not be reprobed: %+v %v", res, prober.calls)
	}

	later := time.Now().Add(time.Hour)
	os.Chtimes(filepath.Join(root, "one.mp3"), later, later)
	res, _ = db.Scan([]string{root}, prober, skip)
	if res.Updated != 1 || len(prober.calls) != 1 {
		t.Fatalf("changed file should be reprobed once: %+v %v", res, prober.calls)
	}

	os.Remove(filepath.Join(root, "sub", "two.flac"))
	res, _ = db.Scan([]string{root}, prober, skip)
	if res.Removed != 1 {
		t.Fatalf("removed %+v", res)
	}
	songs, _ := db.List(Query{})
	if len(songs) != 1 || songs[0].Title != "T-one" || songs[0].Kind != "audio" {
		t.Fatalf("songs %+v", songs)
	}
}

func TestScanDoesNotRemoveSongsOutsideTheScannedFolders(t *testing.T) {
	db := open(t)
	a := t.TempDir()
	b := t.TempDir()
	write(t, filepath.Join(a, "a.mp3"))
	write(t, filepath.Join(b, "b.mp3"))
	prober := &fakeProber{}
	db.Scan([]string{a, b}, prober, nil)
	os.Remove(filepath.Join(b, "b.mp3"))
	res, _ := db.Scan([]string{a}, prober, nil)
	if res.Removed != 0 {
		t.Fatalf("a song from an unscanned folder was removed: %+v", res)
	}
}

func TestIndexFileFallsBackToTheFileNameAndRejectsOtherTypes(t *testing.T) {
	db := open(t)
	dir := t.TempDir()
	p := filepath.Join(dir, "Mystery Song.mp3")
	write(t, p)
	empty := proberFunc(func(string) (Meta, error) { return Meta{}, errors.New("probe failed") })
	id, err := db.IndexFile(p, empty, "https://src")
	if id == 0 || err == nil {
		t.Fatalf("a failed probe still indexes the file but reports the error: id=%d err=%v", id, err)
	}
	s, _ := db.Get(id)
	if s.Title != "Mystery Song" || s.SourceURL != "https://src" {
		t.Fatalf("%+v", s)
	}
	txt := filepath.Join(dir, "x.txt")
	write(t, txt)
	var ue *UnsupportedError
	if _, err := db.IndexFile(txt, empty, ""); !errors.As(err, &ue) {
		t.Fatalf("want UnsupportedError, got %v", err)
	}
}

type proberFunc func(string) (Meta, error)

func (f proberFunc) Probe(p string) (Meta, error) { return f(p) }
