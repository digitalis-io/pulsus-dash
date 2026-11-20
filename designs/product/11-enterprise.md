# 11 — Enterprise: access, identity, audit, persistence

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.1-rc · 2026-11-20 |
| **Requirement area** | `ENT` |
| **Source draft** | plans/11-enterprise.md (not tracked) |
| **Depends on** | [01a](01a-audiences-and-perspectives.md), [02](02-information-architecture.md), [06](06-ai-copilot.md), [07](07-alerting.md), [09](09-performance-contract.md), [15](15-estate-navigation.md) |
| **Decisions applied** | [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0009](../adr/0009-optional-object-storage.md) (Proposed), [ADR-0011](../adr/0011-terraform-provider-in-go.md) (Proposed), [ADR-0012](../adr/0012-derived-state-in-postgres.md) (Accepted), [ADR-0013](../adr/0013-metrics-data-scopes.md) (**pending**, open decision O1), D3 licence |
| **Technical designs** | T10 auth & data scopes (draft), [T11](../technical/T11-postgres-schema.md), [T18](../technical/T18-security.md), [T19](../technical/T19-deployment.md), [pulsusdb-requirements](../technical/pulsusdb-requirements.md) (R12, R16) |
| **Mockups** | [02 Atlas topology](../mockups/22-topology-3d.svg) (restricted nodes) · [18 NOC wall](../mockups/24-noc-wall-3d.svg) (kiosk) |

## 1. Purpose & scope

This document specifies, as users and administrators experience them:
- the permission model: organisations, teams, roles, resource scoping and data scopes (§3);
- identity: SSO, provisioning, tokens and kiosks (§4);
- audit (§5);
- what Dash persists in PostgreSQL and where large artefacts go (§6);
- versioning and config-as-code (§7);
- multi-tenancy and deployment (§8).

Mechanisms (query rewriting, session handling, the schema) are in T10 (draft),
[T11](../technical/T11-postgres-schema.md), [T18](../technical/T18-security.md) and
[T19](../technical/T19-deployment.md).

## 2. Definitions

| Term | Meaning |
|---|---|
| **Organisation** | The top-level customer account. Contains teams, users, service accounts and tenant bindings |
| **Tenant** | A PulsusDB database / tenant that the organisation's data lives in, selected by `X-Pulsus-Database` |
| **Principal** | A user, service account, API token, kiosk or the AI agent acting as one of these |
| **Permission** | A fine-grained capability such as `board:write`, `alert:silence`, `ai:act`, `data:logs:read` |
| **Role** | A named set of permissions |
| **Data scope** | Which tenants, environments, entities and label selectors a principal can query |
| **Metric family** | All series of one metric name |
| **Coverage meter** | The per-viewport statement of how complete the shown data is ([09](09-performance-contract.md)) |

## 3. Permission model

### 3.1 Structure and roles

**Table 3.1 — Built-in roles**

| Role | Can |
|---|---|
| Viewer | Read boards, Lenses, alerts, investigations within their data scope |
| Responder | Viewer + acknowledge, silence, investigate |
| Editor | Responder + create and edit boards, Lens templates, alert rules |
| Admin | Editor + manage users, teams, roles, data scopes, contact points, policies, AI settings |

#### ENT-001 — Organisations, teams and users
**MUST** · M-UI6 · Admin

Dash MUST model **Organisation → Teams → Users**, with users able to belong to several teams.

*Acceptance:* Given an organisation with teams payments and platform, when a user is added to both,
then resources owned by either team are listed for them under "My teams".

#### ENT-002 — Service accounts
**MUST** · M-UI6 · Admin, Platform

Dash MUST provide service accounts for automation, kiosks and the auto-RCA identity. A service account
MUST have roles and a data scope like a user, and no interactive login.

*Acceptance:* Given a service account with role Responder, when it is used by an automation token to
ack an alert, then the ack succeeds and is audit-logged under the service account; an interactive
login as the service account is refused.

#### ENT-003 — Built-in roles
**MUST** · M-UI6 · Admin

Dash MUST ship the roles of Table 3.1.

*Acceptance:* Given a Viewer, when they try to ack an alert, then the Ack control is disabled with a
"request access" link (ENT-010); given a Responder, the ack succeeds; given an Editor, saving a board
succeeds; only an Admin can open user management.

#### ENT-004 — Custom roles
**MUST** · M-UI6 · Admin

