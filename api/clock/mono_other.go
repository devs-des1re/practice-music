//go:build !windows

package clock

import "time"

var epoch = time.Now()

func MonoUs() int64 {
	return time.Since(epoch).Microseconds()
}
