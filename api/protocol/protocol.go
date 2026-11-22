package protocol

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

const Version = 1

const MaxFrameBytes = 4 << 20

var (
	ErrVersion   = errors.New("protocol version mismatch")
	ErrMalformed = errors.New("malformed frame")
	ErrTooLarge  = errors.New("frame too large")
)

type Kind int

const (
	KindRequest Kind = iota + 1
	KindResponse
	KindEvent
)

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string {
	return e.Code + ": " + e.Message
}

type Message struct {
	Kind   Kind
	ID     uint64
	Method string
	Params json.RawMessage
	OK     bool
	Result json.RawMessage
	Err    *Error
	Event  string
	Data   json.RawMessage
}

type wire struct {
	V      *int            `json:"v"`
	ID     *uint64         `json:"id"`
	Method *string         `json:"method"`
	Params json.RawMessage `json:"params"`
	OK     *bool           `json:"ok"`
	Result json.RawMessage `json:"result"`
	Error  *Error          `json:"error"`
	Event  *string         `json:"event"`
	Data   json.RawMessage `json:"data"`
}

func Decode(line []byte) (Message, error) {
	var w wire
	if err := json.Unmarshal(bytes.TrimSpace(line), &w); err != nil {
		return Message{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	if w.V == nil {
		return Message{}, fmt.Errorf("%w: missing version", ErrMalformed)
	}
	if *w.V != Version {
		return Message{}, fmt.Errorf("%w: got %d, want %d", ErrVersion, *w.V, Version)
	}
	switch {
	case w.Event != nil:
		return Message{Kind: KindEvent, Event: *w.Event, Data: w.Data}, nil
	case w.ID != nil && w.OK != nil:
		m := Message{Kind: KindResponse, ID: *w.ID, OK: *w.OK, Result: w.Result, Err: w.Error}
		if !m.OK && m.Err == nil {
			m.Err = &Error{Code: "unknown", Message: "engine reported failure without detail"}
		}
		return m, nil
	case w.ID != nil && w.Method != nil:
		return Message{Kind: KindRequest, ID: *w.ID, Method: *w.Method, Params: w.Params}, nil
	}
	return Message{}, fmt.Errorf("%w: neither request, response nor event", ErrMalformed)
}

func EncodeRequest(id uint64, method string, params any) ([]byte, error) {
	req := map[string]any{"v": Version, "id": id, "method": method}
	if params != nil {
		req["params"] = params
	}
	data, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func EncodeResponse(id uint64, result any) ([]byte, error) {
	data, err := json.Marshal(map[string]any{"v": Version, "id": id, "ok": true, "result": result})
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

func EncodeError(id uint64, code, message string) []byte {
	data, _ := json.Marshal(map[string]any{
		"v": Version, "id": id, "ok": false,
		"error": map[string]string{"code": code, "message": message},
	})
	return append(data, '\n')
}

func EncodeEvent(name string, data any) ([]byte, error) {
	out, err := json.Marshal(map[string]any{"v": Version, "event": name, "data": data})
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

type Reader struct {
	r *bufio.Reader
}

func NewReader(r io.Reader) *Reader {
	return &Reader{r: bufio.NewReaderSize(r, 64<<10)}
}

func (r *Reader) Next() ([]byte, error) {
	var line []byte
	for {
		chunk, err := r.r.ReadSlice('\n')
		line = append(line, chunk...)
		if len(line) > MaxFrameBytes {
			r.discardLine(err)
			return nil, ErrTooLarge
		}
		switch err {
		case nil:
			return line, nil
		case bufio.ErrBufferFull:
			continue
		case io.EOF:
			if len(bytes.TrimSpace(line)) > 0 {
				return line, nil
			}
			return nil, io.EOF
		default:
			return nil, err
		}
	}
}

func (r *Reader) discardLine(last error) {
	for last == bufio.ErrBufferFull {
		_, last = r.r.ReadSlice('\n')
	}
}
