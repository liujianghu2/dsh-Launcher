# DeepSeek Harness 分发打包

把本机的 DeepSeek Harness 本地应用打包成一个自包含的 Windows 安装程序，用于分发给其他人。

## 本版功能一览

相对前几版新增/修好的东西，每条一句：

- **预装三个插件并默认启用**：插件市场 `dshmarket`、额度卡片 `dsh-deepseek-quota-bar`、本项目自己写的「数据管理」；装完即可用，不需要联网安装。
- **设置里新增「数据管理」页**（设置左侧一级入口）：查看数据位置、来源、占用与明细；可把整个数据目录迁移到别的盘，过程按「复制 → 校验 → 切换配置 → 重启生效」四步显示。
- **数据目录可固定**：`config.json` 的 `dataDirectory` 一处决定，启动器解析后显式传给服务进程，两边永远读同一个位置。
- **启动窗口**：应用图标 + 当前阶段文字 + 已等待秒数；失败自动重试的过程也显示在里面。
- **升级**：检查更新会列出每个发布通道（`newest`/`latest`/`next`/`alpha`）各自指向的版本，默认跟随 `newest`；点「立即升级」后弹出**可最小化**的进度窗口，实时显示下载 / 替换 / 验证 / 回滚。
- **首次启动失败自愈**：启动前预检 profile 模块索引，失败后按 3/6/10/15/20/25/30 秒重试并重建索引。
- **只用自带的 Node.js**：所有入口（`start.vbs` / `stop.vbs` / `update.vbs` / `run-server.vbs` / `dsh.cmd` / 启动器）固定用 `runtime\node\node.exe`，运行时缺失就明确报错，不回退系统 Node。
- **重新安装记住上次的安装位置**：Windows 卸载项 + 自己的注册表标记，双保险，`/DIR` 仍优先。
- **安装向导完成页不再自动勾选启动**；开始菜单新增「卸载 DeepSeek Harness」。

## 产物

```
dist\DeepSeekHarness-Setup-0.1.5-rc.1-win-x64.exe    54 MB
```

单文件、免联网、免预装。对方双击后：

1. 选择安装目录（默认 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，**不需要管理员权限**）；
2. 自动创建开始菜单项、桌面图标和卸载程序；
3. 安装完成后不再自动启动，从快捷方式启动即可；
4. 首次启动时自动启用随包的三个插件，不需要联网安装（见「内置插件」）。

安装后占用约 330 MB（含自带的 Node.js 运行时与三个预装插件）。安装包 54 MB，因为用 LZMA2 固实压缩把 322 MB 内容压到了六分之一。

## 重新构建

先决条件：

- 本机已装好可用的应用（默认 `%LOCALAPPDATA%\Programs\DeepSeekHarness`）。打包时**只**从它复制 `app\` 和 `assets\`——依赖树必须是本机验证过能跑的那一份；启动器、VBS 入口、部署文件和预装插件全部来自本仓库，避免把本机安装目录里过期的副本带进包里。
- 已安装 Inno Setup 6（`winget install JRSoftware.InnoSetup`）。
- 能访问 npm 源：组装时会用**自带的** Node.js/npm 把 `package-files\plugins\package.json` 里钉住的插件装进 `staging\plugins\`（本仓库自己写的插件不需要 npm，构建脚本直接复制）。

```powershell
# 完整重建：重新组装 staging 并编译安装包
pwsh -NoProfile -File E:\tools\dsh-dist\build-package.ps1

