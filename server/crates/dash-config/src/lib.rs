//! Strict, layered configuration of the `pulsus-dash` binary (T06-019, T06 §4.9, T19-010).
//!
//! Layers, lowest first: the YAML `--config` file, `PULSUS_DASH_*` environment variables, then
//! command-line flags. Unknown keys are errors. See `docs/server/configuration.md`.

mod error;
mod layer;
mod model;
mod secret;

pub use error::{ConfigError, Source};
pub use layer::{ConfigInput, LoadedConfig, load};
pub use model::{
    BasicCredentials, DatasourceSeed, LogConfig, LogFormat, MigrateConfig, PgConnect, Role,
    ServeConfig,
};
pub use secret::{SecretRef, resolve_postgres_url};
