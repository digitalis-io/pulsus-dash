package config

import (
	"errors"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// Require is not implemented yet.
func (c *Config) Require(cmd Command) error { return errors.New("not implemented") }

// SeedSettings is not implemented yet.
func (c *Config) SeedSettings() (core.BootstrapSeed, error) {
	return core.BootstrapSeed{}, errors.New("not implemented")
}

// ValidateRoles is not implemented yet.
func ValidateRoles(roles []string) error { return errors.New("not implemented") }
