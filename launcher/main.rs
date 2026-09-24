#![cfg_attr(windows, windows_subsystem = "windows")]

//! 启动器外壳：拉起 node 跑管理服务，再把这个管理页装进一个自己的窗口。
//! Windows 上是 DSH.exe（WebView2），macOS 上是 DSH-X.app 里的 Contents/MacOS/DSH（WKWebView）。
//!
//! 之所以要窗口而不是丢给系统浏览器：浏览器只允许脚本关闭「自己用 window.open 打开的」
//! 页面，所以系统浏览器里那个标签页谁也关不掉——托盘退出时只能指望页面自己 window.close()，
//! 关不掉还得退化成一张告别页。窗口是本进程创建的，收放就都是自己的事。
//!
//! 关窗口 ≠ 退出：托盘还在、dsh 照常跑；托盘点「打开管理页」时 start.js 会打 SHOW_PORT，
//! 把隐藏的窗口叫回来。

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(target_os = "macos")]
use tao::dpi::LogicalPosition;
use tao::dpi::{LogicalSize, PhysicalPosition};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder};
use tao::window::WindowBuilder;
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use wry::{WebContext, WebViewBuilder};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 每用户目录名（和 platform.js 的 APP_DIR_NAME 一致）：settings.json、webview 数据都在它下面。
const APP_DIR_NAME: &str = "DSH";
/// 自带运行时里 node 的文件名（和 platform.js 的 NODE_BINARY 一致）。
#[cfg(windows)]
const NODE_BINARY: &str = "node.exe";
#[cfg(target_os = "macos")]
const NODE_BINARY: &str = "node";
/// 管理页地址上的 window 参数：页面据此决定自己画窗口按钮（Windows）还是给系统红绿灯让位（macOS）。
#[cfg(windows)]
const WINDOW_QUERY: &str = "1";
#[cfg(target_os = "macos")]
const WINDOW_QUERY: &str = "mac";
/// 红绿灯的位置（逻辑像素，相对窗口左上角）：对齐页面顶栏的竖直中线，页面在左边让出了这块。
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_INSET: (f64, f64) = (18.0, 29.0);
/// 托盘图标边长：Windows 托盘只要 16/32；macOS 菜单栏按 18pt 显示，给 2 倍图才不糊。
#[cfg(windows)]
const TRAY_ICON_SIZE: u32 = 32;
#[cfg(target_os = "macos")]
const TRAY_ICON_SIZE: u32 = 36;
/// 管理页默认端口；设置页里可以改（存在每用户目录的 settings.json）。
const DEFAULT_PORT: u16 = 3780;
/// 等管理服务起来的时限；超了也照常开窗口，让页面自己显示连接失败。
const PORT_WAIT: Duration = Duration::from_secs(25);
/// 找管理页时最多往后扫这么多端口（和 server.js 的 PORT_SCAN 保持一致）。
const PORT_SCAN: u16 = 20;
/// 单个本机端口的探测不能拖住启动。Windows 防火墙有时会让一个未监听端口等约 2 秒才失败。
const PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(120);
const PROBE_IO_TIMEOUT: Duration = Duration::from_millis(180);
/// 顺延端口并行探测的总预算。超过这个时间就当作没有旧实例，继续创建窗口。
const PROBE_SCAN_BUDGET: Duration = Duration::from_millis(350);
/// 首次出现的窗口尺寸（逻辑像素）
const WINDOW_W: f64 = 1100.0;
const WINDOW_H: f64 = 760.0;
const WINDOW_MIN_W: f64 = 720.0;
const WINDOW_MIN_H: f64 = 520.0;
/// 启动失败那张错误页的窗口尺寸（逻辑像素）
const ERROR_W: f64 = 560.0;
const ERROR_H: f64 = 300.0;
/// node 往 stdout 打这一行，就表示它要我们把窗口叫到前面（见 start.js 的 requestShow）。
const SHOW_SIGNAL: &str = "__DSH_SHOW__";
/// 菜单项 id
const ITEM_OPEN_DSH: &str = "open-dsh";
const ITEM_TOGGLE: &str = "toggle";
const ITEM_RESTART: &str = "restart";
const ITEM_MANAGER: &str = "manager";
const ITEM_QUIT: &str = "quit";
/// macOS 应用菜单里的 ⌘W：和关窗口一样只是藏起来
#[cfg(target_os = "macos")]
const ITEM_CLOSE_WINDOW: &str = "close-window";

#[derive(Debug)]
enum UserEvent {
    Show,
    Exited,
    /// 以下几个来自页面：原生标题栏去掉了，最小化/最大化/关闭/拖动都由页面发过来
    Minimize,
    ToggleMaximize,
    Hide,
    Drag,
    /// 错误页上的「关闭」
    Quit,
    /// 轮询到的最新托盘状态
    Tray(TrayState),
}

