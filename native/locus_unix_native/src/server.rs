//! Unix domain socket server.
//!
//! Replaces the Win32 named pipe. One listener serves every connection; a new
//! connection is accepted immediately so several Locus clients (the desktop app
//! and the DSH plugin) can talk to one editor. Socket permissions are 0600 and
//! the directory is 0700, which reproduces the Windows "current user only" DACL.
//!
//! The socket path is removed on startup (a stale socket from a crashed editor
//! would otherwise block `bind`) and on shutdown.

use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::broker::{handle_line, Broker};
use crate::names_unix;

/// Remove a socket file that no live broker owns.
async fn clear_stale_socket(path: &str) {
    let path_ref = std::path::Path::new(path);
    if !path_ref.exists() {
        return;
    }
    // A reachable socket means another editor for the same project is running:
    // keep it (the second broker then fails to bind, exactly like the Windows
    // `first_pipe_instance` behaviour).
    if UnixStream::connect(path).await.is_ok() {
        return;
    }
    let _ = std::fs::remove_file(path_ref);
}

async fn serve_connection(broker: Arc<Broker>, stream: UnixStream) {
    let (read_half, mut write_half) = tokio::io::split(stream);
    let (client, outbox) = broker.register_client();
    eprintln!(
        "[locus-native] client {client} connected: {}",
        broker.config.socket_path
    );

    let writer_outbox = Arc::clone(&outbox);
    let writer = tokio::spawn(async move {
        while let Some(bytes) = writer_outbox.next().await {
            if std::env::var_os("LOCUS_BROKER_DEBUG").is_some() {
                eprintln!("[locus-native] debug: writing {} bytes to client {client}", bytes.len());
            }
            let written = write_half.write_all(&bytes).await.is_ok() && write_half.flush().await.is_ok();
            writer_outbox.written();
            if !written {
                eprintln!("[locus-native] client {client} write failed; closing");
                break;
            }
        }
    });

    let mut reader = BufReader::new(read_half);
    let mut buffer: Vec<u8> = Vec::with_capacity(4096);

    loop {
        buffer.clear();
        let read = tokio::select! {
            _ = broker.shutdown_notify.notified() => break,
            _ = outbox.closed() => break,
            result = reader.read_until(b'\n', &mut buffer) => result,
        };
        match read {
            Ok(0) => break,
            Ok(_) => handle_line(&broker, client, &buffer),
            Err(error) => {
                eprintln!("[locus-native] socket read error: {error}");
                break;
            }
        }
    }

    broker.unregister_client(client);
    writer.abort();
    let _ = writer.await;
    eprintln!(
        "[locus-native] client {client} disconnected: {}",
        broker.config.socket_path
    );
}

pub(crate) async fn broker_main(broker: Arc<Broker>) {
    let socket_path = broker.config.socket_path.clone();
    if let Err(error) = names_unix::ensure_socket_dir(std::path::Path::new(&socket_path)) {
        eprintln!("[locus-native] cannot create the socket directory: {error}");
        return;
    }
    clear_stale_socket(&socket_path).await;
    eprintln!("[locus-native] broker listening on {socket_path}");

    let listener = match UnixListener::bind(&socket_path) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("[locus-native] bind {socket_path} failed: {error}");
            return;
        }
    };
    let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));

    loop {
        if broker.shutdown.load(Ordering::SeqCst) {
            break;
        }
        tokio::select! {
            _ = broker.shutdown_notify.notified() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _address)) => {
                    tokio::spawn(serve_connection(Arc::clone(&broker), stream));
                }
                Err(error) => {
                    eprintln!("[locus-native] accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
        }
    }

    drop(listener);
    let _ = std::fs::remove_file(&socket_path);
    eprintln!("[locus-native] broker loop exited");
}
