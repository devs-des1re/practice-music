//go:build windows

package clock

import (
	"syscall"
	"unsafe"
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	procQPC  = kernel32.NewProc("QueryPerformanceCounter")
	procQPF  = kernel32.NewProc("QueryPerformanceFrequency")
	qpcFreq  int64
	qpcBase  int64
)

func init() {
	procQPF.Call(uintptr(unsafe.Pointer(&qpcFreq)))
	procQPC.Call(uintptr(unsafe.Pointer(&qpcBase)))
	if qpcFreq <= 0 {
		qpcFreq = 1
	}
}

func MonoUs() int64 {
	var now int64
	procQPC.Call(uintptr(unsafe.Pointer(&now)))
	ticks := now - qpcBase
	return ticks/qpcFreq*1_000_000 + ticks%qpcFreq*1_000_000/qpcFreq
}
