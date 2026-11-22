package clock

import "testing"

func TestOffsetRecoversTheRemoteClockWithSymmetricDelay(t *testing.T) {
	s := Sample{SentUs: 1000, RemoteUs: 5_001_500, ReceivedUs: 2000}
	if s.RTT() != 1000 {
		t.Fatalf("rtt %d", s.RTT())
	}
	if s.Offset() != 5_000_000 {
		t.Fatalf("offset %d", s.Offset())
	}
}

func TestBestPicksTheSmallestRoundTrip(t *testing.T) {
	est, ok := Best([]Sample{
		{SentUs: 0, RemoteUs: 10_050, ReceivedUs: 900},
		{SentUs: 1000, RemoteUs: 11_020, ReceivedUs: 1040},
		{SentUs: 2000, RemoteUs: 12_300, ReceivedUs: 3000},
	})
	if !ok || est.RTTUs != 40 || est.OffsetUs != 10_000 || est.Samples != 3 {
		t.Fatalf("estimate %+v ok=%v", est, ok)
	}
	if est.ErrorUs() != 20 {
		t.Fatalf("error bound %d", est.ErrorUs())
	}
}

func TestBestRejectsNegativeRoundTripsAndEmptyInput(t *testing.T) {
	if _, ok := Best(nil); ok {
		t.Fatal("no samples should not produce an estimate")
	}
	if _, ok := Best([]Sample{{SentUs: 10, RemoteUs: 5, ReceivedUs: 4}}); ok {
		t.Fatal("a negative round trip is not usable")
	}
}

func TestToLocalInvertsTheOffset(t *testing.T) {
	est := Estimate{OffsetUs: 7_000_000}
	if est.ToLocal(7_001_234) != 1234 {
		t.Fatalf("got %d", est.ToLocal(7_001_234))
	}
}

func TestMonoIsMonotonic(t *testing.T) {
	a := MonoUs()
	b := MonoUs()
	if b < a {
		t.Fatalf("clock went backwards: %d then %d", a, b)
	}
}

func TestMonoHasMicrosecondResolution(t *testing.T) {
	seen := map[int64]bool{}
	for i := 0; i < 2000; i++ {
		seen[MonoUs()] = true
	}
	if len(seen) < 20 {
		t.Fatalf("only %d distinct readings in 2000 calls, the clock is too coarse for latency work", len(seen))
	}
}
