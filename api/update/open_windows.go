//go:build windows

package update

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const (
	showNormal   = 1
	accessDenied = 5
)

var shellExecute = syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")

func Open(target string) error {
	verb, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	file, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	code, _, _ := shellExecute.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, showNormal)
	if code > 32 {
		return nil
	}
	if code == accessDenied {
		return errors.New("Windows did not give permission to run it")
	}
	return fmt.Errorf("Windows could not open it (code %d)", code)
}
