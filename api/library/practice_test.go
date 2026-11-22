package library

import (
	"errors"
	"testing"
)

func TestGridRoundTripAndValidation(t *testing.T) {
	db := open(t)
	id := add(t, db, "/1.mp3", "A", "")
	if _, err := db.GetGrid(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("no grid yet: %v", err)
	}
	g := Grid{Bpm: 123.4, OffsetMs: 215.5, BeatsPerBar: 4, Downbeat: 2, Confidence: 0.7}
	if err := db.SaveGrid(id, g); err != nil {
		t.Fatal(err)
	}
	got, err := db.GetGrid(id)
	if err != nil || got.Bpm != 123.4 || got.Downbeat != 2 || got.UserEdited || !got.Found {
		t.Fatalf("%+v %v", got, err)
	}
	g.UserEdited = true
	g.Bpm = 90
	db.SaveGrid(id, g)
	got, _ = db.GetGrid(id)
	if got.Bpm != 90 || !got.UserEdited {
		t.Fatalf("update failed: %+v", got)
	}
	bad := []Grid{
		{Bpm: 10, BeatsPerBar: 4},
		{Bpm: 500, BeatsPerBar: 4},
		{Bpm: 100, BeatsPerBar: 0},
		{Bpm: 100, BeatsPerBar: 4, OffsetMs: -1},
		{Bpm: 100, BeatsPerBar: 4, Downbeat: 4},
	}
	for i, b := range bad {
		if err := db.SaveGrid(id, b); err == nil {
			t.Errorf("case %d should be rejected", i)
		}
	}
	if err := db.SaveGrid(9999, Grid{Bpm: 100, BeatsPerBar: 4}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing song: %v", err)
	}
}

func TestSectionsAreOrderedByPositionAndValidated(t *testing.T) {
	db := open(t)
	id := add(t, db, "/1.mp3", "A", "")
	chorus, err := db.SaveSection(id, "  Chorus ", 60000, 75000)
	if err != nil || chorus.Name != "Chorus" {
		t.Fatalf("%+v %v", chorus, err)
	}
	verse, _ := db.SaveSection(id, "Verse", 10000, 30000)
	fill, _ := db.SaveSection(id, "Fill", 30000, 32000)
	list, _ := db.Sections(id)
	if len(list) != 3 || list[0].ID != verse.ID || list[1].ID != fill.ID || list[2].ID != chorus.ID {
		t.Fatalf("order %+v", list)
	}
	if err := db.RenameSection(fill.ID, "Drum fill"); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteSection(verse.ID); err != nil {
		t.Fatal(err)
	}
	if err := db.DeleteSection(verse.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
	for _, c := range []struct {
		name       string
		start, end float64
	}{{"", 0, 1}, {"x", -5, 1}, {"x", 5, 5}, {"x", 5, 2}} {
		if _, err := db.SaveSection(id, c.name, c.start, c.end); err == nil {
			t.Errorf("%+v should be rejected", c)
		}
	}
	if _, err := db.SaveSection(9999, "x", 0, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing song: %v", err)
	}
}

func TestGridsAndSectionsDisappearWithTheirSong(t *testing.T) {
	db := open(t)
	id := add(t, db, "/1.mp3", "A", "")
	db.SaveGrid(id, Grid{Bpm: 100, BeatsPerBar: 4})
	db.SaveSection(id, "A", 0, 1000)
	db.Delete(id)
	if s, _ := db.Sections(id); len(s) != 0 {
		t.Fatal("sections should be removed with the song")
	}
	if _, err := db.GetGrid(id); !errors.Is(err, ErrNotFound) {
		t.Fatal("grid should be removed with the song")
	}
}