/// 从 /api/tray 读回来的状态（纯文本 key=value，见 server.js）
#[derive(Debug, Default, Clone)]
struct TrayState {
    status: String,
    url: String,
    installed: bool,
    /// 界面语言（zh / en），由管理页的 /api/tray 带过来
    lang: String,
}

impl TrayState {
    fn live(&self) -> bool {
        self.status == "running" || self.status == "starting"
    }
}

fn parse_tray_state(text: &str) -> TrayState {
    let mut state = TrayState::default();
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim() {
            "status" => state.status = value.trim().to_string(),
            "url" => state.url = value.trim().to_string(),
            "installed" => state.installed = value.trim() == "1",
            "lang" => state.lang = value.trim().to_string(),
            _ => {}
        }
    }
    state
}

/// 原生托盘。菜单项句柄要留着——状态一变就得改文案和可用性。
struct Tray {
    _icon: TrayIcon,
    open_dsh: MenuItem,
    toggle: MenuItem,
    restart: MenuItem,
    manager: MenuItem,
    quit: MenuItem,
}

impl Tray {
    fn sync(&self, state: &TrayState) {
        let live = state.live();
        let en = state.lang == "en";
        // 文案跟着界面语言走（安装时选的语言，设置页也能改）
        self.open_dsh.set_text(if en { "Open dsh" } else { "打开 DSH" });
        self.restart.set_text(if en { "Restart dsh" } else { "重启 DSH" });
        self.manager.set_text(if en { "Open manager" } else { "打开管理页" });
        self.quit.set_text(if en { "Quit" } else { "退出" });
        self.open_dsh.set_enabled(!state.url.is_empty());
        self.toggle.set_text(if live {
            if en { "Stop" } else { "停止" }
        } else if en {
            "Start"
        } else {
            "启动"
        });
        self.toggle.set_enabled(state.installed && state.status != "stopping");
        self.restart.set_enabled(state.status == "running");
    }
}

/// 托盘图标用不了 256 那帧（托盘只要 TRAY_ICON_SIZE），从大图缩下去。
fn load_tray_icon(root: &Path) -> Option<tray_icon::Icon> {
    let bytes = std::fs::read(root.join("assets").join("tray.ico")).ok()?;
    let (rgba, width, height) = decode_ico(&bytes)?;
    let source = image::RgbaImage::from_raw(width, height, rgba)?;
    let size = TRAY_ICON_SIZE;
    let scaled = image::imageops::resize(&source, size, size, image::imageops::FilterType::Lanczos3);
    tray_icon::Icon::from_rgba(scaled.into_raw(), size, size).ok()
}

fn build_tray(root: &Path) -> Option<Tray> {
    let menu = Menu::new();
    let open_dsh = MenuItem::with_id(ITEM_OPEN_DSH, "打开 DSH", false, None);
    let toggle = MenuItem::with_id(ITEM_TOGGLE, "启动", false, None);
    let restart = MenuItem::with_id(ITEM_RESTART, "重启 DSH", false, None);
    let separator = PredefinedMenuItem::separator();
    let manager = MenuItem::with_id(ITEM_MANAGER, "打开管理页", true, None);
    let quit = MenuItem::with_id(ITEM_QUIT, "退出", true, None);
    for item in [
        &open_dsh as &dyn tray_icon::menu::IsMenuItem,
        &toggle,
        &restart,
        &separator,
        &manager,
        &quit,
    ] {
        let _ = menu.append(item);
    }
    let icon = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        // Windows：左键留给「打开启动器界面」，菜单走右键。macOS 菜单栏的惯例是单击就出菜单，
        // 叫回窗口由程序坞图标负责（见 Event::Reopen）。
        .with_menu_on_left_click(cfg!(target_os = "macos"))
        .with_tooltip("DSH-X")
        .with_icon(load_tray_icon(root)?)
        .build()
        .ok()?;
    Some(Tray {
        _icon: icon,
        open_dsh,
        toggle,
        manager,
        quit,
        restart,
    })
}