Admins MUST be able to define custom roles from fine-grained permissions (e.g. `board:write`,
`alert:silence`, `ai:act`, `data:logs:read`).

*Acceptance:* Given a custom role with `alert:silence` but not `alert:ack`, when a user with it opens
an alert, then Silence is enabled and Ack is disabled.

#### ENT-005 — Resource scoping
**MUST** · M-UI6 · Admin, Engineer

Boards MUST be scoped by folder, and alert rules and Lens templates by team. Permissions MUST be
grantable per folder and per team.

*Acceptance:* Given folder "Payments" granted Editor to team payments only, when a platform-team
Editor opens a board in it, then it is read-only for them.

### 3.2 Data scopes

The data scope is the enterprise must-have. Scoped users must not see data outside their scope, on
any surface, through any path, including the AI agent ([06](06-ai-copilot.md)).

#### ENT-006 — Scoped users see no out-of-scope data
**MUST** · M-UI6 · Admin, Support, Business

A principal's data scope MUST define which tenants, environments, entities and label selectors it can
query. Scoped users MUST NOT see out-of-scope data, on any signal (metrics, logs, traces, profiles,
derived state such as alert history and anomaly scores), in any view, export, API or AI answer.
Enforcement MUST be in the BFF by query rewriting (injected matchers) and response filtering, never by
hiding UI. It MUST apply equally to humans, service accounts, tokens and the AI agent.

*Acceptance:* Given a user scoped to `env=staging`, when they run a query for `env=prod` in the
workbench, call the API directly with the same query, open the Atlas, and ask the copilot about prod,
then every path returns only staging data (or none), and no prod value, entity name or count is
present in any response body.

#### ENT-007 — Metrics scopes on labels, fail closed per family (O1 pending)
**MUST** · M-UI6 · Admin, Platform

> **Pending decision:** this requirement specifies the user-visible behaviour of option B of
> [ADR-0013](../adr/0013-metrics-data-scopes.md), which is the recommended default but is **not yet
> decided** (open decision O1). If the product owner chooses otherwise, this requirement is
> revised; ENT-006 holds under every option.

For metrics, a scope attribute (e.g. `deployment.environment`, `k8s.namespace.name`) MUST be enforced
on metric **labels**. Dash MUST check, per metric family, that every scope attribute is present as a
label:
- families where it is present MUST be returned filtered by the scope;
- families where it is absent MUST **fail closed**: no series of that family are returned to the
  scoped principal;
- the coverage meter of every affected viewport MUST explain the gap (which families were withheld
  and why) and show the collector-side fix (copying resource attributes onto metric labels, e.g. OTel
  `resource_to_telemetry_conversion`, or a PulsusDB promotion list per R16).

A `target_info` join MUST NOT be used to enforce a scope; it MAY be used for display only.

*Acceptance:* Given a user scoped to `k8s.namespace.name=payments`, and family
`http_server_duration` carrying label `k8s_namespace_name` while `jvm_memory_used` does not, when the
user opens a payments Lens, then `http_server_duration` shows only payments series,
`jvm_memory_used` shows no data, and the coverage meter reads that `jvm_memory_used` is withheld
because the scope label is missing, with a link to the collector fix.

#### ENT-008 — Field-level controls
**MUST** · M-UI6 · Admin, Support

Dash MUST support field-level controls: log body visibility, PII attribute masking, and gating of
customer-identifier lookups (Support Perspective). Gated lookups MUST be audited.

*Acceptance:* Given a scope with log bodies hidden, when the user opens a log stream, then each line
shows "‹body restricted›" and line filters on the body are rejected; given a Support user looking up
customer ACME, the lookup appears in the audit log.

#### ENT-009 — Out-of-scope entities in the Atlas
**MUST** · M-UI6 · Admin, Platform, NOC

Entities outside a principal's scope MUST be handled in the Atlas and every topology by an org-level
policy: **omit**, or **show as anonymous dependency** ("external · restricted") with no id or name, so
the topology still makes sense. Health of restricted entities MUST be hidden unless the org opts in.

*Acceptance:* Given policy "anonymous" and a user scoped to checkout, when the Atlas shows checkout's
dependency on payments, then payments renders as "external · restricted" with no name and neutral
health; with policy "omit", the node and edge are absent.

