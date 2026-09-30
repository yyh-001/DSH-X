#![cfg_attr(windows, windows_subsystem = "windows")]

// 网页只负责展示；文件复制、卸载登记、升级与回滚仍由原来的 Inno 引擎执行。
#[cfg(windows)]
mod installer {
    use serde_json::{json, Value};
    use std::{fs, path::{Path, PathBuf}, process::{Command, Stdio}, thread, time::{Duration, SystemTime, UNIX_EPOCH}};
    use std::os::windows::process::CommandExt;
    use tao::{dpi::LogicalSize, event::{Event, WindowEvent}, event_loop::{ControlFlow, EventLoopBuilder}, window::WindowBuilder};
    use wry::{WebContext, WebViewBuilder};
    include!(concat!(env!("OUT_DIR"), "/installer_payload.rs"));
    const NO_WINDOW: u32 = 0x08000000;
    const PAGE: &str = include_str!("../installer/index.html");
    const ICON: &[u8] = include_bytes!("../assets/icon.png");
    const UNINSTALL_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{8F3C2A91-6B47-4E1D-9C5A-2D8E0F4B7A16}_is1";

    #[link(name="kernel32")]
    extern "system" { fn GetUserDefaultUILanguage() -> u16; }
    #[link(name="user32")]
    extern "system" {
        fn SystemParametersInfoW(action: u32, param: u32, value: *mut i32, flags: u32) -> i32;
        fn MessageBoxW(wnd: isize, text: *const u16, caption: *const u16, flags: u32) -> i32;
    }
    #[link(name="advapi32")]
    extern "system" { fn RegGetValueW(key: isize, sub: *const u16, value: *const u16, flags: u32, kind: *mut u32, data: *mut u8, size: *mut u32) -> i32; }
    #[repr(C)]
    struct BrowseInfo { owner: isize, root: *const u8, display: *mut u16, title: *const u16, flags: u32, callback: usize, param: isize, image: i32 }
    #[link(name="shell32")]
    extern "system" {
        fn SHBrowseForFolderW(info: *const BrowseInfo) -> *mut u8;
        fn SHGetPathFromIDListW(id: *const u8, path: *mut u16) -> i32;
    }
    #[link(name="ole32")]
    extern "system" { fn CoTaskMemFree(memory: *mut std::ffi::c_void); }
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
    fn language() -> &'static str { if unsafe { GetUserDefaultUILanguage() } & 0x3ff == 4 { "zh-CN" } else { "en" } }
    fn reduced_motion() -> bool { let mut enabled = 0; unsafe { SystemParametersInfoW(0x1042, 0, &mut enabled, 0); } enabled == 0 }
    fn fatal(message: &str) { unsafe { MessageBoxW(0, wide(message).as_ptr(), wide("DSH-X").as_ptr(), 0x10); } }
    fn default_dir() -> PathBuf {
        // 使用与 Inno 相同的卸载项，升级用户不会被悄悄改回默认目录。
        for key in [-2147483647isize, -2147483646isize] {
            for view in [0x10000, 0x20000] {
                let mut buffer = [0u16; 32768]; let mut size = (buffer.len() * 2) as u32;
                let ok = unsafe { RegGetValueW(key, wide(UNINSTALL_KEY).as_ptr(), wide("InstallLocation").as_ptr(), 2 | view, std::ptr::null_mut(), buffer.as_mut_ptr().cast(), &mut size) };
                if ok == 0 { let end = buffer.iter().position(|x| *x == 0).unwrap_or(buffer.len()); let path = PathBuf::from(String::from_utf16_lossy(&buffer[..end])); if path.is_absolute() { return path; } }
            }
        }
        PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("Programs").join("DSH")
    }
    fn folder(owner: isize) -> Option<String> {
        let mut name = [0u16; 260]; let mut path = [0u16; 260]; let title = wide(if language().starts_with("zh") { "选择 DSH-X 安装目录" } else { "Choose installation folder" });
        let info = BrowseInfo { owner, root: std::ptr::null(), display: name.as_mut_ptr(), title: title.as_ptr(), flags: 0x41, callback: 0, param: 0, image: 0 };
        unsafe { let id = SHBrowseForFolderW(&info); if id.is_null() { return None; } let ok = SHGetPathFromIDListW(id, path.as_mut_ptr()); CoTaskMemFree(id.cast()); if ok == 0 { return None; } }
        Some(String::from_utf16_lossy(&path[..path.iter().position(|v| *v == 0).unwrap_or(path.len())]))
    }
    fn base64(bytes: &[u8]) -> String {
        const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for part in bytes.chunks(3) { let n = ((part[0] as u32) << 16) | ((part.get(1).copied().unwrap_or(0) as u32) << 8) | part.get(2).copied().unwrap_or(0) as u32; out.push(ABC[(n >> 18) as usize] as char); out.push(ABC[((n >> 12) & 63) as usize] as char); out.push(if part.len() > 1 { ABC[((n >> 6) & 63) as usize] as char } else { '=' }); out.push(if part.len() > 2 { ABC[(n & 63) as usize] as char } else { '=' }); }
        out
    }
    fn validate_dir(value: &str) -> Result<PathBuf, String> {
        let path = PathBuf::from(value.trim());
        if !path.is_absolute() || path.parent().is_none() || value.chars().any(|c| c == '"' || c.is_control()) { return Err(if language().starts_with("zh") { "请选择完整的安装目录，不能使用磁盘根目录。" } else { "Choose a full installation folder, not a drive root." }.into()); }
        Ok(path)
    }
    fn private_dir() -> std::io::Result<PathBuf> {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
        let dir = std::env::temp_dir().join(format!("dsh-x-installer-{}-{stamp}", std::process::id())); fs::create_dir(&dir)?; Ok(dir)
    }
    /// 解析桥接进度文件：`阶段:百分比`（preparing/files/finishing/cleaning，见 installer-engine.iss）。
    /// 老引擎只写纯百分号 → 归到 files；认不得的阶段也回落 files；写坏了返回 None（保持上一格）。
    fn parse_progress(text: &str) -> Option<(String, u32)> {
        let text = text.trim();
        let (stage, value) = match text.split_once(':') { Some((stage, value)) => (stage.trim(), value.trim()), None => ("files", text) };
        let percent = value.parse::<u32>().ok()?.min(100);
        let stage = match stage { "preparing" | "files" | "finishing" | "cleaning" => stage, _ => "files" };
        Some((stage.to_string(), percent))
    }
    fn engine_args(dir: Option<&Path>, desktop: bool, work: &Path) -> Vec<String> {
        let mut args = vec!["/VERYSILENT".into(), "/SUPPRESSMSGBOXES".into(), "/NORESTART".into(), "/SP-".into(), "/WEBUI=1".into(), format!("/STATUSFILE={}", work.join("progress.txt").display()), format!("/RESULTFILE={}", work.join("directory.txt").display()), format!("/LOG={}", work.join("install.log").display())];
        if let Some(dir) = dir { args.push(format!("/DIR={}", dir.display())); args.push(if desktop { "/TASKS=desktopicon".into() } else { "/TASKS=".into() }); }
        args
    }
    fn installed_dir(work: &Path) -> Option<PathBuf> { fs::read_to_string(work.join("directory.txt")).ok().map(|s| PathBuf::from(s.trim_start_matches('\u{feff}').trim())).filter(|p| p.is_absolute()) }
    fn launch_app(dir: &Path) -> std::io::Result<()> { Command::new(dir.join("DSH.exe")).current_dir(dir).spawn().map(|_| ()) }
    fn cleanup_after_exit(dir: &Path, work: &Path, delete_installer: bool) {
        // 使用已安装的 Node 以独立 argv 传路径；不把用户目录拼进 shell 命令。
        let script = "const fs=require('node:fs');const [exe,work]=process.argv.slice(1);let tries=0;const timer=setInterval(()=>{try{if(exe&&fs.existsSync(exe))fs.unlinkSync(exe);fs.rmSync(work,{recursive:true,force:true});clearInterval(timer)}catch{if(++tries>30)clearInterval(timer)}},1000);";
        let original = if delete_installer { std::env::current_exe().ok().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default() } else { String::new() };
        let _ = Command::new(dir.join("node/node.exe")).args(["-e", script, &original, &work.to_string_lossy()]).creation_flags(NO_WINDOW).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
    }
    #[derive(Debug)]
    enum UiEvent { Message(Value), Progress(String, u32), Finished(i32), Error(String) }

