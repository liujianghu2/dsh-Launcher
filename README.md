# DeepSeek Harness 分发打包

把本机的 DeepSeek Harness 本地应用打包成一个自包含的 Windows 安装程序，用于分发给其他人。

## 产物

```
dist\DeepSeekHarness-Setup-0.1.5-rc.1-win-x64.exe    53 MB
```

单文件、免联网、免预装。对方双击后：

1. 选择安装目录（默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，**不需要管理员权限**）；
2. 自动创建开始菜单项、桌面图标和卸载程序；
3. 可选「立即启动 DeepSeek Harness」。

安装后占用约 327 MB（含自带的 Node.js 运行时）。安装包 53 MB，因为用 LZMA2 固实压缩把 316 MB 内容压到了六分之一。

## 重新构建

先决条件：

- 本机已装好可用的应用（默认 `%LOCALAPPDATA%\Programs\DeepSeekHarness`），打包时直接复制它的运行时——这样打出来的依赖树就是本机验证过能跑的那一份。
- 已安装 Inno Setup 6（`winget install JRSoftware.InnoSetup`）。

```powershell
# 完整重建：重新组装 staging 并编译安装包
pwsh -NoProfile -File E:\tools\dsh-dist\build-package.ps1

# 只改了 installer\DeepSeekHarness.iss 时，跳过组装直接重编译
pwsh -NoProfile -File E:\tools\dsh-dist\build-package.ps1 -SkipStage
```

脚本会先核对 Node.js 压缩包的 SHA-256（对照官方 `SHASUMS256.txt`），再组装 `staging\`，最后调用 `ISCC.exe` 编译。它还会断言 `staging\bin\start.vbs` 里存在 `runtime\node\node.exe` 查找——缺了这条，目标机器上没装 Node 时就会启动失败。

## 目录说明

| 路径 | 作用 |
|---|---|
| `build-package.ps1` | 构建脚本（组装 + 校验 + 编译） |
| `package-files\` | 面向使用者的文件：`README.md`、`config.json`、`dsh.cmd`、`THIRD-PARTY-NOTICES.md` |
| `installer\DeepSeekHarness.iss` | Inno Setup 脚本 |
| `installer\ChineseSimplified.isl` | 简体中文向导翻译，来自 Inno Setup 官方源码仓库 |
| `test\fake-registry.mjs` | 测试用桩 npm 源：能应答版本查询但下载必定失败，用来验证自动换源 |
| `staging\` | 组装出的安装内容（316 MB），每次完整构建会重建，可随时删除 |
| `cache\` | Node.js 官方校验和清单 |
| `dist\` | 最终安装包 |

## 包内组成

| 内容 | 来源 | 说明 |
|---|---|---|
| `app\` | 本机应用目录 | `@deepseek-ai/dsh` 及其 517 个依赖，MIT |
| `runtime\node\` | nodejs.org 官方 win-x64 压缩包 | Node.js 24.21.0，MIT，随包附带 |
| `bin\`、`assets\` | 本机应用目录 | 启动器脚本与应用图标 |
| `tools\install-shortcuts.ps1` | 本机应用目录 | 快捷方式损坏时可在安装目录就地修复 |

打包时 `bin\start.vbs`、`bin\stop.vbs`、`bin\update.vbs` 由 `install-shortcuts.ps1 -SkipShortcuts` 在 `staging\` 内重新生成，而不是照抄本机文件——这样安装脚本里的 Node 查找顺序一定包含自带的运行时。

## 后续升级官方版本

安装包里的 `@deepseek-ai/dsh` 就是官方 npm 包，**没有 fork、没有改源码、没有固定补丁**。所以跟随官方升级不需要重新打包分发——装好的程序自己就能升级：

| 方式 | 操作 |
|---|---|
| 启动后自动提示 | 服务就绪、界面可用之后，独立后台进程才检查并弹三选一：立即升级 / 以后再说 / 不再提示此版本 |
| 手动 | 开始菜单 →「检查更新」：显示**当前版本**与**最新版本**，可直接确认升级（不受「不再提示」影响） |
| 只看不升 | `dsh.cmd check`（同样显示当前版本与最新版本） |
| 无人值守 | `dsh.cmd update --yes` |

「以后再说」只在本次生效，下次启动继续提示；「不再提示此版本」把版本号写进 `run\update-state.json` 的 `suppressed`，只对自动提示生效，手动检查永远可用。

提示跑在 `dsh-app.mjs notify-update` 这个 detach 出去的子进程里，并在服务就绪之后才启动，所以不会拖慢启动，也不会像早期版本那样在服务起来之前拦住用户。它同时会去拿同一把启动锁，避免和一次手动启动互相踩。

升级流程：完整下载到 `update\` 暂存目录并校验版本 → 停掉服务 → `app\` 改名 `app.previous`、暂存目录改名 `app\` → 实际启动做健康检查 → 失败则把 `app.previous` 换回来。整个过程不需要重新安装，也不影响 `%USERPROFILE%\.dsh` 里的会话数据。

升级行为由安装目录的 `config.json` 控制：`registries`（源列表）、`channel`（默认 `latest`，可改 `alpha`/`next`）、`checkUpdates`、`updateCheckHours`。

### 关于 npm 源

打包机和本机用户配置的 `~\.npmrc` 里写的是 `registry=https://registry.npm.taobao.org`，这是一个已停更的老镜像。实测它缺少官方源上已有的子包版本，用它升级会直接失败：