# 只改了 installer\DeepSeekHarness.iss 或 package-files\ 时，跳过组装直接重编译
pwsh -NoProfile -File E:\tools\dsh-dist\build-package.ps1 -SkipStage
```

脚本会先核对 Node.js 压缩包的 SHA-256（对照官方 `SHASUMS256.txt`），再组装 `staging\`，最后调用 `ISCC.exe` 编译。组装完成后它会断言：`staging\bin\start.vbs` 里有 `runtime\node\node.exe` 查找、并把它当必备条件（缺了这条，目标机器上没装 Node 时就会启动失败）；每个预装插件都真的落到了 `staging\plugins\` 里、带着自己的 `cordis.patch.yml`，且解析到的版本等于 `package-files\plugins\package.json` 钉住的版本；打包进 `staging\bin\dsh-app.mjs` 的启动器带预装插件同步逻辑。

## 目录说明

| 路径 | 作用 |
|---|---|
| `build-package.ps1` | 构建脚本（组装 + 校验 + 编译） |
| `node-runtime.json` | **Node.js 版本的唯一来源**：版本号、平台、压缩包 SHA-256 |
| `package-files\bin\dsh-app.mjs` | 启动器主体（本仓库是它的唯一来源） |
| `package-files\tools\install-shortcuts.ps1` | 生成 `bin\*.vbs` 与快捷方式 |
| `package-files\plugins\package.json` | **npm 预装插件的唯一来源**：钉住的包名与版本 |
| `package-files\plugins\dsh-data-manager\` | 本仓库自己写的「数据管理」插件（host + 浏览器半，无构建步骤） |
| `package-files\plugins\preinstalled.json` | 要默认启用哪些插件 |
| `package-files\` 其余文件 | 面向使用者的文件：`README.md`、`config.json`、`dsh.cmd`、`THIRD-PARTY-NOTICES.md` |
| `installer\DeepSeekHarness.iss` | Inno Setup 脚本 |
| `installer\ChineseSimplified.isl` | 简体中文向导翻译，来自 Inno Setup 官方源码仓库 |
| `test\fake-registry.mjs` | 测试用桩 npm 源：能应答版本查询但下载必定失败，用来验证自动换源 |
| `test\startup-probe.ps1` | 冷启动探针：用隔离的 `DSH_HOME` 启动一次并报告耗时/失败原因 |
| `test\preinstalled-plugins.ps1` | 预装插件验收：冷 `DSH_HOME` 启动一次，断言插件已复制进 profile、已写进 `bundles` 与 `dependencies`、三个插件都出现在前端启动清单里，且市场报告 `selfManaged=true` |
| `test\upgrade-keeps-state.ps1` | 升级保状态验收：按升级的方式交换 `app\` 后启动，断言 profile 与 `config.json` 未被改动 |
| `test\artifact-check.ps1` | 端到端：重编译 → 静默安装 → 跑预装插件验收 → 卸载 |
| `staging\` | 组装出的安装内容，每次完整构建会重建，可随时删除 |
| `cache\` | Node.js 官方校验和清单（历史遗留，校验现已改为读 `node-runtime.json`） |
| `dist\` | 最终安装包 |

## 内置插件

安装包自带三个插件，并在启动服务前自动把它们挂进插件树：

| 插件 | 版本 | 作用 |
|---|---|---|
| `dshmarket` | 见 `package-files\plugins\package.json` | 插件市场（[dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)） |
| `dsh-deepseek-quota-bar` | 同上 | 右下角额度卡片 |
| `dsh-data-manager` | 本仓库源码（`package-files\plugins\dsh-data-manager\`） | 设置 → 数据管理：看数据存在哪、占多少，并迁移到别的盘 |

前两个来自 npm，第三个是本仓库自己写的，**没有构建步骤**：host 半是普通 ESM（只用 node 内置模块），浏览器半直接按 `window.__ModuleLoader__.load({ id, factory })` 契约手写（`factory` 里 `require('react')`，`exports.apply` / `exports.inject`），注册进 `settings.plugins.tab`。构建脚本按**包名**（不是目录名）把它放进 `staging\plugins\node_modules\`，与 npm 装的那些并排——目录名和包名不一致时，用目录名会让 profile 解析不到。

### 数据管理插件为什么写 `config.json`

它**不**用 `dsh` 的 settings 命名空间存数据目录：设置项本身就存在数据目录里，拿它描述"数据目录在哪"是循环的。真正的权威是程序安装目录下的 `config.json`，启动器每次启动读它——所以插件直接改那个文件。它靠启动器导出的 `DSH_INSTALL_ROOT` 找到安装目录，找不到就退回从 `process.argv[1]` 逐级上溯（要求该目录同时有 `config.json` 与 `bin\dsh-app.mjs`）。

迁移只做「复制 + 校验文件数 + 改写 config + 提示重启」，不删原目录；目标是空目录或不存在。

### 为什么不用 `dsh plugin add`

`dsh plugin --profile web add <包>` 要在目标机器上跑 pnpm 并联网。预装的前提是「装上就有、不联网」，所以走的是另一条路：

1. 插件装在 **`plugins\`**（`app\` 之外），所以程序自我升级替换 `app\` 时不会被删掉；
2. 启动器把每个插件**复制**进 profile 自己的 `node_modules`（`%USERPROFILE%\.dsh\profiles\web\node_modules\<包名>`）——这正是 `dsh plugin add` 会装到的位置；
3. 启动器把插件写进 profile 清单：`dsh.profile.bundles` 加一层，`dependencies` 记一条 `^版本`。之后就是**普通的 bundle**，和用户自己装的一模一样。

用真 bundle 而不是旁路插入，是因为插件市场要靠 profile 清单判断「自己是不是已安装的插件」：`/dsh-market/status` 里的 `selfManaged` 取自 `dependencies`，为 `false` 时它不会给自己提供更新入口。实测预装后 `selfManaged=true`。

profile 不存在时（新电脑的第一次启动），启动器先让 `dsh` 自己把 profile 建出来：

```
<内置 node> app\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --dump-default-config
```

它按当前版本的模板写出 `package.json` / `cordis.patch.yml` / `cordis.yml` / `pnpm-workspace.yaml`（实测约 0.1 秒），启动器只往后追加自己的条目。这样模板永远跟着装的 `dsh` 走，不会在启动器里钉死一份可能过期的 bundle 列表。

### 为什么是复制，不是符号链接

Node 解析一个包的 import 时用的是它的**真实目录**，不是链接路径。实测（把 `pkg` 链接到 `link\node_modules`、依赖放在 `link\node_modules\peer`）：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'peer'
  imported from C:\...\esm-symlink-probe\real\pkg\index.js
```

