# DeepSeek Harness 本地应用

一个可以双击启动的 DeepSeek Harness 桌面入口。安装后不需要命令行，也不需要预先安装 Node.js。

## 安装

1. 双击 `DeepSeekHarness-Setup-*.exe`。
2. 在「选择目标位置」页面确认或修改安装目录，然后一路「下一步」。
   - 默认装到当前用户目录下，**不需要管理员权限**。
   - 请不要装到 `C:\Program Files` 这类受保护目录，程序需要在安装目录里写运行日志。
3. 安装完成后可以勾选「立即启动 DeepSeek Harness」。

Windows 可能弹出「已保护你的电脑」的蓝色提示——这是因为安装包没有购买代码签名证书，不是病毒。点「更多信息」→「仍要运行」即可。

## 使用

双击桌面上的 **DeepSeek Harness** 图标。会先弹出一个小窗提示「正在启动 DeepSeek Harness，请稍候…」，服务就绪后该窗口自动关闭，浏览器随之打开。

- 首次启动约十秒；等待期间那个提示窗就是进度信号，不用重复点击。
- 再次双击图标时，如果服务已经在运行，只会打开浏览器，不会重复启动，也不会再出现提示窗。
- 开始菜单里还有「停止 DeepSeek Harness」「检查更新」「查看日志」「命令行工具」四项。
- 运行期间**不会弹出命令行黑窗口**：Harness 服务在一个隐藏的控制台里运行，它启动的子进程不会另开窗口。

**首次使用需要填写 API Key**：打开界面后进入设置，填入你自己的 DeepSeek API Key。Key 保存在本机，不会随程序分发。

## 升级

程序内的是官方发布的 `@deepseek-ai/dsh` 包，可以从 npm 源升级，不需要重新下载安装包。

- **启动后自动提示**：应用启动、界面已经能用了之后，才会在后台检查新版本。发现新版本时弹出三个选项：
  - **立即升级** —— 下载并自动重启服务，失败会自动回滚。
  - **以后再说** —— 这次不升，下次启动仍会提示。
  - **不再提示此版本** —— 这个版本不再自动打扰你。
- **手动检查**：开始菜单 → DeepSeek Harness → **检查更新**。无论上面选过什么，手动检查都会告诉你**当前版本**、**最新版本**以及是否需要升级，并允许升级。
- **只查看不升级**：`dsh.cmd check`。
- **无人值守升级**：`dsh.cmd update --yes`。

提示不会挡住启动：对话框弹出来的时候，界面早就可以正常使用了。

升级是安全的：新版本会先完整下载到一个临时目录，通过校验后才会替换正在用的版本；替换后会实际启动一次做健康检查，**启动失败会自动回滚到原来的版本**。

升级默认跟随 `latest` 标签。想改用其他发布通道（如 `alpha`）见下方配置。

### 多个 npm 源

升级会同时向配置里列出的**所有** npm 源查询版本，取其中最新的一个，因此某个源没同步、挂掉或很慢都不影响判断；下载则按顺序逐个尝试，**任何一个源下载失败都会自动换下一个**，全部失败才会报错。

| 默认顺序 | 源 |
|---|---|
| 1 | `https://registry.npmjs.org`（官方源，最完整） |
| 2 | `https://registry.npmmirror.com`（国内，快） |
| 3 | `https://mirrors.cloud.tencent.com/npm` |
| 4 | `https://mirrors.huaweicloud.com/repository/npm` |

官方源排第一是因为镜像虽然同步快，但有时只同步了主包、没同步它依赖的同批子包，这会让 npm 拒绝安装；后面的镜像作为兜底。国内如果嫌官方源慢，可以在 `config.json` 里把镜像调到前面，失败时仍会自动回退。

## 配置

安装目录下的 `config.json`：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `port` | `3080` | Web 服务端口，与别的程序冲突时改这里。 |
| `workingDirectory` | 用户主目录 | 新建会话的默认工作目录。 |
| `registries` | 见上表 | npm 源列表，按顺序尝试；也可写单个字符串 `registry`。 |
| `channel` | `latest` | 跟随的发布标签，可改为 `alpha`、`next`。 |
| `checkUpdates` | `true` | 启动时是否检查新版本；改为 `false` 可完全关闭。 |
| `updateCheckHours` | `6` | 两次联网检查之间的最小间隔（小时）。 |

