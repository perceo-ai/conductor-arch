use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use tracing::{error, info, warn};
use uuid::Uuid;

use crate::archcar::harness::{managed_harness_for_kind, provider_name};
use crate::archcar::harness_contract::{HarnessControl, RequiredHarnessFeature};
use crate::archcar::harness_contract::{
    ProviderInteractionKind, ProviderInteractionResolution as InteractionResolution,
};
use crate::archcar::protocol::{
    archcar_event_summary, archcar_request_summary, archcar_response_summary,
    ArchcarChatLiveSession, ArchcarChatSnapshot, ArchcarChatThread, ArchcarChatTranscriptMessage,
    ArchcarChatTranscriptSummary, ArchcarChecksSummary, ArchcarContextPlan, ArchcarEvent,
    ArchcarMessage, ArchcarProcessSummary, ArchcarProjectionItem, ArchcarRepositorySummary,
    ArchcarRequest, ArchcarResponse, ArchcarRunScript, ArchcarWorkspaceSummary, QueuedArchcarInput,
    RpcEnvelope, WorkspaceChangeScope, WorkspaceGitAction,
};
use crate::archcar::remote;
use crate::archcar::session::{
    restore_managed_session, spawn_managed_session, spawn_managed_session_for_thread,
    SessionCommand, SessionHandle,
};
use crate::archcar::transport::{self, DuplexStream, LocalListener};
use crate::paths::AppPaths;
use crate::provider_events::ProviderEventStore;
use crate::provider_interactions::{ProviderInteractionRecord, ProviderInteractionStore};
use crate::provider_projection::{
    provider_projection_from_records, provider_projection_item_is_relevant_chat_event,
    provider_projection_item_text,
};
use crate::repository::{AddRepository, RepositoryStore};
use crate::session_state::AgentSessionState;
use crate::workspace::WorkspaceStatusLine;
use crate::workspace::{CreateWorkspace, SessionKind, WorkspaceStore};

pub struct ArchcarServer {
    listener: LocalListener,
    endpoint_path: PathBuf,
    /// Optional token-guarded TCP listener for clients that are not on this
    /// machine. Off unless the operator asked for it.
    remote: Option<RemoteListener>,
    state: Arc<Mutex<ServerState>>,
}

struct RemoteListener {
    listener: std::net::TcpListener,
    token: String,
    addr: std::net::SocketAddr,
}

struct ServerState {
    db_path: PathBuf,
    logs_dir: PathBuf,
    shutting_down: bool,
    queued_defaults: HashSet<String>,
    queued_threads: HashSet<i64>,
    draining_threads: HashSet<i64>,
    /// Threads whose drain was requested while a drain was already running.
    /// Without this, the second request is dropped and its input sits in the
    /// queue until some later event happens to trigger another drain.
    drain_reruns: HashSet<i64>,
    sessions: HashMap<i64, SessionHandle>,
    subscribers: Vec<Sender<ArchcarEvent>>,
}

/// How often the daemon advances background development tasks.
const BACKGROUND_TASK_TICK: Duration = Duration::from_secs(10);

struct QueueDrainGuard {
    state: Arc<Mutex<ServerState>>,
    thread_id: i64,
}

impl QueueDrainGuard {
    fn begin(state: &Arc<Mutex<ServerState>>, thread_id: i64) -> Option<Self> {
        let mut guard = state.lock().ok()?;
        if !guard.draining_threads.insert(thread_id) {
            // A drain is already running for this thread; record the request so
            // the running drain re-runs instead of losing the wakeup.
            guard.drain_reruns.insert(thread_id);
            return None;
        }
        guard.drain_reruns.remove(&thread_id);
        drop(guard);
        Some(Self {
            state: Arc::clone(state),
            thread_id,
        })
    }
}

impl Drop for QueueDrainGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.draining_threads.remove(&self.thread_id);
        }
    }
}

pub fn reconcile_managed_sessions_on_startup(paths: &AppPaths) -> Result<()> {
    let store = WorkspaceStore::open_app_with_logs(&paths.database_path, &paths.logs_dir)?;
    let provider_events = ProviderEventStore::new(&paths.database_path);
    for workspace in store.list()? {
        let records = store.list_sessions(&workspace.name)?;
        for kind in [SessionKind::Codex, SessionKind::Claude] {
            for record in persisted_running_session_candidates(&records, kind) {
                if !is_archcar_managed_persisted_session(&record, &paths.logs_dir) {
                    continue;
                }
                if archcar_process_alive(record.pid) {
                    continue;
                }
                let interrupted = provider_events.interrupt_active_turns_for_process(
                    record.id,
                    "Archcar stopped before the provider turn completed.",
                )?;
                if interrupted > 0 {
                    let _ = store.mark_session_process_stopped(record.id, None)?;
                } else {
                    let _ = store.mark_session_process_exited(record.id, None)?;
                }
            }
        }
    }
    Ok(())
}

fn archcar_process_alive(pid: u32) -> bool {
    crate::platform::process_alive(pid)
}