```
npm error code ETARGET
npm error notarget No matching version found for @deepseek-ai/dsh-client-ui-...@^0.1.5-rc.2
```

官方源 `https://registry.npmjs.org` 上是齐的。因此启动器**不继承用户的 `.npmrc`**，只使用 `config.json` 里的 `registries`。另外升级时加了 `--prefer-online`：npm 的本地元数据缓存过期时会误报同样的 `notarget`，强制校验一次就能避免。

**多源与自动切换**（默认四个源，均实测可服务该包）：

| 源 | 实测元数据延时 |
|---|---|
| `https://registry.npmjs.org` | ~0.9–1.4s |
| `https://registry.npmmirror.com` | ~0.06s |
| `https://mirrors.cloud.tencent.com/npm` | ~0.5s |
| `https://mirrors.huaweicloud.com/repository/npm` | ~0.3s |

- **查询**：四个源并行请求，取其中报告的**最新版本**。并行让慢源不拖后腿（整体约 1.5s），取最大值保证未同步的镜像不会让程序误判「已是最新」。
- **下载**：只先试应答过查询的源（答不出元数据的源基本也发不了 tarball），按顺序逐个尝试；任一源失败就清空暂存目录换下一个，全部失败才报错并保留当前版本。
- **重试上限**：npm 默认会按指数退避重试失败请求，用户的 `.npmrc` 里设的是 5 次、最长 120 秒，一个死源能耗掉 8 分钟。启动器改用 `--fetch-retries=2`、`--fetch-retry-mintimeout=5000`、`--fetch-retry-maxtimeout=15000`，把失败源压到秒级。
- **全源不可达**：明确报「无法连接任何 npm 源」并列出尝试过的源，退出码 1；不会拿上次缓存的结果冒充「已是最新」。
- **缓存的源会被校验**：记忆的「上次成功的源」只有在仍出现在 `registries` 里时才会被优先使用，避免改过配置后还在用一个已经删掉的源。

官方源排第一，是因为镜像有时只同步主包、没同步同批发布的子包（这正是上面 `notarget` 的成因）；后面的镜像作为兜底。国内嫌官方源慢可以把镜像调到前面，失败时仍会自动回退。

实测（用 `test\fake-registry.mjs` 做桩源）：

| 场景 | 结果 |
|---|---|
| 桩源排第一且下载必失败 | 0.4 秒后切换到下一个源，全程 30 秒完成升级 |
| 唯一可用源也失败 | 21 秒后放弃并保留原版本（修复前是 533 秒） |
| 全部源不可达 | 明确报错 + 退出码 1，不谎报「已是最新」 |

同一份依赖树完整安装实测：官方源约 4 分钟，npmmirror 约 25–45 秒。

## 常用改动

| 想改什么 | 改哪里 |
|---|---|
| 版本号 | `installer\DeepSeekHarness.iss` 的 `#define AppVersion` |
| 默认安装目录 | 同文件的 `DefaultDirName` |
| 默认端口 | `package-files\config.json` 的 `port` |
| 应用图标 | 替换本机 `assets\dsh.ico` 后完整重建 |
| 更新内置的 dsh | 在本机 `app\` 目录执行 `npm install @deepseek-ai/dsh@latest`，再完整重建 |

## 分发注意事项

- **Windows SmartScreen**：安装包没有代码签名，对方首次运行会看到「已保护你的电脑」的蓝色提示，需要点「更多信息 → 仍要运行」。
- **API Key**：程序不含任何密钥。对方需要自己准备 DeepSeek API Key，首次打开后在界面设置里填写，保存在其本机的 `%USERPROFILE%\.dsh`。
- **数据隔离**：每个用户的数据都在自己的 `%USERPROFILE%\.dsh`，互不影响。
- **许可证**：`@deepseek-ai/dsh` 与 Node.js 都是 MIT，可以再分发；各自的 LICENSE 文件已随包保留，`THIRD-PARTY-NOTICES.md` 做了汇总。
- **商标**：「DeepSeek」名称与鲸鱼标识属于 DeepSeek。对内部分发通常没问题，对外公开发布前请确认商标使用授权。

## 已验证项

在隔离目录上做过完整的静默安装 → 启动 → 停止 → 卸载验证：

| 项目 | 结果 |
|---|---|
| 静默安装 | 退出码 0，327 MB 落盘，卸载程序已注册 |
| 内置 Node.js | `runtime\node\node.exe --version` → v24.21.0 |
| 双击路径（wscript → start.vbs） | 约 6.5 秒就绪 |
| 实际运行进程 | `runtime\node\node.exe ...\dsh\lib\bin.js web --port 3084`，系统 Node 完全未参与 |
| 快捷方式 | 桌面 + 开始菜单 4 项，目标、参数、图标均正确 |
| 停止 | 进程树结束，端口释放 |
| 卸载 | 目录、快捷方式、注册表项全部清除，无残留 |
| 安装包图标 | 已嵌入 |
| 自带启动脚本 | `start.vbs` / `stop.vbs` / `update.vbs` 均含自带运行时查找 |

## 备选：免安装压缩包

如果对方不方便运行 exe，可以直接把 `staging\` 打成 zip 发过去：解压后双击 `bin\start.vbs` 即可运行，脚本会按自身所在位置定位文件，不依赖安装过程。代价是没有开始菜单项、桌面图标和卸载程序。