/// 启动失败时显示的页面。刻意不用系统弹窗（mshta/javascript:alert 那种）——它长得和
/// 窗口里的其它东西没关系，是这套界面里唯一格格不入的一块。
const ERROR_PAGE: &str = r#"<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DSH-X</title><style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         background: #15171c; color: #e7e9ee;
         font: 14px/1.6 "Microsoft YaHei UI", "Segoe UI", sans-serif;
         -webkit-user-select: none; user-select: none; }
  .card { width: 100%; padding: 26px 28px; background: #1c1f26; border-top: 1px solid #2a2e38; }
  .head { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #f2777a;
         box-shadow: 0 0 0 4px rgba(242, 119, 122, .16); }
  h1 { margin: 0; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 14px; color: #b9bec9; }
  pre { margin: 0 0 20px; padding: 10px 12px; background: #14161b; border: 1px solid #262a33;
        border-radius: 8px; max-height: 150px; overflow: auto; color: #9aa1ad;
        font: 12px/1.5 Consolas, "Courier New", monospace; white-space: pre-wrap;
        word-break: break-all; -webkit-user-select: text; user-select: text; }
  button { border: 0; border-radius: 8px; padding: 9px 20px; background: #3b6cff; color: #fff;
           font: inherit; font-size: 13px; cursor: pointer; }
  button:hover { background: #4a78ff; }
</style></head>
<body>
  <div class="card">
    <div class="head" id="drag"><span class="dot"></span><h1>__TITLE__</h1></div>
    <p>__MESSAGE__</p>
    <pre>__DETAIL__</pre>
    <button onclick="window.ipc.postMessage('quit')">关闭</button>
  </div>
  <script>
    window.ipc.postMessage('loaded:' + document.body.innerText.length + ':' + document.title);
    const drag = document.getElementById('drag');
    drag.addEventListener('mousedown', (e) => {
      if (e.target.tagName !== 'BUTTON') window.ipc.postMessage('drag');
    });
  </script>
</body></html>
"#;

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn error_page(title: &str, message: &str, detail: &str) -> String {
    ERROR_PAGE
        .replace("__TITLE__", &escape_html(title))
        .replace("__MESSAGE__", &escape_html(message))
        .replace("__DETAIL__", &escape_html(detail))
}

/// 启动失败就把这句话显示在我们自己的窗口里，然后守着它，直到用户点关闭。
/// 不返回：事件循环跑在这个函数里（一个进程只能有一个事件循环，所以不能另起一个）。
fn run_error_window(event_loop: EventLoop<UserEvent>, root: &Path, title: &str, message: &str, detail: &str) -> ! {
    let centered = event_loop.primary_monitor().map(|monitor| {
        let screen = monitor.size();
        let area = LogicalSize::new(ERROR_W, ERROR_H).to_physical::<u32>(monitor.scale_factor());
        PhysicalPosition::new(
            monitor.position().x + (screen.width as i32 - area.width as i32) / 2,
            monitor.position().y + (screen.height as i32 - area.height as i32) / 2,
        )
    });
    let mut window_builder = WindowBuilder::new()
        .with_title("DSH-X")
        .with_window_icon(load_window_icon(root))
        .with_decorations(false)
        .with_inner_size(LogicalSize::new(ERROR_W, ERROR_H));
    if let Some(position) = centered {
        window_builder = window_builder.with_position(position);
    }
    let Ok(window) = window_builder.build(&event_loop) else {
        // 连这个窗口都建不出来（WebView2 缺失等）：没有能显示我们界面的地方了，
        // 只能交给系统浏览器，至少管理页本身还能用
        open_in_browser(&manager_url());
        std::process::exit(1);
    };

    let proxy = event_loop.create_proxy();
    let mut context = WebContext::new(None);
    // 走和主窗口同一条路：先 about:blank，再 load_url。直接 with_html 在这里渲染不出来
    // （实测窗口是空白的），而这条路径是主窗口天天在跑的。
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_url("about:blank")
        .with_ipc_handler(move |request| match request.body().as_str() {
            "quit" => {
                let _ = proxy.send_event(UserEvent::Quit);
            }
            "drag" => {
                let _ = proxy.send_event(UserEvent::Drag);
            }
            _ => {}
        })
        .build(&window)
        .ok();
    let Some(webview) = webview else {
        // 连错误页都建不出来（WebView2 运行时缺失等）：留一份日志说明原因，别留一个白窗口
        let _ = std::fs::write(
            std::env::temp_dir().join("dsh-x-window-error.log"),
            format!("{title}: {message}\n{detail}\n"),
        );
        std::process::exit(1);
    };
    let page = error_page(title, message, detail);

    // 导航必须等事件循环跑起来之后再做：在 run 之前调 load_url/load_html，WebView2 收下了
    // 却不会真正加载，窗口就一直是一片空白（实测）。
    let mut loaded = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        if !loaded {
            if let Event::NewEvents(tao::event::StartCause::Init) = event {
                loaded = true;
                if let Err(error) = webview.load_html(&page) {
                    let _ = std::fs::write(
                        std::env::temp_dir().join("dsh-x-window-error.log"),
                        format!("错误页加载失败：{error}\n"),
                    );
                }
            }
        }
        match event {
            Event::UserEvent(UserEvent::Quit) => *control_flow = ControlFlow::Exit,
            // 无边框窗口，拖动只能自己来（和主窗口一样由页面发信号）
            Event::UserEvent(UserEvent::Drag) => {
                let _ = window.drag_window();
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            Event::WindowEvent { event: WindowEvent::Destroyed, .. } => {
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    })
}

/// 配置端口：settings.json 里的 port（设置页可改），读不到/不合法就用默认值。
static CONFIGURED_PORT: OnceLock<u16> = OnceLock::new();
/// 实际在用的端口：管理页在自己端口被别的程序占用时会往后顺延，扫到哪个用哪个。
static LIVE_PORT: OnceLock<u16> = OnceLock::new();

/// 每用户目录（和 platform.js 的 userAppDir 一致）：Windows 是 %APPDATA%\DSH，
/// macOS 是 ~/Library/Application Support/DSH。
fn user_app_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library").join("Application Support"));
    base.map(|dir| dir.join(APP_DIR_NAME))
}

fn configured_port() -> u16 {
    *CONFIGURED_PORT.get_or_init(|| {
        let text = user_app_dir()
            .map(|dir| dir.join("settings.json"))
            .and_then(|file| std::fs::read_to_string(file).ok());
        text.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            .and_then(|json| json.get("port").and_then(|value| value.as_u64()))
            .filter(|port| (1..=65535).contains(port))
            .map(|port| port as u16)
            .unwrap_or(DEFAULT_PORT)
    })
}

fn live_port() -> u16 {
    *LIVE_PORT.get().unwrap_or(&configured_port())
}

fn manager_url() -> String {
    format!("http://127.0.0.1:{}/", live_port())
}

fn manager_addr() -> String {
    format!("127.0.0.1:{}", live_port())
}

/// 端口上是不是我们自己的管理页——/api/ping 带身份标记，能区分自己的实例和别人的程序。
fn probe_manager(port: u16) -> bool {
    let Some(text) = http_get_with_timeout(
        &format!("127.0.0.1:{port}"),
        "/api/ping",
        PROBE_CONNECT_TIMEOUT,
        PROBE_IO_TIMEOUT,
    ) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|json| json.get("app").and_then(|value| value.as_str()).map(|app| app == "dsh-x"))
        .unwrap_or(false)
}

/// 找在跑的管理页：配置端口被占时它会顺延，所以从配置端口开始往后扫。
fn find_manager() -> Option<u16> {
    find_manager_from(configured_port())
}

fn find_manager_from(first: u16) -> Option<u16> {
    if probe_manager(first) {
        return Some(first);
    }

    // 以前这里逐个扫 20 个端口。在部分 Windows 环境里，一个未监听端口会等约 2 秒，
    // 冷启动最坏因此要卡几十秒。配置端口先单独探测，剩余顺延端口同时查，并给整个扫描
    // 一个很短的总预算；已有实例仍能被唤醒，新实例则尽快继续创建窗口。
    let (sender, receiver) = mpsc::channel();
    let mut pending = 0usize;
    for offset in 1..PORT_SCAN {
        let Some(port) = first.checked_add(offset) else {
            break;
        };
        pending += 1;
        let sender = sender.clone();
        thread::spawn(move || {
            let _ = sender.send(probe_manager(port).then_some(port));
        });
    }
    drop(sender);

    let deadline = Instant::now() + PROBE_SCAN_BUDGET;
    while pending > 0 {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        match receiver.recv_timeout(remaining) {
            Ok(Some(port)) => return Some(port),
            Ok(None) => pending -= 1,
            Err(_) => break,
        }
    }
    None
}

/// 等管理页起来（启动到 listen 之间有一小段），并把实际端口定下来。
fn wait_for_manager() -> Option<u16> {
    let deadline = Instant::now() + PORT_WAIT;
    loop {
        if let Some(port) = find_manager() {
            let _ = LIVE_PORT.set(port);
            return Some(port);
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(250));
    }
}



/// 用系统默认程序打开链接。
///
/// 别用 `cmd /c start`：cmd 会把 URL 再解析一遍，里面的 `&` 就是语句分隔符，
/// 页面上任何一个链接（插件页面、更新日志）被构造成 `http://127.0.0.1:1/?&calc`
/// 就成了任意命令执行。这里直接调 ShellExecuteW——`start` 内部走的也是它，
/// 参数按 argv 原样传，中间没有 shell。
#[cfg(windows)]
fn open_in_browser(url: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
    }
}

/// macOS：`open` 按 argv 收参数、不经过 shell，同样没有注入问题。
#[cfg(target_os = "macos")]
fn open_in_browser(url: &str) {
    let _ = Command::new("/usr/bin/open").arg(url).spawn();
}

/// 把隐藏/最小化的窗口叫回前台。
fn show_window(window: &tao::window::Window) {
    // 被 ─ 收到任务栏/程序坞的窗口，光 set_visible + set_focus 拉不回来
    window.set_minimized(false);
    window.set_visible(true);
    window.set_focus();
}

/// macOS 的应用菜单。没有它 ⌘Q/⌘W/⌘C/⌘V 全都不灵（WKWebView 的复制粘贴靠菜单里的
/// 标准动作派发），而无边框窗口又拿不到系统菜单。「退出」不用系统预设项：那会直接结束进程、
/// 绕过 node 的收尾，所以换成自己的项、走和托盘同一条 /api/quit。
#[cfg(target_os = "macos")]
fn build_app_menu() -> Menu {
    use tray_icon::menu::accelerator::{Accelerator, Code, Modifiers};
    use tray_icon::menu::Submenu;
    let quit = MenuItem::with_id(ITEM_QUIT, "Quit DSH-X", true, Some(Accelerator::new(Modifiers::META, Code::KeyQ)));
    let close = MenuItem::with_id(ITEM_CLOSE_WINDOW, "Close Window", true, Some(Accelerator::new(Modifiers::META, Code::KeyW)));
    let app = Submenu::with_items(
        "DSH-X",
        true,
        &[
            &PredefinedMenuItem::about(None, None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::hide(None),
            &PredefinedMenuItem::hide_others(None),
            &PredefinedMenuItem::show_all(None),
            &PredefinedMenuItem::separator(),
            &quit,
        ],
    );
    let edit = Submenu::with_items(
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(None),
            &PredefinedMenuItem::redo(None),
            &PredefinedMenuItem::separator(),
            &PredefinedMenuItem::cut(None),
            &PredefinedMenuItem::copy(None),
            &PredefinedMenuItem::paste(None),
            &PredefinedMenuItem::select_all(None),
        ],
    );
    let window = Submenu::with_items(
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(None), &PredefinedMenuItem::fullscreen(None), &close],
    );
    let menu = Menu::new();
    for submenu in [app, edit, window].into_iter().flatten() {
        let _ = menu.append(&submenu);
    }
    menu
}

