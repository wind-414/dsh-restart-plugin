# dsh-restart-plugin

给 DeepSeek Harness 桌面端加一个「重启」按钮：点一下，应用自己退出再拉起来，不用去任务管理器结束进程。

按钮在左侧栏底部、账户「我」的正上方，黑底白字，图标 + 「重启」。

## 它是怎么工作的

```
Client（侧栏按钮）
  └─ POST /plugins/dsh-restart/restart   （带 x-dsh-restart: 1）
       └─ Host（插件主进程）
            └─ WMI Win32_Process.Create → wscript.exe relaunch.vbs
                 └─ 隐藏窗口跑 relaunch.ps1
                      └─ 等 2s → 杀掉所有 "DeepSeek Harness" 进程
                           → 等 1.5s → Start-Process 新实例
                           → 等 3s → 检查是否起来，写日志
```

关键点在 **WMI**：Host 本身跑在桌面端的 process job 里，普通子进程会跟着主进程一起被杀，根本活不到“重新启动”那一步。所以让 WMI 服务去创建 helper，它不在这个 job 里，能活下来。

helper 用 `wscript.exe`（GUI 子系统）而不是 `powershell.exe`，配上 `-WindowStyle Hidden`，整条链路不会闪黑框。

## 路径怎么来的

没有写死任何路径，Host 每次加载时自己算：

- 插件目录：`import.meta.url` → `fileURLToPath` → `dirname`；
- 应用 exe 和进程名：`process.execPath` → `basename` 去掉扩展名；
- 脚本 / 日志 / marker：优先 `%TEMP%\dsh-restart`；不可写时回退到插件目录 `.runtime`，再回退到 `~\.dsh-restart`。

算完会用当前路径重新生成 `relaunch.ps1` / `relaunch.vbs`，所以插件搬到哪、应用装在哪、用户名是什么，都能对上。生成的 `.ps1` 带 UTF-8 BOM、`.vbs` 用 UTF-16LE 写，中文用户名/安装路径不会乱码。`restart.log` 的 `loaded` 行会把这三组路径和 `desktop` 判定打出来，方便核对。

## 目录结构

```
dsh-restart/
├─ package.json          # bundle 元数据 + exports
├─ index.js              # 兼容 DSH loader 的根入口（转发到 src/host）
├─ cordis.patch.yml      # bundle 插入行
├─ README.md
├─ LICENSE
├─ .gitignore
├─ src/
│  ├─ host/index.js      # Host 半
│  └─ client/index.js    # Client 半
├─ locales/              # en / zh / zh-CN
└─ assets/icon.svg
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `src/host/index.js` | Host 半：注册 HTTP 路由、WMI 拉起 helper、写日志 |
| `src/client/index.js` | Client 半：在 `sidebar.footer.action` 注册按钮，发 POST |
| `cordis.patch.yml` | bundle 插入行（`id: dsh-restart`） |
| `locales/` | en / zh / zh-CN 文案 |
| `assets/icon.svg` | bundle 图标 |
| `%TEMP%\dsh-restart\relaunch.vbs` | 运行时生成：隐藏启动 PowerShell |
| `%TEMP%\dsh-restart\relaunch.ps1` | 运行时生成：等、杀进程、起新实例、自检 |
| `%TEMP%\dsh-restart\restart.log` | 运行时日志 |

## 安装

这个 bundle 已经在当前 profile 里以 `dsh-restart-plugin` 安装（本地目录 link，改代码后重新 enable 即可加载）。换一台机器/换 profile：

```powershell
# 用 plugin_manager 的 install_bundle，target 填本目录绝对路径
# 装完重启一次 DSH，让 Host 半加载
```

安装后如果按钮没出现，先刷新页面（F5）；再不行检查 `restart.log` 里有没有 `hit`。

## HTTP 接口

```
POST /plugins/dsh-restart/restart
Headers:
  Origin: http://127.0.0.1:<当前端口>   # 同源校验
  x-dsh-restart: 1                      # 必带，防跨站误触
```

| 状态 | 含义 |
| --- | --- |
| 200 `{ ok: true, method: 'powershell' }` | 已安排重启 |
| 409 `{ reason: 'not-desktop' }` | 当前不是桌面模式（`process.execPath` 不像 app exe），拒绝执行 |
| 400 `{ reason: 'missing-header' }` | 缺 `x-dsh-restart` 头 |
| 403 `{ reason: 'origin' }` | Origin 不同源 |
| 405 `{ reason: 'method' }` | 不是 POST |

诊断参数：`?dry=1` 不会重启，只走同一条 WMI 链路写一个 `restart-marker.txt`，用来确认 helper 能不能起来。

## 日志

`%TEMP%\dsh-restart\restart.log` 按行记录，时间戳是 UTC：

- `loaded here=... exe=... name=... runtime=...` — 插件加载时算出来的路径
- `hit POST ...` — 请求到了
- `relaunch wmi` / `relaunch launcher pid` / `relaunch exit` — Host 拉起 WMI helper
- `relaunch-helper start|killing|starting|app running|app not running after start` — helper 内部进度

重启没反应时，先看日志停在哪一步：没有 `hit` 是前端/路由问题；有 `wmi` 没有 `relaunch-helper start` 是 WMI 创建失败；有 `killing` 没有 `starting` 是杀进程卡住。

## 已知限制

- 仅 Windows：依赖 WMI、`wscript.exe`、Windows PowerShell 5.1。
- 非桌面模式（纯 web/node 跑）会返回 409 并写日志，不会把 `node` 当 app 去杀；开发模式下的 `electron.exe` 也拒绝。
- 运行目录 `%TEMP%\dsh-restart` 是临时的，清掉临时文件后下次加载会自动重建；不可写时回退到插件目录或用户目录。
- 单击直接触发，没有二次确认；按钮在侧栏收成窄轨时只显示图标。
- 发布名：`dsh-restart-plugin`（npm 上可用）。改名时同步 `package.json.name`、`cordis.patch.yml` 的 `name`、`src/client/index.js` 的 `__ModuleLoader__.load({ id })`。
