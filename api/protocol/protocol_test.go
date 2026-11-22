package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestRequestRoundTrip(t *testing.T) {
	line, err := EncodeRequest(42, "hello", map[string]int{"protocol": 1})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasSuffix(line, []byte("\n")) {
		t.Fatal("frame must end with a newline")
	}
	m, err := Decode(line)
	if err != nil {
		t.Fatal(err)
	}
	if m.Kind != KindRequest || m.ID != 42 || m.Method != "hello" {
		t.Fatalf("unexpected message %+v", m)
	}
	var params map[string]int
	if err := json.Unmarshal(m.Params, &params); err != nil || params["protocol"] != 1 {
		t.Fatalf("params lost: %v %v", params, err)
	}
}

func TestResponseDecoding(t *testing.T) {
	ok, err := Decode([]byte(`{"v":1,"id":3,"ok":true,"result":{"a":1}}`))
	if err != nil || ok.Kind != KindResponse || !ok.OK || ok.ID != 3 {
		t.Fatalf("ok response: %+v %v", ok, err)
	}
	bad, err := Decode(EncodeError(4, "boom", "it broke"))
	if err != nil || bad.OK || bad.Err == nil || bad.Err.Code != "boom" {
		t.Fatalf("error response: %+v %v", bad, err)
	}
}

func TestFailureWithoutDetailStillCarriesAnError(t *testing.T) {
	m, err := Decode([]byte(`{"v":1,"id":5,"ok":false}`))
	if err != nil || m.Err == nil {
		t.Fatalf("expected a synthesised error, got %+v %v", m, err)
	}
}

func TestEventDecoding(t *testing.T) {
	line, _ := EncodeEvent("meters", map[string]float64{"peak": 0.5})
	m, err := Decode(line)
	if err != nil || m.Kind != KindEvent || m.Event != "meters" {
		t.Fatalf("event: %+v %v", m, err)
	}
}

func TestVersionMismatchIsDistinguishable(t *testing.T) {
	_, err := Decode([]byte(`{"v":2,"id":1,"ok":true}`))
	if !errors.Is(err, ErrVersion) {
		t.Fatalf("want ErrVersion, got %v", err)
	}
}

func TestMalformedFrames(t *testing.T) {
	for _, in := range []string{`not json`, `{}`, `{"v":1}`, `{"v":1,"id":1}`, `[]`} {
		if _, err := Decode([]byte(in)); !errors.Is(err, ErrMalformed) {
			t.Errorf("%q: want ErrMalformed, got %v", in, err)
		}
	}
}

func TestReaderSplitsFramesAndHandlesFinalLineWithoutNewline(t *testing.T) {
	r := NewReader(strings.NewReader("a\nb\nc"))
	var got []string
	for {
		line, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, strings.TrimSpace(string(line)))
	}
	if strings.Join(got, ",") != "a,b,c" {
		t.Fatalf("got %v", got)
	}
}

func TestReaderHandlesFramesLargerThanTheBufferAndRejectsHugeOnes(t *testing.T) {
	big := strings.Repeat("x", 200<<10)
	r := NewReader(strings.NewReader(big + "\nnext\n"))
	line, err := r.Next()
	if err != nil || len(bytes.TrimSpace(line)) != len(big) {
		t.Fatalf("large frame: len=%d err=%v", len(line), err)
	}
	if line, err = r.Next(); err != nil || strings.TrimSpace(string(line)) != "next" {
		t.Fatalf("follow-up: %q %v", line, err)
	}

	huge := strings.Repeat("y", MaxFrameBytes+10)
	r = NewReader(strings.NewReader(huge + "\nafter\n"))
	if _, err := r.Next(); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
	line, err = r.Next()
	if err != nil || strings.TrimSpace(string(line)) != "after" {
		t.Fatalf("reader did not resync: %q %v", line, err)
	}
}
