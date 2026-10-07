use super::{is_loopback_url, is_web_url, open_in_browser, same_origin, show_window, UserEvent};
use serde_json::{json, Value};
use tao::dpi::{LogicalPosition, LogicalSize};
use tao::event_loop::EventLoopProxy;
use tao::window::Window;
use wry::{PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder};
#[cfg(target_os = "windows")]
use wry::{MemoryUsageLevel, WebViewExtWindows};

const HEADER_HEIGHT: f64 = 72.0;
#[derive(Debug, Clone, PartialEq)]
pub struct TabTarget {
    pub id: String,
    pub title: String,
    pub url: String,
    pub status: String,
    pub managed: bool,
}

impl TabTarget {
    pub fn parse(value: &Value) -> Option<Self> {
        let id = value.get("id")?.as_str()?.to_string();
        let url = value.get("url")?.as_str()?.to_string();
        if id.is_empty() || (!url.is_empty() && !is_loopback_url(&url)) { return None; }
        Some(Self {
            id,
            url,
            title: value.get("title").and_then(Value::as_str).unwrap_or("DSH").to_string(),
            status: value.get("status").and_then(Value::as_str).unwrap_or("running").to_string(),
            managed: value.get("managed").and_then(Value::as_bool).unwrap_or(true),
        })
    }
}

pub fn parse_open(line: &str) -> Option<TabTarget> {
    let value: Value = serde_json::from_str(line.trim().strip_prefix("__DSH_TAB__ ")?).ok()?;
    let target = TabTarget::parse(&value)?;
    if target.url.is_empty() { return None; }
    Some(target)
}

#[derive(Debug)]
pub enum TabAction { Select(String), SelectRequested(String, u64), Reorder(Vec<String>, u64), Close(String), Reload, Next, CloseActive, Layout(f64), Present(u64) }

pub fn parse_action(body: &str) -> Option<TabAction> {
    let value: Value = serde_json::from_str(body).ok()?;
    match value.get("action")?.as_str()? {
        "select" => {
            let id = value.get("id")?.as_str()?.to_string();
            Some(if value.get("request").is_some() { TabAction::SelectRequested(id, value.get("request")?.as_u64()?) } else { TabAction::Select(id) })
        }
        "close-tab" => Some(TabAction::Close(value.get("id")?.as_str()?.to_string())),
        "reorder" => {
            let ids = value.get("ids")?.as_array()?.iter().map(|id| id.as_str().filter(|id| !id.is_empty()).map(str::to_owned)).collect::<Option<Vec<_>>>()?;
            if ids.iter().collect::<std::collections::HashSet<_>>().len() != ids.len() { return None; }
            Some(TabAction::Reorder(ids, value.get("request")?.as_u64()?))
        }
        "reload" => Some(TabAction::Reload),
        "next" => Some(TabAction::Next),
        "close-active" => Some(TabAction::CloseActive),
        "layout" => value.get("height")?.as_f64().filter(|height| (36.0..=256.0).contains(height)).map(TabAction::Layout),
        "present" => Some(TabAction::Present(value.get("serial")?.as_u64()?)),
        _ => None,
    }
}

struct Tab {
    target: TabTarget,
    view: WebView,
    loaded: String,
    page_title: String,
    visible: bool,
    memory_active: bool,
    page_loaded: bool,
}

fn reorder<T>(items: &mut [T], ids: &[String], id: impl Fn(&T) -> &str) {
    // 拖动与开关标签可能交错：已经关闭的忽略，新打开的留在末尾；只移动现有对象，不重建 WebView。
    let ranks: std::collections::HashMap<_, _> = ids.iter().enumerate().map(|(rank, id)| (id.as_str(), rank)).collect();
    items.sort_by_key(|item| ranks.get(id(item)).copied().unwrap_or(ids.len()));
}

pub struct BrowserTabs {
    tabs: Vec<Tab>,
    selected: String,
    enabled: bool,
    lang: String,
    theme: String,
    rendered: String,
    header_height: f64,
    geometry: Option<(f64, f64, f64, f64)>,
    presentation: u64,
    rendered_selection: String,
    selection_request: Option<u64>,
    order_request: Option<u64>,
    // 关闭当前标签时先保留旧画面，替代页面显示后再释放原生视图。
    retired: Vec<Tab>,
}

pub(super) fn bounds(window: &Window, top: f64, height: Option<f64>) -> Rect {
    let size = window.inner_size().to_logical::<f64>(window.scale_factor());
    Rect {
        position: LogicalPosition::new(0.0, top).into(),
        size: LogicalSize::new(size.width, height.unwrap_or((size.height - top).max(0.0))).into(),
    }
}

