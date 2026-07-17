# LLM-Wiki Knowledge Fusion

> **免费的 AI 文献批量自动精读工具包** — 无需 API Key，零成本
>
> 用豆包 / 千问 / DeepSeek **网页版**的免费额度，批量自动精读 PDF 文献，产出结构化笔记，再融合成可检索、可视化的三层知识库。

```
PDF 文献库（几十~几千篇）
   │
   ▼  ① 浏览器自动精读脚本（本仓库 uploaders/，油猴脚本 × 3）
豆包 / 千问 / DeepSeek 网页版
   │  自动上传 → 自动输入精读 Prompt → 等待回答 → 质量校验 → 自动保存 .md
   ▼
7 段结构化精读笔记
   │
   ▼  ② llm-wiki-knowledge-fusion Skill（本仓库 skill/）
L1 LLM-Wiki（Obsidian）── concepts / entities / methods / comparisons / synthesis
   │
   ▼  单向同步
L2 GBrain 图谱索引（实体摘要 + Wiki 链接）
```

**为什么免费**：不调用任何付费 API。脚本直接驱动 AI 平台的网页版对话，你平时怎么免费用，它就怎么帮你批量自动用。

## 仓库内容

| 目录 | 内容 |
|------|------|
| [`uploaders/`](uploaders/) | **核心：三个浏览器自动精读脚本**（Tampermonkey `.user.js`） |
| [`skill/llm-wiki-knowledge-fusion/`](skill/llm-wiki-knowledge-fusion/) | 知识融合 Skill 源码（SKILL.md + 参考文档 + 脚本 + 模板） |
| [`dist/`](dist/) | 打包好的 `.skill` 文件（也可从 Release 下载） |
| [`docs/RELEASE_NOTES.md`](docs/RELEASE_NOTES.md) | 发布说明 |

## ① 浏览器自动精读脚本

| 脚本文件 | 平台 | 版本 | 技术特色 |
|------|------|------|------|
| [`doubao-pdf-uploader-pro.user.js`](uploaders/doubao-pdf-uploader-pro.user.js) | [豆包](https://www.doubao.com) | 4.5.0 | SSE 流拦截 + MutationObserver 加速完成判定、平台默认总结按钮模式 |
| [`qianwen-pdf-uploader-pro.user.js`](uploaders/qianwen-pdf-uploader-pro.user.js) | [千问](https://www.qianwen.com) | 4.0.0 | `showOpenFilePicker` 劫持注入文件、网络拦截 + DOM 双通道取回答 |
| [`deepseek-pdf-uploader.user.js`](uploaders/deepseek-pdf-uploader.user.js) | [DeepSeek](https://chat.deepseek.com) | 1.0.0 | 自适应 DOM 探测、深度思考模式开关、思考链内容排除 |

### 共同能力

- **批量队列**：选择文件夹（File System Access API）或拖拽 PDF，跨会话断点续传
- **Prompt 轮换**：多角色变体（博士后 / 资深研究员 / 博士生 / 期刊审稿人 / 行业研发）自动轮换，降低回答同质化（豆包 / DeepSeek 版内置 5 种，千问版内置 2 种）
- **配置即注释**：所有默认参数（上传间隔、等待时间、冷却策略等）集中在脚本开头，逐项中文注释，也可在面板中随时调整
- **回答质量校验**：长度 / 拒答模式检测；无效回答自动进入冷却期，冷却后用日常问题唤醒再继续
- **自动保存**：回答保存为 `原PDF名_文献标题.md`（浏览器下载目录），同时复制到剪贴板兜底
- **时间窗口**：只在设定时段运行（例如 08:00–22:00），窗口外自动暂停
- **持久化日志**：导出 / 导入进度报告，换电脑、清缓存后也能恢复进度
- **精细控制**：按序号上传（`1,3,5-10`）、点选上传、一键重试全部失败项

### 安装（3 步）

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展（Edge / Chrome）
2. 打开 [`uploaders/`](uploaders/) 中对应平台的 `.user.js` → Tampermonkey 自动提示安装
3. 访问对应 AI 平台网页版并登录，页面右上角出现控制面板：选择 PDF 文件夹 → 调整上传间隔 → **▶ 开始**

### 内置精读 Prompt

内置**通用文献七段法**，适用于任意学科。产出 7 段结构化笔记：**基本信息 / 研究背景 / 方法路线 / 核心结果 / 创新点 / 局限展望 / 原文摘要**，并附图表定量读取协议（谱图 / 显微影像 / 性能曲线 / 统计图表 / 拟合回归 / 表格）与 5 项自检清单（数字反查、措辞合规、图表全覆盖、引号溯源、零占位符）。

Prompt 强制忠实原文：不编造数字、图文冲突以图为准、推断必须标注"合理推断/作者未述"。**可在面板 Prompt 编辑框中改成你所在领域的专用版本**。

## ② llm-wiki-knowledge-fusion Skill

精读笔记攒多了怎么办？这个 Skill 把散落的笔记编译成三层知识库：

| 层 | 系统 | 职责 |
|----|------|------|
| L0 会话记忆 | Agent Memory | 操作日志、偏好、项目状态 |
| L1 知识编译 | LLM-Wiki (Obsidian) | sources / concepts / entities / methods / comparisons / synthesis |
| L2 图谱索引 | GBrain | 实体摘要 + 关系 + 时间线（只存索引，不重复存长内容） |

**核心原则**：每层单一职责，数据单向流动（raw → Wiki → GBrain），避免循环写入。

### 安装

```bash
# 方式一：从 Release 下载 llm-wiki-knowledge-fusion.skill（ZIP 格式），解压到 skills 目录
unzip llm-wiki-knowledge-fusion.skill -d <你的 skills 目录>

# 方式二：直接复制本仓库源码
cp -r skill/llm-wiki-knowledge-fusion <你的 skills 目录>/
```

### 包含内容

- `SKILL.md` — 触发条件 + 核心指令
- `references/` — LLM-Wiki 目录规范、GBrain 集成协议、批量回填指南、Obsidian 配置
- `scripts/backfill_entities.py` — 从已有精读笔记批量提取 concepts / entities / methods
- `scripts/sync_to_gbrain.py` — Wiki → GBrain 单向同步
- `assets/templates/` — source / entity / concept / method 四个页面模板

### 典型工作流

1. **批量精读**：用上面的浏览器脚本把 PDF 库跑成结构化笔记
2. **结构补齐**：用 Skill 模板建立 Wiki 目录结构
3. **批量回填**：`python backfill_entities.py` 处理存量笔记
4. **图谱同步**：`python sync_to_gbrain.py`
5. **可视化浏览**：按 `obsidian-setup.md` 配置 Obsidian Graph view + Dataview

## ⚠️ 免责声明

- 本工具通过模拟操作驱动 AI 平台**网页版**，仅供**个人学习与文献管理**使用
- 请遵守各平台服务条款；高频自动化操作可能触发平台风控，请合理设置上传间隔与时间窗口
- 脚本不收集、不上传任何数据到第三方；所有笔记只保存在你的本地

## License

[MIT](LICENSE) © QClaw