/// 极简 HTTP GET，只用来问本机管理服务一个短路径；读完整响应取正文即可。
fn http_get_with_timeout(
    addr: &str,
    path: &str,
    connect_timeout: Duration,
    io_timeout: Duration,
) -> Option<String> {
    let socket: SocketAddr = addr.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&socket, connect_timeout).ok()?;
    stream.set_read_timeout(Some(io_timeout)).ok()?;
    stream.set_write_timeout(Some(io_timeout)).ok()?;
    stream
        .write_all(format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").as_bytes())
        .ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    Some(
        raw.split_once("\r\n\r\n")
            .map(|(_, body)| body)
            .unwrap_or_default()
            .trim()
            .to_string(),
    )
}

fn http_get(addr: &str, path: &str) -> Option<String> {
    http_get_with_timeout(
        addr,
        path,
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
}

/// 同样极简的 POST，用来让本机管理服务执行托盘菜单的动作；正文固定给个空 JSON。
fn http_post(addr: &str, path: &str) -> Option<String> {
    let socket: SocketAddr = addr.parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&socket, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(2))).ok()?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(head.as_bytes()).ok()?;
    stream.write_all(b"{}").ok()?;
    let mut raw = String::new();
    stream.read_to_string(&mut raw).ok()?;
    Some(raw)
}