impl ArchcarServer {
    pub fn bind(paths: AppPaths) -> Result<Self> {
        fs::create_dir_all(&paths.state_dir)?;
        if let Err(err) = WorkspaceStore::open_app_with_logs(&paths.database_path, &paths.logs_dir)
            .and_then(|store| {
                store.recover_workspace_lifecycle_jobs()?;
                store.reconcile_script_processes()?;
                Ok(())
            })
        {
            warn!(error = %err, "archcar workspace recovery failed");
        }
        let endpoint_path = paths.archcar_endpoint_path();
        if let Some(parent) = endpoint_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let listener = transport::bind(&endpoint_path)
            .with_context(|| format!("bind archcar endpoint {}", endpoint_path.display()))?;
        let remote = match remote::listen_addr_from_env() {
            Some(Ok(addr)) => Some(bind_remote_listener(&paths, addr)?),
            Some(Err(err)) => return Err(err),
            None => None,
        };
        let state = Arc::new(Mutex::new(ServerState {
            db_path: paths.database_path,
            logs_dir: paths.logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));
        Ok(Self {
            listener,
            endpoint_path,
            remote,
            state,
        })
    }

    pub fn serve(mut self) -> Result<()> {
        let shutdown = Arc::new(AtomicBool::new(false));
        spawn_queued_input_startup_sweep(&self.state);
        spawn_background_task_supervisor(&self.state, Arc::clone(&shutdown));
        if let Some(remote) = self.remote.take() {
            spawn_remote_listener(remote, &self.state, Arc::clone(&shutdown));
        }
        let shutdown_for_signal = Arc::clone(&shutdown);
        ctrlc::set_handler(move || {
            shutdown_for_signal.store(true, Ordering::SeqCst);
        })
        .context("install archcar shutdown handler")?;
        self.listener.set_nonblocking(true)?;
        let mut handlers = Vec::new();
        let mut serve_error = None;

        while !shutdown.load(Ordering::SeqCst) {
            match transport::accept(&self.listener, &self.endpoint_path) {
                Ok((stream, _)) => {
                    let state = self.state.clone();
                    handlers.push(std::thread::spawn(move || {
                        let _ = handle_connection(stream, state);
                    }));
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(err) => {
                    serve_error = Some(anyhow!(err));
                    break;
                }
            }
        }

        begin_shutdown(&self.state);
        for handler in handlers {
            let _ = handler.join();
        }
        let shutdown_result = shutdown_managed_sessions(&self.state, "Archcar is shutting down.");
        match (serve_error, shutdown_result) {
            (Some(err), Ok(())) => Err(err),
            (Some(err), Err(cleanup_err)) => {
                Err(err.context(format!("archcar cleanup also failed: {cleanup_err:#}")))
            }
            (None, result) => result,
        }
    }
}

fn bind_remote_listener(paths: &AppPaths, addr: std::net::SocketAddr) -> Result<RemoteListener> {
    let token = remote::ensure_token(paths)?;
    let listener = remote::bind(addr)?;
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;
    if remote::is_public_addr(&addr) {
        warn!(
            %addr,
            token_path = %remote::token_path(paths).display(),
            "archcar is listening on a non-loopback address; the access token is the only guard"
        );
    } else {
        info!(%addr, "archcar remote listener bound to loopback");
    }
    Ok(RemoteListener {
        listener,
        token,
        addr,
    })
}

/// Serve token-authenticated TCP clients alongside the local endpoint. Failed
/// handshakes are dropped quietly; one bad client must not stop the daemon.
fn spawn_remote_listener(
    remote: RemoteListener,
    state: &Arc<Mutex<ServerState>>,
    shutdown: Arc<AtomicBool>,
) {
    let state = Arc::clone(state);
    std::thread::spawn(move || {
        while !shutdown.load(Ordering::SeqCst) {
            match remote::accept_authenticated(&remote.listener, &remote.token) {
                Ok(Some((stream, peer))) => {
                    info!(%peer, listener = %remote.addr, "archcar remote client authenticated");
                    if let Err(err) = stream.set_nonblocking(false) {
                        warn!(error = %err, "archcar remote stream setup failed");
                        continue;
                    }
                    let state = Arc::clone(&state);
                    std::thread::spawn(move || {
                        let _ = handle_connection(stream, state);
                    });
                }
                Ok(None) => {}
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(err) => {
                    warn!(error = %err, "archcar remote listener accept failed");
                    break;
                }
            }
        }
    });
}

/// Workspaces whose live agent sessions are mid-turn. A managed session keeps
/// its process alive between turns, so only the runtime state distinguishes
/// "still working" from "waiting for the next prompt".
fn busy_agent_workspaces(state: &Arc<Mutex<ServerState>>) -> HashSet<String> {
    let guard = state.lock().unwrap();
    guard
        .sessions
        .values()
        .filter_map(|handle| {
            let snapshot = handle.snapshot.lock().ok()?.clone();
            let busy = matches!(
                snapshot.runtime_state,
                AgentSessionState::Starting
                    | AgentSessionState::Running
                    | AgentSessionState::Streaming
                    | AgentSessionState::ToolRunning
            );
            busy.then_some(snapshot.workspace)
        })
        .collect()
}

/// Workspaces that have a live session handle at all, busy or not. If a
/// workspace has one, its runtime state is authoritative and the database's
/// process rows must not be consulted.
fn workspaces_with_live_sessions(state: &Arc<Mutex<ServerState>>) -> HashSet<String> {
    let guard = state.lock().unwrap();
    guard
        .sessions
        .values()
        .filter_map(|handle| Some(handle.snapshot.lock().ok()?.workspace.clone()))
        .collect()
}

fn tick_background_tasks(
    state: &Arc<Mutex<ServerState>>,
) -> Result<Vec<crate::background_tasks::BackgroundTask>> {
    let (db_path, logs_dir) = {
        let guard = state.lock().unwrap();
        (guard.db_path.clone(), guard.logs_dir.clone())
    };
    let busy = busy_agent_workspaces(state);
    let live = workspaces_with_live_sessions(state);
    let store = WorkspaceStore::open_app_with_logs(&db_path, &logs_dir)?;
    let advanced = store.tick_background_tasks_with(|workspace| {
        if live.contains(workspace) {
            return busy.contains(workspace);
        }
        store.workspace_has_active_agent(workspace).unwrap_or(false)
    })?;
    // Every advance is broadcast so clients can refresh their strips and
    // notify the user when a task reaches ready/failed.
    if !advanced.is_empty() {
        {
            let mut guard = state.lock().unwrap();
            for task in &advanced {
                broadcast(
                    &mut guard,
                    ArchcarEvent::BackgroundTaskUpdated { task: task.clone() },
                );
            }
        }
        // Background progress is summary evidence too.
        let workspaces: std::collections::BTreeSet<String> = advanced
            .iter()
            .filter_map(|task| task.workspace_name.clone())
            .collect();
        for workspace in workspaces {
            refresh_workspace_context_after_change(state, &workspace, None);
        }
    }
    Ok(advanced)
}

/// Periodically advance background development tasks: once an agent goes idle,
/// checks run, the summary is written, and (when asked) a pull request opens —
/// without a human at the keyboard.
fn spawn_background_task_supervisor(state: &Arc<Mutex<ServerState>>, shutdown: Arc<AtomicBool>) {
    let state = Arc::clone(state);
    std::thread::spawn(move || {
        while !shutdown.load(Ordering::SeqCst) {
            std::thread::sleep(BACKGROUND_TASK_TICK);
            if shutdown.load(Ordering::SeqCst) || state.lock().unwrap().shutting_down {
                break;
            }
            match tick_background_tasks(&state) {
                Ok(tasks) if !tasks.is_empty() => {
                    for task in tasks {
                        info!(
                            background_task = task.id,
                            status = %task.status,
                            "background task advanced"
                        );
                    }
                }
                Ok(_) => {}
                Err(err) => warn!(error = %err, "background task tick failed"),
            }
        }
    });
}

/// Deliver messages that were queued before this daemon started.
///
/// The queue is durable, but drains are event-driven: without this sweep a
/// message queued right before a restart (or one whose session died) waits for
/// an event that will never arrive, and the chat shows it stuck in "Queued"
/// forever. Runs off-thread so binding the socket is not delayed by session
/// spawns.
fn spawn_queued_input_startup_sweep(state: &Arc<Mutex<ServerState>>) {
    let state = Arc::clone(state);
    std::thread::spawn(move || drain_every_queued_chat_thread(&state));
}

fn drain_every_queued_chat_thread(state: &Arc<Mutex<ServerState>>) {
    let db_path = match state.lock() {
        Ok(guard) => guard.db_path.clone(),
        Err(_) => return,
    };
    let thread_ids = match WorkspaceStore::open_app(&db_path)
        .and_then(|store| store.list_queued_chat_thread_ids())
    {
        Ok(thread_ids) => thread_ids,
        Err(err) => {
            warn!(error = %format!("{err:#}"), "archcar could not list queued chat threads at startup");
            return;
        }
    };
    if thread_ids.is_empty() {
        return;
    }
    info!(
        threads = thread_ids.len(),
        "archcar delivering chat inputs queued before startup"
    );
    for thread_id in thread_ids {
        if state
            .lock()
            .map(|guard| guard.shutting_down)
            .unwrap_or(true)
        {
            return;
        }
        drain_queued_input_for_thread(state, thread_id);
    }
}

fn handle_connection<S: DuplexStream>(stream: S, state: Arc<Mutex<ServerState>>) -> Result<()> {
    let mut writer = stream.try_clone_stream()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    if line.trim().is_empty() {
        return Ok(());
    }
    let envelope: RpcEnvelope<ArchcarRequest> = serde_json::from_str(&line)?;
    log_archcar_rpc(
        &envelope.id,
        "recv",
        "request",
        archcar_request_summary(&envelope.payload),
        line.trim_end(),
    );
    match envelope.payload {
        ArchcarRequest::Subscribe => {
            let (tx, rx) = mpsc::channel();
            register_subscriber_with_snapshot(&mut state.lock().unwrap(), tx);
            spawn_queued_input_startup_sweep(&state);
            while let Ok(event) = rx.recv() {
                let envelope = RpcEnvelope {
                    id: Uuid::new_v4().to_string(),
                    payload: event,
                };
                let line = serde_json::to_string(&envelope)?;
                log_archcar_rpc(
                    &envelope.id,
                    "send",
                    "event",
                    archcar_event_summary(&envelope.payload),
                    &line,
                );
                writer.write_all(line.as_bytes())?;
                writer.write_all(b"\n")?;
                writer.flush()?;
            }
        }
        request => {
            let response = dispatch_request(request, &state);
            let envelope = RpcEnvelope {
                id: envelope.id,
                payload: response,
            };
            let line = serde_json::to_string(&envelope)?;
            log_archcar_rpc(
                &envelope.id,
                "send",
                "response",
                archcar_response_summary(&envelope.payload),
                &line,
            );
            writer.write_all(line.as_bytes())?;
            writer.write_all(b"\n")?;
            writer.flush()?;
        }
    }
    Ok(())
}

fn log_archcar_rpc(
    rpc_id: &str,
    direction: &str,
    message_type: &str,
    summary: String,
    raw_payload: &str,
) {
    if let Some(payload) = archcar_rpc_log_payload(raw_payload) {
        info!(
            %rpc_id,
            direction,
            message_type,
            summary = %summary,
            payload = %payload,
            "archcar local rpc"
        );
    } else {
        info!(
            %rpc_id,
            direction,
            message_type,
            summary = %summary,
            "archcar local rpc"
        );
    }
}

fn archcar_rpc_log_payload(raw_payload: &str) -> Option<String> {
    archcar_rpc_log_payload_for_flag(
        raw_payload,
        crate::env_flags::enabled("ARCHDUCTOR_LOG_ARCHCAR_PAYLOADS"),
    )
}

fn archcar_rpc_log_payload_for_flag(raw_payload: &str, enabled: bool) -> Option<String> {
    enabled.then(|| crate::redaction::redact_sensitive_text(raw_payload))
}

fn dispatch_request(request: ArchcarRequest, state: &Arc<Mutex<ServerState>>) -> ArchcarResponse {
    if archcar_request_is_mutating(&request) && state.lock().unwrap().shutting_down {
        return ArchcarResponse::Error {
            message: "archcar is shutting down".to_owned(),
        };
    }
    let response = match request {
        ArchcarRequest::EnsureWorkspaceDefaultSession {
            workspace,
            kind,
            harness,
        } => ensure_default_session(state, workspace, kind, harness.unwrap_or_default()),
        ArchcarRequest::EnsureChatThreadSession {
            workspace,
            thread_id,
            kind,
            harness,
        } => ensure_chat_thread_session(
            state,
            workspace,
            thread_id,
            kind,
            harness.unwrap_or_default(),
        ),
        ArchcarRequest::SpawnSession {
            workspace,
            kind,
            harness,
        } => spawn_session(state, workspace, kind, harness.unwrap_or_default()),
        ArchcarRequest::SendInput {
            session_id,
            input,
            visible_input,
            kind,
            delivery,
        } => match load_or_restore_session_handle(state, session_id) {
            Ok(Some(handle)) => {
                if let Err(err) = validate_send_input_delivery(&handle, &kind, delivery) {
                    return ArchcarResponse::Error {
                        message: err.to_string(),
                    };
                }
                match handle
                    .command_tx
                    .send(crate::archcar::session::SessionCommand::SendInput {
                        input,
                        visible_input,
                        kind,
                        delivery,
                    }) {
                    Ok(_) => ArchcarResponse::Ack,
                    Err(err) => ArchcarResponse::Error {
                        message: err.to_string(),
                    },
                }
            }
            Ok(None) => ArchcarResponse::Error {
                message: format!("unknown session {session_id}"),
            },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::InterruptTurn { session_id } => {
            match load_or_restore_session_handle(state, session_id) {
                Ok(Some(handle)) => {
                    let kind = handle.snapshot.lock().ok().map(|snapshot| snapshot.kind);
                    let interrupt_supported =
                        kind.and_then(managed_harness_for_kind)
                            .is_some_and(|harness| {
                                harness
                                    .descriptor()
                                    .required_features
                                    .contains(&RequiredHarnessFeature::Interrupt)
                            });
                    if !interrupt_supported {
                        return ArchcarResponse::Error {
                            message: format!(
                                "interrupt_turn is not supported for session kind {kind:?}"
                            ),
                        };
                    }
                    match handle
                        .command_tx
                        .send(crate::archcar::session::SessionCommand::InterruptTurn)
                    {
                        Ok(_) => ArchcarResponse::Ack,
                        Err(err) => ArchcarResponse::Error {
                            message: err.to_string(),
                        },
                    }
                }
                Ok(None) => ArchcarResponse::Error {
                    message: format!("unknown session {session_id}"),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::SetSessionModel { session_id, model } => {
            send_session_control(state, session_id, HarnessControl::SetModel(model))
        }
        ArchcarRequest::SetSessionEffort { session_id, effort } => {
            send_session_control(state, session_id, HarnessControl::SetEffort(effort))
        }
        ArchcarRequest::SetSessionFastMode {
            session_id,
            fast_mode,
        } => send_session_control(state, session_id, HarnessControl::SetFastMode(fast_mode)),
        ArchcarRequest::SetSessionPermissionMode { session_id, mode } => send_session_control(
            state,
            session_id,
            HarnessControl::SetPermissionMode(Some(mode)),
        ),
        ArchcarRequest::ResizeSession {
            session_id,
            rows,
            cols,
        } => match load_or_restore_session_handle(state, session_id) {
            Ok(Some(handle)) => {
                match handle
                    .command_tx
                    .send(crate::archcar::session::SessionCommand::Resize { rows, cols })
                {
                    Ok(_) => ArchcarResponse::Ack,
                    Err(err) => ArchcarResponse::Error {
                        message: err.to_string(),
                    },
                }
            }
            Ok(None) => ArchcarResponse::Error {
                message: format!("unknown session {session_id}"),
            },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::GetSessionStatus { session_id } => {
            match load_or_restore_session_handle(state, session_id) {
                Ok(Some(handle)) => {
                    let snapshot = handle.snapshot.lock().unwrap().clone();
                    ArchcarResponse::SessionStatus {
                        session_id,
                        status: snapshot.status.as_str().to_owned(),
                        runtime_state: snapshot.runtime_state,
                        ready: snapshot.ready,
                        capabilities: snapshot.capabilities,
                    }
                }
                Ok(None) => ArchcarResponse::Error {
                    message: format!("unknown session {session_id}"),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetSessionScreen { session_id } => {
            match load_or_restore_session_handle(state, session_id) {
                Ok(Some(handle)) => {
                    let snapshot = handle.snapshot.lock().unwrap().clone();
                    ArchcarResponse::SessionScreen {
                        session_id,
                        screen: snapshot.screen,
                    }
                }
                Ok(None) => ArchcarResponse::Error {
                    message: format!("unknown session {session_id}"),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetSessionMessages { thread_id } => {
            let db_path = state.lock().unwrap().db_path.clone();
            // Rendering applies any agent naming directive, so this read can
            // rename the workspace or retitle the chat.
            let before = thread_naming_snapshot(&db_path, thread_id);
            let response = match session_messages_for_thread(&db_path, thread_id) {
                Ok(messages) => ArchcarResponse::SessionMessages {
                    thread_id,
                    messages,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            };
            broadcast_naming_changes(state, &db_path, thread_id, before);
            response
        }
        ArchcarRequest::GetChatSnapshot { thread_id } => {
            let (db_path, live_session) = {
                let guard = state.lock().unwrap();
                (
                    guard.db_path.clone(),
                    live_session_snapshot_for_thread(&guard, thread_id),
                )
            };
            let before = thread_naming_snapshot(&db_path, thread_id);
            let response = match chat_snapshot_for_thread(&db_path, thread_id, live_session) {
                Ok(snapshot) => ArchcarResponse::ChatSnapshot { snapshot },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            };
            broadcast_naming_changes(state, &db_path, thread_id, before);
            response
        }
        ArchcarRequest::QueueChatInput {
            thread_id,
            input,
            visible_input,
            kind,
            session_kind,
        } => queue_chat_input(state, thread_id, input, visible_input, kind, session_kind),
        ArchcarRequest::ListQueuedChatInputs { thread_id } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|store| store.list_queued_chat_inputs(thread_id))
            {
                Ok(inputs) => ArchcarResponse::QueuedChatInputs {
                    thread_id,
                    inputs: inputs
                        .into_iter()
                        .map(queued_archcar_input_from_record)
                        .collect(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::RemoveQueuedChatInput { queue_id } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|store| store.delete_queued_chat_input(queue_id))
            {
                Ok(Some(input)) => {
                    broadcast(
                        &mut state.lock().unwrap(),
                        ArchcarEvent::ChatQueueUpdated {
                            thread_id: input.thread_id,
                        },
                    );
                    ArchcarResponse::QueuedChatInput {
                        input: queued_archcar_input_from_record(input),
                    }
                }
                Ok(None) => ArchcarResponse::Error {
                    message: format!("unknown queued chat input {queue_id}"),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::MoveQueuedChatInput { queue_id, up } => {
            let db_path = state.lock().unwrap().db_path.clone();
            let result = WorkspaceStore::open_app(&db_path).and_then(|store| {
                match store.move_queued_chat_input(queue_id, up)? {
                    Some(thread_id) => {
                        let inputs = store.list_queued_chat_inputs(thread_id)?;
                        Ok(Some((thread_id, inputs)))
                    }
                    None => Ok(None),
                }
            });
            match result {
                Ok(Some((thread_id, inputs))) => {
                    broadcast(
                        &mut state.lock().unwrap(),
                        ArchcarEvent::ChatQueueUpdated { thread_id },
                    );
                    ArchcarResponse::QueuedChatInputs {
                        thread_id,
                        inputs: inputs
                            .into_iter()
                            .map(queued_archcar_input_from_record)
                            .collect(),
                    }
                }
                Ok(None) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::SaveChatPaste { thread_id, text } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|store| store.save_thread_paste_attachment(thread_id, &text))
            {
                Ok(saved) => ArchcarResponse::ChatPasteSaved {
                    relative_path: saved.relative_path,
                    label: "pasted text".to_owned(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::KillSession { session_id } => {
            match load_or_restore_session_handle(state, session_id) {
                Ok(Some(handle)) => {
                    match handle
                        .command_tx
                        .send(crate::archcar::session::SessionCommand::Kill)
                    {
                        Ok(_) => ArchcarResponse::Ack,
                        Err(err) => ArchcarResponse::Error {
                            message: err.to_string(),
                        },
                    }
                }
                Ok(None) => ArchcarResponse::Error {
                    message: format!("unknown session {session_id}"),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetInventorySnapshot => {
            let db_path = state.lock().unwrap().db_path.clone();
            match inventory_snapshot(&db_path) {
                Ok((repositories, workspaces, chat_threads)) => {
                    ArchcarResponse::InventorySnapshot {
                        repositories,
                        workspaces,
                        chat_threads,
                    }
                }
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListWorkspaces => {
            let db_path = state.lock().unwrap().db_path.clone();
            match workspace_summaries(&db_path) {
                Ok(workspaces) => ArchcarResponse::Workspaces { workspaces },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListRepositories => {
            let db_path = state.lock().unwrap().db_path.clone();
            match repository_summaries(&db_path) {
                Ok(repositories) => ArchcarResponse::Repositories { repositories },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListChatThreads { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match chat_threads_for_workspace(&db_path, &workspace) {
                Ok(threads) => ArchcarResponse::ChatThreads { workspace, threads },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetChatProjection { thread_id } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match ProviderEventStore::new(&db_path).list_for_chat_thread(thread_id) {
                Ok(records) => {
                    let projection = provider_projection_from_records(&records);
                    ArchcarResponse::ChatProjection {
                        thread_id,
                        items: crate::provider_projection::drop_echoed_user_messages(
                            projection.items,
                        )
                        .into_iter()
                        // Drop parser noise (MCP loading/loaded, skill/diff
                        // duplicates, fallback + irrelevant status cards) so the
                        // desktop timeline matches the GTK surface.
                        .filter(provider_projection_item_is_relevant_chat_event)
                        .map(|item| ArchcarProjectionItem {
                            id: item.id,
                            sequence: item.sequence,
                            render_class: item.render_class.as_str().to_owned(),
                            role_label: item.render_class.role_label().to_owned(),
                            title: item.title,
                            body: item.body,
                            status: item.status.as_str().to_owned(),
                            stream_state: item.stream_state.as_str().to_owned(),
                        })
                        .collect(),
                    }
                }
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListChatTranscripts { workspace, limit } => {
            let db_path = state.lock().unwrap().db_path.clone();
            let limit = limit.unwrap_or(crate::workspace::DEFAULT_CHAT_TRANSCRIPT_LIMIT);
            match WorkspaceStore::open_app(&db_path)
                .and_then(|store| store.list_chat_transcripts(&workspace, limit))
            {
                Ok(transcripts) => ArchcarResponse::ChatTranscripts {
                    workspace,
                    transcripts: transcripts
                        .into_iter()
                        .map(|t| ArchcarChatTranscriptSummary {
                            thread_id: t.thread_id,
                            title: t.title,
                            provider: t.provider,
                            message_count: t.message_count,
                            updated_at: t.updated_at,
                        })
                        .collect(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetChatTranscript { thread_id } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|store| {
                let thread = store.get_chat_thread_record(thread_id)?;
                let messages = store.chat_transcript_messages(thread_id)?;
                Ok((thread, messages))
            }) {
                Ok((thread, messages)) => ArchcarResponse::ChatTranscript {
                    thread_id,
                    title: thread.title,
                    messages: messages
                        .into_iter()
                        .map(|m| ArchcarChatTranscriptMessage {
                            role: m.role,
                            content: m.content,
                            created_at: m.created_at,
                        })
                        .collect(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListContextPlans { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|store| store.list_context_plans(&workspace))
            {
                Ok(plans) => ArchcarResponse::ContextPlans {
                    workspace,
                    plans: plans
                        .into_iter()
                        .map(|plan| ArchcarContextPlan {
                            name: plan.name,
                            path: plan.path,
                            title: plan.title,
                        })
                        .collect(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListWorkspaceFiles { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|store| store.list_files(&workspace, 400))
            {
                Ok(files) => ArchcarResponse::WorkspaceFiles { workspace, files },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ReadWorkspaceFile { workspace, path } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| s.read_file(&workspace, &path)) {
                Ok(content) => ArchcarResponse::WorkspaceFileContent {
                    workspace,
                    path,
                    content,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::WriteWorkspaceFile {
            workspace,
            path,
            content,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.write_file(&workspace, &path, &content))
            {
                Ok(()) => ArchcarResponse::WorkspaceFileWritten { workspace, path },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetWorkspaceChanges { workspace, scope } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|store| match &scope {
                WorkspaceChangeScope::All => store.all_file_change_summaries(&workspace),
                WorkspaceChangeScope::Uncommitted => store.diff_file_summaries(&workspace),
                WorkspaceChangeScope::Commit { sha } => {
                    store.file_summaries_for_commit(&workspace, sha)
                }
            }) {
                Ok(files) => ArchcarResponse::WorkspaceChanges {
                    workspace,
                    scope,
                    files,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetWorkspaceDiff {
            workspace,
            path,
            scope,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|store| {
                scoped_workspace_diff(&store, &workspace, path.as_deref(), &scope)
            }) {
                Ok(diff) => ArchcarResponse::WorkspaceDiff { workspace, diff },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListTodos { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| s.list_todos(&workspace)) {
                Ok(todos) => ArchcarResponse::Todos { workspace, todos },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::AddTodo { workspace, text } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| s.add_todo(&workspace, &text)) {
                Ok(todo) => ArchcarResponse::TodoAdded { todo },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListCheckpoints { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| s.checkpoint_list(&workspace)) {
                Ok(checkpoints) => ArchcarResponse::Checkpoints {
                    workspace,
                    checkpoints,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::CreateCheckpoint { workspace, message } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.checkpoint_create(&workspace, &message, None))
            {
                Ok(checkpoint) => ArchcarResponse::CheckpointSaved { checkpoint },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::CompareCheckpoint {
            workspace,
            checkpoint_id,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.checkpoint_compare(&workspace, checkpoint_id))
            {
                Ok((diff, truncated)) => ArchcarResponse::CheckpointDiff {
                    workspace,
                    checkpoint_id,
                    diff,
                    truncated,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::RestoreCheckpoint {
            workspace,
            checkpoint_id,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.checkpoint_restore(&workspace, checkpoint_id))
            {
                Ok(checkpoint) => ArchcarResponse::CheckpointSaved { checkpoint },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetWorkspaceProcesses { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path) {
                Ok(store) => ArchcarResponse::WorkspaceProcesses {
                    text: workspace_processes_text(&store, &workspace),
                    workspace,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListWorkspaceTimeline { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.workspace_timeline(&workspace, None))
            {
                Ok(events) => ArchcarResponse::WorkspaceTimeline {
                    workspace,
                    events: events
                        .into_iter()
                        .map(|e| crate::archcar::protocol::ArchcarTimelineEvent {
                            id: e.id,
                            kind: e.kind,
                            summary: e.summary,
                            created_at: e.created_at,
                        })
                        .collect(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListWorkspaceConflicts { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.find_conflicting_workspaces(&workspace))
            {
                Ok(rows) => ArchcarResponse::WorkspaceConflicts {
                    workspace,
                    conflicts: rows
                        .into_iter()
                        .map(|(workspace, files)| {
                            crate::archcar::protocol::ArchcarWorkspaceConflict { workspace, files }
                        })
                        .collect(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListLinkedDirectories { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.list_linked_directories(&workspace))
            {
                Ok(rows) => ArchcarResponse::LinkedDirectories {
                    workspace,
                    directories: rows
                        .into_iter()
                        .map(|d| crate::archcar::protocol::ArchcarLinkedDirectory {
                            target_workspace: d.target_workspace_name,
                            link_path: d.link_path.to_string_lossy().into_owned(),
                            created_at: d.created_at,
                        })
                        .collect(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetRecentCommits { workspace, limit } => {
            let db_path = state.lock().unwrap().db_path.clone();
            let n = limit.unwrap_or(20).clamp(1, 200) as usize;
            match WorkspaceStore::open_app(&db_path).and_then(|s| s.git_log_oneline(&workspace, n))
            {
                Ok(log) => ArchcarResponse::RecentCommits { workspace, log },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetCommitMessageDraft { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.commit_message_draft(&workspace))
            {
                Ok(message) => ArchcarResponse::CommitMessageDraft { workspace, message },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetCommitDiff {
            workspace,
            commit,
            path,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| match path.as_deref() {
                Some(path) => s.commit_diff(&workspace, &commit, Some(Path::new(path))),
                None => s.git_show_commit(&workspace, &commit),
            }) {
                Ok(diff) => ArchcarResponse::CommitDiff {
                    workspace,
                    commit,
                    diff,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::RunWorkspaceScript { workspace } => {
            let (db_path, logs_dir) = {
                let s = state.lock().unwrap();
                (s.db_path.clone(), s.logs_dir.clone())
            };
            match WorkspaceStore::open_app_with_logs(&db_path, &logs_dir)
                .and_then(|s| s.run_workspace(&workspace))
            {
                Ok(process) => ArchcarResponse::RunScriptStarted {
                    workspace,
                    pid: process.pid,
                    log_path: process.log_path.to_string_lossy().into_owned(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::StopWorkspaceScript { workspace } => {
            let (db_path, logs_dir) = {
                let s = state.lock().unwrap();
                (s.db_path.clone(), s.logs_dir.clone())
            };
            match WorkspaceStore::open_app_with_logs(&db_path, &logs_dir)
                .and_then(|s| s.stop_workspace(&workspace))
            {
                Ok(process) => ArchcarResponse::RunScriptStopped {
                    workspace,
                    pid: process.pid,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetRunLog { workspace } => {
            let (db_path, logs_dir) = {
                let s = state.lock().unwrap();
                (s.db_path.clone(), s.logs_dir.clone())
            };
            match WorkspaceStore::open_app_with_logs(&db_path, &logs_dir)
                .and_then(|s| s.read_latest_run_log(&workspace))
            {
                Ok(log) => ArchcarResponse::RunLog { workspace, log },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetCheckLog { workspace } => {
            let (db_path, logs_dir) = {
                let s = state.lock().unwrap();
                (s.db_path.clone(), s.logs_dir.clone())
            };
            match WorkspaceStore::open_app_with_logs(&db_path, &logs_dir)
                .and_then(|s| s.read_latest_check_log(&workspace))
            {
                Ok(log) => ArchcarResponse::CheckLog { workspace, log },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetPullRequestReadiness { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.pull_request_readiness_text(&workspace))
            {
                Ok(text) => ArchcarResponse::PullRequestReadiness { workspace, text },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetWorkspaceGitActionPrompt { workspace, action } => {
            let db_path = state.lock().unwrap().db_path.clone();
            let result = WorkspaceStore::open_app(&db_path).and_then(|s| {
                let prompt = match action {
                    WorkspaceGitAction::CreatePr => {
                        s.create_pull_request_agent_prompt(&workspace)?
                    }
                    WorkspaceGitAction::PushBranch => s.push_branch_agent_prompt(&workspace)?,
                    WorkspaceGitAction::MergePr => s.merge_pull_request_agent_prompt(&workspace)?,
                    WorkspaceGitAction::OpenPr => s.review_pull_request_agent_prompt(&workspace)?,
                };
                Ok(prompt)
            });
            match result {
                Ok(prompt) => ArchcarResponse::WorkspaceGitActionPrompt {
                    workspace,
                    action,
                    prompt,
                    visible_input: workspace_git_action_visible_input(action).to_owned(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetSpotlightStatus { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| s.spotlight_status(&workspace)) {
                Ok(session) => ArchcarResponse::SpotlightStatus {
                    workspace,
                    active: session.is_some(),
                    status: session.as_ref().map(|s| s.status.clone()),
                    started_at: session.as_ref().map(|s| s.started_at.clone()),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::StartSpotlight { workspace } => {
            let (db_path, logs_dir) = {
                let s = state.lock().unwrap();
                (s.db_path.clone(), s.logs_dir.clone())
            };
            match WorkspaceStore::open_app_with_logs(&db_path, &logs_dir)
                .and_then(|s| s.spotlight_start(&workspace))
            {
                Ok(session) => ArchcarResponse::SpotlightStatus {
                    workspace,
                    active: true,
                    status: Some(session.status),
                    started_at: Some(session.started_at),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::StopSpotlight { workspace } => {
            let (db_path, logs_dir) = {
                let s = state.lock().unwrap();
                (s.db_path.clone(), s.logs_dir.clone())
            };
            match WorkspaceStore::open_app_with_logs(&db_path, &logs_dir)
                .and_then(|s| s.spotlight_stop(&workspace))
            {
                Ok(_) => ArchcarResponse::SpotlightStatus {
                    workspace,
                    active: false,
                    status: None,
                    started_at: None,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::CommitWorkspaceChanges {
            workspace,
            message,
            stage_all,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            let result = WorkspaceStore::open_app(&db_path).and_then(|s| {
                if stage_all {
                    s.stage_all_workspace_files(&workspace)?;
                }
                s.commit_workspace_changes(&workspace, &message)
            });
            match result {
                Ok(output) => ArchcarResponse::WorkspaceCommitted { workspace, output },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListWorkspaceChecks { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.list_workspace_checks(&workspace))
            {
                Ok(checks) => ArchcarResponse::WorkspaceChecks {
                    workspace,
                    checks: checks
                        .into_iter()
                        .map(|c| crate::archcar::protocol::ArchcarConfiguredCheck {
                            key: c.key,
                            label: c.label,
                            command: c.command,
                        })
                        .collect(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::RunWorkspaceCheck { workspace, key } => {
            let (db_path, logs_dir) = {
                let s = state.lock().unwrap();
                (s.db_path.clone(), s.logs_dir.clone())
            };
            match WorkspaceStore::open_app_with_logs(&db_path, &logs_dir)
                .and_then(|s| s.run_workspace_check(&workspace, &key))
            {
                Ok(process) => ArchcarResponse::CheckStarted {
                    workspace,
                    key,
                    pid: process.pid,
                    log_path: process.log_path.to_string_lossy().into_owned(),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetWorkspaceScriptPrompt { workspace, kind } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path) {
                Ok(store) => ArchcarResponse::WorkspaceScriptPrompt {
                    prompt: workspace_script_prompt(&store, &workspace, &kind),
                    kind,
                    workspace,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetWorkspaceRunScripts { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path) {
                Ok(store) => ArchcarResponse::WorkspaceRunScripts {
                    scripts: workspace_run_scripts(&store, &workspace),
                    workspace,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::StartWorkspaceSetup { workspace } => {
            let (db_path, logs_dir) = {
                let state = state.lock().unwrap();
                (state.db_path.clone(), state.logs_dir.clone())
            };
            match WorkspaceStore::open_app_with_logs(&db_path, logs_dir)
                .and_then(|store| store.setup_workspace(&workspace))
            {
                Ok(process) => ArchcarResponse::WorkspaceProcessStarted {
                    process: archcar_process_summary(&process),
                    workspace,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::StartWorkspaceRun { workspace } => {
            let (db_path, logs_dir) = {
                let state = state.lock().unwrap();
                (state.db_path.clone(), state.logs_dir.clone())
            };
            match WorkspaceStore::open_app_with_logs(&db_path, logs_dir)
                .and_then(|store| store.run_workspace(&workspace))
            {
                Ok(process) => ArchcarResponse::WorkspaceProcessStarted {
                    process: archcar_process_summary(&process),
                    workspace,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::StopWorkspaceRun { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|store| store.stop_workspace(&workspace))
            {
                Ok(process) => ArchcarResponse::WorkspaceProcessStopped {
                    process: archcar_process_summary(&process),
                    workspace,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::RecoverWorkspaceLifecycleJobs => {
            let (db_path, logs_dir) = {
                let state = state.lock().unwrap();
                (state.db_path.clone(), state.logs_dir.clone())
            };
            match WorkspaceStore::open_app_with_logs(&db_path, logs_dir).and_then(|store| {
                let recovered = store.recover_workspace_lifecycle_jobs()?;
                let reconciled_processes = store.reconcile_script_processes()?.len();
                Ok((recovered, reconciled_processes))
            }) {
                Ok((recovered, reconciled_processes)) => {
                    ArchcarResponse::WorkspaceLifecycleRecovery {
                        recovered,
                        reconciled_processes,
                    }
                }
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListReviewComments { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.list_review_comments(&workspace))
            {
                Ok(comments) => ArchcarResponse::ReviewComments {
                    workspace,
                    comments,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetChecksSummary { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| s.checks_summary(&workspace)) {
                Ok(summary) => ArchcarResponse::ChecksSummary {
                    workspace: workspace.clone(),
                    summary: ArchcarChecksSummary {
                        workspace,
                        changed_files: summary.changed_files,
                        run_status: summary.run_status.map(|s| s.as_str().to_owned()),
                        check_status: summary.check_status.map(|s| s.as_str().to_owned()),
                        check_exit_code: summary.check_exit_code,
                        session_status: summary.session_status.map(|s| s.as_str().to_owned()),
                        active_sessions: summary.active_sessions,
                        open_todos: summary.open_todos,
                        total_todos: summary.total_todos,
                        open_review_comments: summary.open_review_comments,
                        source_branch_ahead: summary.source_branch_ahead,
                        branch_ahead: summary.branch_push_state.as_ref().map(|s| s.ahead),
                        branch_behind: summary.branch_push_state.as_ref().map(|s| s.behind),
                        pull_request_number: summary.pull_request.as_ref().map(|pr| pr.number),
                        pull_request_state: summary
                            .pull_request
                            .as_ref()
                            .map(|pr| pr.state.clone()),
                        conflicting_workspaces: summary.conflicting_workspaces.len(),
                    },
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetSettings { repository } => {
            let db_path = state.lock().unwrap().db_path.clone();
            let shared = AppPaths::from_env().shared_settings_path();
            let loaded = match &repository {
                None => crate::settings::load_effective_app_shared_settings(&shared),
                Some(repo) => RepositoryStore::open(&db_path)
                    .and_then(|s| s.get_by_name(repo))
                    .and_then(|r| {
                        crate::settings::load_effective_repository_settings(&r.root_path, &shared)
                    }),
            };
            match loaded.and_then(|s| crate::settings::repository_settings_to_toml(&s)) {
                Ok(toml) => ArchcarResponse::Settings {
                    scope: repository.unwrap_or_else(|| "global".to_owned()),
                    toml,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListRepositoryBranches { repository } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match RepositoryStore::open(&db_path)
                .and_then(|s| s.get_by_name(&repository))
                .and_then(|r| crate::workspace::list_repository_branches(&r.root_path))
            {
                Ok(branches) => ArchcarResponse::RepositoryBranches {
                    repository,
                    branches,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListPromptPacks { repository } => {
            let db_path = state.lock().unwrap().db_path.clone();
            let result: anyhow::Result<(Vec<String>, Option<String>)> =
                RepositoryStore::open(&db_path)
                    .and_then(|s| s.get_by_name(&repository))
                    .and_then(|r| {
                        let packs = crate::settings::list_prompt_pack_names(&r.root_path)?;
                        let active = crate::settings::load_repository_settings_for_layer(
                            &r.root_path,
                            crate::settings::SettingsLayer::RepositoryShared,
                        )
                        .ok()
                        .and_then(|s| s.prompt_pack.active);
                        Ok((packs, active))
                    });
            match result {
                Ok((packs, active)) => ArchcarResponse::PromptPacks {
                    repository,
                    packs,
                    active,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::SetActivePromptPack { repository, pack } => {
            let db_path = state.lock().unwrap().db_path.clone();
            let result: anyhow::Result<(Vec<String>, Option<String>)> =
                RepositoryStore::open(&db_path)
                    .and_then(|s| s.get_by_name(&repository))
                    .and_then(|r| {
                        crate::settings::set_active_prompt_pack(&r.root_path, &pack)?;
                        let packs = crate::settings::list_prompt_pack_names(&r.root_path)?;
                        let active = crate::settings::load_repository_settings_for_layer(
                            &r.root_path,
                            crate::settings::SettingsLayer::RepositoryShared,
                        )
                        .ok()
                        .and_then(|s| s.prompt_pack.active);
                        Ok((packs, active))
                    });
            match result {
                Ok((packs, active)) => ArchcarResponse::PromptPacks {
                    repository,
                    packs,
                    active,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetSettingsSource { repository, layer } => {
            let db_path = state.lock().unwrap().db_path.clone();
            let read_layer_file = |path: std::path::PathBuf| -> std::io::Result<String> {
                match std::fs::read_to_string(&path) {
                    Ok(s) => Ok(s),
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
                    Err(err) => Err(err),
                }
            };
            let result: anyhow::Result<(String, String)> = match &repository {
                None => {
                    let shared = AppPaths::from_env().shared_settings_path();
                    read_layer_file(shared)
                        .map(|toml| ("global".to_owned(), toml))
                        .map_err(Into::into)
                }
                Some(repo) => RepositoryStore::open(&db_path)
                    .and_then(|s| s.get_by_name(repo))
                    .and_then(|r| {
                        let layer = layer.as_deref().unwrap_or("repository");
                        let file = match layer {
                            "local" => r.root_path.join(".archductor/settings.local.toml"),
                            _ => r.root_path.join(".archductor/settings.toml"),
                        };
                        let name = if layer == "local" {
                            "local"
                        } else {
                            "repository"
                        };
                        read_layer_file(file)
                            .map(|toml| (name.to_owned(), toml))
                            .map_err(Into::into)
                    }),
            };
            match result {
                Ok((layer, toml)) => ArchcarResponse::SettingsSource {
                    scope: repository.unwrap_or_else(|| "global".to_owned()),
                    layer,
                    toml,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::SaveSettings {
            repository,
            layer,
            toml,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            let result: anyhow::Result<String> = match &repository {
                None => {
                    let shared = AppPaths::from_env().shared_settings_path();
                    crate::settings::save_app_shared_settings_from_toml(&shared, &toml)
                        .map(|()| "global".to_owned())
                }
                Some(repo) => {
                    let layer_name = layer.as_deref().unwrap_or("repository");
                    let settings_layer = if layer_name == "local" {
                        crate::settings::SettingsLayer::LocalOverride
                    } else {
                        crate::settings::SettingsLayer::RepositoryShared
                    };
                    RepositoryStore::open(&db_path)
                        .and_then(|s| s.get_by_name(repo))
                        .and_then(|r| {
                            crate::settings::save_repository_settings_from_toml(
                                &r.root_path,
                                settings_layer,
                                &toml,
                            )
                        })
                        .map(|()| {
                            if layer_name == "local" {
                                "local"
                            } else {
                                "repository"
                            }
                            .to_owned()
                        })
                }
            };
            match result {
                Ok(layer) => ArchcarResponse::SettingsSaved {
                    scope: repository.unwrap_or_else(|| "global".to_owned()),
                    layer,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetSetupReadiness { recheck } => ArchcarResponse::SetupReadiness {
            report: crate::doctor::setup_report(recheck),
        },
        ArchcarRequest::CreateChatThread {
            workspace,
            provider,
            title,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.create_chat_thread(&workspace, &provider, &title, None))
            {
                Ok(t) => {
                    let harness = crate::workspace::SessionHarnessOptions::from_metadata(
                        t.harness_metadata.as_deref(),
                    );
                    ArchcarResponse::ChatThreadCreated {
                        thread: ArchcarChatThread {
                            id: t.id,
                            provider: t.provider,
                            title: t.title,
                            status: t.status,
                            model: t.model,
                            effort_mode: harness.effort_mode,
                            fast_mode: harness.fast_mode,
                            updated_at: t.updated_at,
                            archived_at: t.archived_at,
                        },
                    }
                }
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::CloseChatThread { thread_id } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| s.close_chat_thread(thread_id)) {
                Ok(()) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ReopenChatThread { thread_id } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| s.reopen_chat_thread(thread_id)) {
                Ok(()) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::AddRepository {
            path,
            name,
            remote_name,
            default_branch,
            workspace_parent,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match RepositoryStore::open(&db_path).and_then(|s| {
                s.add(AddRepository {
                    name,
                    root_path: PathBuf::from(path),
                    default_branch,
                    remote_name: remote_name.unwrap_or_else(|| "origin".to_owned()),
                    workspace_parent_path: workspace_parent.map(PathBuf::from),
                })
            }) {
                Ok(repo) => ArchcarResponse::RepositoryAdded { name: repo.name },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::CloneRepository { url, dest, name } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match clone_repository(&url, &dest).and_then(|()| {
                RepositoryStore::open(&db_path).and_then(|s| {
                    s.add(AddRepository {
                        name,
                        root_path: PathBuf::from(&dest),
                        default_branch: None,
                        remote_name: "origin".to_owned(),
                        workspace_parent_path: None,
                    })
                })
            }) {
                Ok(repo) => ArchcarResponse::RepositoryAdded { name: repo.name },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::RemoveRepository { repository } => {
            // DB-only record removal — use the plain app store, NOT the lifecycle
            // store. open_lifecycle_workspace_store() runs pending create/delete
            // job recovery first, which touches the (possibly missing) worktree and
            // can error out before we ever reach the delete, silently stranding a
            // dead project that can't be removed.
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| s.remove_repository(&repository))
            {
                Ok(()) => ArchcarResponse::RepositoryRemoved { name: repository },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::CreateWorkspace {
            repository,
            name,
            branch,
            base_ref,
        } => match open_lifecycle_workspace_store(state).and_then(|s| {
            s.create_lifecycle_job(CreateWorkspace {
                repository_name: repository,
                name,
                branch,
                base_ref,
            })
        }) {
            Ok(w) => ArchcarResponse::WorkspaceCreated { name: w.name },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::CreateWorkspaceFromPrompt {
            repository,
            prompt,
            name,
            branch,
            base_ref,
        } => match open_lifecycle_workspace_store(state).and_then(|s| {
            s.create_from_prompt(
                &repository,
                &prompt,
                name.as_deref(),
                branch.as_deref(),
                base_ref.as_deref(),
            )
        }) {
            Ok(w) => ArchcarResponse::WorkspaceCreated { name: w.name },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::CreateWorkspaceFromIssue {
            repository,
            issue_number,
            branch_prefix,
        } => match open_lifecycle_workspace_store(state)
            .and_then(|s| s.create_from_issue(&repository, issue_number, branch_prefix.as_deref()))
        {
            Ok(w) => ArchcarResponse::WorkspaceCreated { name: w.name },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::CreateWorkspaceFromPullRequest {
            repository,
            pr_number,
            name,
            branch,
        } => match open_lifecycle_workspace_store(state).and_then(|s| {
            s.create_from_pull_request(&repository, pr_number, name.as_deref(), branch.as_deref())
        }) {
            Ok(w) => ArchcarResponse::WorkspaceCreated { name: w.name },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::CreateWorkspaceFromLinear {
            repository,
            issue_id,
            name,
            branch,
            base_ref,
        } => match open_lifecycle_workspace_store(state).and_then(|s| {
            s.create_from_linear_issue(
                &repository,
                &issue_id,
                name.as_deref(),
                branch.as_deref(),
                base_ref.as_deref(),
            )
        }) {
            Ok(w) => ArchcarResponse::WorkspaceCreated { name: w.name },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::ArchiveWorkspace {
            workspace,
            remove_worktree,
        } => match open_lifecycle_workspace_store(state)
            .and_then(|s| s.archive(&workspace, remove_worktree))
        {
            Ok(w) => ArchcarResponse::WorkspaceUpdated { name: w.name },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::RestoreWorkspace { workspace } => {
            match open_lifecycle_workspace_store(state).and_then(|s| s.restore(&workspace)) {
                Ok(w) => ArchcarResponse::WorkspaceUpdated { name: w.name },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::RenameWorkspace {
            workspace,
            new_name,
        } => match open_lifecycle_workspace_store(state)
            .and_then(|s| s.rename(&workspace, &new_name))
        {
            Ok(w) => ArchcarResponse::WorkspaceUpdated { name: w.name },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::DuplicateWorkspace {
            workspace,
            new_name,
            branch,
        } => match open_lifecycle_workspace_store(state)
            .and_then(|s| s.duplicate(&workspace, &new_name, branch.as_deref()))
        {
            Ok(w) => ArchcarResponse::WorkspaceCreated { name: w.name },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::DeleteWorkspace {
            workspace,
            remove_worktree,
            delete_branch,
        } => match open_lifecycle_workspace_store(state)
            .and_then(|s| s.delete_lifecycle_job(&workspace, remove_worktree, delete_branch))
        {
            Ok(result) => {
                if let Some(err) = &result.cleanup_error {
                    // Metadata is already deleted; surface cleanup failure in logs
                    // but still report removal so the UI drops the row.
                    warn!(workspace = %result.workspace.name, error = %err, "workspace artifact cleanup failed after delete");
                }
                ArchcarResponse::WorkspaceRemoved {
                    name: result.workspace.name,
                }
            }
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::CreateBranch { workspace, branch } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.create_branch(&workspace, &branch))
            {
                Ok(()) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::CheckoutBranch { workspace, branch } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.checkout_branch(&workspace, &branch))
            {
                Ok(w) => ArchcarResponse::WorkspaceUpdated { name: w.name },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::RenameWorkspaceBranch {
            workspace,
            new_branch,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.rename_branch(&workspace, &new_branch))
            {
                Ok(w) => ArchcarResponse::WorkspaceUpdated { name: w.name },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::DeleteBranch { workspace, branch } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.delete_branch(&workspace, &branch))
            {
                Ok(()) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::PushBranch { workspace, force } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| {
                if force {
                    s.force_push_branch_with_lease(&workspace)
                } else {
                    s.push_branch(&workspace)
                }
            }) {
                Ok(_) => ArchcarResponse::WorkspaceUpdated { name: workspace },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::RefreshPullRequest { workspace } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.refresh_pull_request_state(&workspace))
            {
                Ok(_) => ArchcarResponse::WorkspaceUpdated { name: workspace },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ResolveReviewThread {
            workspace,
            thread_id,
            resolved,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|s| {
                s.set_pull_request_review_thread_resolution(&workspace, &thread_id, resolved)
            }) {
                Ok(_) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::MergePullRequest { workspace, method } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.merge_pull_request(&workspace, method.as_deref()))
            {
                Ok(_) => ArchcarResponse::WorkspaceUpdated { name: workspace },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::AddReviewComment {
            workspace,
            file_path,
            line_number,
            body,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.add_review_comment(&workspace, &file_path, line_number, &body))
            {
                Ok(comment) => ArchcarResponse::ReviewCommentAdded { comment },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::DeleteCheckpoint {
            workspace,
            checkpoint_id,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.checkpoint_delete(&workspace, checkpoint_id))
            {
                Ok(()) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::LinkWorkspaceDirectory { workspace, target } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.link_workspace_directory(&workspace, &target))
            {
                Ok(_) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::UnlinkWorkspaceDirectory { workspace, target } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path)
                .and_then(|s| s.unlink_workspace_directory(&workspace, &target))
            {
                Ok(_) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::SetDefaultAgentProvider {
            workspace,
            provider,
        } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::save_local_default_agent_provider_for_database(
                &db_path, &workspace, &provider,
            ) {
                Ok(()) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::SetChatPlanMode {
            thread_id,
            plan_mode,
        } => set_chat_plan_mode(state, thread_id, plan_mode),
        ArchcarRequest::GetChatPlan { thread_id } => {
            let db_path = state.lock().unwrap().db_path.clone();
            match WorkspaceStore::open_app(&db_path).and_then(|store| {
                let plan_mode = store.chat_thread_plan_mode(thread_id)?;
                let plan_path = store.chat_thread_plan_path(thread_id)?;
                let plan_markdown = match plan_path.as_deref() {
                    Some(path) => read_thread_plan_markdown(&store, thread_id, path)?,
                    None => None,
                };
                Ok((plan_mode, plan_path, plan_markdown))
            }) {
                Ok((plan_mode, plan_path, plan_markdown)) => ArchcarResponse::ChatPlan {
                    thread_id,
                    plan_mode,
                    plan_path,
                    plan_markdown,
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::RegisterProviderInteraction { interaction } => {
            let store = {
                let guard = state.lock().unwrap();
                ProviderInteractionStore::new(guard.db_path.clone())
            };
            match store.register(interaction) {
                Ok(interaction) => {
                    broadcast(
                        &mut state.lock().unwrap(),
                        ArchcarEvent::ProviderInteractionRequested {
                            interaction: interaction.clone(),
                        },
                    );
                    ArchcarResponse::ProviderInteraction { interaction }
                }
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetProviderInteraction { interaction_id } => {
            let store = {
                let guard = state.lock().unwrap();
                ProviderInteractionStore::new(guard.db_path.clone())
            };
            match store.get(&interaction_id) {
                Ok(Some(interaction)) => ArchcarResponse::ProviderInteraction { interaction },
                Ok(None) => ArchcarResponse::Error {
                    message: format!("unknown provider interaction {interaction_id}"),
                },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ListProviderInteractions {
            thread_id,
            pending_only,
        } => {
            let store = {
                let guard = state.lock().unwrap();
                ProviderInteractionStore::new(guard.db_path.clone())
            };
            match store.list(thread_id, pending_only) {
                Ok(interactions) => ArchcarResponse::ProviderInteractions { interactions },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ResolveProviderInteraction {
            interaction_id,
            resolution,
        } => {
            let store = {
                let guard = state.lock().unwrap();
                ProviderInteractionStore::new(guard.db_path.clone())
            };
            match store.resolve(&interaction_id, resolution.clone()) {
                Ok(interaction) => {
                    // Storing the answer is not answering: the provider is
                    // holding its turn open for a native reply keyed by the id
                    // it asked with.
                    deliver_interaction_resolution(state, &interaction, &resolution);
                    broadcast(
                        &mut state.lock().unwrap(),
                        ArchcarEvent::ProviderInteractionResolved {
                            interaction: interaction.clone(),
                        },
                    );
                    ArchcarResponse::ProviderInteraction { interaction }
                }
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::ConsumeProviderInteraction {
            interaction_id,
            native_response,
        } => {
            let store = {
                let guard = state.lock().unwrap();
                ProviderInteractionStore::new(guard.db_path.clone())
            };
            match store.consume_resolution(&interaction_id, native_response) {
                Ok(interaction) => ArchcarResponse::ProviderInteraction { interaction },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        // ---- Daemon service and remote access ---------------------------
        // Service management reads the process environment's paths, which is
        // where this daemon's own state lives.
        ArchcarRequest::GetServiceStatus => match crate::service::status(&AppPaths::from_env()) {
            Ok(status) => ArchcarResponse::ServiceStatus { status },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::InstallService { input } => {
            match crate::service::install(&AppPaths::from_env(), &input) {
                Ok(status) => ArchcarResponse::ServiceStatus { status },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::UninstallService => {
            match crate::service::uninstall(&AppPaths::from_env()) {
                Ok(status) => ArchcarResponse::ServiceStatus { status },
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        ArchcarRequest::GetRemoteAccess => remote_access_response(false),
        ArchcarRequest::RotateRemoteToken => remote_access_response(true),
        // ---- Background development tasks -------------------------------
        ArchcarRequest::StartBackgroundTask { input } => start_background_task(state, input),
        ArchcarRequest::ListBackgroundTasks { active_only } => with_store(state, |store| {
            Ok(ArchcarResponse::BackgroundTasks {
                tasks: store.list_background_tasks(active_only)?,
            })
        }),
        ArchcarRequest::GetBackgroundTask { background_task_id } => with_store(state, |store| {
            Ok(ArchcarResponse::BackgroundTaskSaved {
                task: store.get_background_task(background_task_id)?,
            })
        }),
        ArchcarRequest::CancelBackgroundTask { background_task_id } => with_store(state, |store| {
            Ok(ArchcarResponse::BackgroundTaskSaved {
                task: store.cancel_background_task(background_task_id)?,
            })
        }),
        ArchcarRequest::TickBackgroundTasks => match tick_background_tasks(state) {
            Ok(tasks) => ArchcarResponse::BackgroundTasks { tasks },
            Err(err) => ArchcarResponse::Error {
                message: err.to_string(),
            },
        },
        ArchcarRequest::CreatePullRequest {
            workspace,
            title,
            body,
            draft,
        } => {
            let requested = workspace.clone();
            let db_path = state.lock().unwrap().db_path.clone();
            // Creating the PR renames the workspace to the PR title, which is the
            // best name this work ever gets. Capture the id so we can report the
            // new name to clients that only know the old one.
            let workspace_id = WorkspaceStore::open_app(&db_path)
                .and_then(|store| store.get_by_name(&requested))
                .map(|workspace| workspace.id)
                .ok();
            let response = with_store(state, |store| {
                let output = store.create_pull_request(
                    &workspace,
                    title.as_deref(),
                    body.as_deref(),
                    draft,
                )?;
                Ok(ArchcarResponse::PullRequestCreated { workspace, output })
            });
            if let Some(new_name) = workspace_id.and_then(|id| {
                WorkspaceStore::open_app(&db_path)
                    .and_then(|store| store.workspace_name_by_id(id))
                    .ok()
            }) {
                broadcast_workspace_renamed(state, &requested, &new_name);
            }
            response
        }
        ArchcarRequest::GetPullRequestDraft { workspace } => with_store(state, |store| {
            let template = store.render_pull_request_template(&workspace)?;
            Ok(ArchcarResponse::PullRequestDraft {
                workspace,
                title: template.title,
                body: template.body,
            })
        }),
        // ---- Workspace intelligence -------------------------------------
        ArchcarRequest::ListTasks { workspace } => with_store(state, |store| {
            let tasks = store.list_tasks(&workspace)?;
            Ok(ArchcarResponse::Tasks { workspace, tasks })
        }),
        ArchcarRequest::CreateTask {
            workspace,
            title,
            body,
            intended_areas,
        } => {
            let workspace_name = workspace.clone();
            let response = with_store(state, |store| {
                let task = store.create_task(&workspace, &title, &body, &intended_areas)?;
                Ok(ArchcarResponse::TaskSaved { task })
            });
            if let ArchcarResponse::TaskSaved { task } = &response {
                broadcast_task_updated(state, &workspace_name, task.id, &task.status);
                refresh_workspace_context_after_change(state, &workspace_name, None);
            }
            response
        }
        // Every id below is a global primary key, so the store resolves it
        // against the workspace the request named.
        ArchcarRequest::UpdateTask {
            workspace,
            task_id,
            update,
        } => {
            let workspace_name = workspace.clone();
            let response = with_store(state, |store| {
                let task = store.update_task(&workspace, task_id, update)?;
                Ok(ArchcarResponse::TaskSaved { task })
            });
            if let ArchcarResponse::TaskSaved { task } = &response {
                broadcast_task_updated(state, &workspace_name, task.id, &task.status);
                refresh_workspace_context_after_change(state, &workspace_name, None);
            }
            response
        }
        ArchcarRequest::DeleteTask { workspace, task_id } => {
            let workspace_name = workspace.clone();
            let response = with_store(state, |store| {
                store.delete_task(&workspace, task_id)?;
                Ok(ArchcarResponse::TaskDeleted { task_id })
            });
            if matches!(response, ArchcarResponse::TaskDeleted { .. }) {
                broadcast_task_updated(state, &workspace_name, task_id, "deleted");
                refresh_workspace_context_after_change(state, &workspace_name, None);
            }
            response
        }
        ArchcarRequest::AssignSessionTask {
            workspace,
            session_id,
            task_id,
        } => {
            let workspace_name = workspace.clone();
            let response = with_store(state, |store| {
                store.assign_session_task(&workspace, session_id, task_id)?;
                Ok(ArchcarResponse::Ack)
            });
            if matches!(response, ArchcarResponse::Ack) {
                refresh_workspace_context_after_change(state, &workspace_name, Some(session_id));
            }
            response
        }
        ArchcarRequest::SetSessionIntendedAreas {
            workspace,
            session_id,
            areas,
        } => with_store(state, |store| {
            store.set_session_intended_areas(&workspace, session_id, &areas)?;
            Ok(ArchcarResponse::Ack)
        }),
        ArchcarRequest::ListSummaries { workspace } => with_store(state, |store| {
            let summaries = store.list_summaries(&workspace)?;
            Ok(ArchcarResponse::Summaries {
                workspace,
                summaries,
            })
        }),
        ArchcarRequest::SaveSummary {
            workspace,
            scope_type,
            scope_id,
            body_markdown,
            source_refs,
        } => with_store(state, |store| {
            let summary = store.save_summary(
                &workspace,
                &scope_type,
                scope_id,
                &body_markdown,
                &source_refs,
            )?;
            Ok(ArchcarResponse::SummarySaved { summary })
        }),
        ArchcarRequest::DeleteSummary {
            workspace,
            summary_id,
        } => with_store(state, |store| {
            store.delete_summary(&workspace, summary_id)?;
            Ok(ArchcarResponse::SummaryDeleted { summary_id })
        }),
        ArchcarRequest::DraftSummary {
            workspace,
            session_id,
        } => with_store(state, |store| {
            let body_markdown = match session_id {
                Some(session_id) => store.draft_session_summary(&workspace, session_id)?,
                None => store.draft_workspace_summary(&workspace)?,
            };
            Ok(ArchcarResponse::SummaryDraft {
                workspace,
                body_markdown,
            })
        }),
        ArchcarRequest::RefreshSummary {
            workspace,
            scope_type,
            scope_id,
        } => {
            let workspace_name = workspace.clone();
            let response = with_store(state, |store| {
                let scope = summary_refresh_scope(workspace.clone(), &scope_type, scope_id)?;
                let result = store.refresh_summary(scope)?;
                Ok(ArchcarResponse::SummaryRefreshed { workspace, result })
            });
            if let ArchcarResponse::SummaryRefreshed { result, .. } = &response {
                if result.changed {
                    broadcast_summary_updated(state, &workspace_name, &result.summary);
                }
            }
            response
        }
        ArchcarRequest::GetContextBriefing {
            workspace,
            thread_id,
        } => with_store(state, |store| {
            let briefing = store.context_briefing(&workspace, thread_id)?;
            Ok(ArchcarResponse::ContextBriefing { briefing })
        }),
        ArchcarRequest::SyncChatTasks {
            workspace,
            thread_id,
        } => {
            let workspace_name = workspace.clone();
            let response = with_store(state, |store| {
                let result = store.sync_chat_tasks(&workspace, thread_id)?;
                Ok(ArchcarResponse::TasksSynced { result })
            });
            if let ArchcarResponse::TasksSynced { result } = &response {
                for task_id in &result.task_ids {
                    broadcast_task_updated(state, &workspace_name, *task_id, "todo");
                }
                if result.created > 0 {
                    refresh_workspace_context_after_change(state, &workspace_name, thread_id);
                }
            }
            response
        }
        ArchcarRequest::ListContextAttachments { workspace } => with_store(state, |store| {
            let attachments = store.list_context_attachments(&workspace)?;
            Ok(ArchcarResponse::ContextAttachments {
                workspace,
                attachments,
            })
        }),
        ArchcarRequest::AddContextAttachment {
            workspace,
            source,
            kind,
            body_or_ref,
            scope,
            pinned,
        } => with_store(state, |store| {
            let attachment = store.add_context_attachment(
                &workspace,
                &source,
                &kind,
                &body_or_ref,
                &scope,
                pinned,
            )?;
            Ok(ArchcarResponse::ContextAttachmentAdded { attachment })
        }),
        ArchcarRequest::RemoveContextAttachment {
            workspace,
            attachment_id,
        } => with_store(state, |store| {
            store.remove_context_attachment(&workspace, attachment_id)?;
            Ok(ArchcarResponse::ContextAttachmentRemoved { attachment_id })
        }),
        ArchcarRequest::ListSessionContributions { workspace } => with_store(state, |store| {
            let contributions = store.session_contributions(&workspace)?;
            Ok(ArchcarResponse::SessionContributions {
                workspace,
                contributions,
            })
        }),
        ArchcarRequest::ListSessionOverlaps { workspace } => with_store(state, |store| {
            let overlaps = store.session_overlaps(&workspace)?;
            Ok(ArchcarResponse::SessionOverlaps {
                workspace,
                overlaps,
            })
        }),
        ArchcarRequest::ListSessionRuns {
            workspace,
            session_id,
        } => with_store(state, |store| {
            let runs = store.session_run_history(&workspace, session_id)?;
            Ok(ArchcarResponse::SessionRuns {
                workspace,
                session_id,
                runs,
            })
        }),
        ArchcarRequest::SnapshotDiffContribution {
            workspace,
            session_id,
            risks,
            blockers,
        } => with_store(state, |store| {
            let contribution =
                store.snapshot_diff_contribution(&workspace, session_id, &risks, &blockers)?;
            Ok(ArchcarResponse::DiffContributionSaved { contribution })
        }),
        ArchcarRequest::ListDiffContributions { workspace } => with_store(state, |store| {
            let contributions = store.list_diff_contributions(&workspace)?;
            Ok(ArchcarResponse::DiffContributions {
                workspace,
                contributions,
            })
        }),
        ArchcarRequest::Subscribe => ArchcarResponse::Error {
            message: "subscribe must use a persistent connection".to_owned(),
        },
    };
    broadcast_inventory_change_for_response(state, &response);
    response
}

fn broadcast_inventory_change_for_response(
    state: &Arc<Mutex<ServerState>>,
    response: &ArchcarResponse,
) {
    let event = match response {
        ArchcarResponse::RepositoryAdded { name } | ArchcarResponse::RepositoryRemoved { name } => {
            Some(ArchcarEvent::InventoryChanged {
                scope: "repositories".to_owned(),
                workspace: None,
                repository: Some(name.clone()),
            })
        }
        ArchcarResponse::WorkspaceCreated { name }
        | ArchcarResponse::WorkspaceUpdated { name }
        | ArchcarResponse::WorkspaceRemoved { name } => Some(ArchcarEvent::InventoryChanged {
            scope: "workspaces".to_owned(),
            workspace: Some(name.clone()),
            repository: None,
        }),
        ArchcarResponse::WorkspaceCommitted { workspace, .. }
        | ArchcarResponse::RunScriptStarted { workspace, .. }
        | ArchcarResponse::RunScriptStopped { workspace, .. }
        | ArchcarResponse::WorkspaceProcessStarted { workspace, .. }
        | ArchcarResponse::WorkspaceProcessStopped { workspace, .. }
        | ArchcarResponse::CheckStarted { workspace, .. }
        | ArchcarResponse::PullRequestCreated { workspace, .. }
        | ArchcarResponse::WorkspaceFileWritten { workspace, .. } => {
            Some(ArchcarEvent::InventoryChanged {
                scope: "workspaces".to_owned(),
                workspace: Some(workspace.clone()),
                repository: None,
            })
        }
        _ => None,
    };
    if let Some(event) = event {
        broadcast(&mut state.lock().unwrap(), event);
    }
}

/// Report (or rotate) the token and address a remote client needs. The listen
/// address comes from this process's configuration, so it reflects the daemon
/// that is actually running rather than what a unit file once said.
fn remote_access_response(rotate: bool) -> ArchcarResponse {
    let paths = AppPaths::from_env();
    let token = if rotate {
        remote::rotate_token(&paths)
    } else {
        remote::ensure_token(&paths)
    };
    match token {
        Ok(token) => ArchcarResponse::RemoteAccess {
            listen: remote::listen_addr_from_env()
                .and_then(|addr| addr.ok())
                .map(|addr| addr.to_string()),
            token,
            token_path: remote::token_path(&paths).display().to_string(),
        },
        Err(err) => ArchcarResponse::Error {
            message: err.to_string(),
        },
    }
}

/// Start a background development task: create the workspace and tracking rows
/// in core, then open a chat thread, queue the prompt, and spawn the agent
/// session so the work actually runs without a human at the keyboard.
fn start_background_task(
    state: &Arc<Mutex<ServerState>>,
    input: crate::background_tasks::StartBackgroundTask,
) -> ArchcarResponse {
    let (db_path, logs_dir) = {
        let guard = state.lock().unwrap();
        (guard.db_path.clone(), guard.logs_dir.clone())
    };
    let provider = input.provider.clone();
    let extra_agents = input.extra_agents.clone();
    let started = WorkspaceStore::open_app_with_logs(&db_path, &logs_dir)
        .and_then(|store| store.start_background_task(input));
    let task = match started {
        Ok(task) => task,
        Err(err) => {
            return ArchcarResponse::Error {
                message: err.to_string(),
            };
        }
    };
    let Some(workspace) = task.workspace_name.clone() else {
        return ArchcarResponse::BackgroundTaskSaved { task };
    };

    // A start failure after the workspace exists must land on the task row;
    // otherwise the supervisor would retry a task that can never proceed.
    let fail = |message: String| -> ArchcarResponse {
        let recorded = WorkspaceStore::open_app(&db_path)
            .and_then(|store| store.mark_background_task_failed(task.id, &message));
        match recorded {
            Ok(task) => ArchcarResponse::BackgroundTaskSaved { task },
            Err(err) => ArchcarResponse::Error {
                message: format!("{message} (and the failure could not be recorded: {err})"),
            },
        }
    };

    // The strategy allows one or more agents per background task: the primary
    // provider plus any extra specs, each with its own session and prompt.
    let mut agents = vec![(provider.clone(), task.prompt.clone(), task.title.clone())];
    for (index, agent) in extra_agents.iter().enumerate() {
        agents.push((
            agent.provider.clone(),
            agent.prompt.clone().unwrap_or_else(|| task.prompt.clone()),
            format!("{} (agent {})", task.title, index + 2),
        ));
    }

    let mut thread_ids = Vec::new();
    for (agent_provider, prompt, title) in &agents {
        // Core rejects anything but a managed provider before we get here.
        let kind = if agent_provider == "claude" {
            SessionKind::Claude
        } else {
            SessionKind::Codex
        };

        // Reuse the normal chat path so a background workspace looks exactly
        // like one a human started: a thread with the prompt queued, then a
        // session.
        let thread = dispatch_request(
            ArchcarRequest::CreateChatThread {
                workspace: workspace.clone(),
                provider: agent_provider.clone(),
                title: title.clone(),
            },
            state,
        );
        let thread_id = match thread {
            ArchcarResponse::ChatThreadCreated { thread } => thread.id,
            other => {
                abort_background_agents(state, &thread_ids);
                return fail(format!(
                    "created workspace {workspace} but no chat thread: {}",
                    archcar_response_summary(&other)
                ));
            }
        };
        // Track the thread before spawning so a failure below also cleans up
        // this agent, not only the earlier ones.
        thread_ids.push(thread_id);

        // Session first, then the prompt: the queue drains into a session
        // that is already coming up, which is the same order the desktop uses.
        let spawned = dispatch_request(
            ArchcarRequest::EnsureChatThreadSession {
                workspace: workspace.clone(),
                thread_id,
                kind,
                harness: None,
            },
            state,
        );
        if let ArchcarResponse::Error { message } = spawned {
            abort_background_agents(state, &thread_ids);
            return fail(format!("could not start its agent: {message}"));
        }

        let queued = dispatch_request(
            ArchcarRequest::QueueChatInput {
                thread_id,
                input: prompt.clone(),
                visible_input: Some(prompt.clone()),
                kind: crate::archcar::protocol::ArchcarInputKind::User,
                session_kind: kind,
            },
            state,
        );
        if let ArchcarResponse::Error { message } = queued {
            abort_background_agents(state, &thread_ids);
            return fail(format!("could not queue its prompt: {message}"));
        }
    }

    match WorkspaceStore::open_app(&db_path).and_then(|store| {
        for thread_id in &thread_ids {
            store.assign_session_task(&workspace, *thread_id, task.task_id)?;
        }
        store.mark_background_task_running(task.id)
    }) {
        Ok(task) => {
            let mut guard = state.lock().unwrap();
            broadcast(
                &mut guard,
                ArchcarEvent::BackgroundTaskUpdated { task: task.clone() },
            );
            drop(guard);
            ArchcarResponse::BackgroundTaskSaved { task }
        }
        Err(err) => {
            // The agents are already launched with prompts queued. Leaving
            // them running against a task stuck in `pending` would be
            // unsupervised work — stop them and land the failure on the task
            // row like every earlier startup error.
            abort_background_agents(state, &thread_ids);
            fail(format!(
                "started its agents but could not record them: {err}"
            ))
        }
    }
}

/// Stop the agents a partially-started background task already launched.
/// A failed task must not leave an unsupervised agent editing the workspace,
/// so: drop every queued prompt (a session that finishes spawning later has
/// nothing to work on), close the threads, and kill any live session bound to
/// them.
///
/// Ordering matters: threads are closed *before* the session snapshot below.
/// Session registration checks thread-closed under the state lock, so a
/// session still spawning either sees the close and terminates itself, or is
/// registered in time for the snapshot here to kill it. Closing after the
/// snapshot would let a mid-registration session slip past both.
fn abort_background_agents(state: &Arc<Mutex<ServerState>>, thread_ids: &[i64]) {
    for &thread_id in thread_ids {
        if let ArchcarResponse::QueuedChatInputs { inputs, .. } =
            dispatch_request(ArchcarRequest::ListQueuedChatInputs { thread_id }, state)
        {
            for input in inputs {
                let _ = dispatch_request(
                    ArchcarRequest::RemoveQueuedChatInput { queue_id: input.id },
                    state,
                );
            }
        }
    }
    for &thread_id in thread_ids {
        let _ = dispatch_request(ArchcarRequest::CloseChatThread { thread_id }, state);
    }
    let kills: Vec<_> = {
        let guard = state.lock().unwrap();
        guard
            .sessions
            .values()
            .filter(|handle| {
                handle
                    .snapshot
                    .lock()
                    .ok()
                    .is_some_and(|snapshot| thread_ids.contains(&snapshot.thread_id))
            })
            .map(|handle| handle.command_tx.clone())
            .collect()
    };
    for command_tx in kills {
        let _ = command_tx.send(crate::archcar::session::SessionCommand::Kill);
    }
}

/// Map a wire scope to a refresh scope. `session` and `current_chat` are
/// aliases so MCP clients can name the concept they mean.
fn summary_refresh_scope(
    workspace: String,
    scope_type: &str,
    scope_id: Option<i64>,
) -> Result<crate::workspace_intel::SummaryRefreshScope> {
    use crate::workspace_intel::SummaryRefreshScope;
    match scope_type {
        "workspace" => Ok(SummaryRefreshScope::Workspace { workspace }),
        "session" | "current_chat" => Ok(SummaryRefreshScope::CurrentChat {
            workspace,
            thread_id: scope_id.context("session summaries require scope_id")?,
        }),
        "task" => Ok(SummaryRefreshScope::Task {
            workspace,
            task_id: scope_id.context("task summaries require scope_id")?,
        }),
        other => anyhow::bail!("unsupported summary refresh scope `{other}`"),
    }
}

fn broadcast_summary_updated(
    state: &Arc<Mutex<ServerState>>,
    workspace: &str,
    summary: &crate::workspace_intel::Summary,
) {
    let mut guard = state.lock().unwrap();
    broadcast(
        &mut guard,
        ArchcarEvent::SummaryUpdated {
            workspace: workspace.to_owned(),
            summary_id: summary.id,
            scope_type: summary.scope_type.clone(),
            scope_id: summary.scope_id,
        },
    );
}

/// The workspace name and chat title a thread carries right now. Agent metadata
/// can change both while a thread is rendered, so callers snapshot before and
/// after and tell clients what moved.
fn thread_naming_snapshot(db_path: &Path, thread_id: i64) -> Option<(String, String)> {
    let store = WorkspaceStore::open_app(db_path).ok()?;
    let thread = store.get_chat_thread_record(thread_id).ok()?;
    let workspace = store.workspace_name_by_id(thread.workspace_id).ok()?;
    Some((workspace, thread.title))
}

fn broadcast_naming_changes(
    state: &Arc<Mutex<ServerState>>,
    db_path: &Path,
    thread_id: i64,
    before: Option<(String, String)>,
) {
    let Some((old_workspace, old_title)) = before else {
        return;
    };
    let Some((new_workspace, new_title)) = thread_naming_snapshot(db_path, thread_id) else {
        return;
    };
    let mut guard = state.lock().unwrap();
    if new_workspace != old_workspace {
        broadcast(
            &mut guard,
            ArchcarEvent::WorkspaceRenamed {
                old_name: old_workspace,
                new_name: new_workspace,
            },
        );
    }
    if new_title != old_title {
        broadcast(
            &mut guard,
            ArchcarEvent::ChatThreadRenamed {
                thread_id,
                title: new_title,
            },
        );
    }
}

fn broadcast_workspace_renamed(state: &Arc<Mutex<ServerState>>, old_name: &str, new_name: &str) {
    if old_name == new_name {
        return;
    }
    let mut guard = state.lock().unwrap();
    broadcast(
        &mut guard,
        ArchcarEvent::WorkspaceRenamed {
            old_name: old_name.to_owned(),
            new_name: new_name.to_owned(),
        },
    );
}

fn broadcast_task_updated(
    state: &Arc<Mutex<ServerState>>,
    workspace: &str,
    task_id: i64,
    status: &str,
) {
    let mut guard = state.lock().unwrap();
    broadcast(
        &mut guard,
        ArchcarEvent::TaskUpdated {
            workspace: workspace.to_owned(),
            task_id,
            status: status.to_owned(),
        },
    );
}

/// Continuous summary maintenance: refresh the workspace summary (and, when a
/// thread is known, that current chat's summary) after evidence-changing
/// daemon events. Best effort — a refresh failure logs a warning and never
/// fails the action that triggered it.
fn refresh_workspace_context_after_change(
    state: &Arc<Mutex<ServerState>>,
    workspace: &str,
    thread_id: Option<i64>,
) {
    use crate::workspace_intel::SummaryRefreshScope;
    let db_path = state.lock().unwrap().db_path.clone();
    let store = match WorkspaceStore::open_app(&db_path) {
        Ok(store) => store,
        Err(err) => {
            warn!(error = %err, workspace, "summary refresh skipped: store unavailable");
            return;
        }
    };
    let mut scopes = vec![SummaryRefreshScope::Workspace {
        workspace: workspace.to_owned(),
    }];
    if let Some(thread_id) = thread_id {
        scopes.push(SummaryRefreshScope::CurrentChat {
            workspace: workspace.to_owned(),
            thread_id,
        });
    }
    for scope in scopes {
        match store.refresh_summary(scope) {
            Ok(result) if result.changed => {
                broadcast_summary_updated(state, workspace, &result.summary);
            }
            Ok(_) => {}
            Err(err) => warn!(error = %err, workspace, "summary refresh failed"),
        }
    }
}

/// Resolve a chat thread to its workspace name, for event-driven refreshes.
fn workspace_name_for_thread(state: &Arc<Mutex<ServerState>>, thread_id: i64) -> Option<String> {
    let db_path = state.lock().unwrap().db_path.clone();
    let store = WorkspaceStore::open_app(&db_path).ok()?;
    let thread = store.get_chat_thread_record(thread_id).ok()?;
    let workspace = store.get_workspace_record(thread.workspace_id).ok()?;
    Some(workspace.name)
}

/// Open the app store and map any failure to a protocol error response. Keeps
/// the workspace-intelligence handlers to their happy path.
fn with_store(
    state: &Arc<Mutex<ServerState>>,
    body: impl FnOnce(&WorkspaceStore) -> Result<ArchcarResponse>,
) -> ArchcarResponse {
    let db_path = state.lock().unwrap().db_path.clone();
    match WorkspaceStore::open_app(&db_path).and_then(|store| body(&store)) {
        Ok(response) => response,
        Err(err) => ArchcarResponse::Error {
            message: err.to_string(),
        },
    }
}

fn validate_send_input_delivery(
    handle: &SessionHandle,
    kind: &crate::archcar::protocol::ArchcarInputKind,
    delivery: crate::archcar::protocol::ArchcarInputDelivery,
) -> Result<()> {
    let snapshot = handle.snapshot.lock().unwrap();
    if *kind == crate::archcar::protocol::ArchcarInputKind::RawTerminal
        && snapshot.kind != SessionKind::Shell
    {
        anyhow::bail!("raw terminal input is only supported for shell sessions");
    }
    if delivery == crate::archcar::protocol::ArchcarInputDelivery::Immediate {
        return Ok(());
    }
    if matches!(snapshot.kind, SessionKind::Codex | SessionKind::Claude) && !snapshot.ready {
        anyhow::bail!(
            "{} session {} is not ready for automatic input; use immediate delivery to steer the active turn",
            provider_name(snapshot.kind),
            snapshot.session_id
        );
    }
    Ok(())
}

fn queue_chat_input(
    state: &Arc<Mutex<ServerState>>,
    thread_id: i64,
    input: String,
    visible_input: Option<String>,
    kind: crate::archcar::protocol::ArchcarInputKind,
    session_kind: SessionKind,
) -> ArchcarResponse {
    let db_path = state.lock().unwrap().db_path.clone();
    let queued = match WorkspaceStore::open_app(&db_path).and_then(|store| {
        let thread = store.get_chat_thread_record(thread_id)?;
        anyhow::ensure!(
            thread.provider == provider_name(session_kind),
            "chat thread {thread_id} is not a {:?} thread",
            session_kind
        );
        anyhow::ensure!(
            managed_harness_for_kind(session_kind).is_some(),
            "queued chat input is only supported for managed Codex and Claude sessions"
        );
        anyhow::ensure!(
            kind != crate::archcar::protocol::ArchcarInputKind::RawTerminal,
            "raw terminal input cannot be queued"
        );
        // The first human message of a chat carries a hidden request for real
        // workspace/branch/chat names. It rides the provider-bound text only; the
        // transcript keeps the visible text, so the user never sees the block.
        let (input, visible_input) = match kind {
            crate::archcar::protocol::ArchcarInputKind::User => {
                match store.decorate_first_chat_input(thread_id, &input)? {
                    Some(decorated) => (
                        decorated,
                        Some(visible_input.clone().unwrap_or_else(|| input.clone())),
                    ),
                    None => (input.clone(), visible_input.clone()),
                }
            }
            _ => (input.clone(), visible_input.clone()),
        };
        store.enqueue_chat_input(
            thread_id,
            &input,
            visible_input.as_deref(),
            kind,
            session_kind,
        )
    }) {
        Ok(queued) => queued,
        Err(err) => {
            return ArchcarResponse::Error {
                message: err.to_string(),
            };
        }
    };
    broadcast(
        &mut state.lock().unwrap(),
        ArchcarEvent::ChatQueueUpdated { thread_id },
    );
    drain_queued_input_for_thread(state, thread_id);
    ArchcarResponse::QueuedChatInput {
        input: queued_archcar_input_from_record(queued),
    }
}

fn drain_queued_input_for_thread(state: &Arc<Mutex<ServerState>>, thread_id: i64) {
    let Some(_guard) = QueueDrainGuard::begin(state, thread_id) else {
        return;
    };
    loop {
        drain_queued_input_once(state, thread_id);
        let rerun = state
            .lock()
            .map(|mut guard| guard.drain_reruns.remove(&thread_id))
            .unwrap_or(false);
        if !rerun {
            return;
        }
    }
}

fn drain_queued_input_once(state: &Arc<Mutex<ServerState>>, thread_id: i64) {
    let db_path = state.lock().unwrap().db_path.clone();
    let store = match WorkspaceStore::open_app(&db_path) {
        Ok(store) => store,
        Err(err) => {
            warn!(thread_id, error = %format!("{err:#}"), "archcar could not open store for queue drain");
            return;
        }
    };
    let queued = match store.peek_next_queued_chat_input(thread_id) {
        Ok(Some(queued)) => queued,
        Ok(None) => return,
        Err(err) => {
            warn!(thread_id, error = %format!("{err:#}"), "archcar could not read queued chat input");
            return;
        }
    };
    if queued.input_kind == crate::archcar::protocol::ArchcarInputKind::RawTerminal {
        warn!(
            thread_id,
            queue_id = queued.id,
            "archcar rejected raw terminal input from managed chat queue"
        );
        return;
    }
    let session_kind = queued.session_kind;

    let handle = ready_session_handle_for_thread(state, thread_id, session_kind)
        .or_else(|| restore_ready_session_handle_for_queue(state, &store, thread_id, session_kind));
    let Some(handle) = handle else {
        // No live session at all → nothing will ever drain this queue. Start the
        // thread's session; SessionReady drains the queue once it comes up.
        start_session_for_queued_thread(state, &store, thread_id, session_kind);
        return;
    };
    if let Err(err) = validate_send_input_delivery(
        &handle,
        &queued.input_kind,
        crate::archcar::protocol::ArchcarInputDelivery::Auto,
    ) {
        warn!(thread_id, error = %format!("{err:#}"), "archcar queued chat input waited for session readiness");
        return;
    }
    let queued = match store.claim_next_queued_chat_input(thread_id) {
        Ok(Some(queued)) => queued,
        Ok(None) => return,
        Err(err) => {
            warn!(thread_id, error = %format!("{err:#}"), "archcar could not claim queued chat input");
            return;
        }
    };

    match handle
        .command_tx
        .send(crate::archcar::session::SessionCommand::SendInput {
            input: queued.input.clone(),
            visible_input: queued.visible_input.clone(),
            kind: queued.input_kind.clone(),
            delivery: crate::archcar::protocol::ArchcarInputDelivery::Auto,
        }) {
        Ok(()) => {
            broadcast(
                &mut state.lock().unwrap(),
                ArchcarEvent::ChatQueueUpdated { thread_id },
            );
            // One queued input per turn. The session does not report "busy"
            // until the provider starts the turn, so a message queued in that
            // gap would otherwise be written into the same turn — which merges
            // two prompts and leaves the harness's turn accounting waiting for
            // a completion that never comes. TurnCompleted drains the next one.
            note_session_not_ready_for_queue(&handle);
        }
        Err(err) => {
            if let Err(restore_err) = store.requeue_claimed_chat_input_front(&queued) {
                warn!(
                    thread_id,
                    queue_id = queued.id,
                    error = %format!("{restore_err:#}"),
                    "archcar could not restore claimed queued chat input after send failure"
                );
            }
            warn!(
                thread_id,
                queue_id = queued.id,
                error = %err,
                "archcar could not send queued chat input"
            );
        }
    }
}

/// After a codex planning turn, take the plan it just proposed and raise the
/// same PlanApproval a Claude ExitPlanMode would have.
fn raise_codex_plan_approval(state: &Arc<Mutex<ServerState>>, thread_id: i64, session_id: i64) {
    let db_path = state.lock().unwrap().db_path.clone();
    let Ok(store) = WorkspaceStore::open_app(&db_path) else {
        return;
    };
    if !store.chat_thread_plan_mode(thread_id).unwrap_or(false) {
        return;
    }
    let Ok(thread) = store.get_chat_thread_record(thread_id) else {
        return;
    };
    if thread.provider != "codex" {
        return;
    }
    let interactions = ProviderInteractionStore::new(db_path.clone());
    if interactions
        .list(Some(thread_id), true)
        .map(|pending| {
            pending
                .iter()
                .any(|interaction| interaction.kind == ProviderInteractionKind::PlanApproval)
        })
        .unwrap_or(false)
    {
        return;
    }
    let Some(plan_markdown) = latest_assistant_text(&db_path, thread_id) else {
        return;
    };
    let Ok(workspace) = store.get_workspace_record(thread.workspace_id) else {
        return;
    };
    let draft = crate::archcar::harness_contract::ProviderInteractionDraft {
        provider_key: "codex".to_owned(),
        workspace: workspace.name.clone(),
        thread_id,
        session_id,
        native_session_id: thread.native_thread_id.clone(),
        // Codex is not holding a request open for this, so the id only has to
        // be unique to the plan it belongs to.
        native_id: format!(
            "codex-plan-{thread_id}-{}",
            plan_fingerprint(&plan_markdown)
        ),
        kind: ProviderInteractionKind::PlanApproval,
        title: "Plan ready for review".to_owned(),
        detail: plan_markdown.clone(),
        questions: Vec::new(),
        auto_resolution_ms: None,
        native_request: serde_json::json!({ "source": "codex-plan-turn" }),
    };
    let runtime_store = crate::runtime_session_store::RuntimeSessionStore::new(db_path);
    match runtime_store.register_provider_interaction(draft) {
        Ok(interaction) => {
            let interaction = runtime_store
                .save_chat_plan(thread_id, &interaction.id, &plan_markdown)
                .and_then(|plan_path| {
                    runtime_store.attach_interaction_plan_path(&interaction.id, &plan_path)
                })
                .unwrap_or(interaction);
            broadcast(
                &mut state.lock().unwrap(),
                ArchcarEvent::ProviderInteractionRequested { interaction },
            );
        }
        Err(err) => {
            warn!(thread_id, error = %format!("{err:#}"), "archcar could not raise a codex plan approval");
        }
    }
}

/// The assistant's last word in a thread — for a planning turn, that is the plan.
fn latest_assistant_text(db_path: &Path, thread_id: i64) -> Option<String> {
    let projection = provider_projection_from_records(
        &ProviderEventStore::new(db_path)
            .list_for_chat_thread(thread_id)
            .ok()?,
    );
    projection
        .items
        .iter()
        .rev()
        .find(|item| {
            item.render_class == crate::provider_projection::ProjectionRenderClass::AssistantChat
                && !item.body.trim().is_empty()
        })
        .map(|item| item.body.clone())
}

fn plan_fingerprint(plan_markdown: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    plan_markdown.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Fail pending asks whose session has exited: their native request ids died
/// with the process, so they can never be answered.
fn expire_pending_interactions_for_session(state: &Arc<Mutex<ServerState>>, session_id: i64) {
    let db_path = state.lock().unwrap().db_path.clone();
    let store = ProviderInteractionStore::new(db_path);
    let Ok(pending) = store.list(None, true) else {
        return;
    };
    for interaction in pending
        .into_iter()
        .filter(|interaction| interaction.session_id == session_id)
    {
        match store.expire(&interaction.id) {
            Ok(expired) => broadcast(
                &mut state.lock().unwrap(),
                ArchcarEvent::ProviderInteractionResolved {
                    interaction: expired,
                },
            ),
            Err(err) => {
                warn!(interaction = %interaction.id, error = %format!("{err:#}"), "archcar could not expire a pending interaction");
            }
        }
    }
}

/// Enter or leave plan mode. Both providers switch mid-session, so a live
/// session is told directly rather than restarted; the thread flag makes it
/// stick for future sessions.
fn set_chat_plan_mode(
    state: &Arc<Mutex<ServerState>>,
    thread_id: i64,
    plan_mode: bool,
) -> ArchcarResponse {
    let db_path = state.lock().unwrap().db_path.clone();
    let store = match WorkspaceStore::open_app(&db_path) {
        Ok(store) => store,
        Err(err) => {
            return ArchcarResponse::Error {
                message: err.to_string(),
            }
        }
    };
    if let Err(err) = store.set_chat_thread_plan_mode(thread_id, plan_mode) {
        return ArchcarResponse::Error {
            message: err.to_string(),
        };
    }
    for kind in [SessionKind::Claude, SessionKind::Codex] {
        if let Some(handle) = live_session_handle_for_thread(state, thread_id, kind) {
            let mode = match kind {
                SessionKind::Claude if plan_mode => {
                    Some(crate::archcar::session::CLAUDE_PLAN_PERMISSION_MODE.to_owned())
                }
                SessionKind::Claude => {
                    Some(crate::archcar::session::CLAUDE_DEFAULT_PERMISSION_MODE.to_owned())
                }
                // Codex carries plan mode as a read-only sandbox on the turns
                // it starts; the adapter only needs to know which mode it is in.
                SessionKind::Codex if plan_mode => Some(
                    crate::provider_adapters::codex_app_server::CODEX_PLAN_PERMISSION_MODE
                        .to_owned(),
                ),
                SessionKind::Codex => Some("default".to_owned()),
                _ => None,
            };
            if let Some(mode) = mode {
                let _ = handle.command_tx.send(SessionCommand::ApplyControl(
                    crate::archcar::harness_contract::HarnessControl::SetPermissionMode(Some(mode)),
                ));
            }
        }
    }
    let plan_path = store.chat_thread_plan_path(thread_id).ok().flatten();
    broadcast(
        &mut state.lock().unwrap(),
        ArchcarEvent::ChatPlanUpdated {
            thread_id,
            plan_mode,
            plan_path: plan_path.clone(),
        },
    );
    ArchcarResponse::ChatPlan {
        thread_id,
        plan_mode,
        plan_path,
        plan_markdown: None,
    }
}

/// Read a plan back out of the workspace checkout.
fn read_thread_plan_markdown(
    store: &WorkspaceStore,
    thread_id: i64,
    plan_path: &str,
) -> Result<Option<String>> {
    let thread = store.get_chat_thread_record(thread_id)?;
    let workspace = store.get_workspace_record(thread.workspace_id)?;
    let absolute = Path::new(&workspace.path).join(plan_path);
    Ok(std::fs::read_to_string(absolute).ok())
}

/// Send a resolved interaction back to the provider that asked, and carry out
/// what approving a plan means: leave plan mode and start building from the
/// plan we saved.
fn deliver_interaction_resolution(
    state: &Arc<Mutex<ServerState>>,
    interaction: &ProviderInteractionRecord,
    resolution: &InteractionResolution,
) {
    let Some(handle) = live_session_handle_for_session(state, interaction.session_id) else {
        warn!(
            interaction = %interaction.id,
            session_id = interaction.session_id,
            "archcar could not answer a provider interaction: its session is gone"
        );
        return;
    };
    if let Err(err) = handle.command_tx.send(SessionCommand::ApplyControl(
        crate::archcar::harness_contract::HarnessControl::ResolveInteraction {
            native_id: interaction.native_id.clone(),
            resolution: resolution.clone(),
        },
    )) {
        warn!(
            interaction = %interaction.id,
            error = %err,
            "archcar could not deliver an interaction resolution to its session"
        );
        return;
    }
    let approved = matches!(
        resolution,
        InteractionResolution::Approve | InteractionResolution::ApproveForSession
    );
    if interaction.kind == ProviderInteractionKind::PlanApproval && approved {
        start_building_approved_plan(state, interaction);
    }
}

/// Approving a plan ends planning: the thread leaves plan mode and the agent is
/// told to build what was agreed, pointing at the saved file rather than
/// re-pasting the plan.
fn start_building_approved_plan(
    state: &Arc<Mutex<ServerState>>,
    interaction: &ProviderInteractionRecord,
) {
    let db_path = state.lock().unwrap().db_path.clone();
    let store = match WorkspaceStore::open_app(&db_path) {
        Ok(store) => store,
        Err(err) => {
            warn!(error = %format!("{err:#}"), "archcar could not open store to start an approved plan");
            return;
        }
    };
    if let Err(err) = store.set_chat_thread_plan_mode(interaction.thread_id, false) {
        warn!(error = %format!("{err:#}"), "archcar could not clear plan mode after approval");
    }
    broadcast(
        &mut state.lock().unwrap(),
        ArchcarEvent::ChatPlanUpdated {
            thread_id: interaction.thread_id,
            plan_mode: false,
            plan_path: interaction.plan_path.clone(),
        },
    );
    let Some(plan_path) = interaction.plan_path.clone() else {
        return;
    };
    let input = format!("Implement the plan at {plan_path}.");
    if let Err(err) = store.enqueue_chat_input(
        interaction.thread_id,
        &input,
        Some("Implement the approved plan"),
        crate::archcar::protocol::ArchcarInputKind::User,
        session_kind_for_provider(&interaction.provider_key),
    ) {
        warn!(error = %format!("{err:#}"), "archcar could not queue the approved plan's build step");
        return;
    }
    broadcast(
        &mut state.lock().unwrap(),
        ArchcarEvent::ChatQueueUpdated {
            thread_id: interaction.thread_id,
        },
    );
    drain_queued_input_for_thread(state, interaction.thread_id);
}

fn session_kind_for_provider(provider_key: &str) -> SessionKind {
    match provider_key {
        "claude" => SessionKind::Claude,
        _ => SessionKind::Codex,
    }
}

fn live_session_handle_for_session(
    state: &Arc<Mutex<ServerState>>,
    session_id: i64,
) -> Option<SessionHandle> {
    state.lock().ok()?.sessions.get(&session_id).cloned()
}

fn ready_session_handle_for_thread(
    state: &Arc<Mutex<ServerState>>,
    thread_id: i64,
    kind: SessionKind,
) -> Option<SessionHandle> {
    state.lock().ok()?.sessions.values().find_map(|handle| {
        let snapshot = handle.snapshot.lock().ok()?.clone();
        (snapshot.thread_id == thread_id
            && snapshot.kind == kind
            && snapshot.status == crate::workspace::ProcessStatus::Running
            && snapshot.ready)
            .then_some(handle.clone())
    })
}

fn restore_ready_session_handle_for_queue(
    state: &Arc<Mutex<ServerState>>,
    store: &WorkspaceStore,
    thread_id: i64,
    kind: SessionKind,
) -> Option<SessionHandle> {
    let thread = store.get_chat_thread_record(thread_id).ok()?;
    let workspace = store.get_workspace_record(thread.workspace_id).ok()?;
    let _ = restore_thread_session_from_store(state, &workspace.name, thread_id, kind);
    ready_session_handle_for_thread(state, thread_id, kind)
}

/// Any live (running) session for this thread, ready or not. A busy session
/// still drains the queue when its turn completes, so it must not be treated as
/// "no session" and re-spawned.
fn live_session_handle_for_thread(
    state: &Arc<Mutex<ServerState>>,
    thread_id: i64,
    kind: SessionKind,
) -> Option<SessionHandle> {
    state.lock().ok()?.sessions.values().find_map(|handle| {
        let snapshot = handle.snapshot.lock().ok()?.clone();
        (snapshot.thread_id == thread_id
            && snapshot.kind == kind
            && snapshot.status == crate::workspace::ProcessStatus::Running)
            .then_some(handle.clone())
    })
}

/// The workspace whose thread session must be started so a queued input can be
/// delivered, or `None` when a session already exists (or the kind cannot be
/// auto-started).
fn workspace_needing_session_for_queue(
    state: &Arc<Mutex<ServerState>>,
    store: &WorkspaceStore,
    thread_id: i64,
    kind: SessionKind,
) -> Option<String> {
    if !matches!(kind, SessionKind::Codex | SessionKind::Claude) {
        return None;
    }
    if live_session_handle_for_thread(state, thread_id, kind).is_some() {
        return None;
    }
    let thread = store.get_chat_thread_record(thread_id).ok()?;
    let workspace = store.get_workspace_record(thread.workspace_id).ok()?;
    Some(workspace.name)
}

/// Start the session a queued input needs. Runs off-thread: spawning takes
/// seconds and `ensure_chat_thread_session` drains the queue itself, which
/// would re-enter the drain guard if it ran inline.
fn start_session_for_queued_thread(
    state: &Arc<Mutex<ServerState>>,
    store: &WorkspaceStore,
    thread_id: i64,
    kind: SessionKind,
) {
    let Some(workspace) = workspace_needing_session_for_queue(state, store, thread_id, kind) else {
        return;
    };
    info!(
        %workspace,
        thread_id,
        ?kind,
        "archcar starting chat-thread session to deliver queued input"
    );
    let state = Arc::clone(state);
    std::thread::spawn(move || {
        let response = ensure_chat_thread_session(
            &state,
            workspace.clone(),
            thread_id,
            kind,
            crate::workspace::SessionHarnessOptions::default(),
        );
        if let ArchcarResponse::Error { message } = response {
            warn!(
                %workspace,
                thread_id,
                ?kind,
                error = %message,
                "archcar could not start session for queued chat input"
            );
        }
    });
}

fn note_session_not_ready_for_queue(handle: &SessionHandle) {
    let Ok(mut snapshot) = handle.snapshot.lock() else {
        return;
    };
    if matches!(snapshot.kind, SessionKind::Codex | SessionKind::Claude) {
        snapshot.ready = false;
        snapshot.runtime_state = crate::session_state::AgentSessionState::Running;
    }
}

fn handle_session_event(state: &Arc<Mutex<ServerState>>, event: ArchcarEvent) {
    let drain_thread_id = match &event {
        ArchcarEvent::SessionReady { thread_id, .. }
        | ArchcarEvent::TurnCompleted { thread_id, .. } => Some(*thread_id),
        _ => None,
    };
    // Codex has no ExitPlanMode: a planning turn simply ends with the plan as
    // its answer, so the plan approval is raised here instead of by the
    // provider. Same card, same buttons, different transport.
    if let ArchcarEvent::TurnCompleted {
        thread_id,
        session_id,
        ..
    } = &event
    {
        raise_codex_plan_approval(state, *thread_id, *session_id);
    }
    // An ask can only be answered on the connection it arrived on; once the
    // session is gone the request id means nothing, so pending asks must not
    // linger in the UI as if they were still answerable.
    if let ArchcarEvent::SessionExited { session_id, .. } = &event {
        expire_pending_interactions_for_session(state, *session_id);
    }
    // Continuous context maintenance: turn boundaries and message updates are
    // the evidence streams behind workspace/current-chat summaries.
    let refresh_thread_id = match &event {
        ArchcarEvent::TurnCompleted { thread_id, .. }
        | ArchcarEvent::SessionMessagesUpdated { thread_id } => Some(*thread_id),
        _ => None,
    };
    {
        let mut guard = state.lock().unwrap();
        if let ArchcarEvent::SessionExited { session_id, .. } = &event {
            guard.sessions.remove(session_id);
        }
        broadcast(&mut guard, event);
    }
    if let Some(thread_id) = drain_thread_id {
        drain_queued_input_for_thread(state, thread_id);
    }
    if let Some(thread_id) = refresh_thread_id {
        if let Some(workspace) = workspace_name_for_thread(state, thread_id) {
            refresh_workspace_context_after_change(state, &workspace, Some(thread_id));
        }
    }
}

fn queued_archcar_input_from_record(
    input: crate::workspace::QueuedChatInputRecord,
) -> QueuedArchcarInput {
    QueuedArchcarInput {
        id: input.id,
        thread_id: input.thread_id,
        input: input.input,
        visible_input: input.visible_input,
        kind: input.input_kind,
        session_kind: input.session_kind,
        created_at: input.created_at,
        updated_at: input.updated_at,
    }
}

fn live_session_snapshot_for_thread(
    state: &ServerState,
    thread_id: i64,
) -> Option<ArchcarChatLiveSession> {
    state.sessions.values().find_map(|handle| {
        let snapshot = handle.snapshot.lock().ok()?.clone();
        if snapshot.thread_id != thread_id {
            return None;
        }
        Some(ArchcarChatLiveSession {
            session_id: snapshot.session_id,
            status: snapshot.status.as_str().to_owned(),
            runtime_state: snapshot.runtime_state,
            ready: snapshot.ready,
            capabilities: snapshot.capabilities,
        })
    })
}

fn send_session_control(
    state: &Arc<Mutex<ServerState>>,
    session_id: i64,
    control: HarnessControl,
) -> ArchcarResponse {
    match load_or_restore_session_handle(state, session_id) {
        Ok(Some(handle)) => {
            match handle
                .command_tx
                .send(crate::archcar::session::SessionCommand::ApplyControl(
                    control,
                )) {
                Ok(_) => ArchcarResponse::Ack,
                Err(err) => ArchcarResponse::Error {
                    message: err.to_string(),
                },
            }
        }
        Ok(None) => ArchcarResponse::Error {
            message: format!("unknown session {session_id}"),
        },
        Err(err) => ArchcarResponse::Error {
            message: err.to_string(),
        },
    }
}

/// Open the workspace store the way lifecycle-mutating CLI/GTK flows do:
/// with the logs directory wired and pending lifecycle jobs recovered so a
/// prior crash mid-create/delete doesn't leave the store inconsistent.
fn open_lifecycle_workspace_store(state: &Arc<Mutex<ServerState>>) -> Result<WorkspaceStore> {
    let (db_path, logs_dir) = {
        let guard = state.lock().unwrap();
        (guard.db_path.clone(), guard.logs_dir.clone())
    };
    let store = WorkspaceStore::open_app_with_logs(db_path, logs_dir)?;
    store.recover_workspace_lifecycle_jobs()?;
    Ok(store)
}

struct RepositoryCloneCommand {
    program: &'static str,
    args: Vec<String>,
    failure_context: &'static str,
}

fn clone_command_for_url(url: &str, dest: &str) -> RepositoryCloneCommand {
    if is_github_remote_url(url) {
        return RepositoryCloneCommand {
            program: "gh",
            args: vec![
                "repo".to_owned(),
                "clone".to_owned(),
                url.to_owned(),
                dest.to_owned(),
            ],
            failure_context: "run gh repo clone",
        };
    }

    RepositoryCloneCommand {
        program: "git",
        args: vec!["clone".to_owned(), url.to_owned(), dest.to_owned()],
        failure_context: "run git clone",
    }
}

fn is_github_remote_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://github.com/")
        || lower.starts_with("http://github.com/")
        || lower.starts_with("ssh://git@github.com/")
        || lower.starts_with("git@github.com:")
}

fn command_failure_message(
    program: &str,
    args: &[String],
    output: &std::process::Output,
) -> String {
    let mut message = format!("{program} {} failed ({})", args.join(" "), output.status);
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if !stderr.is_empty() {
        message.push_str(": ");
        message.push_str(&stderr);
        return message;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if !stdout.is_empty() {
        message.push_str(": ");
        message.push_str(&stdout);
    }
    message
}

/// Clone a remote repository into `dest`. GitHub remotes go through `gh` so the
/// desktop Clone tab uses the same local GitHub CLI auth it used to list repos.
/// The caller then registers the cloned path with `RepositoryStore::add`.
fn clone_repository(url: &str, dest: &str) -> Result<()> {
    let command = clone_command_for_url(url, dest);
    let output = std::process::Command::new(command.program)
        .args(&command.args)
        .output()
        .with_context(|| command.failure_context)?;
    anyhow::ensure!(
        output.status.success(),
        "{}",
        command_failure_message(command.program, &command.args, &output)
    );
    Ok(())
}

fn workspace_git_action_visible_input(action: WorkspaceGitAction) -> &'static str {
    match action {
        WorkspaceGitAction::CreatePr => "Create pull request",
        WorkspaceGitAction::PushBranch => "Push branch",
        WorkspaceGitAction::MergePr => "Merge pull request",
        WorkspaceGitAction::OpenPr => "Review pull request",
    }
}

fn archcar_request_is_mutating(request: &ArchcarRequest) -> bool {
    !matches!(
        request,
        ArchcarRequest::Subscribe
            | ArchcarRequest::GetSessionStatus { .. }
            | ArchcarRequest::GetSessionScreen { .. }
            | ArchcarRequest::GetSessionMessages { .. }
            | ArchcarRequest::GetChatSnapshot { .. }
            | ArchcarRequest::ListQueuedChatInputs { .. }
            | ArchcarRequest::GetInventorySnapshot
            | ArchcarRequest::ListWorkspaces
            | ArchcarRequest::ListRepositories
            | ArchcarRequest::ListChatThreads { .. }
            | ArchcarRequest::GetChatProjection { .. }
            | ArchcarRequest::ListChatTranscripts { .. }
            | ArchcarRequest::GetChatTranscript { .. }
            | ArchcarRequest::ListContextPlans { .. }
            | ArchcarRequest::ListWorkspaceFiles { .. }
            | ArchcarRequest::ReadWorkspaceFile { .. }
            | ArchcarRequest::GetWorkspaceChanges { .. }
            | ArchcarRequest::GetWorkspaceDiff { .. }
            | ArchcarRequest::ListTodos { .. }
            | ArchcarRequest::ListCheckpoints { .. }
            | ArchcarRequest::GetWorkspaceProcesses { .. }
            | ArchcarRequest::ListWorkspaceTimeline { .. }
            | ArchcarRequest::ListWorkspaceConflicts { .. }
            | ArchcarRequest::ListLinkedDirectories { .. }
            | ArchcarRequest::GetSpotlightStatus { .. }
            | ArchcarRequest::GetPullRequestReadiness { .. }
            | ArchcarRequest::GetWorkspaceGitActionPrompt { .. }
            | ArchcarRequest::GetRecentCommits { .. }
            | ArchcarRequest::GetCommitMessageDraft { .. }
            | ArchcarRequest::GetCommitDiff { .. }
            | ArchcarRequest::GetRunLog { .. }
            | ArchcarRequest::GetCheckLog { .. }
            | ArchcarRequest::ListWorkspaceChecks { .. }
            | ArchcarRequest::ListReviewComments { .. }
            | ArchcarRequest::GetChecksSummary { .. }
            | ArchcarRequest::GetSettings { .. }
            | ArchcarRequest::ListRepositoryBranches { .. }
            | ArchcarRequest::ListPromptPacks { .. }
            | ArchcarRequest::GetSettingsSource { .. }
            | ArchcarRequest::GetSetupReadiness { .. }
            | ArchcarRequest::GetPullRequestDraft { .. }
            | ArchcarRequest::GetServiceStatus
            | ArchcarRequest::GetRemoteAccess
            | ArchcarRequest::ListBackgroundTasks { .. }
            | ArchcarRequest::GetBackgroundTask { .. }
            | ArchcarRequest::ListTasks { .. }
            | ArchcarRequest::ListSummaries { .. }
            | ArchcarRequest::DraftSummary { .. }
            | ArchcarRequest::GetContextBriefing { .. }
            | ArchcarRequest::ListContextAttachments { .. }
            | ArchcarRequest::ListSessionContributions { .. }
            | ArchcarRequest::ListSessionOverlaps { .. }
            | ArchcarRequest::ListSessionRuns { .. }
            | ArchcarRequest::ListDiffContributions { .. }
            | ArchcarRequest::CompareCheckpoint { .. }
    )
}

const DIFF_RENDER_LIMIT_BYTES: usize = 200_000;

/// The unified diff for one scope, which is what a client actually renders.
///
/// This replaced a three-section document (working tree / unstaged / staged
/// concatenated under headings). That shape forced every caller to pick a
/// section, and the sections overlap — a file that is both staged and unstaged
/// appeared twice with overlapping hunks. Returning exactly the scope that was
/// asked for lets the changes panel and the file view agree on what is shown.
fn scoped_workspace_diff(
    store: &WorkspaceStore,
    name: &str,
    path: Option<&str>,
    scope: &WorkspaceChangeScope,
) -> Result<String> {
    let path_ref = path.map(Path::new);
    let diff = match scope {
        WorkspaceChangeScope::All => store.unified_diff_against_base(name, path_ref)?,
        WorkspaceChangeScope::Uncommitted => store.uncommitted_diff(name, path_ref)?,
        WorkspaceChangeScope::Commit { sha } => store.commit_diff(name, sha, path_ref)?,
    };
    Ok(truncate_diff_for_render(diff))
}

fn truncate_diff_for_render(text: String) -> String {
    if text.len() <= DIFF_RENDER_LIMIT_BYTES {
        return text;
    }
    let mut end = DIFF_RENDER_LIMIT_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[Diff truncated after {DIFF_RENDER_LIMIT_BYTES} bytes. Open the file for full context.]\n",
        &text[..end]
    )
}

fn exit_code_label(exit_code: Option<i32>) -> String {
    exit_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "-".to_owned())
}

// Build the Setup/Run tab prompt — port of the GTK run console's
// workspace_script_prompt. Instructs the agent to (re)write scripts.setup/run in
// .archductor/settings.toml, seeding it with any script already configured, then
// appends the repo's configured Setup/Run prompt as extra instructions.
fn workspace_script_prompt(store: &WorkspaceStore, name: &str, kind: &str) -> String {
    use crate::settings::PromptKind;
    let (script_key, label, prompt_kind) = match kind {
        "run" => ("run", "Run", PromptKind::RunScript),
        _ => ("setup", "Setup", PromptKind::SetupScript),
    };
    let current = store
        .workspace_repo_settings(name)
        .ok()
        .and_then(|settings| match script_key {
            "run" => settings.scripts.run,
            _ => settings.scripts.setup,
        });
    let mut prompt = match current {
        Some(script) if !script.trim().is_empty() => format!(
            "Create or update .archductor/settings.toml for workspace {name}.\n\
             Set scripts.{script_key} to this multiline shell block of successive commands:\n\n{script}\n"
        ),
        _ => format!(
            "Create or update .archductor/settings.toml for workspace {name}.\n\
             Define scripts.{script_key} as a multiline shell block so the {label} tab can run successive commands in order.\n\
             Keep the commands short, reliable, and checked into the repo."
        ),
    };
    if let Some(configured) = store
        .resolved_prompt(name, prompt_kind)
        .ok()
        .flatten()
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        prompt.push_str("\n\nRepository instructions:\n");
        prompt.push_str(configured);
    }
    prompt
}

fn workspace_run_scripts(store: &WorkspaceStore, name: &str) -> Vec<ArchcarRunScript> {
    let Ok(settings) = store.workspace_repo_settings(name) else {
        return Vec::new();
    };
    let scripts = if settings.scripts.run_scripts.is_empty() {
        settings
            .scripts
            .run
            .filter(|command| !command.trim().is_empty())
            .map(|command| {
                vec![crate::settings::RunScriptDefinition {
                    id: "run".to_owned(),
                    command,
                    available_in: Vec::new(),
                    default: true,
                    icon: Some("play".to_owned()),
                }]
            })
            .unwrap_or_default()
    } else {
        settings.scripts.run_scripts
    };

    scripts
        .into_iter()
        .map(|script| {
            let runnable_here = script.runnable_locally();
            ArchcarRunScript {
                id: script.id,
                command: script.command,
                available_in: script.available_in,
                default: script.default,
                icon: script.icon,
                runnable_here,
                unavailable_reason: (!runnable_here)
                    .then(|| "Available only in cloud workspaces.".to_owned()),
            }
        })
        .collect()
}

fn archcar_process_summary(process: &crate::workspace::ProcessRecord) -> ArchcarProcessSummary {
    let kind = match process.kind {
        crate::workspace::ProcessKind::Setup => "setup",
        crate::workspace::ProcessKind::Run => "run",
        crate::workspace::ProcessKind::Check => "check",
        crate::workspace::ProcessKind::Session => "session",
        crate::workspace::ProcessKind::Terminal => "terminal",
    };
    ArchcarProcessSummary {
        id: process.id,
        kind: kind.to_owned(),
        pid: process.pid,
        status: process.status.as_str().to_owned(),
        log_path: process.log_path.to_string_lossy().into_owned(),
    }
}

/// Compose the Processes tab text (Setups / Runs / Checks / Sessions). Ported
/// from workspace_command_center::workspace_processes_text.
fn workspace_processes_text(store: &WorkspaceStore, name: &str) -> String {
    let mut out = String::new();
    let section = |out: &mut String,
                   title: &str,
                   result: Result<Vec<crate::workspace::ProcessRecord>>,
                   empty: &str,
                   with_command: bool| {
        out.push_str(title);
        out.push('\n');
        match result {
            Ok(records) if records.is_empty() => {
                out.push_str(empty);
                out.push('\n');
            }
            Ok(records) => {
                for r in records {
                    if with_command {
                        out.push_str(&format!(
                            "#{} {} {} pid={} exit={} started={} log={}\n",
                            r.id,
                            r.command,
                            r.status.as_str(),
                            r.pid,
                            exit_code_label(r.exit_code),
                            r.started_at,
                            r.log_path.display()
                        ));
                    } else {
                        out.push_str(&format!(
                            "#{} {} pid={} exit={} started={} log={}\n",
                            r.id,
                            r.status.as_str(),
                            r.pid,
                            exit_code_label(r.exit_code),
                            r.started_at,
                            r.log_path.display()
                        ));
                    }
                }
            }
            Err(err) => out.push_str(&format!("Could not read: {err:#}\n")),
        }
    };
    section(
        &mut out,
        "Setups",
        store.list_setups(name),
        "No setup runs recorded.",
        false,
    );
    out.push('\n');
    section(
        &mut out,
        "Runs",
        store.list_runs(name),
        "No runs recorded.",
        false,
    );
    out.push('\n');
    section(
        &mut out,
        "Checks",
        store.list_checks(name),
        "No check runs recorded.",
        false,
    );
    out.push('\n');
    section(
        &mut out,
        "Sessions",
        store.list_sessions(name),
        "No sessions recorded.",
        true,
    );
    out
}

fn workspace_summary_from_status_line(
    line: WorkspaceStatusLine,
    changed_files: usize,
    tasks: crate::workspace_intel::TaskCounts,
) -> ArchcarWorkspaceSummary {
    let WorkspaceStatusLine {
        workspace,
        repository_name,
        open_todos,
        pull_request,
        run_running,
        active_sessions,
        branch_push_state,
        diff_additions,
        diff_deletions,
    } = line;
    ArchcarWorkspaceSummary {
        id: workspace.id,
        name: workspace.name,
        repository_name,
        path: workspace.path.display().to_string(),
        branch: workspace.branch,
        base_ref: workspace.base_ref,
        status: workspace.status,
        open_todos,
        open_tasks: tasks.open,
        blocked_tasks: tasks.blocked,
        active_sessions,
        run_running,
        changed_files,
        diff_additions,
        diff_deletions,
        pull_request_number: pull_request.as_ref().map(|pr| pr.number),
        pull_request_state: pull_request.as_ref().map(|pr| pr.state.clone()),
        pull_request_url: pull_request.map(|pr| pr.url),
        branch_ahead: branch_push_state.as_ref().map(|s| s.ahead),
        branch_behind: branch_push_state.map(|s| s.behind),
        updated_at: workspace.updated_at,
    }
}

fn workspace_summaries(db_path: &Path) -> Result<Vec<ArchcarWorkspaceSummary>> {
    WorkspaceStore::open_app(db_path).and_then(|store| {
        let lines = store.list_status()?;
        let task_counts = store.task_counts_by_workspace().unwrap_or_default();
        Ok(lines
            .into_iter()
            .map(|line| {
                // Match the GTK dashboard card: changed-file count for the diff
                // badge, only meaningful for active checkouts.
                let changed_files = if line.workspace.status == "active" {
                    store
                        .changed_files(&line.workspace.name)
                        .map(|files| files.len())
                        .unwrap_or(0)
                } else {
                    0
                };
                let tasks = task_counts
                    .get(&line.workspace.id)
                    .copied()
                    .unwrap_or_default();
                workspace_summary_from_status_line(line, changed_files, tasks)
            })
            .collect())
    })
}

fn repository_summaries(db_path: &Path) -> Result<Vec<ArchcarRepositorySummary>> {
    RepositoryStore::open(db_path)
        .and_then(|store| store.list_with_workspace_counts())
        .map(|rows| {
            rows.into_iter()
                .map(|(repo, active, total)| ArchcarRepositorySummary {
                    id: repo.id,
                    name: repo.name,
                    root_path: repo.root_path.to_string_lossy().into_owned(),
                    default_branch: repo.default_branch,
                    remote_name: repo.remote_name,
                    active_workspaces: active,
                    total_workspaces: total,
                })
                .collect()
        })
}

fn chat_threads_for_workspace(db_path: &Path, workspace: &str) -> Result<Vec<ArchcarChatThread>> {
    WorkspaceStore::open_app(db_path)
        .and_then(|store| store.list_chat_threads(workspace))
        .map(|threads| {
            threads
                .into_iter()
                .map(|t| {
                    let harness = crate::workspace::SessionHarnessOptions::from_metadata(
                        t.harness_metadata.as_deref(),
                    );
                    ArchcarChatThread {
                        id: t.id,
                        provider: t.provider,
                        title: t.title,
                        status: t.status,
                        model: t.model,
                        effort_mode: harness.effort_mode,
                        fast_mode: harness.fast_mode,
                        updated_at: t.updated_at,
                        archived_at: t.archived_at,
                    }
                })
                .collect()
        })
}

/// Repositories, workspaces, and each workspace's chat threads, as one bundle.
type InventorySnapshot = (
    Vec<ArchcarRepositorySummary>,
    Vec<ArchcarWorkspaceSummary>,
    BTreeMap<String, Vec<ArchcarChatThread>>,
);

fn inventory_snapshot(db_path: &Path) -> Result<InventorySnapshot> {
    let repositories = repository_summaries(db_path)?;
    let workspaces = workspace_summaries(db_path)?;
    let mut chat_threads = BTreeMap::new();
    for workspace in workspaces.iter().filter(|ws| ws.status != "archived") {
        chat_threads.insert(
            workspace.name.clone(),
            chat_threads_for_workspace(db_path, &workspace.name)?,
        );
    }
    Ok((repositories, workspaces, chat_threads))
}

fn begin_shutdown(state: &Arc<Mutex<ServerState>>) {
    let mut guard = state.lock().unwrap();
    guard.shutting_down = true;
    guard.subscribers.clear();
}

fn session_messages_for_thread(db_path: &Path, thread_id: i64) -> Result<Vec<ArchcarMessage>> {
    let store = WorkspaceStore::open_app(db_path)?;
    let mut persisted_messages: Vec<_> = store
        .list_chat_messages(thread_id)?
        .into_iter()
        .map(|message| ArchcarMessage {
            id: message.id,
            role: message.role,
            content: message.content,
            source: message.source,
            inline_event: None,
            context_usage: None,
        })
        .collect();
    persisted_messages.sort_by_key(|message| message.id);

    let provider_records = ProviderEventStore::new(db_path).list_for_chat_thread(thread_id)?;
    let projection = provider_projection_from_records(&provider_records);
    let mut messages = Vec::new();
    let mut next_provider_message_id = -1;
    let provider_items = projection
        .items
        .into_iter()
        .filter(provider_projection_item_is_relevant_chat_event)
        .collect::<Vec<_>>();
    let has_provider_user_anchors = provider_items.iter().any(|item| {
        item.render_class.role_label() == "user"
            && !provider_projection_item_text(item).trim().is_empty()
    });
    if !has_provider_user_anchors {
        messages.append(&mut persisted_messages);
    }
    for item in provider_items {
        let content = provider_projection_item_text(&item);
        let content = if item.render_class.role_label() == "assistant" {
            store.apply_agent_chat_metadata_directive(thread_id, &content)?
        } else {
            content
        };
        if content.trim().is_empty() {
            continue;
        }
        if item.render_class.role_label() == "user" {
            if let Some(index) = persisted_messages.iter().position(|message| {
                message.role == "user" && message.content.trim() == content.trim()
            }) {
                let matched = persisted_messages.remove(index);
                messages.extend(persisted_messages.drain(..index));
                messages.push(matched);
            } else if !messages.iter().any(|message: &ArchcarMessage| {
                semantic_roles_match(&message.role, "user")
                    && message.content.trim() == content.trim()
            }) {
                messages.push(ArchcarMessage {
                    id: next_provider_message_id,
                    role: "user".to_owned(),
                    content,
                    source: "provider_event".to_owned(),
                    inline_event: None,
                    context_usage: None,
                });
                next_provider_message_id -= 1;
            }
            continue;
        }
        if messages
            .iter()
            .chain(persisted_messages.iter())
            .any(|message: &ArchcarMessage| {
                message.source != "provider_event"
                    && semantic_roles_match(&message.role, item.render_class.role_label())
                    && message.content.trim() == content.trim()
            })
        {
            continue;
        }
        messages.push(ArchcarMessage {
            id: next_provider_message_id,
            role: item.render_class.role_label().to_owned(),
            content,
            source: "provider_event".to_owned(),
            inline_event: None,
            context_usage: None,
        });
        next_provider_message_id -= 1;
    }
    messages.extend(persisted_messages);

    Ok(messages)
}

fn chat_snapshot_for_thread(
    db_path: &Path,
    thread_id: i64,
    live_session: Option<ArchcarChatLiveSession>,
) -> Result<ArchcarChatSnapshot> {
    let store = WorkspaceStore::open_app(db_path)?;
    let messages = store.list_chat_messages(thread_id)?;
    let events = store.list_chat_events(thread_id)?;
    let queued_inputs = store
        .list_queued_chat_inputs(thread_id)?
        .into_iter()
        .map(queued_archcar_input_from_record)
        .collect();
    let provider_events = ProviderEventStore::new(db_path).list_for_chat_thread(thread_id)?;
    Ok(ArchcarChatSnapshot {
        thread_id,
        messages,
        events,
        provider_events,
        queued_inputs,
        live_session,
    })
}

fn semantic_roles_match(left: &str, right: &str) -> bool {
    left == right
        || matches!(
            (left, right),
            ("agent", "assistant") | ("assistant", "agent")
        )
}

fn ensure_default_session(
    state: &Arc<Mutex<ServerState>>,
    workspace: String,
    kind: SessionKind,
    harness: crate::workspace::SessionHarnessOptions,
) -> ArchcarResponse {
    if !matches!(kind, SessionKind::Codex | SessionKind::Claude) {
        return ArchcarResponse::Error {
            message: "only codex and claude auto-spawn are implemented".to_owned(),
        };
    }
    let mut guard = state.lock().unwrap();
    if let Some((session_id, thread_id, pid, ready)) = guard
        .sessions
        .values()
        .filter_map(|handle| {
            let snapshot = handle.snapshot.lock().ok()?.clone();
            (snapshot.workspace == workspace
                && snapshot.kind == kind
                && snapshot.status == crate::workspace::ProcessStatus::Running)
                .then_some((
                    snapshot.session_id,
                    snapshot.thread_id,
                    snapshot.pid,
                    snapshot.ready,
                ))
        })
        .max_by_key(|(session_id, _, _, _)| *session_id)
    {
        if ready {
            broadcast(
                &mut guard,
                ArchcarEvent::SessionReady {
                    session_id,
                    thread_id,
                },
            );
        }
        drop(guard);
        if ready {
            drain_queued_input_for_thread(state, thread_id);
        }
        return ArchcarResponse::SessionSpawned {
            session_id,
            thread_id,
            workspace,
            kind,
            pid,
        };
    }
    drop(guard);

    if let Some(response) = restore_workspace_session_from_store(state, &workspace, kind) {
        return response;
    }

    let mut guard = state.lock().unwrap();
    let queue_key = default_queue_key(&workspace, kind);
    if !guard.queued_defaults.insert(queue_key.clone()) {
        return ArchcarResponse::SessionSpawnQueued { workspace, kind };
    }
    let db_path = guard.db_path.clone();
    let logs_dir = guard.logs_dir.clone();
    let state_for_spawn = state.clone();
    broadcast(
        &mut guard,
        ArchcarEvent::SessionSpawnQueued {
            workspace: workspace.clone(),
            kind,
        },
    );
    info!(%workspace, ?kind, "archcar queued default session spawn");
    drop(guard);

    let workspace_for_spawn = workspace.clone();
    std::thread::spawn(move || {
        let (event_tx, event_rx) = mpsc::channel();
        match spawn_managed_session(
            db_path,
            logs_dir,
            workspace_for_spawn.clone(),
            kind,
            harness,
            event_tx,
        ) {
            Ok(handle) => {
                let session_id = handle.snapshot.lock().unwrap().session_id;
                info!(%workspace_for_spawn, session_id, ?kind, "archcar spawned managed session");
                let mut guard = state_for_spawn.lock().unwrap();
                if guard.shutting_down {
                    guard
                        .queued_defaults
                        .remove(&default_queue_key(&workspace_for_spawn, kind));
                    drop(guard);
                    terminate_managed_handle(&handle);
                    return;
                }
                guard.sessions.insert(session_id, handle);
                guard
                    .queued_defaults
                    .remove(&default_queue_key(&workspace_for_spawn, kind));
                drop(guard);
                while let Ok(event) = event_rx.recv() {
                    handle_session_event(&state_for_spawn, event);
                }
            }
            Err(err) => {
                let detail = format!("{err:#}");
                error!(%workspace_for_spawn, ?kind, error = %detail, "archcar failed to spawn managed session");
                let mut guard = state_for_spawn.lock().unwrap();
                guard
                    .queued_defaults
                    .remove(&default_queue_key(&workspace_for_spawn, kind));
                broadcast(
                    &mut guard,
                    ArchcarEvent::SessionError {
                        session_id: None,
                        thread_id: None,
                        message: detail,
                    },
                );
            }
        }
    });

    ArchcarResponse::SessionSpawnQueued { workspace, kind }
}

fn default_queue_key(workspace: &str, kind: SessionKind) -> String {
    let kind = match kind {
        SessionKind::Shell => "shell",
        SessionKind::Codex => "codex",
        SessionKind::Claude => "claude",
    };
    format!("{workspace}\0{kind}")
}

fn ensure_chat_thread_session(
    state: &Arc<Mutex<ServerState>>,
    workspace: String,
    thread_id: i64,
    kind: SessionKind,
    harness: crate::workspace::SessionHarnessOptions,
) -> ArchcarResponse {
    if !matches!(kind, SessionKind::Codex | SessionKind::Claude) {
        return ArchcarResponse::Error {
            message: "only codex and claude chat-thread auto-spawn are implemented".to_owned(),
        };
    }
    let mut guard = state.lock().unwrap();
    let db_path = guard.db_path.clone();
    let logs_dir = guard.logs_dir.clone();
    if let Some((session_id, pid, ready)) = guard
        .sessions
        .values()
        .filter_map(|handle| {
            let snapshot = handle.snapshot.lock().ok()?.clone();
            (snapshot.workspace == workspace
                && snapshot.kind == kind
                && snapshot.thread_id == thread_id
                && snapshot.status == crate::workspace::ProcessStatus::Running)
                .then_some((snapshot.session_id, snapshot.pid, snapshot.ready))
        })
        .max_by_key(|(session_id, _, _)| *session_id)
    {
        if ready {
            broadcast(
                &mut guard,
                ArchcarEvent::SessionReady {
                    session_id,
                    thread_id,
                },
            );
        }
        drop(guard);
        if ready {
            drain_queued_input_for_thread(state, thread_id);
        }
        return ArchcarResponse::SessionSpawned {
            session_id,
            thread_id,
            workspace,
            kind,
            pid,
        };
    }
    drop(guard);

    if let Err(err) = validate_chat_thread_workspace(&db_path, &workspace, thread_id, kind) {
        let message = format!("{err:#}");
        let mut guard = state.lock().unwrap();
        broadcast(
            &mut guard,
            ArchcarEvent::SessionError {
                session_id: None,
                thread_id: Some(thread_id),
                message: message.clone(),
            },
        );
        return ArchcarResponse::Error { message };
    }

    let mut guard = state.lock().unwrap();
    if !guard.queued_threads.insert(thread_id) {
        return ArchcarResponse::SessionSpawnQueued { workspace, kind };
    }
    drop(guard);

    if let Some(response) = restore_thread_session_from_store(state, &workspace, thread_id, kind) {
        if let Ok(mut guard) = state.lock() {
            guard.queued_threads.remove(&thread_id);
        }
        return response;
    }

    let mut guard = state.lock().unwrap();
    let state_for_spawn = state.clone();
    broadcast(
        &mut guard,
        ArchcarEvent::SessionSpawnQueued {
            workspace: workspace.clone(),
            kind,
        },
    );
    info!(%workspace, thread_id, ?kind, "archcar queued chat-thread session spawn");
    drop(guard);

    let workspace_for_spawn = workspace.clone();
    std::thread::spawn(move || {
        let (event_tx, event_rx) = mpsc::channel();
        match spawn_managed_session_for_thread(
            db_path,
            logs_dir,
            workspace_for_spawn.clone(),
            thread_id,
            kind,
            harness,
            event_tx,
        ) {
            Ok(handle) => {
                let session_id = handle.snapshot.lock().unwrap().session_id;
                info!(%workspace_for_spawn, thread_id, session_id, ?kind, "archcar spawned chat-thread managed session");
                let mut guard = state_for_spawn.lock().unwrap();
                if guard.shutting_down {
                    guard.queued_threads.remove(&thread_id);
                    drop(guard);
                    terminate_managed_handle(&handle);
                    return;
                }
                // Registration race with abort_background_agents: the thread
                // may have been closed while this session was spawning. The
                // check runs under the state lock and abort closes threads
                // *before* it snapshots sessions, so either this sees the
                // close (terminate here) or the abort snapshot sees the
                // insert (killed there). A closed thread never keeps an
                // unsupervised live agent.
                let closed = WorkspaceStore::open_app(&guard.db_path)
                    .and_then(|store| store.chat_thread_is_closed(thread_id))
                    .unwrap_or(false);
                if closed {
                    guard.queued_threads.remove(&thread_id);
                    drop(guard);
                    info!(
                        thread_id,
                        session_id,
                        "archcar dropping managed session for a thread closed during spawn"
                    );
                    terminate_managed_handle(&handle);
                    return;
                }
                guard.sessions.insert(session_id, handle);
                guard.queued_threads.remove(&thread_id);
                drop(guard);
                while let Ok(event) = event_rx.recv() {
                    handle_session_event(&state_for_spawn, event);
                }
            }
            Err(err) => {
                let detail = format!("{err:#}");
                error!(%workspace_for_spawn, thread_id, ?kind, error = %detail, "archcar failed to spawn chat-thread managed session");
                let mut guard = state_for_spawn.lock().unwrap();
                guard.queued_threads.remove(&thread_id);
                broadcast(
                    &mut guard,
                    ArchcarEvent::SessionError {
                        session_id: None,
                        thread_id: Some(thread_id),
                        message: detail,
                    },
                );
            }
        }
    });

    ArchcarResponse::SessionSpawnQueued { workspace, kind }
}

fn restore_workspace_session_from_store(
    state: &Arc<Mutex<ServerState>>,
    workspace: &str,
    kind: SessionKind,
) -> Option<ArchcarResponse> {
    let db_path = state.lock().ok()?.db_path.clone();
    let store = match WorkspaceStore::open_app(&db_path) {
        Ok(store) => store,
        Err(err) => {
            warn!(
                workspace,
                ?kind,
                error = %format!("{err:#}"),
                "archcar failed to open workspace store for persisted session restore"
            );
            return None;
        }
    };
    let records = match store.list_sessions(workspace) {
        Ok(records) => records,
        Err(err) => {
            warn!(
                workspace,
                ?kind,
                error = %format!("{err:#}"),
                "archcar failed to list persisted sessions for restore"
            );
            return None;
        }
    };

    for record in persisted_running_session_candidates(&records, kind) {
        match load_or_restore_session_handle(state, record.id) {
            Ok(Some(handle)) => {
                let snapshot = match handle.snapshot.lock() {
                    Ok(snapshot) => snapshot.clone(),
                    Err(_) => continue,
                };
                if snapshot.workspace != workspace
                    || snapshot.kind != kind
                    || snapshot.status != crate::workspace::ProcessStatus::Running
                {
                    continue;
                }

                let mut guard = match state.lock() {
                    Ok(guard) => guard,
                    Err(_) => return None,
                };
                if snapshot.ready {
                    broadcast(
                        &mut guard,
                        ArchcarEvent::SessionReady {
                            session_id: snapshot.session_id,
                            thread_id: snapshot.thread_id,
                        },
                    );
                }
                drop(guard);
                if snapshot.ready {
                    drain_queued_input_for_thread(state, snapshot.thread_id);
                }
                info!(
                    workspace,
                    ?kind,
                    session_id = snapshot.session_id,
                    thread_id = snapshot.thread_id,
                    pid = snapshot.pid,
                    "archcar restored persisted workspace session"
                );
                return Some(ArchcarResponse::SessionSpawned {
                    session_id: snapshot.session_id,
                    thread_id: snapshot.thread_id,
                    workspace: snapshot.workspace,
                    kind: snapshot.kind,
                    pid: snapshot.pid,
                });
            }
            Ok(None) => {}
            Err(err) => {
                warn!(
                    workspace,
                    ?kind,
                    session_id = record.id,
                    error = %format!("{err:#}"),
                    "archcar failed to restore persisted session candidate"
                );
            }
        }
    }

    None
}

fn restore_thread_session_from_store(
    state: &Arc<Mutex<ServerState>>,
    workspace: &str,
    thread_id: i64,
    kind: SessionKind,
) -> Option<ArchcarResponse> {
    let db_path = state.lock().ok()?.db_path.clone();
    let store = match WorkspaceStore::open_app(&db_path) {
        Ok(store) => store,
        Err(err) => {
            warn!(
                workspace,
                thread_id,
                ?kind,
                error = %format!("{err:#}"),
                "archcar failed to open workspace store for persisted thread restore"
            );
            return None;
        }
    };
    let records = match store.list_thread_processes(thread_id) {
        Ok(records) => records,
        Err(err) => {
            warn!(
                workspace,
                thread_id,
                ?kind,
                error = %format!("{err:#}"),
                "archcar failed to list persisted thread sessions for restore"
            );
            return None;
        }
    };

    for record in persisted_running_session_candidates(&records, kind) {
        match load_or_restore_session_handle(state, record.id) {
            Ok(Some(handle)) => {
                let snapshot = match handle.snapshot.lock() {
                    Ok(snapshot) => snapshot.clone(),
                    Err(_) => continue,
                };
                if snapshot.workspace != workspace
                    || snapshot.kind != kind
                    || snapshot.thread_id != thread_id
                    || snapshot.status != crate::workspace::ProcessStatus::Running
                {
                    continue;
                }

                let mut guard = match state.lock() {
                    Ok(guard) => guard,
                    Err(_) => return None,
                };
                if snapshot.ready {
                    broadcast(
                        &mut guard,
                        ArchcarEvent::SessionReady {
                            session_id: snapshot.session_id,
                            thread_id: snapshot.thread_id,
                        },
                    );
                }
                drop(guard);
                if snapshot.ready {
                    drain_queued_input_for_thread(state, snapshot.thread_id);
                }
                info!(
                    workspace,
                    thread_id,
                    ?kind,
                    session_id = snapshot.session_id,
                    pid = snapshot.pid,
                    "archcar restored persisted chat-thread session"
                );
                return Some(ArchcarResponse::SessionSpawned {
                    session_id: snapshot.session_id,
                    thread_id: snapshot.thread_id,
                    workspace: snapshot.workspace,
                    kind: snapshot.kind,
                    pid: snapshot.pid,
                });
            }
            Ok(None) => {}
            Err(err) => {
                warn!(
                    workspace,
                    thread_id,
                    ?kind,
                    session_id = record.id,
                    error = %format!("{err:#}"),
                    "archcar failed to restore persisted thread session candidate"
                );
            }
        }
    }
    None
}

fn validate_chat_thread_workspace(
    db_path: &std::path::Path,
    workspace: &str,
    thread_id: i64,
    kind: SessionKind,
) -> Result<()> {
    let store = WorkspaceStore::open_app(db_path)?;
    let workspace_record = store.get_workspace_record_by_name(workspace)?;
    let thread_record = store.get_chat_thread_record(thread_id)?;
    anyhow::ensure!(
        thread_record.workspace_id == workspace_record.id,
        "chat thread {thread_id} does not belong to workspace {workspace}"
    );
    anyhow::ensure!(
        thread_record.provider == crate::archcar::harness::provider_name(kind),
        "chat thread {thread_id} is not a {:?} thread",
        kind
    );
    Ok(())
}

fn persisted_running_session_candidates(
    records: &[crate::workspace::ProcessRecord],
    kind: SessionKind,
) -> Vec<crate::workspace::ProcessRecord> {
    records
        .iter()
        .filter(|record| {
            record.status == crate::workspace::ProcessStatus::Running
                && record.chat_thread_id.is_some()
                && session_kind_matches_command(&record.command, kind)
        })
        .cloned()
        .collect()
}

fn is_archcar_managed_persisted_session(
    record: &crate::workspace::ProcessRecord,
    state_logs_dir: &Path,
) -> bool {
    record.log_path.starts_with(state_logs_dir)
}

fn session_kind_matches_command(command: &str, kind: SessionKind) -> bool {
    let trimmed = command.trim();
    match kind {
        SessionKind::Codex => trimmed == "codex" || trimmed.starts_with("codex "),
        SessionKind::Claude => trimmed == "claude" || trimmed.starts_with("claude "),
        SessionKind::Shell => {
            !(trimmed == "codex"
                || trimmed.starts_with("codex ")
                || trimmed == "claude"
                || trimmed.starts_with("claude "))
        }
    }
}

fn spawn_session(
    state: &Arc<Mutex<ServerState>>,
    workspace: String,
    kind: SessionKind,
    harness: crate::workspace::SessionHarnessOptions,
) -> ArchcarResponse {
    let mut guard = state.lock().unwrap();
    let db_path = guard.db_path.clone();
    let logs_dir = guard.logs_dir.clone();
    let state_for_spawn = state.clone();
    broadcast(
        &mut guard,
        ArchcarEvent::SessionSpawnQueued {
            workspace: workspace.clone(),
            kind,
        },
    );
    info!(%workspace, ?kind, "archcar queued explicit session spawn");
    drop(guard);

    let workspace_for_spawn = workspace.clone();
    std::thread::spawn(move || {
        let (event_tx, event_rx) = mpsc::channel();
        match spawn_managed_session(
            db_path,
            logs_dir,
            workspace_for_spawn.clone(),
            kind,
            harness,
            event_tx,
        ) {
            Ok(handle) => {
                let session_id = handle.snapshot.lock().unwrap().session_id;
                info!(%workspace_for_spawn, session_id, ?kind, "archcar spawned explicit managed session");
                let mut guard = state_for_spawn.lock().unwrap();
                if guard.shutting_down {
                    drop(guard);
                    terminate_managed_handle(&handle);
                    return;
                }
                guard.sessions.insert(session_id, handle);
                drop(guard);
                while let Ok(event) = event_rx.recv() {
                    handle_session_event(&state_for_spawn, event);
                }
            }
            Err(err) => {
                let detail = format!("{err:#}");
                error!(%workspace_for_spawn, ?kind, error = %detail, "archcar failed to spawn explicit managed session");
                let mut guard = state_for_spawn.lock().unwrap();
                broadcast(
                    &mut guard,
                    ArchcarEvent::SessionError {
                        session_id: None,
                        thread_id: None,
                        message: detail,
                    },
                );
            }
        }
    });

    ArchcarResponse::SessionSpawnQueued { workspace, kind }
}

fn load_or_restore_session_handle(
    state: &Arc<Mutex<ServerState>>,
    session_id: i64,
) -> Result<Option<SessionHandle>> {
    if let Some(handle) = state.lock().unwrap().sessions.get(&session_id).cloned() {
        return Ok(Some(handle));
    }

    let (db_path, logs_dir) = {
        let guard = state.lock().unwrap();
        (guard.db_path.clone(), guard.logs_dir.clone())
    };
    let (event_tx, event_rx) = mpsc::channel();
    let Some(handle) = restore_managed_session(db_path, logs_dir, session_id, event_tx)? else {
        warn!(
            session_id,
            "archcar could not restore unknown session from persistent state"
        );
        return Ok(None);
    };

    let inserted = {
        let mut guard = state.lock().unwrap();
        if let Some(existing) = guard.sessions.get(&session_id).cloned() {
            return Ok(Some(existing));
        }
        if guard.shutting_down {
            terminate_managed_handle(&handle);
            return Ok(None);
        }
        guard.sessions.insert(session_id, handle.clone());
        info!(session_id, "archcar restored session into active state");
        true
    };

    if inserted {
        let state_for_events = Arc::clone(state);
        std::thread::spawn(move || {
            while let Ok(event) = event_rx.recv() {
                handle_session_event(&state_for_events, event);
            }
        });
    }

    Ok(Some(handle))
}

fn broadcast(state: &mut ServerState, event: ArchcarEvent) {
    state
        .subscribers
        .retain(|subscriber| subscriber.send(event.clone()).is_ok());
}

fn register_subscriber_with_snapshot(state: &mut ServerState, subscriber: Sender<ArchcarEvent>) {
    let mut snapshots = state
        .sessions
        .values()
        .filter_map(|handle| handle.snapshot.lock().ok().map(|snapshot| snapshot.clone()))
        .filter(|snapshot| snapshot.status == crate::workspace::ProcessStatus::Running)
        .collect::<Vec<_>>();
    snapshots.sort_by_key(|snapshot| snapshot.session_id);

    state.subscribers.push(subscriber.clone());
    for snapshot in snapshots {
        let _ = subscriber.send(ArchcarEvent::SessionStarted {
            session_id: snapshot.session_id,
            thread_id: snapshot.thread_id,
            workspace: snapshot.workspace,
            kind: snapshot.kind,
            pid: snapshot.pid,
        });
        if snapshot.ready {
            let _ = subscriber.send(ArchcarEvent::SessionReady {
                session_id: snapshot.session_id,
                thread_id: snapshot.thread_id,
            });
        }
        if let Some(capabilities) = snapshot.capabilities {
            let _ = subscriber.send(ArchcarEvent::SessionCapabilitiesChanged {
                session_id: snapshot.session_id,
                thread_id: snapshot.thread_id,
                capabilities,
            });
        }
    }
}

fn shutdown_managed_sessions(state: &Arc<Mutex<ServerState>>, reason: &str) -> Result<()> {
    let (db_path, handles) = {
        let guard = state.lock().unwrap();
        (
            guard.db_path.clone(),
            guard.sessions.values().cloned().collect::<Vec<_>>(),
        )
    };
    let provider_events = ProviderEventStore::new(&db_path);
    let mut errors = Vec::new();

    for handle in handles {
        let snapshot = match handle.snapshot.lock() {
            Ok(snapshot) => snapshot.clone(),
            Err(err) => {
                errors.push(format!("read session snapshot: {err}"));
                continue;
            }
        };
        if snapshot.status != crate::workspace::ProcessStatus::Running {
            continue;
        }
        if let Err(err) =
            provider_events.interrupt_active_turns_for_process(snapshot.session_id, reason)
        {
            errors.push(format!(
                "interrupt active turns for session {}: {err:#}",
                snapshot.session_id
            ));
        }
        let _ = handle
            .command_tx
            .send(crate::archcar::session::SessionCommand::Kill);
        if crate::platform::process_alive(snapshot.pid) {
            crate::archcar::session::terminate_process(snapshot.pid);
        }
        if !wait_for_process_exit(snapshot.pid, Duration::from_secs(2)) {
            errors.push(format!(
                "session {} process {} did not exit during shutdown",
                snapshot.session_id, snapshot.pid
            ));
        }
        if let Ok(store) = WorkspaceStore::open(&db_path) {
            if let Err(err) = store.mark_session_process_stopped(snapshot.session_id, None) {
                errors.push(format!(
                    "mark session {} stopped during shutdown: {err:#}",
                    snapshot.session_id
                ));
            }
        }
        if let Ok(mut current) = handle.snapshot.lock() {
            current.status = crate::workspace::ProcessStatus::Stopped;
            current.ready = false;
            current.runtime_state = crate::session_state::AgentSessionState::Interrupted;
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(anyhow!(errors.join("; ")))
    }
}

fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if !crate::platform::process_alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    !crate::platform::process_alive(pid)
}

fn terminate_managed_handle(handle: &SessionHandle) {
    let snapshot = match handle.snapshot.lock() {
        Ok(snapshot) => snapshot.clone(),
        Err(_) => return,
    };
    let _ = handle
        .command_tx
        .send(crate::archcar::session::SessionCommand::Kill);
    crate::archcar::session::terminate_process(snapshot.pid);
    if let Ok(mut current) = handle.snapshot.lock() {
        current.status = crate::workspace::ProcessStatus::Stopped;
        current.ready = false;
        current.runtime_state = crate::session_state::AgentSessionState::Interrupted;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::archcar::harness_contract::{
        ProviderInteractionDraft, ProviderInteractionKind, ProviderInteractionResolution,
    };
    use crate::archcar::protocol::{ArchcarInputDelivery, ArchcarInputKind};
    use crate::provider_events::{ProviderEventDraft, ProviderEventKind, ProviderEventPhase};
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    #[cfg(unix)]
    use std::time::{Duration, Instant};

    use crate::paths::AppPaths;
    use crate::repository::{AddRepository, RepositoryStore};
    use crate::workspace::{CreateWorkspace, ProcessStatus};
    use serde_json::json;

    #[test]
    fn clone_command_prefers_gh_for_github_remotes() {
        for url in [
            "git@github.com:perceo-ai/conductor-arch.git",
            "https://github.com/perceo-ai/conductor-arch.git",
            "ssh://git@github.com/perceo-ai/conductor-arch.git",
        ] {
            let command = clone_command_for_url(url, "/tmp/conductor-arch");
            assert_eq!(command.program, "gh");
            assert_eq!(
                command.args,
                vec![
                    "repo".to_owned(),
                    "clone".to_owned(),
                    url.to_owned(),
                    "/tmp/conductor-arch".to_owned()
                ]
            );
            assert_eq!(command.failure_context, "run gh repo clone");
        }
    }

    #[test]
    fn clone_command_keeps_git_for_non_github_remotes() {
        let command = clone_command_for_url("ssh://git@example.test/team/repo.git", "/tmp/repo");

        assert_eq!(command.program, "git");
        assert_eq!(
            command.args,
            vec![
                "clone".to_owned(),
                "ssh://git@example.test/team/repo.git".to_owned(),
                "/tmp/repo".to_owned()
            ]
        );
        assert_eq!(command.failure_context, "run git clone");
    }

    #[test]
    fn provider_interaction_dispatch_registers_lists_and_resolves() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        crate::storage::migrate_workspace_db(&rusqlite::Connection::open(&db_path).unwrap())
            .unwrap();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));

        let response = dispatch_request(
            ArchcarRequest::RegisterProviderInteraction {
                interaction: ProviderInteractionDraft {
                    provider_key: "claude".to_owned(),
                    workspace: "berlin".to_owned(),
                    thread_id: 7,
                    session_id: 11,
                    native_session_id: None,
                    native_id: "tool-1".to_owned(),
                    kind: ProviderInteractionKind::Permission,
                    title: "Permission".to_owned(),
                    detail: "Allow?".to_owned(),
                    questions: Vec::new(),
                    auto_resolution_ms: None,
                    native_request: json!({"tool": "bash"}),
                },
            },
            &state,
        );
        let ArchcarResponse::ProviderInteraction { interaction } = response else {
            panic!("expected provider interaction response");
        };

        let listed = dispatch_request(
            ArchcarRequest::ListProviderInteractions {
                thread_id: Some(7),
                pending_only: true,
            },
            &state,
        );
        assert!(matches!(
            listed,
            ArchcarResponse::ProviderInteractions { ref interactions } if interactions.len() == 1
        ));

        let resolved = dispatch_request(
            ArchcarRequest::ResolveProviderInteraction {
                interaction_id: interaction.id,
                resolution: ProviderInteractionResolution::Approve,
            },
            &state,
        );
        assert!(matches!(
            resolved,
            ArchcarResponse::ProviderInteraction { interaction } if interaction.status == crate::provider_interactions::ProviderInteractionStatus::Allowed
        ));
    }

    #[test]
    fn queue_chat_input_dispatch_persists_and_lists_archcar_queue() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        RepositoryStore::open(&db_path)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(temp.path().join("workspaces/demo")),
            })
            .unwrap();
        let store = WorkspaceStore::open_with_logs(&db_path, temp.path().join("logs")).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        let thread = store
            .create_chat_thread("berlin", "codex", "New Chat", None)
            .unwrap();
        let (subscriber_tx, subscriber_rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: vec![subscriber_tx],
        }));

        let response = dispatch_request(
            ArchcarRequest::QueueChatInput {
                thread_id: thread.id,
                input: "run tests".to_owned(),
                visible_input: None,
                kind: ArchcarInputKind::User,
                session_kind: SessionKind::Codex,
            },
            &state,
        );
        let ArchcarResponse::QueuedChatInput { input } = response else {
            panic!("expected queued chat input response");
        };
        assert_eq!(input.thread_id, thread.id);
        // First human message of the chat: the provider-bound text carries the
        // hidden naming request, the transcript keeps what the user typed.
        assert!(input.input.starts_with("run tests"));
        assert!(input.input.contains("<archductor_hidden_instruction>"));
        assert_eq!(input.visible_input.as_deref(), Some("run tests"));
        assert!(matches!(
            subscriber_rx.try_recv(),
            Ok(ArchcarEvent::ChatQueueUpdated { thread_id }) if thread_id == thread.id
        ));

        let listed = dispatch_request(
            ArchcarRequest::ListQueuedChatInputs {
                thread_id: thread.id,
            },
            &state,
        );
        let ArchcarResponse::QueuedChatInputs { inputs, .. } = listed else {
            panic!("expected queued chat inputs response");
        };
        assert_eq!(inputs.len(), 1);
        assert_eq!(inputs[0].id, input.id);

        // A second send stacked behind the first must not ask for names again.
        let second = dispatch_request(
            ArchcarRequest::QueueChatInput {
                thread_id: thread.id,
                input: "and lint".to_owned(),
                visible_input: None,
                kind: ArchcarInputKind::User,
                session_kind: SessionKind::Codex,
            },
            &state,
        );
        let ArchcarResponse::QueuedChatInput { input: second } = second else {
            panic!("expected queued chat input response");
        };
        assert_eq!(second.input, "and lint");
        assert!(!second.input.contains("<archductor_hidden_instruction>"));
    }

    #[test]
    fn a_rename_between_snapshots_is_broadcast_to_clients() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        RepositoryStore::open(&db_path)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(temp.path().join("workspaces/demo")),
            })
            .unwrap();
        let store = WorkspaceStore::open_with_logs(&db_path, temp.path().join("logs")).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        let thread = store
            .create_chat_thread("berlin", "codex", "New chat", None)
            .unwrap();
        let (subscriber_tx, subscriber_rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: vec![subscriber_tx],
        }));

        // Agent metadata is applied while a thread renders, so a read can rename
        // the workspace and retitle the chat. Clients hold names, not ids.
        let before = thread_naming_snapshot(&db_path, thread.id);
        store.rename("berlin", "billing-webhook-fix").unwrap();
        store
            .update_chat_thread_title(thread.id, "Billing Webhook Fix")
            .unwrap();
        broadcast_naming_changes(&state, &db_path, thread.id, before);

        let events = subscriber_rx.try_iter().collect::<Vec<_>>();
        assert!(
            events.iter().any(|event| matches!(
                event,
                ArchcarEvent::WorkspaceRenamed { old_name, new_name }
                    if old_name == "berlin" && new_name == "billing-webhook-fix"
            )),
            "{events:?}"
        );
        assert!(
            events.iter().any(|event| matches!(
                event,
                ArchcarEvent::ChatThreadRenamed { thread_id, title }
                    if *thread_id == thread.id && title == "Billing Webhook Fix"
            )),
            "{events:?}"
        );

        // Nothing moved this time, so clients are left alone.
        let before = thread_naming_snapshot(&db_path, thread.id);
        broadcast_naming_changes(&state, &db_path, thread.id, before);
        assert!(subscriber_rx.try_iter().next().is_none());
    }

    #[test]
    fn chat_snapshot_dispatch_returns_persisted_messages_and_archcar_queue() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        RepositoryStore::open(&db_path)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(temp.path().join("workspaces/demo")),
            })
            .unwrap();
        let store = WorkspaceStore::open_with_logs(&db_path, temp.path().join("logs")).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        let thread = store
            .create_chat_thread("berlin", "codex", "New Chat", None)
            .unwrap();
        store
            .append_chat_message(thread.id, "user", "fix auth", "user_send")
            .unwrap();
        let process = store
            .record_session_process_for_thread(
                "berlin",
                thread.id,
                &store.session_launch("berlin", SessionKind::Codex).unwrap(),
                std::process::id(),
            )
            .unwrap();
        store
            .append_chat_event(
                thread.id,
                process.id,
                &crate::codex_tui::CodexTranscriptEvent::Tool {
                    title: "Cargo".to_owned(),
                    body: "cargo test".to_owned(),
                },
            )
            .unwrap();
        ProviderEventStore::new(&db_path)
            .upsert_event(&provider_event(
                thread.id,
                "assistant-1",
                ProviderEventKind::AssistantOutput,
                ProviderEventPhase::Completed,
                "assistant_message",
                "Assistant",
                "tests passed",
            ))
            .unwrap();
        store
            .enqueue_chat_input(
                thread.id,
                "run tests",
                Some("run visible tests"),
                ArchcarInputKind::User,
                SessionKind::Codex,
            )
            .unwrap();
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: process.id,
            thread_id: thread.id,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: process.pid,
            status: ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
            ready: true,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, _command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            snapshot.session_id,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));

        let response = dispatch_request(
            ArchcarRequest::GetChatSnapshot {
                thread_id: thread.id,
            },
            &state,
        );

        let ArchcarResponse::ChatSnapshot { snapshot } = response else {
            panic!("expected chat snapshot response");
        };
        assert_eq!(snapshot.thread_id, thread.id);
        assert_eq!(snapshot.messages.len(), 1);
        assert_eq!(snapshot.messages[0].content, "fix auth");
        assert_eq!(snapshot.events.len(), 1);
        assert_eq!(snapshot.events[0].thread_id, thread.id);
        assert_eq!(snapshot.events[0].process_id, Some(process.id));
        assert_eq!(snapshot.events[0].kind, "tool");
        assert_eq!(snapshot.events[0].body, "cargo test");
        assert_eq!(snapshot.provider_events.len(), 1);
        assert_eq!(snapshot.provider_events[0].chat_thread_id, Some(thread.id));
        assert_eq!(
            snapshot.provider_events[0].kind,
            ProviderEventKind::AssistantOutput
        );
        assert_eq!(snapshot.queued_inputs.len(), 1);
        assert_eq!(snapshot.queued_inputs[0].input, "run tests");
        assert_eq!(
            snapshot.queued_inputs[0].visible_input.as_deref(),
            Some("run visible tests")
        );
        let live_session = snapshot
            .live_session
            .expect("live session should be projected");
        assert_eq!(live_session.session_id, process.id);
        assert_eq!(
            live_session.runtime_state,
            crate::session_state::AgentSessionState::WaitingForInput
        );
        assert!(live_session.ready);
    }

    #[test]
    fn queued_raw_terminal_input_is_rejected_before_claim() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let store = seeded_workspace_store(&db_path, &temp.path().join("logs"), temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "New Chat", None)
            .unwrap();
        let queued = store
            .enqueue_chat_input(
                thread.id,
                "pwd\n",
                None,
                ArchcarInputKind::RawTerminal,
                SessionKind::Codex,
            )
            .unwrap();
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: thread.id,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
            status: ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
            ready: true,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            snapshot.session_id,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));

        drain_queued_input_for_thread(&state, thread.id);

        assert!(command_rx.try_recv().is_err());
        assert_eq!(
            store
                .peek_next_queued_chat_input(thread.id)
                .unwrap()
                .unwrap()
                .id,
            queued.id
        );
    }

    #[test]
    fn ready_session_event_drains_one_archcar_queued_input() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        RepositoryStore::open(&db_path)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(temp.path().join("workspaces/demo")),
            })
            .unwrap();
        let store = WorkspaceStore::open_with_logs(&db_path, temp.path().join("logs")).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        let thread = store
            .create_chat_thread("berlin", "codex", "New Chat", None)
            .unwrap();
        let first = store
            .enqueue_chat_input(
                thread.id,
                "run tests",
                Some("visible tests"),
                ArchcarInputKind::User,
                SessionKind::Codex,
            )
            .unwrap();
        let second = store
            .enqueue_chat_input(
                thread.id,
                "second",
                None,
                ArchcarInputKind::User,
                SessionKind::Codex,
            )
            .unwrap();
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: thread.id,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
            status: ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
            ready: true,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            snapshot.session_id,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let (subscriber_tx, subscriber_rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: vec![subscriber_tx],
        }));

        handle_session_event(
            &state,
            ArchcarEvent::SessionReady {
                session_id: 9,
                thread_id: thread.id,
            },
        );

        assert!(matches!(
            command_rx.try_recv(),
            Ok(crate::archcar::session::SessionCommand::SendInput {
                input,
                visible_input,
                delivery: ArchcarInputDelivery::Auto,
                ..
            }) if input == "run tests" && visible_input.as_deref() == Some("visible tests")
        ));
        assert_eq!(
            WorkspaceStore::open_with_logs(&db_path, temp.path().join("logs"))
                .unwrap()
                .list_queued_chat_inputs(thread.id)
                .unwrap()
                .into_iter()
                .map(|input| input.id)
                .collect::<Vec<_>>(),
            vec![second.id]
        );
        let events = subscriber_rx.try_iter().collect::<Vec<_>>();
        assert!(events.contains(&ArchcarEvent::SessionReady {
            session_id: 9,
            thread_id: thread.id,
        }));
        assert!(events.contains(&ArchcarEvent::ChatQueueUpdated {
            thread_id: thread.id,
        }));
        assert_ne!(first.id, second.id);
    }

    fn interaction_draft_for(
        thread_id: i64,
        session_id: i64,
        kind: ProviderInteractionKind,
        native_id: &str,
    ) -> crate::archcar::harness_contract::ProviderInteractionDraft {
        crate::archcar::harness_contract::ProviderInteractionDraft {
            provider_key: "claude".to_owned(),
            workspace: "berlin".to_owned(),
            thread_id,
            session_id,
            native_session_id: None,
            native_id: native_id.to_owned(),
            kind,
            title: "Plan ready for review".to_owned(),
            detail: "# Plan\n\n- do the thing".to_owned(),
            questions: Vec::new(),
            auto_resolution_ms: None,
            native_request: serde_json::json!({}),
        }
    }

    #[test]
    fn resolving_an_interaction_answers_the_session_that_asked() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let logs_dir = temp.path().join("logs");
        let store = seeded_workspace_store(&db_path, &logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "claude", "New Chat", None)
            .unwrap();
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: thread.id,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Claude,
            pid: 12345,
            status: ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
            ready: false,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            9,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));
        let interaction = ProviderInteractionStore::new(db_path.clone())
            .register(interaction_draft_for(
                thread.id,
                9,
                ProviderInteractionKind::UserQuestion,
                "req-1",
            ))
            .unwrap();

        dispatch_request(
            ArchcarRequest::ResolveProviderInteraction {
                interaction_id: interaction.id.clone(),
                resolution: InteractionResolution::Deny {
                    reason: Some("not that one".to_owned()),
                },
            },
            &state,
        );

        // Storing the answer is not answering: the provider holds its turn open
        // until the reply reaches the session that asked.
        assert!(matches!(
            command_rx.try_recv(),
            Ok(SessionCommand::ApplyControl(
                crate::archcar::harness_contract::HarnessControl::ResolveInteraction {
                    native_id,
                    ..
                }
            )) if native_id == "req-1"
        ));
    }

    #[test]
    fn approving_a_plan_leaves_plan_mode_and_queues_the_build() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let logs_dir = temp.path().join("logs");
        let store = seeded_workspace_store(&db_path, &logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "claude", "New Chat", None)
            .unwrap();
        store.set_chat_thread_plan_mode(thread.id, true).unwrap();
        let (command_tx, _command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            9,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(crate::archcar::session::SessionSnapshot {
                    session_id: 9,
                    thread_id: thread.id,
                    workspace: "berlin".to_owned(),
                    kind: SessionKind::Claude,
                    pid: 12345,
                    status: ProcessStatus::Running,
                    runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
                    ready: false,
                    capabilities: None,
                    screen: String::new(),
                })),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));
        let interactions = ProviderInteractionStore::new(db_path.clone());
        let interaction = interactions
            .register(interaction_draft_for(
                thread.id,
                9,
                ProviderInteractionKind::PlanApproval,
                "req-plan",
            ))
            .unwrap();
        let interaction = interactions
            .attach_plan_path(&interaction.id, ".context/plans/thread-1-abc.md")
            .unwrap();

        dispatch_request(
            ArchcarRequest::ResolveProviderInteraction {
                interaction_id: interaction.id.clone(),
                resolution: InteractionResolution::Approve,
            },
            &state,
        );

        assert!(!store.chat_thread_plan_mode(thread.id).unwrap());
        let queued = store.list_queued_chat_inputs(thread.id).unwrap();
        assert_eq!(queued.len(), 1, "approving a plan starts the build");
        assert!(
            queued[0].input.contains(".context/plans/thread-1-abc.md"),
            "the build step points at the saved plan, not a re-pasted copy: {}",
            queued[0].input
        );
    }

    #[test]
    fn a_dead_session_expires_the_asks_it_was_holding() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let logs_dir = temp.path().join("logs");
        let store = seeded_workspace_store(&db_path, &logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "claude", "New Chat", None)
            .unwrap();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));
        let interactions = ProviderInteractionStore::new(db_path.clone());
        interactions
            .register(interaction_draft_for(
                thread.id,
                9,
                ProviderInteractionKind::UserQuestion,
                "req-1",
            ))
            .unwrap();

        expire_pending_interactions_for_session(&state, 9);

        // The request id died with the process; leaving it pending would show a
        // question that can never be answered.
        assert!(interactions.list(Some(thread.id), true).unwrap().is_empty());
    }

    #[test]
    fn startup_sweep_delivers_inputs_queued_before_the_daemon_started() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let logs_dir = temp.path().join("logs");
        let store = seeded_workspace_store(&db_path, &logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "New Chat", None)
            .unwrap();
        // Queued while the previous daemon was alive; nothing will emit a
        // session event for it after the restart.
        store
            .enqueue_chat_input(
                thread.id,
                "left over from before the restart",
                None,
                ArchcarInputKind::User,
                SessionKind::Codex,
            )
            .unwrap();
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: thread.id,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
            status: ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
            ready: true,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            9,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));

        drain_every_queued_chat_thread(&state);

        assert!(matches!(
            command_rx.try_recv(),
            Ok(crate::archcar::session::SessionCommand::SendInput { input, .. })
                if input == "left over from before the restart"
        ));
        assert!(store.list_queued_chat_inputs(thread.id).unwrap().is_empty());
    }

    #[test]
    fn a_second_queued_input_waits_for_the_first_turn_instead_of_joining_it() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let logs_dir = temp.path().join("logs");
        let store = seeded_workspace_store(&db_path, &logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "claude", "New Chat", None)
            .unwrap();
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: thread.id,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Claude,
            pid: 12345,
            status: ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
            ready: true,
            capabilities: None,
            screen: String::new(),
        };
        let handle_snapshot = Arc::new(Mutex::new(snapshot));
        let (command_tx, command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            9,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::clone(&handle_snapshot),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));

        // Two sends back to back, the way a user types a follow-up right after
        // the first message: the provider has not started the turn yet, so the
        // session still looks ready when the second one arrives.
        for input in ["first", "second"] {
            dispatch_request(
                ArchcarRequest::QueueChatInput {
                    thread_id: thread.id,
                    input: input.to_owned(),
                    visible_input: None,
                    kind: ArchcarInputKind::User,
                    session_kind: SessionKind::Claude,
                },
                &state,
            );
        }

        let sent = command_rx.try_iter().collect::<Vec<_>>();
        assert_eq!(sent.len(), 1, "only the first input may reach the session");
        assert!(!handle_snapshot.lock().unwrap().ready);
        assert_eq!(
            store
                .list_queued_chat_inputs(thread.id)
                .unwrap()
                .into_iter()
                .map(|queued| queued.input)
                .collect::<Vec<_>>(),
            vec!["second".to_owned()]
        );
    }

    #[test]
    fn queued_input_without_any_session_requests_a_thread_session_start() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let logs_dir = temp.path().join("logs");
        let store = seeded_workspace_store(&db_path, &logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "New Chat", None)
            .unwrap();
        store
            .enqueue_chat_input(
                thread.id,
                "first message",
                None,
                ArchcarInputKind::User,
                SessionKind::Codex,
            )
            .unwrap();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));

        // A brand-new chat thread has no session, so nothing would ever deliver
        // the first message unless the queue starts one.
        assert_eq!(
            workspace_needing_session_for_queue(&state, &store, thread.id, SessionKind::Codex),
            Some("berlin".to_owned())
        );
    }

    #[test]
    fn queued_input_with_a_busy_session_does_not_request_another_session() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let logs_dir = temp.path().join("logs");
        let store = seeded_workspace_store(&db_path, &logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "New Chat", None)
            .unwrap();
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: thread.id,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
            status: ProcessStatus::Running,
            // Mid-turn: not ready, but TurnCompleted will drain the queue.
            runtime_state: crate::session_state::AgentSessionState::Running,
            ready: false,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, _command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            snapshot.session_id,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));

        assert_eq!(
            workspace_needing_session_for_queue(&state, &store, thread.id, SessionKind::Codex),
            None
        );
    }

    #[test]
    fn drain_requested_during_a_drain_reruns_instead_of_being_dropped() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let logs_dir = temp.path().join("logs");
        let store = seeded_workspace_store(&db_path, &logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "New Chat", None)
            .unwrap();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));

        let guard = QueueDrainGuard::begin(&state, thread.id).expect("first drain runs");
        assert!(
            QueueDrainGuard::begin(&state, thread.id).is_none(),
            "a second concurrent drain must not run"
        );
        assert!(
            state.lock().unwrap().drain_reruns.contains(&thread.id),
            "the skipped drain must be recorded so the running drain repeats"
        );
        drop(guard);

        // The rerun flag is cleared when the next drain actually starts.
        let guard = QueueDrainGuard::begin(&state, thread.id).expect("drain runs again");
        assert!(!state.lock().unwrap().drain_reruns.contains(&thread.id));
        drop(guard);
    }

    #[test]
    fn ensure_existing_ready_thread_session_drains_one_archcar_queued_input() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        RepositoryStore::open(&db_path)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(temp.path().join("workspaces/demo")),
            })
            .unwrap();
        let store = WorkspaceStore::open_with_logs(&db_path, temp.path().join("logs")).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        let thread = store
            .create_chat_thread("berlin", "codex", "New Chat", None)
            .unwrap();
        let queued = store
            .enqueue_chat_input(
                thread.id,
                "run tests",
                None,
                ArchcarInputKind::User,
                SessionKind::Codex,
            )
            .unwrap();
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: thread.id,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
            status: ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
            ready: true,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            snapshot.session_id,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));

        let response = dispatch_request(
            ArchcarRequest::EnsureChatThreadSession {
                workspace: "berlin".to_owned(),
                thread_id: thread.id,
                kind: SessionKind::Codex,
                harness: None,
            },
            &state,
        );

        assert!(matches!(
            response,
            ArchcarResponse::SessionSpawned {
                session_id: 9,
                thread_id,
                ..
            } if thread_id == thread.id
        ));
        assert!(matches!(
            command_rx.try_recv(),
            Ok(crate::archcar::session::SessionCommand::SendInput {
                input,
                delivery: ArchcarInputDelivery::Auto,
                ..
            }) if input == "run tests"
        ));
        assert!(
            WorkspaceStore::open_with_logs(&db_path, temp.path().join("logs"))
                .unwrap()
                .list_queued_chat_inputs(thread.id)
                .unwrap()
                .is_empty()
        );
        assert_eq!(queued.input, "run tests");
    }

    #[test]
    fn ensure_default_session_debounces_repeat_requests() {
        let state = Arc::new(Mutex::new(ServerState {
            db_path: PathBuf::from("/tmp/does-not-matter.db"),
            logs_dir: PathBuf::from("/tmp/does-not-matter-logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));
        let first = ensure_default_session(
            &state,
            "berlin".to_owned(),
            SessionKind::Codex,
            crate::workspace::SessionHarnessOptions::default(),
        );
        let second = ensure_default_session(
            &state,
            "berlin".to_owned(),
            SessionKind::Codex,
            crate::workspace::SessionHarnessOptions::default(),
        );
        assert_eq!(
            first,
            ArchcarResponse::SessionSpawnQueued {
                workspace: "berlin".to_owned(),
                kind: SessionKind::Codex,
            }
        );
        assert_eq!(
            second,
            ArchcarResponse::SessionSpawnQueued {
                workspace: "berlin".to_owned(),
                kind: SessionKind::Codex,
            }
        );
    }

    #[test]
    fn ensure_default_session_queue_is_scoped_by_workspace_and_kind() {
        let (event_tx, event_rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: PathBuf::from("/tmp/does-not-matter.db"),
            logs_dir: PathBuf::from("/tmp/does-not-matter-logs"),
            shutting_down: false,
            queued_defaults: HashSet::from([default_queue_key("berlin", SessionKind::Codex)]),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: vec![event_tx],
        }));

        let claude = ensure_default_session(
            &state,
            "berlin".to_owned(),
            SessionKind::Claude,
            crate::workspace::SessionHarnessOptions::default(),
        );

        assert!(matches!(
            claude,
            ArchcarResponse::SessionSpawnQueued {
                kind: SessionKind::Claude,
                ..
            }
        ));
        assert!(matches!(
            event_rx.try_recv(),
            Ok(ArchcarEvent::SessionSpawnQueued {
                kind: SessionKind::Claude,
                ..
            })
        ));
    }

    #[test]
    fn explicit_spawn_session_accepts_shell_runtime_requests() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let logs_dir = temp.path().join("logs");
        let state = Arc::new(Mutex::new(ServerState {
            db_path,
            logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));

        let response = spawn_session(
            &state,
            "missing-workspace".to_owned(),
            SessionKind::Shell,
            crate::workspace::SessionHarnessOptions::default(),
        );

        assert_ne!(
            response,
            ArchcarResponse::Error {
                message: "only codex auto-spawn is implemented".to_owned(),
            }
        );
    }

    #[test]
    fn archcar_rpc_log_payload_is_omitted_by_default_for_send_input() {
        let envelope = RpcEnvelope {
            id: "abc".to_owned(),
            payload: ArchcarRequest::SendInput {
                session_id: 42,
                input: "paste OPENAI_API_KEY=sk-secret into session".to_owned(),
                visible_input: None,
                kind: ArchcarInputKind::User,
                delivery: ArchcarInputDelivery::Auto,
            },
        };
        let line = serde_json::to_string(&envelope).unwrap();

        assert_eq!(archcar_rpc_log_payload(&line), None);
        assert_eq!(
            archcar_request_summary(&envelope.payload),
            "send_input session_id=42 kind=user delivery=auto chars=43"
        );
    }

    #[test]
    fn archcar_rpc_log_payload_redacts_sensitive_values_when_payload_logging_is_enabled() {
        let envelope = RpcEnvelope {
            id: "abc".to_owned(),
            payload: ArchcarRequest::SendInput {
                session_id: 42,
                input: "paste OPENAI_API_KEY=sk-secret bearer ghp_secret --password swordfish"
                    .to_owned(),
                visible_input: None,
                kind: ArchcarInputKind::User,
                delivery: ArchcarInputDelivery::Auto,
            },
        };
        let line = serde_json::to_string(&envelope).unwrap();

        let payload = archcar_rpc_log_payload_for_flag(&line, true).unwrap();

        assert!(payload.contains("[redacted]"));
        assert!(!payload.contains("sk-secret"));
        assert!(!payload.contains("ghp_secret"));
        assert!(!payload.contains("swordfish"));
    }

    #[test]
    fn session_messages_project_provider_events_into_semantic_messages() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let store = seeded_workspace_store(&db_path, &temp.path().join("logs"), temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        store
            .append_chat_message(thread.id, "user", "Run tests", "cli")
            .unwrap();
        let provider_store = ProviderEventStore::new(&db_path);
        provider_store
            .upsert_event(&provider_event(
                thread.id,
                "assistant-1",
                ProviderEventKind::AssistantOutput,
                ProviderEventPhase::Completed,
                "agent_message",
                "Assistant",
                "Tests passed",
            ))
            .unwrap();
        provider_store
            .upsert_event(&provider_event(
                thread.id,
                "reasoning-1",
                ProviderEventKind::PlanningReasoning,
                ProviderEventPhase::Progress,
                "reasoning_summary",
                "Reasoning",
                "Checking failure output",
            ))
            .unwrap();
        provider_store
            .upsert_event(&provider_event(
                thread.id,
                "turn-1",
                ProviderEventKind::Turn,
                ProviderEventPhase::Started,
                "turn_started",
                "Turn started",
                "raw lifecycle",
            ))
            .unwrap();

        let messages = session_messages_for_thread(&db_path, thread.id).unwrap();

        assert_eq!(
            messages
                .iter()
                .map(|message| (message.role.as_str(), message.content.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("user", "Run tests"),
                ("assistant", "Tests passed"),
                ("reasoning", "Reasoning\nChecking failure output"),
            ]
        );
    }

    #[test]
    fn session_messages_preserve_assistant_edge_whitespace() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let store = seeded_workspace_store(&db_path, &temp.path().join("logs"), temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        ProviderEventStore::new(&db_path)
            .upsert_event(&provider_event(
                thread.id,
                "assistant-whitespace",
                ProviderEventKind::AssistantOutput,
                ProviderEventPhase::Completed,
                "agent_message",
                "Assistant",
                "  indented reply\n",
            ))
            .unwrap();

        let messages = session_messages_for_thread(&db_path, thread.id).unwrap();

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].role, "assistant");
        assert_eq!(messages[0].content, "  indented reply\n");
    }

    #[test]
    fn session_messages_hide_mcp_startup_status_provider_events() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let store = seeded_workspace_store(&db_path, &temp.path().join("logs"), temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        let provider_store = ProviderEventStore::new(&db_path);
        provider_store
            .upsert_event(&provider_event(
                thread.id,
                "mcp-startup-status",
                ProviderEventKind::Mcp,
                ProviderEventPhase::Progress,
                "mcpServer/startupStatus/updated",
                "MCP loading",
                "",
            ))
            .unwrap();
        provider_store
            .upsert_event(&provider_event(
                thread.id,
                "mcp-startup-status",
                ProviderEventKind::Mcp,
                ProviderEventPhase::Completed,
                "mcpServer/startupStatus/updated",
                "MCP loaded",
                "github: ready",
            ))
            .unwrap();

        let messages = session_messages_for_thread(&db_path, thread.id).unwrap();

        assert!(messages.is_empty());
    }

    #[test]
    fn ensure_default_session_reuses_existing_running_session() {
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: 4,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
            status: crate::workspace::ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
            ready: true,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, _command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            snapshot.session_id,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: PathBuf::from("/tmp/does-not-matter.db"),
            logs_dir: PathBuf::from("/tmp/does-not-matter-logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));

        let response = ensure_default_session(
            &state,
            "berlin".to_owned(),
            SessionKind::Codex,
            crate::workspace::SessionHarnessOptions::default(),
        );

        assert_eq!(
            response,
            ArchcarResponse::SessionSpawned {
                session_id: 9,
                thread_id: 4,
                workspace: "berlin".to_owned(),
                kind: SessionKind::Codex,
                pid: 12345,
            }
        );
        assert!(state.lock().unwrap().queued_defaults.is_empty());
    }

    #[test]
    fn subscriber_snapshot_replays_started_and_ready_sessions() {
        let ready_snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: 4,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
            status: ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
            ready: true,
            capabilities: None,
            screen: String::new(),
        };
        let starting_snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 10,
            thread_id: 5,
            workspace: "paris".to_owned(),
            kind: SessionKind::Codex,
            pid: 12346,
            status: ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::Starting,
            ready: false,
            capabilities: None,
            screen: String::new(),
        };
        let (ready_tx, _ready_rx) = mpsc::channel();
        let (starting_tx, _starting_rx) = mpsc::channel();
        let mut state = ServerState {
            db_path: PathBuf::from("/tmp/does-not-matter.db"),
            logs_dir: PathBuf::from("/tmp/does-not-matter-logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::from([
                (
                    9,
                    crate::archcar::session::SessionHandle {
                        snapshot: Arc::new(Mutex::new(ready_snapshot)),
                        command_tx: ready_tx,
                    },
                ),
                (
                    10,
                    crate::archcar::session::SessionHandle {
                        snapshot: Arc::new(Mutex::new(starting_snapshot)),
                        command_tx: starting_tx,
                    },
                ),
            ]),
            subscribers: Vec::new(),
        };
        let (subscriber_tx, subscriber_rx) = mpsc::channel();

        register_subscriber_with_snapshot(&mut state, subscriber_tx);

        let events = subscriber_rx.try_iter().collect::<Vec<_>>();
        assert!(events.contains(&ArchcarEvent::SessionStarted {
            session_id: 9,
            thread_id: 4,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
        }));
        assert!(events.contains(&ArchcarEvent::SessionReady {
            session_id: 9,
            thread_id: 4,
        }));
        assert!(events.contains(&ArchcarEvent::SessionStarted {
            session_id: 10,
            thread_id: 5,
            workspace: "paris".to_owned(),
            kind: SessionKind::Codex,
            pid: 12346,
        }));
        assert!(!events.contains(&ArchcarEvent::SessionReady {
            session_id: 10,
            thread_id: 5,
        }));
        assert_eq!(state.subscribers.len(), 1);
    }

    #[test]
    fn begin_shutdown_blocks_mutations_and_drops_subscribers() {
        let (subscriber_tx, subscriber_rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: PathBuf::from("/tmp/does-not-matter.db"),
            logs_dir: PathBuf::from("/tmp/does-not-matter-logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: vec![subscriber_tx],
        }));

        begin_shutdown(&state);

        let guard = state.lock().unwrap();
        assert!(guard.shutting_down);
        assert!(guard.subscribers.is_empty());
        drop(guard);
        assert!(subscriber_rx
            .recv_timeout(Duration::from_millis(20))
            .is_err());
    }

    #[test]
    fn graceful_shutdown_interrupts_active_turn_and_stops_owned_session() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let logs_dir = temp.path().join("logs");
        let store = seeded_workspace_store(&db_path, &logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        let launch = store.session_launch("berlin", SessionKind::Codex).unwrap();
        let process = store
            .record_session_process_for_thread("berlin", thread.id, &launch, exited_child_pid())
            .unwrap();
        let mut active_turn = provider_event(
            thread.id,
            "turn-1",
            ProviderEventKind::Turn,
            ProviderEventPhase::Started,
            "turn/started",
            "Turn started",
            "",
        );
        active_turn.process_id = Some(process.id);
        ProviderEventStore::new(&db_path)
            .upsert_event(&active_turn)
            .unwrap();
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: process.id,
            thread_id: thread.id,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: process.pid,
            status: ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::Running,
            ready: false,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, _command_rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir,
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::from([(
                process.id,
                crate::archcar::session::SessionHandle {
                    snapshot: Arc::new(Mutex::new(snapshot)),
                    command_tx,
                },
            )]),
            subscribers: Vec::new(),
        }));

        shutdown_managed_sessions(&state, "Archcar is shutting down.").unwrap();

        assert_eq!(
            store.get_process_record(process.id).unwrap().status,
            ProcessStatus::Stopped
        );
        let events = ProviderEventStore::new(&db_path)
            .list_for_process(process.id)
            .unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.phase == ProviderEventPhase::Interrupted)
                .count(),
            1
        );
    }

    #[test]
    fn ensure_chat_thread_session_does_not_reuse_other_thread() {
        let temp = tempfile::tempdir().unwrap();
        let repo_path = init_repo(temp.path().join("demo"));
        let db_path = temp.path().join("state.db");
        let workspace_parent = temp.path().join("workspaces/demo");
        RepositoryStore::open(&db_path)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(workspace_parent),
            })
            .unwrap();
        let store = WorkspaceStore::open(&db_path).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        let requested_thread = store
            .create_chat_thread("berlin", "codex", "Codex Chat 2", None)
            .unwrap();
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: requested_thread.id + 1,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
            status: crate::workspace::ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::WaitingForInput,
            ready: true,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, _command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            snapshot.session_id,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path,
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));

        let response = ensure_chat_thread_session(
            &state,
            "berlin".to_owned(),
            requested_thread.id,
            SessionKind::Codex,
            crate::workspace::SessionHarnessOptions::default(),
        );

        assert_eq!(
            response,
            ArchcarResponse::SessionSpawnQueued {
                workspace: "berlin".to_owned(),
                kind: SessionKind::Codex,
            }
        );
    }

    #[test]
    fn auto_send_rejects_not_ready_managed_session_before_enqueue() {
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: 4,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
            status: crate::workspace::ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::Running,
            ready: false,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            snapshot.session_id,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: PathBuf::from("/tmp/does-not-matter.db"),
            logs_dir: PathBuf::from("/tmp/does-not-matter-logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));

        let response = dispatch_request(
            ArchcarRequest::SendInput {
                session_id: 9,
                input: "queued follow-up".to_owned(),
                visible_input: None,
                kind: ArchcarInputKind::User,
                delivery: ArchcarInputDelivery::Auto,
            },
            &state,
        );

        assert!(matches!(
            response,
            ArchcarResponse::Error { ref message }
                if message.contains("not ready for automatic input")
        ));
        assert!(command_rx.try_recv().is_err());
    }

    #[test]
    fn immediate_send_allows_not_ready_managed_session_for_steering() {
        let snapshot = crate::archcar::session::SessionSnapshot {
            session_id: 9,
            thread_id: 4,
            workspace: "berlin".to_owned(),
            kind: SessionKind::Codex,
            pid: 12345,
            status: crate::workspace::ProcessStatus::Running,
            runtime_state: crate::session_state::AgentSessionState::Running,
            ready: false,
            capabilities: None,
            screen: String::new(),
        };
        let (command_tx, command_rx) = mpsc::channel();
        let mut sessions = HashMap::new();
        sessions.insert(
            snapshot.session_id,
            crate::archcar::session::SessionHandle {
                snapshot: Arc::new(Mutex::new(snapshot)),
                command_tx,
            },
        );
        let state = Arc::new(Mutex::new(ServerState {
            db_path: PathBuf::from("/tmp/does-not-matter.db"),
            logs_dir: PathBuf::from("/tmp/does-not-matter-logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions,
            subscribers: Vec::new(),
        }));

        let response = dispatch_request(
            ArchcarRequest::SendInput {
                session_id: 9,
                input: "steer now".to_owned(),
                visible_input: None,
                kind: ArchcarInputKind::User,
                delivery: ArchcarInputDelivery::Immediate,
            },
            &state,
        );

        assert_eq!(response, ArchcarResponse::Ack);
        assert!(matches!(
            command_rx.try_recv(),
            Ok(crate::archcar::session::SessionCommand::SendInput {
                input,
                delivery: ArchcarInputDelivery::Immediate,
                ..
            }) if input == "steer now"
        ));
    }

    #[test]
    fn ensure_chat_thread_session_validates_workspace_before_queue_dedupe() {
        let temp = tempfile::tempdir().unwrap();
        let repo_path = init_repo(temp.path().join("demo"));
        let db_path = temp.path().join("state.db");
        let workspace_parent = temp.path().join("workspaces/demo");
        RepositoryStore::open(&db_path)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(workspace_parent),
            })
            .unwrap();
        let store = WorkspaceStore::open(&db_path).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "tokyo".to_owned(),
                branch: "lc/tokyo".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        let requested_thread = store
            .create_chat_thread("berlin", "codex", "Codex Chat", None)
            .unwrap();
        let state = Arc::new(Mutex::new(ServerState {
            db_path,
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::from([requested_thread.id]),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));

        let response = ensure_chat_thread_session(
            &state,
            "tokyo".to_owned(),
            requested_thread.id,
            SessionKind::Codex,
            crate::workspace::SessionHarnessOptions::default(),
        );

        assert!(matches!(response, ArchcarResponse::Error { .. }));
    }

    #[test]
    fn session_messages_merge_persisted_inputs_at_provider_user_anchors() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let store = seeded_workspace_store(&db_path, &temp.path().join("logs"), temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        store
            .append_chat_message(thread.id, "user", "first", "user_send")
            .unwrap();
        store
            .append_chat_message(thread.id, "user", "second", "user_send")
            .unwrap();
        let event_store = ProviderEventStore::new(&db_path);
        for (sequence, kind, item_id, body) in [
            (1, ProviderEventKind::UserInput, "user-1", "first"),
            (
                2,
                ProviderEventKind::AssistantOutput,
                "assistant-1",
                "answer one",
            ),
            (3, ProviderEventKind::UserInput, "user-2", "second"),
            (
                4,
                ProviderEventKind::AssistantOutput,
                "assistant-2",
                "answer two",
            ),
        ] {
            event_store
                .upsert_event(&ProviderEventDraft {
                    provider: "codex".to_owned(),
                    provider_event_id: Some(format!("event-{sequence}")),
                    provider_item_id: Some(item_id.to_owned()),
                    provider_thread_id: Some("thread-1".to_owned()),
                    provider_turn_id: None,
                    parent_provider_item_id: None,
                    parent_provider_thread_id: None,
                    workspace_id: None,
                    chat_thread_id: Some(thread.id),
                    process_id: None,
                    phase: ProviderEventPhase::Completed,
                    kind,
                    provider_subtype: Some("test".to_owned()),
                    provider_sequence: Some(sequence),
                    occurred_at_ms: sequence as u64,
                    normalized_payload: json!({
                        "title": if kind == ProviderEventKind::UserInput { "User" } else { "Assistant" },
                        "body": body
                    }),
                    raw_json: json!({"sequence": sequence}),
                    schema_version: 1,
                    adapter_version: "test".to_owned(),
                })
                .unwrap();
        }

        let messages = session_messages_for_thread(&db_path, thread.id).unwrap();
        let rendered = messages
            .iter()
            .map(|message| format!("{}:{}", message.role, message.content))
            .collect::<Vec<_>>();

        assert_eq!(
            rendered,
            vec![
                "user:first",
                "assistant:answer one",
                "user:second",
                "assistant:answer two",
            ]
        );
    }

    #[test]
    fn session_messages_emit_history_before_matching_provider_anchor() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let store = seeded_workspace_store(&db_path, &temp.path().join("logs"), temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        store
            .append_chat_message(thread.id, "user", "old prompt", "user_send")
            .unwrap();
        store
            .append_chat_message(thread.id, "agent", "old answer", "agent")
            .unwrap();
        store
            .append_chat_message(thread.id, "user", "new prompt", "user_send")
            .unwrap();
        let event_store = ProviderEventStore::new(&db_path);
        for (sequence, kind, item_id, body) in [
            (1, ProviderEventKind::UserInput, "user-1", "new prompt"),
            (
                2,
                ProviderEventKind::AssistantOutput,
                "assistant-1",
                "new answer",
            ),
        ] {
            event_store
                .upsert_event(&provider_event_with_sequence(
                    thread.id, sequence, kind, item_id, body,
                ))
                .unwrap();
        }

        let rendered = session_messages_for_thread(&db_path, thread.id)
            .unwrap()
            .into_iter()
            .map(|message| format!("{}:{}", message.role, message.content))
            .collect::<Vec<_>>();

        assert_eq!(
            rendered,
            vec![
                "user:old prompt",
                "agent:old answer",
                "user:new prompt",
                "assistant:new answer",
            ]
        );
    }

    #[test]
    fn session_messages_synthesize_provider_user_without_persisted_anchor() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let store = seeded_workspace_store(&db_path, &temp.path().join("logs"), temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        let event_store = ProviderEventStore::new(&db_path);
        for (sequence, kind, item_id, body) in [
            (1, ProviderEventKind::UserInput, "user-1", "native prompt"),
            (
                2,
                ProviderEventKind::AssistantOutput,
                "assistant-1",
                "native answer",
            ),
        ] {
            event_store
                .upsert_event(&provider_event_with_sequence(
                    thread.id, sequence, kind, item_id, body,
                ))
                .unwrap();
        }

        let rendered = session_messages_for_thread(&db_path, thread.id)
            .unwrap()
            .into_iter()
            .map(|message| format!("{}:{}:{}", message.role, message.source, message.content))
            .collect::<Vec<_>>();

        assert_eq!(
            rendered,
            vec![
                "user:provider_event:native prompt",
                "assistant:provider_event:native answer",
            ]
        );
    }

    #[test]
    fn session_messages_ignore_empty_provider_user_anchors() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let store = seeded_workspace_store(&db_path, &temp.path().join("logs"), temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        store
            .append_chat_message(thread.id, "user", "persisted prompt", "user_send")
            .unwrap();
        let event_store = ProviderEventStore::new(&db_path);
        event_store
            .upsert_event(&provider_event_with_sequence(
                thread.id,
                1,
                ProviderEventKind::UserInput,
                "user-1",
                "",
            ))
            .unwrap();

        let rendered = session_messages_for_thread(&db_path, thread.id)
            .unwrap()
            .into_iter()
            .map(|message| format!("{}:{}:{}", message.role, message.source, message.content))
            .collect::<Vec<_>>();

        assert_eq!(rendered, vec!["user:user_send:persisted prompt"]);
    }

    #[test]
    fn session_messages_dedupe_provider_assistant_against_remaining_agent_row() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let store = seeded_workspace_store(&db_path, &temp.path().join("logs"), temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        store
            .append_chat_message(thread.id, "user", "prompt", "user_send")
            .unwrap();
        store
            .append_chat_message(thread.id, "agent", "same answer", "agent")
            .unwrap();
        let event_store = ProviderEventStore::new(&db_path);
        for (sequence, kind, item_id, body) in [
            (1, ProviderEventKind::UserInput, "user-1", "prompt"),
            (
                2,
                ProviderEventKind::AssistantOutput,
                "assistant-1",
                "same answer",
            ),
        ] {
            event_store
                .upsert_event(&provider_event_with_sequence(
                    thread.id, sequence, kind, item_id, body,
                ))
                .unwrap();
        }

        let rendered = session_messages_for_thread(&db_path, thread.id)
            .unwrap()
            .into_iter()
            .map(|message| format!("{}:{}:{}", message.role, message.source, message.content))
            .collect::<Vec<_>>();

        assert_eq!(
            rendered,
            vec!["user:user_send:prompt", "agent:agent:same answer"]
        );
    }

    #[test]
    fn persisted_running_session_candidates_preserve_store_descending_order() {
        let records = vec![
            crate::workspace::ProcessRecord {
                id: 6,
                workspace_id: 1,
                chat_thread_id: Some(60),
                kind: crate::workspace::ProcessKind::Session,
                command: "codex".to_owned(),
                pid: 666,
                log_path: "/tmp/6.log".into(),
                status: crate::workspace::ProcessStatus::Exited,
                started_at: "2026-06-28T00:00:03Z".to_owned(),
                exit_code: Some(0),
                ended_at: Some("2026-06-28T00:00:04Z".to_owned()),
                session_harness_metadata: None,
                session_resume_id: None,
            },
            crate::workspace::ProcessRecord {
                id: 5,
                workspace_id: 1,
                chat_thread_id: Some(50),
                kind: crate::workspace::ProcessKind::Session,
                command: "codex resume --last".to_owned(),
                pid: 555,
                log_path: "/tmp/5.log".into(),
                status: crate::workspace::ProcessStatus::Running,
                started_at: "2026-06-28T00:00:02Z".to_owned(),
                exit_code: None,
                ended_at: None,
                session_harness_metadata: None,
                session_resume_id: None,
            },
            crate::workspace::ProcessRecord {
                id: 4,
                workspace_id: 1,
                chat_thread_id: Some(40),
                kind: crate::workspace::ProcessKind::Session,
                command: "claude".to_owned(),
                pid: 444,
                log_path: "/tmp/4.log".into(),
                status: crate::workspace::ProcessStatus::Running,
                started_at: "2026-06-28T00:00:01Z".to_owned(),
                exit_code: None,
                ended_at: None,
                session_harness_metadata: None,
                session_resume_id: None,
            },
            crate::workspace::ProcessRecord {
                id: 3,
                workspace_id: 1,
                chat_thread_id: Some(30),
                kind: crate::workspace::ProcessKind::Session,
                command: "codex --no-alt-screen".to_owned(),
                pid: 333,
                log_path: "/tmp/3.log".into(),
                status: crate::workspace::ProcessStatus::Running,
                started_at: "2026-06-28T00:00:00Z".to_owned(),
                exit_code: None,
                ended_at: None,
                session_harness_metadata: None,
                session_resume_id: None,
            },
        ];

        assert_eq!(
            persisted_running_session_candidates(&records, SessionKind::Codex)
                .into_iter()
                .map(|record| record.id)
                .collect::<Vec<_>>(),
            vec![5, 3]
        );
        assert_eq!(
            persisted_running_session_candidates(&records, SessionKind::Claude)
                .into_iter()
                .map(|record| record.id)
                .collect::<Vec<_>>(),
            vec![4]
        );
    }

    fn init_repo(path: PathBuf) -> PathBuf {
        fs::create_dir(&path).unwrap();
        Command::new("git")
            .args(["init", "--initial-branch", "main"])
            .arg(&path)
            .status()
            .unwrap();
        fs::write(path.join("README.md"), "demo\n").unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["add", "."])
            .status()
            .unwrap();
        Command::new("git")
            .arg("-C")
            .arg(&path)
            .args([
                "-c",
                "user.name=Archductor",
                "-c",
                "user.email=archductor@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                "initial",
            ])
            .status()
            .unwrap();
        path
    }

    fn wait_for_test_path(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if path.exists() {
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("timed out waiting for {}", path.display());
    }

    #[test]
    fn workspace_run_scripts_dispatch_projects_local_availability() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        fs::create_dir_all(repo_path.join(".archductor")).unwrap();
        fs::write(
            repo_path.join(".archductor/settings.toml"),
            r#"
[scripts.run.dev]
command = "pnpm dev --port $ARCHDUCTOR_PORT"
available_in = ["local"]
default = true
icon = "play"

[scripts.run.cloud-preview]
command = "pnpm preview"
available_in = ["cloud"]
icon = "cloud"
"#,
        )
        .unwrap();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));

        let added = dispatch_request(
            ArchcarRequest::AddRepository {
                path: repo_path.to_string_lossy().into_owned(),
                name: Some("demo".to_owned()),
                remote_name: None,
                default_branch: Some("main".to_owned()),
                workspace_parent: Some(
                    temp.path()
                        .join("workspaces/demo")
                        .to_string_lossy()
                        .into_owned(),
                ),
            },
            &state,
        );
        assert!(
            matches!(added, ArchcarResponse::RepositoryAdded { ref name } if name == "demo"),
            "add_repository got {added:?}"
        );
        let created = dispatch_request(
            ArchcarRequest::CreateWorkspace {
                repository: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            },
            &state,
        );
        assert!(
            matches!(created, ArchcarResponse::WorkspaceCreated { ref name } if name == "berlin"),
            "create_workspace got {created:?}"
        );

        let response = dispatch_request(
            ArchcarRequest::GetWorkspaceRunScripts {
                workspace: "berlin".to_owned(),
            },
            &state,
        );

        let ArchcarResponse::WorkspaceRunScripts { scripts, .. } = response else {
            panic!("get_workspace_run_scripts got {response:?}");
        };
        assert_eq!(scripts.len(), 2);
        assert_eq!(scripts[0].id, "cloud-preview");
        assert!(!scripts[0].runnable_here);
        assert_eq!(
            scripts[0].unavailable_reason.as_deref(),
            Some("Available only in cloud workspaces.")
        );
        assert_eq!(scripts[1].id, "dev");
        assert!(scripts[1].runnable_here);
        assert!(scripts[1].default);
    }

    #[test]
    fn workspace_script_start_dispatch_runs_setup_and_default_run_script() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        fs::create_dir_all(repo_path.join(".archductor")).unwrap();
        fs::write(
            repo_path.join(".archductor/settings.toml"),
            r#"
[scripts]
setup = "printf setup > .context/setup-started"

[scripts.run.dev]
command = "printf run > .context/run-started; sleep 5"
available_in = ["local"]
default = true
"#,
        )
        .unwrap();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));

        let added = dispatch_request(
            ArchcarRequest::AddRepository {
                path: repo_path.to_string_lossy().into_owned(),
                name: Some("demo".to_owned()),
                remote_name: None,
                default_branch: Some("main".to_owned()),
                workspace_parent: Some(
                    temp.path()
                        .join("workspaces/demo")
                        .to_string_lossy()
                        .into_owned(),
                ),
            },
            &state,
        );
        assert!(
            matches!(added, ArchcarResponse::RepositoryAdded { ref name } if name == "demo"),
            "add_repository got {added:?}"
        );
        let created = dispatch_request(
            ArchcarRequest::CreateWorkspace {
                repository: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            },
            &state,
        );
        assert!(
            matches!(created, ArchcarResponse::WorkspaceCreated { ref name } if name == "berlin"),
            "create_workspace got {created:?}"
        );
        let workspace = WorkspaceStore::open_app(&db_path)
            .unwrap()
            .list()
            .unwrap()
            .into_iter()
            .find(|workspace| workspace.name == "berlin")
            .unwrap();

        let setup = dispatch_request(
            ArchcarRequest::StartWorkspaceSetup {
                workspace: "berlin".to_owned(),
            },
            &state,
        );
        assert!(
            matches!(setup, ArchcarResponse::WorkspaceProcessStarted { ref process, .. } if process.kind == "setup"),
            "start_workspace_setup got {setup:?}"
        );
        wait_for_test_path(&workspace.path.join(".context/setup-started"));

        let run = dispatch_request(
            ArchcarRequest::StartWorkspaceRun {
                workspace: "berlin".to_owned(),
            },
            &state,
        );
        assert!(
            matches!(run, ArchcarResponse::WorkspaceProcessStarted { ref process, .. } if process.kind == "run"),
            "start_workspace_run got {run:?}"
        );
        wait_for_test_path(&workspace.path.join(".context/run-started"));

        let stopped = dispatch_request(
            ArchcarRequest::StopWorkspaceRun {
                workspace: "berlin".to_owned(),
            },
            &state,
        );
        assert!(
            matches!(stopped, ArchcarResponse::WorkspaceProcessStopped { ref process, .. } if process.kind == "run" && process.status == "stopped"),
            "stop_workspace_run got {stopped:?}"
        );
    }

    #[test]
    fn abort_background_agents_drains_queues_and_closes_threads() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));
        dispatch_request(
            ArchcarRequest::AddRepository {
                path: repo_path.to_string_lossy().into_owned(),
                name: Some("demo".to_owned()),
                remote_name: None,
                default_branch: Some("main".to_owned()),
                workspace_parent: Some(
                    temp.path()
                        .join("workspaces/demo")
                        .to_string_lossy()
                        .into_owned(),
                ),
            },
            &state,
        );
        dispatch_request(
            ArchcarRequest::CreateWorkspace {
                repository: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            },
            &state,
        );
        let created = dispatch_request(
            ArchcarRequest::CreateChatThread {
                workspace: "berlin".to_owned(),
                provider: "codex".to_owned(),
                title: "doomed agent".to_owned(),
            },
            &state,
        );
        let ArchcarResponse::ChatThreadCreated { thread } = created else {
            panic!("create_chat_thread got {created:?}");
        };
        dispatch_request(
            ArchcarRequest::QueueChatInput {
                thread_id: thread.id,
                input: "do the work".to_owned(),
                visible_input: None,
                kind: ArchcarInputKind::User,
                session_kind: SessionKind::Codex,
            },
            &state,
        );

        // Before the abort the thread reads as open — this is the flag the
        // spawn-registration path checks under the state lock.
        assert!(!WorkspaceStore::open_app(&db_path)
            .unwrap()
            .chat_thread_is_closed(thread.id)
            .unwrap());

        abort_background_agents(&state, &[thread.id]);

        // The close is what a mid-spawn registration observes and terminates on.
        assert!(WorkspaceStore::open_app(&db_path)
            .unwrap()
            .chat_thread_is_closed(thread.id)
            .unwrap());

        // The queued prompt is gone, so a late-spawning session has no work.
        let queued = dispatch_request(
            ArchcarRequest::ListQueuedChatInputs {
                thread_id: thread.id,
            },
            &state,
        );
        assert!(
            matches!(queued, ArchcarResponse::QueuedChatInputs { ref inputs, .. } if inputs.is_empty()),
            "queue should be drained, got {queued:?}"
        );
        // The thread is closed, so it no longer lists as an active session.
        let threads = dispatch_request(
            ArchcarRequest::ListChatThreads {
                workspace: "berlin".to_owned(),
            },
            &state,
        );
        assert!(
            matches!(threads, ArchcarResponse::ChatThreads { ref threads, .. } if threads.is_empty()),
            "thread should be closed, got {threads:?}"
        );
    }

    #[test]
    fn workspace_intelligence_dispatch_end_to_end() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));

        dispatch_request(
            ArchcarRequest::AddRepository {
                path: repo_path.to_string_lossy().into_owned(),
                name: Some("demo".to_owned()),
                remote_name: None,
                default_branch: Some("main".to_owned()),
                workspace_parent: Some(
                    temp.path()
                        .join("workspaces/demo")
                        .to_string_lossy()
                        .into_owned(),
                ),
            },
            &state,
        );
        dispatch_request(
            ArchcarRequest::CreateWorkspace {
                repository: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            },
            &state,
        );

        let created = dispatch_request(
            ArchcarRequest::CreateTask {
                workspace: "berlin".to_owned(),
                title: "Port the right panel".to_owned(),
                body: String::new(),
                intended_areas: vec!["desktop/src/pages".to_owned()],
            },
            &state,
        );
        let ArchcarResponse::TaskSaved { task } = created else {
            panic!("create_task got {created:?}");
        };
        assert_eq!(task.status, "todo");

        let updated = dispatch_request(
            ArchcarRequest::UpdateTask {
                workspace: "berlin".to_owned(),
                task_id: task.id,
                update: crate::workspace_intel::TaskUpdate {
                    status: Some("in_progress".to_owned()),
                    ..Default::default()
                },
            },
            &state,
        );
        assert!(
            matches!(updated, ArchcarResponse::TaskSaved { ref task } if task.status == "in_progress"),
            "update_task got {updated:?}"
        );

        let listed = dispatch_request(
            ArchcarRequest::ListTasks {
                workspace: "berlin".to_owned(),
            },
            &state,
        );
        assert!(
            matches!(listed, ArchcarResponse::Tasks { ref tasks, .. } if tasks.len() == 1),
            "list_tasks got {listed:?}"
        );

        let drafted = dispatch_request(
            ArchcarRequest::DraftSummary {
                workspace: "berlin".to_owned(),
                session_id: None,
            },
            &state,
        );
        let ArchcarResponse::SummaryDraft { body_markdown, .. } = drafted else {
            panic!("draft_summary got {drafted:?}");
        };
        assert!(
            body_markdown.contains("Port the right panel"),
            "{body_markdown}"
        );

        let saved = dispatch_request(
            ArchcarRequest::SaveSummary {
                workspace: "berlin".to_owned(),
                scope_type: "workspace".to_owned(),
                scope_id: None,
                body_markdown: body_markdown.clone(),
                source_refs: vec!["draft".to_owned()],
            },
            &state,
        );
        assert!(
            matches!(saved, ArchcarResponse::SummarySaved { .. }),
            "save_summary got {saved:?}"
        );

        let refreshed = dispatch_request(
            ArchcarRequest::RefreshSummary {
                workspace: "berlin".to_owned(),
                scope_type: "workspace".to_owned(),
                scope_id: None,
            },
            &state,
        );
        let ArchcarResponse::SummaryRefreshed { result, .. } = refreshed else {
            panic!("refresh_summary got {refreshed:?}");
        };
        assert_eq!(result.summary.scope_type, "workspace");
        assert_eq!(result.state.source, "auto");
        assert!(!result.state.evidence_hash.is_empty());

        // Session-scoped refresh without a scope_id is refused, not guessed.
        let refused = dispatch_request(
            ArchcarRequest::RefreshSummary {
                workspace: "berlin".to_owned(),
                scope_type: "session".to_owned(),
                scope_id: None,
            },
            &state,
        );
        assert!(
            matches!(refused, ArchcarResponse::Error { ref message } if message.contains("scope_id")),
            "refresh_summary without scope_id got {refused:?}"
        );

        let briefed = dispatch_request(
            ArchcarRequest::GetContextBriefing {
                workspace: "berlin".to_owned(),
                thread_id: None,
            },
            &state,
        );
        let ArchcarResponse::ContextBriefing { briefing } = briefed else {
            panic!("get_context_briefing got {briefed:?}");
        };
        assert!(briefing.body_markdown.contains("## Workspace"));
        assert!(briefing.body_markdown.contains("## Tasks"));
        assert!(briefing.body_markdown.contains("Port the right panel"));
        assert_eq!(briefing.task_ids, vec![task.id]);

        let attached = dispatch_request(
            ArchcarRequest::AddContextAttachment {
                workspace: "berlin".to_owned(),
                source: "local".to_owned(),
                kind: "note".to_owned(),
                body_or_ref: "review base is main".to_owned(),
                scope: String::new(),
                pinned: true,
            },
            &state,
        );
        let ArchcarResponse::ContextAttachmentAdded { attachment } = attached else {
            panic!("add_context_attachment got {attached:?}");
        };

        let context = dispatch_request(
            ArchcarRequest::ListContextAttachments {
                workspace: "berlin".to_owned(),
            },
            &state,
        );
        assert!(
            matches!(context, ArchcarResponse::ContextAttachments { ref attachments, .. } if attachments.len() == 1),
            "list_context_attachments got {context:?}"
        );

        let removed = dispatch_request(
            ArchcarRequest::RemoveContextAttachment {
                workspace: "berlin".to_owned(),
                attachment_id: attachment.id,
            },
            &state,
        );
        assert!(
            matches!(removed, ArchcarResponse::ContextAttachmentRemoved { .. }),
            "remove_context_attachment got {removed:?}"
        );

        let deleted = dispatch_request(
            ArchcarRequest::DeleteTask {
                workspace: "berlin".to_owned(),
                task_id: task.id,
            },
            &state,
        );
        assert!(
            matches!(deleted, ArchcarResponse::TaskDeleted { .. }),
            "delete_task got {deleted:?}"
        );
    }

    #[test]
    fn repository_and_workspace_lifecycle_dispatch_end_to_end() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));

        let added = dispatch_request(
            ArchcarRequest::AddRepository {
                path: repo_path.to_string_lossy().into_owned(),
                name: Some("demo".to_owned()),
                remote_name: None,
                default_branch: Some("main".to_owned()),
                workspace_parent: Some(
                    temp.path()
                        .join("workspaces/demo")
                        .to_string_lossy()
                        .into_owned(),
                ),
            },
            &state,
        );
        assert!(
            matches!(added, ArchcarResponse::RepositoryAdded { ref name } if name == "demo"),
            "add_repository got {added:?}"
        );

        let created = dispatch_request(
            ArchcarRequest::CreateWorkspace {
                repository: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            },
            &state,
        );
        assert!(
            matches!(created, ArchcarResponse::WorkspaceCreated { ref name } if name == "berlin"),
            "create_workspace got {created:?}"
        );

        let renamed = dispatch_request(
            ArchcarRequest::RenameWorkspace {
                workspace: "berlin".to_owned(),
                new_name: "berlin2".to_owned(),
            },
            &state,
        );
        assert!(
            matches!(renamed, ArchcarResponse::WorkspaceUpdated { ref name } if name == "berlin2"),
            "rename_workspace got {renamed:?}"
        );

        let archived = dispatch_request(
            ArchcarRequest::ArchiveWorkspace {
                workspace: "berlin2".to_owned(),
                remove_worktree: false,
            },
            &state,
        );
        assert!(
            matches!(archived, ArchcarResponse::WorkspaceUpdated { .. }),
            "archive_workspace got {archived:?}"
        );

        let restored = dispatch_request(
            ArchcarRequest::RestoreWorkspace {
                workspace: "berlin2".to_owned(),
            },
            &state,
        );
        assert!(
            matches!(restored, ArchcarResponse::WorkspaceUpdated { .. }),
            "restore_workspace got {restored:?}"
        );

        let deleted = dispatch_request(
            ArchcarRequest::DeleteWorkspace {
                workspace: "berlin2".to_owned(),
                remove_worktree: true,
                delete_branch: false,
            },
            &state,
        );
        assert!(
            matches!(deleted, ArchcarResponse::WorkspaceRemoved { ref name } if name == "berlin2"),
            "delete_workspace got {deleted:?}"
        );

        let listed = dispatch_request(ArchcarRequest::ListWorkspaces, &state);
        assert!(
            matches!(listed, ArchcarResponse::Workspaces { ref workspaces } if workspaces.is_empty()),
            "list_workspaces got {listed:?}"
        );
    }

    #[test]
    fn workspace_lifecycle_broadcasts_inventory_change_events() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        let (subscriber_tx, subscriber_rx) = mpsc::channel();
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: vec![subscriber_tx],
        }));

        dispatch_request(
            ArchcarRequest::AddRepository {
                path: repo_path.to_string_lossy().into_owned(),
                name: Some("demo".to_owned()),
                remote_name: None,
                default_branch: Some("main".to_owned()),
                workspace_parent: Some(
                    temp.path()
                        .join("workspaces/demo")
                        .to_string_lossy()
                        .into_owned(),
                ),
            },
            &state,
        );
        dispatch_request(
            ArchcarRequest::CreateWorkspace {
                repository: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            },
            &state,
        );

        let events = subscriber_rx.try_iter().collect::<Vec<_>>();
        assert!(
            events.iter().any(|event| {
                matches!(
                    event,
                    ArchcarEvent::InventoryChanged {
                        scope,
                        repository: Some(repository),
                        workspace: None,
                    } if scope == "repositories" && repository == "demo"
                )
            }),
            "expected repository inventory change, got {events:?}"
        );
        assert!(
            events.iter().any(|event| {
                matches!(
                    event,
                    ArchcarEvent::InventoryChanged {
                        scope,
                        repository: None,
                        workspace: Some(workspace),
                    } if scope == "workspaces" && workspace == "berlin"
                )
            }),
            "expected workspace inventory change, got {events:?}"
        );
    }

    #[test]
    fn inventory_snapshot_lists_repositories_workspaces_and_chat_threads() {
        let temp = tempfile::tempdir().unwrap();
        let db_path = temp.path().join("state.db");
        let repo_path = init_repo(temp.path().join("demo"));
        let state = Arc::new(Mutex::new(ServerState {
            db_path: db_path.clone(),
            logs_dir: temp.path().join("logs"),
            shutting_down: false,
            queued_defaults: HashSet::new(),
            queued_threads: HashSet::new(),
            draining_threads: HashSet::new(),
            drain_reruns: HashSet::new(),
            sessions: HashMap::new(),
            subscribers: Vec::new(),
        }));

        dispatch_request(
            ArchcarRequest::AddRepository {
                path: repo_path.to_string_lossy().into_owned(),
                name: Some("demo".to_owned()),
                remote_name: None,
                default_branch: Some("main".to_owned()),
                workspace_parent: Some(
                    temp.path()
                        .join("workspaces/demo")
                        .to_string_lossy()
                        .into_owned(),
                ),
            },
            &state,
        );
        dispatch_request(
            ArchcarRequest::CreateWorkspace {
                repository: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            },
            &state,
        );
        let created = dispatch_request(
            ArchcarRequest::CreateChatThread {
                workspace: "berlin".to_owned(),
                provider: "codex".to_owned(),
                title: "remote client prep".to_owned(),
            },
            &state,
        );
        assert!(
            matches!(created, ArchcarResponse::ChatThreadCreated { .. }),
            "create_chat_thread got {created:?}"
        );

        let snapshot = dispatch_request(ArchcarRequest::GetInventorySnapshot, &state);
        let ArchcarResponse::InventorySnapshot {
            repositories,
            workspaces,
            chat_threads,
        } = snapshot
        else {
            panic!("get_inventory_snapshot got {snapshot:?}");
        };

        assert_eq!(repositories.len(), 1);
        assert_eq!(repositories[0].name, "demo");
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].name, "berlin");
        assert_eq!(chat_threads.get("berlin").map(Vec::len), Some(1));
    }

    #[cfg(unix)]
    #[test]
    fn reconcile_startup_leaves_live_managed_codex_sessions_running() {
        let temp = tempfile::tempdir().unwrap();
        let paths = app_paths(temp.path());
        let store = seeded_workspace_store(&paths.database_path, &paths.logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        let launch = store.session_launch("berlin", SessionKind::Codex).unwrap();
        let mut child = spawn_fake_managed_codex_process();
        let process = store
            .record_session_process_for_thread("berlin", thread.id, &launch, child.id())
            .unwrap();
        assert!(
            wait_for_fake_codex_child_alive(child.id()),
            "fake codex child should be alive before reconciliation"
        );

        reconcile_managed_sessions_on_startup(&paths).unwrap();

        assert!(
            child.try_wait().unwrap().is_none(),
            "startup reconciliation should not signal live pids"
        );
        let reconciled = store.get_process_record(process.id).unwrap();
        assert_eq!(reconciled.status, ProcessStatus::Running);
        assert!(reconciled.ended_at.is_none());
        assert!(reconciled.log_path.starts_with(&paths.logs_dir));

        terminate_test_child(&mut child);
    }

    #[test]
    fn reconcile_startup_marks_dead_active_codex_turn_interrupted() {
        let temp = tempfile::tempdir().unwrap();
        let paths = app_paths(temp.path());
        let store = seeded_workspace_store(&paths.database_path, &paths.logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        let launch = store.session_launch("berlin", SessionKind::Codex).unwrap();
        let process = store
            .record_session_process_for_thread("berlin", thread.id, &launch, exited_child_pid())
            .unwrap();
        let mut active_turn = provider_event(
            thread.id,
            "turn-1",
            ProviderEventKind::Turn,
            ProviderEventPhase::Started,
            "turn/started",
            "Turn started",
            "",
        );
        active_turn.process_id = Some(process.id);
        ProviderEventStore::new(&paths.database_path)
            .upsert_event(&active_turn)
            .unwrap();

        reconcile_managed_sessions_on_startup(&paths).unwrap();

        let reconciled = store.get_process_record(process.id).unwrap();
        assert_eq!(reconciled.status, ProcessStatus::Stopped);
        assert!(reconciled.ended_at.is_some());
        assert!(reconciled.log_path.starts_with(&paths.logs_dir));
        let events = ProviderEventStore::new(&paths.database_path)
            .list_for_process(process.id)
            .unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    event.kind == ProviderEventKind::Turn
                        && event.phase == ProviderEventPhase::Interrupted
                })
                .count(),
            1
        );

        reconcile_managed_sessions_on_startup(&paths).unwrap();
        let events = ProviderEventStore::new(&paths.database_path)
            .list_for_process(process.id)
            .unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    event.kind == ProviderEventKind::Turn
                        && event.phase == ProviderEventPhase::Interrupted
                })
                .count(),
            1
        );
    }

    #[test]
    fn reconcile_startup_does_not_interrupt_completed_codex_turn() {
        let temp = tempfile::tempdir().unwrap();
        let paths = app_paths(temp.path());
        let store = seeded_workspace_store(&paths.database_path, &paths.logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        let launch = store.session_launch("berlin", SessionKind::Codex).unwrap();
        let process = store
            .record_session_process_for_thread("berlin", thread.id, &launch, exited_child_pid())
            .unwrap();
        let provider_store = ProviderEventStore::new(&paths.database_path);
        for phase in [ProviderEventPhase::Started, ProviderEventPhase::Completed] {
            let mut turn = provider_event(
                thread.id,
                "turn-1",
                ProviderEventKind::Turn,
                phase,
                if phase == ProviderEventPhase::Started {
                    "turn/started"
                } else {
                    "turn/completed"
                },
                "Turn",
                "",
            );
            turn.process_id = Some(process.id);
            provider_store.upsert_event(&turn).unwrap();
        }

        reconcile_managed_sessions_on_startup(&paths).unwrap();

        assert_eq!(
            store.get_process_record(process.id).unwrap().status,
            ProcessStatus::Exited
        );
        assert!(!provider_store
            .list_for_process(process.id)
            .unwrap()
            .iter()
            .any(|event| event.phase == ProviderEventPhase::Interrupted));
    }

    #[test]
    fn reconcile_startup_marks_dead_managed_claude_sessions_exited() {
        let temp = tempfile::tempdir().unwrap();
        let paths = app_paths(temp.path());
        let store = seeded_workspace_store(&paths.database_path, &paths.logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "claude", "Claude", None)
            .unwrap();
        let launch = store.session_launch("berlin", SessionKind::Claude).unwrap();
        let process = store
            .record_session_process_for_thread("berlin", thread.id, &launch, exited_child_pid())
            .unwrap();

        reconcile_managed_sessions_on_startup(&paths).unwrap();

        let reconciled = store.get_process_record(process.id).unwrap();
        assert_eq!(reconciled.status, ProcessStatus::Exited);
        assert!(reconciled.ended_at.is_some());
        assert!(reconciled.log_path.starts_with(&paths.logs_dir));
    }

    #[test]
    fn reconcile_startup_leaves_data_dir_codex_sessions_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let paths = app_paths(temp.path());
        let data_logs_dir = paths.data_dir.join("logs");
        let store = seeded_workspace_store(&paths.database_path, &data_logs_dir, temp.path());
        let thread = store
            .create_chat_thread("berlin", "codex", "Codex", None)
            .unwrap();
        let launch = store.session_launch("berlin", SessionKind::Codex).unwrap();
        let process = store
            .record_session_process_for_thread("berlin", thread.id, &launch, std::process::id())
            .unwrap();
        assert!(process.log_path.starts_with(&data_logs_dir));
        assert_eq!(process.status, ProcessStatus::Running);

        reconcile_managed_sessions_on_startup(&paths).unwrap();

        let unchanged = store.get_process_record(process.id).unwrap();
        assert_eq!(unchanged.status, ProcessStatus::Running);
        assert_eq!(unchanged.ended_at, None);
    }

    #[test]
    fn reconcile_startup_leaves_non_managed_sessions_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let paths = app_paths(temp.path());
        let store = seeded_workspace_store(
            &paths.database_path,
            &paths.data_dir.join("logs"),
            temp.path(),
        );
        let launch = store.session_launch("berlin", SessionKind::Shell).unwrap();
        let process = store
            .record_session_process("berlin", &launch, std::process::id())
            .unwrap();
        assert_eq!(process.status, ProcessStatus::Running);

        reconcile_managed_sessions_on_startup(&paths).unwrap();

        let unchanged = store.get_process_record(process.id).unwrap();
        assert_eq!(unchanged.status, ProcessStatus::Running);
        assert_eq!(unchanged.ended_at, None);
    }

    fn app_paths(root: &Path) -> AppPaths {
        let state_dir = root.join("state");
        AppPaths {
            config_dir: root.join("config"),
            data_dir: root.join("data"),
            state_dir: state_dir.clone(),
            cache_dir: root.join("cache"),
            database_path: root.join("data/archductor.db"),
            logs_dir: state_dir.join("logs"),
        }
    }

    fn seeded_workspace_store(db_path: &Path, logs_dir: &Path, root: &Path) -> WorkspaceStore {
        let repo_path = init_repo(root.join("demo"));
        RepositoryStore::open(db_path)
            .unwrap()
            .add(AddRepository {
                name: Some("demo".to_owned()),
                root_path: repo_path,
                default_branch: Some("main".to_owned()),
                remote_name: "origin".to_owned(),
                workspace_parent_path: Some(root.join("workspaces/demo")),
            })
            .unwrap();
        let store = WorkspaceStore::open_with_logs(db_path, logs_dir).unwrap();
        store
            .create(CreateWorkspace {
                repository_name: "demo".to_owned(),
                name: "berlin".to_owned(),
                branch: "lc/berlin".to_owned(),
                base_ref: Some("main".to_owned()),
            })
            .unwrap();
        store
    }

    fn provider_event(
        thread_id: i64,
        item_id: &str,
        kind: ProviderEventKind,
        phase: ProviderEventPhase,
        subtype: &str,
        title: &str,
        body: &str,
    ) -> ProviderEventDraft {
        ProviderEventDraft {
            provider: "codex".to_owned(),
            provider_event_id: Some(format!("evt-{item_id}")),
            provider_item_id: Some(item_id.to_owned()),
            provider_thread_id: Some("thread-1".to_owned()),
            provider_turn_id: Some("turn-1".to_owned()),
            parent_provider_item_id: None,
            parent_provider_thread_id: None,
            workspace_id: None,
            chat_thread_id: Some(thread_id),
            process_id: None,
            phase,
            kind,
            provider_subtype: Some(subtype.to_owned()),
            provider_sequence: Some(1),
            occurred_at_ms: 42,
            normalized_payload: json!({"title": title, "body": body}),
            raw_json: json!({"method": subtype, "params": {"body": body}}),
            schema_version: 1,
            adapter_version: "test".to_owned(),
        }
    }

    fn provider_event_with_sequence(
        thread_id: i64,
        sequence: u64,
        kind: ProviderEventKind,
        item_id: &str,
        body: &str,
    ) -> ProviderEventDraft {
        ProviderEventDraft {
            provider: "codex".to_owned(),
            provider_event_id: Some(format!("event-{sequence}")),
            provider_item_id: Some(item_id.to_owned()),
            provider_thread_id: Some("thread-1".to_owned()),
            provider_turn_id: None,
            parent_provider_item_id: None,
            parent_provider_thread_id: None,
            workspace_id: None,
            chat_thread_id: Some(thread_id),
            process_id: None,
            phase: ProviderEventPhase::Completed,
            kind,
            provider_subtype: Some("test".to_owned()),
            provider_sequence: Some(sequence as i64),
            occurred_at_ms: sequence,
            normalized_payload: json!({
                "title": if kind == ProviderEventKind::UserInput { "User" } else { "Assistant" },
                "body": body
            }),
            raw_json: json!({"sequence": sequence}),
            schema_version: 1,
            adapter_version: "test".to_owned(),
        }
    }

    #[cfg(unix)]
    fn spawn_fake_managed_codex_process() -> std::process::Child {
        let mut command = Command::new("bash");
        command
            .arg("-lc")
            .arg("exec -a codex bash -lc 'while :; do sleep 1; done' --no-alt-screen")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.process_group(0);
        command.spawn().unwrap()
    }

    #[cfg(unix)]
    fn terminate_test_child(child: &mut std::process::Child) {
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(format!("-{}", child.id()))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = Command::new("kill")
            .arg("-KILL")
            .arg(child.id().to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = child.wait();
    }

    #[cfg(unix)]
    fn wait_for_fake_codex_child_alive(pid: u32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let alive = Command::new("kill")
                .arg("-0")
                .arg(pid.to_string())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            if alive {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }

    fn exited_child_pid() -> u32 {
        let mut command = crate::platform::shell_command("exit 0");
        let mut child = command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        pid
    }
}