impl BrowserTabs {
    pub fn new() -> Self {
        Self { tabs: vec![], selected: String::new(), enabled: false, lang: "zh".into(), theme: "system".into(), rendered: String::new(), header_height: HEADER_HEIGHT,
            geometry: None, presentation: 0, rendered_selection: String::new(), selection_request: None, order_request: None, retired: vec![] }
    }

    pub fn preferences(&mut self, enabled: bool, lang: &str, theme: &str, window: &Window, manager: &WebView) {
        self.enabled = enabled;
        self.lang = lang.to_string();
        self.theme = theme.to_string();
        self.layout(window, manager);
        self.render(manager, false);
    }

    pub fn layout(&mut self, window: &Window, manager: &WebView) {
        let size = window.inner_size().to_logical::<f64>(window.scale_factor());
        let geometry = (size.width, size.height, window.scale_factor(), self.header_height);
        if self.geometry == Some(geometry) { return; }
        self.geometry = Some(geometry);
        // 标签直接画在管理页已有的菜单栏内；主 WebView 始终留着，窗口按钮和设置入口继续复用。
        let _ = manager.set_bounds(bounds(window, 0.0, None));
        for tab in self.tabs.iter().chain(&self.retired) {
            let _ = tab.view.set_bounds(bounds(window, self.header_height, None));
        }
    }

    pub fn update_memory(&mut self, window: &Window) {
        let foreground = window.is_visible() && !window.is_minimized();
        for tab in &mut self.tabs {
            // 首次导航尚未完成时先保持正常目标，避免后台页面加载到一半就被收缩。
            let active = !tab.page_loaded || (foreground && tab.visible);
            if active != tab.memory_active {
                set_memory_active(&tab.view, active);
                tab.memory_active = active;
            }
        }
    }

