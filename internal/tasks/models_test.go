package tasks

import "testing"

func TestBuildScheduledTaskPK(t *testing.T) {
	if got := BuildScheduledTaskPK("daily-summary"); got != "TASK#daily-summary" {
		t.Fatalf("BuildScheduledTaskPK() = %q", got)
	}
}