#### ENT-010 — No dead "Access denied" pages
**MUST** · M-UI6 · Engineer, Business, Support, Admin

Out-of-scope or unpermitted items MUST be absent, or rendered restricted with a "request access"
action that notifies the owning team. List endpoints MUST filter by permission rather than return
items and hide them. Dash MUST NOT show a dead "Access denied" page.

*Acceptance:* Given a user following a link to a board they cannot read, when it opens, then a
restricted placeholder with "Request access" is shown, and clicking it notifies the board's owning
team; the board's title is not revealed.

## 4. Identity

#### ENT-011 — OIDC SSO with IdP-enforced MFA
**MUST** · M-UI6 · Admin

Dash MUST support OIDC SSO. MFA MUST be enforced by the IdP; Dash MUST honour the IdP's
authentication context and not implement its own MFA.

*Acceptance:* Given an OIDC IdP requiring MFA, when a user logs in, then the IdP's MFA prompt is the
only second factor and Dash creates a session on success.

#### ENT-012 — SAML SSO
**MUST** · M-UI6 · Admin

Dash MUST support SAML 2.0 SSO.

*Acceptance:* Given a SAML IdP, when a user logs in, then a session is created; an unsigned or
replayed assertion is rejected.

#### ENT-013 — SCIM provisioning
**MUST** · M-UI6 · Admin

Dash MUST support SCIM 2.0 provisioning of users and groups. Deprovisioning a user MUST revoke all
their sessions and tokens within 5 s.

*Acceptance:* Given a user with an open session, when the IdP sets `active=false` over SCIM, then
their next request after 5 s is rejected and their API tokens are revoked.

#### ENT-014 — Group to team and role mapping
**MUST** · M-UI6 · Admin

IdP groups MUST map to teams and roles, applied at every login (and at every SCIM push). A role
granted by the IdP MUST be labelled "managed by IdP" and not editable in Dash.

*Acceptance:* Given IdP group `payments-oncall` mapped to team payments as Responder, when a member
logs in, then they are in team payments with Responder, and the role shows "managed by IdP".

#### ENT-015 — API tokens
**MUST** · M-UI6 · Admin, Platform

API tokens MUST have an expiry and scopes (permissions and data scope), and MUST act with no more than
their owner's permissions.

*Acceptance:* Given a token with scope `board:read` expiring tomorrow, when it is used to save a
board, then the request is refused; after expiry, every request is refused.

#### ENT-016 — Kiosk tokens
**MUST** · M-UI6 · NOC, Admin

Kiosk tokens MUST be read-only and limited to a single scene or playlist, and MAY be IP-bound. Kiosks
MUST be paired without typing a secret on the wall (the wall shows a code that an admin approves), and
a view thrown onto a wall MUST render under the kiosk's own principal and scope.

*Acceptance:* Given a wall showing pairing code `K7Q2-M9XD`, when an admin approves it for playlist
"NOC main" from Admin → Kiosks, then the wall shows the playlist; any write request from the wall is
refused; throwing a view whose scope exceeds the kiosk's is refused.

## 5. Audit

#### ENT-017 — Append-only audit log
**MUST** · M-UI4 · Admin

Dash MUST keep an append-only audit log, in Postgres, of: config changes (with diff), AI tool calls,
silences, acknowledgements and actions taken. From M-UI6 it MUST also record exports and data access
(who queried which entity and time range, sampled or full per policy).

*Acceptance:* Given a rule edit, a silence, an ack, an action and an RCA, when the audit log is
queried, then each appears with actor, time and (for the edit) the diff; an attempt by any role,
including Admin, to modify or delete an entry fails.

#### ENT-018 — Audit viewer
**MUST** · M-UI4 · Admin

Admins MUST have an audit viewer with filters (actor, action, resource, time).

*Acceptance:* Given 10 000 audit events, when an admin filters actor=sam and action=silence, then
only Sam's silences are listed.

#### ENT-019 — SIEM export
**MUST** · M-UI6 · Admin

The audit log MUST be exportable to a SIEM over syslog or OTLP logs. The OTLP sink MAY be a PulsusDB
tenant chosen by the operator; this is the only product data, besides Dash's self-telemetry, that
Dash writes to PulsusDB, and only when configured.

*Acceptance:* Given an OTLP export sink configured, when an audit event is written, then it arrives at
the sink; with no sink configured, Dash writes no audit data to PulsusDB.

