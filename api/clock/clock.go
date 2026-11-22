package clock

type Sample struct {
	SentUs     int64
	RemoteUs   int64
	ReceivedUs int64
}

func (s Sample) RTT() int64 {
	return s.ReceivedUs - s.SentUs
}

func (s Sample) Offset() int64 {
	return s.RemoteUs - (s.SentUs+s.ReceivedUs)/2
}

type Estimate struct {
	OffsetUs int64
	RTTUs    int64
	Samples  int
}

func (e Estimate) ErrorUs() int64 {
	return e.RTTUs / 2
}

func Best(samples []Sample) (Estimate, bool) {
	var best Sample
	found := false
	for _, s := range samples {
		if s.RTT() < 0 {
			continue
		}
		if !found || s.RTT() < best.RTT() {
			best = s
			found = true
		}
	}
	if !found {
		return Estimate{}, false
	}
	return Estimate{OffsetUs: best.Offset(), RTTUs: best.RTT(), Samples: len(samples)}, true
}

func (e Estimate) ToLocal(remoteUs int64) int64 {
	return remoteUs - e.OffsetUs
}