所以链接回 `plugins\` 的插件看不到 `app\node_modules` 里的任何东西，而它自己在 `plugins\` 里的真实目录同样够不到安装的依赖树（`@deepseek-ai/schemastery` 这类 peer 就解析不到）。复制到 profile 后，父级查找依次经过 `profiles\web\node_modules` → `profiles\node_modules`（`dsh` 启动时建立的安装依赖闭包），因此插件拿到的是**同一份** `schemastery`、`js-yaml`、`undici`，不会出现模块双实例。

同理，构建时用 `npm install --install-strategy=nested --omit=peer`：依赖嵌在插件自己的目录里（复制插件时一起带走），peer 不安装（必须由安装提供，保证单实例）。

### 清单里只会出现「确实装得上」的插件

profile 清单里写了一个解析不到的 bundle，`dsh` 会**直接拒绝启动**。所以启动器给自己定了一条硬规则：**只有复制成功的插件才会被写进清单**，复制失败的会连同 `dependencies` 一起被摘掉，程序照常启动、只是少那个插件。

启动器只动自己写过的条目。它在 profile 目录里记一份 `.dsh-preinstalled.json`：

| 情形 | 行为 |
|---|---|
| 条目是本启动器加的，现在不在清单里了 | 用户自己删的（或市场里卸载的），记进 `declined`，**不再加回来** |
| 插件的源目录消失了（用户删了 `plugins\`） | 摘掉清单里的条目与依赖，程序照常启动 |
| 用户自己重新装上了（清单里又有这个名字） | 从 `declined` 里移出，按已安装对待 |
| 清单已经和要写的内容一致 | 一个字节都不写 |

实测这四条：首次启动写入三个插件；第二次启动清单哈希不变；手动移除一个后不再加回、另一个源目录消失时条目被摘掉且服务仍正常启动（10.1 秒）；源目录恢复并清掉状态文件后三个都回来。

### 要增删预装插件

改 `package-files\plugins\package.json`（版本）与 `package-files\plugins\preinstalled.json`（启用列表），然后重新构建。对已经装好的机器：改安装目录里的同名文件即可 —— 从 `preinstalled.json` 里删掉名字，下次启动启动器就会把对应条目从 profile 清单里摘掉。反过来，用户也可以直接在插件市场里卸载它，启动器不会再加回来。

插件版本就是 `plugins\package.json` 里钉住的那个；构建脚本会在装完后核对实际解析到的版本是否等于钉住的版本，不等就报错。

## Node.js 运行时固定

安装包**自带一份固定版本的 Node.js**，装好的程序只用这一份，不会去用目标电脑上装的那个。

### 为什么必须固定

`app\node_modules` 里带有为特定 Node 版本编译的原生模块（sharp、koffi、node-pty 等）。如果程序在 A 电脑上用自带的 Node 24 运行、在 B 电脑上退回到系统里的 Node 20，原生模块就会因 ABI 不符而加载失败——同一份安装包在不同电脑上表现不一致，正是"打开失败"的典型来源。

### 版本在哪里指定

只有一个地方：`node-runtime.json`。

```json
{
  "version": "24.21.0",
  "platform": "win-x64",
  "archiveSha256": "158f7685...",
  "pinnedFor": "deepseek-harness desktop launcher"
}
```

构建脚本据此推导压缩包文件名与下载地址、校验 SHA-256、解压，并把同一份信息写成 `runtime\node-runtime.json` 随包分发。要换版本，改这一个文件即可（记得同步 `archiveSha256`，取自 nodejs.org 的 `SHASUMS256.txt`）。

### 运行时是如何强制生效的

包内出现 `runtime\node-runtime.json` 就代表"这是一个正式安装包"，此时所有入口都**只**使用 `runtime\node\node.exe`：

| 入口 | 行为 |
|---|---|
| `bin\start.vbs` / `stop.vbs` / `update.vbs` | 固定运行时缺失时直接弹窗说明并退出，不再退回到系统 Node |
| `bin\run-server.vbs` | 只按固定路径启动服务 |
| `dsh.cmd` | 固定运行时缺失时打印错误并返回 1；不再退回 PATH 里的 `node` |
| `bin\dsh-app.mjs` | 启动前校验运行时存在且版本与清单一致；不一致或缺失会给出明确原因 |

修复前这些位置都是一条候选链（自带的 → `%ProgramFiles%\nodejs` → … → PATH 里的 `node`），任何一环缺失都会**静默换用别的 Node**，这正是要消除的不确定性。

源码安装（如 `%LOCALAPPDATA%\Programs\DeepSeekHarness`）没有清单也没有自带运行时，仍然允许使用系统 Node，本地开发不受影响。

### 会拦住的三类问题

| 情况 | 表现 |
|---|---|
| 运行时文件被杀毒软件删除或未完整复制 | 「内置的 Node.js 运行时缺失…请重新运行安装程序修复」 |
| 运行时无法执行（被拦截 / 架构不符） | 「内置的 Node.js 运行时无法执行（退出码 …）」 |
| 被另一个版本的 Node.js 覆盖 | 「内置 Node.js 版本不符：安装程序固定的是 v24.21.0，当前文件是 vX」 |

三种情况都返回非零退出码，并且**不会**退回到系统 Node 继续运行。

### `dsh.cmd` 为什么是纯 ASCII

`cmd.exe` 按 OEM 代码页解析批处理文件。UTF-8 的中文字节在该代码页下可能解码出 `|`、`&` 之类字符，把一行拆成几条乱命令——实测 UTF-8（带不带 BOM 都一样）会报 `'xxx' is not recognized`。因此 `dsh.cmd` 内的提示一律用英文；中文提示保留在所有 `*.vbs` 弹窗里（WSH 按 UTF-16 读取，不受影响）。

## 包内组成

| 内容 | 来源 | 说明 |
|---|---|---|
| `app\` | 本机应用目录 | `@deepseek-ai/dsh` 及其 517 个依赖，MIT |
| `runtime\node\` | nodejs.org 官方 win-x64 压缩包 | 版本见 `node-runtime.json`（当前 24.21.0），MIT，随包附带 |
| `runtime\node-runtime.json` | 构建脚本写入 | 固定版本的清单；入口据此判定"正式安装包"并强制使用自带运行时 |
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
| **内置 Node.js 版本** | `node-runtime.json` 的 `version` 与 `archiveSha256`（唯一来源） |
| **预装插件** | `package-files\plugins\package.json`（版本）与 `package-files\plugins\preinstalled.json`（启用列表） |
| 启动器行为 | `package-files\bin\dsh-app.mjs`（本仓库是它的唯一来源，不再从本机安装目录取） |
| 默认安装目录 / 记住上次位置 | `installer\DeepSeekHarness.iss` 的 `DefaultDirName` 与 `[Code] GetDefaultDirName` |
| 默认端口 | `package-files\config.json` 的 `port` |
| 应用图标 | 替换本机 `assets\dsh.ico` 后完整重建 |
| 更新内置的 dsh | 在本机 `app\` 目录执行 `npm install @deepseek-ai/dsh@latest`，再完整重建 |

## 用户数据放在哪

数据全部在一个目录里，默认 `%USERPROFILE%\.dsh`（会话、设置、凭据、附件、storages、profile 都在下面）。位置按下面顺序解析，**只解析一次**，由启动器决定后通过 `DSH_HOME` 显式传给服务进程：

| 优先级 | 来源 |
|---|---|
| 1 | `config.json` 的 `dataDirectory` |
| 2 | 环境变量 `DSH_HOME`（`dsh` 自己的约定） |
| 3 | `%USERPROFILE%\.dsh` |

"解析一次再传给服务"是关键：如果让服务自己读环境变量、启动器另算一遍，`config.json` 改了位置之后两边就会读不同的目录——插件的 profile 装在一个地方、服务在另一个地方读，表现成"插件没生效"。`dsh.cmd data` / `dsh.cmd status` 会打印最终目录与它来自哪一条。

改位置有两条路：界面里的 **设置 → 数据管理**（`dsh-data-manager`，会先复制再改配置），或手动停服务 → 复制 `.dsh` → 改 `dataDirectory` → 启动。

## 首次启动失败：现在的处理

首次安装后的第一次启动，一直出现「弹一堆 `Cannot find package … imported from …\profiles\…`，手动再点一次就正常」。第二份日志（这一版已经带 4 秒退避重试）把结论钉死了：

```
15:42:29.721 正在启动 DeepSeek Harness…
15:42:34.933 插件解析失败，已重建 profile 模块索引（清理 2 个目录），第 1 次重试…   ← 4 次全失败
15:42:44.053 …第 2 次重试…
15:42:57.028 …第 3 次重试…
15:43:21.425 正在启动 DeepSeek Harness…      ← 用户手点，24 秒后
15:43:34.859 已就绪
```

也就是说：**自动的 4 次尝试在 ~27 秒内全部失败，而约 1 分钟后手动启动一次就成功**；不是"重试一次就够"，而是这个窗口有几十秒。同一份日志还证明索引本身是好的——最后一次重试重建出的 `profiles/node_modules` 有完整的 186 项，canary 包读得到，可当时的启动仍然失败，说明问题在"这一刻读不到那些文件"，而不是索引缺项。

我做三件事：

| 环节 | 行为 |
|---|---|
| **启动前预检** | 若 `profiles\node_modules` 已存在，就**读**该索引里任一包的 `package.json`：读得到才启动。读不到就每秒重试，最多等 45 秒（首启没有索引时跳过——那时由服务自己建）。这直接测的是"loader 到底能不能解析"；`Test-Path` 测不出来（路径在、文件读不了），而只认某一个固定包名会在将来改名时变成每次启动都空等。 |
| **等待后重建** | 预检等满 45 秒仍读不到，就删掉索引让服务重建，而不是继续撞同一堵墙 |
| **拉长重试** | 失败后按 **3/6/10/15/20/25/30 秒** 重试（共 7 次，约 2 分钟），每次前先等端口真正释放，再重建索引 |

我仍然**没有复现出最初的触发条件**（同路径覆盖安装 + 再启动，反复测都正常，多半是这台机器的文件已被 Defender 缓存过），所以这版修法针对的是**已被两份日志证实的事实**：失败窗口是几十秒量级，且与文件可读性有关。配套的启动窗口（见下）会把每一次重试都显示出来，用户看到的是"在重试"，而不是一句"启动失败"。

## 启动窗口：应用图标 + 当前阶段

启动窗口是应用图标加一行状态文字，读 `run\boot-status.txt`（启动器每次阶段变化**覆盖**写一行）：

| 阶段文字 | 时机 |
|---|---|
| `开始启动 DeepSeek Harness` | 进入 `start()` |
| `检查内置 Node.js 运行时（…）` | 校验固定运行时 |
| `同步随包插件…` | 把 `plugins\` 里的插件写进 profile |
| `启动服务进程…` | 拉起 `run-server.vbs` |
| `等待服务就绪…（已 N 秒）` | 就绪轮询期间每 3 秒更新 |
| `启动未完成，N 秒后重试（第 K 次）…` | 重试退避期间 |
| `启动完成：http://…` | 就绪 |