## 6. What lives in PostgreSQL

Per [ADR-0006](../adr/0006-pulsusdb-and-postgres.md) and
[ADR-0012](../adr/0012-derived-state-in-postgres.md), all configuration and all Dash-derived state are
in PostgreSQL, in tenant-scoped tables under row-level security. DDL is in
[T11](../technical/T11-postgres-schema.md).

**Table 6.1 — Postgres domains**

| Domain | Tables (indicative) |
|---|---|
| Identity & access | orgs, teams, users, memberships, roles, permissions, data_scopes, api_tokens, sessions, kiosks |
| Content | folders, boards, board_versions, lens_templates, lens_overrides, perspectives, waypoints, playlists |
| Entities | entity_overrides (names, owners, tier, runbooks), entity_schema, label_mappings, journeys |
| Alerting | alert_rules, rule_versions, slos, contact_points, routing_trees, silences, maintenance_windows, mute_timings, alert_instances, incidents; alert transitions and notification attempts in time-partitioned tables ([07](07-alerting.md)) |
| Derived state | anomaly baselines and scores, change events, fallback pyramids (time-partitioned) |
| Investigations | investigations, evidence, notes, hypotheses, participants, timeline_events, postmortems |
| AI | ai_sessions, tool_call_log, feedback, incident_embeddings (pgvector), ai_policies |
| Prefs | user_preferences (theme, density, keymap, perspective, home), notification_prefs |
| Audit | audit_events (partitioned by month) |

**Table 6.2 — Default retention of time-partitioned state** (per tenant, configurable)

| Data | Default retention |
|---|---|
| Alert transitions, notification attempts | 13 months |
| Anomaly scores (5-minute resolution per entity × signal) | 30 days |
| Fallback pyramids | 7 days, regenerated on demand |
| Audit events | Per org policy |

#### ENT-020 — Configuration and derived state in Postgres
**MUST** · M-UI6 · Admin, Platform

All configuration and Dash-derived state (Table 6.1) MUST be stored in Postgres in tenant-scoped
tables under row-level security. Time-partitioned tables MUST enforce per-tenant retention (Table 6.2)
by dropping partitions, and MUST NOT require a Postgres extension (an operator MAY enable one).

*Acceptance:* Given two tenants, when a session for tenant A queries any Table 6.1 table directly
through the application role, then no tenant B row is returned; given default retention, alert
transitions older than 13 months are not present.

#### ENT-021 — Large artefacts in optional object storage
**MAY** · M-UI4 · Admin, Platform

Large artefacts (AI tool-call payloads, snapshots, flight-recorder blobs) MAY be stored in optional
S3-compatible object storage ([ADR-0009](../adr/0009-optional-object-storage.md)), with Postgres
keeping the references. Without object storage, they MUST be stored in Postgres.

*Acceptance:* Given object storage configured, when a snapshot is taken, then its blob is in the
bucket and Postgres holds its reference; with none configured, the snapshot is stored in Postgres and
reopens identically.

## 7. Versioning & config-as-code

#### ENT-022 — Versioned content with diff and restore
**MUST** · M-UI5 · Engineer, Platform, Admin

Boards, Lens templates, Perspectives, alert rules, SLOs and Journeys MUST be versioned, with diff
between any two versions and restore. (Alert rule versions are required earlier, at M-UI4, by
[07](07-alerting.md).)

*Acceptance:* Given a board with three versions, when the user diffs v1 and v3 and restores v1, then
the diff lists changed panels and the restore creates v4 equal to v1.

#### ENT-023 — YAML export
**MUST** · M-UI5 · Engineer, Platform

Every versioned object of ENT-022 MUST be exportable as YAML and re-importable without loss.

*Acceptance:* Given a board, when it is exported to YAML and imported into a new folder, then the
imported board is identical apart from its id and folder.

#### ENT-024 — Git sync
**MUST** · M-UI6 · Platform, Admin

Dash MUST offer optional bidirectional, PR-based Git sync for the objects of ENT-022.

*Acceptance:* Given a folder synced to a repository, when a board is edited in the UI, then a PR is
opened with the YAML change; when a commit changing a rule is merged, the rule is updated in Dash.

#### ENT-025 — Managed-by-Git badge and conflicting edits
**MUST** · M-UI6 · Engineer, Platform

