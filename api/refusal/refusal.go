package refusal

import (
	"errors"
	"fmt"

	"github.com/kratejs/krate/packages/native/krate"
)

const Code = "refused"

type Error struct {
	message string
	cause   error
}

func New(message string) error {
	return &Error{message: message}
}

func Errorf(format string, args ...any) error {
	formatted := fmt.Errorf(format, args...)
	return &Error{message: formatted.Error(), cause: errors.Unwrap(formatted)}
}

func (e *Error) Error() string {
	return e.message
}

func (e *Error) Unwrap() error {
	return e.cause
}

func (e *Error) As(target any) bool {
	coded, ok := target.(**krate.Error)
	if ok {
		*coded = &krate.Error{Code: Code, Message: e.message}
	}
	return ok
}
