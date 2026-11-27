package library

import (
	"database/sql"
	"errors"
	"strings"

	"practice-music/api/refusal"
)

type Grid struct {
	Bpm         float64 `json:"bpm"`
	OffsetMs    float64 `json:"offsetMs"`
	BeatsPerBar int     `json:"beatsPerBar"`
	Downbeat    int     `json:"downbeat"`
	Confidence  float64 `json:"confidence"`
	UserEdited  bool    `json:"userEdited"`
	Found       bool    `json:"found"`
}

type Section struct {
	ID      int64   `json:"id"`
	SongID  int64   `json:"songId"`
	Name    string  `json:"name"`
	StartMs float64 `json:"startMs"`
	EndMs   float64 `json:"endMs"`
}

func (g Grid) Validate() error {
	if g.Bpm < 20 || g.Bpm > 400 {
		return refusal.New("tempo must be between 20 and 400 BPM")
	}
	if g.BeatsPerBar < 1 || g.BeatsPerBar > 32 {
		return refusal.New("beats per bar must be between 1 and 32")
	}
	if g.OffsetMs < 0 {
		return refusal.New("the first beat cannot be before the start of the song")
	}
	if g.Downbeat < 0 || g.Downbeat >= g.BeatsPerBar {
		return refusal.New("the bar start must be one of the beats in the bar")
	}
	return nil
}

func (d *DB) GetGrid(songID int64) (Grid, error) {
	var g Grid
	var edited int
	err := d.db.QueryRow(`SELECT bpm, offset_ms, beats_per_bar, downbeat, confidence, user_edited FROM grids WHERE song_id = ?`, songID).
		Scan(&g.Bpm, &g.OffsetMs, &g.BeatsPerBar, &g.Downbeat, &g.Confidence, &edited)
	if errors.Is(err, sql.ErrNoRows) {
		return Grid{}, ErrNotFound
	}
	g.UserEdited = edited == 1
	g.Found = err == nil
	return g, err
}

func (d *DB) SaveGrid(songID int64, g Grid) error {
	if err := g.Validate(); err != nil {
		return err
	}
	if _, err := d.Get(songID); err != nil {
		return err
	}
	edited := 0
	if g.UserEdited {
		edited = 1
	}
	_, err := d.db.Exec(`
INSERT INTO grids (song_id, bpm, offset_ms, beats_per_bar, downbeat, confidence, user_edited)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(song_id) DO UPDATE SET bpm = excluded.bpm, offset_ms = excluded.offset_ms,
	beats_per_bar = excluded.beats_per_bar, downbeat = excluded.downbeat,
	confidence = excluded.confidence, user_edited = excluded.user_edited`,
		songID, g.Bpm, g.OffsetMs, g.BeatsPerBar, g.Downbeat, g.Confidence, edited)
	return err
}

func (d *DB) Sections(songID int64) ([]Section, error) {
	rows, err := d.db.Query(`SELECT id, song_id, name, start_ms, end_ms FROM sections WHERE song_id = ? ORDER BY start_ms, id`, songID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Section{}
	for rows.Next() {
		var s Section
		if err := rows.Scan(&s.ID, &s.SongID, &s.Name, &s.StartMs, &s.EndMs); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (d *DB) SaveSection(songID int64, name string, startMs, endMs float64) (Section, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return Section{}, refusal.New("a section needs a name")
	}
	if len(name) > 60 {
		return Section{}, refusal.New("a section name can be at most 60 characters")
	}
	if startMs < 0 || endMs <= startMs {
		return Section{}, refusal.New("a section must end after it starts")
	}
	if _, err := d.Get(songID); err != nil {
		return Section{}, err
	}
	res, err := d.db.Exec(`INSERT INTO sections (song_id, name, start_ms, end_ms, created_at) VALUES (?, ?, ?, ?, ?)`, songID, name, startMs, endMs, d.now().UnixMilli())
	if err != nil {
		return Section{}, err
	}
	id, _ := res.LastInsertId()
	return Section{ID: id, SongID: songID, Name: name, StartMs: startMs, EndMs: endMs}, nil
}

func (d *DB) RenameSection(id int64, name string) error {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return refusal.New("a section needs a name")
	}
	res, err := d.db.Exec(`UPDATE sections SET name = ? WHERE id = ?`, name, id)
	return affected(res, err)
}

func (d *DB) DeleteSection(id int64) error {
	res, err := d.db.Exec(`DELETE FROM sections WHERE id = ?`, id)
	return affected(res, err)
}
