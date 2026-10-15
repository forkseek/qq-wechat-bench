# qq&wechat bench 发布包

版本：0.5.2。GitHub 仓库：`forkseek/qq-wechat-bench`，私有。

源码包包含完整程序源码、界面、启动脚本、公共 JSON 配置、依赖锁文件、测试、第三方许可证和验收报告。`data/`、真实 `.env`、`node_modules/`、登录资料、聊天数据库和模型密钥不进入 GitHub；`.env.example` 是空配置示例。历史规划文档中的真实实验群号已替换为占位符。

## 在 Windows 上首次运行源码包

1. 安装 Node.js 24 或更高版本，进入 `qq-workbench` 文件夹运行 `npm.cmd ci`。
2. 双击“打开工作台.cmd”，或运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1`，页面默认位于 `http://127.0.0.1:4318/`。
3. 如需微信接入，运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-wechat.ps1`，下载固定版本的独立 Python 与已审查的组件，然后正常登录桌面微信。
4. 如需 QQ 独立采集，按 NapCat 上游固定版本说明准备本地组件。源码包不包含 NapCat 二进制和原账号登录资料；程序仍保留桌面 QQ 优先规则。桌面接入补丁不会在安装或启动时自动执行。
5. 在“接入设置”配置自己的模型服务，在会话管理中选择要保存和整理的群。原用户的模型密钥和已关注群不会随源码包迁移。

开发验证：`npm.cmd test` 与 `npm.cmd run check`。本版本验收详情见 `docs/最终兼容性与稳定性验收-2026-10-15.md`。

## 本机完整备份

同批生成的 `qq-wechat-bench-v0.5.2-local-full-*.zip` 仅保存在原电脑，包含完整项目、依赖、第三方运行时、原账号配置、消息与附件。它含有私有数据，不作为 GitHub 附件。主工作台 SQLite 使用在线一致性快照替换，运行中的 WAL/SHM 和 PID 等临时文件不写入备份；其他缓存按打包时读取的内容保留。无需为打包退出桌面 QQ 或微信。

完整备份用于原机恢复。恢复前关闭工作台，再解压到独立目录并核对原来的路径依赖；QQ、微信和第三方组件仍受固定客户端版本限制。完整备份不是无需依赖的 EXE 安装器。

`PACKAGE-MANIFEST.json` 记录源码文件的 SHA-256，外层 `SHA256SUMS.txt` 记录 ZIP 校验值。
