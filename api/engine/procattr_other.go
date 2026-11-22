//go:build !windows

package engine

import "os/exec"

func applyProcAttr(cmd *exec.Cmd) {
	_ = cmd
}
