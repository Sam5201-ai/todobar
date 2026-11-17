//! 平台能力真源（编译期常量）。
//!
//! 所有「某平台是否提供某功能」的判断只看这里，杜绝两套表：
//! - Rust 侧（托盘菜单、快捷键、OCR 状态）直接调用 `current()`；
//! - 前端通过 `platform_capabilities` 命令取一次并缓存。
//!
//! 设计约束：
//! 1. 这是**编译期**能力表，不落盘、不读偏好、不写 `prefs.json`。
//! 2. 字段用 serde camelCase，与前端 `platformCapabilities.ts` 的 `CapabilityId` 一一对应。
//! 3. Windows 全部为 true；macOS 首发隐藏截图/贴图/OCR/晾衣绳/应用内安装更新，
//!    保留剪贴板历史（见 clipboard.rs）、复制写入、录音采集与文件操作。
//! 4. 不可用项在前端是「隐藏」，不是「报错」；本表不承载「暂不支持」文案。

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    /// "windows" / "macos" / 其他
    pub os: &'static str,
    /// 截图 / 贴图 / 图片保存 / 框选 / 窗口截图
    pub screenshot: bool,
    /// OCR 识别（依附截图输入链路）
    pub ocr: bool,
    /// 剪贴板历史（Mac 端已实现，见 clipboard.rs）
    pub clipboard_history: bool,
    /// 晾衣绳
    pub clothesline: bool,
    /// 应用内检查更新中的「下载并安装」
    pub in_app_update: bool,
    /// 全应用复制通道（clipboard_write_text）
    pub clipboard_write: bool,
    /// 录音的文件打开 / 定位 / 打开目录 / 权限设置跳转
    pub recording_shell: bool,
}

/// 编译期分派，进程内多次调用零开销。
pub const fn current() -> PlatformCapabilities {
    #[cfg(target_os = "windows")]
    {
        PlatformCapabilities {
            os: "windows",
            screenshot: true,
            ocr: true,
            clipboard_history: true,
            clothesline: true,
            in_app_update: true,
            clipboard_write: true,
            recording_shell: true,
        }
    }

    #[cfg(target_os = "macos")]
    {
        PlatformCapabilities {
            os: "macos",
            screenshot: false,
            ocr: false,
            clipboard_history: true,
            clothesline: false,
            in_app_update: false,
            clipboard_write: true,
            recording_shell: true,
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        PlatformCapabilities {
            os: "other",
            screenshot: false,
            ocr: false,
            // 其他平台的剪贴板监听是空桩（start_monitor 的 seq 恒 0），不提供历史。
            clipboard_history: false,
            clothesline: false,
            in_app_update: false,
            clipboard_write: false,
            recording_shell: false,
        }
    }
}

#[tauri::command]
pub fn platform_capabilities() -> PlatformCapabilities {
    current()
}
