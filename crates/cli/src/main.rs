use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use linux_conductor_core::doctor;
use linux_conductor_core::paths::AppPaths;
use linux_conductor_core::repository::{AddRepository, RepositoryStore};
use linux_conductor_core::workspace::{CreateWorkspace, SessionKind, WorkspaceStore};
use std::path::PathBuf;

#[derive(Debug, Parser)]
#[command(name = "linux-conductor")]
#[command(about = "Linux-native Git worktree workflow for parallel coding agents")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Doctor,
    Repo {
        #[command(subcommand)]
        command: RepoCommand,
    },
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
    Run {
        workspace: String,
    },
    Stop {
        workspace: String,
    },
    Logs {
        workspace: String,
        #[arg(long)]
        run: bool,
        #[arg(long)]
        session: bool,
    },
    Diff {
        workspace: String,
        #[arg(long)]
        name_only: bool,
        #[arg(long)]
        file: Option<PathBuf>,
    },
    Pr {
        #[command(subcommand)]
        command: PrCommand,
    },
    Session {
        #[command(subcommand)]
        command: SessionCommand,
    },
}

#[derive(Debug, Subcommand)]
enum RepoCommand {
    Add {
        path: PathBuf,
        #[arg(long)]
        name: Option<String>,
        #[arg(long, default_value = "origin")]
        remote: String,
        #[arg(long)]
        default_branch: Option<String>,
        #[arg(long)]
        workspace_parent: Option<PathBuf>,
    },
    List,
    Doctor {
        name: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum WorkspaceCommand {
    Create {
        repository: String,
        #[arg(long)]
        name: String,
        #[arg(long)]
        branch: String,
        #[arg(long)]
        base: Option<String>,
    },
    List,
    Archive {
        name: String,
    },
}

#[derive(Debug, Subcommand)]
enum SessionCommand {
    Start {
        workspace: String,
        #[arg(long, value_enum, default_value_t = CliSessionKind::Shell)]
        kind: CliSessionKind,
    },
    Stop {
        workspace: String,
    },
}

#[derive(Debug, Subcommand)]
enum PrCommand {
    Create {
        workspace: String,
        #[arg(long)]
        title: Option<String>,
        #[arg(long)]
        body: Option<String>,
        #[arg(long)]
        draft: bool,
    },
    Checks {
        workspace: String,
    },
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum CliSessionKind {
    Shell,
    Codex,
    Claude,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let paths = AppPaths::from_env();

    match cli.command {
        Command::Doctor => print_doctor(doctor::report_from_host()),
        Command::Repo { command } => {
            let store = RepositoryStore::open(paths.database_path)?;
            match command {
                RepoCommand::Add {
                    path,
                    name,
                    remote,
                    default_branch,
                    workspace_parent,
                } => {
                    let repo = store.add(AddRepository {
                        name,
                        root_path: path,
                        default_branch,
                        remote_name: remote,
                        workspace_parent_path: workspace_parent,
                    })?;
                    println!(
                        "Added {} at {} (default branch: {}, workspace parent: {})",
                        repo.name,
                        repo.root_path.display(),
                        repo.default_branch,
                        repo.workspace_parent_path.display()
                    );
                }
                RepoCommand::List => {
                    for repo in store.list()? {
                        println!(
                            "{}\t{}\t{}\t{}",
                            repo.name,
                            repo.root_path.display(),
                            repo.remote_name,
                            repo.default_branch
                        );
                    }
                }
                RepoCommand::Doctor { name: _ } => {
                    print_doctor(doctor::report_from_host());
                }
            }
        }
        Command::Workspace { command } => {
            let store = WorkspaceStore::open(paths.database_path)?;
            match command {
                WorkspaceCommand::Create {
                    repository,
                    name,
                    branch,
                    base,
                } => {
                    let workspace = store.create(CreateWorkspace {
                        repository_name: repository,
                        name,
                        branch,
                        base_ref: base,
                    })?;
                    println!(
                        "Created {} at {} (branch: {}, base: {}, port: {})",
                        workspace.name,
                        workspace.path.display(),
                        workspace.branch,
                        workspace.base_ref,
                        workspace.port_base
                    );
                }
                WorkspaceCommand::List => {
                    for workspace in store.list()? {
                        println!(
                            "{}\t{}\t{}\t{}\t{}\t{}",
                            workspace.name,
                            workspace.path.display(),
                            workspace.branch,
                            workspace.base_ref,
                            workspace.port_base,
                            workspace.status
                        );
                    }
                }
                WorkspaceCommand::Archive { name } => {
                    let workspace = store.archive(&name)?;
                    println!(
                        "Archived {} at {}",
                        workspace.name,
                        workspace.path.display()
                    );
                }
            }
        }
        Command::Run { workspace } => {
            let store = WorkspaceStore::open_with_logs(paths.database_path, paths.logs_dir)?;
            let process = store.run_workspace(&workspace)?;
            println!(
                "Started run for {} as pid {} (log: {})",
                workspace,
                process.pid,
                process.log_path.display()
            );
        }
        Command::Stop { workspace } => {
            let store = WorkspaceStore::open_with_logs(paths.database_path, paths.logs_dir)?;
            let process = store.stop_workspace(&workspace)?;
            println!("Stopped run for {} (pid {})", workspace, process.pid);
        }
        Command::Logs {
            workspace,
            run,
            session,
        } => {
            if run == session {
                anyhow::bail!(
                    "choose exactly one log stream, for example: linux-conductor logs {workspace} --run"
                );
            }
            let store = WorkspaceStore::open_with_logs(paths.database_path, paths.logs_dir)?;
            if run {
                print!("{}", store.read_latest_run_log(&workspace)?);
            } else {
                print!("{}", store.read_latest_session_log(&workspace)?);
            }
        }
        Command::Diff {
            workspace,
            name_only,
            file,
        } => {
            let store = WorkspaceStore::open_with_logs(paths.database_path, paths.logs_dir)?;
            if name_only {
                for path in store.changed_files(&workspace)? {
                    println!("{path}");
                }
            } else {
                print!("{}", store.unified_diff(&workspace, file.as_deref())?);
            }
        }
        Command::Pr { command } => {
            let store = WorkspaceStore::open_with_logs(paths.database_path, paths.logs_dir)?;
            match command {
                PrCommand::Create {
                    workspace,
                    title,
                    body,
                    draft,
                } => {
                    store.push_branch(&workspace)?;
                    print!(
                        "{}",
                        store.create_pull_request(
                            &workspace,
                            title.as_deref(),
                            body.as_deref(),
                            draft
                        )?
                    );
                }
                PrCommand::Checks { workspace } => {
                    print!("{}", store.pull_request_checks(&workspace)?);
                }
            }
        }
        Command::Session { command } => {
            let store = WorkspaceStore::open_with_logs(paths.database_path, paths.logs_dir)?;
            match command {
                SessionCommand::Start { workspace, kind } => {
                    let process = store.start_session(&workspace, kind.into())?;
                    println!(
                        "Started session for {} as pid {} (log: {})",
                        workspace,
                        process.pid,
                        process.log_path.display()
                    );
                }
                SessionCommand::Stop { workspace } => {
                    let process = store.stop_session(&workspace)?;
                    println!("Stopped session for {} (pid {})", workspace, process.pid);
                }
            }
        }
    }

    Ok(())
}

impl From<CliSessionKind> for SessionKind {
    fn from(value: CliSessionKind) -> Self {
        match value {
            CliSessionKind::Shell => Self::Shell,
            CliSessionKind::Codex => Self::Codex,
            CliSessionKind::Claude => Self::Claude,
        }
    }
}

fn print_doctor(report: doctor::DoctorReport) {
    let distro = report.distro_id.as_deref().unwrap_or("unknown");
    println!("Distro: {distro}");

    if let Some(command) = report.install_command {
        println!("Install required tools: {command}");
    } else {
        println!(
            "Install required tools: see your distro packages for git, gh, sqlite, and openssh"
        );
    }

    for dependency in report.dependencies {
        let required = if dependency.required {
            "required"
        } else {
            "optional"
        };
        let status = if dependency.installed {
            "ok"
        } else {
            "missing"
        };
        println!("{:<8} {:<8} {}", dependency.name, required, status);
    }
}
