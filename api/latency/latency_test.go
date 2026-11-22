package latency

import (
	"math"
	"testing"
)

func near(a, b float64) bool {
	return math.Abs(a-b) < 1e-9
}

func request(id uint64) Request {
	return Request{ID: id, UIPressUs: 1_000, HostRecvUs: 3_500, HostSendUs: 3_700}
}

func report(id uint64) Report {
	return Report{ID: id, EngineRecvUs: 4_200, CallbackUs: 9_200, PlaybackNs: 32_000_000, BufferFrames: 480, SampleRate: 48000}
}

func TestComputeSplitsTheJourneyIntoLayers(t *testing.T) {
	b := Compute(request(1), report(1))
	if !near(b.UIToHostMs, 2.5) || !near(b.HostToEngineMs, 0.5) || !near(b.EngineQueueMs, 5.0) || !near(b.OutputMs, 32.0) {
		t.Fatalf("unexpected breakdown %+v", b)
	}
	if !near(b.TotalMs, 40.0) {
		t.Fatalf("total %v", b.TotalMs)
	}
	if !near(b.BufferPeriodMs, 10.0) {
		t.Fatalf("buffer period %v", b.BufferPeriodMs)
	}
}

func TestComputeHandlesAZeroSampleRate(t *testing.T) {
	rep := report(1)
	rep.SampleRate = 0
	if b := Compute(request(1), rep); b.BufferPeriodMs != 0 {
		t.Fatalf("period %v", b.BufferPeriodMs)
	}
}

func TestSummarizeUsesNearestRank(t *testing.T) {
	s := Summarize([]float64{5, 1, 3, 2, 4, 9, 7, 8, 6, 10})
	if s.Count != 10 || s.MinMs != 1 || s.MaxMs != 10 || s.MedianMs != 5 || s.P95Ms != 10 {
		t.Fatalf("stats %+v", s)
	}
	if Summarize(nil).Count != 0 {
		t.Fatal("empty input should give zero stats")
	}
	one := Summarize([]float64{4})
	if one.MedianMs != 4 || one.P95Ms != 4 {
		t.Fatalf("single value %+v", one)
	}
}

func TestTrackerJoinsRequestAndReportInEitherOrder(t *testing.T) {
	tr := NewTracker()
	if _, done := tr.AddRequest(request(1)); done {
		t.Fatal("request alone is not a measurement")
	}
	if b, done := tr.AddReport(report(1)); !done || b.ID != 1 {
		t.Fatalf("report should complete id 1, got %+v %v", b, done)
	}
	if _, done := tr.AddReport(report(2)); done {
		t.Fatal("report alone is not a measurement")
	}
	if b, done := tr.AddRequest(request(2)); !done || b.ID != 2 {
		t.Fatalf("request should complete id 2, got %+v %v", b, done)
	}
	snap := tr.Snapshot()
	if !snap.HasLast || snap.Last.ID != 2 || snap.Total.Count != 2 {
		t.Fatalf("snapshot %+v", snap)
	}
}

func TestTrackerDropsOldUnmatchedEntries(t *testing.T) {
	tr := NewTracker()
	for id := uint64(1); id <= maxPending+50; id++ {
		tr.AddRequest(request(id))
	}
	if _, done := tr.AddReport(report(1)); done {
		t.Fatal("the oldest pending request should have been evicted")
	}
	if _, done := tr.AddReport(report(maxPending + 50)); !done {
		t.Fatal("a recent pending request must still match")
	}
}

func TestHistoryIsBoundedAndSnapshotShowsRecentOnly(t *testing.T) {
	tr := NewTracker()
	for id := uint64(1); id <= maxHistory+30; id++ {
		tr.AddRequest(request(id))
		tr.AddReport(report(id))
	}
	snap := tr.Snapshot()
	if snap.Total.Count != maxHistory {
		t.Fatalf("history size %d", snap.Total.Count)
	}
	if len(snap.Recent) != recentKept || snap.Recent[len(snap.Recent)-1].ID != maxHistory+30 {
		t.Fatalf("recent window wrong: len %d", len(snap.Recent))
	}
}

func TestResetClearsEverything(t *testing.T) {
	tr := NewTracker()
	tr.AddRequest(request(1))
	tr.AddReport(report(1))
	tr.Reset()
	snap := tr.Snapshot()
	if snap.HasLast || snap.Total.Count != 0 || len(snap.Recent) != 0 {
		t.Fatalf("not reset: %+v", snap)
	}
}
