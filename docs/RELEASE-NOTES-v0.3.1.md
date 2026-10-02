# DSHTauri v0.3.1

> 本文件是 **v0.3.1 的发布说明草稿**（Release notes），已准备好但**尚未发布**。
> 发布方式见文末「如何真正发布」。

---

## 本次更新

### 统一程序 logo

程序各处图标统一成**托盘那只小鲸鱼**（透明背景），并跟随系统深浅色自动换色：

| 场景 | 表现 |
| --- | --- |
| 深色主题 / 深色任务栏 | **白色**小鲸鱼 |
| 浅色主题 / 浅色任务栏 | **深藏青**（`#020E36`）小鲸鱼 |

覆盖范围：

- **主程序 exe** 图标
- **安装包** `DSHTauri-v0.3.1-setup.exe` 的图标（之前是 Tauri 默认图标）
- **卸载程序** `uninstall.exe` 的图标（之前是 Tauri 默认图标）
- **系统托盘**图标（原有能力，保持不变）
- **主窗口 / 任务栏 / 标题栏**图标（新增：之前不跟随主题）
- 选择窗口 / 关于窗口 / 设置窗口的图标

> 说明：Windows 资源管理器与桌面上的 **exe/快捷方式图标不会**随系统主题自动换色
> —— 这是 Windows 的限制（一个 `.ico` 只能有一份图像）。因此文件图标固定用
> **深藏青**版（在浅色背景上清晰）；而**运行时**的窗口/任务栏/托盘图标会按主题自动切换。

### 侧栏过渡动画改进

针对上一版反馈的「不丝滑、深色模式下有白色卡顿」做了针对性修复：

- 消除**白色闪烁**：给侧栏子 webview 设置与页面底色一致的背景色，
  避免 WebView2 默认白底在滑动过程中露出来。
- 减少**卡帧**：动画期间不再重复设置尺寸（尺寸本来就没变），
  只改位置 —— 避免每帧触发网页重新布局。

### 文档重构

- `README.md` 重写为**面向使用者**的上手 / 排错 / 声明文档。
- 新增 `CONTRIBUTER_README.md`：构建、测试、CI、代码结构等**面向贡献者与 AI Agent** 的内容。

---

## 安装

1. 下载 `DSHTauri-v0.3.1-setup.exe`。
2. 运行安装程序。首次运行可能出现 SmartScreen 提示（未做代码签名），
   选择「更多信息 → 仍要运行」即可。
3. 安装时**默认不勾选**「创建桌面快捷方式」，需要的话在完成页自行勾选。

系统要求：Windows 10/11 x64（需要 WebView2 运行时，安装包会自动处理）。

---

## 如何真正发布（尚未执行）

本版本已准备好，但**没有**创建 Release。要发布时：

```bash
# 在 GitHub 上手动触发 workflow，并勾选 create_release
gh workflow run release-windows.yml -f create_release=true
```

或在仓库 **Actions → release-windows → Run workflow** 中勾选
「构建完成后创建 GitHub Release 并附带 NSIS 安装包」。

发布后会创建 tag `v0.3.1`，并附上 `DSHTauri-v0.3.1-setup.exe`。

> 注意：普通 push 到 `main` **只会构建 + 跑冒烟测试**，不会发布 Release
> （release job 有 `if: github.event_name == 'workflow_dispatch' && inputs.create_release` 守卫）。