窗口与升级进度窗口共用 `showStatusWindow()`：`assets\dsh-256.png`（缺失时退到 `dsh.ico`）+ 标题 + 阶段文字 + 已等待秒数。图标是静止的，动的是那行秒数。

窗口只在快捷方式启动那次出现（`--splash`），`dsh.cmd start`、重启、升级后的健康检查都不显示窗口，也不写状态。

**这一版去掉了上一版的实时模块列表**：那套东西靠 `bin\boot-trace.mjs` 给服务加 `--import`、用 loader resolve 钩子把每个解析到的模块写进文件（一次启动 1200+ 行）。实测成本可以接受（逐条写文件 19.1s，改成 250ms 批量落盘后 13.9s，不开 13.3s），但用户要的只是"知道它在跑"，滚动日志反而是噪音。所以钩子、`--import` 参数、`DSH_BOOT_PROGRESS` 环境变量**整套删掉**了——留着就是没人用的死代码。也试过 `NODE_DEBUG=esm`：25.8 秒、209 MB / 290 万行 stderr，本来也不可用。

## 升级进度窗口

点「立即升级」后三选一对话框立刻关闭，所以以前是"什么都没有"地等上几分钟。现在立刻弹出升级窗口，可**最小化**（升级期间应用照常能用，用户要能把它挪开），实时显示阶段：

