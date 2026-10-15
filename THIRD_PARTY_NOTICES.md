# 复用项目与固定版本

本次扩展沿用现有 OneBot / SQLite 架构，优先复用已审查的开源组件。接入组件、数据库、密钥、日志、媒体及备份均位于 Git 忽略的 `data/`，不发布用户聊天。

| 组件 | 固定版本 | 来源与许可证 |
| --- | --- | --- |
| wechatauto-replica | 1.2.6.1，提交 `62503d76a0db069171cb4e42e87090ad285db489` | [GitHub](https://github.com/fanyuantaier/wechatauto-replica/tree/62503d76a0db069171cb4e42e87090ad285db489)，Apache-2.0；完整许可证见 `docs/licenses/wechatauto-replica.txt` |
| Pino | 10.4.0 | [GitHub](https://github.com/pinojs/pino)，MIT；见 `docs/licenses/pino.txt` |
| node-cron | 4.6.0 | [GitHub](https://github.com/node-cron/node-cron)，ISC；见 `docs/licenses/node-cron.txt` |
| NapCatQQ | 4.18.37，既有 Shell；Framework 为待授权候选 | [固定发布页](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.37)，许可证以原项目为准；保持上游发布包不变 |
| QQ 桌面校验函数模式 | 固定 x64 模式，本机单一匹配 | [Mzdyl 公开安装源码](https://github.com/Mzdyl/LiteLoaderQQNT_Install/blob/main/install_windows.py)；仅复用签名定位方法，不运行其一键安装器 |
| Python | 3.12.10 独立运行时 | [官方 NuGet 包](https://www.nuget.org/packages/python/3.12.10)，不修改系统 Python；包哈希固定在 `setup-wechat.ps1` |

工作台自有适配器通过进程内配置关闭 SDK 默认日志，限制私有缓存位置，并补充活跃账号验证、跨分片消息去重、显示名歧义检查和发送结果回读。未修改上游 SDK 源码。Python 依赖固定在 `requirements-wechat.txt`，Node 依赖固定在 `package-lock.json`。
