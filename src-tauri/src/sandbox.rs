//! Helpers for running inside the macOS App Sandbox (Mac App Store build).
//!
//! Inside the sandbox `$HOME` points at the app container, and files outside it are only readable
//! after the user picks them in an open panel. Security-scoped bookmarks let us keep that access
//! across launches.

use std::path::PathBuf;

/// The user's real home directory, even inside the sandbox where `$HOME` is redirected.
pub fn real_home() -> Option<PathBuf> {
    #[cfg(unix)]
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if !pw.is_null() && !(*pw).pw_dir.is_null() {
            let dir = std::ffi::CStr::from_ptr((*pw).pw_dir).to_string_lossy().into_owned();
            if !dir.is_empty() {
                return Some(PathBuf::from(dir));
            }
        }
    }
    dirs::home_dir()
}

pub fn is_sandboxed() -> bool {
    std::env::var_os("APP_SANDBOX_CONTAINER_ID").is_some()
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::runtime::Bool;
    use objc2_foundation::{NSData, NSString, NSURL, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions};

    pub fn create(path: &str) -> Result<Vec<u8>, String> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::WithSecurityScope,
            None,
            None,
        )
        .map(|d| d.to_vec())
        .map_err(|e| e.localizedDescription().to_string())
    }

    /// Resolves a bookmark and starts accessing it for the lifetime of the process.
    pub fn activate(data: &[u8]) -> Option<String> {
        let data = NSData::with_bytes(data);
        let mut stale = Bool::NO;
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                NSURLBookmarkResolutionOptions::WithSecurityScope,
                None,
                &mut stale,
            )
        }
        .ok()?;
        if !unsafe { url.startAccessingSecurityScopedResource() } {
            return None;
        }
        url.path().map(|p| p.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub fn create(_path: &str) -> Result<Vec<u8>, String> {
        Ok(Vec::new())
    }
    pub fn activate(_data: &[u8]) -> Option<String> {
        None
    }
}

pub use imp::{activate, create};

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn bookmark_roundtrip() {
        let dir = std::env::temp_dir().join(format!("kc-bookmark-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("config");
        std::fs::write(&file, "x").unwrap();
        let data = super::create(file.to_str().unwrap()).expect("create bookmark");
        assert!(!data.is_empty());
        let resolved = super::activate(&data).expect("resolve bookmark");
        assert!(resolved.ends_with("/config"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn real_home_is_absolute() {
        assert!(super::real_home().unwrap().is_absolute());
    }
}