/// 把 dsh.ico 解成 RGBA。ico 里 256 那帧是 PNG、小帧是 BMP，交给 image 统一处理。
fn decode_ico(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let decoded = image::load_from_memory_with_format(bytes, image::ImageFormat::Ico).ok()?;
    let rgba = decoded.to_rgba8();
    let (width, height) = rgba.dimensions();
    Some((rgba.into_raw(), width, height))
}

/// 窗口图标。exe 里内嵌的是同一张图，但 tao 不会自动取用，得自己解出来给它。
fn load_window_icon(root: &Path) -> Option<tao::window::Icon> {
    let bytes = std::fs::read(root.join("assets").join("dsh.ico")).ok()?;
    let (rgba, width, height) = decode_ico(&bytes)?;
    tao::window::Icon::from_rgba(rgba, width, height).ok()
}

/// 启动器文件（start.js、node/、assets/…）所在的目录。
/// Windows 就是 exe 旁边；macOS 是包里的 Contents/Resources/app（可执行文件在 Contents/MacOS）。
fn app_root(exe: &Path) -> PathBuf {
    let dir = exe.parent().expect("install dir");
    #[cfg(target_os = "macos")]
    {
        let bundled = dir.parent().map(|contents| contents.join("Resources").join("app"));
        if let Some(bundled) = bundled.filter(|path| path.join("start.js").exists()) {
            return bundled;
        }
    }
    dir.to_path_buf()
}

