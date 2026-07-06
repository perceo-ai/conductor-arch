use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use tracing::{info, warn};
use uuid::Uuid;

use crate::archcar::protocol::{
    archcar_event_summary, archcar_request_summary, archcar_response_summary, ArchcarEvent,
    ArchcarRequest, ArchcarResponse, RpcEnvelope,
};
use crate::paths::AppPaths;

#[derive(Clone)]
pub struct ArchcarClient {
    socket_path: PathBuf,
}

impl ArchcarClient {
    pub fn from_paths(paths: &AppPaths) -> Self {
        Self {
            socket_path: paths.archcar_socket_path(),
        }
    }

    pub fn send(&self, request: ArchcarRequest) -> Result<ArchcarResponse> {
        let mut stream = self.connect_or_spawn()?;
        let request_summary = archcar_request_summary(&request);
        let envelope = RpcEnvelope {
            id: Uuid::new_v4().to_string(),
            payload: request,
        };
        let line = serde_json::to_string(&envelope)?;
        log_archcar_rpc(
            &self.socket_path,
            &envelope.id,
            "send",
            "request",
            request_summary,
            &line,
        );
        stream.write_all(line.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;

        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let response: RpcEnvelope<ArchcarResponse> = serde_json::from_str(&line)?;
        log_archcar_rpc(
            &self.socket_path,
            &response.id,
            "recv",
            "response",
            archcar_response_summary(&response.payload),
            line.trim_end(),
        );
        Ok(response.payload)
    }

    pub fn subscribe(&self) -> Result<std::sync::mpsc::Receiver<ArchcarEvent>> {
        let mut stream = self.connect_or_spawn()?;
        let envelope = RpcEnvelope {
            id: Uuid::new_v4().to_string(),
            payload: ArchcarRequest::Subscribe,
        };
        let line = serde_json::to_string(&envelope)?;
        log_archcar_rpc(
            &self.socket_path,
            &envelope.id,
            "send",
            "request",
            archcar_request_summary(&ArchcarRequest::Subscribe),
            &line,
        );
        stream.write_all(line.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        let (tx, rx) = std::sync::mpsc::channel();
        let socket_path = self.socket_path.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stream);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => match serde_json::from_str::<RpcEnvelope<ArchcarEvent>>(&line) {
                        Ok(event) => {
                            log_archcar_rpc(
                                &socket_path,
                                &event.id,
                                "recv",
                                "event",
                                archcar_event_summary(&event.payload),
                                line.trim_end(),
                            );
                            let _ = tx.send(event.payload);
                        }
                        Err(err) => {
                            warn!(
                                socket_path = %socket_path.display(),
                                error = %err,
                                bytes = line.len(),
                                "archcar unix rpc event decode failed"
                            );
                        }
                    },
                    Err(_) => break,
                }
            }
        });
        Ok(rx)
    }

    fn connect_or_spawn(&self) -> Result<UnixStream> {
        match UnixStream::connect(&self.socket_path) {
            Ok(stream) => Ok(stream),
            Err(first_err) => {
                self.spawn_sidecar()?;
                for _ in 0..20 {
                    match UnixStream::connect(&self.socket_path) {
                        Ok(stream) => return Ok(stream),
                        Err(_) => thread::sleep(Duration::from_millis(100)),
                    }
                }
                Err(first_err)
                    .with_context(|| format!("connect archcar {}", self.socket_path.display()))
            }
        }
    }

    fn spawn_sidecar(&self) -> Result<()> {
        let current_exe = std::env::current_exe().ok();
        let sibling = current_exe
            .as_ref()
            .map(|path| path.with_file_name("archcar"));
        let explicit = std::env::var_os("ARCHDUCTOR_ARCHCAR_BIN").map(PathBuf::from);
        let mut last_err = None;
        for (candidate, args) in explicit
            .into_iter()
            .map(|path| (path, Vec::<&str>::new()))
            .chain(
                current_exe
                    .clone()
                    .into_iter()
                    .map(|path| (path, vec!["--archcar-serve"])),
            )
            .chain(sibling.into_iter().map(|path| (path, Vec::<&str>::new())))
            .chain(std::iter::once((
                PathBuf::from("archcar"),
                Vec::<&str>::new(),
            )))
        {
            match Command::new(&candidate)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(_) => return Ok(()),
                Err(err) => last_err = Some((candidate, err)),
            }
        }
        let (candidate, err) = last_err.context("no archcar binary candidate available")?;
        Err(err).with_context(|| format!("spawn archcar binary {}", candidate.display()))
    }
}

fn log_archcar_rpc(
    socket_path: &Path,
    rpc_id: &str,
    direction: &str,
    message_type: &str,
    summary: String,
    raw_payload: &str,
) {
    if let Some(payload) = archcar_rpc_log_payload(raw_payload) {
        info!(
            socket_path = %socket_path.display(),
            %rpc_id,
            direction,
            message_type,
            summary = %summary,
            payload,
            "archcar unix rpc"
        );
    } else {
        info!(
            socket_path = %socket_path.display(),
            %rpc_id,
            direction,
            message_type,
            summary = %summary,
            "archcar unix rpc"
        );
    }
}

fn archcar_rpc_log_payload(raw_payload: &str) -> Option<&str> {
    std::env::var("ARCHDUCTOR_LOG_ARCHCAR_PAYLOADS")
        .map(|value| {
            matches!(
                value.as_str(),
                "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"
            )
        })
        .unwrap_or(false)
        .then_some(raw_payload)
}
