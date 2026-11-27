package library

import (
	"database/sql"
	"errors"
	"strings"

	"practice-music/api/refusal"
)

type Scene struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Data      string `json:"data"`
	UpdatedAt int64  `json:"updatedAt"`
}

const maxSceneNameRunes = 40

const maxSceneBytes = 64 * 1024

func cleanSceneName(name string) (string, error) {
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return "", refusal.New("a scene needs a name")
	}
	if len([]rune(name)) > maxSceneNameRunes {
		return "", refusal.New("a scene name can be at most 40 characters")
	}
	return name, nil
}

func (d *DB) Scenes() ([]Scene, error) {
	rows, err := d.db.Query(`SELECT id, name, data, updated_at FROM scenes ORDER BY name COLLATE NOCASE, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Scene{}
	for rows.Next() {
		var s Scene
		if err := rows.Scan(&s.ID, &s.Name, &s.Data, &s.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func (d *DB) Scene(id int64) (Scene, error) {
	var s Scene
	err := d.db.QueryRow(`SELECT id, name, data, updated_at FROM scenes WHERE id = ?`, id).Scan(&s.ID, &s.Name, &s.Data, &s.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Scene{}, ErrNotFound
	}
	return s, err
}

func (d *DB) SaveScene(name, data string) (Scene, error) {
	name, err := cleanSceneName(name)
	if err != nil {
		return Scene{}, err
	}
	if len(data) > maxSceneBytes {
		return Scene{}, refusal.New("the scene is too large")
	}
	now := d.now().UnixMilli()
	_, err = d.db.Exec(`
INSERT INTO scenes (name, data, updated_at) VALUES (?, ?, ?)
ON CONFLICT(name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, name, data, now)
	if err != nil {
		return Scene{}, err
	}
	var s Scene
	err = d.db.QueryRow(`SELECT id, name, data, updated_at FROM scenes WHERE name = ?`, name).Scan(&s.ID, &s.Name, &s.Data, &s.UpdatedAt)
	return s, err
}

func (d *DB) RenameScene(id int64, name string) error {
	name, err := cleanSceneName(name)
	if err != nil {
		return err
	}
	res, err := d.db.Exec(`UPDATE scenes SET name = ? WHERE id = ?`, name, id)
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "unique") {
		return refusal.New("another scene already has that name")
	}
	return affected(res, err)
}

func (d *DB) DeleteScene(id int64) error {
	res, err := d.db.Exec(`DELETE FROM scenes WHERE id = ?`, id)
	return affected(res, err)
}