| 阶段文字 | 时机 |
|---|---|
| `正在准备升级到 x.y.z…` | 弹窗时 |
| `正在从 <源> 下载 x.y.z…` | 每个 npm 源开始尝试时 |
| `已下载 x.y.z，正在替换程序文件…` | 下载校验通过 |
| `正在停止服务…` / `正在替换程序文件…` | 目录交换前后 |
| `正在验证新版本（会先启动一次）…` | 健康检查 |
| `已升级到 x.y.z，正在打开界面…` | 成功 |
| `新版本无法启动，正在回滚…` / `已回滚到升级前的版本。` | 失败与回滚 |
| `下载失败，保留当前版本。` | 全部源失败 |

细节：结论行在屏幕上停 4 秒再关窗；窗口自动关闭上限 1 小时（升级可能几分钟以上）；`dsh.cmd update --yes` 不弹窗（无人值守，没人看），只写 `run\upgrade-status.txt`。

窗口用的是普通单行边框而不是工具窗口边框——**工具窗口边框不显示最小化按钮**，且 `ShowInTaskbar` 必须为真，否则最小化后没有回到它的入口。

## 升级通道：为什么以前总说"已是最新版本"

用户截图：GitHub 上已经有 `dsh-v0.1.5-rc.2`、`dsh-v0.1.6-alpha.1`，而"检查更新"说"当前版本 0.1.5-rc.1 / 最新版本 0.1.5-rc.1 / 已是最新版本"。

