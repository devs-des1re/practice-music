package library

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var ErrNotFound = errors.New("not found")

type Song struct {
	ID         int64    `json:"id"`
	Path       string   `json:"path"`
	Title      string   `json:"title"`
	Artist     string   `json:"artist"`
	Album      string   `json:"album"`
	DurationMs int64    `json:"durationMs"`
	Kind       string   `json:"kind"`
	Size       int64    `json:"size"`
	Mtime      int64    `json:"mtime"`
	AddedAt    int64    `json:"addedAt"`
	Thumb      string   `json:"thumb"`
	SourceURL  string   `json:"sourceUrl"`
	Tags       []string `json:"tags"`
}

type Query struct {
	Text       string `json:"text"`
	Tag        string `json:"tag"`
	PlaylistID int64  `json:"playlistId"`
	Sort       string `json:"sort"`
}

type TagCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type Playlist struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

type FileState struct {
	ID    int64
	Size  int64
	Mtime int64
}

type DB struct {
	db  *sql.DB
	now func() time.Time
}

const schema = `
CREATE TABLE IF NOT EXISTS songs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	path TEXT NOT NULL UNIQUE,
	title TEXT NOT NULL DEFAULT '',
	artist TEXT NOT NULL DEFAULT '',
	album TEXT NOT NULL DEFAULT '',
	duration_ms INTEGER NOT NULL DEFAULT 0,
	kind TEXT NOT NULL DEFAULT 'audio',
	size INTEGER NOT NULL DEFAULT 0,
	mtime INTEGER NOT NULL DEFAULT 0,
	added_at INTEGER NOT NULL DEFAULT 0,
	thumb TEXT NOT NULL DEFAULT '',
	source_url TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tags (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS song_tags (
	song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
	tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
	PRIMARY KEY (song_id, tag_id)
);
CREATE TABLE IF NOT EXISTS playlists (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS playlist_items (
	playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
	song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
	position INTEGER NOT NULL,
	PRIMARY KEY (playlist_id, song_id)
);
CREATE TABLE IF NOT EXISTS grids (
	song_id INTEGER PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
	bpm REAL NOT NULL,
	offset_ms REAL NOT NULL,
	beats_per_bar INTEGER NOT NULL DEFAULT 4,
	downbeat INTEGER NOT NULL DEFAULT 0,
	confidence REAL NOT NULL DEFAULT 0,
	user_edited INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sections (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	start_ms REAL NOT NULL,
	end_ms REAL NOT NULL,
	created_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scenes (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	name TEXT NOT NULL UNIQUE COLLATE NOCASE,
	data TEXT NOT NULL,
	updated_at INTEGER NOT NULL DEFAULT 0
);
`

func Open(path string) (*DB, error) {
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
	}
	dsn := path
	if path != ":memory:" {
		dsn = "file:" + filepath.ToSlash(path) + "?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	} else {
		dsn = "file::memory:?_pragma=foreign_keys(1)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &DB{db: db, now: time.Now}, nil
}

func (d *DB) Close() error {
	return d.db.Close()
}

func (d *DB) Upsert(s Song) (int64, error) {
	if s.Path == "" {
		return 0, errors.New("a song needs a path")
	}
	if s.Kind == "" {
		s.Kind = "audio"
	}
	added := d.now().UnixMilli()
	_, err := d.db.Exec(`
INSERT INTO songs (path, title, artist, album, duration_ms, kind, size, mtime, added_at, thumb, source_url)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(path) DO UPDATE SET
	title = excluded.title, artist = excluded.artist, album = excluded.album,
	duration_ms = excluded.duration_ms, kind = excluded.kind, size = excluded.size, mtime = excluded.mtime,
	thumb = CASE WHEN excluded.thumb = '' THEN songs.thumb ELSE excluded.thumb END,
	source_url = CASE WHEN excluded.source_url = '' THEN songs.source_url ELSE excluded.source_url END`,
		s.Path, s.Title, s.Artist, s.Album, s.DurationMs, s.Kind, s.Size, s.Mtime, added, s.Thumb, s.SourceURL)
	if err != nil {
		return 0, err
	}
	var id int64
	err = d.db.QueryRow(`SELECT id FROM songs WHERE path = ?`, s.Path).Scan(&id)
	return id, err
}

