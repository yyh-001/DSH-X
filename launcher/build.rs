/// 启动器自己的版本号跟着 package.json 走（和安装包、管理页显示的保持一致）。
/// macOS 的版本号写在 Info.plist 里（由 scripts/pack.mjs 生成），这里只有 Windows 用。
#[cfg(windows)]
fn app_version() -> String {
    let raw = std::fs::read_to_string("../package.json").unwrap_or_default();
    raw.split("\"version\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .map(|value| value.to_string())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

fn main() {
    println!("cargo:rerun-if-changed=../assets/dsh.ico");
    println!("cargo:rerun-if-changed=../package.json");
    #[cfg(windows)]
    {
        let icon = std::path::Path::new("../assets/dsh.ico");
        if icon.exists() {
            let mut res = winresource::WindowsResource::new();
            res.set_icon("../assets/dsh.ico");
            // 这些字段不只是好看：杀软/信誉服务看厂商、版权、原始文件名，
            // 一片空白的未签名 exe 更容易被启发式当成下载器。
            res.set("ProductName", "DSH-X");
            res.set("FileDescription", "DSH-X 启动器");
            res.set("CompanyName", "yyh");
            res.set("LegalCopyright", "Copyright (C) 2026 yyh");
            res.set("OriginalFilename", "DSH.exe");
            res.set("InternalName", "DSH");
            let version = app_version();
            res.set("FileVersion", &version);
            res.set("ProductVersion", &version);
            if let Err(error) = res.compile() {
                println!("cargo:warning=embed icon failed: {error}");
            }
        }
    }
}