查证（四个 npm 源口径一致，`@deepseek-ai/dsh`）：

```
dist-tags: {"latest":"0.1.5-rc.1","next":"0.1.5-rc.2","alpha":"0.1.6-alpha.1"}
versions : 21 个，最新四个 … 0.1.5-alpha.2, 0.1.5-rc.1, 0.1.5-rc.2, 0.1.6-alpha.1
```

**根因**：旧代码只读 `packument['dist-tags'][CHANNEL]`，而 `config.json` 的 `channel` 是 `latest` —— 上游发布 rc.2 / alpha.1 后**没有移动 `latest` 标签**（新版本挂在 `next`、`alpha` 上）。所以程序"正确地"报告 `latest` 就是 rc.1；技术上没错，对用户完全没用。它不是坏在网络、也不是坏在下载。

**改法**：

| 改动 | 说明 |
|---|---|
| `fetchChannelVersion` → `fetchPackument` | 一次请求同时取回 `dist-tags` **和完整版本列表**（abbreviated packument 本来就带 `versions`） |
| 新增 `channel: newest`（**新默认**） | 取所有已发布版本里 semver 最高的一个，不再依赖上游何时移动标签 |
| `latest`/`next`/`alpha`/具体版本号 | 仍然可用：命中 dist-tag 就用它，否则按"已发布的具体版本"匹配 |
| 通道写错 | **明确报错**并列出可用通道与各自版本，退出码 1，不静默退回默认 |
| 报告与弹窗 | 列出**每个通道当前指向哪个版本**，所以即使固定在 `latest` 也能看到 `next`/`alpha` 上有更新的东西 |

实测（`dsh-app.mjs check`，隔离的假 root，真实 npm 源）：

| `channel` | 输出 |
|---|---|
| `newest` | 解析为 `0.1.6-alpha.1`，**发现新版本，可以升级** |
| `latest` | 解析为 `0.1.5-rc.1`，已是最新 + 列 `alpha 0.1.6-alpha.1`、`next 0.1.5-rc.2` |
| `0.1.5-rc.2` | 解析为该版本，可以升级 |
| `stabel`（打错） | 退出码 1，`config.json 里的 channel 无法识别：stabel` + 可用值 |

下载路径也验过：`npm install @deepseek-ai/dsh@0.1.6-alpha.1` 能完整解析出依赖树（在受限沙箱里只因 npm 要 spawn 生命周期脚本而被拦，属于测试环境限制，不是产品问题）。

## 再次安装记住上次的位置

`installer\DeepSeekHarness.iss` 用了两个记忆：

1. **Inno 自带的 `UsePreviousAppDir=yes`**：读 Windows 卸载项里的 `InstallLocation`。实测有效——静默装到 `%TEMP%\dsh-prev-A` 后，不带 `/DIR` 再装一次，仍然落在 A，默认目录根本没被创建。
2. **自己的标记 `HKCU\Software\DeepSeek Harness` → `InstallDir`**：`{code:GetDefaultDirName}` 读它。

