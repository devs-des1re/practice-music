package trainer

import "testing"

func cfg() Config {
	return Config{StartBpm: 80, TargetBpm: 100, StepBpm: 5, RepsPerStep: 3}
}

func TestValidation(t *testing.T) {
	bad := []Config{
		{StartBpm: 10, TargetBpm: 100, StepBpm: 5, RepsPerStep: 3},
		{StartBpm: 80, TargetBpm: 500, StepBpm: 5, RepsPerStep: 3},
		{StartBpm: 100, TargetBpm: 80, StepBpm: 5, RepsPerStep: 3},
		{StartBpm: 80, TargetBpm: 100, StepBpm: 0.1, RepsPerStep: 3},
		{StartBpm: 80, TargetBpm: 100, StepBpm: 5, RepsPerStep: 0},
		{StartBpm: 80, TargetBpm: 100, StepBpm: 5, RepsPerStep: 99},
	}
	for i, c := range bad {
		if _, err := New().Start(c); err == nil {
			t.Errorf("case %d should be rejected", i)
		}
	}
	if _, err := New().Start(cfg()); err != nil {
		t.Fatal(err)
	}
}

func TestManualCleanRepetitionsStepTheTempoUp(t *testing.T) {
	tr := New()
	st, _ := tr.Start(cfg())
	if st.CurrentBpm != 80 || st.Needed != 3 || !st.Active {
		t.Fatalf("%+v", st)
	}
	for i := 1; i <= 2; i++ {
		st, stepped := tr.Clean()
		if stepped || st.Clean != i || st.CurrentBpm != 80 {
			t.Fatalf("rep %d: %+v stepped=%v", i, st, stepped)
		}
	}
	st, stepped := tr.Clean()
	if !stepped || st.CurrentBpm != 85 || st.Clean != 0 || st.Steps != 1 || st.LastEvent != "stepped up" {
		t.Fatalf("%+v stepped=%v", st, stepped)
	}
}

func TestMissResetsTheCleanCount(t *testing.T) {
	tr := New()
	tr.Start(cfg())
	tr.Clean()
	tr.Clean()
	if st := tr.Miss(); st.Clean != 0 {
		t.Fatalf("%+v", st)
	}
	tr.Clean()
	tr.Clean()
	if st, stepped := tr.Clean(); !stepped || st.CurrentBpm != 85 {
		t.Fatalf("three clean in a row after a miss should step: %+v", st)
	}
}

func TestTheTempoStopsAtTheTargetAndTheTrainerFinishes(t *testing.T) {
	tr := New()
	tr.Start(Config{StartBpm: 90, TargetBpm: 100, StepBpm: 7, RepsPerStep: 1})
	st, _ := tr.Clean()
	if st.CurrentBpm != 97 || st.Done {
		t.Fatalf("%+v", st)
	}
	st, stepped := tr.Clean()
	if !stepped || st.CurrentBpm != 100 || !st.Done || st.LastEvent != "target reached" {
		t.Fatalf("the last step is capped at the target: %+v", st)
	}
	if _, stepped := tr.Clean(); stepped {
		t.Fatal("nothing changes after the target is reached")
	}
}

func TestAutoCleanCountsEveryLoopPass(t *testing.T) {
	tr := New()
	c := cfg()
	c.AutoClean = true
	tr.Start(c)
	if _, stepped := tr.Clean(); stepped {
		t.Fatal("the manual button is ignored in auto mode")
	}
	var stepped bool
	var st State
	for i := 0; i < 3; i++ {
		st, stepped = tr.OnLoop()
	}
	if !stepped || st.CurrentBpm != 85 || st.Passes != 3 {
		t.Fatalf("%+v", st)
	}
}

func TestManualModeOnlyCountsPassesWithoutStepping(t *testing.T) {
	tr := New()
	tr.Start(cfg())
	for i := 0; i < 5; i++ {
		if _, stepped := tr.OnLoop(); stepped {
			t.Fatal("a loop pass alone is not a clean repetition in manual mode")
		}
	}
	if st := tr.State(); st.Passes != 5 || st.Clean != 0 || st.CurrentBpm != 80 {
		t.Fatalf("%+v", st)
	}
}

func TestStoppedTrainersIgnoreEvents(t *testing.T) {
	tr := New()
	tr.Start(cfg())
	tr.Stop()
	if _, stepped := tr.Clean(); stepped {
		t.Fatal("stopped")
	}
	if _, stepped := tr.OnLoop(); stepped {
		t.Fatal("stopped")
	}
	if st := tr.State(); st.Active || st.LastEvent != "stopped" {
		t.Fatalf("%+v", st)
	}
}

func TestStartingAtTheTargetFinishesImmediately(t *testing.T) {
	st, err := New().Start(Config{StartBpm: 100, TargetBpm: 100, StepBpm: 5, RepsPerStep: 2})
	if err != nil || !st.Done {
		t.Fatalf("%+v %v", st, err)
	}
}

func TestSpeedIsTheRatioToTheSongTempo(t *testing.T) {
	tr := New()
	tr.Start(cfg())
	if got := tr.Speed(160); got != 0.5 {
		t.Fatalf("got %v", got)
	}
	if tr.Speed(0) != 1 {
		t.Fatal("an unknown song tempo means normal speed")
	}
}
