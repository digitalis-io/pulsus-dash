//! `cargo xtask serve`: the dev server with the T03 §5.7 headers (plan §4.9). Stub: answers 404.

use std::path::PathBuf;

use crate::{R, XtaskError};

/// Dev server options.
#[derive(Debug, Clone)]
pub struct ServeOptions {
    pub root: PathBuf,
    pub port: u16,
    pub isolation: bool,
}

pub fn headers(_path: &str, _isolation: bool) -> Vec<(&'static str, String)> {
    Vec::new()
}

pub fn serve(o: &ServeOptions, ready: Option<std::sync::mpsc::Sender<u16>>) -> R<()> {
    let server = tiny_http::Server::http(("localhost", o.port)).map_err(|e| XtaskError::Tool {
        command: "serve".into(),
        detail: e.to_string(),
    })?;
    if let (Some(tx), Some(a)) = (ready, server.server_addr().to_ip()) {
        let _ = tx.send(a.port());
    }
    for rq in server.incoming_requests() {
        let _ = rq.respond(tiny_http::Response::from_string("stub").with_status_code(404));
    }
    Ok(())
}