    pub fn page_loaded(&mut self, id: &str, url: &str, window: &Window) {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.target.id == id) {
            if same_origin(&tab.loaded, url) || (tab.loaded.is_empty() && (url.starts_with("data:") || url == "about:blank")) {
                tab.page_loaded = true;
            }
        }
        self.update_memory(window);
    }

    fn present(&mut self, serial: u64, manager: &WebView) {
        // 快速连点产生的旧绘制回执不能把页面切回去。只响应最新一次选择。
        if serial != self.presentation { return; }
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.target.id == self.selected) {
            if !tab.visible {
                // 激活前恢复正常内存目标；后台只收缩浏览器缓存，不暂停脚本或断开连接。
                set_memory_active(&tab.view, true);
                tab.memory_active = true;
                // 先显示新页面，后隐藏旧页面；两者之间始终有完整内容，不露出管理页底层。
                if tab.view.set_visible(true).is_err() { return; }
                tab.visible = true;
            }
        }
        for tab in self.tabs.iter_mut().chain(&mut self.retired) {
            if tab.visible && tab.target.id != self.selected && tab.view.set_visible(false).is_ok() {
                tab.visible = false;
                if tab.page_loaded {
                    set_memory_active(&tab.view, false);
                    tab.memory_active = false;
                }
            }
        }
        self.retired.clear();
        if self.selected.is_empty() { let _ = manager.focus(); }
        else { let _ = tab_focus(&self.tabs, &self.selected); }
    }

    pub fn open(&mut self, target: TabTarget, window: &Window, manager: &WebView, context: &mut WebContext, proxy: &EventLoopProxy<UserEvent>) -> wry::Result<()> {
        if !self.tabs.iter().any(|tab| tab.target.id == target.id) {
            let title_id = target.id.clone();
            let title_proxy = proxy.clone();
            let link_id = target.id.clone();
            let link_proxy = proxy.clone();
            let ipc_proxy = proxy.clone();
            let loaded_id = target.id.clone();
            let loaded_proxy = proxy.clone();
            // 每个标签保留独立的原生 WebView，不靠 iframe：避免跨源嵌入限制，切换也不会重载会话。
            let view = WebViewBuilder::new_with_web_context(context)
                .with_url("about:blank")
                .with_visible(false)
                .with_bounds(bounds(window, self.header_height, None))
                .with_initialization_script("document.addEventListener('keydown',e=>{if(!(e.ctrlKey||e.metaKey))return;let a=e.key.toLowerCase()==='w'?'close-active':e.key.toLowerCase()==='r'?'reload':e.key==='Tab'?'next':null;if(a){e.preventDefault();window.ipc.postMessage(JSON.stringify({action:a}))}})")
                .with_ipc_handler(move |request| {
                    // 远端页面只允许浏览操作；启动、停止和系统窗口控制留给本地管理界面。
                    if let Some(action @ (TabAction::Reload | TabAction::Next | TabAction::CloseActive)) = parse_action(request.body()) {
                        let _ = ipc_proxy.send_event(UserEvent::TabsAction(action));
                    }
                })
                .with_new_window_req_handler(move |url, _| {
                    let _ = link_proxy.send_event(UserEvent::TabLink(link_id.clone(), url));
                    wry::NewWindowResponse::Deny
                })
                .with_navigation_handler(|url| {
                    if is_web_url(&url) && !is_loopback_url(&url) { open_in_browser(&url); return false; }
                    is_loopback_url(&url) || url == "about:blank" || url.starts_with("data:") || url.starts_with("blob:")
                })
                .with_document_title_changed_handler(move |title| {
                    let _ = title_proxy.send_event(UserEvent::TabTitle(title_id.clone(), title));
                })
                .with_on_page_load_handler(move |event, url| {
                    if matches!(event, PageLoadEvent::Finished) {
                        let _ = loaded_proxy.send_event(UserEvent::TabPageLoaded(loaded_id.clone(), url));
                    }
                })
                .build_as_child(window)?;
            self.tabs.push(Tab { target: target.clone(), view, loaded: String::new(), page_title: String::new(), visible: false, memory_active: true, page_loaded: false });
        }
        let tab = self.tabs.iter_mut().find(|tab| tab.target.id == target.id).unwrap();
        if tab.loaded != target.url {
            tab.page_loaded = false;
            set_memory_active(&tab.view, true);
            tab.memory_active = true;
            tab.view.load_url(&target.url)?;
            tab.loaded = target.url.clone();
        }
        self.selected = target.id.clone();
        tab.target = target;
        self.layout(window, manager);
        self.render(manager, false);
        show_window(window);
        Ok(())
    }

    pub fn action(&mut self, action: TabAction, window: &Window, manager: &WebView) {
        match action {
            TabAction::Select(id) => {
                if id.is_empty() || self.tabs.iter().any(|tab| tab.target.id == id) { self.selected = id; }
            }
            TabAction::SelectRequested(id, request) => {
                self.selection_request = Some(request);
                if id.is_empty() || self.tabs.iter().any(|tab| tab.target.id == id) { self.selected = id; }
            }
            TabAction::Reorder(ids, request) => {
                if self.order_request.is_some_and(|previous| request <= previous) { return; }
                reorder(&mut self.tabs, &ids, |tab| &tab.target.id);
                self.order_request = Some(request);
            }
            TabAction::Close(id) => self.close(&id),
            TabAction::CloseActive => self.close(&self.selected.clone()),
            TabAction::Next => {
                let current = self.tabs.iter().position(|tab| tab.target.id == self.selected).map(|i| i + 1).unwrap_or(0);
                self.selected = self.tabs.get(current).map(|tab| tab.target.id.clone()).unwrap_or_default();
            }
            TabAction::Reload => {
                if let Some(tab) = self.tabs.iter().find(|tab| tab.target.id == self.selected) { let _ = tab.view.reload(); }
                else { let _ = manager.reload(); }
            }
            TabAction::Layout(height) => {
                self.header_height = height;
                self.layout(window, manager);
                return;
            }
            TabAction::Present(serial) => {
                self.present(serial, manager);
                return;
            }
        }
        self.layout(window, manager);
        self.render(manager, false);
    }

    fn close(&mut self, id: &str) {
        if let Some(index) = self.tabs.iter().position(|tab| tab.target.id == id) {
            // 只释放页面，不向服务端发 stop；关闭标签不等于关闭正在运行的 DSH 实例。
            self.retired.push(self.tabs.remove(index));
            if self.selected == id {
                self.selected = self.tabs.get(index.saturating_sub(1)).map(|tab| tab.target.id.clone()).unwrap_or_default();
            }
        }
    }

    pub fn follow(&mut self, instances: &[TabTarget], manager: &WebView) {
        for tab in &mut self.tabs {
            if !tab.target.managed { continue; }
            let next = instances.iter().find(|next| next.id == tab.target.id);
            let url = next.filter(|next| next.status == "running" || next.status == "starting").map(|next| next.url.as_str()).unwrap_or("");
            if tab.loaded != url {
                tab.page_loaded = false;
                set_memory_active(&tab.view, true);
                tab.memory_active = true;
                let result = if url.is_empty() {
                    let text = if self.lang == "en" { "This DSH instance has stopped. Return to the launcher to start it." } else { "此 DSH 实例已停止，请返回启动器启动。" };
                    // 不在占用的旧端口上反复刷新，以免重启间隙误加载到另一个实例。
                    tab.view.load_html(&format!("<!doctype html><meta charset='utf-8'><style>body{{font:16px system-ui;color:#7182a2;background:{};display:grid;place-items:center;height:90vh}}</style><p>{text}</p>", if self.theme == "dark" { "#111827" } else { "#f5f8ff" }))
                } else { tab.view.load_url(url) };
                if result.is_ok() { tab.loaded = url.to_string(); tab.page_title.clear(); }
            }
            if let Some(next) = next { tab.target = next.clone(); }
            else { tab.target.status = "stopped".into(); }
        }
        self.render(manager, false);
    }

    pub fn title(&mut self, id: &str, title: String, manager: &WebView) {
        if let Some(tab) = self.tabs.iter_mut().find(|tab| tab.target.id == id) {
            tab.page_title = title.chars().filter(|c| !c.is_control()).take(160).collect();
            self.render(manager, false);
        }
    }

    pub fn link(&self, id: &str, url: &str) -> bool {
        if let Some(tab) = self.tabs.iter().find(|tab| tab.target.id == id) {
            if same_origin(url, &tab.target.url) { let _ = tab.view.load_url(url); return true; }
        }
        false
    }

    pub fn render(&mut self, manager: &WebView, force: bool) {
        if force || self.presentation == 0 || self.rendered_selection != self.selected || !self.retired.is_empty() {
            self.presentation += 1;
            self.rendered_selection = self.selected.clone();
        }
        let value = json!({
            "active": self.selected, "lang": self.lang, "theme": self.theme,
            "presentation": self.presentation,
            "request": self.selection_request,
            "orderRequest": self.order_request,
            "enabled": self.enabled || !self.tabs.is_empty(),
            "tabs": self.tabs.iter().map(|tab| json!({"id":tab.target.id, "title":tab.target.title, "pageTitle":tab.page_title, "stopped":tab.loaded.is_empty()})).collect::<Vec<_>>()
        }).to_string();
        if force || value != self.rendered {
            let _ = manager.evaluate_script(&format!("window.updateInternalTabs?.({value})"));
            self.rendered = value;
        }
    }
}

