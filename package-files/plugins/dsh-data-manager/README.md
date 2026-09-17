# dsh-data-manager

DeepSeek Harness 的「数据管理」设置页。

## 它做什么

应用的所有用户数据——会话、设置、API Key、附件、storages、插件 profile——都在**一个目录**里（默认
`%USERPROFILE%\.dsh`）。这个插件在 **设置 → 插件 → 数据管理** 里把它显示出来，并允许把它整体迁移到
另一个盘（例如 `D:\dsh-data`），避免长期使用后占满系统盘。

| 能力 | 说明 |
|---|---|
| 查看 | 当前位置、由谁决定（`config.json` / 环境变量 / 默认）、占用大小、文件数、一级子目录明细 |
| 迁移 | 复制到新目录（跳过符号链接/junction，这些是 dsh 每次启动按当前安装重建的索引），校验文件数，再改写程序目录下的 `config.json` 的 `dataDirectory` |
| 重启 | 迁移完成后一键重启应用，让新位置生效 |

## 设计约束

- **写 `config.json`，不写自己的设置项**：设置项本身存在数据目录里，用它来描述数据目录在哪儿是循环的。
  真正的权威是程序安装目录下的 `config.json`，启动器每次启动读它。
- **只复制，不删除**：迁移完成后旧目录原样保留，确认新位置可用后由用户自行删除。目标目录必须是空目录或不存在，
  避免和已有数据混在一起。
- **不复制 junction**：`profiles/node_modules` 是指向安装目录的 junction 农场，跟着它复制会把整个应用复制进来。
- **重启走启动器**：重启必须比它停掉的进程活得更久，所以通过 `wscript` + 生成的 `run\restart.vbs` 调
  `bin\dsh-app.mjs restart`，和本安装包其它入口用的是同一套「隐藏控制台」技术。

## 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-data/status` | 当前数据目录、来源、占用与迁移进度 |
| POST | `/dsh-data/migrate` | `{ target, removeSource? }`，开始一次迁移 |
| POST | `/dsh-data/restart` | 重启应用 |

只监听本机回环地址，与 Web 界面同源，因此沿用同一份会话凭据。
