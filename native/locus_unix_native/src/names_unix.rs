//! POSIX names for the Locus broker objects.
//!
//! The Windows broker serves `\\.\pipe\locus_unity_native_<project key>` and
//! publishes into `Local\LocusNativeBrokerState_<project key>`. A Unix host has
//! no kernel namespace that maps project paths to names, and `/tmp` collisions
//! between several checkouts are a real hazard, so both objects are derived
//! from the same project key:
//!
//! * endpoint: `<runtime dir>/locus/locus_unity_native_<key>.sock`
//! * state plane: `<runtime dir>/locus/LocusNativeBrokerState_<key>.shm`
//!
//! `<runtime dir>` is `$XDG_RUNTIME_DIR` when set (per-login, mode 0700), else
//! `$TMPDIR`, else `/tmp`. The socket lives inside a per-user directory so one
//! account cannot open another's broker.
//!
//! Clients (the desktop app, the DSH plugin) learn the exact path from the
//! Unity-side marker file `Library/Locus/NativeBridge.enabled`, whose first line
//! the Windows plugin already uses for its pipe name. The plugin writes the
//! absolute socket path there, so both ends agree byte for byte.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use locus_native_protocol::names;

/// Directory holding every Locus runtime object of this login session.
///
/// `$XDG_RUNTIME_DIR/locus`, else `$TMPDIR/locus`, else `/tmp/locus` — the first
/// one that exists or can be created **and written**. The selection happens
/// once per process: a broker that cannot create its preferred directory must
/// fall back instead of disabling the transport (sandboxes, CI containers and
/// read-only `/run` are all real cases).
pub fn runtime_root() -> PathBuf {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let candidates = [
            std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from),
            std::env::var_os("TMPDIR").map(PathBuf::from),
            Some(PathBuf::from("/tmp")),
        ];
        for base in candidates.into_iter().flatten() {
            let dir = base.join("locus");
            if std::fs::create_dir_all(&dir).is_err() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
            }
            let probe = dir.join(format!(".probe-{}", std::process::id()));
            if std::fs::write(&probe, b"").is_ok() {
                let _ = std::fs::remove_file(&probe);
                return dir;
            }
        }
        // Nothing writable: keep the conventional path so error messages name
        // the place the broker tried, and let the server report the failure.
        PathBuf::from("/tmp/locus")
    })
        .clone()
}

/// Absolute socket path for one Unity project.
pub fn unity_socket_path(project_path: &str) -> PathBuf {
    runtime_root().join(format!(
        "locus_unity_native_{}.sock",
        names::project_key(project_path)
    ))
}

/// Absolute state-plane path for one Unity project.
pub fn unity_state_plane_path(project_path: &str) -> PathBuf {
    runtime_root().join(format!(
        "LocusNativeBrokerState_{}.shm",
        names::project_key(project_path)
    ))
}

/// The `unity_state_plane_name` the Windows build uses, mapped onto a path.
///
/// `locus_init` hands the broker a state-plane *name* (`Local\LocusNativeBrokerState_<key>`);
/// on Unix any name that is already absolute is used verbatim, otherwise the
/// value is treated as a key and resolved under [`runtime_root`].
pub fn resolve_state_plane_path(state_plane_name: &str) -> PathBuf {
    let name = state_plane_name.trim();
    if name.is_empty() {
        return PathBuf::new();
    }
    if name.starts_with('/') {
        return PathBuf::from(name);
    }
    // `Local\LocusNativeBrokerState_<key>` (or any bare object name).
    let tail = name.rsplit(['\\', '/']).next().unwrap_or(name);
    runtime_root().join(format!("{tail}.shm"))
}

/// Create the directory that holds `socket_path` (mode 0700).
pub fn ensure_socket_dir(socket_path: &Path) -> std::io::Result<()> {
    let Some(parent) = socket_path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_paths_are_absolute_and_per_project() {
        let a = unity_socket_path("F:/Projects/Game");
        let b = unity_socket_path(r"f:\projects\game");
        assert_eq!(a, b, "the project key normalization is shared with Windows");
        assert!(a.is_absolute());
        assert!(a.to_string_lossy().ends_with(".sock"));
        assert_ne!(a, unity_socket_path("F:/Projects/Other"));
    }

    #[test]
    fn state_plane_names_resolve_to_paths() {
        let resolved = resolve_state_plane_path(r"Local\LocusNativeBrokerState_abc");
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with("LocusNativeBrokerState_abc.shm"));
        assert_eq!(
            resolve_state_plane_path("/run/user/1000/locus/x.shm"),
            PathBuf::from("/run/user/1000/locus/x.shm")
        );
        assert!(resolve_state_plane_path("").as_os_str().is_empty());
    }
}
