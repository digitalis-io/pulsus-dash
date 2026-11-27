-- name: GetInstallState :one
SELECT bootstrap_org_id, seeded_at FROM install_state WHERE singleton;

-- name: InsertInstallState :exec
INSERT INTO install_state (singleton, bootstrap_org_id) VALUES (true, $1);

-- name: InsertOrg :exec
INSERT INTO orgs (id, slug, name) VALUES ($1, $2, $3);

-- name: InsertTenantBinding :exec
INSERT INTO tenant_bindings (org_id, id, slug, datasource_url, database, scope_org_id, credentials_ref) VALUES ($1, $2, $3, $4, sqlc.narg(database), sqlc.narg(scope_org_id), sqlc.narg(credentials_ref));

-- name: ListTenantBindings :many
SELECT org_id, id, slug, datasource_url, database, scope_org_id, credentials_ref, kind, scope_seq FROM tenant_bindings WHERE org_id = $1 ORDER BY slug;

-- name: GetOrg :one
SELECT id, slug, name FROM orgs WHERE id = $1;