Objects managed by Git (or Terraform) MUST show a "managed by Git" badge, and a UI edit MUST either be
blocked or create a PR, never silently diverge from the repository.

*Acceptance:* Given a Git-managed board, when an Editor saves a change in the UI, then a PR is created
(or the save is blocked, per folder policy) and the live board is unchanged until the PR is merged.

#### ENT-026 — Terraform provider
**MUST** · M-UI6 · Platform

Dash MUST offer a Terraform provider ([ADR-0011](../adr/0011-terraform-provider-in-go.md)) for the
objects of ENT-022, plus contact points, routing, silences and data scopes.

*Acceptance:* Given a Terraform configuration declaring a contact point and a rule, when `terraform
apply` runs, then both exist in Dash with the "managed by Terraform" badge, and `terraform plan`
afterwards shows no changes.

## 8. Multi-tenancy & deployment

> **Note:** the repository is licensed **AGPL-3.0** (D3), like PulsusDB. Self-hosted and air-gapped
> installs run the same AGPL-3.0 build.

#### ENT-027 — One deployment, many PulsusDB tenants
**MUST** · M-UI1 · Admin, Platform

One Pulsus Dash deployment MUST be able to front multiple PulsusDB clusters and tenants, selected per
request via `X-Pulsus-Database`.

*Acceptance:* Given an organisation bound to two PulsusDB databases, when the user switches tenant in
the Context, then subsequent queries carry the other `X-Pulsus-Database` value and return that
tenant's data.

#### ENT-028 — Single binary, static assets, Helm
**MUST** · M-UI1 · Platform

Dash MUST deploy as a single Go binary that embeds the static web-client assets
([ADR-0015](../adr/0015-go-bff.md)), plus the optional server-side chart renderer image, with a Helm
chart.

*Acceptance:* Given a Kubernetes cluster with Postgres reachable, when the Helm chart is installed
with default values, then Dash serves the application shell as the fixed local principal, with no
login page until authentication lands (M-UI6, D12).

#### ENT-029 — High availability
**MUST** · M-UI4 · Platform

Dash MUST support HA via stateless replicas behind a load balancer, Postgres HA, and a leader-elected
alert evaluator ([T16](../technical/T16-alert-evaluator.md)).

*Acceptance:* Given three replicas, when one is killed during evaluation, then no alert evaluation is
missed for more than one interval, no duplicate notification is sent, and sessions continue on the
remaining replicas.

#### ENT-030 — Air-gapped installs
**MUST** · M-UI6 · Platform, Admin

Air-gapped installs MUST be supported, including self-hosted AI models ([06](06-ai-copilot.md)).

*Acceptance:* Given an install with no egress, when Dash starts and the full test suite runs, then
all features pass with a self-hosted model and no outbound connection is attempted.

