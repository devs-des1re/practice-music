package update

import (
	"cmp"
	"slices"
	"strconv"
	"strings"
)

type Version struct {
	Numbers [3]int
	Pre     []string
}

func ParseVersion(text string) (Version, bool) {
	text = strings.TrimPrefix(strings.TrimSpace(text), "v")
	text, _, _ = strings.Cut(text, "+")
	core, pre, hasPre := strings.Cut(text, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return Version{}, false
	}
	var v Version
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return Version{}, false
		}
		v.Numbers[i] = n
	}
	if !hasPre {
		return v, true
	}
	v.Pre = strings.Split(pre, ".")
	for _, id := range v.Pre {
		if id == "" || strings.IndexFunc(id, notIdentifier) >= 0 {
			return Version{}, false
		}
	}
	return v, true
}

func notIdentifier(r rune) bool {
	return !(r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z')
}

func (v Version) String() string {
	text := strconv.Itoa(v.Numbers[0]) + "." + strconv.Itoa(v.Numbers[1]) + "." + strconv.Itoa(v.Numbers[2])
	if len(v.Pre) > 0 {
		text += "-" + strings.Join(v.Pre, ".")
	}
	return text
}

func compareIdentifier(a, b string) int {
	x, errA := strconv.Atoi(a)
	y, errB := strconv.Atoi(b)
	switch {
	case errA == nil && errB == nil:
		return cmp.Compare(x, y)
	case errA == nil:
		return -1
	case errB == nil:
		return 1
	}
	return strings.Compare(a, b)
}

func Compare(a, b Version) int {
	if c := slices.Compare(a.Numbers[:], b.Numbers[:]); c != 0 {
		return c
	}
	if len(a.Pre) == 0 || len(b.Pre) == 0 {
		return cmp.Compare(len(b.Pre), len(a.Pre))
	}
	return slices.CompareFunc(a.Pre, b.Pre, compareIdentifier)
}
