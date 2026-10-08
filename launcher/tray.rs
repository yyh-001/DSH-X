use serde_json::Value;
use tray_icon::menu::{Menu, MenuItem, Submenu};
use crate::tabs::TabTarget;

#[derive(Debug, Clone)]
pub struct LaunchEntry {
    pub id: String,
    pub instance_id: String,
    pub name: String,
    pub status: String,
    pub installed: bool,
    pub busy: bool,
    pub target: Option<TabTarget>,
}

impl LaunchEntry {
    pub fn parse(value: &Value) -> Option<Self> {
        let id = value.get("id")?.as_str()?.to_string();
        if id.is_empty() { return None; }
        Some(Self {
            id,
            instance_id: value.get("instanceId").and_then(Value::as_str).unwrap_or("").to_string(),
            name: value.get("name")?.as_str()?.to_string(),
            status: value.get("status")?.as_str()?.to_string(),
            installed: value.get("installed").and_then(Value::as_bool).unwrap_or(false),
            busy: value.get("busy").and_then(Value::as_bool).unwrap_or(false),
            target: value.get("target").and_then(TabTarget::parse),
        })
    }

    fn enabled(&self, action: &str) -> bool {
        if self.busy || self.status == "stopping" { return false; }
        match action {
            "start" => self.installed && self.status == "stopped",
            "open" => self.status == "running" && self.target.as_ref().is_some_and(|target| !target.url.is_empty()),
            "restart" => self.installed && self.status == "running",
            "stop" => matches!(self.status.as_str(), "running" | "starting"),
            _ => false,
        }
    }

    fn label(&self, en: bool) -> String {
        let status = match (self.status.as_str(), en) {
            ("running", true) => "Running", ("running", false) => "运行中",
            ("starting", true) => "Starting…", ("starting", false) => "启动中…",
            ("stopping", true) => "Stopping…", ("stopping", false) => "停止中…",
            (_, true) if !self.installed => "Not installed",
            (_, false) if !self.installed => "未安装",
            (_, true) => "Stopped", (_, false) => "未运行",
        };
        // Windows 原生菜单把 & 当快捷键标记，用户名称需要转义。
        let name = if cfg!(target_os = "windows") { self.name.replace('&', "&&") } else { self.name.clone() };
        format!("{name} · {status}")
    }
}

const ACTIONS: [(&str, &str, &str); 4] = [
    ("start", "启动", "Start"), ("open", "打开", "Open"),
    ("restart", "重启", "Restart"), ("stop", "停止", "Stop"),
];

struct EntryMenu {
    entry: LaunchEntry,
    submenu: Submenu,
    items: Vec<MenuItem>,
}

pub struct LaunchMenus {
    menu: Menu,
    entries: Vec<EntryMenu>,
}

impl LaunchMenus {
    pub fn new(menu: Menu) -> Self { Self { menu, entries: Vec::new() } }

    pub fn sync(&mut self, rows: &[LaunchEntry], en: bool) {
        let same_order = self.entries.iter().map(|item| &item.entry.id).eq(rows.iter().map(|row| &row.id));
        // 只在入口增删或排序时重建，轮询状态不会反复拆掉用户展开的子菜单。
        if !same_order {
            for item in self.entries.drain(..) { let _ = self.menu.remove(&item.submenu); }
            for (index, row) in rows.iter().enumerate() {
                let submenu = Submenu::new(row.label(en), true);
                let items = ACTIONS.iter().map(|(action, zh, english)| {
                    let id = serde_json::json!(["launch", row.id, action]).to_string();
                    MenuItem::with_id(id, if en { english } else { zh }, row.enabled(action), None)
                }).collect::<Vec<_>>();
                for item in &items { let _ = submenu.append(item); }
                let _ = self.menu.insert(&submenu, index + 2);
                self.entries.push(EntryMenu { entry: row.clone(), submenu, items });
            }
        }
        for (menu, row) in self.entries.iter_mut().zip(rows) {
            menu.entry = row.clone();
            menu.submenu.set_text(row.label(en));
            for (item, (action, zh, english)) in menu.items.iter().zip(ACTIONS) {
                item.set_text(if en { english } else { zh });
                item.set_enabled(row.enabled(action));
            }
        }
    }

    pub fn request(&self, id: &str) -> Option<Value> {
        let parts: Vec<String> = serde_json::from_str(id).ok()?;
        if parts.len() != 3 || parts[0] != "launch" { return None; }
        let row = &self.entries.iter().find(|item| item.entry.id == parts[1])?.entry;
        if !row.enabled(&parts[2]) { return None; }
        Some(serde_json::json!({ "id": row.id, "instanceId": row.instance_id, "action": parts[2], "targetId": row.target.as_ref().map(|target| target.id.as_str()).unwrap_or("") }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_follow_their_own_status_and_url() {
        let mut row = LaunchEntry::parse(&serde_json::json!({
            "id": "custom", "name": "测试 & 工作", "status": "running", "installed": true,
            "target": { "id": "instance", "url": "http://127.0.0.1:7890/?token=test" }
        })).unwrap();
        assert!(row.enabled("open"));
        assert!(!row.enabled("start"));
        assert!(row.enabled("stop"));
        assert_eq!(row.label(false), if cfg!(target_os = "windows") { "测试 && 工作 · 运行中" } else { "测试 & 工作 · 运行中" });
        row.busy = true;
        assert!(!row.enabled("restart"));
        assert!(!row.enabled("stop"));
        row.busy = false;
        row.status = "stopped".into();
        assert!(row.enabled("start"));
        assert!(!row.enabled("open"));
        row.installed = false;
        assert!(!row.enabled("start"));
        assert!(row.label(true).ends_with("Not installed"));
    }

    #[test]
    fn invalid_targets_cannot_enable_open() {
        let row = LaunchEntry::parse(&serde_json::json!({
            "id": "custom", "name": "测试", "status": "running",
            "target": { "id": "instance", "url": "https://example.com/" }
        })).unwrap();
        assert!(!row.enabled("open"));
    }
}
