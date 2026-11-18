# dsh-dpi-tuner

DSH Web GUI 的触控优先显示调节插件（Android）：界面缩放 50–200%、会话字号 10–22px（经官方 theme service 生效）、实时 DPI 读数；缩放偏好跨重启、跨随机 loopback 端口持久化。

| 项目 | 说明 |
| --- | --- |
| 类型 | Host + Web Client bundle（`immediately` 注入） |
| 注入 | `@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-settings-general`、`@deepseek-ai/dsh-client-ui-theme` |
| 许可证 | MIT |

## 支持环境：仅 DSHA

> **本插件仅支持 DSHA**（Android 上以 proot/Ubuntu 运行 dsh、触控屏 Web GUI 的环境）：其交互设计（触控目标尺寸、缩放档位、DPI 读数）与持久化语义按 DSHA 手机场景实现。
> **桌面版 dsh（Desktop/CLI）不适用**：桌面环境有原生缩放体系，本插件的调节项与语义不匹配。
>
> **DSHA only.** This plugin targets the DSHA touch-first Web GUI on Android. It does not apply to desktop dsh.

## 功能

- **界面缩放**：50–200%，作用于 Web GUI 整体布局（触控优先）；
- **会话字号**：10–22px，通过官方 theme service 调整会话渲染字号；
- **实时 DPI 读数**：显示当前设备/渲染 DPI；
- **持久化**：缩放偏好在宿主重启与 loopback 端口随机变化后仍然生效。

## 安装（DSHA profile）

profile `package.json` 的 `dependencies`：

```json
"dsh-dpi-tuner": "github:<你的用户名>/dsh-dpi-tuner"
```

然后在 profile 目录执行 `pnpm install`（或经插件管理器安装）。安装后在设置面板中调节。
