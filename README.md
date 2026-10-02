# dsh-download-dashboard

**给 DSH 的一块「大文件下载看板」：停在对话区右侧的浮窗，只列 300MB 以上的下载，实时显示进度、速度与剩余时间。**

和已有下载进度插件最大的不同只有一句：**它不关心下载是谁发起的。** 只要某个下载器按约定把状态写进那个目录——主会话跑的、子代理跑的、甚至你自己在终端里跑的——都会出现在同一块浮窗里。

> DSH 生态里已有 `dsh-download-progress`、`dsh-smart-dl`、`dsh-task-progress`、`dsh-job-progress` 等下载/进度类插件；它们都只覆盖「本会话」或「自己的工作区」（有的还在 README 里明确写出了这个限制）。本插件补的正是这一维：**跨会话可见**。逐条差异见文末[相关项目](#相关项目)。

## 它长什么样

- 停在对话区右侧的浮窗：**不占聊天宽度、不抢焦点、不挡输入框**；
- 一行一个下载：文件名（悬停显示完整保存路径）、百分比 + 进度条、已下载 / 总量、速度、剩余时间；
- 状态点：蓝＝进行中，绿＝已完成，红＝失败（失败直接显示原因）；
- 下载被**中断**（Ctrl+C、进程被杀、断电）时，快照会永远停在 `running`——所以规则是：**90 秒没有进度更新就标为「已中断」**（黄色），保留中断时的字节数，再过 5 分钟消失。它其实只是卡了一下又继续的话，会自动变回进行中；
- **没有符合条件的下载时，整个浮窗不渲染**——不占位、不吃鼠标事件；
- 完成或失败后保留 **5 分钟**，之后自己消失；
- 窗口缩放时位置跟随（定位完全交给 CSS，没有一行 JS 在算坐标）；右侧栏打开时自动向左让位。

## 数据从哪来

配套的下载器每次刷新进度，把一份机器可读快照写进系统临时目录：

```
%TEMP%\dsh-downloads\state\<id>.json           (Windows)
$TMPDIR/dsh-downloads/state/<id>.json          (macOS / Linux)
```

插件分两半：

| 文件 | 作用 |
|---|---|
| `index.js`（host 半） | 注册只读路由 `GET /dsh-downloads/state`，汇总该目录，跳过解析失败与超过 24 小时的记录 |
| `client.js`（client 半） | 挂在框架自带的 `shell.overlay` 浮层席位；有下载在跑时 1.5 秒拉一次（空闲 6 秒，页面隐藏时暂停），自己画浮窗 |

### 状态文件契约

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 唯一标识（配套下载器用「时间戳 + 文件名 + 进程号」保证并发不撞） |
| `name` | string | 文件名（浮窗显示的就是它） |
| `out` | string | 完整保存路径（悬停提示） |
| `totalBytes` | number \| null | 总字节；服务器没给 `Content-Length` 时为 `null` |
| `doneBytes` | number | 已下载字节 |
| `speedBps` | number | 字节 / 秒 |
| `etaSec` | number \| null | 剩余秒数 |
| `status` | string | `starting` / `running` / `retrying` / `done` / `failed` |
| `error` | string \| null | 失败原因 |
| `startedAt` / `updatedAt` | string | ISO 8601 时间戳；`updatedAt` 决定它何时从面板消失 |

**前提**：你需要一个会写这个文件的下载器。本仓库 `tools/dl.ps1` 就是（PowerShell 5.1+：换行式进度、断点续传、重试，结束时校验落盘字节数与 `Content-Length` 一致）。**旧版不带状态写入的 dl.ps1 会让浮窗一直是空的**——这是「装了没反应」最常见的原因。

## 安装

本包**未发布到 npm**（`private: true`），按本地目录安装：

```sh
git clone https://github.com/LemRic1117/dsh-download-dashboard
```

然后在 DSH 桌面端 / Web 端侧栏的 **Plugins** 页，粘贴你克隆下来的**绝对目录**（例如 `D:\plugins\dsh-download-dashboard`）。装完刷新一次页面（Ctrl+R）。

把 `tools/dl.ps1` 放到 `~/.dsh/tools/dl.ps1` 或任何你顺手的位置，下载时用它：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\dl.ps1 -Url <url> -Out <path> -Resume
```

## 可调项

都在 `client.js` 顶部：

| 常量 | 默认 | 含义 |
|---|---|---|
| `MIN_BYTES` | 300 MB | 显示阈值 |
| `LINGER_MS` | 5 分钟 | 完成 / 失败后保留多久 |
| `ACTIVE_STALE_MS` | 90 秒 | 声称在跑但这么久没更新，就当作已中断 |
| `POLL_ACTIVE_MS` | 1500 ms | 有下载在跑时的刷新间隔 |
| `POLL_IDLE_MS` | 6000 ms | 空闲时的刷新间隔 |
| `GAP_PX` | 12 | 与右边缘、右侧栏的间距 |

改完重新安装，或等 HMR 生效。

## 安全模型

设计前提是「**你自己控制的目录就是授权**」，而不是去扫别人的数据：

- **只读**：路由没有 POST/PUT/DELETE，也没有下载 / 取消 / 清空接口，不能改变任何状态。
- **三重访问栅栏**（任何一项不过即 403）：
  1. socket 对端地址必须是回环——这是内核提供的事实，客户端伪造不了；
  2. 请求头里**若有** `Host`，必须是本机回环 authority（兼容 `127.0.0.1` / `localhost` / `[::1]`）；
  3. 拒绝带 `Sec-Fetch-Site: cross-site` 的请求；若有 `Origin`，必须与 `Host` 同源。
     > 只查 `Host` 是不够的，因为 `Host` 由客户端提供。若有人把 DSH 的 web server 绑到 `0.0.0.0`（局域网访问），外部主机只要伪造 `Host: 127.0.0.1:<port>` 就能读走数据——所以第 1 条才是真正的边界。
- **字段白名单**：路由只返回上面契约表里的字段。**不返回下载 URL**（可能带签名令牌）、不返回会话 id、不返回命令行——状态文件里就算有，也不会出去。
- **不跨用户**：状态目录在系统临时目录下，ACL 限当前用户；同用户的未提权进程本来就能直接读那些文件，所以路由没有扩大权限面。真正的边界是「其他用户 / 远程」，由目录 ACL 与回环绑定守住。

关于「跨会话可见会不会泄露别的会话」——这是 `dsh-task-progress` 公开提出过的顾虑，值得正面回答：本插件**不读**任何会话的数据，它读的是一个**由你自己配置的目录**。谁往里面写，谁就被展示；所以这里的「跨会话」不是绕过权限，而是**把判断权交回给你**：不想被看到的下载，不写进去就是了。如果你确实想限制在单会话，把 `index.js` 顶部的 `STATE_DIR` 换成每会话目录即可（一行改动）。

## 相关项目

- [Fro2en12/dsh-download-progress](https://github.com/Fro2en12/dsh-download-progress) —— 最直接的近亲：同样是 `shell.overlay` 浮窗 + host 路由 + 轮询。它靠**追踪 shell 工具命令 + 扫描工作区文件增长**发现下载，阈值 64KB，完成保留 10 分钟，并提供下载 / 取消等写接口。**差异**：它只看得见自己托管或已注册工作区里的下载；本插件看的是状态目录，因此跨会话、跨子代理、跨终端。
- [LeiSureYu/dsh-smart-download](https://github.com/LeiSureYu/dsh-smart-download)（npm `@leisureyu/dsh-smart-dl`）—— 内置 aria2c 的多线程下载器 + 浮层进度胶囊。**差异**：它把状态写在 `<会话 cwd>/.dsh-progress/<会话 id>/`，源码注释写明「只有那个会话的面板会读它」，因此看不见子代理与终端里的下载。
- [chen8923/dsh-task-progress](https://github.com/chen8923/dsh-task-progress) —— 定义了生态里事实上的进度文件协议（`<root>/.dsh-progress/<会话 id>/<task>.jsonl`），并**刻意**不做跨会话读取。本插件的字段与它高度重合，但作用域是全局状态目录。
- [Rice00/dsh-job-progress](https://github.com/Rice00/dsh-job-progress) —— 读 DSH 的 job registry + 自己的进度目录；README 明确「你没在看的会话里的 job 是不可见的」。
- [chy007-fun/dsh-token-hud](https://github.com/chy007-fun/dsh-token-hud) —— **架构同构**的旁证：host 只读端点 + `shell.overlay` + 每秒轮询 + 无内容不渲染，只是它监控 token 吞吐而不是下载。
- [LemRic1117/opencode-download-progress](https://github.com/LemRic1117/opencode-download-progress) —— 同一思路在 opencode 上的先例（阈值默认也是 300MB、子代理的下载汇入主会话）。差异：它把进度写进对话流原地改写，本插件把它搬到对话右侧的独立浮层。

## 卸载

在 Plugins 页关掉或移除这个 bundle 即可。路由与浮层都由插件的生命周期持有，关闭即消失，不会残留重复注册。

## 已验证 / 未验证

**已在应用之外验证**：模块加载契约（loader id 与包名一致）、`shell.overlay` 注册形态、真实 React 渲染（阈值过滤、完成态、失败态、折叠控件、恶意文本转义）、浮层根节点点击穿透、只用主题令牌、路由的 200 / 403 / 405 三条路径、字段白名单、以及真机跑通一次 469MB 的真实下载（落盘字节与 `Content-Length` 完全一致）。

**未在真机验证**：首次安装是否必须刷新页面；右侧栏里的浮动面板（dockkit 的 `--dsh-dockkit-float-layer: 60`）会不会盖住本浮窗；与皮肤中心 / 宠物挂件的相对层级。

## License

[MIT](LICENSE)
