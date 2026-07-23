// ==UserScript==
// @name         豆包 PDF 批量上传器 Pro
// @namespace    https://github.com/qclaw/doubao-pdf-uploader
// @version      4.5.0
// @description  v4.5.0 断点自动恢复(页面跳转后自动续传) | 文件名前缀+时间窗口 | Prompt轮换 | 回答验证 | 持久化日志
// @author       QClaw
// @match        https://www.doubao.com/*
// @match        https://doubao.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_listValues
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ==================== 用户可调配置（默认值，均可在面板中修改） ====================
    const DEFAULT_INTERVAL_MINUTES = 10;        // 上传间隔（分钟）：两篇文献之间的等待时间
    const DEFAULT_MIN_WAIT_SECONDS = 120;       // 最短等待（秒）：发送后至少等这么久才判定回答完成
    const DEFAULT_STABLE_THRESHOLD = 10;        // 稳定判定（次）：回答文本连续 N 次（每次 2 秒）无变化视为生成完毕
    const DEFAULT_COOLDOWN_MINUTES = 120;       // 冷却时间（分钟）：检测到无效回答后暂停这么久再继续
    const DEFAULT_WAKEUP_PROMPT = '你好，今天天气怎么样？';  // 唤醒问题：冷却结束后先发一句日常对话再恢复上传
    const DEFAULT_UPLOAD_WAIT_SECONDS = 5;      // 上传后等待（秒）：文件上传完成到开始输入 Prompt 的间隔
    const DEFAULT_PROMPT_DONE_WAIT_SECONDS = 2; // Prompt 后等待（秒）：Prompt 输入完成到点击发送的间隔
    const DEFAULT_PRESEND_WAIT_SECONDS = 3;     // 发送前等待（秒）：点击发送前的最后缓冲
    // 注：精读笔记保存为浏览器下载（默认下载目录），文件名 = 原PDF名_文献标题.md

    // ==================== 内部常量（一般无需修改） ====================
    const STORE_PREFIX = 'dbpdf_';              // 油猴存储键前缀
    const DB_NAME = 'DoubaoPdfUploader';        // IndexedDB 库名（记忆所选文件夹）
    const DB_VERSION = 1;
    const FILE_INPUT_WAIT_TIMEOUT = 10000;      // 查找上传入口的超时（毫秒）
    const PANEL_ID = 'db-uploader-panel';       // 控制面板元素 ID
    const DROP_OVERLAY_ID = 'db-drop-overlay';  // 拖拽遮罩元素 ID

    // ==================== 状态管理 ====================
    const STATE = {
        running: false,
        paused: false,
        queue: [],
        currentIndex: -1,
        totalUploaded: 0,
        dirHandle: null,
        config: null,
        ui: {},
        // 回答质量追踪
        consecutiveFailures: 0,
        // 日志缓冲（用于持久化）
        logBuffer: [],
        logLoaded: false,
        // SSE 拦截
        sseText: '',
        sseDone: false,
        sseActive: false,
        // 去重
        lastSavedHash: '',
        processedHashes: [],
        baselineFingerprints: new Set(),
        // Prompt 轮换
        prompt_index: 0
    };

    // ==================== GM 存储封装 ====================
    function gmGet(key, fallback) {
        const val = GM_getValue(STORE_PREFIX + key, null);
        if (val === null || val === undefined) return fallback;
        try { return JSON.parse(val); } catch(e) { return val; }
    }

    function gmSet(key, value) {
        GM_setValue(STORE_PREFIX + key, JSON.stringify(value));
    }

    // ==================== 默认 Prompt ====================
    // ==================== Prompt 轮换池（5个变体，结构相同，措辞不同） ====================
    // ==================== Prompt 轮换池（通用文献七段法，5 个角色变体） ====================
    // 结构相同、措辞不同；每篇轮换使用以降低同质化。可在面板中编辑并保存。
    const PROMPT_POOL = [
        // Prompt #0 — 博士后研究员（通用文献七段法）
        `## 角色设定
你是专业严谨的科研助理，逻辑缜密、学术规范，严格依据论文**正文文字+所有实验图表**，撰写标准化7段式文献精读笔记，全程客观中立、有据可依。

## 严格执行准则
1. 所有内容**完全来源于原文图文**，绝不编造、杜撰任何数据与结论
2. 文字描述与图表数据冲突时，**以文本为准**，并注明图文数据存在不一致
3. 主观推导、延伸分析统一标注**合理推断**，文献未提及内容标注**原文未说明**
4. 所有关键参数、数值均标注来源：Fig.XX / Table.XX
5. 所有附图、附表均**系统性深度识别解读**，不遗漏结构、趋势、差异、对比规律，不局限单一材料图谱参数

---
### 1. 文献基本信息
论文标题、第一作者、通讯作者、发表期刊、发表年份、DOI编号、文章核心关键词

### 2. 研究背景与科学问题
1. 该领域现阶段普遍存在的技术瓶颈、行业痛点与待解决科学难题
2. 现有研究方案、材料、工艺、方法存在的短板与局限性
3. 本文研究目的、核心待解决问题、验证假设与整体研究目标

### 3. 实验方法与技术路线
1. 样品制备、试验流程、分组对照、工艺条件、操作步骤与后处理方式
2. 全部表征检测手段、测试仪器、实验工况与相关测试参数
3. 数据分析、模型计算、机理推导、动力学与统计学处理方法

### 4. 结果规律与图表全面解读
按核心发现逐条撰写：结论规律 + 具体量化数值 + 图表出处
**通用图表识别体系（全学科通用）**
- 物相/光谱类图谱：识别特征峰位置、峰形强弱、峰偏移、物相组成、结构变化规律
- 形貌显微图片：分析颗粒尺寸、形貌特征、分散状态、界面结构、微观形貌差异
- 性能趋势曲线：读取关键节点数值、变化趋势、最优区间、稳定性、组间对比差异
- 数据对比表格：逐一核对正文引用数据与表格原始数值是否吻合一致

### 5. 研究创新点与学术价值
基于摘要、结论客观总结，统一用词：作者探明……、作者验证……、作者得出……
不擅自使用首次、突破性、开创性等绝对化夸张词汇，仅原文原话可引用

### 6. 研究局限与未来展望
1. 作者原文自述的研究不足、试验条件限制、体系适用范围短板
2. 实验设计、数据完整性、机理深度等潜在问题，统一标注**合理推断**
3. 作者规划后续研究方向、优化思路与拓展应用前景

### 7. 全文高度摘要
字数≤300字，完整概括研究背景、实验思路、核心规律、关键数据与最终研究结论`,

        // Prompt #1 — 资深研究员
        `## 角色设定
你是专业严谨的科研助理，逻辑缜密、学术规范，严格依据论文**正文文字+所有实验图表**，撰写标准化7段式文献精读笔记，全程客观中立、有据可依。

## 严格执行准则
1. 所有内容**完全来源于原文图文**，绝不编造、杜撰任何数据与结论
2. 文字描述与图表数据冲突时，**以文本为准**，并注明图文数据存在不一致
3. 主观推导、延伸分析统一标注**合理推断**，文献未提及内容标注**原文未说明**
4. 所有关键参数、数值均标注来源：Fig.XX / Table.XX
5. 所有附图、附表均**系统性深度识别解读**，不遗漏结构、趋势、差异、对比规律，不局限单一材料图谱参数

---
### 1. 文献基本信息
论文标题、第一作者、通讯作者、发表期刊、发表年份、DOI编号、文章核心关键词

### 2. 研究背景与科学问题
1. 该领域现阶段普遍存在的技术瓶颈、行业痛点与待解决科学难题
2. 现有研究方案、材料、工艺、方法存在的短板与局限性
3. 本文研究目的、核心待解决问题、验证假设与整体研究目标

### 3. 实验方法与技术路线
1. 样品制备、试验流程、分组对照、工艺条件、操作步骤与后处理方式
2. 全部表征检测手段、测试仪器、实验工况与相关测试参数
3. 数据分析、模型计算、机理推导、动力学与统计学处理方法

### 4. 结果规律与图表全面解读
按核心发现逐条撰写：结论规律 + 具体量化数值 + 图表出处
**通用图表识别体系（全学科通用）**
- 物相/光谱类图谱：识别特征峰位置、峰形强弱、峰偏移、物相组成、结构变化规律
- 形貌显微图片：分析颗粒尺寸、形貌特征、分散状态、界面结构、微观形貌差异
- 性能趋势曲线：读取关键节点数值、变化趋势、最优区间、稳定性、组间对比差异
- 数据对比表格：逐一核对正文引用数据与表格原始数值是否吻合一致

### 5. 研究创新点与学术价值
基于摘要、结论客观总结，统一用词：作者探明……、作者验证……、作者得出……
不擅自使用首次、突破性、开创性等绝对化夸张词汇，仅原文原话可引用

### 6. 研究局限与未来展望
1. 作者原文自述的研究不足、试验条件限制、体系适用范围短板
2. 实验设计、数据完整性、机理深度等潜在问题，统一标注**合理推断**
3. 作者规划后续研究方向、优化思路与拓展应用前景

### 7. 全文高度摘要
字数≤300字，完整概括研究背景、实验思路、核心规律、关键数据与最终研究结论`,

        // Prompt #2 — 博士研究生
        `## 角色设定
你是专业严谨的科研助理，逻辑缜密、学术规范，严格依据论文**正文文字+所有实验图表**，撰写标准化7段式文献精读笔记，全程客观中立、有据可依。

## 严格执行准则
1. 所有内容**完全来源于原文图文**，绝不编造、杜撰任何数据与结论
2. 文字描述与图表数据冲突时，**以文本为准**，并注明图文数据存在不一致
3. 主观推导、延伸分析统一标注**合理推断**，文献未提及内容标注**原文未说明**
4. 所有关键参数、数值均标注来源：Fig.XX / Table.XX
5. 所有附图、附表均**系统性深度识别解读**，不遗漏结构、趋势、差异、对比规律，不局限单一材料图谱参数

---
### 1. 文献基本信息
论文标题、第一作者、通讯作者、发表期刊、发表年份、DOI编号、文章核心关键词

### 2. 研究背景与科学问题
1. 该领域现阶段普遍存在的技术瓶颈、行业痛点与待解决科学难题
2. 现有研究方案、材料、工艺、方法存在的短板与局限性
3. 本文研究目的、核心待解决问题、验证假设与整体研究目标

### 3. 实验方法与技术路线
1. 样品制备、试验流程、分组对照、工艺条件、操作步骤与后处理方式
2. 全部表征检测手段、测试仪器、实验工况与相关测试参数
3. 数据分析、模型计算、机理推导、动力学与统计学处理方法

### 4. 结果规律与图表全面解读
按核心发现逐条撰写：结论规律 + 具体量化数值 + 图表出处
**通用图表识别体系（全学科通用）**
- 物相/光谱类图谱：识别特征峰位置、峰形强弱、峰偏移、物相组成、结构变化规律
- 形貌显微图片：分析颗粒尺寸、形貌特征、分散状态、界面结构、微观形貌差异
- 性能趋势曲线：读取关键节点数值、变化趋势、最优区间、稳定性、组间对比差异
- 数据对比表格：逐一核对正文引用数据与表格原始数值是否吻合一致

### 5. 研究创新点与学术价值
基于摘要、结论客观总结，统一用词：作者探明……、作者验证……、作者得出……
不擅自使用首次、突破性、开创性等绝对化夸张词汇，仅原文原话可引用

### 6. 研究局限与未来展望
1. 作者原文自述的研究不足、试验条件限制、体系适用范围短板
2. 实验设计、数据完整性、机理深度等潜在问题，统一标注**合理推断**
3. 作者规划后续研究方向、优化思路与拓展应用前景

### 7. 全文高度摘要
字数≤300字，完整概括研究背景、实验思路、核心规律、关键数据与最终研究结论`,

        // Prompt #3 — 期刊审稿人（英文指令，中文输出）
        `## 角色设定
你是专业严谨的科研助理，逻辑缜密、学术规范，严格依据论文**正文文字+所有实验图表**，撰写标准化7段式文献精读笔记，全程客观中立、有据可依。

## 严格执行准则
1. 所有内容**完全来源于原文图文**，绝不编造、杜撰任何数据与结论
2. 文字描述与图表数据冲突时，**以文本为准**，并注明图文数据存在不一致
3. 主观推导、延伸分析统一标注**合理推断**，文献未提及内容标注**原文未说明**
4. 所有关键参数、数值均标注来源：Fig.XX / Table.XX
5. 所有附图、附表均**系统性深度识别解读**，不遗漏结构、趋势、差异、对比规律，不局限单一材料图谱参数

---
### 1. 文献基本信息
论文标题、第一作者、通讯作者、发表期刊、发表年份、DOI编号、文章核心关键词

### 2. 研究背景与科学问题
1. 该领域现阶段普遍存在的技术瓶颈、行业痛点与待解决科学难题
2. 现有研究方案、材料、工艺、方法存在的短板与局限性
3. 本文研究目的、核心待解决问题、验证假设与整体研究目标

### 3. 实验方法与技术路线
1. 样品制备、试验流程、分组对照、工艺条件、操作步骤与后处理方式
2. 全部表征检测手段、测试仪器、实验工况与相关测试参数
3. 数据分析、模型计算、机理推导、动力学与统计学处理方法

### 4. 结果规律与图表全面解读
按核心发现逐条撰写：结论规律 + 具体量化数值 + 图表出处
**通用图表识别体系（全学科通用）**
- 物相/光谱类图谱：识别特征峰位置、峰形强弱、峰偏移、物相组成、结构变化规律
- 形貌显微图片：分析颗粒尺寸、形貌特征、分散状态、界面结构、微观形貌差异
- 性能趋势曲线：读取关键节点数值、变化趋势、最优区间、稳定性、组间对比差异
- 数据对比表格：逐一核对正文引用数据与表格原始数值是否吻合一致

### 5. 研究创新点与学术价值
基于摘要、结论客观总结，统一用词：作者探明……、作者验证……、作者得出……
不擅自使用首次、突破性、开创性等绝对化夸张词汇，仅原文原话可引用

### 6. 研究局限与未来展望
1. 作者原文自述的研究不足、试验条件限制、体系适用范围短板
2. 实验设计、数据完整性、机理深度等潜在问题，统一标注**合理推断**
3. 作者规划后续研究方向、优化思路与拓展应用前景

### 7. 全文高度摘要
字数≤300字，完整概括研究背景、实验思路、核心规律、关键数据与最终研究结论`,

        // Prompt #4 — 行业研发工程师
        `## 角色设定
你是专业严谨的科研助理，逻辑缜密、学术规范，严格依据论文**正文文字+所有实验图表**，撰写标准化7段式文献精读笔记，全程客观中立、有据可依。

## 严格执行准则
1. 所有内容**完全来源于原文图文**，绝不编造、杜撰任何数据与结论
2. 文字描述与图表数据冲突时，**以文本为准**，并注明图文数据存在不一致
3. 主观推导、延伸分析统一标注**合理推断**，文献未提及内容标注**原文未说明**
4. 所有关键参数、数值均标注来源：Fig.XX / Table.XX
5. 所有附图、附表均**系统性深度识别解读**，不遗漏结构、趋势、差异、对比规律，不局限单一材料图谱参数

---
### 1. 文献基本信息
论文标题、第一作者、通讯作者、发表期刊、发表年份、DOI编号、文章核心关键词

### 2. 研究背景与科学问题
1. 该领域现阶段普遍存在的技术瓶颈、行业痛点与待解决科学难题
2. 现有研究方案、材料、工艺、方法存在的短板与局限性
3. 本文研究目的、核心待解决问题、验证假设与整体研究目标

### 3. 实验方法与技术路线
1. 样品制备、试验流程、分组对照、工艺条件、操作步骤与后处理方式
2. 全部表征检测手段、测试仪器、实验工况与相关测试参数
3. 数据分析、模型计算、机理推导、动力学与统计学处理方法

### 4. 结果规律与图表全面解读
按核心发现逐条撰写：结论规律 + 具体量化数值 + 图表出处
**通用图表识别体系（全学科通用）**
- 物相/光谱类图谱：识别特征峰位置、峰形强弱、峰偏移、物相组成、结构变化规律
- 形貌显微图片：分析颗粒尺寸、形貌特征、分散状态、界面结构、微观形貌差异
- 性能趋势曲线：读取关键节点数值、变化趋势、最优区间、稳定性、组间对比差异
- 数据对比表格：逐一核对正文引用数据与表格原始数值是否吻合一致

### 5. 研究创新点与学术价值
基于摘要、结论客观总结，统一用词：作者探明……、作者验证……、作者得出……
不擅自使用首次、突破性、开创性等绝对化夸张词汇，仅原文原话可引用

### 6. 研究局限与未来展望
1. 作者原文自述的研究不足、试验条件限制、体系适用范围短板
2. 实验设计、数据完整性、机理深度等潜在问题，统一标注**合理推断**
3. 作者规划后续研究方向、优化思路与拓展应用前景

### 7. 全文高度摘要
字数≤300字，完整概括研究背景、实验思路、核心规律、关键数据与最终研究结论`
    ];

    // 兼容旧版：DEFAULT_PROMPT 指向 PROMPT_POOL[0]
    const DEFAULT_PROMPT = PROMPT_POOL[0];

    // 备份原始 Prompt 池（用于恢复默认）
    const PROMPT_POOL_ORIG = PROMPT_POOL.map(p => p);

    function getOriginalPrompt(idx) {
        return PROMPT_POOL_ORIG[idx] || PROMPT_POOL[idx];
    }

    // ==================== Prompt 轮换逻辑 ====================
    function getRotatedPrompt() {
        const config = getConfig();
        if (!config.autoRotateEnabled) {
            // 非自动轮换：始终用当前激活 tab 的 Prompt
            const tab = config.activePromptTab || 0;
            log(`📝 使用 Prompt 变体 #${tab}（固定模式）`, 'info');
            return PROMPT_POOL[tab];
        }
        const idx = STATE.prompt_index !== undefined ? STATE.prompt_index : 0;
        const prompt = PROMPT_POOL[idx % PROMPT_POOL.length];
        STATE.prompt_index = (idx + 1) % PROMPT_POOL.length;
        gmSet('prompt_index', STATE.prompt_index);
        log(`🔄 使用 Prompt 变体 #${idx % PROMPT_POOL.length}（共${PROMPT_POOL.length}种，下次用 #${STATE.prompt_index}）`, 'info');
        return prompt;
    }

    function getConfig() {
        if (STATE.config) return STATE.config;
        const saved = gmGet('config', {});
        STATE.config = Object.assign({
            folderDisplayName: '',
            intervalMinutes: DEFAULT_INTERVAL_MINUTES,
            minWaitSeconds: DEFAULT_MIN_WAIT_SECONDS,
            stableThreshold: DEFAULT_STABLE_THRESHOLD,
            cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
            wakeupPrompt: DEFAULT_WAKEUP_PROMPT,
            uploadWaitSeconds: DEFAULT_UPLOAD_WAIT_SECONDS,
            promptDoneWaitSeconds: DEFAULT_PROMPT_DONE_WAIT_SECONDS,
            presendWaitSeconds: DEFAULT_PRESEND_WAIT_SECONDS,
            autoClearAfterComplete: false,
            autoPrompt: true,
            promptText: DEFAULT_PROMPT,
            savePath: '',
            autoSave: true,
            activePromptTab: 0,
            autoRotateEnabled: true,
            useDoubaoDefaultButton: false,
            scheduleStart: '',
            scheduleEnd: ''
        }, saved);
        return STATE.config;
    }

    function saveConfig() {
        gmSet('config', STATE.config);
    }

    function getUploadedSet() {
        return new Set(gmGet('uploaded', []));
    }

    function addUploaded(filename, status) {
        const records = gmGet('uploadRecords', []);
        const existing = records.findIndex(r => r.name === filename);
        const record = {
            name: filename,
            status: status || 'success',
            timestamp: new Date().toISOString(),
            attempts: existing >= 0 ? (records[existing].attempts || 0) + 1 : 1
        };
        if (existing >= 0) records[existing] = record;
        else records.push(record);
        gmSet('uploadRecords', records);

        const s = getUploadedSet();
        s.add(filename);
        gmSet('uploaded', [...s]);
        STATE.totalUploaded = s.size;
    }

    function clearUploaded() {
        gmSet('uploaded', []);
        gmSet('uploadRecords', []);
        STATE.totalUploaded = 0;
    }

    function removeUploaded(filename) {
        const s = getUploadedSet();
        s.delete(filename);
        gmSet('uploaded', [...s]);
        const records = gmGet('uploadRecords', []);
        const filtered = records.filter(r => r.name !== filename);
        gmSet('uploadRecords', filtered);
        STATE.totalUploaded = s.size;
    }

    function getUploadRecords() {
        return gmGet('uploadRecords', []);
    }

    // ==================== 断点自动恢复（v4.5.0） ====================
    // 根因：startNewChat() 兜底用 window.location.href 跳转，整页刷新会杀死脚本
    // 运行环境，导致批量任务中断、只能手动重新开始。
    // 方案：运行期间持久化"运行中"标记；页面重载后 init() 检测到标记即自动续传
    //（已完成文件自动跳过）。标记超过 30 分钟视为过期，避免隔天打开页面突然自启。
    const RESUME_MAX_AGE_MS = 30 * 60 * 1000;

    function setResumeState(reason) {
        gmSet('resumeState', { active: true, savedAt: Date.now(), reason: reason || '' });
    }
    function clearResumeState() {
        gmSet('resumeState', null);
    }
    function getResumeState() {
        const st = gmGet('resumeState', null);
        if (!st || !st.active) return null;
        if (Date.now() - (st.savedAt || 0) > RESUME_MAX_AGE_MS) return null;
        return st;
    }

    // ==================== 持久化日志系统 ====================
    function persistLog(message, level) {
        const entry = {
            time: new Date().toISOString(),
            level: level || 'info',
            msg: message
        };
        STATE.logBuffer.push(entry);
        if (STATE.logBuffer.length > 500) STATE.logBuffer.shift();
        gmSet('logBuffer', STATE.logBuffer);
    }

    function loadPersistedLog() {
        if (STATE.logLoaded) return;
        STATE.logBuffer = gmGet('logBuffer', []);
        STATE.logLoaded = true;
    }

    function clearPersistedLog() {
        STATE.logBuffer = [];
        gmSet('logBuffer', []);
    }

    function exportLogToFile() {
        const records = getUploadRecords();
        const logText = STATE.logBuffer.map(e => {
            const t = new Date(e.time).toTimeString().slice(0, 8);
            const d = new Date(e.time).toISOString().slice(0, 10);
            return `[${d} ${t}] ${e.level.toUpperCase()} | ${e.msg}`;
        }).join('\n');

        const reportLines = [
            '===== 豆包 PDF 批量上传进度报告 =====',
            `导出时间: ${new Date().toLocaleString()}`,
            `总队列: ${STATE.queue.length} 个文件`,
            `已完成: ${getUploadedSet().size} 个`,
            `失败: ${records.filter(r => r.status === 'invalid' || r.status === 'no_response').length} 个`,
            `剩余: ${STATE.queue.length - getUploadedSet().size} 个`,
            '',
            '===== 上传记录 ====='
        ];

        const uploaded = getUploadedSet();
        for (const item of STATE.queue) {
            const done = uploaded.has(item.name);
            const rec = records.find(r => r.name === item.name);
            let status = '⬜ 待处理';
            if (done) {
                if (rec && rec.status === 'invalid') status = '⚠️ 无效回答';
                else if (rec && rec.status === 'no_response') status = '❌ 无回答';
                else status = '✅ 完成';
            }
            const ts = rec ? ` (${new Date(rec.timestamp).toLocaleString()})` : '';
            reportLines.push(`${status} ${item.name}${ts}`);
        }

        reportLines.push('', '===== 操作日志 (最近200条) =====');
        const recentLogs = STATE.logBuffer.slice(-200);
        for (const e of recentLogs) {
            const t = new Date(e.time).toTimeString().slice(0, 8);
            const d = new Date(e.time).toISOString().slice(0, 10);
            reportLines.push(`[${d} ${t}] ${e.level.toUpperCase()} | ${e.msg}`);
        }

        const blob = new Blob([reportLines.join('\n')], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `doubao-upload-log-${new Date().toISOString().slice(0, 10)}.txt`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ==================== 读取日志文件恢复进度 ====================
    function parseLogAndRestore(logText) {
        const lines = logText.split('\n');
        let restored = 0, success = 0, invalid = 0, noResponse = 0;
        const records = [];

        for (const line of lines) {
            // 解析格式: ✅ 完成 filename (timestamp)  或  ⚠️ 无效回答 filename (timestamp)
            const m = line.match(/^(✅ 完成|⚠️ 无效回答|❌ 无回答)\s+(.+?)(?:\s+\((.+)\))?$/);
            if (m) {
                const status = m[1] === '✅ 完成' ? 'success' : (m[1] === '⚠️ 无效回答' ? 'invalid' : 'no_response');
                const name = m[2].trim();
                const ts = m[3] ? new Date(m[3]).toISOString() : new Date().toISOString();
                records.push({ name, status, timestamp: ts, attempts: 1 });
                restored++;
                if (status === 'success') success++;
                else if (status === 'invalid') invalid++;
                else noResponse++;
            }
        }

        if (records.length === 0) {
            log('⚠️ 日志文件中未找到有效记录', 'warn');
            return { restored: 0, success: 0, invalid: 0, noResponse: 0 };
        }

        // 合并到现有记录
        const existing = gmGet('uploadRecords', []);
        for (const rec of records) {
            const idx = existing.findIndex(r => r.name === rec.name);
            if (idx >= 0) {
                existing[idx] = rec;
            } else {
                existing.push(rec);
            }
        }
        gmSet('uploadRecords', existing);

        // 更新 uploaded set
        const uploaded = new Set(gmGet('uploaded', []));
        for (const rec of records) {
            uploaded.add(rec.name);
        }
        gmSet('uploaded', [...uploaded]);
        STATE.totalUploaded = uploaded.size;

        persistLog(`从日志文件恢复 ${restored} 条记录`, 'info');
        return { restored, success, invalid, noResponse };
    }

    function updateRetryFailedButton() {
        const records = getUploadRecords();
        const failedCount = records.filter(r => r.status === 'invalid' || r.status === 'no_response').length;
        if (failedCount > 0) {
            STATE.ui.btnRetryFailed.disabled = false;
            STATE.ui.btnRetryFailed.textContent = `🔁 重试失败(${failedCount})`;
        } else {
            STATE.ui.btnRetryFailed.disabled = true;
            STATE.ui.btnRetryFailed.textContent = '🔁 重试失败';
        }
    }

    function updateRotateIndex() {
        if (!STATE.ui || !STATE.ui.rotateIndex) return;
        const config = getConfig();
        if (config.autoRotateEnabled !== false) {
            const idx = STATE.prompt_index !== undefined ? STATE.prompt_index : 0;
            STATE.ui.rotateIndex.textContent = `下次用变体 #${idx}`;
        } else {
            STATE.ui.rotateIndex.textContent = '已固定';
        }
    }

    // ==================== 解析序号范围字符串 ====================
    function parseRange(str, maxLen) {
        const result = [];
        const parts = str.split(',');
        for (const part of parts) {
            const trimmed = part.trim();
            const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
            if (rangeMatch) {
                let start = parseInt(rangeMatch[1]);
                let end = parseInt(rangeMatch[2]);
                if (start > end) { [start, end] = [end, start]; }
                for (let n = start; n <= end; n++) {
                    if (n >= 1 && n <= maxLen) result.push(n - 1);
                }
            } else {
                const num = parseInt(trimmed);
                if (!isNaN(num) && num >= 1 && num <= maxLen) result.push(num - 1);
            }
        }
        // 去重
        return [...new Set(result)];
    }

    // ==================== IndexedDB：持久化目录句柄 ====================
    function openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains('handles')) {
                    req.result.createObjectStore('handles');
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function storeDirHandle(handle) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('handles', 'readwrite');
            tx.objectStore('handles').put(handle, 'dirHandle');
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    async function loadDirHandle() {
        try {
            const db = await openDB();
            const handle = await new Promise((resolve) => {
                const tx = db.transaction('handles', 'readonly');
                const req = tx.objectStore('handles').get('dirHandle');
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
            });
            if (!handle) return null;
            const opts = { mode: 'read' };
            const perm = await handle.queryPermission(opts);
            if (perm === 'granted') return handle;
            if (perm === 'prompt') {
                const granted = await handle.requestPermission(opts);
                if (granted === 'granted') return handle;
            }
            const db2 = await openDB();
            const tx = db2.transaction('handles', 'readwrite');
            tx.objectStore('handles').delete('dirHandle');
            return null;
        } catch(e) {
            return null;
        }
    }

    // ==================== 文件系统访问 ====================
    async function pickFolder() {
        if (!('showDirectoryPicker' in window)) {
            log('❌ 浏览器不支持 File System Access API，请使用拖拽方式', 'error');
            return null;
        }
        try {
            const handle = await window.showDirectoryPicker({ mode: 'read' });
            await storeDirHandle(handle);
            STATE.dirHandle = handle;
            STATE.config.folderDisplayName = handle.name;
            saveConfig();
            updateFolderDisplay();
            log('📂 已选择文件夹: ' + handle.name, 'success');
            return handle;
        } catch(e) {
            if (e.name !== 'AbortError') {
                log('❌ 选择文件夹失败: ' + e.message, 'error');
            }
            return null;
        }
    }

    async function listPdfFiles(dirHandle) {
        const files = [];
        for await (const [name, handle] of dirHandle.entries()) {
            if (handle.kind === 'file' && name.toLowerCase().endsWith('.pdf')) {
                files.push({ name, handle });
            }
        }
        files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
        return files;
    }

    async function getFileFromHandle(fileHandle) {
        return fileHandle.getFile();
    }

    // ==================== 拖拽支持 ====================
    async function handleDropEntries(items) {
        const files = [];
        for (const item of items) {
            if (item.kind !== 'file') continue;
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
            if (!entry) continue;
            const collected = await collectFiles(entry);
            files.push(...collected);
        }
        return files;
    }

    async function collectFiles(entry) {
        const result = [];
        if (entry.isFile) {
            if (entry.name.toLowerCase().endsWith('.pdf')) {
                const file = await new Promise(resolve => entry.file(resolve));
                result.push({ name: file.name, file });
            }
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            let batch;
            do {
                batch = await new Promise(resolve => reader.readEntries(resolve));
                for (const e of batch) {
                    const sub = await collectFiles(e);
                    result.push(...sub);
                }
            } while (batch.length > 0);
        }
        return result;
    }

    // ==================== 文件输入查找 ====================
    function findFileInput(doc, depth) {
        if (!doc || depth > 5) return null;
        let inp = doc.querySelector('input[type="file"]');
        if (inp) return inp;
        const all = doc.querySelectorAll('input');
        for (let i = 0; i < all.length; i++) {
            if (all[i].type === 'file') return all[i];
        }
        const frames = doc.querySelectorAll('iframe');
        for (let i = 0; i < frames.length; i++) {
            try {
                const d = frames[i].contentDocument || frames[i].contentWindow.document;
                const r = findFileInput(d, depth + 1);
                if (r) return r;
            } catch(e) {}
        }
        return null;
    }

    // ==================== 上传按钮点击器 ====================
    const UPLOAD_SELECTORS = [
        '[aria-label="上传文件"]', '[aria-label="文件上传"]',
        '[aria-label="上传"]', '[aria-label="附件"]',
        '[aria-label="upload file"]', '[aria-label="attach file"]',
        '[class*="upload-btn"]', '[class*="UploadBtn"]',
        '[class*="upload-button"]', '[class*="UploadButton"]',
        '[class*="attach-btn"]', '[class*="AttachBtn"]',
        '[class*="file-upload"]', '[class*="FileUpload"]',
        'button[id^="radix-"][aria-haspopup="menu"]',
        'button[class*="input-engagement"]',
        '[id*="input-engagement"] button',
    ];

    function isDangerousButton(el) {
        const text = (el.textContent || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const combined = text + ' ' + label;
        const blocked = ['朗读', 'read aloud', '语音', 'voice', 'speech',
            '播放', 'play', 'audio', '音量', 'volume',
            '截图', 'screenshot', 'screen', '分享', 'share',
            '设置', 'settings', '帮助', 'help', 'new chat', '新对话'];
        return blocked.some(w => combined.includes(w));
    }

    function clickUploadButtons() {
        let clicked = 0;
        for (const sel of UPLOAD_SELECTORS) {
            try {
                const btns = document.querySelectorAll(sel);
                for (const btn of btns) {
                    try {
                        if (btn.offsetParent === null) continue;
                        if (isDangerousButton(btn)) continue;
                        btn.click();
                        clicked++;
                        break;
                    } catch(e) {}
                }
                if (clicked > 0) break;
            } catch(e) {}
        }
        if (clicked > 0) {
            setTimeout(() => {
                const menuItems = document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]');
                for (const item of menuItems) {
                    const text = (item.textContent || '').trim();
                    if (text.includes('文件') || text.includes('上传') || text.includes('file') || text.includes('upload')) {
                        item.click();
                        break;
                    }
                }
            }, 300);
        }
        return clicked;
    }

    async function waitForFileInput(timeout) {
        const start = Date.now();
        let clickedUpload = false;
        while (Date.now() - start < timeout) {
            let inp = findFileInput(document, 0);
            if (inp) return inp;
            if (!clickedUpload) {
                clickUploadButtons();
                clickedUpload = true;
                await sleep(500);
                inp = findFileInput(document, 0);
                if (inp) return inp;
            }
            await sleep(800);
        }
        return null;
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==================== 文件设置到 input ====================
    function setFileToInput(input, file) {
        log(`🔧 设置文件到 input: class=${input.className}`, 'info');
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        try { input.focus(); } catch(e) {}
        input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        log(`✅ 文件已设置并触发 change 事件, files.length=${input.files.length}`, 'info');
    }

    // ==================== 发送消息 ====================
    function randomDelay(minMs, maxMs) {
        const ms = minMs + Math.random() * (maxMs - minMs);
        return sleep(ms);
    }

    function clickSendButton() {
        // 策略 1: 精确 ID
        const sendBtn = document.querySelector('button#flow-end-msg-send');
        if (sendBtn && sendBtn.offsetParent !== null) {
            sendBtn.click();
            log('🔧 点击发送按钮 (#flow-end-msg-send)', 'info');
            return true;
        }

        // 策略 2: aria-label
        const allBtns = document.querySelectorAll('button');
        for (const btn of allBtns) {
            if (btn.offsetParent === null) continue;
            if (isDangerousButton(btn)) continue;
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (/send|发送|submit|提交/.test(aria)) {
                btn.click();
                log('🔧 点击发送按钮 (aria-label)', 'info');
                return true;
            }
        }

        // 策略 3: SVG class
        for (const btn of allBtns) {
            if (btn.offsetParent === null) continue;
            if (isDangerousButton(btn)) continue;
            const svg = btn.querySelector('svg');
            if (svg) {
                const svgClass = (svg.getAttribute('class') || '').toLowerCase();
                if (/send|submit|arrow|plane/.test(svgClass)) {
                    btn.click();
                    log('🔧 点击发送按钮 (SVG class)', 'info');
                    return true;
                }
            }
        }

        // 策略 4: Enter 键兜底
        const editable = document.querySelector('textarea.semi-input-textarea, [contenteditable="true"]');
        if (editable) {
            editable.focus();
            editable.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
                bubbles: true, composed: true, cancelable: true
            }));
            log('🔧 Enter 发送 (兜底)', 'info');
            return true;
        }

        return false;
    }

    // ==================== 点击豆包默认按钮 ====================
    async function clickDoubaoDefaultSummaryButton() {
        log('🚀 尝试点击豆包默认「详细总结这篇文档内容」按钮...', 'info');
        const selectors = [
            // 豆包上传PDF后弹出的快捷操作按钮（精确匹配）
            'button:has-text("详细总结这篇文档内容")',
            'button:has-text("总结这篇文档")',
            'button:has-text("详细总结")',
            'button:has-text("总结文档内容")',
            'button:has-text("文档总结")',
            // 通用建议/推荐按钮
            'div[role="button"]:has-text("详细总结")',
            'div[class*="suggestion"]:has-text("总结")',
            'div[class*="recommend"]:has-text("总结")',
            // 豆包 chat action buttons
            'button[class*="action"]:has-text("总结")',
            'button[class*="suggest"]:has-text("总结")',
            // fallback: any visible button containing 总结 near an uploaded file indicator
            'button:has-text("总结")'
        ];

        for (const selector of selectors) {
            try {
                const btn = document.querySelector(selector);
                if (btn && btn.offsetParent !== null) {
                    log(`✅ 找到按钮: "${btn.textContent.trim().slice(0, 40)}"`, 'success');
                    btn.click();
                    await sleep(500);
                    // 有些按钮点击后会展开子选项，再次查找发送按钮
                    // 等待对话开始
                    return true;
                }
            } catch (e) {
                // selector not supported, continue
            }
        }

        // 备用方案：查找包含"总结"文字的可见可点击元素
        const allEls = document.querySelectorAll('button, div[role="button"], span[role="button"]');
        for (const el of allEls) {
            const text = el.textContent.trim();
            if ((text.includes('总结') || text.includes('总结这篇')) && el.offsetParent !== null) {
                log(`⚠️ 使用备用方案，找到: "${text.slice(0, 40)}"`, 'warn');
                el.click();
                await sleep(500);
                return true;
            }
        }

        log('❌ 未找到豆包默认总结按钮', 'error');
        return false;
    }

    // ==================== 输入 Prompt ====================
    async function typePromptIntoChat(promptText) {
        try {
            log('🔧 开始输入 Prompt...', 'info');

            const editable = document.querySelector('textarea.semi-input-textarea')
                || document.querySelector('[contenteditable="true"]')
                || document.querySelector('[role="textbox"]')
                || document.querySelector('textarea');

            if (!editable) {
                log('⚠️ 未找到输入框', 'warn');
                return false;
            }

            log(`🔧 找到输入框: tag=${editable.tagName}`, 'info');
            editable.focus();
            await sleep(300);

            try { if (typeof GM_setClipboard !== 'undefined') { GM_setClipboard(promptText); } } catch(e) {}

            // 策略 1: execCommand insertText
            let success = false;
            try {
                editable.focus();
                document.execCommand('selectAll', false);
                document.execCommand('delete', false);
                await sleep(100);
                document.execCommand('insertText', false, promptText);
                await sleep(300);
                editable.dispatchEvent(new InputEvent('input', {
                    bubbles: true, composed: true, cancelable: true,
                    inputType: 'insertText', data: promptText
                }));
                const len = (editable.textContent || editable.value || '').trim().length;
                log(`📋 策略1后内容长度: ${len} 字符`, 'info');
                if (len >= 20) {
                    log(`✅ Prompt 已输入 (execCommand, ${len} 字符)`, 'info');
                    success = true;
                }
            } catch(e) {
                log(`⚠️ execCommand 失败: ${e.message}`, 'warn');
            }

            // 策略 2: textContent + InputEvent
            if (!success) {
                try {
                    editable.focus();
                    editable.textContent = promptText;
                    if (editable.tagName === 'TEXTAREA') editable.value = promptText;
                    const tracker = editable._valueTracker;
                    if (tracker) tracker.setValue('');
                    editable.dispatchEvent(new InputEvent('input', {
                        bubbles: true, composed: true, cancelable: true,
                        inputType: 'insertText', data: promptText
                    }));
                    editable.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
                    await sleep(300);
                    const len = (editable.textContent || editable.value || '').trim().length;
                    if (len >= 20) {
                        log(`✅ Prompt 已输入 (textContent, ${len} 字符)`, 'info');
                        success = true;
                    }
                } catch(e) {
                    log(`⚠️ textContent 失败: ${e.message}`, 'warn');
                }
            }

            // 策略 3: 逐行 execCommand
            if (!success) {
                try {
                    editable.focus();
                    document.execCommand('selectAll', false);
                    document.execCommand('delete', false);
                    await sleep(50);
                    const lines = promptText.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (i > 0) document.execCommand('insertLineBreak', false);
                        if (lines[i].length > 0) document.execCommand('insertText', false, lines[i]);
                        if (i % 100 === 0) await sleep(10);
                    }
                    editable.dispatchEvent(new InputEvent('input', {
                        bubbles: true, composed: true, inputType: 'insertText'
                    }));
                    await sleep(300);
                    const len = (editable.textContent || editable.value || '').trim().length;
                    if (len >= 20) {
                        log(`✅ Prompt 已输入 (逐行execCommand, ${len} 字符)`, 'info');
                        success = true;
                    }
                } catch(e) {
                    log(`⚠️ 逐行失败: ${e.message}`, 'warn');
                }
            }

            if (!success) {
                log('❌ 所有 Prompt 输入方式均失败', 'error');
                return false;
            }

            await sleep(200);
            const finalLen = (editable.textContent || editable.value || '').trim().length;
            if (finalLen < 20) {
                log(`❌ 最终验证失败: ${finalLen} 字符`, 'error');
                return false;
            }
            return true;
        } catch(ex) {
            log(`❌ typePromptIntoChat 异常: ${ex.message}`, 'error');
            return false;
        }
    }

    // ==================== 回答质量验证 ====================
    /**
     * 结构化验证：判断捕获内容真的是 AI 精读笔记，还是误捕获的用户 Prompt / 错误信息。
     * 只做实质性判断——必须出现真实学术文献的典型特征，缺一不可。
     */
    function isValidResponse(text, promptText, useDefaultBtn) {
        if (!text || text.length < 500) {
            return { valid: false, reason: '内容过短 (' + (text ? text.length : 0) + ' 字符, 需>=500)' };
        }
        // ━━ 排除用户 Prompt 回声 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // 用户 Prompt 以"角色设定"开头，AI 回答不会出现这些指令原文
        if (/^#{1,3}\s*角色设定/m.test(text)) {
            return { valid: false, reason: '检测到用户 Prompt 回声（角色设定）' };
        }
        // 用户 Prompt 包含未填充的占位符模板，AI 回答会填实
        if (/<标题\/作者\/机构/.test(text) || /<制备条件/.test(text)) {
            return { valid: false, reason: '检测到未填充的 Prompt 占位符模板' };
        }
        // ━━ 排除平台拒绝 / 错误 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        const refuse = [
            /抱歉.{0,20}(无法|不能).{0,20}(处理|读取|识别|访问)/,
            /I('m| am) sorry.{0,30}(cannot|unable)/i,
            /请提供.{0,10}(文件|文档|PDF|内容)/,
            /Please (upload|provide|attach).{0,15}(file|document)/i,
            /(错误|异常).{0,10}(处理|读取|上传|生成)/,
            /(服务|系统).{0,10}(繁忙|拥挤|不可用|暂时)/,
        ];
        for (const p of refuse) {
            if (p.test(text)) {
                return { valid: false, reason: '检测到拒绝/错误: ' + text.substring(0, 80).replace(/\n/g, ' ') };
            }
        }
        // ━━ 正向验证：必须包含真实学术笔记特征 ━━━━━━━━━━━━━━━━━━━━━━
        // 1. 必须出现真实的文献基本信息（DOI 或具体期刊或作者+机构）
        const hasDOI = /DOI[：:\s]*10\.\d{4,}/i.test(text);
        const hasJournal = /期刊[：:\s]*[A-Z].{3,}(et al|Vol|vol|\(\d{4}\))/.test(text)
                        || /[A-Z][a-z]+ [A-Z][a-z]+.{0,40}\d{4}/.test(text.substring(0, 2000));
        const hasAuthor = /(作者|Authors?)[：:\s]*[A-Z一-鿿]{2,}/.test(text)
                       || /(第一作者|通讯|通讯作者|Corresponding)/.test(text);
        if (!hasDOI && !hasJournal && !hasAuthor) {
            return { valid: false, reason: '未检测到真实文献引用信息（DOI/期刊/作者均缺失）' };
        }
        // 2. 至少出现 4 个 7 段结构中的章节标题（已填充内容的）
        const _sRe = /^(?:#{1,4}\s*(?:[1-7]\.?\s*)?|▎\d\.?\s*|【.*】)(?:文献(?:基本信息|卡片|档案|概览)|研究(?:背景|动机)|(?:科学|研究)?问题|方法|(?:实验|研究)?(?:方法|路线|方案)|(?:技术|工艺)路线|(?:核心|主要)?(?:结果|发现)|(?:创新|贡献|(?:技术)?亮点)|局限|展望|(?:原文|全文)?(?:摘要|精要|总结|速览))/gm;
        const sections = text.match(_sRe);
        if (secCount < 4 && text.length < 8000) {
            // Short texts need 4 sections; very long texts (>8k chars) likely passed other checks
            return { valid: false, reason: '7段结构章节标题不足(' + secCount + '/4)，可能是非结构化内容' };
        }
        return { valid: true, reason: '有效精读笔记 (' + text.length + ' 字符, ' + secCount + '/7 章节)' };
    }

    // ==================== 等待 AI 回答完成 ====================
    function isInsideOurPanel(el) {
        if (!el) return false;
        return !!(el.closest && (el.closest('#' + PANEL_ID) || el.closest('#' + DROP_OVERLAY_ID)));
    }

    function findChatScrollContainer() {
        const knownSelectors = [
            'div.message-list-zLoNs1',
            'div[class*="message-list"]',
            'div.scroller_content',
            'div.list_items',
            'div[class*="v_list_scroller"]',
        ];
        for (const sel of knownSelectors) {
            const el = document.querySelector(sel);
            if (el && !isInsideOurPanel(el)) {
                const listItems = el.querySelector('div.list_items');
                if (listItems) return listItems;
                return el;
            }
        }
        const mains = document.querySelectorAll('main');
        for (const main of mains) {
            if (isInsideOurPanel(main)) continue;
            const divs = main.querySelectorAll('div');
            for (const d of divs) {
                if (isInsideOurPanel(d)) continue;
                const style = window.getComputedStyle(d);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && d.scrollHeight > d.clientHeight && d.clientHeight > 100) {
                    const listItems = d.querySelector('div.list_items');
                    return listItems || d;
                }
            }
        }
        return null;
    }

    function getChatMessageElements(container) {
        if (!container) return [];
        return [...container.children].filter(el => {
            if (isInsideOurPanel(el)) return false;
            // v4.5.2: 只取 assistant 消息，跳过用户消息
            return isAssistantEl(el);
        });
    }

    // 豆包/v_list_row 没有 role 属性，用 class/布局位置区分
    function isAssistantEl(el) {
        // 遍历祖先找是否为 assistant conversation turn
        var cur = el;
        while (cur) {
            var cls = (cur.className || '').toString ? (cur.className || '').toString() : '';
            if (/agent|assistant|(?:^|_)reply(?:$|_)|reply/i.test(cls)) return true;
            // data 属性
            var role = cur.getAttribute ? cur.getAttribute('data-role') || cur.getAttribute('role') : '';
            if (/assistant/i.test(role)) return true;
            cur = cur.parentElement;
        }
        // 最后一层兜底：layout 包含发送者图标（豆包 assistant 有头像）+ md 块
        var icons = el.querySelectorAll('.user-icon, .agent-icon, img[alt="assistant"], [class*="avatar"][class*="bot"]');
        if (icons.length > 0) return true;
        // 如果某个 v_list_row 内部有 md-box（AI 回答特征），推定是 assistant
        var mdBox = el.querySelector('.md-box-root, [class*="md-box"], [class*="markdown"]');
        if (mdBox && !el.querySelector('.semi-input-textarea, [contenteditable]')) return true;
        return false;
    }

    function hashText(text) {
        const n = text.length;
        if (n < 100) return text.substring(0, 50) + '|' + n;
        const points = [
            text.substring(0, 80),
            text.substring(Math.floor(n * 0.25), Math.floor(n * 0.25) + 60),
            text.substring(Math.floor(n * 0.5), Math.floor(n * 0.5) + 60),
            text.substring(Math.floor(n * 0.75), Math.floor(n * 0.75) + 60),
            text.substring(n - 80)
        ];
        return points.join('|') + '|' + n;
    }

    function isPreviouslySaved(text) {
        const h = hashText(text);
        if (STATE.processedHashes.includes(h)) return true;
        if (STATE.baselineFingerprints.has(h)) return true;
        return false;
    }

    function markBaseline() {
        const container = findChatScrollContainer();
        if (!container) {
            log('⚠️ 未找到聊天滚动容器，无法标记基线', 'warn');
            return { container: null, lastChild: null, childCount: 0, fingerprints: new Set() };
        }
        const children = getChatMessageElements(container);
        const lastChild = children.length > 0 ? children[children.length - 1] : null;
        const fingerprints = new Set(STATE.processedHashes);
        const allMdBoxes = document.querySelectorAll('div.md-box-root, div[class*="md-box"]');
        for (const box of allMdBoxes) {
            if (isInsideOurPanel(box)) continue;
            const text = (box.textContent || '').trim();
            if (text.length > 50) {
                fingerprints.add(hashText(text));
            }
        }
        STATE.baselineFingerprints = fingerprints;
        log(`📊 标记基线: 容器 ${children.length} 条消息, ${fingerprints.size} 个已知指纹`, 'info');
        return { container, lastChild, childCount: children.length, fingerprints };
    }

    async function waitForResponseComplete(timeoutMs, baseline, config) {
        const start = Date.now();
        let lastTextLength = 0;
        let stableCount = 0;
        const _cfg = config || getConfig();
        const STABLE_THRESHOLD = _cfg.stableThreshold || DEFAULT_STABLE_THRESHOLD;
        const MIN_WAIT_MS = (_cfg.minWaitSeconds || DEFAULT_MIN_WAIT_SECONDS) * 1000;
        const CHECK_INTERVAL = 2000;
        const STRATEGY2_MIN_WAIT = 20000;
        const GROWTH_RATE_THRESHOLD = 0.005;

        const fingerprints = baseline.fingerprints || STATE.baselineFingerprints || new Set();
        log('⏳ 等待豆包回答...', 'info');

        // MutationObserver 跟踪发送按钮转折
        let moFired = false;
        let moCleanup = () => {};
        const initBtnVisible = (() => {
            const btn = document.querySelector('button#flow-end-msg-send');
            return !!(btn && btn.offsetParent !== null);
        })();
        log(`🔍 初始发送按钮状态: ${initBtnVisible ? '可见' : '隐藏'}`, 'info');

        if (!initBtnVisible) {
            let wasHidden = true;
            const moResolvePromise = new Promise((resolve) => {
                const observer = new MutationObserver(() => {
                    if (!wasHidden) return;
                    const btn = document.querySelector('button#flow-end-msg-send');
                    if (btn && btn.offsetParent !== null) {
                        wasHidden = false;
                        moFired = true;
                        log('🔔 MO: 发送按钮隐藏→可见转折 — AI 生成完毕', 'success');
                        resolve(true);
                    }
                });
                observer.observe(document.body, { childList: true, subtree: true, attributes: true });
                const moTimeout = setTimeout(() => {
                    observer.disconnect();
                    log('⚠️ MO 超时（5分钟），回退纯 DOM 轮询', 'warn');
                    resolve(false);
                }, Math.min(timeoutMs, 300000));
                moCleanup = () => { clearTimeout(moTimeout); observer.disconnect(); };
            });
            moResolvePromise.catch(() => {});
        } else {
            log('ℹ️ 发送按钮初始可见，使用 DOM 轮询', 'info');
        }

        function captureLatestAnswer() {
            let bestText = '';
            const allMdBoxes = document.querySelectorAll('div.md-box-root, div[class*="md-box"]');
            for (const box of allMdBoxes) {
                if (isInsideOurPanel(box)) continue;
                const text = (box.textContent || '').trim();
                if (text.length < 200) continue;
                if (text.startsWith('你是 ') || text.startsWith('## 角色设定') || text.startsWith('## 角色设定') || text.includes('<标题/作者')) continue;
                if (text.includes('历史对话') || text.includes('搜索')) continue;
                const fp = hashText(text);
                if (fingerprints.has(fp)) continue;
                if (isPreviouslySaved(text)) continue;
                if (text.length > bestText.length) bestText = text;
            }
            return bestText;
        }

        function saveAndReturn(text) {
            const fp = hashText(text);
            STATE.processedHashes.push(fp);
            STATE.lastSavedHash = fp;
            if (STATE.processedHashes.length > 50) STATE.processedHashes.shift();
            moCleanup();
            return text;
        }

        while (Date.now() - start < timeoutMs) {
            while (STATE.paused && STATE.running) { await sleep(1000); }
            if (!STATE.running) { moCleanup(); return null; }

            // SSE 拦截结果优先
            if (STATE.sseDone && STATE.sseText && STATE.sseText.length > 200) {
                const fp = hashText(STATE.sseText);
                if (!fingerprints.has(fp) && !isPreviouslySaved(STATE.sseText)) {
                    STATE.processedHashes.push(fp);
                    STATE.lastSavedHash = fp;
                    if (STATE.processedHashes.length > 50) STATE.processedHashes.shift();
                    moCleanup();
                    log(`✅ 回答完成 (${STATE.sseText.length} 字符, 🔌SSE拦截)`, 'success');
                    return STATE.sseText;
                }
            }
            if (STATE.sseActive) {
                await sleep(1000);
                continue;
            }

            let newMsg = null;
            let newMsgText = '';

            // 策略 1: 聊天容器中找新增
            if (baseline.container) {
                const currentChildren = getChatMessageElements(baseline.container);
                let newElements = [];
                if (baseline.lastChild) {
                    const baselineIdx = currentChildren.indexOf(baseline.lastChild);
                    if (baselineIdx >= 0) {
                        newElements = currentChildren.slice(baselineIdx + 1);
                    } else if (currentChildren.length > baseline.childCount) {
                        newElements = currentChildren.slice(baseline.childCount);
                    } else {
                        newElements = currentChildren.slice(Math.max(0, baseline.childCount));
                    }
                } else {
                    newElements = currentChildren;
                }
                for (const el of newElements) {
                    if (isInsideOurPanel(el)) continue;
                    const mdBox = el.querySelector('div.md-box-root, div[class*="md-box"]');
                    if (!mdBox || isInsideOurPanel(mdBox)) continue;
                    const text = (mdBox.textContent || '').trim();
                    if (text.length < 50) continue;
                    if (text.startsWith('你是 ') || text.startsWith('## 角色设定')) continue;
                    if (text.includes('<标题/作者')) continue;
                    const fp = hashText(text);
                    if (fingerprints.has(fp)) continue;
                    if (text.length > newMsgText.length) { newMsgText = text; newMsg = mdBox; }
                }
            }

            // 策略 2: 全局搜索
            const elapsed = Date.now() - start;
            if ((!newMsg || newMsgText.length < 100) && elapsed >= STRATEGY2_MIN_WAIT) {
                const allMdBoxes = document.querySelectorAll('div.md-box-root, div[class*="md-box"]');
                for (const box of allMdBoxes) {
                    if (isInsideOurPanel(box)) continue;
                    const text = (box.textContent || '').trim();
                    if (text.length < 100) continue;
                    if (text.startsWith('你是 ') || text.startsWith('## 角色设定') || text.startsWith('## 角色设定') || text.includes('<标题/作者')) continue;
                    if (text.includes('历史对话') || text.includes('搜索')) continue;
                    const fp = hashText(text);
                    if (fingerprints.has(fp)) continue;
                    if (isPreviouslySaved(text)) continue;
                    if (text.length > newMsgText.length) { newMsgText = text; newMsg = box; }
                }
            }

            if (newMsg && newMsgText.length > 50) {
                const currentLength = newMsgText.length;
                const preview = newMsgText.substring(0, 100);
                if (preview.includes('你是 ') || preview.startsWith('## 角色设定') || preview.includes('## 严格执行准则')) {
                    newMsg = null; newMsgText = ''; lastTextLength = 0; stableCount = 0;
                    await sleep(CHECK_INTERVAL); continue;
                }

                if (currentLength === lastTextLength) {
                    stableCount++;
                } else if (currentLength > lastTextLength && lastTextLength > 0) {
                    const growth = currentLength - lastTextLength;
                    const growthRate = growth / lastTextLength;
                    if (growthRate < GROWTH_RATE_THRESHOLD) {
                        stableCount++;
                    } else {
                        stableCount = 0;
                        log(`📝 生成中 (${currentLength} 字符, +${growth})...`, 'info');
                    }
                }
                lastTextLength = currentLength;

                const moBoost = moFired;
                const effectiveStable = moBoost ? Math.min(STABLE_THRESHOLD, 4) : STABLE_THRESHOLD;
                const effectiveMinWait = moBoost ? Math.min(MIN_WAIT_MS, 10000) : MIN_WAIT_MS;

                if (stableCount >= effectiveStable && elapsed >= effectiveMinWait) {
                    const fp = hashText(newMsgText);
                    if (fingerprints.has(fp) || isPreviouslySaved(newMsgText)) {
                        stableCount = 0; lastTextLength = 0;
                        await sleep(CHECK_INTERVAL * 2); continue;
                    }
                    const tag = moBoost ? 'MO加速' : 'DOM轮询';
                    log(`✅ 回答完成 (${currentLength} 字符, ${tag}, 稳定 ${stableCount * 2}秒)`, 'success');
                    return saveAndReturn(newMsgText);
                }

                if (stableCount >= effectiveStable && elapsed < effectiveMinWait) {
                    const tag = moBoost ? 'MO加速' : '';
                    log(`⏳ 文本已稳定，等待最短时间 (${Math.round(elapsed/1000)}/${Math.round(effectiveMinWait/1000)}s)${tag}...`, 'info');
                }
            } else if (elapsed > 60000 && newMsgText.length < 100) {
                const best = captureLatestAnswer();
                if (!best || best.length < 100) {
                    let raw = '';
                    const allMdBoxes = document.querySelectorAll('div.md-box-root, div[class*="md-box"]');
                    for (const box of allMdBoxes) {
                        if (isInsideOurPanel(box)) continue;
                        const text = (box.textContent || '').trim();
                        if (text.length > raw.length && text.length > 200) raw = text;
                    }
                    if (raw && !isPreviouslySaved(raw) && !fingerprints.has(hashText(raw))) {
                        log(`✅ 回答完成 (${raw.length} 字符, 原始扫描)`, 'success');
                        return saveAndReturn(raw);
                    }
                }
            }

            await sleep(CHECK_INTERVAL);
        }

        moCleanup();
        log('⚠️ 等待回答超时', 'warn');
        return null;
    }

    // ==================== 从回答中提取标题 ====================
    function extractTitleFromResponse(responseText, fileName) {
        const titleMatch = responseText.match(/标题[：:]\s*(.+?)(?:\n|$)/);
        if (titleMatch) {
            let title = titleMatch[1].trim();
            title = title.replace(/\s+/g, ' ').substring(0, 80);
            title = title.replace(/[\\/:*?"<>|]/g, '_').trim();
            if (title && title.length > 2) return title;
        }

        const lines = responseText.split('\n');
        let foundBasicInfo = false;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].match(/##\s*1\.\s*基本信息/i) || lines[i].match(/^1\.\s*基本信息/)) {
                foundBasicInfo = true;
                continue;
            }
            if (foundBasicInfo) {
                const line = lines[i].trim();
                if (!line || line.startsWith('<') || line.startsWith('##')) continue;
                const m = line.match(/标题[：:]\s*(.+)/);
                if (m) {
                    let title = m[1].trim().substring(0, 80).replace(/[\\/:*?"<>|]/g, '_').trim();
                    if (title && title.length > 2) return title;
                    continue;
                }
                let title = line.substring(0, 80).replace(/[\\/:*?"<>|]/g, '_').trim();
                if (title && title.length > 2) return title;
            }
        }

        let name = fileName.replace(/\.pdf$/i, '');
        name = name.replace(/^\d+\.\d+\/[^,]+,/, '').trim();
        return name.substring(0, 80) || fileName.substring(0, 60);
    }

    // ==================== 保存回答到文件 ====================
    async function saveResponseToFile(text, title, config, originalPdfName) {
        const autoSave = config.autoSave !== false;
        log(`💾 准备保存: autoSave=${autoSave}, savePath=${config.savePath}`, 'info');
        if (!autoSave) {
            log('💾 自动保存未开启', 'info');
            return false;
        }

        // v4.4.0: 文件名带原始 PDF 名前缀，统一可追溯
        let namePrefix = '';
        if (originalPdfName) {
            namePrefix = originalPdfName.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
        }
        const titleClean = title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
        const fileName = (namePrefix ? namePrefix + '_' : '') + titleClean + '.md';

        // 浏览器下载（保存到默认下载目录）
        try {
            const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            log(`💾 文件已下载: ${fileName}`, 'success');

            try {
                if (typeof GM_setClipboard !== 'undefined') {
                    GM_setClipboard(text);
                    log('📋 回答已复制到剪贴板', 'info');
                }
            } catch(e) {}
            return true;
        } catch(e) {
            log(`❌ 下载失败: ${e.message}`, 'error');
            return false;
        }
    }

    // ==================== 新建对话 ====================
    async function startNewChat() {
        log('🆕 正在新建对话...', 'info');
        await sleep(3000);

        // 策略1: 找"新对话"按钮
        const allBtns = document.querySelectorAll('button, a, div[role="button"], span[role="button"]');
        const keywords = ['新对话', '新建对话', '新聊天', '发起新', 'new chat', 'New Chat'];
        for (const btn of allBtns) {
            if (isInsideOurPanel(btn)) continue;
            const text = (btn.textContent || '').trim();
            if (text.length > 0 && text.length <= 20) {
                for (const kw of keywords) {
                    if (text.includes(kw)) {
                        log('🆕 点击: ' + text, 'info');
                        btn.click();
                        await sleep(3000);
                        const editable = document.querySelector('[contenteditable="true"], [role="textbox"], textarea');
                        if (editable && (!editable.textContent || editable.textContent.trim().length < 5)) {
                            log('✅ 新对话成功', 'success');
                            return true;
                        }
                    }
                }
            }
        }

        // 策略2: 侧边栏首按钮
        const sidebar = document.querySelector('[class*="side"], nav, aside');
        if (sidebar) {
            const btns = sidebar.querySelectorAll('button, [role="button"]');
            for (const btn of btns) {
                if (isInsideOurPanel(btn)) continue;
                const rect = btn.getBoundingClientRect();
                if (rect.top < 150 && rect.width > 0) {
                    log('🆕 点击侧边栏按钮', 'info');
                    btn.click();
                    await sleep(3000);
                    const editable = document.querySelector('[contenteditable="true"], [role="textbox"], textarea');
                    if (editable && (!editable.textContent || editable.textContent.trim().length < 5)) {
                        log('✅ 新对话成功(侧边栏)', 'success');
                        return true;
                    }
                }
            }
        }

        // 策略3: 导航到 /chat
        log('🔄 尝试URL新建对话', 'warn');
        const url = window.location.href;
        const baseUrl = url.replace(/\/chat\/[^/?]+/, '/chat');
        if (baseUrl !== url) {
            if (STATE.running) setResumeState('新建对话-URL跳转');
            window.location.href = baseUrl;
            await sleep(8000);
            return true;
        }

        // 策略4: 导航到首页
        log('🔄 导航到豆包首页', 'warn');
        if (STATE.running) setResumeState('新建对话-跳转首页');
        window.location.href = 'https://www.doubao.com/chat';
        await sleep(8000);
        return true;
    }

    // ==================== 冷却 + 唤醒 ====================
    /**
     * v4.0.0 新增：无效回答后冷却 + 发日常问题唤醒豆包
     */
    async function cooldownAndWake(config) {
        const cooldownMs = (config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES) * 60 * 1000;
        log(`😴 检测到无效回答，进入冷却期 ${Math.round(cooldownMs/60000)} 分钟...`, 'warn');
        persistLog(`无效回答冷却开始，预计 ${Math.round(cooldownMs/60000)} 分钟`, 'warn');

        // 倒计时等待
        const start = Date.now();
        while (Date.now() - start < cooldownMs) {
            while (STATE.paused && STATE.running) { await sleep(1000); }
            if (!STATE.running) return;
            await sleep(1000);
        }

        if (!STATE.running) return;

        // 发送日常问题唤醒豆包
        const wakePrompt = config.wakeupPrompt || DEFAULT_WAKEUP_PROMPT;
        log(`🌅 冷却完成，发送日常问题唤醒豆包: "${wakePrompt}"`, 'info');

        // 新建对话
        await startNewChat();
        await sleep(2000);

        // 输入日常问题
        const entered = await typePromptIntoChat(wakePrompt);
        if (entered) {
            await sleep(1000 + Math.random() * 500);
            const baseline = markBaseline();
            STATE.sseText = '';
            STATE.sseDone = false;
            STATE.sseActive = false;
            clickSendButton();
            log('📨 日常问题已发送，等待回答...', 'info');

            // 等待回答（不需要保存）
            await waitForResponseComplete(5 * 60 * 1000, baseline, config);
            log('✅ 唤醒完成，继续上传', 'success');
            persistLog('冷却+唤醒完成，继续上传', 'info');
        } else {
            log('⚠️ 日常问题输入失败，直接继续上传', 'warn');
        }

        // 再新建对话准备下一次上传
        await sleep(2000);
        await startNewChat();
    }

    // ==================== 上传引擎 ====================
    async function uploadOneFile(queueItem) {
        const { name, file, handle } = queueItem;
        const config = getConfig();
        log(`📤 正在处理: ${name}`, 'info');
        persistLog(`开始处理: ${name}`, 'info');

        try {
            let fileObj = file;
            if (!fileObj && handle) {
                fileObj = await getFileFromHandle(handle);
            }
            if (!fileObj) {
                log(`❌ 无法读取文件: ${name}`, 'error');
                persistLog(`无法读取文件: ${name}`, 'error');
                return false;
            }

            const fileInput = await waitForFileInput(FILE_INPUT_WAIT_TIMEOUT);
            if (!fileInput) {
                log(`❌ 未找到上传入口: ${name}`, 'error');
                persistLog(`未找到上传入口: ${name}`, 'error');
                return false;
            }

            setFileToInput(fileInput, fileObj);

            const uploadWaitSec = config.uploadWaitSeconds || DEFAULT_UPLOAD_WAIT_SECONDS;
            const uploadWait = (uploadWaitSec * 1000) + Math.random() * 2000;
            log(`📎 文件已上传，等待 ${Math.round(uploadWait/1000)} 秒后操作...`, 'info');
            await sleep(uploadWait);

            let promptEntered = false;
            const useDefaultBtn = config.useDoubaoDefaultButton === true;

            // v4.3.1: 豆包默认按钮模式 — 点击前就打基线（AI 会在点击后立即开始回答）
            let baseline = null;
            if (useDefaultBtn) {
                STATE.sseText = '';
                STATE.sseDone = false;
                STATE.sseActive = false;
                baseline = markBaseline();
                log('🚀 豆包默认按钮模式: 点击前已标记基线', 'info');

                promptEntered = await clickDoubaoDefaultSummaryButton();
                if (promptEntered) {
                    log('📨 ' + name + ' (豆包默认按钮已发起对话)', 'success');
                } else {
                    log('⚠️ 未找到豆包默认按钮，回退到自定义 Prompt', 'warn');
                }
            }

            // 自定义 Prompt 模式
            if (!promptEntered) {
                const autoPromptOn = config.autoPrompt !== false;
                if (autoPromptOn && config.promptText) {
                    log('📝 自动 Prompt 已开启，开始输入...', 'info');
                    promptEntered = await typePromptIntoChat(getRotatedPrompt());
                    if (promptEntered) {
                        const promptDoneSec = config.promptDoneWaitSeconds || DEFAULT_PROMPT_DONE_WAIT_SECONDS;
                        const promptDoneWait = promptDoneSec * 1000 + Math.random() * 500;
                        log(`✅ Prompt 已输入，等待 ${Math.round(promptDoneWait/1000)} 秒后发送...`, 'info');
                        await sleep(promptDoneWait);
                    } else {
                        log('⚠️ Prompt 输入失败', 'warn');
                    }
                }

                if (autoPromptOn && config.promptText && !promptEntered) {
                    log(`⏭ 跳过发送（Prompt 未输入成功）: ${name}`, 'warn');
                    persistLog(`跳过（Prompt未输入）: ${name}`, 'warn');
                    return false;
                }

                const presendSec = config.presendWaitSeconds || DEFAULT_PRESEND_WAIT_SECONDS;
                const sendDelay = (presendSec * 1000) + Math.random() * 2000;
                log(`⏳ 最后缓冲 ${Math.round(sendDelay/1000)} 秒后发送...`, 'info');
                await sleep(sendDelay);

                if (!baseline) baseline = markBaseline();
                STATE.sseText = '';
                STATE.sseDone = false;
                STATE.sseActive = false;

                let sent = clickSendButton();
                if (sent) {
                    log(`📨 已发送: ${name}`, 'success');
                } else {
                    log(`⚠️ 未能发送: ${name}`, 'warn');
                }
            }

            const responseText = await waitForResponseComplete(15 * 60 * 1000, baseline, config);

            // v4.0.0 核心：回答质量验证
            if (responseText) {
                const validation = isValidResponse(responseText, config.promptText, useDefaultBtn);
                if (validation.valid) {
                    log(`✅ 回答有效: ${validation.reason}`, 'success');
                    log(`📝 收到回答 (${responseText.length} 字符)，开始保存...`, 'info');
                    const title = extractTitleFromResponse(responseText, name);
                    log(`📝 提取标题: ${title}`, 'info');
                    const saved = await saveResponseToFile(responseText, title, config, name);
                    if (saved) {
                        log(`✅ 回答已保存: ${title}.md`, 'success');
                        persistLog(`完成: ${name} → ${title}.md`, 'success');
                    } else {
                        log(`⚠️ 回答保存失败`, 'warn');
                        persistLog(`保存失败: ${name}`, 'warn');
                    }
                    addUploaded(name, 'success');
                    STATE.consecutiveFailures = 0;
                    updateStats();
                    return true;
                } else {
                    // 无效回答！
                    log(`❌ 回答无效: ${validation.reason}`, 'error');
                    log(`📄 无效内容前200字: ${responseText.substring(0, 200).replace(/\n/g, ' ')}`, 'warn');
                    persistLog(`无效回答: ${name} — ${validation.reason}`, 'error');

                    addUploaded(name, 'invalid');
                    STATE.consecutiveFailures++;
                    updateStats();

                    // 进入冷却 + 唤醒流程
                    await cooldownAndWake(config);
                    return false;
                }
            } else {
                log('⚠️ 未获取到回答内容', 'warn');
                persistLog(`无回答: ${name}`, 'warn');
                addUploaded(name, 'no_response');
                STATE.consecutiveFailures++;
                updateStats();

                // 连续无回答也冷却
                if (STATE.consecutiveFailures >= 2) {
                    await cooldownAndWake(config);
                }
                return false;
            }

        } catch(e) {
            log(`❌ 处理异常: ${name} - ${e.message}`, 'error');
            persistLog(`异常: ${name} — ${e.message}`, 'error');
            return false;
        }
    }

    // ==================== 时间窗口检查 ====================
    function isWithinSchedule(config) {
        const startTime = config.scheduleStart || '';
        const endTime = config.scheduleEnd || '';
        if (!startTime || !endTime) return true; // 未设置=不限

        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const [sh, sm] = startTime.split(':').map(Number);
        const [eh, em] = endTime.split(':').map(Number);
        const startMin = sh * 60 + sm;
        const endMin = eh * 60 + em;

        if (startMin <= endMin) {
            // 不跨天: 如 08:00 ~ 22:00
            return nowMinutes >= startMin && nowMinutes <= endMin;
        } else {
            // 跨天: 如 22:00 ~ 08:00
            return nowMinutes >= startMin || nowMinutes <= endMin;
        }
    }

    function getNextScheduleStart(config) {
        const startTime = config.scheduleStart || '';
        if (!startTime) return null;
        const [sh, sm] = startTime.split(':').map(Number);
        const now = new Date();
        const target = new Date(now);
        target.setHours(sh, sm, 0, 0);
        if (target <= now) target.setDate(target.getDate() + 1);
        return target;
    }

    function formatTimeRemaining(ms) {
        if (ms <= 0) return '即将开始';
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        if (h > 0) return `${h} 小时 ${m} 分钟`;
        return `${m} 分钟`;
    }

    async function runUploadLoop() {
        const config = getConfig();

        STATE.running = true;
        STATE.paused = false;
        STATE.consecutiveFailures = 0;
        updateButtons();
        setResumeState('开始批量上传');

        // v4.4.0: 时间窗口提示
        if (config.scheduleStart && config.scheduleEnd) {
            if (isWithinSchedule(config)) {
                log(`⏰ 时间窗口: ${config.scheduleStart} ~ ${config.scheduleEnd}（当前在窗口内）`, 'info');
            } else {
                const next = getNextScheduleStart(config);
                const waitMs = next ? next - new Date() : 0;
                log(`⏰ 当前 ${new Date().toTimeString().slice(0,5)} 不在窗口 ${config.scheduleStart}~${config.scheduleEnd} 内，等待 ${formatTimeRemaining(waitMs)} 后自动启动...`, 'warn');
            }
        }

        log(`▶ 开始批量上传，共 ${STATE.queue.length} 个文件，间隔 ${config.intervalMinutes} 分钟`, 'info');
        persistLog(`开始批量上传，共 ${STATE.queue.length} 个文件`, 'info');

        for (let i = 0; i < STATE.queue.length; i++) {
            while (STATE.paused && STATE.running) { await sleep(1000); }
            if (!STATE.running) {
                log('⏹ 上传已停止', 'warn');
                persistLog('上传已停止', 'warn');
                break;
            }

            // v4.4.0: 时间窗口检查 — 不在窗口内则等待
            const cfg = getConfig();
            while (!isWithinSchedule(cfg) && STATE.running) {
                const next = getNextScheduleStart(cfg);
                const waitMs = next ? next - new Date() : 60000;
                if (waitMs > 0) {
                    const oldPaused = STATE.paused;
                    STATE.paused = true;
                    updateButtons();
                    updateScheduleStatus(cfg);
                    log(`⏰ 时间窗口外 (${cfg.scheduleStart}~${cfg.scheduleEnd})，暂停中... 约 ${formatTimeRemaining(waitMs)} 后恢复`, 'warn');
                    await sleep(Math.min(waitMs, 60000)); // 每 60 秒重检
                    STATE.paused = oldPaused;
                    updateButtons();
                } else {
                    await sleep(10000);
                }
                if (!STATE.running) break;
            }
            if (!STATE.running) break;
            updateScheduleStatus(cfg);
            if (STATE.paused) {
                STATE.paused = false;
                updateButtons();
                log('⏰ 进入时间窗口，自动恢复上传', 'success');
            }

            STATE.currentIndex = i;
            updateStats();
            updateQueueList();

            const item = STATE.queue[i];
            const uploaded = getUploadedSet();
            if (uploaded.has(item.name)) {
                log(`⏭ 跳过已上传: ${item.name}`, 'info');
                continue;
            }

            setResumeState('处理中: ' + item.name);
            const success = await uploadOneFile(item);

            if (i < STATE.queue.length - 1 && STATE.running) {
                const baseInterval = config.intervalMinutes * 60 * 1000;
                const jitter = (Math.random() - 0.5) * 60000;
                const actualWait = Math.max(30000, baseInterval + jitter);
                log(`⏰ 等待 ${Math.round(actualWait/1000)} 秒后处理下一个文件...`, 'info');
                const waitStart = Date.now();
                while (Date.now() - waitStart < actualWait) {
                    while (STATE.paused && STATE.running) { await sleep(1000); }
                    if (!STATE.running) break;
                    await sleep(1000);
                }
            }
        }

        STATE.running = false;
        STATE.paused = false;
        STATE.currentIndex = -1;
        updateButtons();
        updateStats();
        clearResumeState();

        const allDone = STATE.queue.every(item => getUploadedSet().has(item.name));
        if (allDone) {
            log('✅ 所有文件上传完成！', 'success');
            persistLog('所有文件上传完成！', 'success');
        } else {
            log('⏸ 上传结束（有未完成项，可继续）', 'warn');
            persistLog('上传结束，有未完成项', 'warn');
        }
    }

    // ==================== 构建队列 ====================
    async function buildQueueFromDir() {
        if (!STATE.dirHandle) return;
        const files = await listPdfFiles(STATE.dirHandle);
        STATE.queue = files.map(f => ({ name: f.name, handle: f.handle }));
        log(`📋 从文件夹加载: ${files.length} 个PDF文件`, 'info');
        updateStats();
        updateQueueList();
    }

    function addToQueueFromDrop(droppedFiles) {
        const existing = new Set(STATE.queue.map(q => q.name));
        let added = 0;
        for (const df of droppedFiles) {
            if (!existing.has(df.name)) {
                STATE.queue.push({ name: df.name, file: df.file });
                added++;
            }
        }
        if (added > 0) {
            log(`📥 拖拽添加了 ${added} 个PDF文件`, 'info');
            updateStats();
            updateQueueList();
        }
    }

    // ==================== 日志系统 ====================
    function log(message, level) {
        const now = new Date();
        const time = now.toTimeString().slice(0, 8);
        const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
        const icon = icons[level] || 'ℹ️';
        const line = `[${time}] ${icon} ${message}`;

        const logContainer = STATE.ui.logContainer;
        if (logContainer) {
            const entry = document.createElement('div');
            entry.className = `db-log-entry db-log-${level}`;
            entry.textContent = line;
            logContainer.appendChild(entry);
            logContainer.scrollTop = logContainer.scrollHeight;
        }

        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);

        // 持久化
        persistLog(message, level);
    }

    // ==================== UI 面板 ====================
    function createPanel() {
        GM_addStyle(`
            #db-uploader-panel {
                position: fixed; top: 100px; right: 20px; z-index: 99999;
                width: 440px; max-height: 85vh;
                background: #1a1a2e; color: #e0e0e0;
                border-radius: 12px; box-shadow: 0 8px 40px rgba(0,0,0,0.5);
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
                font-size: 13px; line-height: 1.5;
                display: flex; flex-direction: column;
                overflow: hidden;
                border: 1px solid #2a2a4a;
                user-select: none;
            }
            #db-uploader-panel.db-collapsed { width: 48px; height: 48px; border-radius: 24px; }
            #db-uploader-panel.db-collapsed .db-content { display: none; }
            #db-uploader-panel.db-collapsed .db-minimize-icon { display: block; }
            #db-uploader-panel.db-collapsed .db-header-text { display: none; }

            .db-header {
                display: flex; align-items: center; padding: 10px 14px;
                background: linear-gradient(135deg, #16213e 0%, #1a1a2e 100%);
                border-bottom: 1px solid #2a2a4a;
                cursor: move;
                border-radius: 12px 12px 0 0;
                gap: 8px;
            }
            .db-header-icon { font-size: 18px; }
            .db-header-text { font-weight: 600; font-size: 14px; white-space: nowrap; }
            .db-header-spacer { flex: 1; }
            .db-header-btn {
                background: none; border: 1px solid #3a3a5a; color: #aaa;
                border-radius: 6px; cursor: pointer; padding: 4px 8px;
                font-size: 12px; transition: all 0.2s;
            }
            .db-header-btn:hover { background: #3a3a5a; color: #fff; }
            .db-minimize-icon { display: none; cursor: pointer; font-size: 20px; }

            .db-content {
                flex: 1; overflow-y: auto; padding: 12px 14px;
                display: flex; flex-direction: column; gap: 10px;
            }

            .db-section { display: flex; flex-direction: column; gap: 6px; }
            .db-section-title {
                font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
                color: #6a6a8a; margin-bottom: 2px;
            }
            .db-row { display: flex; align-items: center; gap: 8px; }
            .db-label { color: #aaa; font-size: 12px; min-width: 60px; white-space: nowrap; }

            .db-btn {
                padding: 6px 14px; border: none; border-radius: 6px;
                cursor: pointer; font-size: 12px; font-weight: 500;
                transition: all 0.2s;
            }
            .db-btn-primary { background: #4a6cf7; color: #fff; }
            .db-btn-primary:hover { background: #5a7cf7; }
            .db-btn-success { background: #10b981; color: #fff; }
            .db-btn-success:hover { background: #059669; }
            .db-btn-warn { background: #f59e0b; color: #fff; }
            .db-btn-warn:hover { background: #d97706; }
            .db-btn-danger { background: #ef4444; color: #fff; }
            .db-btn-danger:hover { background: #dc2626; }
            .db-btn-outline {
                background: transparent; border: 1px solid #4a6cf7; color: #4a6cf7;
            }
            .db-btn-outline:hover { background: rgba(74,108,247,0.1); }
            .db-btn:disabled { opacity: 0.4; cursor: not-allowed; }
            .db-btn-sm { padding: 4px 10px; font-size: 11px; }

            .db-input {
                background: #16213e; border: 1px solid #2a2a4a; color: #e0e0e0;
                border-radius: 6px; padding: 6px 10px; font-size: 12px;
                width: 60px; text-align: center;
            }
            .db-input:focus { outline: none; border-color: #4a6cf7; }
            input[type=number].db-input { -moz-appearance: textfield; }
            input[type=number].db-input::-webkit-inner-spin-button,
            input[type=number].db-input::-webkit-outer-spin-button { opacity: 1; }

            .db-folder-display {
                flex: 1; padding: 6px 10px; background: #16213e;
                border: 1px dashed #3a3a5a; border-radius: 6px;
                color: #6a6a8a; font-size: 12px; white-space: nowrap;
                overflow: hidden; text-overflow: ellipsis;
            }
            .db-folder-display.active { color: #10b981; border-color: #10b981; border-style: solid; }

            .db-stats {
                display: flex; gap: 12px; padding: 8px 12px;
                background: #16213e; border-radius: 8px;
                font-size: 12px; color: #aaa;
            }
            .db-stat-value { color: #4a6cf7; font-weight: 600; }
            .db-stat-value.success { color: #10b981; }
            .db-stat-value.warn { color: #f59e0b; }
            .db-stat-value.error { color: #ef4444; }

            .db-progress-bar {
                height: 6px; background: #2a2a4a; border-radius: 3px;
                overflow: hidden; margin-top: 4px;
            }
            .db-progress-fill {
                height: 100%; background: linear-gradient(90deg, #4a6cf7, #10b981);
                border-radius: 3px; transition: width 0.3s;
            }

            .db-log-container {
                background: #0d0d1a; border-radius: 8px;
                padding: 8px; max-height: 200px; overflow-y: auto;
                font-family: "JetBrains Mono", "Fira Code", "Consolas", monospace;
                font-size: 11px; line-height: 1.6;
            }
            .db-log-entry { padding: 1px 0; }
            .db-log-info { color: #a0a0c0; }
            .db-log-success { color: #10b981; }
            .db-log-warn { color: #f59e0b; }
            .db-log-error { color: #ef4444; font-weight: 600; }

            .db-queue-list {
                max-height: 400px; overflow-y: auto;
                background: #16213e; border-radius: 6px;
                padding: 4px 8px;
            }
            .db-queue-item {
                padding: 3px 6px; border-radius: 4px;
                font-size: 11px; color: #aaa;
                display: flex; align-items: center; gap: 6px;
                cursor: pointer;
            }
            .db-queue-item:hover { background: rgba(74,108,247,0.1); }
            .db-queue-item.current { background: rgba(74,108,247,0.15); color: #4a6cf7; font-weight: 600; }
            .db-queue-item.done { color: #10b981; }
            .db-queue-item.invalid { color: #ef4444; }
            .db-queue-item.selected { background: rgba(245,158,11,0.15); color: #f59e0b; }
            .db-queue-item .db-queue-dot { font-size: 8px; }
            .db-queue-item.current .db-queue-dot { color: #4a6cf7; }
            .db-queue-item.done .db-queue-dot { color: #10b981; }
            .db-queue-item.invalid .db-queue-dot { color: #ef4444; }

            .db-divider { border: none; border-top: 1px solid #2a2a4a; margin: 4px 0; }

            .db-prompt-tabs {
                display: flex; gap: 2px; flex-wrap: wrap;
            }
            .db-prompt-tab {
                padding: 5px 10px; border-radius: 6px 6px 0 0;
                background: #0d0d1a; color: #6a6a8a;
                font-size: 11px; cursor: pointer; border: 1px solid transparent;
                transition: all 0.2s; white-space: nowrap;
            }
            .db-prompt-tab:hover { color: #aaa; background: #16213e; }
            .db-prompt-tab.active {
                background: #16213e; color: #4a6cf7;
                border-color: #2a2a4a; border-bottom-color: #16213e;
                font-weight: 600;
            }
            .db-prompt-textarea {
                width: 100%; height: 100px;
                background: #16213e; border: 1px solid #2a2a4a; color: #e0e0e0;
                border-radius: 0 6px 6px 6px;
                padding: 6px 10px; font-size: 11px; line-height: 1.4;
                resize: vertical; font-family: inherit;
            }
            .db-prompt-textarea:focus { outline: none; border-color: #4a6cf7; }
            .db-prompt-rotate-row {
                display: flex; align-items: center; gap: 8px; margin-top: 4px;
            }
            .db-prompt-rotate-row label {
                color: #aaa; font-size: 12px; display: flex; align-items: center; gap: 4px; cursor: pointer;
            }

            .db-drop-overlay {
                position: fixed; inset: 0; z-index: 99998;
                background: rgba(74,108,247,0.15);
                border: 3px dashed #4a6cf7;
                display: none; align-items: center; justify-content: center;
                pointer-events: none;
            }
            .db-drop-overlay.active { display: flex; }
            .db-drop-text {
                background: rgba(26,26,46,0.95); color: #4a6cf7;
                padding: 24px 48px; border-radius: 16px;
                font-size: 20px; font-weight: 700;
                pointer-events: none;
            }

            .db-content::-webkit-scrollbar,
            .db-log-container::-webkit-scrollbar,
            .db-queue-list::-webkit-scrollbar { width: 4px; }
            .db-content::-webkit-scrollbar-track,
            .db-log-container::-webkit-scrollbar-track,
            .db-queue-list::-webkit-scrollbar-track { background: transparent; }
            .db-content::-webkit-scrollbar-thumb,
            .db-log-container::-webkit-scrollbar-thumb,
            .db-queue-list::-webkit-scrollbar-thumb { background: #3a3a5a; border-radius: 2px; }
        `);

        const dropOverlay = document.createElement('div');
        dropOverlay.id = 'db-drop-overlay';
        dropOverlay.className = 'db-drop-overlay';
        dropOverlay.innerHTML = '<div class="db-drop-text">📂 释放以上传 PDF 文件夹</div>';
        document.body.appendChild(dropOverlay);

        const panel = document.createElement('div');
        panel.id = 'db-uploader-panel';
        panel.innerHTML = `
            <div class="db-header" id="db-header-drag">
                <span class="db-header-icon">📁</span>
                <span class="db-header-text">豆包 PDF 批量上传器 v4.5.0</span>
                <span class="db-header-spacer"></span>
                <span class="db-minimize-icon" id="db-minimize-icon" title="展开">📁</span>
                <button class="db-header-btn" id="db-btn-minimize" title="最小化">−</button>
            </div>
            <div class="db-content" id="db-content">
                <div class="db-section">
                    <div class="db-section-title">📂 文件夹</div>
                    <div class="db-row">
                        <span class="db-folder-display" id="db-folder-display">未选择</span>
                        <button class="db-btn db-btn-outline db-btn-sm" id="db-btn-pick">选择</button>
                        <button class="db-btn db-btn-outline db-btn-sm" id="db-btn-refresh" disabled>🔄</button>
                    </div>
                </div>

                <hr class="db-divider">

                <div class="db-section">
                    <div class="db-section-title">⚙️ 间隔设置 (全部可调)</div>
                    <div class="db-row">
                        <span class="db-label">上传间隔</span>
                        <input type="number" class="db-input" id="db-input-interval" min="0.1" step="0.5" value="${DEFAULT_INTERVAL_MINUTES}">
                        <span style="color:#aaa;font-size:12px;">分钟</span>
                    </div>
                    <div class="db-row">
                        <span class="db-label">最短等待</span>
                        <input type="number" class="db-input" id="db-input-min-wait" min="30" step="10" value="${DEFAULT_MIN_WAIT_SECONDS}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">秒</span>
                    </div>
                    <div class="db-row">
                        <span class="db-label">稳定判定</span>
                        <input type="number" class="db-input" id="db-input-stable" min="5" step="1" value="${DEFAULT_STABLE_THRESHOLD}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">次(×2秒)</span>
                    </div>
                    <div class="db-row">
                        <span class="db-label">冷却时间</span>
                        <input type="number" class="db-input" id="db-input-cooldown" min="10" step="10" value="${DEFAULT_COOLDOWN_MINUTES}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">分钟(无效回答后)</span>
                    </div>
                    <div class="db-row">
                        <span class="db-label">上传后等待</span>
                        <input type="number" class="db-input" id="db-input-upload-wait" min="1" step="0.5" value="${DEFAULT_UPLOAD_WAIT_SECONDS}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">秒(上传→输入Prompt)</span>
                    </div>
                    <div class="db-row">
                        <span class="db-label">Prompt后等待</span>
                        <input type="number" class="db-input" id="db-input-prompt-done-wait" min="0.5" step="0.5" value="${DEFAULT_PROMPT_DONE_WAIT_SECONDS}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">秒(Prompt完成→发送)</span>
                    </div>
                    <div class="db-row">
                        <span class="db-label">发送前等待</span>
                        <input type="number" class="db-input" id="db-input-presend-wait" min="0.5" step="0.5" value="${DEFAULT_PRESEND_WAIT_SECONDS}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">秒(最后缓冲)</span>
                    </div>
                    <div class="db-row" style="margin-top:8px;">
                        <span class="db-label">⏰ 时间窗口</span>
                        <input type="time" id="db-input-schedule-start" style="background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:4px 8px;font-size:12px;width:130px;">
                        <span style="color:#aaa;font-size:12px;">&nbsp;至&nbsp;</span>
                        <input type="time" id="db-input-schedule-end" style="background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:4px 8px;font-size:12px;width:130px;">
                        <span style="color:#aaa;font-size:11px;" id="db-schedule-status">(未设置)</span>
                    </div>
                </div>

                <div class="db-section">
                    <div class="db-section-title">🌅 唤醒设置</div>
                    <div class="db-row">
                        <input type="text" id="db-input-wakeup" style="flex:1;background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:6px 10px;font-size:12px;" placeholder="冷却后发送的日常问题" value="${DEFAULT_WAKEUP_PROMPT}">
                    </div>
                </div>

                <hr class="db-divider">

                <div class="db-section">
                    <div class="db-section-title">⚙️ 选项</div>
                    <div class="db-row">
                        <label style="color:#aaa;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;">
                            <input type="checkbox" id="db-checkbox-autoprompt" checked> 上传后自动输入 Prompt
                        </label>
                    </div>
                    <div class="db-row">
                        <label style="color:#aaa;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;">
                            <input type="checkbox" id="db-checkbox-autosave" checked> 自动保存回答
                        </label>
                    </div>
                </div>

                <div class="db-section">
                    <div class="db-section-title">📝 Prompt 模板（5种变体轮换抗风控）</div>
                    <div class="db-prompt-tabs" id="db-prompt-tabs">
                        <span class="db-prompt-tab active" data-tab="0">🧑‍🔬 博士后</span>
                        <span class="db-prompt-tab" data-tab="1">👨‍🏫 资深研究员</span>
                        <span class="db-prompt-tab" data-tab="2">🎓 博士生</span>
                        <span class="db-prompt-tab" data-tab="3">📝 审稿人</span>
                        <span class="db-prompt-tab" data-tab="4">🏭 工业研发</span>
                    </div>
                    <textarea class="db-prompt-textarea" id="db-textarea-prompt" placeholder="上传文件后自动输入的 Prompt..."></textarea>
                    <div class="db-prompt-rotate-row">
                        <label>
                            <input type="checkbox" id="db-checkbox-auto-rotate" checked> 🔄 自动轮换（每次上传用下一个变体）
                        </label>
                        <label style="margin-left:12px;">
                            <input type="checkbox" id="db-checkbox-default-btn"> 🚀 用豆包默认按钮（点击「详细总结这篇文档内容」代替输入Prompt）
                        </label>
                        <span style="color:#6a6a8a;font-size:10px;">（当前轮换位: <span id="db-rotate-index">-</span>）</span>
                    </div>
                    <div class="db-row" style="gap:6px;">
                        <button class="db-btn db-btn-outline db-btn-sm" id="db-btn-save-prompt">保存</button>
                        <button class="db-btn db-btn-outline db-btn-sm" id="db-btn-reset-prompt">恢复默认</button>
                    </div>
                </div>

                <hr class="db-divider">

                <div class="db-stats" id="db-stats">
                    <span>队列: <span class="db-stat-value" id="db-queue-count">0</span></span>
                    <span>已完成: <span class="db-stat-value success" id="db-uploaded-count">0</span></span>
                    <span>无效: <span class="db-stat-value error" id="db-invalid-count">0</span></span>
                    <span>当前: <span class="db-stat-value warn" id="db-current-file">-</span></span>
                </div>
                <div class="db-progress-bar">
                    <div class="db-progress-fill" id="db-progress-fill" style="width:0%"></div>
                </div>

                <div class="db-section">
                    <div class="db-section-title">📋 队列列表 (点击选择/取消选择)</div>
                    <div class="db-queue-list" id="db-queue-list">
                        <div style="color:#6a6a8a;font-size:11px;">暂无文件，选择文件夹或拖拽PDF以添加</div>
                    </div>
                </div>

                <div class="db-section">
                    <div class="db-section-title">🎯 按序号上传</div>
                    <div class="db-row" style="gap:6px;">
                        <input type="text" id="db-input-range" style="flex:1;background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:6px 10px;font-size:12px;" placeholder="输入序号，如 1,3,5-10,15">
                        <button class="db-btn db-btn-outline db-btn-sm" id="db-btn-upload-range" title="按序号上传指定文件">🎯 上传指定</button>
                    </div>
                    <div style="color:#6a6a8a;font-size:10px;margin-top:2px;">格式: 单个序号(3)、逗号分隔(1,3,5)、范围(5-10)、混合(1,3,5-10)</div>
                </div>

                <div class="db-row" style="gap:6px;flex-wrap:wrap;">
                    <button class="db-btn db-btn-success" id="db-btn-start" disabled>▶ 开始</button>
                    <button class="db-btn db-btn-warn" id="db-btn-pause" disabled>⏸ 暂停</button>
                    <button class="db-btn db-btn-danger" id="db-btn-stop" disabled>⏹ 停止</button>
                    <button class="db-btn db-btn-outline db-btn-sm" id="db-btn-reset" title="清除已上传记录">🔄 重置</button>
                    <button class="db-btn db-btn-outline db-btn-sm" id="db-btn-export-log" title="导出日志和进度">📜 导出日志</button>
                    <button class="db-btn db-btn-outline db-btn-sm" id="db-btn-import-log" title="读取导出的日志文件恢复进度">📥 读取日志</button>
                    <button class="db-btn db-btn-outline db-btn-sm" id="db-btn-retry-failed" title="重试所有无效回答的文件" disabled>🔁 重试失败</button>
                    <button class="db-btn db-btn-outline db-btn-sm" id="db-btn-upload-selected" title="仅上传选中的文件" disabled>📌 上传选中</button>
                </div>

                <hr class="db-divider">

                <div class="db-section">
                    <div class="db-section-title">📜 日志</div>
                    <div class="db-log-container" id="db-log-container">
                        <div class="db-log-entry db-log-info">🚀 豆包 PDF 批量上传器 v4.5.0 已启动</div>
                        <div class="db-log-entry db-log-info">📌 选择文件夹或拖拽PDF到页面开始</div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        STATE.ui = {
            panel,
            content: panel.querySelector('#db-content'),
            folderDisplay: panel.querySelector('#db-folder-display'),
            btnPick: panel.querySelector('#db-btn-pick'),
            btnRefresh: panel.querySelector('#db-btn-refresh'),
            btnStart: panel.querySelector('#db-btn-start'),
            btnPause: panel.querySelector('#db-btn-pause'),
            btnStop: panel.querySelector('#db-btn-stop'),
            btnReset: panel.querySelector('#db-btn-reset'),
            btnMinimize: panel.querySelector('#db-btn-minimize'),
            minimizeIcon: panel.querySelector('#db-minimize-icon'),
            headerDrag: panel.querySelector('#db-header-drag'),
            inputInterval: panel.querySelector('#db-input-interval'),
            inputMinWait: panel.querySelector('#db-input-min-wait'),
            inputStable: panel.querySelector('#db-input-stable'),
            inputCooldown: panel.querySelector('#db-input-cooldown'),
            inputUploadWait: panel.querySelector('#db-input-upload-wait'),
            inputPromptDoneWait: panel.querySelector('#db-input-prompt-done-wait'),
            inputPresendWait: panel.querySelector('#db-input-presend-wait'),
            inputScheduleStart: panel.querySelector('#db-input-schedule-start'),
            inputScheduleEnd: panel.querySelector('#db-input-schedule-end'),
            scheduleStatus: panel.querySelector('#db-schedule-status'),
            inputWakeup: panel.querySelector('#db-input-wakeup'),
            checkboxAutoPrompt: panel.querySelector('#db-checkbox-autoprompt'),
            checkboxAutoSave: panel.querySelector('#db-checkbox-autosave'),
            textareaPrompt: panel.querySelector('#db-textarea-prompt'),
            promptTabs: panel.querySelector('#db-prompt-tabs'),
            checkboxAutoRotate: panel.querySelector('#db-checkbox-auto-rotate'),
            checkboxDefaultBtn: panel.querySelector('#db-checkbox-default-btn'),
            rotateIndex: panel.querySelector('#db-rotate-index'),
            btnSavePrompt: panel.querySelector('#db-btn-save-prompt'),
            btnResetPrompt: panel.querySelector('#db-btn-reset-prompt'),
            btnExportLog: panel.querySelector('#db-btn-export-log'),
            btnImportLog: panel.querySelector('#db-btn-import-log'),
            btnRetryFailed: panel.querySelector('#db-btn-retry-failed'),
            btnUploadSelected: panel.querySelector('#db-btn-upload-selected'),
            inputRange: panel.querySelector('#db-input-range'),
            btnUploadRange: panel.querySelector('#db-btn-upload-range'),
            queueCount: panel.querySelector('#db-queue-count'),
            uploadedCount: panel.querySelector('#db-uploaded-count'),
            invalidCount: panel.querySelector('#db-invalid-count'),
            currentFile: panel.querySelector('#db-current-file'),
            progressFill: panel.querySelector('#db-progress-fill'),
            queueList: panel.querySelector('#db-queue-list'),
            logContainer: panel.querySelector('#db-log-container'),
            dropOverlay,
        };

        bindUIEvents();
        panel.addEventListener('mousedown', onPanelDragStart);
        bindDropEvents();

        return panel;
    }

    // 选中的文件集合
    const selectedFiles = new Set();

    function bindUIEvents() {
        const ui = STATE.ui;

        ui.btnPick.addEventListener('click', async () => {
            const handle = await pickFolder();
            if (handle) {
                await buildQueueFromDir();
                ui.btnRefresh.disabled = false;
                ui.btnStart.disabled = STATE.queue.length === 0;
            }
        });

        ui.btnRefresh.addEventListener('click', async () => {
            if (STATE.dirHandle) {
                await buildQueueFromDir();
                ui.btnStart.disabled = STATE.queue.length === 0;
            }
        });

        // 间隔设置
        ui.inputInterval.addEventListener('change', () => {
            const val = parseFloat(ui.inputInterval.value);
            if (val > 0) { STATE.config.intervalMinutes = val; saveConfig(); log(`⏱ 上传间隔: ${val} 分钟`, 'info'); }
        });
        ui.inputMinWait.addEventListener('change', () => {
            const val = parseInt(ui.inputMinWait.value) || DEFAULT_MIN_WAIT_SECONDS;
            STATE.config.minWaitSeconds = val; saveConfig(); log(`⏱ 最短等待: ${val} 秒`, 'info');
        });
        ui.inputStable.addEventListener('change', () => {
            const val = parseInt(ui.inputStable.value) || DEFAULT_STABLE_THRESHOLD;
            STATE.config.stableThreshold = val; saveConfig(); log(`📊 稳定判定: ${val} 次`, 'info');
        });
        ui.inputCooldown.addEventListener('change', () => {
            const val = parseInt(ui.inputCooldown.value) || DEFAULT_COOLDOWN_MINUTES;
            STATE.config.cooldownMinutes = val; saveConfig(); log(`😴 冷却时间: ${val} 分钟`, 'info');
        });
        ui.inputUploadWait.addEventListener('change', () => {
            const val = parseFloat(ui.inputUploadWait.value) || DEFAULT_UPLOAD_WAIT_SECONDS;
            STATE.config.uploadWaitSeconds = val; saveConfig(); log(`⏱ 上传后等待: ${val} 秒`, 'info');
        });
        ui.inputPromptDoneWait.addEventListener('change', () => {
            const val = parseFloat(ui.inputPromptDoneWait.value) || DEFAULT_PROMPT_DONE_WAIT_SECONDS;
            STATE.config.promptDoneWaitSeconds = val; saveConfig(); log(`⏱ Prompt后等待: ${val} 秒`, 'info');
        });
        ui.inputPresendWait.addEventListener('change', () => {
            const val = parseFloat(ui.inputPresendWait.value) || DEFAULT_PRESEND_WAIT_SECONDS;
            STATE.config.presendWaitSeconds = val; saveConfig(); log(`⏱ 发送前等待: ${val} 秒`, 'info');
        });

        // v4.4.0: 时间窗口
        ui.inputScheduleStart.addEventListener('change', () => {
            STATE.config.scheduleStart = ui.inputScheduleStart.value;
            saveConfig();
            updateScheduleStatus();
            log(`⏰ 窗口起始: ${STATE.config.scheduleStart || '未设置'}`, 'info');
        });
        ui.inputScheduleEnd.addEventListener('change', () => {
            STATE.config.scheduleEnd = ui.inputScheduleEnd.value;
            saveConfig();
            updateScheduleStatus();
            log(`⏰ 窗口结束: ${STATE.config.scheduleEnd || '未设置'}`, 'info');
        });

        ui.inputWakeup.addEventListener('change', () => {
            STATE.config.wakeupPrompt = ui.inputWakeup.value.trim() || DEFAULT_WAKEUP_PROMPT;
            saveConfig(); log(`🌅 唤醒问题已更新`, 'info');
        });

        ui.checkboxAutoPrompt.addEventListener('change', () => {
            STATE.config.autoPrompt = ui.checkboxAutoPrompt.checked; saveConfig();
            log(`📝 自动 Prompt: ${STATE.config.autoPrompt ? '开启' : '关闭'}`, 'info');
        });
        ui.checkboxAutoSave.addEventListener('change', () => {
            STATE.config.autoSave = ui.checkboxAutoSave.checked; saveConfig();
            log(`💾 自动保存: ${STATE.config.autoSave ? '开启' : '关闭'}`, 'info');
        });

        // ==================== Prompt 标签页 ====================
        function switchPromptTab(tabIdx) {
            STATE.config.activePromptTab = tabIdx;
            saveConfig();
            ui.textareaPrompt.value = PROMPT_POOL[tabIdx];
            // 更新 tab 高亮
            const tabs = ui.promptTabs.querySelectorAll('.db-prompt-tab');
            tabs.forEach(t => { t.classList.toggle('active', parseInt(t.dataset.tab) === tabIdx); });
            log(`📝 切换到 Prompt 变体 #${tabIdx}`, 'info');
        }

        ui.promptTabs.addEventListener('click', (e) => {
            const tab = e.target.closest('.db-prompt-tab');
            if (!tab) return;
            const idx = parseInt(tab.dataset.tab);
            if (!isNaN(idx) && idx >= 0 && idx < PROMPT_POOL.length) {
                switchPromptTab(idx);
            }
        });

        // 自动轮换开关
        ui.checkboxAutoRotate.addEventListener('change', () => {
            STATE.config.autoRotateEnabled = ui.checkboxAutoRotate.checked;
            saveConfig();
            log(`🔄 自动轮换: ${ui.checkboxAutoRotate.checked ? '开启' : '关闭'}`, 'info');
        });

        // 豆包默认按钮开关
        ui.checkboxDefaultBtn.addEventListener('change', () => {
            STATE.config.useDoubaoDefaultButton = ui.checkboxDefaultBtn.checked;
            saveConfig();
            log(`🚀 使用豆包默认按钮: ${ui.checkboxDefaultBtn.checked ? '开启（点击「详细总结这篇文档」代替输入Prompt）' : '关闭（使用自定义Prompt）'}`, 'info');
        });

        ui.btnSavePrompt.addEventListener('click', () => {
            const tab = STATE.config.activePromptTab || 0;
            PROMPT_POOL[tab] = ui.textareaPrompt.value;
            STATE.config.promptText = ui.textareaPrompt.value;
            saveConfig();
            log(`✅ Prompt 变体 #${tab} 已保存`, 'success');
        });
        ui.btnResetPrompt.addEventListener('click', () => {
            const tab = STATE.config.activePromptTab || 0;
            const original = getOriginalPrompt(tab);
            PROMPT_POOL[tab] = original;
            ui.textareaPrompt.value = original;
            STATE.config.promptText = original;
            saveConfig();
            log(`🔄 Prompt 变体 #${tab} 已恢复默认`, 'info');
        });

        ui.btnStart.addEventListener('click', async () => {
            if (STATE.queue.length === 0) { log('⚠️ 队列为空', 'warn'); return; }
            if (STATE.running) return;
            ui.btnStart.disabled = true;
            ui.btnPause.disabled = false;
            ui.btnStop.disabled = false;
            await runUploadLoop();
        });

        ui.btnPause.addEventListener('click', () => {
            if (!STATE.running) return;
            STATE.paused = !STATE.paused;
            if (STATE.paused) {
                ui.btnPause.textContent = '▶ 继续';
                log('⏸ 已暂停', 'warn');
            } else {
                ui.btnPause.textContent = '⏸ 暂停';
                log('▶ 已恢复', 'info');
            }
        });

        ui.btnStop.addEventListener('click', () => {
            STATE.running = false; STATE.paused = false;
            clearResumeState();
            updateButtons(); log('⏹ 已停止上传', 'warn');
        });

        ui.btnReset.addEventListener('click', () => {
            if (confirm('确定要清除所有上传记录吗？这将允许重新上传所有文件。')) {
                clearUploaded(); selectedFiles.clear();
                updateStats(); updateQueueList();
                log('🔄 已重置上传记录', 'warn');
            }
        });

        ui.btnExportLog.addEventListener('click', () => {
            exportLogToFile();
            log('📜 日志已导出', 'success');
        });

        // 读取日志文件恢复进度
        ui.btnImportLog.addEventListener('click', () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.txt';
            input.style.display = 'none';
            document.body.appendChild(input);
            input.addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) { document.body.removeChild(input); return; }
                try {
                    const text = await file.text();
                    const result = parseLogAndRestore(text);
                    log(`📥 读取日志: 恢复 ${result.restored} 条记录 (成功 ${result.success}, 无效 ${result.invalid}, 无回答 ${result.noResponse})`, 'success');
                    updateStats();
                    updateQueueList();
                    updateRetryFailedButton();
                } catch(err) {
                    log(`❌ 读取日志失败: ${err.message}`, 'error');
                }
                document.body.removeChild(input);
            });
            input.click();
        });

        // 重试所有失败文件
        ui.btnRetryFailed.addEventListener('click', async () => {
            if (STATE.running) return;
            const records = getUploadRecords();
            const failedNames = records.filter(r => r.status === 'invalid' || r.status === 'no_response').map(r => r.name);
            if (failedNames.length === 0) { log('⚠️ 没有失败文件', 'warn'); return; }

            log(`🔁 开始重试 ${failedNames.length} 个失败文件`, 'info');
            persistLog(`重试失败文件: ${failedNames.length} 个`, 'info');

            // 清除这些文件的上传记录
            for (const name of failedNames) { removeUploaded(name); }
            updateStats();
            updateQueueList();

            // 构建重试队列
            const retryQueue = STATE.queue.filter(q => failedNames.includes(q.name));

            STATE.running = true;
            STATE.paused = false;
            updateButtons();

            for (let i = 0; i < retryQueue.length; i++) {
                while (STATE.paused && STATE.running) { await sleep(1000); }
                if (!STATE.running) break;

                const item = retryQueue[i];
                log(`🔁 [${i+1}/${retryQueue.length}] 重试: ${item.name}`, 'info');
                await uploadOneFile(item);

                if (i < retryQueue.length - 1 && STATE.running) {
                    const config = getConfig();
                    const baseInterval = config.intervalMinutes * 60 * 1000;
                    const jitter = (Math.random() - 0.5) * 60000;
                    const actualWait = Math.max(30000, baseInterval + jitter);
                    log(`⏰ 等待 ${Math.round(actualWait/1000)} 秒...`, 'info');
                    const waitStart = Date.now();
                    while (Date.now() - waitStart < actualWait) {
                        while (STATE.paused && STATE.running) { await sleep(1000); }
                        if (!STATE.running) break;
                        await sleep(1000);
                    }
                }
            }

            STATE.running = false;
            STATE.paused = false;
            updateButtons();
            updateStats();
            updateQueueList();
            updateRetryFailedButton();
            log('✅ 失败文件重试完成', 'success');
            persistLog('失败文件重试完成', 'success');
        });

        // 仅上传选中的文件
        ui.btnUploadSelected.addEventListener('click', async () => {
            if (selectedFiles.size === 0) { log('⚠️ 未选中任何文件', 'warn'); return; }
            if (STATE.running) return;

            // 构建临时队列
            const selectedQueue = STATE.queue.filter(q => selectedFiles.has(q.name));
            log(`📌 开始上传 ${selectedQueue.length} 个选中文件`, 'info');

            // 移除这些文件的上传记录以便重新上传
            for (const item of selectedQueue) {
                removeUploaded(item.name);
            }
            updateStats();
            updateQueueList();

            // 运行上传循环（只处理选中的）
            STATE.running = true;
            STATE.paused = false;
            updateButtons();

            for (let i = 0; i < selectedQueue.length; i++) {
                while (STATE.paused && STATE.running) { await sleep(1000); }
                if (!STATE.running) break;

                const item = selectedQueue[i];
                log(`📌 [${i+1}/${selectedQueue.length}] 处理选中文件: ${item.name}`, 'info');
                await uploadOneFile(item);

                if (i < selectedQueue.length - 1 && STATE.running) {
                    const config = getConfig();
                    const baseInterval = config.intervalMinutes * 60 * 1000;
                    const jitter = (Math.random() - 0.5) * 60000;
                    const actualWait = Math.max(30000, baseInterval + jitter);
                    log(`⏰ 等待 ${Math.round(actualWait/1000)} 秒...`, 'info');
                    const waitStart = Date.now();
                    while (Date.now() - waitStart < actualWait) {
                        while (STATE.paused && STATE.running) { await sleep(1000); }
                        if (!STATE.running) break;
                        await sleep(1000);
                    }
                }
            }

            STATE.running = false; STATE.paused = false;
            selectedFiles.clear();
            updateButtons(); updateStats(); updateQueueList();
            log('✅ 选中文件上传完成', 'success');
        });

        // 按序号上传指定文件
        ui.btnUploadRange.addEventListener('click', async () => {
            const rangeText = ui.inputRange.value.trim();
            if (!rangeText) { log('⚠️ 请输入序号', 'warn'); return; }
            if (STATE.running) return;

            const indices = parseRange(rangeText, STATE.queue.length);
            if (indices.length === 0) { log('⚠️ 未解析到有效序号', 'warn'); return; }

            const rangeQueue = indices.map(idx => STATE.queue[idx]);
            log(`🎯 开始上传 ${rangeQueue.length} 个指定文件 (序号: ${rangeText})`, 'info');
            persistLog(`按序号上传: ${rangeText} → ${rangeQueue.length} 个文件`, 'info');

            // 清除这些文件的上传记录
            for (const item of rangeQueue) { removeUploaded(item.name); }
            updateStats(); updateQueueList();

            STATE.running = true;
            STATE.paused = false;
            updateButtons();

            for (let i = 0; i < rangeQueue.length; i++) {
                while (STATE.paused && STATE.running) { await sleep(1000); }
                if (!STATE.running) break;

                const item = rangeQueue[i];
                log(`🎯 [${i+1}/${rangeQueue.length}] 序号 ${indices[i]+1}: ${item.name}`, 'info');
                await uploadOneFile(item);

                if (i < rangeQueue.length - 1 && STATE.running) {
                    const config = getConfig();
                    const baseInterval = config.intervalMinutes * 60 * 1000;
                    const jitter = (Math.random() - 0.5) * 60000;
                    const actualWait = Math.max(30000, baseInterval + jitter);
                    log(`⏰ 等待 ${Math.round(actualWait/1000)} 秒...`, 'info');
                    const waitStart = Date.now();
                    while (Date.now() - waitStart < actualWait) {
                        while (STATE.paused && STATE.running) { await sleep(1000); }
                        if (!STATE.running) break;
                        await sleep(1000);
                    }
                }
            }

            STATE.running = false; STATE.paused = false;
            updateButtons(); updateStats(); updateQueueList();
            log('✅ 指定文件上传完成', 'success');
            persistLog('指定文件上传完成', 'success');
        });

        ui.btnMinimize.addEventListener('click', toggleMinimize);
    }

    function bindDropEvents() {
        let dragCounter = 0;
        document.addEventListener('dragenter', (e) => {
            e.preventDefault(); dragCounter++;
            if (hasPdfInDrag(e.dataTransfer)) STATE.ui.dropOverlay.classList.add('active');
        });
        document.addEventListener('dragleave', (e) => {
            dragCounter--;
            if (dragCounter === 0) STATE.ui.dropOverlay.classList.remove('active');
        });
        document.addEventListener('dragover', (e) => { e.preventDefault(); });
        document.addEventListener('drop', async (e) => {
            e.preventDefault(); dragCounter = 0;
            STATE.ui.dropOverlay.classList.remove('active');
            if (!e.dataTransfer || !e.dataTransfer.items) return;
            const files = await handleDropEntries([...e.dataTransfer.items]);
            if (files.length > 0) {
                addToQueueFromDrop(files);
                STATE.ui.btnStart.disabled = STATE.queue.length === 0;
            }
        });
    }

    function hasPdfInDrag(dt) {
        if (!dt || !dt.types) return false;
        return dt.types.includes('Files');
    }

    let dragState = null;
    function onPanelDragStart(e) {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
        if (!e.target.closest('#db-header-drag')) return;
        dragState = { startX: e.clientX, startY: e.clientY, startLeft: STATE.ui.panel.offsetLeft, startTop: STATE.ui.panel.offsetTop };
        document.addEventListener('mousemove', onPanelDragMove);
        document.addEventListener('mouseup', onPanelDragEnd);
    }
    function onPanelDragMove(e) {
        if (!dragState) return;
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        STATE.ui.panel.style.right = 'auto';
        STATE.ui.panel.style.top = Math.max(0, dragState.startTop + dy) + 'px';
        STATE.ui.panel.style.left = Math.max(0, dragState.startLeft + dx) + 'px';
    }
    function onPanelDragEnd() {
        dragState = null;
        document.removeEventListener('mousemove', onPanelDragMove);
        document.removeEventListener('mouseup', onPanelDragEnd);
    }

    function updateScheduleStatus(config) {
        const cfg = config || getConfig();
        if (!STATE.ui.scheduleStatus) return;
        if (!cfg.scheduleStart || !cfg.scheduleEnd) {
            STATE.ui.scheduleStatus.textContent = '(未设置)';
            STATE.ui.scheduleStatus.style.color = '#aaa';
            return;
        }
        if (isWithinSchedule(cfg)) {
            STATE.ui.scheduleStatus.textContent = '✅ 窗口内';
            STATE.ui.scheduleStatus.style.color = '#4ade80';
        } else {
            const next = getNextScheduleStart(cfg);
            STATE.ui.scheduleStatus.textContent = '⏸ 等待 ' + formatTimeRemaining(next ? next - new Date() : 0);
            STATE.ui.scheduleStatus.style.color = '#f59e0b';
        }
    }

    function updateFolderDisplay() {
        const config = getConfig();
        const display = STATE.ui.folderDisplay;
        if (config.folderDisplayName) {
            display.textContent = '📂 ' + config.folderDisplayName;
            display.classList.add('active');
        } else {
            display.textContent = '未选择（也支持拖拽）';
            display.classList.remove('active');
        }
    }

    function updateStats() {
        const total = STATE.queue.length;
        const uploaded = getUploadedSet();
        const records = getUploadRecords();
        let done = 0, invalid = 0;
        for (const item of STATE.queue) {
            if (uploaded.has(item.name)) {
                const rec = records.find(r => r.name === item.name);
                if (rec && (rec.status === 'invalid' || rec.status === 'no_response')) invalid++;
                else done++;
            }
        }
        STATE.totalUploaded = uploaded.size;

        STATE.ui.queueCount.textContent = total;
        STATE.ui.uploadedCount.textContent = done;
        STATE.ui.invalidCount.textContent = invalid;
        STATE.ui.currentFile.textContent = STATE.currentIndex >= 0 && STATE.currentIndex < total
            ? STATE.queue[STATE.currentIndex].name : '-';
        STATE.ui.progressFill.style.width = total > 0 ? (done / total * 100) + '%' : '0%';
        updateRetryFailedButton();
    }

    function updateQueueList() {
        const list = STATE.ui.queueList;
        const uploaded = getUploadedSet();
        const records = getUploadRecords();
        if (STATE.queue.length === 0) {
            list.innerHTML = '<div style="color:#6a6a8a;font-size:11px;">暂无文件，选择文件夹或拖拽PDF以添加</div>';
            return;
        }
        const show = STATE.queue.slice(0, 80);
        list.innerHTML = show.map((item, i) => {
            let cls = '';
            let dot = '○';
            const isUploaded = uploaded.has(item.name);
            const rec = records.find(r => r.name === item.name);
            if (isUploaded) {
                if (rec && (rec.status === 'invalid' || rec.status === 'no_response')) {
                    cls = 'invalid'; dot = '✗';
                } else {
                    cls = 'done'; dot = '●';
                }
            }
            if (i === STATE.currentIndex && STATE.running) { cls = 'current'; dot = '▶'; }
            if (selectedFiles.has(item.name)) { cls = 'selected'; dot = '📌'; }
            const num = i + 1;
            return `<div class="db-queue-item ${cls}" data-idx="${i}">
                <span class="db-queue-dot">${dot}</span>
                <span style="color:#6a6a8a;min-width:28px;font-size:10px;">${num}.</span>
                <span>${escapeHtml(item.name)}</span>
            </div>`;
        }).join('');
        if (STATE.queue.length > 80) {
            list.innerHTML += `<div style="color:#6a6a8a;font-size:11px;padding:3px 6px;">...还有 ${STATE.queue.length - 80} 个文件</div>`;
        }

        // 点击选择/取消选择
        list.querySelectorAll('.db-queue-item').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.idx);
                const itemName = STATE.queue[idx].name;
                if (selectedFiles.has(itemName)) {
                    selectedFiles.delete(itemName);
                } else {
                    selectedFiles.add(itemName);
                }
                updateQueueList();
                STATE.ui.btnUploadSelected.disabled = selectedFiles.size === 0;
                STATE.ui.btnUploadSelected.textContent = selectedFiles.size > 0
                    ? `📌 上传选中(${selectedFiles.size})`
                    : '📌 上传选中';
            });
        });

        STATE.ui.btnUploadSelected.disabled = selectedFiles.size === 0;
        STATE.ui.btnUploadSelected.textContent = selectedFiles.size > 0
            ? `📌 上传选中(${selectedFiles.size})`
            : '📌 上传选中';
    }

    function updateButtons() {
        const ui = STATE.ui;
        if (STATE.running) {
            ui.btnStart.disabled = true;
            ui.btnPause.disabled = false;
            ui.btnStop.disabled = false;
            ui.btnPause.textContent = STATE.paused ? '▶ 继续' : '⏸ 暂停';
        } else {
            ui.btnStart.disabled = STATE.queue.length === 0;
            ui.btnPause.disabled = true;
            ui.btnStop.disabled = true;
            ui.btnPause.textContent = '⏸ 暂停';
        }
    }

    function toggleMinimize() {
        STATE.ui.panel.classList.toggle('db-collapsed');
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ==================== SSE fetch 拦截器 ====================
    function setupSSEInterceptor() {
        const origFetch = window.fetch;
        window.fetch = async function(input, init) {
            const response = await origFetch.call(window, input, init);
            const url = (typeof input === 'string') ? input : (input?.url || '');
            if (!url || !url.includes('chat/completion')) return response;
            const ct = (response.headers && response.headers.get) ? (response.headers.get('content-type') || '') : '';
            if (!ct.includes('text/event-stream')) return response;

            STATE.sseText = '';
            STATE.sseDone = false;
            STATE.sseActive = true;
            log('🔌 SSE 拦截: chat/completion 流已捕获', 'info');

            try {
                const [reactStream, ourStream] = response.body.tee();
                (async () => {
                    const reader = ourStream.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let text = '';
                    try {
                        while (true) {
                            const {done, value} = await reader.read();
                            if (done) break;
                            const chunk = decoder.decode(value, {stream: true});
                            buffer += chunk;
                            const parts = buffer.split('\n\n');
                            buffer = parts.pop();
                            for (const part of parts) {
                                let eventType = '';
                                let dataStr = '';
                                const lines = part.split('\n');
                                for (const line of lines) {
                                    if (line.startsWith('event:')) eventType = line.substring(6).trim();
                                    else if (line.startsWith('data:')) dataStr = line.substring(5).trim();
                                }
                                if (!dataStr || dataStr === '{}') continue;
                                try {
                                    const data = JSON.parse(dataStr);
                                    if (eventType === 'SSE_REPLY_END' && data.end_type === 1) {
                                        if (!text && data.msg_finish_attr?.brief) {
                                            text = data.msg_finish_attr.brief;
                                        }
                                        STATE.sseText = text;
                                        STATE.sseDone = true;
                                        STATE.sseActive = false;
                                        log(`🔌 SSE 完成: ${text.length} 字符`, 'success');
                                    }
                                    if (eventType === 'STREAM_CHUNK' && data.patch_op) {
                                        for (const op of data.patch_op) {
                                            if (op.patch_object === 1 && op.patch_value?.content_block) {
                                                for (const block of op.patch_value.content_block) {
                                                    if (block.block_type === 10000) {
                                                        text += block.content?.text_block?.text || '';
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    if (eventType === 'CHUNK_DELTA' && data.text) {
                                        text += data.text;
                                    }
                                } catch(e) {}
                            }
                        }
                    } catch(e) {
                        log(`🔌 SSE 流读取失败: ${e.message}`, 'warn');
                        STATE.sseActive = false;
                    }
                })();

                return new Response(reactStream, {
                    headers: response.headers,
                    status: response.status,
                    statusText: response.statusText
                });
            } catch(e) {
                log(`🔌 SSE tee 失败: ${e.message}，回退 DOM 轮询`, 'warn');
                STATE.sseActive = false;
                return response;
            }
        };
        log('🔌 SSE fetch 拦截器已就绪', 'info');
    }

    // ==================== 初始化 ====================
    async function init() {
        loadPersistedLog();

        log('🚀 豆包 PDF 批量上传器 v4.5.0 已启动', 'info');

        createPanel();

        const config = getConfig();
        let configChanged = false;
        if (config.autoPrompt === undefined) { config.autoPrompt = true; configChanged = true; }
        if (config.autoSave === undefined) { config.autoSave = true; configChanged = true; }
        if (config.minWaitSeconds === undefined) { config.minWaitSeconds = DEFAULT_MIN_WAIT_SECONDS; configChanged = true; }
        if (config.stableThreshold === undefined) { config.stableThreshold = DEFAULT_STABLE_THRESHOLD; configChanged = true; }
        if (config.cooldownMinutes === undefined) { config.cooldownMinutes = DEFAULT_COOLDOWN_MINUTES; configChanged = true; }
        if (config.wakeupPrompt === undefined) { config.wakeupPrompt = DEFAULT_WAKEUP_PROMPT; configChanged = true; }
        if (config.uploadWaitSeconds === undefined) { config.uploadWaitSeconds = DEFAULT_UPLOAD_WAIT_SECONDS; configChanged = true; }
        if (config.promptDoneWaitSeconds === undefined) { config.promptDoneWaitSeconds = DEFAULT_PROMPT_DONE_WAIT_SECONDS; configChanged = true; }
        if (config.presendWaitSeconds === undefined) { config.presendWaitSeconds = DEFAULT_PRESEND_WAIT_SECONDS; configChanged = true; }
        if (!config.promptText) { config.promptText = DEFAULT_PROMPT; configChanged = true; }
        if (configChanged) { saveConfig(); log('🔧 配置已更新，补全新字段', 'info'); }

        STATE.ui.inputInterval.value = config.intervalMinutes;
        STATE.ui.inputMinWait.value = config.minWaitSeconds || DEFAULT_MIN_WAIT_SECONDS;
        STATE.ui.inputStable.value = config.stableThreshold || DEFAULT_STABLE_THRESHOLD;
        STATE.ui.inputCooldown.value = config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES;
        STATE.ui.inputUploadWait.value = config.uploadWaitSeconds || DEFAULT_UPLOAD_WAIT_SECONDS;
        STATE.ui.inputPromptDoneWait.value = config.promptDoneWaitSeconds || DEFAULT_PROMPT_DONE_WAIT_SECONDS;
        STATE.ui.inputPresendWait.value = config.presendWaitSeconds || DEFAULT_PRESEND_WAIT_SECONDS;
        STATE.ui.inputScheduleStart.value = config.scheduleStart || '';
        STATE.ui.inputScheduleEnd.value = config.scheduleEnd || '';
        updateScheduleStatus(config);
        STATE.ui.inputWakeup.value = config.wakeupPrompt || DEFAULT_WAKEUP_PROMPT;
        STATE.ui.checkboxAutoPrompt.checked = config.autoPrompt !== false;
        STATE.ui.checkboxAutoSave.checked = config.autoSave !== false;

        // Prompt 标签页初始化
        const activePromptTab = config.activePromptTab || 0;
        STATE.ui.textareaPrompt.value = PROMPT_POOL[activePromptTab];
        const promptTabEls = STATE.ui.promptTabs.querySelectorAll('.db-prompt-tab');
        promptTabEls.forEach(t => t.classList.toggle('active', parseInt(t.dataset.tab) === activePromptTab));

        // 自动轮换开关初始化
        const autoRotate = config.autoRotateEnabled !== undefined ? config.autoRotateEnabled : true;
        STATE.ui.checkboxAutoRotate.checked = autoRotate;
        updateRotateIndex();

        // 豆包默认按钮初始化
        STATE.ui.checkboxDefaultBtn.checked = config.useDoubaoDefaultButton === true;

        updateFolderDisplay();

        STATE.lastSavedHash = '';
        STATE.processedHashes = [];
        STATE.baselineFingerprints = new Set();
        STATE.prompt_index = gmGet('prompt_index', 0);
        log(`🔄 Prompt 轮换恢复: 下一个使用变体 #${STATE.prompt_index}`, 'info');

        setupSSEInterceptor();

        // 恢复持久化日志到面板
        if (STATE.logBuffer.length > 0) {
            const recent = STATE.logBuffer.slice(-50);
            for (const e of recent) {
                const t = new Date(e.time).toTimeString().slice(0, 8);
                const d = new Date(e.time).toISOString().slice(0, 10);
                const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
                const icon = icons[e.level] || 'ℹ️';
                const entry = document.createElement('div');
                entry.className = `db-log-entry db-log-${e.level}`;
                entry.textContent = `[${d} ${t}] ${icon} ${e.msg}`;
                STATE.ui.logContainer.appendChild(entry);
            }
            STATE.ui.logContainer.scrollTop = STATE.ui.logContainer.scrollHeight;
            log(`📖 已恢复 ${STATE.logBuffer.length} 条历史日志`, 'info');
        }

        const handle = await loadDirHandle();
        if (handle) {
            STATE.dirHandle = handle;
            STATE.config.folderDisplayName = handle.name;
            STATE.ui.folderDisplay.textContent = '📂 ' + handle.name;
            STATE.ui.folderDisplay.classList.add('active');
            STATE.ui.btnRefresh.disabled = false;
            saveConfig();
            log('📂 已恢复文件夹: ' + handle.name + '（断点续传就绪）', 'success');
            await buildQueueFromDir();
            STATE.ui.btnStart.disabled = STATE.queue.length === 0;
        } else {
            log('📌 请选择PDF文件夹或拖拽PDF到页面', 'info');
        }

        const uploaded = getUploadedSet();
        STATE.totalUploaded = uploaded.size;
        updateStats();
        updateQueueList();
        updateButtons();

        if (uploaded.size > 0) {
            log(`📊 发现 ${uploaded.size} 条历史上传记录（断点续传就绪）`, 'info');
        }

        // v4.5.0: 断点自动恢复 — 上次运行被页面跳转/刷新中断时自动续传
        window.addEventListener('beforeunload', () => {
            if (STATE.running) setResumeState('页面卸载');
        });
        const resume = getResumeState();
        if (resume) {
            clearResumeState();
            if (STATE.queue.length > 0) {
                const remaining = STATE.queue.filter(it => !getUploadedSet().has(it.name)).length;
                if (remaining > 0) {
                    log(`🔁 检测到运行中断（${resume.reason || '页面刷新'}），8 秒后自动恢复上传（剩余 ${remaining} 个）。不需要恢复请点 ⏹ 停止`, 'warn');
                    persistLog(`自动恢复: ${resume.reason || '页面刷新'}，剩余 ${remaining} 个`, 'warn');
                    STATE.ui.btnStop.disabled = false;
                    setTimeout(() => {
                        if (!STATE.running && STATE.queue.length > 0) runUploadLoop();
                    }, 8000);
                } else {
                    log('🔁 检测到中断标记，但队列已全部完成，无需恢复', 'info');
                }
            } else {
                log('⚠️ 检测到运行中断，但队列为空（文件夹权限可能失效），请重新选择文件夹后点 ▶ 开始', 'warn');
            }
        }

        log('✅ 初始化完成，等待操作', 'info');
        updateRetryFailedButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
