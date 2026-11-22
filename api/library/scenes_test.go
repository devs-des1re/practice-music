package library

import (
	"errors"
	"strings"
	"testing"
)

func TestSavingASceneStoresItsData(t *testing.T) {
	d := open(t)
	s, err := d.SaveScene("Lesson", `{"version":1}`)
	if err != nil {
		t.Fatal(err)
	}
	if s.ID == 0 || s.Name != "Lesson" || s.Data != `{"version":1}` {
		t.Fatalf("scene %+v", s)
	}
	got, err := d.Scene(s.ID)
	if err != nil || got.Data != `{"version":1}` {
		t.Fatalf("got %+v err %v", got, err)
	}
}

func TestSavingUnderTheSameNameReplacesTheScene(t *testing.T) {
	d := open(t)
	first, _ := d.SaveScene("Solo practice", `{"a":1}`)
	second, err := d.SaveScene("solo  PRACTICE", `{"a":2}`)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != first.ID || second.Data != `{"a":2}` {
		t.Fatalf("first %+v second %+v", first, second)
	}
	all, _ := d.Scenes()
	if len(all) != 1 {
		t.Fatalf("scenes %d", len(all))
	}
}

func TestScenesAreListedByName(t *testing.T) {
	d := open(t)
	for _, n := range []string{"warm-up", "Lesson", "headphones only"} {
		if _, err := d.SaveScene(n, "{}"); err != nil {
			t.Fatal(err)
		}
	}
	all, err := d.Scenes()
	if err != nil {
		t.Fatal(err)
	}
	names := []string{all[0].Name, all[1].Name, all[2].Name}
	want := []string{"headphones only", "Lesson", "warm-up"}
	for i := range want {
		if names[i] != want[i] {
			t.Fatalf("order %v", names)
		}
	}
}

func TestSceneNamesAreValidated(t *testing.T) {
	d := open(t)
	if _, err := d.SaveScene("   ", "{}"); err == nil {
		t.Fatal("blank name accepted")
	}
	if _, err := d.SaveScene(strings.Repeat("n", 41), "{}"); err == nil {
		t.Fatal("long name accepted")
	}
	if _, err := d.SaveScene("ok", strings.Repeat("x", 70*1024)); err == nil {
		t.Fatal("huge scene accepted")
	}
}

func TestRenamingASceneKeepsNamesUnique(t *testing.T) {
	d := open(t)
	a, _ := d.SaveScene("A", "{}")
	if _, err := d.SaveScene("B", "{}"); err != nil {
		t.Fatal(err)
	}
	if err := d.RenameScene(a.ID, "b"); err == nil || !strings.Contains(err.Error(), "already") {
		t.Fatalf("err %v", err)
	}
	if err := d.RenameScene(a.ID, "Warm up"); err != nil {
		t.Fatal(err)
	}
	got, _ := d.Scene(a.ID)
	if got.Name != "Warm up" {
		t.Fatalf("name %q", got.Name)
	}
	if err := d.RenameScene(9999, "Ghost"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err %v", err)
	}
}

func TestDeletingAScene(t *testing.T) {
	d := open(t)
	s, _ := d.SaveScene("Gone", "{}")
	if err := d.DeleteScene(s.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := d.Scene(s.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err %v", err)
	}
	if err := d.DeleteScene(s.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete err %v", err)
	}
}
