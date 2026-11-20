package core

import "sync"

// PartitionState is the audit partition health that /readyz reports (T11-021). The maintenance
// loop records every run; the gateway reads Check.
type PartitionState struct {
	mu       sync.Mutex
	ran      bool
	failures int // consecutive failed runs
	horizon  int // last known horizon in months
	known    bool
}

// Record stores the outcome of one maintenance run: horizon is valid only when known; err is the
// run's error, nil on success. An unknown horizon keeps the previous one.
func (s *PartitionState) Record(horizon int, known bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ran = true
	if known {
		s.horizon, s.known = horizon, true
	}
	if err != nil {
		s.failures++
	} else {
		s.failures = 0
	}
}

// Failures returns the number of consecutive failed runs.
func (s *PartitionState) Failures() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.failures
}

// Horizon returns the last known horizon and whether one is known.
func (s *PartitionState) Horizon() (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.horizon, s.known
}

// Check is a stub.
func (s *PartitionState) Check() string { return "" }