fn main() {
    let exe = std::env::current_exe().expect("current exe");
    let root = app_root(&exe);
    let node = root.join("node").join(NODE_BINARY);
    let script = root.join("start.js");

    // 用户在 DSH.exe 上带的参数：原样转给 start.js（server.js 会把它们拼到 dsh
    // 命令行末尾），不再静默忽略。开头那个不带 `-` 的是 dsh 式调用里的 profile 名
    // （`DSH.exe web --host …`），启动 profile 由设置页决定，这里把它丢掉，只透传
    // flag。唤醒已有实例的那条路上参数会随本进程退出作废——那个实例已经在跑了。
    let mut forwarded: Vec<String> = std::env::args().skip(1).collect();
    if let Some(first) = forwarded.first() {
        if !first.starts_with('-') {
            forwarded.remove(0);
        }
    }

    // 已经有实例在跑就别再走后面那一套了。否则会先建出一个窗口、再拉一次 node 和
    // WebView2，等发现端口被占才收摊——用户看到的就是一个多余的窗口闪一下。
    // 直接让那个实例把窗口叫出来就完事（它的 node 收到 /api/wake 会回信号给我们）。
    if let Some(port) = find_manager() {
        let _ = LIVE_PORT.set(port);
        let _ = http_post(&manager_addr(), "/api/wake");
        std::process::exit(0);
    }

    // 从 Finder / 程序坞打开的 macOS 应用只拿到 launchd 的精简 PATH（/usr/bin:/bin:…），
    // 用户 shell 里配的 Homebrew 等目录都不在；插件的构建脚本会用到 git 之类，这里补上常见位置。
    let mut dirs = vec![node.parent().unwrap().to_path_buf()];
    if let Some(old) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&old));
    }
    #[cfg(target_os = "macos")]
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let extra = PathBuf::from(extra);
        if !dirs.contains(&extra) {
            dirs.push(extra);
        }
    }
    let path = std::env::join_paths(dirs).expect("PATH entries");

    let spawn_node = |app_window: bool| {
        let mut command = Command::new(&node);
        command
            .arg(&script)
            .args(&forwarded)
            .current_dir(&root)
            .env("PATH", &path)
            // stdout 走管道：node 用一行约定标记叫我们把窗口叫到前面
            .stdout(Stdio::piped());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        if app_window {
            // 告诉 start.js：管理页由本进程的窗口承载，别再自己开浏览器
            command.env("DSH_APP_WINDOW", "1");
        }
        command.spawn()
    };

    let mut builder = EventLoopBuilder::<UserEvent>::with_user_event();
    let event_loop = builder.build();
    let proxy = event_loop.create_proxy();

    // 事件循环要先建出来：启动失败的话，我们要用自己的窗口把原因说清楚，而不是弹系统对话框
    if !node.exists() || !script.exists() {
        run_error_window(
            event_loop,
            &root,
            "启动器文件不完整",
            &format!("缺少 node/{NODE_BINARY} 或 start.js，多半是安装没完成、或者被杀毒软件清理掉了。"),
            "重新安装一次 DSH-X 即可。",
        );
    }

    // 先把 node 拉起来：它要加载模块、起 http 服务，这段时间正好和下面 WebView2 的初始化重叠
    let mut child = match spawn_node(true) {
        Ok(child) => child,
        Err(error) => run_error_window(
            event_loop,
            &root,
            "无法启动 dsh 服务进程",
            "启动器没能把 node 拉起来，dsh 因此无法运行。",
            &error.to_string(),
        ),
    };

    let node_out = child.stdout.take();

    // node 退出（含托盘退出）就收摊，窗口跟着关
    {
        let proxy = proxy.clone();
        thread::spawn(move || {
            let _ = child.wait();
            let _ = proxy.send_event(UserEvent::Exited);
        });
    }

    // node 说「把窗口叫出来」时，读的就是这句约定标记
    if let Some(out) = node_out {
        let proxy = proxy.clone();
        thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if line.trim() == SHOW_SIGNAL {
                    let _ = proxy.send_event(UserEvent::Show);
                }
            }
        });
    }

    // 每 1.5 秒问一次状态，用来更新托盘菜单的文案和可用项
    {
        let proxy = proxy.clone();
        thread::spawn(move || loop {
            let state = http_get(&manager_addr(), "/api/tray")
                .map(|text| parse_tray_state(&text))
                .unwrap_or_default();
            if proxy.send_event(UserEvent::Tray(state)).is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(1500));
        });
    }

    // WebView2 的初始化是启动里最贵的一段，放在 node 之后做，两者就能并行。
    // 建不出来（WebView2 缺失等）就降级成「只有托盘、没有窗口」，浏览器顶上管理页，
    // 绝不能在 node 已经在跑的时候直接退出——那会留下没人管的进程。
    let data_dir = user_app_dir().unwrap_or_else(|| root.join("data")).join("webview");
    let _ = std::fs::create_dir_all(&data_dir);
    let mut context = WebContext::new(Some(data_dir));

    // 无边框窗口拿不到系统给的默认摆位，不指定的话会落在系统的层叠位置上；首次出现摆在主屏正中
    let centered = event_loop.primary_monitor().map(|monitor| {
        let screen = monitor.size();
        let area = LogicalSize::new(WINDOW_W, WINDOW_H).to_physical::<u32>(monitor.scale_factor());
        PhysicalPosition::new(
            monitor.position().x + (screen.width as i32 - area.width as i32) / 2,
            monitor.position().y + (screen.height as i32 - area.height as i32) / 2,
        )
    });

    let window_builder = WindowBuilder::new()
        .with_title("DSH-X")
        .with_window_icon(load_window_icon(&root))
        .with_inner_size(LogicalSize::new(WINDOW_W, WINDOW_H))
        .with_min_inner_size(LogicalSize::new(WINDOW_MIN_W, WINDOW_MIN_H));
    // 不要原生标题栏：图标、标题、三个按钮都由页面自己画，风格才统一
    #[cfg(windows)]
    let mut window_builder = window_builder.with_decorations(false);
    // macOS 反过来留着系统红绿灯（用户对它们的肌肉记忆比风格统一更重要），只把标题栏做透明、
    // 让页面铺满整个窗口，红绿灯挪到和页面顶栏对齐的位置
    #[cfg(target_os = "macos")]
    let mut window_builder = {
        use tao::platform::macos::WindowBuilderExtMacOS;
        window_builder
            .with_titlebar_transparent(true)
            .with_title_hidden(true)
            .with_fullsize_content_view(true)
            .with_traffic_light_inset(LogicalPosition::new(TRAFFIC_LIGHT_INSET.0, TRAFFIC_LIGHT_INSET.1))
    };
    if let Some(position) = centered {
        window_builder = window_builder.with_position(position);
    }
    let window = match window_builder
        .build(&event_loop)
    {
        Ok(window) => Some(window),
        Err(error) => {
            // 建不出窗口，就没有能显示我们自己界面的地方了，只能退回系统浏览器——
            // 至少管理页本身还能用，托盘也照常工作
            eprintln!("窗口创建失败，已改用浏览器打开：{error}");
            open_in_browser(&manager_url());
            None
        }
    };

    // 页面的窗口操作走 IPC 转成事件，窗口本身留在事件循环里操作，避免到处共享所有权
    let ipc_proxy = proxy.clone();
    let webview = match &window {
        Some(window) => match WebViewBuilder::new_with_web_context(&mut context)
            .with_url("about:blank")
            .with_ipc_handler(move |request| {
                let event = match request.body().as_str() {
                    "minimize" => UserEvent::Minimize,
                    "maximize" => UserEvent::ToggleMaximize,
                    "close" => UserEvent::Hide,
                    "drag" => UserEvent::Drag,
                    _ => return,
                };
                let _ = ipc_proxy.send_event(event);
            })
            // 外部链接（Star、运行地址、更新日志）一律交给系统浏览器。wry 在没设这个
            // 处理器时会把 target="_blank" 直接取消，点了就像没反应。
            .with_new_window_req_handler(|url, _features| {
                open_in_browser(&url);
                wry::NewWindowResponse::Deny
            })
            // 就地导航（页面里 location.href 那种兜底）会把窗口导走，连自定义标题栏
            // 一起弄丢，所以只放行管理页自己，其余同样丢给浏览器。
            .with_navigation_handler(|url| {
                if url == "about:blank" || url.starts_with(&manager_url()) {
                    return true;
                }
                open_in_browser(&url);
                false
            })
            .build(window)
        {
            Ok(webview) => Some(webview),
            Err(error) => {
                eprintln!("窗口创建失败，已改用浏览器打开：{error}");
                open_in_browser(&manager_url());
                None
            }
        },
        None => None,
    };

    // 等管理服务起来再导航，否则 webview 会先撞上连接失败（它自己不会重试）。
    // 端口被占用时管理页会顺延，所以这里扫一遍把真正的端口定下来。
    wait_for_manager();

    // 直接加载，不问服务端：window 参数是个常量，绕一趟 HTTP 只会拖慢启动——而且
    // 那个接口内部要发网络请求，一旦超过读超时就会退化成不带 window 的地址，
    // 页面因此丢掉自定义标题栏和窗口按钮。更新询问交给页面自己去问 /api/pending。
    if let Some(webview) = &webview {
        let _ = webview.load_url(&format!("{}?window={WINDOW_QUERY}", manager_url()));
    }

    // 托盘建在主线程：它的消息要靠下面这个事件循环的消息泵派发
    let tray = build_tray(&root);
    let mut state = TrayState::default();

    // macOS 的菜单栏菜单也得在事件循环跑起来之前挂上；句柄要一直留着，否则菜单项跟着失效
    #[cfg(target_os = "macos")]
    let app_menu = {
        let menu = build_app_menu();
        menu.init_for_nsapp();
        menu
    };

    // webview 与 context 都是本帧的局部变量，run 不返回，所以它们的生命周期覆盖整个窗口期
    event_loop.run(move |event, _, control_flow| {
        #[cfg(target_os = "macos")]
        let _ = &app_menu;
        // Windows：左键点托盘＝打开启动器界面（菜单已经改成只在右键弹）。macOS 的左键是出菜单。
        while let Ok(tray_event) = TrayIconEvent::receiver().try_recv() {
            if cfg!(target_os = "macos") {
                continue;
            }
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = tray_event
            {
                match &window {
                    Some(window) => show_window(window),
                    None => open_in_browser(&manager_url()),
                }
            }
        }
        // 菜单事件走 muda 的全局 channel；托盘和窗口同在这条线程上，直接收
        while let Ok(menu_event) = MenuEvent::receiver().try_recv() {
            match menu_event.id().as_ref() {
                ITEM_OPEN_DSH => {
                    if !state.url.is_empty() {
                        open_in_browser(&state.url);
                    }
                }
                ITEM_TOGGLE => {
                    let path = if state.live() { "/api/stop" } else { "/api/launch" };
                    let _ = http_post(&manager_addr(), path);
                }
                ITEM_RESTART => {
                    let _ = http_post(&manager_addr(), "/api/restart");
                }
                ITEM_MANAGER => match &window {
                    Some(window) => show_window(window),
                    None => open_in_browser(&manager_url()),
                },
                ITEM_QUIT => {
                    // 让 node 自己收尾（停掉 dsh、通知开着的页面），它一退我们跟着收摊
                    let _ = http_post(&manager_addr(), "/api/quit");
                }
                #[cfg(target_os = "macos")]
                ITEM_CLOSE_WINDOW => {
                    if let Some(window) = &window {
                        window.set_visible(false);
                    }
                }
                _ => {}
            }
        }
        // 菜单事件不会唤醒事件循环，所以按小步长醒着轮询
        *control_flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(80));
        match event {
            Event::UserEvent(UserEvent::Show) => {
                if let Some(window) = &window {
                    show_window(window);
                }
            }
            // macOS：窗口藏起来之后点程序坞图标，系统发的就是这个
            Event::Reopen { .. } => match &window {
                Some(window) => show_window(window),
                None => open_in_browser(&manager_url()),
            },
            // macOS 上系统也能直接结束我们（程序坞右键「退出」、注销关机），这时 node 还活着、
            // 占着端口；同步让它收尾，否则下次打开会撞上一个没有窗口的旧实例。
            // node 已经先退的正常路径上这一步连接被拒，立刻返回。
            #[cfg(target_os = "macos")]
            Event::LoopDestroyed => {
                let _ = http_post(&manager_addr(), "/api/quit");
            }
            Event::UserEvent(UserEvent::Exited) => *control_flow = ControlFlow::ExitWithCode(0),
            Event::UserEvent(UserEvent::Tray(next)) => {
                state = next;
                if let Some(tray) = &tray {
                    tray.sync(&state);
                }
            }
            Event::UserEvent(UserEvent::Minimize) => {
                if let Some(window) = &window {
                    window.set_minimized(true);
                }
            }
            Event::UserEvent(UserEvent::ToggleMaximize) => {
                if let Some(window) = &window {
                    window.set_maximized(!window.is_maximized());
                }
            }
            Event::UserEvent(UserEvent::Hide) => {
                if let Some(window) = &window {
                    window.set_visible(false);
                }
            }
            Event::UserEvent(UserEvent::Drag) => {
                if let Some(window) = &window {
                    let _ = window.drag_window();
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                // 关窗口不退出：托盘还在、dsh 照常跑，需要时从托盘再叫回来
                if let Some(window) = &window {
                    window.set_visible(false);
                }
            }
            _ => {}
        }
        let _ = &webview;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn decodes_the_icon_at_full_size() {
        let bytes = std::fs::read("../assets/dsh.ico").expect("read assets/dsh.ico");
        let (rgba, width, height) = decode_ico(&bytes).expect("decode ico");
        println!("icon decoded {width}x{height}, {} bytes", rgba.len());
        assert_eq!(rgba.len() as u32, width * height * 4, "RGBA buffer size");
        // image 该挑最大那帧；挑到 16x16 标题栏图标就糊了
        assert!(width >= 256 && height >= 256, "expected the 256 frame, got {width}x{height}");
    }

    #[test]
    fn missing_icon_is_not_fatal() {
        assert!(load_window_icon(Path::new("does-not-exist")).is_none());
    }

    #[test]
    fn finds_a_manager_on_a_shifted_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind fake manager");
        let port = listener.local_addr().expect("fake manager address").port();
        assert!(port > 1, "ephemeral port should have a previous port");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept launcher probe");
            let mut request = [0u8; 512];
            let _ = stream.read(&mut request);
            let body = r#"{"app":"dsh-x"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).expect("reply to launcher probe");
        });

        assert_eq!(find_manager_from(port - 1), Some(port));
    }

    #[test]
    fn empty_port_scan_stays_within_the_startup_budget() {
        // 这段端口在本机防火墙下逐个 TcpStream::connect 约等 2 秒。旧实现扫描 20 个
        // 最坏会卡几十秒；并行短超时实现即使机器繁忙也应远低于这个数量级。
        let started = Instant::now();
        assert_eq!(find_manager_from(48_761), None);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "empty scan took {:?}",
            started.elapsed()
        );
    }
}
