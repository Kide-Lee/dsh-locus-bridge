//! POSIX shared-memory state plane.
//!
//! Byte-for-byte the layout of `locus-native-protocol/src/state_plane.rs`, so a
//! reader that understands the Windows mapping (the desktop app) can also read
//! the Unix file mapping. `shm_open` + `ftruncate` + `mmap(MAP_SHARED)` replaces
//! `CreateFileMappingW` + `MapViewOfFile`; the region is unlinked on shutdown.

use std::ffi::CString;
use std::path::{Path, PathBuf};

use locus_native_protocol::state_plane as layout;

pub(crate) struct StatePlane {
    view: *mut u8,
    total_size: usize,
    /// The filesystem path behind the shared object (for diagnostics + unlink).
    path: PathBuf,
}

unsafe impl Send for StatePlane {}

impl StatePlane {
    /// Create or reuse the plane at `path`. `None` disables the plane (the
    /// broker keeps working; only the shared-memory status shortcut is gone).
    pub(crate) fn create(path: &Path) -> Option<Self> {
        if path.as_os_str().is_empty() {
            return None;
        }
        let total_size = layout::total_size();
        let name = CString::new(path.to_string_lossy().as_bytes()).ok()?;

        // SAFETY: `name` is a valid NUL-terminated path; the returned fd is
        // checked before use.
        let fd = unsafe { libc::open(name.as_ptr(), libc::O_CREAT | libc::O_RDWR | libc::O_CLOEXEC, 0o600) };
        if fd < 0 {
            eprintln!(
                "[locus-native] failed to open state plane {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            );
            return None;
        }
        let view = unsafe {
            if libc::ftruncate(fd, total_size as libc::off_t) != 0 {
                let error = std::io::Error::last_os_error();
                libc::close(fd);
                eprintln!("[locus-native] failed to size state plane {}: {error}", path.display());
                return None;
            }
            let mapped = libc::mmap(
                std::ptr::null_mut(),
                total_size,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd,
                0,
            );
            libc::close(fd);
            if mapped == libc::MAP_FAILED {
                eprintln!(
                    "[locus-native] failed to map state plane {}: {}",
                    path.display(),
                    std::io::Error::last_os_error()
                );
                return None;
            }
            mapped as *mut u8
        };

        let mut plane = Self {
            view,
            total_size,
            path: path.to_path_buf(),
        };
        let now = crate::broker::now_ms().max(0) as u64;
        layout::write_header(plane.bytes_mut(), std::process::id(), now);
        Some(plane)
    }

    fn bytes_mut(&mut self) -> &mut [u8] {
        // Exclusively written by this broker; readers validate sequences around
        // every copy (torn-read safe), exactly like the Windows mapping.
        unsafe { std::slice::from_raw_parts_mut(self.view, self.total_size) }
    }

    pub(crate) fn write_json(&mut self, seq: u64, observed_at_ms: i64, json: &str) {
        let bytes = json.as_bytes();
        if bytes.is_empty() || bytes.len() > layout::MAX_PAYLOAD {
            eprintln!(
                "[locus-native] state plane payload too large: {} bytes (max {})",
                bytes.len(),
                layout::MAX_PAYLOAD
            );
            return;
        }
        let observed = observed_at_ms.max(0) as u64;
        layout::write_slot(self.bytes_mut(), seq.max(1), observed, layout::SOURCE_BROKER, bytes);
    }
}

impl Drop for StatePlane {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.view as *mut libc::c_void, self.total_size);
        }
        // The file is unlinked on shutdown so a stale mapping never outlives
        // the editor. Readers that already mapped it keep their snapshot.
        let _ = std::fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_status_payload() {
        let dir = std::env::temp_dir().join(format!("locus-plane-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("plane.shm");
        let mut plane = StatePlane::create(&path).expect("plane");
        plane.write_json(1, 42, r#"{"hostKind":"unity"}"#);
        let bytes = unsafe { std::slice::from_raw_parts(plane.view, plane.total_size) };
        let snapshot = layout::read_latest(bytes).expect("snapshot");
        assert_eq!(snapshot.payload, br#"{"hostKind":"unity"}"#);
        assert_eq!(snapshot.observed_at_ms, 42);
        drop(plane);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
