package update

import (
	"os"
	"runtime"
)

func ThisSystem() System {
	return System{OS: runtime.GOOS, Arch: runtime.GOARCH, Family: linuxFamily(exists)}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func linuxFamily(has func(string) bool) string {
	switch {
	case has("/etc/debian_version"):
		return "deb"
	case has("/etc/redhat-release"), has("/etc/fedora-release"):
		return "rpm"
	}
	return ""
}
