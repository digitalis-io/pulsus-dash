// Package core holds the domain types shared by every BFF package (T06-001).
package core

import "github.com/google/uuid"

// OrgID identifies an organisation, the tenant boundary of every Postgres row (T11-002).
type OrgID uuid.UUID

// NewOrgID returns a new time-ordered organisation ID (UUIDv7, T11 §4.0).
func NewOrgID() (OrgID, error) {
	u, err := uuid.NewV7()
	if err != nil {
		return OrgID{}, err
	}
	return OrgID(u), nil
}

// String returns the canonical textual form of the ID.
func (o OrgID) String() string { return uuid.UUID(o).String() }

// IsZero reports whether the ID is the all-zero value, which never names an organisation.
func (o OrgID) IsZero() bool { return o == OrgID{} }

// NewID returns a new time-ordered row ID (UUIDv7, T11 §4.0).
func NewID() (uuid.UUID, error) { return uuid.NewV7() }