const songColumns = `id, path, title, artist, album, duration_ms, kind, size, mtime, added_at, thumb, source_url`

func scanSong(row interface{ Scan(...any) error }) (Song, error) {
	var s Song
	err := row.Scan(&s.ID, &s.Path, &s.Title, &s.Artist, &s.Album, &s.DurationMs, &s.Kind, &s.Size, &s.Mtime, &s.AddedAt, &s.Thumb, &s.SourceURL)
	s.Tags = []string{}
	return s, err
}

func (d *DB) Get(id int64) (Song, error) {
	s, err := scanSong(d.db.QueryRow(`SELECT `+songColumns+` FROM songs WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return Song{}, ErrNotFound
	}
	if err != nil {
		return Song{}, err
	}
	rows, err := d.db.Query(`SELECT t.name FROM song_tags st JOIN tags t ON t.id = st.tag_id WHERE st.song_id = ? ORDER BY t.name`, id)
	if err != nil {
		return Song{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return Song{}, err
		}
		s.Tags = append(s.Tags, name)
	}
	return s, rows.Err()
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

var sortClauses = map[string]string{
	"":         "s.added_at DESC, s.id DESC",
	"added":    "s.added_at DESC, s.id DESC",
	"title":    "s.title COLLATE NOCASE ASC, s.id ASC",
	"artist":   "s.artist COLLATE NOCASE ASC, s.title COLLATE NOCASE ASC",
	"duration": "s.duration_ms DESC, s.id ASC",
}

func (d *DB) List(q Query) ([]Song, error) {
	order, ok := sortClauses[q.Sort]
	if !ok {
		return nil, fmt.Errorf("unknown sort %q", q.Sort)
	}
	var where []string
	var args []any
	from := "songs s"
	if q.PlaylistID != 0 {
		from = "songs s JOIN playlist_items pi ON pi.song_id = s.id AND pi.playlist_id = ?"
		args = append(args, q.PlaylistID)
		order = "pi.position ASC"
	}
	if text := strings.TrimSpace(q.Text); text != "" {
		for _, word := range strings.Fields(text) {
			like := "%" + escapeLike(word) + "%"
			where = append(where, `(s.title LIKE ? ESCAPE '\' OR s.artist LIKE ? ESCAPE '\' OR s.album LIKE ? ESCAPE '\' OR s.path LIKE ? ESCAPE '\' OR EXISTS (SELECT 1 FROM song_tags st JOIN tags t ON t.id = st.tag_id WHERE st.song_id = s.id AND t.name LIKE ? ESCAPE '\'))`)
			args = append(args, like, like, like, like, like)
		}
	}
	if tag := strings.TrimSpace(q.Tag); tag != "" {
		where = append(where, `EXISTS (SELECT 1 FROM song_tags st JOIN tags t ON t.id = st.tag_id WHERE st.song_id = s.id AND t.name = ?)`)
		args = append(args, tag)
	}
	query := `SELECT s.id, s.path, s.title, s.artist, s.album, s.duration_ms, s.kind, s.size, s.mtime, s.added_at, s.thumb, s.source_url FROM ` + from
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY " + order
	rows, err := d.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	songs := []Song{}
	index := map[int64]int{}
	for rows.Next() {
		s, err := scanSong(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		index[s.ID] = len(songs)
		songs = append(songs, s)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	tagRows, err := d.db.Query(`SELECT st.song_id, t.name FROM song_tags st JOIN tags t ON t.id = st.tag_id ORDER BY t.name`)
	if err != nil {
		return nil, err
	}
	defer tagRows.Close()
	for tagRows.Next() {
		var id int64
		var name string
		if err := tagRows.Scan(&id, &name); err != nil {
			return nil, err
		}
		if i, ok := index[id]; ok {
			songs[i].Tags = append(songs[i].Tags, name)
		}
	}
	return songs, tagRows.Err()
}

func (d *DB) UpdateMeta(id int64, title, artist, album string) error {
	res, err := d.db.Exec(`UPDATE songs SET title = ?, artist = ?, album = ? WHERE id = ?`, strings.TrimSpace(title), strings.TrimSpace(artist), strings.TrimSpace(album), id)
	return affected(res, err)
}

func (d *DB) SetThumb(id int64, name string) error {
	res, err := d.db.Exec(`UPDATE songs SET thumb = ? WHERE id = ?`, name, id)
	return affected(res, err)
}

func (d *DB) SetSourceURL(id int64, url string) error {
	res, err := d.db.Exec(`UPDATE songs SET source_url = ? WHERE id = ?`, url, id)
	return affected(res, err)
}

func (d *DB) Delete(id int64) error {
	res, err := d.db.Exec(`DELETE FROM songs WHERE id = ?`, id)
	return affected(res, err)
}

func affected(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (d *DB) Files() (map[string]FileState, error) {
	rows, err := d.db.Query(`SELECT path, id, size, mtime FROM songs`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]FileState{}
	for rows.Next() {
		var path string
		var st FileState
		if err := rows.Scan(&path, &st.ID, &st.Size, &st.Mtime); err != nil {
			return nil, err
		}
		out[path] = st
	}
	return out, rows.Err()
}

func (d *DB) RemoveIDs(ids []int64) error {
	for _, id := range ids {
		if _, err := d.db.Exec(`DELETE FROM songs WHERE id = ?`, id); err != nil {
			return err
		}
	}
	return nil
}

func normaliseTag(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return "", errors.New("a tag cannot be empty")
	}
	if len(name) > 40 {
		return "", errors.New("a tag can be at most 40 characters")
	}
	return name, nil
}

func (d *DB) AddTag(songID int64, name string) error {
	name, err := normaliseTag(name)
	if err != nil {
		return err
	}
	if _, err := d.Get(songID); err != nil {
		return err
	}
	if _, err := d.db.Exec(`INSERT OR IGNORE INTO tags (name) VALUES (?)`, name); err != nil {
		return err
	}
	_, err = d.db.Exec(`INSERT OR IGNORE INTO song_tags (song_id, tag_id) SELECT ?, id FROM tags WHERE name = ?`, songID, name)
	return err
}

func (d *DB) RemoveTag(songID int64, name string) error {
	if _, err := d.db.Exec(`DELETE FROM song_tags WHERE song_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)`, songID, name); err != nil {
		return err
	}
	_, err := d.db.Exec(`DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM song_tags)`)
	return err
}

func (d *DB) Tags() ([]TagCount, error) {
	rows, err := d.db.Query(`SELECT t.name, COUNT(st.song_id) FROM tags t JOIN song_tags st ON st.tag_id = t.id GROUP BY t.id ORDER BY t.name COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TagCount{}
	for rows.Next() {
		var t TagCount
		if err := rows.Scan(&t.Name, &t.Count); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (d *DB) CreatePlaylist(name string) (Playlist, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return Playlist{}, errors.New("a playlist needs a name")
	}
	res, err := d.db.Exec(`INSERT INTO playlists (name, created_at) VALUES (?, ?)`, name, d.now().UnixMilli())
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return Playlist{}, fmt.Errorf("a playlist named %q already exists", name)
		}
		return Playlist{}, err
	}
	id, _ := res.LastInsertId()
	return Playlist{ID: id, Name: name}, nil
}

func (d *DB) RenamePlaylist(id int64, name string) error {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return errors.New("a playlist needs a name")
	}
	res, err := d.db.Exec(`UPDATE playlists SET name = ? WHERE id = ?`, name, id)
	if err != nil && strings.Contains(err.Error(), "UNIQUE") {
		return fmt.Errorf("a playlist named %q already exists", name)
	}
	return affected(res, err)
}

func (d *DB) DeletePlaylist(id int64) error {
	res, err := d.db.Exec(`DELETE FROM playlists WHERE id = ?`, id)
	return affected(res, err)
}

func (d *DB) Playlists() ([]Playlist, error) {
	rows, err := d.db.Query(`SELECT p.id, p.name, COUNT(pi.song_id) FROM playlists p LEFT JOIN playlist_items pi ON pi.playlist_id = p.id GROUP BY p.id ORDER BY p.name COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Playlist{}
	for rows.Next() {
		var p Playlist
		if err := rows.Scan(&p.ID, &p.Name, &p.Count); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) AddToPlaylist(playlistID int64, songIDs []int64) error {
	var exists int
	if err := d.db.QueryRow(`SELECT COUNT(*) FROM playlists WHERE id = ?`, playlistID).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return ErrNotFound
	}
	for _, songID := range songIDs {
		var next int
		if err := d.db.QueryRow(`SELECT COALESCE(MAX(position), -1) + 1 FROM playlist_items WHERE playlist_id = ?`, playlistID).Scan(&next); err != nil {
			return err
		}
		if _, err := d.db.Exec(`INSERT OR IGNORE INTO playlist_items (playlist_id, song_id, position) SELECT ?, id, ? FROM songs WHERE id = ?`, playlistID, next, songID); err != nil {
			return err
		}
	}
	return nil
}

func (d *DB) RemoveFromPlaylist(playlistID, songID int64) error {
	if _, err := d.db.Exec(`DELETE FROM playlist_items WHERE playlist_id = ? AND song_id = ?`, playlistID, songID); err != nil {
		return err
	}
	return d.compact(playlistID)
}

func (d *DB) compact(playlistID int64) error {
	rows, err := d.db.Query(`SELECT song_id FROM playlist_items WHERE playlist_id = ? ORDER BY position`, playlistID)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	for pos, id := range ids {
		if _, err := d.db.Exec(`UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND song_id = ?`, pos, playlistID, id); err != nil {
			return err
		}
	}
	return nil
}

func (d *DB) MoveInPlaylist(playlistID, songID int64, newPosition int) error {
	rows, err := d.db.Query(`SELECT song_id FROM playlist_items WHERE playlist_id = ? ORDER BY position`, playlistID)
	if err != nil {
		return err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	from := -1
	for i, id := range ids {
		if id == songID {
			from = i
		}
	}
	if from < 0 {
		return ErrNotFound
	}
	newPosition = max(0, min(newPosition, len(ids)-1))
	ids = append(ids[:from], ids[from+1:]...)
	ids = append(ids[:newPosition], append([]int64{songID}, ids[newPosition:]...)...)
	for pos, id := range ids {
		if _, err := d.db.Exec(`UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND song_id = ?`, pos, playlistID, id); err != nil {
			return err
		}
	}
	return nil
}

type JobRow struct {
	ID   int64
	Data []byte
}

func (d *DB) InsertJob(data []byte) (int64, error) {
	res, err := d.db.Exec(`INSERT INTO jobs (data) VALUES (?)`, string(data))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (d *DB) UpdateJob(id int64, data []byte) error {
	res, err := d.db.Exec(`UPDATE jobs SET data = ? WHERE id = ?`, string(data), id)
	return affected(res, err)
}

func (d *DB) DeleteJob(id int64) error {
	_, err := d.db.Exec(`DELETE FROM jobs WHERE id = ?`, id)
	return err
}

func (d *DB) Jobs() ([]JobRow, error) {
	rows, err := d.db.Query(`SELECT id, data FROM jobs ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []JobRow
	for rows.Next() {
		var r JobRow
		var data string
		if err := rows.Scan(&r.ID, &data); err != nil {
			return nil, err
		}
		r.Data = []byte(data)
		out = append(out, r)
	}
	return out, rows.Err()
}