pub(super) fn set_memory_active(view: &WebView, active: bool) {
    // WebView2 的 Low 模式仍执行脚本、保留 WebSocket 和草稿；旧运行时不支持时安静回退。
    #[cfg(target_os = "windows")]
    let _ = view.set_memory_usage_level(if active { MemoryUsageLevel::Normal } else { MemoryUsageLevel::Low });
    #[cfg(not(target_os = "windows"))]
    let _ = (view, active);
}

fn tab_focus(tabs: &[Tab], id: &str) -> wry::Result<()> {
    match tabs.iter().find(|tab| tab.target.id == id) { Some(tab) => tab.view.focus(), None => Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_signal_preserves_auth_and_rejects_external_urls() {
        let target = parse_open(r#"__DSH_TAB__ {"id":"web@1","title":"web · 1","url":"http://127.0.0.1:1234/?token=abc&x=2"}"#).unwrap();
        assert!(target.url.ends_with("token=abc&x=2"));
        assert!(parse_open(r#"__DSH_TAB__ {"id":"x","url":"https://example.com/"}"#).is_none());
        assert!(parse_open("__DSH_TAB__ invalid").is_none());
    }

    #[test]
    fn manager_tab_has_no_close_action_and_unknown_messages_are_rejected() {
        assert!(matches!(parse_action(r#"{"action":"select","id":""}"#), Some(TabAction::Select(id)) if id.is_empty()));
        assert!(parse_action(r#"{"action":"launch"}"#).is_none());
        assert!(parse_action(r#"{"action":"select"}"#).is_none());
        assert!(matches!(parse_action(r#"{"action":"present","serial":3}"#), Some(TabAction::Present(3))));
        assert!(parse_action(r#"{"action":"present","serial":-1}"#).is_none());
        assert!(matches!(parse_action(r#"{"action":"select","id":"web","request":2}"#), Some(TabAction::SelectRequested(id, 2)) if id == "web"));
        assert!(parse_action(r#"{"action":"select","id":"web","request":-1}"#).is_none());
    }

    #[test]
    fn reorder_messages_validate_ids_and_keep_new_tabs() {
        assert!(matches!(parse_action(r#"{"action":"reorder","ids":["second","first"],"request":3}"#), Some(TabAction::Reorder(ids, 3)) if ids == ["second", "first"]));
        for body in [
            r#"{"action":"reorder","ids":["first","first"],"request":3}"#,
            r#"{"action":"reorder","ids":[""],"request":3}"#,
            r#"{"action":"reorder","ids":[1],"request":3}"#,
            r#"{"action":"reorder","ids":[],"request":-1}"#,
        ] { assert!(parse_action(body).is_none()); }
        let mut ids = vec!["first".to_string(), "new-a".to_string(), "second".to_string(), "new-b".to_string()];
        reorder(&mut ids, &["closed".into(), "second".into(), "first".into()], String::as_str);
        assert_eq!(ids, ["second", "first", "new-a", "new-b"]);
    }

    // 需要桌面会话与 WebView2，单独运行这个用例；普通 CI 的纯逻辑测试不强制有桌面。
    #[cfg(windows)]
    #[test]
    #[ignore = "requires a Windows desktop session and WebView2"]
    fn native_tabs_keep_pages_and_follow_restarts() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};
        use std::time::{Duration, Instant};
        use tao::event::Event;
        use tao::event_loop::{ControlFlow, EventLoopBuilder};
        use tao::platform::run_return::EventLoopExtRunReturn;
        use tao::platform::windows::EventLoopBuilderExtWindows;
        use tao::window::WindowBuilder;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}/", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicUsize::new(0));
        let running = Arc::new(AtomicBool::new(true));
        let worker_requests = requests.clone();
        let worker_running = running.clone();
        let worker = std::thread::spawn(move || {
            while worker_running.load(Ordering::SeqCst) {
                if let Ok((mut stream, _)) = listener.accept() {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                    let mut request = Vec::new();
                    let mut chunk = [0; 4096];
                    while request.len() < 16384 && !request.windows(4).any(|part| part == b"\r\n\r\n") {
                        let size = stream.read(&mut chunk).unwrap_or(0);
                        if size == 0 { break; }
                        request.extend_from_slice(&chunk[..size]);
                    }
                    // WebView2 会预连空连接，也可能拆开发送请求头，不能把一次 read 当成完整请求。
                    if !request.windows(4).any(|part| part == b"\r\n\r\n") { continue; }
                    let request = String::from_utf8_lossy(&request);
                    let favicon = request.starts_with("GET /favicon.ico");
                    if request.starts_with("GET /?token=") { worker_requests.fetch_add(1, Ordering::SeqCst); }
                    let body = if favicon { "" } else { "<!doctype html><title>Loaded DSH</title><input id='draft' value='initial'><script>window.backgroundTicks=0;setInterval(()=>backgroundTicks++,100)</script>" };
                    let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                } else { std::thread::sleep(Duration::from_millis(10)); }
            }
        });

        let mut event_loop = EventLoopBuilder::<UserEvent>::with_user_event().with_any_thread(true).build();
        let proxy = event_loop.create_proxy();
        let window = WindowBuilder::new().with_visible(false).with_inner_size(LogicalSize::new(1000.0, 700.0)).build(&event_loop).unwrap();
        let path = std::env::temp_dir().join(format!("dsh-tabs-test-{}", std::process::id()));
        let mut context = WebContext::new(Some(path));
        let source = include_str!("../public/index.html");
        let header = source.split_once("<header>").unwrap().1.split_once("</header>").unwrap().0;
        // 桌面测试会短暂显示窗口，禁用真实鼠标输入，避免用户同时验收预览时误点测试标签。
        let html = format!("<!doctype html><html data-theme='light'><meta charset='utf-8'><style>{} body{{pointer-events:none}}</style><body><header>{header}</header><main>Launcher</main><script>{}</script><script>const applyTabs=window.updateInternalTabs;window.updateInternalTabs=(state)=>{{window.lastTabState=state;applyTabs(state)}}</script></body></html>", include_str!("../public/launcher.css"), include_str!("../public/internal-tabs.js"));
        let ipc_proxy = proxy.clone();
        let manager = WebViewBuilder::new_with_web_context(&mut context)
            .with_html(html)
            .with_bounds(bounds(&window, 0.0, None))
            .with_ipc_handler(move |request| {
                let event = if request.body() == "internal-tabs-ready" { UserEvent::TabsReady }
                    else { match parse_action(request.body()) { Some(action) => UserEvent::TabsAction(action), None => return } };
                let _ = ipc_proxy.send_event(event);
            }).build_as_child(&window).unwrap();
        let mut browser = BrowserTabs::new();
        browser.preferences(true, "zh", "light", &window, &manager);
        let first = TabTarget { id: "first".into(), title: "web · 1".into(), url: format!("{origin}?token=first"), status: "running".into(), managed: true };
        let second = TabTarget { id: "second".into(), title: "other · 1".into(), url: format!("{origin}?token=second"), status: "running".into(), managed: true };
        // WebView 都在事件循环运行前创建；先展示第一页，避免从未显示过的视图延迟初始化。
        browser.open(first.clone(), &window, &manager, &mut context, &proxy).unwrap();
        browser.present(browser.presentation, &manager);
        browser.open(second.clone(), &window, &manager, &mut context, &proxy).unwrap();

        fn pump(event_loop: &mut tao::event_loop::EventLoop<UserEvent>, browser: &mut BrowserTabs, window: &Window, manager: &WebView, duration: Duration) {
            let deadline = Instant::now() + duration;
            event_loop.run_return(|event, _, control| {
                *control = if Instant::now() >= deadline { ControlFlow::Exit } else { ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(20)) };
                match event {
                    Event::UserEvent(UserEvent::TabsReady) => browser.render(manager, true),
                    Event::UserEvent(UserEvent::TabTitle(id, title)) => browser.title(&id, title, manager),
                    Event::UserEvent(UserEvent::TabPageLoaded(id, url)) => browser.page_loaded(&id, &url, window),
                    Event::UserEvent(UserEvent::TabsAction(action)) => browser.action(action, window, manager),
                    _ => {}
                }
            });
        }

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline && !browser.tabs.iter().all(|tab| tab.page_title == "Loaded DSH") {
            pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(100));
        }
        assert_eq!(browser.tabs.len(), 2);
        assert_eq!(browser.selected, "second");
        assert!(browser.tabs.iter().all(|tab| tab.page_title == "Loaded DSH"), "titles: {:?}, visibility: {:?}", browser.tabs.iter().map(|tab| &tab.page_title).collect::<Vec<_>>(), browser.tabs.iter().map(|tab| tab.visible).collect::<Vec<_>>());
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        let (tx, rx) = std::sync::mpsc::channel();
        manager.evaluate_script_with_callback("({count:document.querySelectorAll('header [role=tab]').length,headers:document.querySelectorAll('header').length,theme:document.documentElement.dataset.theme})", move |value| { let _ = tx.send(value); }).unwrap();
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(300));
        let rendered: Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
        assert_eq!(rendered["count"], 2, "菜单栏只显示 DSH 标签，启动器主页由 logo 返回");
        assert_eq!(rendered["theme"], "light");
        assert_eq!(rendered["headers"], 1, "标签必须复用原有菜单栏");
        assert!(!browser.tabs[0].visible && browser.tabs[1].visible);
        assert!(!browser.tabs[0].memory_active && browser.tabs[1].memory_active, "后台页面使用低内存目标，当前页面保持正常目标");
        let (tx, rx) = std::sync::mpsc::channel();
        browser.tabs[0].view.evaluate_script_with_callback("window.backgroundTicks", move |value| { let _ = tx.send(value); }).unwrap();
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(100));
        let ticks: Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
        assert!(ticks.as_u64().unwrap() > 0, "低内存模式不能暂停后台脚本");
        manager.evaluate_script("window.savedTab=document.querySelector('[data-id=first]');window.savedLabel=savedTab.querySelector('.internal-tab-label')").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        manager.evaluate_script_with_callback("(()=>{const old=window.lastTabState;window.savedLabel.click();const immediate=window.savedTab.classList.contains('active');window.updateInternalTabs(old);return {immediate,kept:window.savedTab.classList.contains('active')}})()", move |value| { let _ = tx.send(value); }).unwrap();
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(350));
        let response: Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
        assert_eq!(response["immediate"], true, "点击标签必须立即响应，不等待原生回传");
        assert_eq!(response["kept"], true, "后台旧状态不能打断用户刚开始的滑动");
        assert_eq!(browser.selected, "first");
        browser.tabs[0].view.evaluate_script("document.getElementById('draft').value='unsent draft';document.title='Saved draft'").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && browser.tabs[0].page_title != "Saved draft" {
            pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(100));
        }
        browser.open(first.clone(), &window, &manager, &mut context, &proxy).unwrap();
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(300));
        assert_eq!(browser.tabs.len(), 2, "重复打开不能增加标签");
        assert_eq!(browser.tabs[0].page_title, "Saved draft", "切回原页面不能重载未发送的内容");
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        assert!(browser.tabs[0].visible && !browser.tabs[1].visible);
        assert!(browser.tabs[0].memory_active && !browser.tabs[1].memory_active, "切回后恢复正常内存目标且保留草稿");
        // 连续快速切换只接受最后一次绘制回执；旧页面在新页面接管前仍保持可见。
        browser.action(TabAction::Select("second".into()), &window, &manager);
        let outdated = browser.presentation;
        browser.action(TabAction::Select("first".into()), &window, &manager);
        browser.action(TabAction::Present(outdated), &window, &manager);
        assert!(browser.tabs[0].visible && !browser.tabs[1].visible, "过期回执不能切回旧标签");
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(350));
        let (tx, rx) = std::sync::mpsc::channel();
        manager.evaluate_script_with_callback("({same:window.savedTab===document.querySelector('[data-id=first]')&&window.savedLabel===document.querySelector('[data-id=first] .internal-tab-label'),selected:document.querySelector('[data-id=first] .internal-tab-label').getAttribute('aria-selected'),aligned:Math.abs(document.querySelector('.internal-tab-indicator').getBoundingClientRect().left-window.savedTab.getBoundingClientRect().left)<1,transition:getComputedStyle(document.querySelector('.internal-tab-indicator')).transitionDuration})", move |value| { let _ = tx.send(value); }).unwrap();
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(150));
        let state: Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
        assert_eq!(state["same"], true, "切换和标题更新不能重建标签节点");
        assert_eq!(state["selected"], "true");
        assert_eq!(state["aligned"], true, "滑动背景最终必须与选中的标签对齐");
        assert!(state["transition"].as_str().unwrap().contains("0.26s"));
        let (tx, rx) = std::sync::mpsc::channel();
        manager.evaluate_script_with_callback("document.documentElement.classList.add('reduce-motion');Math.max(...getComputedStyle(document.querySelector('.internal-tab-indicator')).transitionDuration.split(',').map(parseFloat))", move |value| { let _ = tx.send(value); }).unwrap();
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(100));
        let duration: f64 = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
        assert!(duration < 0.001, "减少动态效果设置必须禁用滑动动效");
        manager.evaluate_script("document.documentElement.classList.remove('reduce-motion')").unwrap();
        manager.evaluate_script("document.getElementById('appVer').click()").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && (!browser.selected.is_empty() || browser.tabs.iter().any(|tab| tab.visible)) {
            pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(100));
        }
        assert!(browser.selected.is_empty(), "点击左侧版本号也必须切回管理页");
        assert!(browser.tabs.iter().all(|tab| !tab.visible));
        assert_eq!(browser.tabs.len(), 2, "返回主页不能关闭已有 DSH 标签");
        browser.action(TabAction::Select("first".into()), &window, &manager);
        let (tx, rx) = std::sync::mpsc::channel();
        browser.tabs[0].view.evaluate_script_with_callback("document.getElementById('draft').value", move |value| { let _ = tx.send(value); }).unwrap();
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(300));
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), r#""unsent draft""#);
        let position = browser.tabs[0].view.bounds().unwrap().position.to_logical::<f64>(window.scale_factor());
        assert_eq!(position.y, browser.header_height, "DSH 内容不能遮住菜单栏");
        let (tx, rx) = std::sync::mpsc::channel();
        manager.evaluate_script_with_callback(r#"(()=>{
            const label=window.savedLabel, old=window.lastTabState;
            const start=label.getBoundingClientRect().left+20;
            const end=document.querySelector('[data-id=second]').getBoundingClientRect().right-10;
            label.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,isPrimary:true,pointerId:1,clientX:start}));
            document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:end}));
            window.updateInternalTabs(old);
            const during=[...document.querySelectorAll('.internal-tab')].map(item=>item.dataset.id);
            document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,clientX:end}));
            label.click();
            window.updateInternalTabs(old);
            return {during,after:[...document.querySelectorAll('.internal-tab')].map(item=>item.dataset.id),same:savedTab===document.querySelector('[data-id=first]'),selected:savedTab.classList.contains('active')};
        })()"#, move |value| { let _ = tx.send(value); }).unwrap();
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(350));
        let moved: Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
        assert_eq!(moved["during"], json!(["second", "first"]), "拖动期间旧状态不能重置顺序");
        assert_eq!(moved["after"], json!(["second", "first"]), "松手后等待原生确认也不能跳回旧顺序");
        assert_eq!(moved["same"], true);
        assert_eq!(moved["selected"], true);
        assert_eq!(browser.tabs.iter().map(|tab| tab.target.id.as_str()).collect::<Vec<_>>(), ["second", "first"]);
        assert_eq!(browser.selected, "first");
        assert_eq!(requests.load(Ordering::SeqCst), 2, "拖动只能排序，不能重载页面");
        let (tx, rx) = std::sync::mpsc::channel();
        browser.tabs[1].view.evaluate_script_with_callback("document.getElementById('draft').value", move |value| { let _ = tx.send(value); }).unwrap();
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(100));
        assert_eq!(rx.recv_timeout(Duration::from_secs(1)).unwrap(), r#""unsent draft""#);
        browser.action(TabAction::Next, &window, &manager);
        assert!(browser.selected.is_empty(), "快捷键必须沿拖动后的顺序切换");
        browser.action(TabAction::Next, &window, &manager);
        assert_eq!(browser.selected, "second");
        let request = browser.order_request.unwrap();
        browser.action(TabAction::Reorder(vec!["first".into(), "second".into()], request - 1), &window, &manager);
        assert_eq!(browser.tabs[0].target.id, "second", "旧排序请求不能覆盖新顺序");
        browser.action(TabAction::Reorder(vec!["first".into(), "second".into()], request + 1), &window, &manager);
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(300));
        let (tx, rx) = std::sync::mpsc::channel();
        manager.evaluate_script_with_callback(r#"(()=>{
            const label=window.savedLabel;
            const start=label.getBoundingClientRect().left+20;
            const end=document.querySelector('[data-id=second]').getBoundingClientRect().right;
            const begin=(target,delta=0)=>{
                target.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,isPrimary:true,pointerId:2,clientX:start}));
                document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:2,clientX:end+delta}));
            };
            const ids=()=>[...document.querySelectorAll('.internal-tab')].map(item=>item.dataset.id).join(',');
            begin(label);
            label.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));
            const canceled=ids()==='first,second'&&!document.querySelector('.dragging');
            begin(label);
            document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:2}));
            const pointerCanceled=ids()==='first,second'&&!document.querySelector('.dragging');
            begin(document.querySelector('[data-id=first] .internal-tab-close'));
            document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:2}));
            const closeExcluded=ids()==='first,second';
            label.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,isPrimary:true,pointerId:2,clientX:start}));
            document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:2,clientX:start+2}));
            document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:2}));
            label.click();
            const clickWorks=window.savedTab.classList.contains('active');
            label.focus();
            label.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowRight',altKey:true}));
            const keyboardMoved=ids()==='second,first'&&document.activeElement===label;
            label.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'ArrowLeft',altKey:true}));
            return {canceled,pointerCanceled,closeExcluded,clickWorks,keyboardMoved,restored:ids()==='first,second'};
        })()"#, move |value| { let _ = tx.send(value); }).unwrap();
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(350));
        let result: Value = serde_json::from_str(&rx.recv_timeout(Duration::from_secs(1)).unwrap()).unwrap();
        for field in ["canceled", "pointerCanceled", "closeExcluded", "clickWorks", "keyboardMoved", "restored"] {
            assert_eq!(result[field], true, "排序交互失败: {field}");
        }
        assert_eq!(browser.tabs[0].target.id, "first");
        assert_eq!(browser.selected, "first");
        assert_eq!(requests.load(Ordering::SeqCst), 2);
        // 关闭当前页时等替代页面接管后再释放视图；不能先销毁当前页露出背景。
        browser.action(TabAction::Select("second".into()), &window, &manager);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && !browser.tabs[1].visible {
            pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(100));
        }
        browser.action(TabAction::Close("second".into()), &window, &manager);
        assert!(browser.retired.iter().any(|tab| tab.visible), "页面交接完成前必须保留关闭页的画面");
        pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(300));
        assert_eq!(browser.tabs.len(), 1);
        assert!(browser.retired.is_empty() && browser.tabs[0].visible);
        assert_eq!(requests.load(Ordering::SeqCst), 2, "切换和关闭标签不能重新请求页面");
        browser.follow(&[first.clone(), second], &manager);
        assert_eq!(browser.tabs.len(), 1, "同步实例不能重新打开已关闭的标签");
        let restarted = TabTarget { url: format!("{origin}?token=restarted"), ..first };
        browser.follow(&[restarted.clone()], &manager);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && requests.load(Ordering::SeqCst) < 3 {
            pump(&mut event_loop, &mut browser, &window, &manager, Duration::from_millis(100));
        }
        assert_eq!(requests.load(Ordering::SeqCst), 3);
        assert_eq!(browser.tabs[0].loaded, restarted.url);
        browser.follow(&[], &manager);
        assert!(browser.tabs[0].loaded.is_empty(), "实例停止后不能继续显示旧端口");
        browser.action(TabAction::Select(String::new()), &window, &manager);
        assert!(browser.selected.is_empty());
        browser.action(TabAction::Close("first".into()), &window, &manager);
        assert!(browser.tabs.is_empty());
        running.store(false, Ordering::SeqCst);
        worker.join().unwrap();
    }
}
