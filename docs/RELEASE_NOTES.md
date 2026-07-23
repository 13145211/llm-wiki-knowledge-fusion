# LLM-Wiki Knowledge Fusion — 发布说明

## v1.0.0

| 属性 | 值 |
|------|-----|
| 名称 | `llm-wiki-knowledge-fusion` |
| 版本 | 1.0.0 |
| 组成 | 3 个浏览器自动精读脚本 + 1 个知识融合 Skill |
| 费用 | 完全免费（基于 AI 平台网页版，无需任何 API Key） |

## 内容清单

### ① 浏览器自动精读脚本（`uploaders/`）

| 脚本 | 平台 | 版本 |
|------|------|------|
| `doubao-pdf-uploader-pro.user.js` | 豆包 | 4.5.0 |
| `qianwen-pdf-uploader-pro.user.js` | 千问 | 4.1.1 |
| `deepseek-pdf-uploader.user.js` | DeepSeek | 1.1.0 |

批量上传 PDF → 自动输入精读 Prompt → 等待并校验回答 → 自动保存 Markdown 笔记。
支持断点续传、Prompt 轮换、失败重试、时间窗口、持久化日志。

### ② 知识融合 Skill（`skill/` 与 `.skill` 附件）

```
llm-wiki-knowledge-fusion/
├── SKILL.md                              # 主技能文件（触发器 + 核心指令）
├── references/
│   ├── llm-wiki-schema.md                # 完整 LLM-Wiki 目录结构与规范
│   ├── gbrain-integration.md             # GBrain 集成协议与 CLI 命令
│   ├── backfill-guide.md                 # 批量回填指南（已有文献库升级）
│   └── obsidian-setup.md                 # Obsidian 可视化浏览配置
├── scripts/
│   ├── backfill_entities.py              # 从 sources 提取实体/概念/方法
│   └── sync_to_gbrain.py                 # 同步 Wiki 页面到 GBrain
└── assets/templates/
    ├── source.md                         # 文献精读笔记模板
    ├── entity.md                         # 实体页面模板
    ├── concept.md                        # 概念页面模板
    └── method.md                         # 方法页面模板
```

## 核心能力

1. **零成本精读**：利用 AI 平台网页版免费额度，批量自动精读文献
2. **三层架构**：L0 会话记忆 → L1 LLM-Wiki 知识编译 → L2 GBrain 图谱索引
3. **单向数据流**：原始资料 → Wiki → GBrain，避免循环写入
4. **批量回填**：从已有 sources 自动提取 concepts/entities/methods
5. **GBrain 同步**：实体摘要 + Wiki 链接，不做长内容重复存储
6. **Obsidian 集成**：Graph view、Dataview 查询、模板系统

## 安装

### 浏览器脚本

Tampermonkey 中导入 `uploaders/` 下对应平台的 `.user.js` 文件。

### Skill

```bash
# 从 Release 下载 .skill 文件（ZIP 格式），解压到你的 Agent skills 目录
unzip llm-wiki-knowledge-fusion.skill -d <你的 skills 目录>

# 或直接复制仓库源码
cp -r skill/llm-wiki-knowledge-fusion <你的 skills 目录>/
```

## 推荐工作流

1. **批量精读**：用浏览器脚本把 PDF 库跑成结构化笔记（sources/）
2. **结构补齐**：用 skill 模板创建 `_templates/` 和目录结构
3. **批量回填**：`python backfill_entities.py` 提取概念/实体/方法
4. **图谱同步**：`python sync_to_gbrain.py` 建立实体索引
5. **可视化浏览**：按 `obsidian-setup.md` 配置 Obsidian
