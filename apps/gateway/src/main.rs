//! Command-line entry point. Configuration comes from the environment, plus
//! an optional `.env` file next to the binary's working directory.

use orya_halo_gateway::config::{Config, MockConfig};

const HELP: &str = "\
Orya Halo gateway

Usage: orya-halo-gateway [--mock[=aircraft:N,ships:N]] [--help] [--version]

  --mock      Serve synthetic traffic and make no upstream requests.
              Same as MOCK=aircraft:20000,ships:50000.

Everything else is configured through environment variables, which may be put
in a .env file in the working directory. See .env.example for the full list.
";

fn main() {
    // A .env file is a convenience for local runs; real deployments set the environment.
    let dotenv = dotenvy::dotenv();

    let mut mock_flag: Option<MockConfig> = None;
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--help" | "-h" => {
                print!("{HELP}");
                return;
            }
            "--version" | "-V" => {
                println!("orya-halo-gateway {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "--mock" => mock_flag = Some(MockConfig::DEFAULT),
            other => match other.strip_prefix("--mock=").map(MockConfig::parse) {
                Some(Ok(mock)) => mock_flag = Some(mock),
                Some(Err(message)) => fail(&message),
                None => fail(&format!("Unknown argument \"{other}\". Try --help.")),
            },
        }
    }

    let mut config = match Config::from_env() {
        Ok(config) => config,
        Err(message) => fail(&format!("Configuration problem: {message}")),
    };
    if mock_flag.is_some() {
        config.mock = mock_flag;
    }

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    if config.log_json {
        tracing_subscriber::fmt().with_env_filter(filter).json().init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
    if let Ok(path) = dotenv {
        tracing::info!(path = %path.display(), "loaded .env");
    }

    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let outcome = runtime.block_on(async {
        let gateway = orya_halo_gateway::start(config).await?;
        wait_for_signal().await;
        tracing::info!("shutting down");
        gateway.stop().await;
        anyhow::Ok(())
    });
    if let Err(e) = outcome {
        fail(&format!("The gateway could not start: {e:#}"));
    }
}

fn fail(message: &str) -> ! {
    eprintln!("{message}");
    std::process::exit(2);
}

/// Resolve on Ctrl-C, or SIGTERM where there is one (what container platforms send).
async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