## 9. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| [ENT-001](#ent-001--organisations-teams-and-users) | Organisations, teams and users | MUST | M-UI6 |
| [ENT-002](#ent-002--service-accounts) | Service accounts | MUST | M-UI6 |
| [ENT-003](#ent-003--built-in-roles) | Built-in roles | MUST | M-UI6 |
| [ENT-004](#ent-004--custom-roles) | Custom roles | MUST | M-UI6 |
| [ENT-005](#ent-005--resource-scoping) | Resource scoping | MUST | M-UI6 |
| [ENT-006](#ent-006--scoped-users-see-no-out-of-scope-data) | Scoped users see no out-of-scope data | MUST | M-UI6 |
| [ENT-007](#ent-007--metrics-scopes-on-labels-fail-closed-per-family-o1-pending) | Metrics scopes on labels, fail closed per family (O1 pending) | MUST | M-UI6 |
| [ENT-008](#ent-008--field-level-controls) | Field-level controls | MUST | M-UI6 |
| [ENT-009](#ent-009--out-of-scope-entities-in-the-atlas) | Out-of-scope entities in the Atlas | MUST | M-UI6 |
| [ENT-010](#ent-010--no-dead-access-denied-pages) | No dead "Access denied" pages | MUST | M-UI6 |
| [ENT-011](#ent-011--oidc-sso-with-idp-enforced-mfa) | OIDC SSO with IdP-enforced MFA | MUST | M-UI6 |
| [ENT-012](#ent-012--saml-sso) | SAML SSO | MUST | M-UI6 |
| [ENT-013](#ent-013--scim-provisioning) | SCIM provisioning | MUST | M-UI6 |
| [ENT-014](#ent-014--group-to-team-and-role-mapping) | Group to team and role mapping | MUST | M-UI6 |
| [ENT-015](#ent-015--api-tokens) | API tokens | MUST | M-UI6 |
| [ENT-016](#ent-016--kiosk-tokens) | Kiosk tokens | MUST | M-UI6 |
| [ENT-017](#ent-017--append-only-audit-log) | Append-only audit log | MUST | M-UI4 |
| [ENT-018](#ent-018--audit-viewer) | Audit viewer | MUST | M-UI4 |
| [ENT-019](#ent-019--siem-export) | SIEM export | MUST | M-UI6 |
| [ENT-020](#ent-020--configuration-and-derived-state-in-postgres) | Configuration and derived state in Postgres | MUST | M-UI6 |
| [ENT-021](#ent-021--large-artefacts-in-optional-object-storage) | Large artefacts in optional object storage | MAY | M-UI4 |
| [ENT-022](#ent-022--versioned-content-with-diff-and-restore) | Versioned content with diff and restore | MUST | M-UI5 |
| [ENT-023](#ent-023--yaml-export) | YAML export | MUST | M-UI5 |
| [ENT-024](#ent-024--git-sync) | Git sync | MUST | M-UI6 |
| [ENT-025](#ent-025--managed-by-git-badge-and-conflicting-edits) | Managed-by-Git badge and conflicting edits | MUST | M-UI6 |
| [ENT-026](#ent-026--terraform-provider) | Terraform provider | MUST | M-UI6 |
| [ENT-027](#ent-027--one-deployment-many-pulsusdb-tenants) | One deployment, many PulsusDB tenants | MUST | M-UI1 |
| [ENT-028](#ent-028--single-binary-static-assets-helm) | Single binary, static assets, Helm | MUST | M-UI1 |
| [ENT-029](#ent-029--high-availability) | High availability | MUST | M-UI4 |
| [ENT-030](#ent-030--air-gapped-installs) | Air-gapped installs | MUST | M-UI6 |

## 10. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Alert history in Postgres (D2); metrics scopes per ADR-0013 option B (pending O1); licence note (D3) |
| 1.0-rc2 | 2026-11-19 | Decision D8: ENT-028 is a single Go binary with embedded client assets ([ADR-0015](../adr/0015-go-bff.md)) |
| 1.1-rc | 2026-11-20 | Decision D12 (owner): authentication deferred. ENT-001, ENT-003, ENT-011 and ENT-020 and their dependents ENT-002, ENT-005, ENT-010, ENT-014 and ENT-015 move to M-UI6; ENT-028's acceptance serves the application shell as the fixed local principal, with no login page until M-UI6; note 5 updated |

## Resolved during formalisation

1. **Alert history store (D2).** The draft's Alerting row said alert state history goes to PulsusDB
   with a 30-day Postgres hot copy, and that large time-series-ish data may move to ClickHouse via
   PulsusDB. Both removed: history is time-partitioned in Postgres with 13-month retention (Table 6.1,
   6.2, ENT-020); large artefacts go to optional object storage (ENT-021).
2. **SIEM export.** "OTLP logs → PulsusDB itself" kept only as an operator-configured sink, the
   permitted exception to D2 (ENT-019).
3. **Metrics data scopes (O1).** Stated as the outcome requirement (ENT-006) plus option B behaviour
   (ENT-007), marked pending.
4. **"Request access" target.** The draft said it "notifies the owning team" without saying who
   owns a board; ENT-010 uses the folder's owning team.
5. **Milestones** were not in the draft. Assigned from the roadmap and T10 (draft) rollout: audit of
   config + AI M-UI4; authentication M-UI6 (D12, 2026-11-20): OIDC, organisations, teams and users,
   built-in roles, service accounts, tokens, team/folder bindings, group mapping and request access,
   with data scopes, SAML, SCIM, custom roles, kiosks, data-access audit, SIEM, Git sync and
   Terraform. Until then every request runs as a fixed local principal, which is also the audit
   actor (ENT-017, ENT-018).
6. **Gaps filled:** SCIM deprovisioning time (5 s), kiosk pairing, IdP-managed role labelling, and
   restricted-entity health hidden by default, all from T10 (draft).
7. **Retention table** (6.2) added from ADR-0012's reference figures.