为什么需要第二个：本机 `D:\Application\DeepSeek Harness` 这份安装**在注册表里没有卸载项**（`{398B587A-…}_is1` 不存在），于是第一处什么都不知道，只能回到默认目录——这正是"每次都要重选位置"的成因，多半是清理软件把卸载项当垃圾清掉了。标记写在自己的键下，不跟卸载项一起被扫走；卸载时用 `uninsdeletekey` 清掉，所以"卸载后再装"会重新问位置，而"覆盖安装/更新"会回到原处。

标记指向的目录必须还有 `unins000.exe` 才会被采用，避免被手动删掉安装目录后仍被带进一个空壳路径。`/DIR="..."` 仍然优先于两者。

顺带补了一个开始菜单的「卸载 DeepSeek Harness」：卸载项被清掉时，"应用和功能"里找不到它，至少还有一条能走的路。

## 官方升级不能动的东西

应用内的升级（开始菜单 →「检查更新」或启动后的自动提示）做的是**目录交换**，不是重装：

```
1. npm 把新版本装到 <root>\update\app      ← 全新目录
2. 停服务
3. app\ → app.previous\，update\app\ → app\   ← 只换 app\
4. 启动做健康检查，失败就把 app.previous\ 换回来
```

所以下面这些**物理上不在 `app\` 里**，升级不碰：

| 内容 | 位置 | 升级后 |
|---|---|---|
| 启动器、VBS 入口、构建期生成的脚本 | `bin\` | 不变（启动器所有修复都在这里） |
| 预装插件（市场 / 额度卡片 / 数据管理） | `plugins\` + profile 里的副本 | 不变，仍是 profile 的 bundle |
| 数据目录选择、端口、npm 源、发布通道 | `config.json` | 不变 |
| 会话、设置、API Key、市场里装的插件 | 数据目录（默认 `%USERPROFILE%\.dsh`） | 不变 |
| Node 运行时 | `runtime\` | 不变 |

profile 的模块索引（`~/.dsh/profiles/node_modules`）是指向 `app\node_modules\...` 的 junction，交换 `app\` 后**路径不变、内容变新**——这正是想要的：索引无需重建，插件通过它拿到的就是新版本的核心包。

唯一无法承诺的是"新版本不改变插件 API"：那取决于官方。预装插件里市场能自己更新；`dsh-data-manager` 只依赖 `webServer` 服务与客户端 slot 契约，是本仓库自己维护的，需要时随安装包一起升级。

实测（见 `test/upgrade-keeps-state.ps1`）：按上面的顺序交换 `app\` 后启动，三个插件仍在 profile 的 `bundles`/`dependencies` 里、仍在启动清单里，`config.json` 与数据目录不变。

## 启动耗时

用 `test\startup-probe.ps1` 在隔离的 `DSH_HOME` 上实测（同一台机器，`D:\Application\DeepSeek Harness`，Node v24.21.0）：

| 场景 | 从起进程到服务就绪 |
|---|---|
| 全新 `DSH_HOME`（另一台电脑的首次启动） | 9.6 秒 |
| 已有 `DSH_HOME`（模块索引无需重建） | 8.4 秒 |
| 模块索引指向一个已删除的安装目录 | 10.9 秒 |
| 全新 `DSH_HOME` + 三个预装插件（含建 profile 与一次约 6 MB 复制） | 11.8 秒 |

启动开关里**没有**联网动作：版本检查跑在服务就绪之后、独立的子进程里（`dsh-app.mjs notify-update`），所以源慢或不通都不会让界面晚出现。早期版本是在服务起来之前同步检查的，那才是「装完启动特别慢」的来源。

启动器自身只占很小一段：`runtimeProblem()` 起一次 `node --version`（约 0.02 秒）；真正贵的是 `Get-NetTCPConnection` 查监听进程（约 1.3 秒），它现在排在「已就绪」之后，不再拖慢用户看到就绪的时间。

## 实现要点与踩过的坑

### 黑色命令行窗口的来源

**根因是 `detached`。** Node 在 Windows 上会给 `detached: true` 的子进程**分配一个自己的控制台窗口**，而且 `CREATE_NO_WINDOW`（即 `windowsHide`）与 `DETACHED_PROCESS` 同时指定时会被忽略。于是 Harness 服务进程持有一个**可见的控制台**，它启动的每个子进程（agent 每执行一次 shell 命令都会起一个 job runner）都继承这个控制台——Windows Terminal 便时不时弹出黑色窗口。

对照实验（起一个 15 秒的探针进程，统计可见控制台窗口数量）：

| 启动方式 | 新增可见控制台 |
|---|---|
| `detached: true` + `windowsHide: true` | **+1**（标题为 node.exe 路径） |
| `detached: false` + `windowsHide: true` | 0 |

但直接去掉 `detached` 不可行：实测**非 detached 的子进程会随启动器一起退出**，服务活不下来。

**解法**：服务改由 `bin\run-server.vbs` 启动，脚本内用 `WshShell.Run(cmd, 0, False)`。窗口样式 0 让服务获得**自己的、隐藏的**控制台，同时它与脚本相互独立、可以长期存活；输出仍用 `cmd /c ... >> logs\dsh-web.log 2>&1` 重定向。这样既保住独立性，又让 agent 的子进程继承一个隐藏控制台，不再申请新的可见窗口。

`openBrowser` 与升级提示进程也一并去掉了 `detached`（浏览器那步只是 `cmd /c start`，不需要独立进程组）。

### VBS 读 UTF-8 会乱码

`FileSystemObject.OpenTextFile` 只支持 ANSI 和 UTF-16，没有 UTF-8 模式。启动器写的是 UTF-8，脚本按系统代码页（GBK）读出来就是 `褰撳墠鐗堟湰`。改用 `ADODB.Stream`（`Charset = "utf-8"`）——这是 Windows Script Host 里唯一能正确读 UTF-8 的途径。

### `windowsHide` 会把对话框一起藏掉

`spawnSync(..., { windowsHide: true })` 给子进程设置 `STARTF_USESHOWWINDOW` + `SW_HIDE`，WinForms 窗体第一次 `ShowWindow` 会继承它，于是对话框被创建、`ShowDialog()` 正常阻塞，但**永远不可见**（进程 `MainWindowHandle` 为 0）。改为 `windowsHide: false` + PowerShell 自己的 `-WindowStyle Hidden` 抑制控制台即可。这个问题很隐蔽：日志、退出码全部正常，只有去读窗口句柄才能发现。

另外弹窗超时不能沿用默认的 120 秒——用户还没点，对话框就被杀掉（会被当成「以后再说」）。升级询问用 12 小时上限。

## 分发注意事项

- **Windows SmartScreen**：安装包没有代码签名，对方首次运行会看到「已保护你的电脑」的蓝色提示，需要点「更多信息 → 仍要运行」。
- **API Key**：程序不含任何密钥。对方需要自己准备 DeepSeek API Key，首次打开后在界面设置里填写，保存在其本机的 `%USERPROFILE%\.dsh`。
- **数据隔离**：每个用户的数据都在自己的 `%USERPROFILE%\.dsh`，互不影响。
- **许可证**：`@deepseek-ai/dsh` 与 Node.js 都是 MIT，可以再分发；各自的 LICENSE 文件已随包保留，`THIRD-PARTY-NOTICES.md` 做了汇总。
- **商标**：「DeepSeek」名称与鲸鱼标识属于 DeepSeek。对内部分发通常没问题，对外公开发布前请确认商标使用授权。

## 已验证项

在隔离目录上做过完整的「静默安装 → 启动 → 停止 → 卸载」验证：

| 项目 | 结果 |
|---|---|
| 静默安装 / 卸载 | 退出码 0；卸载后目录、快捷方式、注册表项全部清除，无残留 |
| 内置 Node.js | `runtime\node\node.exe --version` → v24.21.0 |
| 实际运行进程 | `runtime\node\node.exe ...\dsh\lib\bin.js web --port <端口>`，系统 Node 完全未参与 |
| **不依赖 PATH** | 把 PATH 缩到只剩 `C:\Windows\System32`，仍能启动并加载全部插件 |
| **缺失运行时不回退** | 改名 `node.exe` 后：`dsh.cmd` 打印英文错误并返回 1；启动器报「内置的 Node.js 运行时缺失」；均未使用系统 Node |
| **版本不符会拦截** | 把清单改成 22.11.0 后：报「固定的是 v22.11.0，当前文件是 v24.21.0」并返回 1 |
| **预装插件** | 三个插件都写进 profile 的 `bundles`/`dependencies`、都在前端启动清单里，市场报告 `selfManaged=true` |
| **升级保状态** | 按升级的方式交换 `app\` 后启动：profile 与 `config.json` 不变，插件照常加载 |
| **真实升级** | 点「立即升级」后 168 秒完成，版本从 0.1.5-rc.1 变成 0.1.6-alpha.1，插件在 alpha 上仍正常 |
| **不再弹出黑窗** | 启动前后可见控制台窗口数量 delta = 0 |

## 备选：免安装压缩包

如果对方不方便运行 exe，可以直接把 `staging\` 打成 zip 发过去：解压后双击 `bin\start.vbs` 即可运行，脚本会按自身所在位置定位文件，不依赖安装过程。代价是没有开始菜单项、桌面图标和卸载程序。