    pub fn run() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let preview = args.iter().any(|s| s == "--preview");
        if !preview && PAYLOAD.is_empty() { fatal("此构建只用于界面预览，请使用 --preview；正式安装包需要内嵌安装引擎。"); return; }
        let work = match private_dir() { Ok(v) => v, Err(e) => { fatal(&e.to_string()); return; } };
        let engine = work.join("DSH-Install-Engine.exe");
        if !preview { if let Err(e) = fs::write(&engine, PAYLOAD) { fatal(&e.to_string()); return; } }
        // 自动更新和命令行静默安装不初始化 WebView，退出码与安装器保持一致。
        let silent = args.iter().any(|a| ["/silent", "/verysilent"].contains(&a.to_ascii_lowercase().as_str()));
        if silent && !preview {
            let bridge = engine_args(None, true, &work);
            let result = Command::new(&engine).args(&bridge).args(&args).creation_flags(NO_WINDOW).status();
            let code = result.map(|s| s.code().unwrap_or(1)).unwrap_or(1);
            if code == 0 || code == 3010 { if let Some(dir) = installed_dir(&work) { let _ = launch_app(&dir); cleanup_after_exit(&dir, &work, true); } }
            std::process::exit(code);
        }
        let event_loop = EventLoopBuilder::<UiEvent>::with_user_event().build();
        let window = match WindowBuilder::new().with_title(if preview { "DSH-X · 网页安装界面预览" } else { "DSH-X" }).with_decorations(false).with_resizable(false).with_inner_size(LogicalSize::new(780.0, 550.0)).build(&event_loop) { Ok(v) => v, Err(e) => { fatal(&e.to_string()); return; } };
        let proxy = event_loop.create_proxy(); let ipc = proxy.clone();
        let mut context = WebContext::new(Some(work.join("webview")));
        let view = WebViewBuilder::new_with_web_context(&mut context).with_url("about:blank")
            .with_ipc_handler(move |request| { if let Ok(v) = serde_json::from_str::<Value>(request.body()) { let _ = ipc.send_event(UiEvent::Message(v)); } })
            .with_navigation_handler(|url| url == "about:blank" || url.starts_with("data:text/html"))
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny).build(&window);
        let view = match view { Ok(v) => v, Err(e) => { if !preview { let _ = Command::new(&engine).args(&args).status(); } else { fatal(&format!("WebView2: {e}")); } return; } };
        let version: Value = serde_json::from_str(include_str!("../package.json")).unwrap_or_default();
        let config = json!({"preview":preview,"language":language(),"version":version["version"],"path":default_dir(),"reducedMotion":reduced_motion()});
        // 所有 HTML、脚本和素材内嵌；安装页不监听端口、不从网络加载代码。
        let page = PAGE.replace("__MASCOT__", &format!("data:image/png;base64,{}", base64(ICON)))
            .replace("<script>", &format!("<script>window.__INSTALLER__={};", config.to_string().replace('<', "\\u003c")));
        let mut loaded = false; let mut busy = false; let mut success = false; let mut destination = default_dir();
        event_loop.run(move |event, _, flow| {
            *flow = ControlFlow::Wait;
            let emit = |value: Value| { let _ = view.evaluate_script(&format!("window.installerEvent({})", value.to_string().replace('<', "\\u003c"))); };
            match event {
                Event::NewEvents(tao::event::StartCause::Init) if !loaded => { loaded = true; if let Err(e) = view.load_html(&page) { fatal(&e.to_string()); *flow = ControlFlow::Exit; } }
                Event::UserEvent(UiEvent::Message(message)) => match message["action"].as_str().unwrap_or("") {
                    "drag" => { let _ = window.drag_window(); }
                    "minimize" => window.set_minimized(true),
                    "close" => { if busy { emit(json!({"type":"close-request"})); } else { if success && !preview { cleanup_after_exit(&destination, &work, false); } *flow = ControlFlow::Exit; } }
                    "browse" if !busy && !success => {
                        use tao::platform::windows::WindowExtWindows;
                        if let Some(path) = folder(window.hwnd() as isize) { emit(json!({"type":"path","path":path})); }
                    }
                    "install" if !busy && !success && !preview => {
                        match validate_dir(message["path"].as_str().unwrap_or("")) {
                            Err(error) => emit(json!({"type":"error","message":error})),
                            Ok(dir) => {
                                busy = true; destination = dir.clone(); let work = work.clone(); let engine = engine.clone(); let proxy = proxy.clone(); let desktop = message["desktop"].as_bool().unwrap_or(true);
                                thread::spawn(move || {
                                    // 重试前清掉上一次的进度/结果，避免把旧成功误认为本次成功。
                                    let _ = fs::remove_file(work.join("progress.txt")); let _ = fs::remove_file(work.join("directory.txt"));
                                    let result = Command::new(engine).args(engine_args(Some(&dir), desktop, &work)).creation_flags(NO_WINDOW).spawn();
                                    match result {
                                        Err(e) => { let _ = proxy.send_event(UiEvent::Error(e.to_string())); }
                                        Ok(mut child) => { let mut last: (String, u32) = (String::new(), 101); loop {
                                            if let Ok(raw) = fs::read_to_string(work.join("progress.txt")) { if let Some((stage, p)) = parse_progress(&raw) { if (stage.clone(), p) != last { last = (stage.clone(), p); let _ = proxy.send_event(UiEvent::Progress(stage, p)); } } }
                                            match child.try_wait() { Ok(Some(status)) => { let _ = proxy.send_event(UiEvent::Finished(status.code().unwrap_or(1))); break; } Err(e) => { let _ = proxy.send_event(UiEvent::Error(e.to_string())); break; } _ => thread::sleep(Duration::from_millis(120)) }
                                        } }
                                    }
                                });
                            }
                        }
                    }
                    "finish" if preview => { *flow = ControlFlow::Exit; }
                    "finish" if success => {
                        if message["launch"].as_bool().unwrap_or(true) { if let Err(e) = launch_app(&destination) { emit(json!({"type":"error","message":e.to_string()})); return; } }
                        cleanup_after_exit(&destination, &work, message["deleteInstaller"].as_bool().unwrap_or(false)); *flow = ControlFlow::Exit;
                    }
                    _ => {}
                },
                Event::UserEvent(UiEvent::Progress(stage, percent)) => emit(json!({"type":"progress","stage":stage,"percent":percent})),
                Event::UserEvent(UiEvent::Finished(code)) => {
                    busy = false;
                    if (code == 0 || code == 3010) && installed_dir(&work).is_some() { success = true; destination = installed_dir(&work).unwrap(); emit(json!({"type":"done","reboot":code == 3010})); }
                    else { emit(json!({"type":"error","message":format!("{} ({code})\n{}", if language().starts_with("zh") {"安装未完成，详情见日志"} else {"Setup did not finish. See log"}, work.join("install.log").display())})); }
                }
                Event::UserEvent(UiEvent::Error(message)) => { busy = false; emit(json!({"type":"error","message":message})); }
                Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => { if busy { emit(json!({"type":"close-request"})); } else { if success && !preview { cleanup_after_exit(&destination, &work, false); } *flow = ControlFlow::Exit; } }
                _ => {}
            }
        });
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test] fn base64_matches_vectors() { assert_eq!(base64(b""), ""); assert_eq!(base64(b"f"), "Zg=="); assert_eq!(base64(b"fo"), "Zm8="); assert_eq!(base64(b"foo"), "Zm9v"); }
        #[test] fn reject_unsafe_install_paths() { for path in ["", "relative", "C:\\", "C:\\bad\"path", "C:\\bad\npath"] { assert!(validate_dir(path).is_err(), "{path:?}"); } assert!(validate_dir("C:\\用户\\DSH X").is_ok()); }
        #[test] fn parse_progress_accepts_stages_and_bare_percent() {
            assert_eq!(parse_progress("files:56"), Some(("files".to_string(), 56)));
            assert_eq!(parse_progress("preparing:0"), Some(("preparing".to_string(), 0)));
            assert_eq!(parse_progress("finishing:100"), Some(("finishing".to_string(), 100)));
            assert_eq!(parse_progress("56"), Some(("files".to_string(), 56)), "老引擎只写纯数字");
            assert_eq!(parse_progress("weird:12"), Some(("files".to_string(), 12)), "认不得的阶段回落 files");
            assert_eq!(parse_progress("files:120"), Some(("files".to_string(), 100)), "封顶 100");
            assert_eq!(parse_progress(""), None);
            assert_eq!(parse_progress("files:abc"), None);
        }
        #[test] fn engine_paths_stay_single_arguments() { let dir = Path::new("C:\\中文 目录\\DSH"); let args = engine_args(Some(dir), false, Path::new("C:\\Temp\\a b")); assert!(args.contains(&"/DIR=C:\\中文 目录\\DSH".into())); assert!(args.contains(&"/TASKS=".into())); assert!(args.contains(&"/WEBUI=1".into())); }
    }
}
#[cfg(windows)] fn main() { installer::run(); }
#[cfg(not(windows))] fn main() { eprintln!("Windows installer only"); }
