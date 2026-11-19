# PostgreSQL 15 with every extension except plpgsql removed: proves T11-001 (no required
# extension) in `cargo xtask ci itest` (itest:no-extensions).
FROM postgres:15
RUN find /usr/share/postgresql/15/extension -type f ! -name 'plpgsql*' -delete
