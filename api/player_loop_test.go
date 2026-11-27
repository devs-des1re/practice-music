package api

import "testing"

func TestOnlySeekingOutsideAnActiveLoopLeavesIt(t *testing.T) {
	on := LoopRegion{StartMs: 10000, EndMs: 20000, Enabled: true}
	for ms, want := range map[float64]bool{10000: false, 15000: false, 19999: false, 9999.5: false, 5000: true, 20000: true, 45000: true} {
		if leavesLoop(on, ms) != want {
			t.Fatalf("seek to %v: got %v, want %v", ms, !want, want)
		}
	}
	off := on
	off.Enabled = false
	if leavesLoop(off, 45000) {
		t.Fatal("a loop that is off cannot be left")
	}
}
