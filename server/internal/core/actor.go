package core

import "github.com/google/uuid"

// ActorKind says what kind of principal performed an action.
type ActorKind string

// ActorLocal is the fixed local principal until authentication lands (D12, M-UI6).
const ActorLocal ActorKind = "local"

// LocalPrincipalID is the user id of the fixed local principal in stars, recent_views and audit
// rows: 00000000-0000-0000-0000-000000000001.
var LocalPrincipalID = uuid.UUID{15: 1}

// Actor is the principal of a write: the author of a board version and the actor of an audit event.
type Actor struct {
	Kind ActorKind
	ID   uuid.UUID
}

// LocalActor returns the fixed local principal.
func LocalActor() Actor { return Actor{Kind: ActorLocal, ID: LocalPrincipalID} }

// DisplayName is the name the API shows for the actor: "Local user" for the local principal,
// "Unknown" otherwise.
func (a Actor) DisplayName() string {
	if a.Kind == ActorLocal {
		return "Local user"
	}
	return "Unknown"
}

// RequestCtx (request.go) carries the actor of every service call.