改完需要重启应用生效（开始菜单 →「停止」后再双击图标）。

## 开机自启

```bat
dsh.cmd autostart on      :: 开启
dsh.cmd autostart off     :: 关闭
dsh.cmd autostart status  :: 查看
```

也可以手动把桌面快捷方式复制到 `shell:startup` 打开的文件夹。

## 数据位置

会话、设置、API Key 都保存在 `%USERPROFILE%\.dsh`。升级或卸载程序不会删除这份数据。

## 卸载

「设置 → 应用 → 已安装的应用」里找到 DeepSeek Harness 卸载，或使用开始菜单里的卸载项。卸载只删除程序本身，`%USERPROFILE%\.dsh` 需要手动删除。

## 常见问题

| 现象 | 处理 |
|---|---|
| 提示「端口 3080 已被其他程序占用」 | 改 `config.json` 里的 `port`，或结束占用该端口的程序。 |
| 浏览器显示 `dsh web authentication required` | 浏览器登录凭据失效了（例如清理过浏览器数据）。用「停止」结束服务，再双击图标重新启动即可。 |
| 点击「停止」后服务仍在运行 | 正常情况下会连同一并结束。若提示无法确定进程号，请在启动它的终端里按 Ctrl+C。 |
| 启动很慢或失败 | 开始菜单 →「查看日志」，看安装目录下 `logs\dsh-web.log` 的末尾。 |
| 「检查更新」提示连不上 npm 源 | 程序会把尝试过的源都列在提示里。检查网络，或在 `config.json` 的 `registries` 里换成本地可用的源。 |
| 某个源下载失败 | 不需要处理，会自动换下一个源重试；只有全部失败才会报错并保留当前版本。 |
| 升级下载很慢 | 官方源在国内可能较慢；可在 `registries` 里把国内镜像调到前面。下载期间会显示进度窗口。 |

## 系统要求

- Windows 10 / 11 x64（ARM64 设备通过 x64 兼容层运行）。
- 不需要预装 Node.js、pnpm 或其他运行时。
- 需要能访问 DeepSeek API 的网络；升级需要能访问 npm 官方源。

## 安全边界

- Web 服务只监听本机回环地址 `127.0.0.1`，**不对外网或局域网开放**，也没有可开启的开关。同一局域网内的其他人无法访问你的 DSH。
- 浏览器访问需要一次性的登录凭据，登录状态保留 30 天。
- 程序不含任何 API Key，也不会把你的 Key 发送到除你配置的模型服务之外的地方。

## 目录结构

```
DeepSeek Harness\
  dsh.cmd                     命令行助手（start / stop / status / check / update / autostart）
  config.json                 端口与工作目录设置
  README.md                   本文件
  app\                        本机安装的 @deepseek-ai/dsh 运行时及依赖
  runtime\node\               随包附带的 Node.js 运行时
  bin\
    dsh-app.mjs               启动器主体
    start.vbs                 无控制台窗口的启动入口（快捷方式指向它）
    stop.vbs                  停止入口
    update.vbs                检查更新入口
  assets\dsh.ico              应用图标
  logs\                       运行日志
  run\                        进程号与启动锁
  tools\
    install-shortcuts.ps1     快捷方式损坏或丢失时，重新执行可修复
```

## 许可证与声明

本程序分发 `@deepseek-ai/dsh`（MIT）和 Node.js（MIT）。各自的许可证文件随包保留，详见 `THIRD-PARTY-NOTICES.md`。

**本项目是社区自行封装的本地启动器，不是 DeepSeek 官方产品，与深度求索不存在隶属、合作、授权或背书关系。** 智能体能力、Web 界面和插件系统全部来自官方的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，本程序只负责把它包装成可双击启动的桌面入口、以及提供版本升级。

「DeepSeek」名称与鲸鱼标识属于 DeepSeek 的商标。对外分发时请自行确认使用授权。
