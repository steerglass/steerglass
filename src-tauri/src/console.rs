//! Windows: a hidden console for the credential plugins.
//!
//! Steerglass is a GUI app, so it has no console. Every console program it starts (`kubelogin`,
//! `gke-gcloud-auth-plugin`, `gcloud.cmd`…) then gets a console of its own, and with it a window (a
//! Windows Terminal tab when that is the default terminal) that flashes open and shut on every token
//! refresh. Hiding only the plugin isn't enough: `gke-gcloud-auth-plugin` runs `gcloud.cmd`, which gets
//! a window of its own again. So the app holds one console with no window, and every program it starts,
//! and every program those start, shares it.

/// Gives the process a console without a window. False when that isn't possible.
#[cfg(windows)]
pub fn attach_hidden() -> bool {
    imp::attach_hidden()
}

#[cfg(not(windows))]
pub fn attach_hidden() -> bool {
    false
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const ALLOC_CONSOLE_MODE_NO_WINDOW: i32 = 2;

    #[repr(C)]
    struct AllocConsoleOptions {
        mode: i32,
        use_show_window: i32,
        show_window: u16,
    }

    type AllocConsoleWithOptions = unsafe extern "system" fn(*const AllocConsoleOptions, *mut i32) -> i32;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetConsoleWindow() -> *mut c_void;
        fn AttachConsole(pid: u32) -> i32;
        fn GetModuleHandleW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
    }

    pub fn attach_hidden() -> bool {
        // Started from a terminal: there is a console already, and it is the user's.
        if !unsafe { GetConsoleWindow() }.is_null() {
            return true;
        }
        alloc_without_window() || attach_to_windowless_helper()
    }

    /// Windows 11 24H2 and later can create a console with no window directly.
    fn alloc_without_window() -> bool {
        let kernel32: Vec<u16> = "kernel32.dll\0".encode_utf16().collect();
        unsafe {
            let module = GetModuleHandleW(kernel32.as_ptr());
            if module.is_null() {
                return false;
            }
            let proc = GetProcAddress(module, c"AllocConsoleWithOptions".as_ptr().cast());
            if proc.is_null() {
                return false;
            }
            let alloc: AllocConsoleWithOptions = std::mem::transmute(proc);
            let options = AllocConsoleOptions { mode: ALLOC_CONSOLE_MODE_NO_WINDOW, use_show_window: 0, show_window: 0 };
            let mut result = 0;
            alloc(&options, &mut result) >= 0
        }
    }

    /// Older Windows: start a console program with no window and join its console. The helper can go
    /// once we are attached: a console lives as long as a process uses it.
    fn attach_to_windowless_helper() -> bool {
        let Ok(mut helper) = Command::new("cmd.exe")
            .args(["/d", "/q", "/k"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
        else {
            return false;
        };
        let mut attached = false;
        // The console exists only once the helper has started.
        for _ in 0..40 {
            if unsafe { AttachConsole(helper.id()) } != 0 {
                attached = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = helper.kill();
        let _ = helper.wait();
        attached
    }
}
