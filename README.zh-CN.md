# dsh-think-summary

[English](README.md) | [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/@drifter-yh/dsh-think-summary)](https://www.npmjs.com/package/@drifter-yh/dsh-think-summary)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/dsh-0.2.2--rc.1-4D6BFE)](https://github.com/deepseek-ai/deepseek-harness)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的插件：把每一步的
思考原文压成 **1–3 条中文要点**，30 分钟的长任务也能一眼扫完；想看原文，点开还是完整思维链。

> 社区插件，非 DeepSeek 官方产品，不受官方维护。

## 解决什么问题

Harness 显示的是模型的**原始**思维链。长任务里就是这个样子：

- 折叠态：只有一行没什么信息量的摘录，外加「执行了命令、已读取文件、已搜索代码」这类步骤清单；
- 展开态：几千字的意识流，顺序还是模型想到哪写到哪。

Codex 看起来舒服，是因为它显示的是**模型自己产出的摘要**（OpenAI 的 reasoning summary 通道）。
DeepSeek 没有这个通道，想得到同样的体验，只能本地再生成一层——每步多一次便宜的模型调用。

## 装上是什么样

装之前：

```text
› 思考   The user reports a UI issue after the latest changes: a message shows raw
         evidence (the fallback) at the front, trace panel shows 24 tools…
```

装之后：

```text
› 思考 · 摘要
  • 根因：后端在推送 final 事件前先做记忆抽取，把客户端卡住，只能回退展示原始证据
  • 计划：先推 final 再封存、给记忆抽取加 12 秒超时、修续跑逻辑跳过孤立用户消息
  • 还差事件顺序与超时行为的测试
```

点这一行展开，仍然是原来的完整思考，Markdown 渲染不变。

## 安装

```bash
dsh plugin --profile <你的 profile> add @drifter-yh/dsh-think-summary
```

有些构建在 **设置 → 插件** 里带插件目录，也可以在那里安装；否则用上面的命令。

装完需要**重启一次 Harness**：宿主半边是以模块形式加载的，不支持热替换。

## 配置

配置写在你 profile 的 `cordis.patch.yml`（或插件配置面板）：

```yaml
- id: think-summary
  name: '@drifter-yh/dsh-think-summary'
  config:
    provider: opencode-go          # 任意已注册的模型路由
    model: deepseek-v4.1-flash     # 用便宜、快的模型
    enabled: true                  # 总开关；false 完全不调模型
    maxOutputTokens: 2000          # 推理 + 正文的总预算
    maxInputChars: 6000            # 超长思考留头留尾截断
    maxCallsPerSession: 300        # 单会话成本上限
    maxCallsTotal: 600             # 单进程成本上限
```

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关，关掉后只保留界面、不调模型 |
| `provider` / `model` | `opencode-go` / `deepseek-v4.1-flash` | 用来做摘要的路由 |
| `maxInputChars` | `6000` | 超过就留头留尾截断 |
| `maxOutputTokens` | `2000` | 单次补全预算 |
| `timeoutMs` | `25000` | 单次超时 |
| `minChars` | `160` | 更短的思考不值得花一次调用 |
| `maxCallsPerSession` / `maxCallsTotal` | `300` / `600` | 硬性成本上限 |
| `cacheFile` | `~/.dsh/storages/think-summary/cache.json` | 落盘缓存位置 |

应急开关：浏览器控制台执行
`localStorage.setItem('dsh-think-summary.enabled','false')`，当前页面立刻停止请求，不用改 profile。

## 原理

```text
浏览器                                               宿主进程
┌───────────────────────────┐   POST /summarize   ┌──────────────────────────────┐
│ 遮蔽 assistant-step 渲染器 │ ──────────────────▶ │ ctx.llm.stream()             │
│ 折叠态 → 要点列表         │ ◀────────────────── │   用配置的 provider/model     │
│ 展开态 → 原始思考         │     1–3 条要点       │ 内容指纹缓存 + 预算闸门       │
└───────────────────────────┘                     └──────────────────────────────┘
```

- 客户端以 `priority: -1` 注册 `conversation.chat.node` 的 `assistant-step`，
  块过滤规则与出厂一致（`groupPart`、`text`/`reasoning`/`image`，工具调用仍是独立节点）。
- 只在**一步结束**时请求摘要，流式中不打断。
- 摘要以（截断后）思考文本的 SHA-1 为键，同样的内容只计费一次，重启后仍命中缓存。
- 任何失败（没有可用路由、超时、输出被截断、模型没给要点）都退回原来的一行摘录，
  装插件不会让转录比出厂更差。

## 成本与延迟

每步一次便宜调用。用 `deepseek-v4.1-flash` 时，单步通常 3–20 秒、几千输入 token，
输出只有三行。40 步的任务在多数路由上花费不到「一块钱」量级——但这是**付费**功能，
所以上面那些预算上限是刻意留的。

超过 3 小时的步骤不做回填，打开旧会话不会触发一批调用。

## 隐私与安全

- 思考文本只发给你配置的 provider，也就是本来就在跑这个会话的那个 provider。
- 摘要缓存在本地 `~/.dsh/storages/think-summary/cache.json`。
- HTTP 端点（`/dsh-think-summary/*`）只接受回环连接，请求体上限 512 KB，
  `summarize` 必须是 POST，同时最多两个模型调用。
- 没有遥测、没有埋点，除模型请求外不产生任何外连。

## 兼容性

- Harness `>=0.2.2-rc.1 <0.2.3-0`，已在 `0.2.2-rc.1` 的 desktop profile 实测（它跑的就是同一套 Web 客户端）。
- 插件遮蔽了出厂的 `assistant-step` 渲染器。Harness 改动节点契约可能导致渲染异常；
  渲染器外层有错误边界，最坏退回纯文本。

## 已知限制

- 助手正文里的**文件提及**（`@路径`）暂时按纯文本显示。
- **只出中文要点**，多语言还没接。
- 有些路由只提供 `low/high/max` 三档、关不掉思考，所以 `maxOutputTokens` 必须留够预算，
  默认 2000 就是这么来的。
- **历史不回填**（3 小时窗口），为了保证成本可预期。
- 工具调用仍由 Harness 自己渲染，插件只接管 `assistant-step`。

## 排查

| 现象 | 检查 |
| --- | --- |
| 完全没有要点 | 插件启用了吗？`curl http://127.0.0.1:<端口>/dsh-think-summary/status` |
| 返回 `skipped: budget` | 调大 `maxCallsPerSession` / `maxCallsTotal` |
| 宿主日志出现「摘要输出超长」 | 调大 `maxOutputTokens` 或调小 `maxInputChars` |
| 升级 Harness 后失效 | 提 issue，附上 Harness 版本与控制台报错 |

## 开发

```bash
node --check index.js
node --check client.js
npm pack --dry-run
```

发布走 GitHub Actions：推 `v*` tag 触发 `.github/workflows/release.yml`，带 npm provenance，
需要在仓库里配置 `NPM_TOKEN` secret。

宿主半边是 Cordis 插件（`apply(ctx, config)`），客户端半边是
`window.__ModuleLoader__.load` 注册的 ESM 模块。

## 许可证

MIT，见 [LICENSE](LICENSE)；第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
