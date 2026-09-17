# 第三方组件声明

本安装包分发以下第三方软件。完整许可证文本随各自组件保留在安装目录内。

## @deepseek-ai/dsh 及其依赖

- 版本：0.1.5-rc.1
- 许可证：MIT
- 主页：https://github.com/deepseek-ai/deepseek-harness
- 许可证文本：`app\node_modules\@deepseek-ai\dsh\LICENSE`
- 依赖树中每个 npm 包的许可证文本均保留在其自身目录下（`app\node_modules\<包名>\LICENSE`）。

## Node.js

- 版本：随包附带的版本见 `runtime\node\node.exe --version`
- 许可证：MIT
- 主页：https://nodejs.org/
- 许可证文本：`runtime\node\LICENSE`

Node.js 官方二进制包中附带的第三方组件声明见 `runtime\node\LICENSE` 及其同目录下的相关文件。

## dshmarket（插件市场）

- 版本：1.47.0
- 许可证：MIT
- 主页：https://github.com/dsh-market/dsh-market
- 许可证文本：`plugins\node_modules\dshmarket\LICENSE`

## dsh-deepseek-quota-bar（额度卡片）

- 版本：0.6.1
- 许可证：MIT
- 主页：https://www.npmjs.com/package/dsh-deepseek-quota-bar
- 许可证文本：`plugins\node_modules\dsh-deepseek-quota-bar\LICENSE`

## 预装插件的依赖

`plugins\node_modules` 下随插件一起安装的依赖（如 `js-yaml`、`undici`）各自保留自己的
许可证文本，位于其自身目录下。固定版本见 `plugins\package.json`。

