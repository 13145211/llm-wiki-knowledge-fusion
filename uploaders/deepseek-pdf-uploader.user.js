// ==UserScript==
// @name         DeepSeek PDF 批量上传器
// @namespace    https://github.com/qclaw/deepseek-pdf-uploader
// @version      1.1.0
// @description  DeepSeek 网页版 PDF 批量上传 + 断点自动恢复 + Prompt 轮换 + 自动保存 + 时间窗口
// @author       QClaw (adapted from Doubao version)
// @match        https://chat.deepseek.com/*
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
    const DEFAULT_STABLE_THRESHOLD = 12;        // 稳定判定（次）：回答文本连续 N 次（每次 2 秒）无变化视为完毕（DeepSeek 生成较慢，稍放宽）
    const DEFAULT_COOLDOWN_MINUTES = 120;       // 冷却时间（分钟）：检测到无效回答后暂停这么久再继续
    const DEFAULT_WAKEUP_PROMPT = '你好，请帮我总结一下今天天气怎么样？';  // 唤醒问题：冷却结束后先发一句日常对话
    const DEFAULT_UPLOAD_WAIT_SECONDS = 8;      // 上传后等待（秒）：DeepSeek 解析 PDF 较慢，默认比其他平台长
    const DEFAULT_PROMPT_DONE_WAIT_SECONDS = 2; // Prompt 后等待（秒）：Prompt 输入完成到点击发送的间隔
    const DEFAULT_PRESEND_WAIT_SECONDS = 3;     // 发送前等待（秒）：点击发送前的最后缓冲
    // 注：精读笔记保存为浏览器下载（默认下载目录），文件名 = 原PDF名_文献标题.md

    // ==================== 内部常量（一般无需修改） ====================
    const STORE_PREFIX = 'dsup_';               // 油猴存储键前缀
    const DB_NAME = 'DeepSeekPdfUploader';      // IndexedDB 库名（记忆所选文件夹）
    const DB_VERSION = 1;
    const FILE_INPUT_WAIT_TIMEOUT = 15000;      // 查找上传入口的超时（毫秒）
    const PANEL_ID = 'ds-uploader-panel';       // 控制面板元素 ID
    const DROP_OVERLAY_ID = 'ds-drop-overlay';  // 拖拽遮罩元素 ID

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
        consecutiveFailures: 0,
        logBuffer: [],
        logLoaded: false,
        sseText: '',
        sseDone: false,
        sseActive: false,
        lastSavedHash: '',
        processedHashes: [],
        baselineFingerprints: new Set(),
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

    // ==================== Prompt 轮换池（5个变体） ====================
    // ==================== Prompt 轮换池（通用文献七段法，5 个角色变体） ====================
    // 结构相同、措辞不同；每篇轮换使用以降低同质化。可在面板中编辑并保存。
    const PROMPT_POOL = [
        // Prompt #0 — 博士后研究员（通用文献七段法）
        `你是 学术文献精读方向的博士后研究员。
你的任务是精读一篇学术文献，撰写 7 段结构化笔记。

你必须完全忠实地报告**文献原文和图表中的信息**——不能编造任何数字、结论或引用。
当文本和图像信息冲突时，以图像为准并注明矛盾。
如果需要推断，必须标注"合理推断"或"作者未述"。

## 1. 基本信息
<标题/作者/机构/期刊/年份/DOI/通讯/关键词>

## 2. 研究背景与问题
<含(1)具体科学挑战 (2)已有方案不足 (3)本文目标>

## 3. 方法/技术路线
<研究对象与材料 + 实验/计算/调查设计(条件、参数、样本量) + 分析与表征手段 + 评价指标与测试条件>

## 4. 核心结果
<含具体数字 + 图表引用 + 图像解读。每项结果必须注明依据来源>

## 5. 创新点
<基于作者 abstract + conclusions 改写，用"作者报告/作者通过"+ 标"依据"。
不得使用原文未出现的"首次/新发现/新路径"等绝对化措辞。>

## 6. 局限与展望
<作者自陈 + 合理推断(标"合理推断"或"作者未述")>

## 7. 原始文本摘要
<≤300 字，覆盖核心发现>

当遇到以下类型图表时，必须从图像中读取具体值：

【谱图/衍射图/色谱类】
- 读出特征峰的位置、强度与归属标注
- 由峰参数计算的衍生量是否与文本一致？不一致则标注
- 注意是否有未解释的额外峰

【显微/影像类照片】
- 目测估算特征尺寸范围，与文本声称值对比
- 注意形貌与分布均匀性
- 高分辨图像：读出标注的特征间距/尺度，与文本对比

【性能/趋势曲线】
- 直接读取关键数据点，验证文本中数字是否正确
- 观察趋势拐点与异常点
- 时间序列：检测衰减/漂移趋势

【统计类图表】
- 读取均值、误差棒、显著性标注
- 各组差异是否支持文本中的定性判断？

【拟合/回归图】
- 读出拟合参数(斜率、截距、R² 等)
- 验证文本中给出的参数值
- 检查离群点

【Table 数据】
- 扫描所有表格数据，验证文中引用的数字与表一致
- 检查脚注

完成 7 段后，执行以下自检：
1. 数字反查：所有具体数字必须在原文或图表中找到对应值
2. 创新点 clean check：不得出现绝对化措辞除非作者原文中出现
3. 图表引用完整性：每个 Fig/Table/Scheme 必须可见且 caption 一致
4. 引号原话：所有双引号中的英文句子必须在原文中出现
5. 零占位符：不得出现 TODO/TBD 等占位文本`,

        // Prompt #1 — 资深研究员
        `你是 一位拥有 15 年跨学科经验的资深研究员（Senior Researcher）。
请仔细阅读以下学术文献，完成一份 7 模块的结构化分析报告。

核心准则：
- 严格基于原文和图表，不做任何数值或结论的臆造
- 图像信息优先于文本描述（遇到矛盾请明确指出）
- 任何超出原文的推论必须标注"推测"或"文中未提及"

## Module A — 文献概览
<含完整引用信息：标题/作者/机构/期刊/年份/DOI/通讯联系人/研究关键词>

## Module B — 科学问题定位
<概述：(1)领域核心挑战 (2)现有策略的瓶颈 (3)本文的解决思路>

## Module C — 研究方案
<对象与材料 + 实验/计算/调查设计细节 + 分析与表征面板 + 评价条件>

## Module D — 关键发现与数据
<逐条列出主要发现，每条附带具体数值、对应图表编号、图像读出值。标注信息来源>

## Module E — 贡献分析
<从作者视角总结创新之处，使用"作者发现/作者证明"表述。严禁使用原文未出现的"首次/首次提出"等>

## Module F — 不足与未来方向
<作者自述的局限性 + 你的专业推测(标注"推测"或"文中未涉")>

## Module G — 原文精要
<用 ≤300 字概括核心结论，保留关键数据点>

图表深度读取指引：
【谱图类】记录特征峰位置与归属，衍生参数 vs 文本值，检查异常峰
【显微/影像类】目估特征尺寸及分布均匀性，测量标注尺度并与文本对比
【性能曲线】直接取关键数据点，核对文中数字，评估趋势与稳定性
【统计图表】核读均值/误差/显著性，判断是否支持文本定性结论
【拟合/回归图】提取拟合参数验证记载，检查异常离群数据点
【表格】逐行扫描，核对文中所有引用数字，记录脚注条件

完成后逐项核查：数值溯源 / 措辞合规 / 图表全覆盖 / 引号精确匹配 / 无占位符`,

        // Prompt #2 — 博士研究生
        `你是 一名博士研究生，正在系统整理所在领域的文献笔记。
你的导师要求你为每篇文献生成一份标准化的 7 节精读报告。

📋 报告要求：
- 忠于原文，数据必须可追溯到原文或图表
- 图文不符时取图像并注明差异
- 不确定的地方写"待确认"或"作者未说明"

---

**第1节 · 文献卡片**
标题 | 作者 | 单位 | 期刊(年,卷,页) | DOI | 通讯作者 | 关键词

**第2节 · 研究动机**
- 核心科学挑战是什么？
- 目前方法差在哪里？
- 这篇工作想达到什么目标？

**第3节 · 怎么做**
- 研究对象与材料：列出关键条件与参数
- 分析/表征手段：逐项列出
- 评价方式：测试条件、指标、样本量

**第4节 · 看到了什么**
- 用 bullet 列出所有结果，每项附 Fig/Table 编号
- 从图中直接读取的数据单独标注"[读图值]"
- 与文本声称值并列对比

**第5节 · 新在哪里**
- 从 Abstract + Conclusions 概括，表述为"本文报道/本文证明"
- ⚠️ 不自创"首次/前所未有"等判断

**第6节 · 还差什么**
- 作者自己承认的不足
- 你觉得还能做什么（标注"个人看法"）

**第7节 · 一页纸总结**
≤300 字，浓缩最核心的发现和数字

---

🔬 图表专项分析：
▪ 谱图类：记录特征峰位置与归属，衍生参数一致性检查
▪ 显微/影像：目测特征尺寸，评估分布，高分辨图量取标注尺度
▪ 性能曲线：从曲线上取点，与正文数值比较
▪ 统计图表：读均值/误差棒/显著性，检查与结论自洽
▪ 拟合/回归：读拟合参数，核对声明值
▪ 表格数据：全量扫描，与文中数字交叉验证

✅ 自检清单：
(1)所有数字有据可查 (2)无绝对化措辞 (3)所有 Fig/Table 已覆盖
(4)双引号句子可原文定位 (5)无 TODO/待补充 占位`,

        // Prompt #3 — 期刊审稿人（英文指令，中文输出）
        `Act as a peer reviewer for an academic journal. You are evaluating a manuscript and need to produce a
structured 7-section reading digest. Write the digest in Chinese.

Guidelines:
- Faithful to the manuscript — fabricate nothing
- When figures contradict text, trust the figures and flag the discrepancy
- Mark any inference beyond the paper as "[reviewer's inference]" or "[not stated by authors]"

### Section I — Manuscript Identity
Title / Authors / Affiliations / Journal.Year.Volume.Pages / DOI / Corresponding author / Keywords

### Section II — Problem Statement
- What is the specific scientific challenge?
- Why are existing approaches insufficient?
- What does this work aim to achieve?

### Section III — Methodology
- Study objects and materials (key conditions and parameters)
- Analysis / characterization panel
- Evaluation conditions and metrics

### Section IV — Principal Findings
- List each major result with exact values, figure/table references
- Include values directly read from figures (tag as "[read from figure]")
- Compare with text-claimed values; flag discrepancies

### Section V — Significance & Novelty
- Summarize from Abstract & Conclusions
- Use phrasing like "The authors report/demonstrate..."
- Avoid superlatives ("first", "unprecedented") unless verbatim from the original

### Section VI — Limitations & Outlook
- Author-acknowledged limitations
- Your assessment of further work needed (tag "[reviewer's note]")

### Section VII — Condensed Summary
≤300 words, covering core findings with key numbers

---

Figure-by-Figure Analysis Protocol:
▪ Spectra/diffraction/chromatograms: peak positions, assignments, derived quantities vs text
▪ Microscopy/imaging: visual size estimates, distribution, labeled scale features vs text
▪ Performance/trend curves: read key data points directly, verify claimed values, detect drift
▪ Statistical plots: means, error bars, significance marks → consistency with conclusions
▪ Fits/regressions: extract fitted parameters, cross-check with stated values, note outliers
▪ Tables: full scan, cross-reference every cited number, check footnotes

Post-completion Audit:
(1) Every number traceable to source (2) No unqualified superlatives
(3) All Figures/Tables covered (4) Quoted text verifiable
(5) No placeholder text (TODO/TBD)`,

        // Prompt #4 — 行业研发工程师
        `你是 某企业研发中心的主任工程师，正在评估一篇学术文献的技术价值。
请以工程研发视角，撰写一份 7 段技术评估笔记。

⚠️ 铁律：
- 所有数据必须来自文献原文或图表，绝不编造
- 图像数据优先于文字声明（发现矛盾必须记录）
- 任何工程判断/外推需标注"[工程估计]"或"[文献未给]"

▎1. 文献档案
标题 · 作者 · 机构 · 期刊/年/卷/页 · DOI · 通讯 · 技术关键词

▎2. 技术需求分析
(1) 要解决什么实际问题？
(2) 现有技术方案为什么不够？
(3) 这套方案的技术逻辑是什么？

▎3. 技术路线
- 对象与材料：关键条件、参数、投入
- 分析/表征矩阵：逐项列出
- 测试工况：条件窗口、指标、规模

▎4. 实测数据分析
逐条列出结果，格式：
  [数据] ×××（来源：Fig.X / Table Y）
  [读图] ×××（从图中直接量取）
  [对比] 文中声称值 vs 读图值是否一致？

▎5. 技术亮点
从 Abstract + Conclusions 提炼，句型："作者实现了/作者获得了"
禁止使用"首次/突破性/革命性"等营销语言

▎6. 工程可行性评估
- 作者认识到的局限（逐条列出）
- 落地前景判断（标注"[工程估计]"）
- 需要补充的数据（标注"[文献未给]"）

▎7. 结论速览
≤300 字，包含所有关键性能指标的具体数值

---

📊 图表定量解读清单：
● 谱图类：特征峰位置 → 归属 → 衍生参数核算 → 异常检查
● 显微/影像：目测特征尺寸 → 均匀性 → 标注尺度实测 vs 文本
● 性能曲线：逐点取值 → 对比申报值 → 稳定期趋势
● 统计图表：均值/误差/显著性 → 支撑结论？
● 拟合/回归：提取参数 → 与文中给定值对比 → 辨别异常点
● 表格：全表扫描 → 每个数字与正文交叉核对 → 记录注脚条件

📋 完成后自检：(1)数字可溯源 (2)无浮夸用词 (3)图表全覆盖 (4)引号可定位 (5)无占位符`
    ];

    const DEFAULT_PROMPT = PROMPT_POOL[0];
    const PROMPT_POOL_ORIG = PROMPT_POOL.map(p => p);

    function getOriginalPrompt(idx) {
        return PROMPT_POOL_ORIG[idx] || PROMPT_POOL[idx];
    }

    // ==================== Prompt 轮换逻辑 ====================
    function getRotatedPrompt() {
        const config = getConfig();
        if (!config.autoRotateEnabled) {
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
            useDeepSeekDeepThink: false,   // 是否开启深度思考模式
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
        gmSet('uploadRecords', records.filter(r => r.name !== filename));
        STATE.totalUploaded = s.size;
    }

    function getUploadRecords() {
        return gmGet('uploadRecords', []);
    }

    // ==================== 断点自动恢复（v1.1.0） ====================
    // 根因：startNewChat() 兜底用 Logo 点击 / window.location.href 跳转，整页刷新
    // 会杀死脚本运行环境，导致批量任务中断、只能手动重新开始。
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
        const reportLines = [
            '===== DeepSeek PDF 批量上传进度报告 =====',
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
        a.download = `deepseek-upload-log-${new Date().toISOString().slice(0, 10)}.txt`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function parseLogAndRestore(logText) {
        const lines = logText.split('\n');
        let restored = 0;
        const records = [];

        for (const line of lines) {
            const m = line.match(/^(✅ 完成|⚠️ 无效回答|❌ 无回答)\s+(.+?)(?:\s+\((.+)\))?$/);
            if (m) {
                const status = m[1] === '✅ 完成' ? 'success' : (m[1] === '⚠️ 无效回答' ? 'invalid' : 'no_response');
                const name = m[2].trim();
                const ts = m[3] ? new Date(m[3]).toISOString() : new Date().toISOString();
                records.push({ name, status, timestamp: ts, attempts: 1 });
                restored++;
            }
        }

        if (records.length === 0) {
            log('⚠️ 日志文件中未找到有效记录', 'warn');
            return { restored: 0, success: 0, invalid: 0, noResponse: 0 };
        }

        const existing = gmGet('uploadRecords', []);
        for (const rec of records) {
            const idx = existing.findIndex(r => r.name === rec.name);
            if (idx >= 0) existing[idx] = rec;
            else existing.push(rec);
        }
        gmSet('uploadRecords', existing);

        const uploaded = new Set(gmGet('uploaded', []));
        for (const rec of records) uploaded.add(rec.name);
        gmSet('uploaded', [...uploaded]);
        STATE.totalUploaded = uploaded.size;

        persistLog(`从日志文件恢复 ${restored} 条记录`, 'info');
        let success = 0, invalid = 0, noResponse = 0;
        for (const rec of records) {
            if (rec.status === 'success') success++;
            else if (rec.status === 'invalid') invalid++;
            else noResponse++;
        }
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

    // ==================== 解析序号范围 ====================
    function parseRange(str, maxLen) {
        const result = [];
        const parts = str.split(',');
        for (const part of parts) {
            const trimmed = part.trim();
            const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
            if (rangeMatch) {
                let start = parseInt(rangeMatch[1]);
                let end = parseInt(rangeMatch[2]);
                if (start > end) [start, end] = [end, start];
                for (let n = start; n <= end; n++) {
                    if (n >= 1 && n <= maxLen) result.push(n - 1);
                }
            } else {
                const num = parseInt(trimmed);
                if (!isNaN(num) && num >= 1 && num <= maxLen) result.push(num - 1);
            }
        }
        return [...new Set(result)];
    }

    // ==================== IndexedDB ====================
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

    // ==================== 通用 DOM 工具 ====================
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function randomDelay(minMs, maxMs) {
        return sleep(minMs + Math.random() * (maxMs - minMs));
    }

    function isInsideOurPanel(el) {
        if (!el) return false;
        return !!(el.closest && (el.closest('#' + PANEL_ID) || el.closest('#' + DROP_OVERLAY_ID)));
    }

    // ==================== DeepSeek DOM 选择器 ====================
    /**
     * DeepSeek 网页版 DOM 结构（基于已知信息 + 自适应探测）：
     * - 消息列表容器: .ds-virtual-list-visible-items
     * - AI 消息: ._4f9bf79 (可能变化，使用 class 前缀匹配)
     * - AI 回答 markdown: .ds-markdown
     * - 思考链: .ds-think-content
     * - 输入区: textarea 或 [contenteditable]
     * - 发送按钮: 需自适应探测
     * - 上传按钮: 需自适应探测
     *
     * 注意: DeepSeek 使用 CSS Modules，class 名可能随版本更新变化。
     * 脚本会使用多种策略自适应探测正确的元素。
     */

    // ---- 文件输入查找 ----
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

    // ---- 上传/附件按钮探测 ----
    const UPLOAD_BUTTON_SELECTORS = [
        // DeepSeek 特有选择器（推测 + 常见模式）
        'button[aria-label*="upload" i]',
        'button[aria-label*="上传" i]',
        'button[aria-label*="attach" i]',
        'button[aria-label*="附件" i]',
        'button[aria-label*="file" i]',
        'button[aria-label*="文件" i]',
        // 常见 class 模式
        '[class*="upload-btn" i]',
        '[class*="UploadBtn" i]',
        '[class*="attach-btn" i]',
        '[class*="AttachBtn" i]',
        '[class*="file-upload" i]',
        '[class*="FileUpload" i]',
        // DeepSeek icons
        '.ds-icon-button[class*="upload" i]',
        'button[class*="ds-" i] svg path[d*="clip" i]',       // paperclip icon
        'button:has(svg)',
    ];

    function findUploadButton() {
        // 策略1: 精确选择器
        for (const sel of UPLOAD_BUTTON_SELECTORS) {
            try {
                const btns = document.querySelectorAll(sel);
                for (const btn of btns) {
                    if (btn.offsetParent === null) continue;
                    if (isInsideOurPanel(btn)) continue;
                    if (isDangerousButton(btn)) continue;
                    // 验证: 点击后是否出现 file input
                    return btn;
                }
            } catch(e) { /* selector not supported */ }
        }

        // 策略2: 查找所有底部工具栏按钮，找带 paperclip/upload 图标的
        const chatArea = findChatInputArea();
        if (chatArea) {
            const buttons = chatArea.querySelectorAll('button');
            for (const btn of buttons) {
                if (btn.offsetParent === null) continue;
                if (isInsideOurPanel(btn)) continue;
                if (isDangerousButton(btn)) continue;
                const svg = btn.querySelector('svg');
                if (!svg) continue;
                // 检查 SVG 内容是否像 upload/attach 图标
                const svgHTML = svg.outerHTML.toLowerCase();
                if (svgHTML.includes('path') && (svgHTML.includes('clip') || svgHTML.includes('attach') || svgHTML.includes('upload'))) {
                    return btn;
                }
            }
        }

        // 策略3: 查找所有可见按钮中最可能是上传的那个
        //（通常在输入区附近，不包含发送/搜索等文字）
        return null;
    }

    function isDangerousButton(el) {
        const text = (el.textContent || '').toLowerCase();
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        const combined = text + ' ' + label;
        const blocked = [
            '朗读', 'read aloud', '语音', 'voice', 'speech',
            '播放', 'play', 'audio', '音量', 'volume',
            '截图', 'screenshot', 'screen', '分享', 'share',
            '设置', 'settings', '帮助', 'help', 'new chat', '新对话',
            '删除', 'delete', '移除', 'remove',
            '复制', 'copy', '编辑', 'edit', '重命名', 'rename'
        ];
        return blocked.some(w => combined.includes(w));
    }

    function clickUploadButton() {
        const btn = findUploadButton();
        if (btn) {
            btn.click();
            log('🔧 点击上传按钮: ' + (btn.getAttribute('aria-label') || btn.className || btn.tagName), 'info');
            return true;
        }
        return false;
    }

    async function waitForFileInput(timeout) {
        const start = Date.now();
        let clickedUpload = false;
        while (Date.now() - start < timeout) {
            let inp = findFileInput(document, 0);
            if (inp) return inp;
            if (!clickedUpload) {
                clickUploadButton();
                clickedUpload = true;
                await sleep(500);
                inp = findFileInput(document, 0);
                if (inp) return inp;
            }
            await sleep(800);
        }
        return null;
    }

    // ---- 输入框查找 ----
    function findChatInputArea() {
        // DeepSeek 输入区选择器（按优先级）
        const selectors = [
            'textarea',                                   // 最通用
            '[contenteditable="true"]',
            '[role="textbox"]',
            'textarea[class*="ds-" i]',                   // DeepSeek 特有
            'div[class*="chat-input" i] textarea',
            'div[class*="ChatInput" i] textarea',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null && !isInsideOurPanel(el)) return el;
        }
        return null;
    }

    function findTextInput() {
        return findChatInputArea();
    }

    // ---- 发送按钮查找 ----
    function findSendButton() {
        // 策略1: 在输入区附近找发送按钮
        const chatArea = findChatInputArea();
        const searchRoot = chatArea ? chatArea.closest('form') || chatArea.parentElement : document;

        // 常见发送按钮特征
        const allBtns = searchRoot.querySelectorAll('button');
        for (const btn of allBtns) {
            if (btn.offsetParent === null) continue;
            if (isInsideOurPanel(btn)) continue;
            if (isDangerousButton(btn)) continue;

            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (/send|发送|submit|提交/.test(aria)) return btn;

            // 检查是否有发送图标（通常是箭头/纸飞机 SVG）
            const svg = btn.querySelector('svg');
            if (svg) {
                const svgClass = (svg.getAttribute('class') || '').toLowerCase();
                const svgHTML = svg.outerHTML.toLowerCase();
                if (/send|submit|arrow|plane/.test(svgClass + ' ' + svgHTML)) {
                    return btn;
                }
            }
        }

        // 策略2: 全局搜索
        for (const btn of document.querySelectorAll('button')) {
            if (btn.offsetParent === null) continue;
            if (isInsideOurPanel(btn)) continue;
            if (isDangerousButton(btn)) continue;
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
            if (aria === 'send' || aria === '发送' || aria === 'submit') return btn;
        }

        // 策略3: DeepSeek 专用 — 找右下角最近的按钮
        if (chatArea) {
            const form = chatArea.closest('form') || chatArea.closest('div[class*="input" i]');
            if (form) {
                const btns = [...form.querySelectorAll('button')].filter(b => b.offsetParent !== null && !isInsideOurPanel(b));
                // 取最后一个可见按钮（发送按钮通常在最后）
                for (let i = btns.length - 1; i >= 0; i--) {
                    if (!isDangerousButton(btns[i])) return btns[i];
                }
            }
        }

        return null;
    }

    function clickSendButton() {
        const btn = findSendButton();
        if (btn) {
            btn.click();
            log('🔧 点击发送按钮', 'info');
            return true;
        }

        // 兜底: Enter 键
        const editable = findTextInput();
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

    // ==================== 输入 Prompt ====================
    async function typePromptIntoChat(promptText) {
        try {
            log('🔧 开始输入 Prompt...', 'info');

            const editable = findTextInput();

            if (!editable) {
                log('⚠️ 未找到输入框', 'warn');
                return false;
            }

            log(`🔧 找到输入框: tag=${editable.tagName}`, 'info');
            editable.focus();
            await sleep(300);

            try { if (typeof GM_setClipboard !== 'undefined') { GM_setClipboard(promptText); } } catch(e) {}

            // 策略1: execCommand insertText
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

            // 策略2: textContent/value + InputEvent
            if (!success) {
                try {
                    editable.focus();
                    if (editable.tagName === 'TEXTAREA' || editable.tagName === 'INPUT') {
                        editable.value = promptText;
                    } else {
                        editable.textContent = promptText;
                    }
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
                        log(`✅ Prompt 已输入 (直接赋值, ${len} 字符)`, 'info');
                        success = true;
                    }
                } catch(e) {
                    log(`⚠️ 直接赋值失败: ${e.message}`, 'warn');
                }
            }

            // 策略3: 逐行 execCommand
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
    function isValidResponse(text) {
        if (!text || text.length < 500) {
            return { valid: false, reason: '内容过短 (' + (text ? text.length : 0) + ' 字符, 需>=500)' };
        }
        // 排除 DeepSeek 常见的拒绝/错误消息
        const refusePatterns = [
            /抱歉.{0,20}(无法|不能).{0,20}(处理|读取|识别)/,
            /I('m| am) sorry.{0,30}(cannot|unable)/i,
            /请提供.{0,10}(文件|文档|PDF)/,
            /Please (upload|provide|attach).{0,15}(file|document)/i,
            /错误.{0,10}(处理|读取|上传)/,
        ];
        for (const pattern of refusePatterns) {
            if (pattern.test(text)) {
                return { valid: false, reason: '检测到拒绝/错误回答: ' + text.substring(0, 100).replace(/\n/g, ' ') };
            }
        }
        return { valid: true, reason: '有效回答 (' + text.length + ' 字符)' };
    }

    // ==================== 等待 AI 回答完成 ====================
    function findChatScrollContainer() {
        // DeepSeek 消息列表容器
        const selectors = [
            '.ds-virtual-list-visible-items',            // DeepSeek 虚拟列表
            'div[class*="ds-virtual-list" i]',
            'div[class*="message-list" i]',
            'div[class*="chat-messages" i]',
            'div[class*="ChatMessages" i]',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && !isInsideOurPanel(el)) return el;
        }

        // 回退: 找最大的可滚动区域
        const mains = document.querySelectorAll('main');
        for (const main of mains) {
            if (isInsideOurPanel(main)) continue;
            const divs = main.querySelectorAll('div');
            for (const d of divs) {
                if (isInsideOurPanel(d)) continue;
                const style = window.getComputedStyle(d);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll') &&
                    d.scrollHeight > d.clientHeight && d.clientHeight > 100) {
                    return d;
                }
            }
        }
        return null;
    }

    function getChatMessageElements(container) {
        if (!container) return [];
        return [...container.children].filter(el => !isInsideOurPanel(el));
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

        // 也收集所有 markdown 内容的指纹
        const allMdBoxes = document.querySelectorAll('.ds-markdown, div[class*="markdown" i], div[class*="md-box" i]');
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

    /**
     * 等待 DeepSeek 回答完成
     * DeepSeek 的 AI 消息渲染在 .ds-virtual-list-visible-items 容器内
     * AI 消息 class 包含 _4f9bf79（可能随版本变化）
     * 最终回答在 .ds-markdown 元素中
     * 思考链内容在 .ds-think-content 中（需排除）
     */
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
        const GROWTH_ABS_THRESHOLD = 40;         // 绝对增长阈值：每轮 < 40 字符视为稳定

        const fingerprints = baseline.fingerprints || STATE.baselineFingerprints || new Set();
        log('⏳ 等待 DeepSeek 回答...', 'info');

        // 寻找 AI 消息元素（DeepSeek 使用虚拟列表）
        function findLatestAiMessage() {
            // 策略1: 找 .ds-markdown 元素（最终回答），排除思考链中的
            const allMd = document.querySelectorAll('.ds-markdown');
            let best = null, bestLen = 0;
            for (const md of allMd) {
                if (isInsideOurPanel(md)) continue;
                // 排除思考链内的 markdown
                if (md.closest('.ds-think-content')) continue;
                const text = (md.textContent || '').trim();
                if (text.length > bestLen && text.length > 100) {
                    const fp = hashText(text);
                    if (!fingerprints.has(fp) && !isPreviouslySaved(text)) {
                        best = md;
                        bestLen = text.length;
                    }
                }
            }
            return best ? best.textContent.trim() : '';
        }

        function captureBestAnswer() {
            // 策略1: 最新 AI 消息
            const aiText = findLatestAiMessage();
            if (aiText && aiText.length > 200) return aiText;

            // 策略2: 容器内新增子元素
            let bestText = '';
            const allMdBoxes = document.querySelectorAll('.ds-markdown, div[class*="markdown" i]');
            for (const box of allMdBoxes) {
                if (isInsideOurPanel(box)) continue;
                if (box.closest('.ds-think-content')) continue;  // 排除思考链
                const text = (box.textContent || '').trim();
                if (text.length < 200) continue;
                if (text.startsWith('你是 ') || text.includes('<标题/作者')) continue;
                if (text.includes('历史对话') || text.includes('搜索')) continue;
                const fp = hashText(text);
                if (fingerprints.has(fp)) continue;
                if (isPreviouslySaved(text)) continue;
                if (text.length > bestText.length) bestText = text;
            }
            return bestText;
        }

        while (Date.now() - start < timeoutMs) {
            while (STATE.paused && STATE.running) { await sleep(1000); }
            if (!STATE.running) return null;

            // SSE 拦截结果优先
            if (STATE.sseDone && STATE.sseText && STATE.sseText.length > 200) {
                const fp = hashText(STATE.sseText);
                if (!fingerprints.has(fp) && !isPreviouslySaved(STATE.sseText)) {
                    STATE.processedHashes.push(fp);
                    STATE.lastSavedHash = fp;
                    if (STATE.processedHashes.length > 50) STATE.processedHashes.shift();
                    log(`✅ 回答完成 (${STATE.sseText.length} 字符, 🔌SSE拦截)`, 'success');
                    return STATE.sseText;
                }
            }
            if (STATE.sseActive) {
                await sleep(1000);
                continue;
            }

            // 策略1: 容器内新增检查
            let newMsgText = '';
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
                    const mdBoxes = el.querySelectorAll('.ds-markdown, div[class*="markdown" i]');
                    for (const md of mdBoxes) {
                        if (isInsideOurPanel(md)) continue;
                        if (md.closest('.ds-think-content')) continue;
                        const text = (md.textContent || '').trim();
                        if (text.length < 50) continue;
                        if (text.startsWith('你是 ')) continue;
                        if (text.includes('<标题/作者')) continue;
                        const fp = hashText(text);
                        if (fingerprints.has(fp)) continue;
                        if (text.length > newMsgText.length) newMsgText = text;
                    }
                }
            }

            // 策略2: 全局扫描
            const elapsed = Date.now() - start;
            if ((!newMsgText || newMsgText.length < 100) && elapsed >= STRATEGY2_MIN_WAIT) {
                newMsgText = captureBestAnswer() || newMsgText;
            }

            if (newMsgText && newMsgText.length > 50) {
                const currentLength = newMsgText.length;
                const preview = newMsgText.substring(0, 100);
                // 跳过 Prompt 本身（如果出现在回答中）
                if (preview.includes('你是 ') && (preview.includes('研究员') || preview.includes('工程师'))) {
                    lastTextLength = 0; stableCount = 0;
                    await sleep(CHECK_INTERVAL); continue;
                }

                if (currentLength === lastTextLength) {
                    stableCount++;
                } else if (currentLength > lastTextLength && lastTextLength > 0) {
                    const growth = currentLength - lastTextLength;
                    const growthRate = growth / lastTextLength;
                    // 两个条件满足任一即视为稳定：(1) 相对增长率 < 0.5%  (2) 绝对增长 < 40 字符
                    if (growthRate < GROWTH_RATE_THRESHOLD || growth < GROWTH_ABS_THRESHOLD) {
                        stableCount++;
                    } else {
                        stableCount = 0;
                        log(`📝 生成中 (${currentLength} 字符, +${growth})...`, 'info');
                    }
                }
                lastTextLength = currentLength;

                // 自适应稳定阈值：等待超过 2 分钟后逐步放松
                const elapsedMin = (Date.now() - start) / 60000;
                const relax = Math.max(0, Math.floor(elapsedMin - 2));
                const adaptiveStable = Math.max(2, STABLE_THRESHOLD - relax);

                if (stableCount >= adaptiveStable && elapsed >= MIN_WAIT_MS) {
                    const fp = hashText(newMsgText);
                    if (fingerprints.has(fp) || isPreviouslySaved(newMsgText)) {
                        stableCount = 0; lastTextLength = 0;
                        await sleep(CHECK_INTERVAL * 2); continue;
                    }
                    log(`✅ 回答完成 (${currentLength} 字符, DOM轮询, 稳定 ${stableCount * 2}秒)`, 'success');
                    STATE.processedHashes.push(fp);
                    STATE.lastSavedHash = fp;
                    if (STATE.processedHashes.length > 50) STATE.processedHashes.shift();
                    return newMsgText;
                }

                if (stableCount >= STABLE_THRESHOLD && elapsed < MIN_WAIT_MS) {
                    log(`⏳ 文本已稳定，等待最短时间 (${Math.round(elapsed/1000)}/${Math.round(MIN_WAIT_MS/1000)}s)...`, 'info');
                }
            }

            await sleep(CHECK_INTERVAL);
        }

        log('⚠️ 等待回答超时', 'warn');
        // 超时后最后尝试捕获
        const lastTry = captureBestAnswer();
        if (lastTry && lastTry.length > 200 && !isPreviouslySaved(lastTry)) {
            log(`✅ 超时后捕获回答 (${lastTry.length} 字符)`, 'success');
            return lastTry;
        }
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
        name = name.replace(/^\d+\.\d+\/[^,]+,/,'').trim();
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

        let namePrefix = '';
        if (originalPdfName) {
            namePrefix = originalPdfName.replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
        }
        const titleClean = title.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
        const fileName = (namePrefix ? namePrefix + '_' : '') + titleClean + '.md';

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
        await sleep(2000);

        // 策略1: DeepSeek 侧边栏 "新对话" 按钮
        const allBtns = document.querySelectorAll('button, a, div[role="button"], span[role="button"]');
        const keywords = ['新对话', '新建对话', '新聊天', '发起新', 'new chat', 'New Chat', '新建会话', '新会话'];
        for (const btn of allBtns) {
            if (isInsideOurPanel(btn)) continue;
            const text = (btn.textContent || '').trim();
            if (text.length > 0 && text.length <= 20) {
                for (const kw of keywords) {
                    if (text.includes(kw)) {
                        log('🆕 点击: ' + text, 'info');
                        btn.click();
                        await sleep(3000);
                        const input = findTextInput();
                        if (input && (!input.textContent || (input.value || input.textContent || '').trim().length < 5)) {
                            log('✅ 新对话成功', 'success');
                            return true;
                        }
                    }
                }
            }
        }

        // 策略2: 侧边栏首部按钮
        const sidebar = document.querySelector('[class*="side" i], nav, aside');
        if (sidebar) {
            const btns = sidebar.querySelectorAll('button, [role="button"]');
            for (const btn of btns) {
                if (isInsideOurPanel(btn)) continue;
                const rect = btn.getBoundingClientRect();
                if (rect.top < 150 && rect.width > 0) {
                    log('🆕 点击侧边栏顶部按钮', 'info');
                    btn.click();
                    await sleep(3000);
                    const input = findTextInput();
                    if (input && (!input.textContent || (input.value || '').trim().length < 5)) {
                        log('✅ 新对话成功(侧边栏)', 'success');
                        return true;
                    }
                }
            }
        }

        // 策略3: DeepSeek Logo 点击（导航到首页）
        const logoLinks = document.querySelectorAll('a[href="/"], a[href="/chat"]');
        for (const link of logoLinks) {
            if (isInsideOurPanel(link)) continue;
            log('🔄 点击 Logo 导航到首页', 'warn');
            if (STATE.running) setResumeState('新建对话-Logo导航');
            link.click();
            await sleep(5000);
            return true;
        }

        // 策略4: 直接导航
        log('🔄 URL 导航到 DeepSeek 首页', 'warn');
        if (STATE.running) setResumeState('新建对话-跳转首页');
        window.location.href = 'https://chat.deepseek.com/';
        await sleep(8000);
        return true;
    }

    // ==================== 冷却 + 唤醒 ====================
    async function cooldownAndWake(config) {
        const cooldownMs = (config.cooldownMinutes || DEFAULT_COOLDOWN_MINUTES) * 60 * 1000;
        log(`😴 检测到无效回答，进入冷却期 ${Math.round(cooldownMs/60000)} 分钟...`, 'warn');
        persistLog(`无效回答冷却开始，预计 ${Math.round(cooldownMs/60000)} 分钟`, 'warn');

        const start = Date.now();
        while (Date.now() - start < cooldownMs) {
            while (STATE.paused && STATE.running) { await sleep(1000); }
            if (!STATE.running) return;
            await sleep(1000);
        }

        if (!STATE.running) return;

        const wakePrompt = config.wakeupPrompt || DEFAULT_WAKEUP_PROMPT;
        log(`🌅 冷却完成，发送日常问题唤醒 DeepSeek: "${wakePrompt}"`, 'info');

        await startNewChat();
        await sleep(2000);

        const entered = await typePromptIntoChat(wakePrompt);
        if (entered) {
            await randomDelay(1000, 1500);
            const baseline = markBaseline();
            STATE.sseText = '';
            STATE.sseDone = false;
            STATE.sseActive = false;
            clickSendButton();
            log('📨 日常问题已发送，等待回答...', 'info');
            await waitForResponseComplete(5 * 60 * 1000, baseline, config);
            log('✅ 唤醒完成，继续上传', 'success');
            persistLog('冷却+唤醒完成，继续上传', 'info');
        } else {
            log('⚠️ 日常问题输入失败，直接继续上传', 'warn');
        }

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

            // DeepSeek: 查找/触发文件上传
            const fileInput = await waitForFileInput(FILE_INPUT_WAIT_TIMEOUT);
            if (!fileInput) {
                log(`❌ 未找到上传入口: ${name}`, 'error');
                log(`💡 提示: 请确保 DeepSeek 页面已完全加载，且当前对话支持文件上传`, 'warn');
                log(`💡 可尝试点击 DeepSeek 输入框旁的附件/上传按钮后重试`, 'warn');
                persistLog(`未找到上传入口: ${name}`, 'error');
                return false;
            }

            setFileToInput(fileInput, fileObj);

            // DeepSeek 上传后需要更长时间处理（读取 PDF 内容）
            const uploadWaitSec = config.uploadWaitSeconds || DEFAULT_UPLOAD_WAIT_SECONDS;
            const uploadWait = (uploadWaitSec * 1000) + Math.random() * 3000;
            log(`📎 文件已设置，等待 ${Math.round(uploadWait/1000)} 秒让 DeepSeek 处理文件...`, 'info');
            await sleep(uploadWait);

            // 可选: 开启深度思考模式
            if (config.useDeepSeekDeepThink) {
                try {
                    const deepThinkBtn = findDeepThinkButton();
                    if (deepThinkBtn && !deepThinkBtn.classList.contains('ds-toggle-button--selected')) {
                        deepThinkBtn.click();
                        log('🧠 已开启深度思考模式', 'info');
                        await sleep(500);
                    }
                } catch(e) {}
            }

            // 检查是否需要输入 Prompt
            const autoPromptOn = config.autoPrompt !== false;
            let promptEntered = false;

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

            const baseline = markBaseline();
            STATE.sseText = '';
            STATE.sseDone = false;
            STATE.sseActive = false;

            let sent = clickSendButton();
            if (sent) {
                log(`📨 已发送: ${name}`, 'success');
            } else {
                log(`⚠️ 未能发送: ${name}`, 'warn');
                persistLog(`未能发送: ${name}`, 'warn');
            }

            const responseText = await waitForResponseComplete(15 * 60 * 1000, baseline, config);

            if (responseText) {
                const validation = isValidResponse(responseText);
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
                    log(`❌ 回答无效: ${validation.reason}`, 'error');
                    log(`📄 无效内容前200字: ${responseText.substring(0, 200).replace(/\n/g, ' ')}`, 'warn');
                    persistLog(`无效回答: ${name} — ${validation.reason}`, 'error');
                    addUploaded(name, 'invalid');
                    STATE.consecutiveFailures++;
                    updateStats();
                    await cooldownAndWake(config);
                    return false;
                }
            } else {
                log('⚠️ 未获取到回答内容', 'warn');
                persistLog(`无回答: ${name}`, 'warn');
                addUploaded(name, 'no_response');
                STATE.consecutiveFailures++;
                updateStats();
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

    // ---- DeepSeek 深度思考按钮 ----
    function findDeepThinkButton() {
        // 基于 ds-enhance 脚本的信息: DeepSeek 的工具栏按钮使用 .ds-toggle-button
        const toggleBtns = document.querySelectorAll('.ds-toggle-button');
        for (const btn of toggleBtns) {
            const text = btn.textContent.trim();
            if (text.includes('深度思考') || text.includes('DeepThink')) return btn;
        }
        return null;
    }

    // ==================== 时间窗口检查 ====================
    function isWithinSchedule(config) {
        const startTime = config.scheduleStart || '';
        const endTime = config.scheduleEnd || '';
        if (!startTime || !endTime) return true;

        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();
        const [sh, sm] = startTime.split(':').map(Number);
        const [eh, em] = endTime.split(':').map(Number);
        const startMin = sh * 60 + sm;
        const endMin = eh * 60 + em;

        if (startMin <= endMin) return nowMinutes >= startMin && nowMinutes <= endMin;
        else return nowMinutes >= startMin || nowMinutes <= endMin;
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

        if (config.scheduleStart && config.scheduleEnd) {
            if (isWithinSchedule(config)) {
                log(`⏰ 时间窗口: ${config.scheduleStart} ~ ${config.scheduleEnd}（当前在窗口内）`, 'info');
            } else {
                const next = getNextScheduleStart(config);
                const waitMs = next ? next - new Date() : 0;
                log(`⏰ 当前不在窗口内，等待 ${formatTimeRemaining(waitMs)} 后自动启动...`, 'warn');
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

            const cfg = getConfig();
            while (!isWithinSchedule(cfg) && STATE.running) {
                const next = getNextScheduleStart(cfg);
                const waitMs = next ? next - new Date() : 60000;
                if (waitMs > 0) {
                    const oldPaused = STATE.paused;
                    STATE.paused = true;
                    updateButtons();
                    updateScheduleStatus(cfg);
                    log(`⏰ 时间窗口外，暂停中... 约 ${formatTimeRemaining(waitMs)} 后恢复`, 'warn');
                    await sleep(Math.min(waitMs, 60000));
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
            entry.className = `ds-log-entry ds-log-${level}`;
            entry.textContent = line;
            logContainer.appendChild(entry);
            logContainer.scrollTop = logContainer.scrollHeight;
        }

        if (level === 'error') console.error(line);
        else if (level === 'warn') console.warn(line);
        else console.log(line);

        persistLog(message, level);
    }

    // ==================== UI 面板 ====================
    function createPanel() {
        GM_addStyle(`
            #ds-uploader-panel {
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
            #ds-uploader-panel.ds-collapsed { width: 48px; height: 48px; border-radius: 24px; }
            #ds-uploader-panel.ds-collapsed .ds-content { display: none; }
            #ds-uploader-panel.ds-collapsed .ds-minimize-icon { display: block; }
            #ds-uploader-panel.ds-collapsed .ds-header-text { display: none; }

            .ds-header {
                display: flex; align-items: center; padding: 10px 14px;
                background: linear-gradient(135deg, #1a3a5c 0%, #1a1a2e 100%);
                border-bottom: 1px solid #2a2a4a;
                cursor: move;
                border-radius: 12px 12px 0 0;
                gap: 8px;
            }
            .ds-header-icon { font-size: 18px; }
            .ds-header-text { font-weight: 600; font-size: 14px; white-space: nowrap; }
            .ds-header-spacer { flex: 1; }
            .ds-header-btn {
                background: none; border: 1px solid #3a3a5a; color: #aaa;
                border-radius: 6px; cursor: pointer; padding: 4px 8px;
                font-size: 12px; transition: all 0.2s;
            }
            .ds-header-btn:hover { background: #3a3a5a; color: #fff; }
            .ds-minimize-icon { display: none; cursor: pointer; font-size: 20px; }

            .ds-content {
                flex: 1; overflow-y: auto; padding: 12px 14px;
                display: flex; flex-direction: column; gap: 10px;
            }

            .ds-section { display: flex; flex-direction: column; gap: 6px; }
            .ds-section-title {
                font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
                color: #6a6a8a; margin-bottom: 2px;
            }
            .ds-row { display: flex; align-items: center; gap: 8px; }
            .ds-label { color: #aaa; font-size: 12px; min-width: 60px; white-space: nowrap; }

            .ds-btn {
                padding: 6px 14px; border: none; border-radius: 6px;
                cursor: pointer; font-size: 12px; font-weight: 500;
                transition: all 0.2s;
            }
            .ds-btn-primary { background: #3b82f6; color: #fff; }
            .ds-btn-primary:hover { background: #2563eb; }
            .ds-btn-success { background: #10b981; color: #fff; }
            .ds-btn-success:hover { background: #059669; }
            .ds-btn-warn { background: #f59e0b; color: #fff; }
            .ds-btn-warn:hover { background: #d97706; }
            .ds-btn-danger { background: #ef4444; color: #fff; }
            .ds-btn-danger:hover { background: #dc2626; }
            .ds-btn-outline {
                background: transparent; border: 1px solid #3b82f6; color: #3b82f6;
            }
            .ds-btn-outline:hover { background: rgba(59,130,246,0.1); }
            .ds-btn:disabled { opacity: 0.4; cursor: not-allowed; }
            .ds-btn-sm { padding: 4px 10px; font-size: 11px; }

            .ds-input {
                background: #16213e; border: 1px solid #2a2a4a; color: #e0e0e0;
                border-radius: 6px; padding: 6px 10px; font-size: 12px;
                width: 60px; text-align: center;
            }
            .ds-input:focus { outline: none; border-color: #3b82f6; }
            input[type=number].ds-input { -moz-appearance: textfield; }
            input[type=number].ds-input::-webkit-inner-spin-button,
            input[type=number].ds-input::-webkit-outer-spin-button { opacity: 1; }

            .ds-folder-display {
                flex: 1; padding: 6px 10px; background: #16213e;
                border: 1px dashed #3a3a5a; border-radius: 6px;
                color: #6a6a8a; font-size: 12px; white-space: nowrap;
                overflow: hidden; text-overflow: ellipsis;
            }
            .ds-folder-display.active { color: #10b981; border-color: #10b981; border-style: solid; }

            .ds-stats {
                display: flex; gap: 12px; padding: 8px 12px;
                background: #16213e; border-radius: 8px;
                font-size: 12px; color: #aaa;
            }
            .ds-stat-value { color: #3b82f6; font-weight: 600; }
            .ds-stat-value.success { color: #10b981; }
            .ds-stat-value.warn { color: #f59e0b; }
            .ds-stat-value.error { color: #ef4444; }

            .ds-progress-bar {
                height: 6px; background: #2a2a4a; border-radius: 3px;
                overflow: hidden; margin-top: 4px;
            }
            .ds-progress-fill {
                height: 100%; background: linear-gradient(90deg, #3b82f6, #10b981);
                border-radius: 3px; transition: width 0.3s;
            }

            .ds-log-container {
                background: #0d0d1a; border-radius: 8px;
                padding: 8px; max-height: 200px; overflow-y: auto;
                font-family: "JetBrains Mono", "Fira Code", "Consolas", monospace;
                font-size: 11px; line-height: 1.6;
            }
            .ds-log-entry { padding: 1px 0; }
            .ds-log-info { color: #a0a0c0; }
            .ds-log-success { color: #10b981; }
            .ds-log-warn { color: #f59e0b; }
            .ds-log-error { color: #ef4444; font-weight: 600; }

            .ds-queue-list {
                max-height: 400px; overflow-y: auto;
                background: #16213e; border-radius: 6px;
                padding: 4px 8px;
            }
            .ds-queue-item {
                padding: 3px 6px; border-radius: 4px;
                font-size: 11px; color: #aaa;
                display: flex; align-items: center; gap: 6px;
                cursor: pointer;
            }
            .ds-queue-item:hover { background: rgba(59,130,246,0.1); }
            .ds-queue-item.current { background: rgba(59,130,246,0.15); color: #3b82f6; font-weight: 600; }
            .ds-queue-item.done { color: #10b981; }
            .ds-queue-item.invalid { color: #ef4444; }
            .ds-queue-item.selected { background: rgba(245,158,11,0.15); color: #f59e0b; }
            .ds-queue-item .ds-queue-dot { font-size: 8px; }

            .ds-divider { border: none; border-top: 1px solid #2a2a4a; margin: 4px 0; }

            .ds-prompt-tabs {
                display: flex; gap: 2px; flex-wrap: wrap;
            }
            .ds-prompt-tab {
                padding: 5px 10px; border-radius: 6px 6px 0 0;
                background: #0d0d1a; color: #6a6a8a;
                font-size: 11px; cursor: pointer; border: 1px solid transparent;
                transition: all 0.2s; white-space: nowrap;
            }
            .ds-prompt-tab:hover { color: #aaa; background: #16213e; }
            .ds-prompt-tab.active {
                background: #16213e; color: #3b82f6;
                border-color: #2a2a4a; border-bottom-color: #16213e;
                font-weight: 600;
            }
            .ds-prompt-textarea {
                width: 100%; height: 100px;
                background: #16213e; border: 1px solid #2a2a4a; color: #e0e0e0;
                border-radius: 0 6px 6px 6px;
                padding: 6px 10px; font-size: 11px; line-height: 1.4;
                resize: vertical; font-family: inherit;
            }
            .ds-prompt-textarea:focus { outline: none; border-color: #3b82f6; }

            .ds-drop-overlay {
                position: fixed; inset: 0; z-index: 99998;
                background: rgba(59,130,246,0.15);
                border: 3px dashed #3b82f6;
                display: none; align-items: center; justify-content: center;
                pointer-events: none;
            }
            .ds-drop-overlay.active { display: flex; }
            .ds-drop-text {
                background: rgba(26,26,46,0.95); color: #3b82f6;
                padding: 24px 48px; border-radius: 16px;
                font-size: 20px; font-weight: 700;
                pointer-events: none;
            }

            .ds-content::-webkit-scrollbar,
            .ds-log-container::-webkit-scrollbar,
            .ds-queue-list::-webkit-scrollbar { width: 4px; }
            .ds-content::-webkit-scrollbar-track,
            .ds-log-container::-webkit-scrollbar-track,
            .ds-queue-list::-webkit-scrollbar-track { background: transparent; }
            .ds-content::-webkit-scrollbar-thumb,
            .ds-log-container::-webkit-scrollbar-thumb,
            .ds-queue-list::-webkit-scrollbar-thumb { background: #3a3a5a; border-radius: 2px; }
        `);

        const dropOverlay = document.createElement('div');
        dropOverlay.id = DROP_OVERLAY_ID;
        dropOverlay.className = 'ds-drop-overlay';
        dropOverlay.innerHTML = '<div class="ds-drop-text">📂 释放以添加 PDF 到队列</div>';
        document.body.appendChild(dropOverlay);

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="ds-header" id="ds-header-drag">
                <span class="ds-header-icon">🐋</span>
                <span class="ds-header-text">DeepSeek PDF 批量上传器 v1.1.0</span>
                <span class="ds-header-spacer"></span>
                <span class="ds-minimize-icon" id="ds-minimize-icon" title="展开">🐋</span>
                <button class="ds-header-btn" id="ds-btn-minimize" title="最小化">−</button>
            </div>
            <div class="ds-content" id="ds-content">
                <div class="ds-section">
                    <div class="ds-section-title">📂 文件夹</div>
                    <div class="ds-row">
                        <span class="ds-folder-display" id="ds-folder-display">未选择</span>
                        <button class="ds-btn ds-btn-outline ds-btn-sm" id="ds-btn-pick">选择</button>
                        <button class="ds-btn ds-btn-outline ds-btn-sm" id="ds-btn-refresh" disabled>🔄</button>
                    </div>
                    <div style="color:#6a6a8a;font-size:10px;">也支持拖拽 PDF 文件/文件夹到页面</div>
                </div>

                <hr class="ds-divider">

                <div class="ds-section">
                    <div class="ds-section-title">⚙️ 间隔设置</div>
                    <div class="ds-row">
                        <span class="ds-label">上传间隔</span>
                        <input type="number" class="ds-input" id="ds-input-interval" min="0.1" step="0.5" value="${DEFAULT_INTERVAL_MINUTES}">
                        <span style="color:#aaa;font-size:12px;">分钟</span>
                    </div>
                    <div class="ds-row">
                        <span class="ds-label">最短等待</span>
                        <input type="number" class="ds-input" id="ds-input-min-wait" min="30" step="10" value="${DEFAULT_MIN_WAIT_SECONDS}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">秒</span>
                    </div>
                    <div class="ds-row">
                        <span class="ds-label">稳定判定</span>
                        <input type="number" class="ds-input" id="ds-input-stable" min="5" step="1" value="${DEFAULT_STABLE_THRESHOLD}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">次(×2秒)</span>
                    </div>
                    <div class="ds-row">
                        <span class="ds-label">冷却时间</span>
                        <input type="number" class="ds-input" id="ds-input-cooldown" min="10" step="10" value="${DEFAULT_COOLDOWN_MINUTES}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">分钟(无效回答后)</span>
                    </div>
                    <div class="ds-row">
                        <span class="ds-label">上传后等待</span>
                        <input type="number" class="ds-input" id="ds-input-upload-wait" min="1" step="0.5" value="${DEFAULT_UPLOAD_WAIT_SECONDS}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">秒(上传→输入Prompt)</span>
                    </div>
                    <div class="ds-row">
                        <span class="ds-label">Prompt后等待</span>
                        <input type="number" class="ds-input" id="ds-input-prompt-done-wait" min="0.5" step="0.5" value="${DEFAULT_PROMPT_DONE_WAIT_SECONDS}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">秒(Prompt完成→发送)</span>
                    </div>
                    <div class="ds-row">
                        <span class="ds-label">发送前等待</span>
                        <input type="number" class="ds-input" id="ds-input-presend-wait" min="0.5" step="0.5" value="${DEFAULT_PRESEND_WAIT_SECONDS}" style="width:50px;">
                        <span style="color:#aaa;font-size:12px;">秒(最后缓冲)</span>
                    </div>
                    <div class="ds-row" style="margin-top:8px;">
                        <span class="ds-label">⏰ 时间窗口</span>
                        <input type="time" id="ds-input-schedule-start" style="background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:4px 8px;font-size:12px;width:130px;">
                        <span style="color:#aaa;font-size:12px;">&nbsp;至&nbsp;</span>
                        <input type="time" id="ds-input-schedule-end" style="background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:4px 8px;font-size:12px;width:130px;">
                        <span style="color:#aaa;font-size:11px;" id="ds-schedule-status">(未设置)</span>
                    </div>
                </div>

                <div class="ds-section">
                    <div class="ds-section-title">🌅 唤醒设置</div>
                    <div class="ds-row">
                        <input type="text" id="ds-input-wakeup" style="flex:1;background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:6px 10px;font-size:12px;" placeholder="冷却后发送的日常问题" value="${DEFAULT_WAKEUP_PROMPT}">
                    </div>
                </div>

                <hr class="ds-divider">

                <div class="ds-section">
                    <div class="ds-section-title">🧠 DeepSeek 专属选项</div>
                    <div class="ds-row">
                        <label style="color:#aaa;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;">
                            <input type="checkbox" id="ds-checkbox-deepthink"> 自动开启「深度思考」模式 (DeepThink R1)
                        </label>
                    </div>
                </div>

                <div class="ds-section">
                    <div class="ds-section-title">⚙️ 通用选项</div>
                    <div class="ds-row">
                        <label style="color:#aaa;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;">
                            <input type="checkbox" id="ds-checkbox-autoprompt" checked> 上传后自动输入 Prompt
                        </label>
                    </div>
                    <div class="ds-row">
                        <label style="color:#aaa;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;">
                            <input type="checkbox" id="ds-checkbox-autosave" checked> 自动保存回答为 Markdown
                        </label>
                    </div>
                </div>

                <div class="ds-section">
                    <div class="ds-section-title">📝 Prompt 模板（5种变体轮换）</div>
                    <div class="ds-prompt-tabs" id="ds-prompt-tabs">
                        <span class="ds-prompt-tab active" data-tab="0">🧑‍🔬 博士后</span>
                        <span class="ds-prompt-tab" data-tab="1">👨‍🏫 资深研究员</span>
                        <span class="ds-prompt-tab" data-tab="2">🎓 博士生</span>
                        <span class="ds-prompt-tab" data-tab="3">📝 审稿人</span>
                        <span class="ds-prompt-tab" data-tab="4">🏭 工业研发</span>
                    </div>
                    <textarea class="ds-prompt-textarea" id="ds-textarea-prompt" placeholder="上传文件后自动输入的 Prompt..."></textarea>
                    <div class="ds-row" style="margin-top:4px;">
                        <label style="color:#aaa;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer;">
                            <input type="checkbox" id="ds-checkbox-auto-rotate" checked> 🔄 自动轮换（每次用不同变体）
                        </label>
                        <span style="color:#6a6a8a;font-size:10px;margin-left:8px;">（轮换位: <span id="ds-rotate-index">-</span>）</span>
                    </div>
                    <div class="ds-row" style="gap:6px;margin-top:4px;">
                        <button class="ds-btn ds-btn-outline ds-btn-sm" id="ds-btn-save-prompt">💾 保存当前变体</button>
                        <button class="ds-btn ds-btn-outline ds-btn-sm" id="ds-btn-reset-prompt">🔄 恢复默认</button>
                    </div>
                </div>

                <hr class="ds-divider">

                <div class="ds-stats" id="ds-stats">
                    <span>队列: <span class="ds-stat-value" id="ds-queue-count">0</span></span>
                    <span>已完成: <span class="ds-stat-value success" id="ds-uploaded-count">0</span></span>
                    <span>无效: <span class="ds-stat-value error" id="ds-invalid-count">0</span></span>
                    <span>当前: <span class="ds-stat-value warn" id="ds-current-file">-</span></span>
                </div>
                <div class="ds-progress-bar">
                    <div class="ds-progress-fill" id="ds-progress-fill" style="width:0%"></div>
                </div>

                <div class="ds-section">
                    <div class="ds-section-title">📋 队列列表 (点击选择/取消选择)</div>
                    <div class="ds-queue-list" id="ds-queue-list">
                        <div style="color:#6a6a8a;font-size:11px;">暂无文件，选择文件夹或拖拽PDF以添加</div>
                    </div>
                </div>

                <div class="ds-section">
                    <div class="ds-section-title">🎯 按序号上传</div>
                    <div class="ds-row" style="gap:6px;">
                        <input type="text" id="ds-input-range" style="flex:1;background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:6px 10px;font-size:12px;" placeholder="如 1,3,5-10,15">
                        <button class="ds-btn ds-btn-outline ds-btn-sm" id="ds-btn-upload-range">🎯 上传指定</button>
                    </div>
                </div>

                <div class="ds-row" style="gap:6px;flex-wrap:wrap;">
                    <button class="ds-btn ds-btn-success" id="ds-btn-start" disabled>▶ 开始</button>
                    <button class="ds-btn ds-btn-warn" id="ds-btn-pause" disabled>⏸ 暂停</button>
                    <button class="ds-btn ds-btn-danger" id="ds-btn-stop" disabled>⏹ 停止</button>
                    <button class="ds-btn ds-btn-outline ds-btn-sm" id="ds-btn-reset" title="清除所有记录">🔄 重置</button>
                    <button class="ds-btn ds-btn-outline ds-btn-sm" id="ds-btn-export-log">📜 导出日志</button>
                    <button class="ds-btn ds-btn-outline ds-btn-sm" id="ds-btn-import-log">📥 读取日志</button>
                    <button class="ds-btn ds-btn-outline ds-btn-sm" id="ds-btn-retry-failed" disabled>🔁 重试失败</button>
                    <button class="ds-btn ds-btn-outline ds-btn-sm" id="ds-btn-upload-selected" disabled>📌 上传选中</button>
                </div>

                <hr class="ds-divider">

                <div class="ds-section">
                    <div class="ds-section-title">📜 日志</div>
                    <div class="ds-log-container" id="ds-log-container">
                        <div class="ds-log-entry ds-log-info">🐋 DeepSeek PDF 批量上传器 v1.1.0 已启动</div>
                        <div class="ds-log-entry ds-log-info">📌 选择文件夹或拖拽PDF到页面开始</div>
                        <div class="ds-log-entry ds-log-info">💡 首次使用建议先手动上传一个PDF确认流程正常</div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);

        STATE.ui = {
            panel,
            content: panel.querySelector('#ds-content'),
            folderDisplay: panel.querySelector('#ds-folder-display'),
            btnPick: panel.querySelector('#ds-btn-pick'),
            btnRefresh: panel.querySelector('#ds-btn-refresh'),
            btnStart: panel.querySelector('#ds-btn-start'),
            btnPause: panel.querySelector('#ds-btn-pause'),
            btnStop: panel.querySelector('#ds-btn-stop'),
            btnReset: panel.querySelector('#ds-btn-reset'),
            btnMinimize: panel.querySelector('#ds-btn-minimize'),
            minimizeIcon: panel.querySelector('#ds-minimize-icon'),
            headerDrag: panel.querySelector('#ds-header-drag'),
            inputInterval: panel.querySelector('#ds-input-interval'),
            inputMinWait: panel.querySelector('#ds-input-min-wait'),
            inputStable: panel.querySelector('#ds-input-stable'),
            inputCooldown: panel.querySelector('#ds-input-cooldown'),
            inputUploadWait: panel.querySelector('#ds-input-upload-wait'),
            inputPromptDoneWait: panel.querySelector('#ds-input-prompt-done-wait'),
            inputPresendWait: panel.querySelector('#ds-input-presend-wait'),
            inputScheduleStart: panel.querySelector('#ds-input-schedule-start'),
            inputScheduleEnd: panel.querySelector('#ds-input-schedule-end'),
            scheduleStatus: panel.querySelector('#ds-schedule-status'),
            inputWakeup: panel.querySelector('#ds-input-wakeup'),
            checkboxDeepThink: panel.querySelector('#ds-checkbox-deepthink'),
            checkboxAutoPrompt: panel.querySelector('#ds-checkbox-autoprompt'),
            checkboxAutoSave: panel.querySelector('#ds-checkbox-autosave'),
            textareaPrompt: panel.querySelector('#ds-textarea-prompt'),
            promptTabs: panel.querySelector('#ds-prompt-tabs'),
            checkboxAutoRotate: panel.querySelector('#ds-checkbox-auto-rotate'),
            rotateIndex: panel.querySelector('#ds-rotate-index'),
            btnSavePrompt: panel.querySelector('#ds-btn-save-prompt'),
            btnResetPrompt: panel.querySelector('#ds-btn-reset-prompt'),
            btnExportLog: panel.querySelector('#ds-btn-export-log'),
            btnImportLog: panel.querySelector('#ds-btn-import-log'),
            btnRetryFailed: panel.querySelector('#ds-btn-retry-failed'),
            btnUploadSelected: panel.querySelector('#ds-btn-upload-selected'),
            inputRange: panel.querySelector('#ds-input-range'),
            btnUploadRange: panel.querySelector('#ds-btn-upload-range'),
            queueCount: panel.querySelector('#ds-queue-count'),
            uploadedCount: panel.querySelector('#ds-uploaded-count'),
            invalidCount: panel.querySelector('#ds-invalid-count'),
            currentFile: panel.querySelector('#ds-current-file'),
            progressFill: panel.querySelector('#ds-progress-fill'),
            queueList: panel.querySelector('#ds-queue-list'),
            logContainer: panel.querySelector('#ds-log-container'),
            dropOverlay,
        };

        bindUIEvents();
        panel.addEventListener('mousedown', onPanelDragStart);
        bindDropEvents();

        return panel;
    }

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
        [
            [ui.inputInterval, 'intervalMinutes', parseFloat],
            [ui.inputMinWait, 'minWaitSeconds', parseInt],
            [ui.inputStable, 'stableThreshold', parseInt],
            [ui.inputCooldown, 'cooldownMinutes', parseInt],
            [ui.inputUploadWait, 'uploadWaitSeconds', parseFloat],
            [ui.inputPromptDoneWait, 'promptDoneWaitSeconds', parseFloat],
            [ui.inputPresendWait, 'presendWaitSeconds', parseFloat],
        ].forEach(([el, key, parser]) => {
            el.addEventListener('change', () => {
                const val = parser(el.value) || getConfig()[key];
                STATE.config[key] = val;
                saveConfig();
                log(`⏱ ${key}: ${val}`, 'info');
            });
        });

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
            saveConfig();
        });

        ui.checkboxDeepThink.addEventListener('change', () => {
            STATE.config.useDeepSeekDeepThink = ui.checkboxDeepThink.checked;
            saveConfig();
            log(`🧠 深度思考: ${ui.checkboxDeepThink.checked ? '开启' : '关闭'}`, 'info');
        });
        ui.checkboxAutoPrompt.addEventListener('change', () => {
            STATE.config.autoPrompt = ui.checkboxAutoPrompt.checked;
            saveConfig();
            log(`📝 自动 Prompt: ${STATE.config.autoPrompt ? '开启' : '关闭'}`, 'info');
        });
        ui.checkboxAutoSave.addEventListener('change', () => {
            STATE.config.autoSave = ui.checkboxAutoSave.checked;
            saveConfig();
            log(`💾 自动保存: ${STATE.config.autoSave ? '开启' : '关闭'}`, 'info');
        });

        // Prompt 标签页
        function switchPromptTab(tabIdx) {
            STATE.config.activePromptTab = tabIdx;
            saveConfig();
            ui.textareaPrompt.value = PROMPT_POOL[tabIdx];
            const tabs = ui.promptTabs.querySelectorAll('.ds-prompt-tab');
            tabs.forEach(t => { t.classList.toggle('active', parseInt(t.dataset.tab) === tabIdx); });
            log(`📝 切换到 Prompt 变体 #${tabIdx}`, 'info');
        }

        ui.promptTabs.addEventListener('click', (e) => {
            const tab = e.target.closest('.ds-prompt-tab');
            if (!tab) return;
            const idx = parseInt(tab.dataset.tab);
            if (!isNaN(idx) && idx >= 0 && idx < PROMPT_POOL.length) switchPromptTab(idx);
        });

        ui.checkboxAutoRotate.addEventListener('change', () => {
            STATE.config.autoRotateEnabled = ui.checkboxAutoRotate.checked;
            saveConfig();
            updateRotateIndex();
            log(`🔄 自动轮换: ${ui.checkboxAutoRotate.checked ? '开启' : '关闭'}`, 'info');
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
            PROMPT_POOL[tab] = getOriginalPrompt(tab);
            ui.textareaPrompt.value = PROMPT_POOL[tab];
            STATE.config.promptText = PROMPT_POOL[tab];
            saveConfig();
            log(`🔄 Prompt 变体 #${tab} 已恢复默认`, 'info');
        });

        // 开始/暂停/停止
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
            ui.btnPause.textContent = STATE.paused ? '▶ 继续' : '⏸ 暂停';
            log(STATE.paused ? '⏸ 已暂停' : '▶ 已恢复', 'warn');
        });
        ui.btnStop.addEventListener('click', () => {
            STATE.running = false;
            STATE.paused = false;
            clearResumeState();
            updateButtons();
            log('⏹ 已停止上传', 'warn');
        });
        ui.btnReset.addEventListener('click', () => {
            if (confirm('确定要清除所有上传记录吗？这将允许重新上传所有文件。')) {
                clearUploaded();
                selectedFiles.clear();
                updateStats();
                updateQueueList();
                log('🔄 已重置上传记录', 'warn');
            }
        });

        // 导出/导入日志
        ui.btnExportLog.addEventListener('click', () => {
            exportLogToFile();
            log('📜 日志已导出', 'success');
        });
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
                    log(`📥 读取日志: 恢复 ${result.restored} 条`, 'success');
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

        // 重试失败
        ui.btnRetryFailed.addEventListener('click', async () => {
            if (STATE.running) return;
            const records = getUploadRecords();
            const failedNames = records.filter(r => r.status === 'invalid' || r.status === 'no_response').map(r => r.name);
            if (failedNames.length === 0) { log('⚠️ 没有失败文件', 'warn'); return; }
            log(`🔁 开始重试 ${failedNames.length} 个失败文件`, 'info');
            persistLog(`重试失败文件: ${failedNames.length} 个`, 'info');
            for (const name of failedNames) removeUploaded(name);
            updateStats(); updateQueueList();
            const retryQueue = STATE.queue.filter(q => failedNames.includes(q.name));
            STATE.running = true; STATE.paused = false; updateButtons();
            for (let i = 0; i < retryQueue.length; i++) {
                while (STATE.paused && STATE.running) { await sleep(1000); }
                if (!STATE.running) break;
                log(`🔁 [${i+1}/${retryQueue.length}] 重试: ${retryQueue[i].name}`, 'info');
                await uploadOneFile(retryQueue[i]);
                if (i < retryQueue.length - 1 && STATE.running) {
                    const cfg = getConfig();
                    const wait = Math.max(30000, cfg.intervalMinutes * 60 * 1000 + (Math.random() - 0.5) * 60000);
                    const ws = Date.now();
                    while (Date.now() - ws < wait) {
                        while (STATE.paused && STATE.running) { await sleep(1000); }
                        if (!STATE.running) break;
                        await sleep(1000);
                    }
                }
            }
            STATE.running = false; STATE.paused = false;
            updateButtons(); updateStats(); updateQueueList(); updateRetryFailedButton();
            log('✅ 失败文件重试完成', 'success');
        });

        // 上传选中
        ui.btnUploadSelected.addEventListener('click', async () => {
            if (selectedFiles.size === 0) { log('⚠️ 未选中任何文件', 'warn'); return; }
            if (STATE.running) return;
            const selQueue = STATE.queue.filter(q => selectedFiles.has(q.name));
            log(`📌 开始上传 ${selQueue.length} 个选中文件`, 'info');
            for (const item of selQueue) removeUploaded(item.name);
            updateStats(); updateQueueList();
            STATE.running = true; STATE.paused = false; updateButtons();
            for (let i = 0; i < selQueue.length; i++) {
                while (STATE.paused && STATE.running) { await sleep(1000); }
                if (!STATE.running) break;
                log(`📌 [${i+1}/${selQueue.length}] ${selQueue[i].name}`, 'info');
                await uploadOneFile(selQueue[i]);
                if (i < selQueue.length - 1 && STATE.running) {
                    const cfg = getConfig();
                    const wait = Math.max(30000, cfg.intervalMinutes * 60 * 1000 + (Math.random() - 0.5) * 60000);
                    const ws = Date.now();
                    while (Date.now() - ws < wait) {
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

        // 按序号上传
        ui.btnUploadRange.addEventListener('click', async () => {
            const rangeText = ui.inputRange.value.trim();
            if (!rangeText) { log('⚠️ 请输入序号', 'warn'); return; }
            if (STATE.running) return;
            const indices = parseRange(rangeText, STATE.queue.length);
            if (indices.length === 0) { log('⚠️ 未解析到有效序号', 'warn'); return; }
            const rangeQueue = indices.map(idx => STATE.queue[idx]);
            log(`🎯 按序号上传 ${rangeQueue.length} 个文件`, 'info');
            persistLog(`按序号上传: ${rangeText} → ${rangeQueue.length} 个文件`, 'info');
            for (const item of rangeQueue) removeUploaded(item.name);
            updateStats(); updateQueueList();
            STATE.running = true; STATE.paused = false; updateButtons();
            for (let i = 0; i < rangeQueue.length; i++) {
                while (STATE.paused && STATE.running) { await sleep(1000); }
                if (!STATE.running) break;
                log(`🎯 [${i+1}/${rangeQueue.length}] #${indices[i]+1}: ${rangeQueue[i].name}`, 'info');
                await uploadOneFile(rangeQueue[i]);
                if (i < rangeQueue.length - 1 && STATE.running) {
                    const cfg = getConfig();
                    const wait = Math.max(30000, cfg.intervalMinutes * 60 * 1000 + (Math.random() - 0.5) * 60000);
                    const ws = Date.now();
                    while (Date.now() - ws < wait) {
                        while (STATE.paused && STATE.running) { await sleep(1000); }
                        if (!STATE.running) break;
                        await sleep(1000);
                    }
                }
            }
            STATE.running = false; STATE.paused = false;
            updateButtons(); updateStats(); updateQueueList();
            log('✅ 指定文件上传完成', 'success');
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
        return dt && dt.types && dt.types.includes('Files');
    }

    let dragState = null;
    function onPanelDragStart(e) {
        if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        if (!e.target.closest('#ds-header-drag')) return;
        dragState = {
            startX: e.clientX, startY: e.clientY,
            startLeft: STATE.ui.panel.offsetLeft,
            startTop: STATE.ui.panel.offsetTop
        };
        document.addEventListener('mousemove', onPanelDragMove);
        document.addEventListener('mouseup', onPanelDragEnd);
    }
    function onPanelDragMove(e) {
        if (!dragState) return;
        STATE.ui.panel.style.right = 'auto';
        STATE.ui.panel.style.top = Math.max(0, dragState.startTop + e.clientY - dragState.startY) + 'px';
        STATE.ui.panel.style.left = Math.max(0, dragState.startLeft + e.clientX - dragState.startX) + 'px';
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
            display.textContent = '未选择（也支持拖拽上传）';
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
        STATE.ui.currentFile.textContent = STATE.currentIndex >= 0 ? STATE.queue[STATE.currentIndex]?.name || '-' : '-';
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
            let cls = '', dot = '○';
            const isUploaded = uploaded.has(item.name);
            const rec = records.find(r => r.name === item.name);
            if (isUploaded) {
                if (rec && (rec.status === 'invalid' || rec.status === 'no_response')) { cls = 'invalid'; dot = '✗'; }
                else { cls = 'done'; dot = '●'; }
            }
            if (i === STATE.currentIndex && STATE.running) { cls = 'current'; dot = '▶'; }
            if (selectedFiles.has(item.name)) { cls = 'selected'; dot = '📌'; }
            return `<div class="ds-queue-item ${cls}" data-idx="${i}">
                <span class="ds-queue-dot">${dot}</span>
                <span style="color:#6a6a8a;min-width:28px;font-size:10px;">${i+1}.</span>
                <span>${escapeHtml(item.name)}</span>
            </div>`;
        }).join('');
        if (STATE.queue.length > 80) {
            list.innerHTML += `<div style="color:#6a6a8a;font-size:11px;padding:3px 6px;">...还有 ${STATE.queue.length - 80} 个</div>`;
        }
        list.querySelectorAll('.ds-queue-item').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.idx);
                const name = STATE.queue[idx].name;
                selectedFiles.has(name) ? selectedFiles.delete(name) : selectedFiles.add(name);
                updateQueueList();
                STATE.ui.btnUploadSelected.disabled = selectedFiles.size === 0;
                STATE.ui.btnUploadSelected.textContent = selectedFiles.size > 0
                    ? `📌 上传选中(${selectedFiles.size})` : '📌 上传选中';
            });
        });
        STATE.ui.btnUploadSelected.disabled = selectedFiles.size === 0;
        STATE.ui.btnUploadSelected.textContent = selectedFiles.size > 0
            ? `📌 上传选中(${selectedFiles.size})` : '📌 上传选中';
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
        STATE.ui.panel.classList.toggle('ds-collapsed');
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ==================== SSE fetch 拦截（DeepSeek 专用） ====================
    /**
     * DeepSeek 使用 SSE 流式返回回答。
     * 端点通常包含 "completion" 或 "chat" 关键字。
     * SSE 数据格式可能为 OpenAI 兼容格式:
     *   data: {"choices":[{"delta":{"content":"text"}}]}
     * 或 DeepSeek 自有格式。
     */
    function setupSSEInterceptor() {
        const origFetch = window.fetch;
        window.fetch = async function(input, init) {
            const response = await origFetch.call(window, input, init);
            const url = (typeof input === 'string') ? input : (input?.url || '');

            // DeepSeek 的流式端点匹配
            const isStreamEndpoint = url.includes('completion') ||
                                     url.includes('chat') ||
                                     url.includes('stream');

            if (!isStreamEndpoint) return response;

            const ct = (response.headers && response.headers.get)
                ? (response.headers.get('content-type') || '')
                : '';
            if (!ct.includes('text/event-stream') && !ct.includes('application/x-ndjson')) {
                return response;
            }

            STATE.sseText = '';
            STATE.sseDone = false;
            STATE.sseActive = true;
            log('🔌 SSE 拦截: 流式响应已捕获 (' + url.split('/').pop() + ')', 'info');

            try {
                const [reactStream, ourStream] = response.body.tee();
                (async () => {
                    const reader = ourStream.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';
                    let text = '';

                    try {
                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            const chunk = decoder.decode(value, { stream: true });
                            buffer += chunk;

                            // 按 SSE 事件边界分割
                            const parts = buffer.split('\n\n');
                            buffer = parts.pop();

                            for (const part of parts) {
                                const lines = part.split('\n');
                                for (const line of lines) {
                                    if (!line.startsWith('data:')) continue;
                                    const dataStr = line.substring(5).trim();
                                    if (!dataStr || dataStr === '[DONE]') {
                                        STATE.sseText = text;
                                        STATE.sseDone = true;
                                        STATE.sseActive = false;
                                        log(`🔌 SSE 完成: ${text.length} 字符`, 'success');
                                        continue;
                                    }
                                    try {
                                        const data = JSON.parse(dataStr);

                                        // OpenAI 兼容格式
                                        if (data.choices && data.choices[0]) {
                                            const delta = data.choices[0].delta;
                                            if (delta && delta.content) {
                                                text += delta.content;
                                            }
                                            // 检查 finish_reason
                                            if (data.choices[0].finish_reason) {
                                                STATE.sseText = text;
                                                STATE.sseDone = true;
                                                STATE.sseActive = false;
                                                log(`🔌 SSE 完成: ${text.length} 字符 (finish_reason=${data.choices[0].finish_reason})`, 'success');
                                            }
                                        }

                                        // DeepSeek 自有格式: message 字段直接包含内容
                                        if (data.message && data.message.content) {
                                            text += data.message.content;
                                        }

                                        // 通用: content 字段
                                        if (data.content && !data.choices) {
                                            text += data.content;
                                        }

                                        // 完成标记
                                        if (data.done || data.finished || data.status === 'completed') {
                                            STATE.sseText = text;
                                            STATE.sseDone = true;
                                            STATE.sseActive = false;
                                            log(`🔌 SSE 完成: ${text.length} 字符`, 'success');
                                        }
                                    } catch(e) {
                                        // 非 JSON 数据行（如注释），跳过
                                    }
                                }
                            }
                        }
                    } catch(e) {
                        log(`🔌 SSE 流读取异常: ${e.message}`, 'warn');
                        STATE.sseActive = false;
                    }
                    // 流结束时标记完成
                    if (!STATE.sseDone && text.length > 50) {
                        STATE.sseText = text;
                        STATE.sseDone = true;
                        STATE.sseActive = false;
                        log(`🔌 SSE 完成(流结束): ${text.length} 字符`, 'success');
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
        log('🔌 SSE fetch 拦截器已就绪 (DeepSeek 模式)', 'info');
    }

    // ==================== 初始化 ====================
    async function init() {
        loadPersistedLog();

        log('🐋 DeepSeek PDF 批量上传器 v1.1.0 已启动', 'info');

        createPanel();

        const config = getConfig();
        let configChanged = false;
        const defaults = {
            autoPrompt: true, autoSave: true,
            minWaitSeconds: DEFAULT_MIN_WAIT_SECONDS,
            stableThreshold: DEFAULT_STABLE_THRESHOLD,
            cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
            wakeupPrompt: DEFAULT_WAKEUP_PROMPT,
            uploadWaitSeconds: DEFAULT_UPLOAD_WAIT_SECONDS,
            promptDoneWaitSeconds: DEFAULT_PROMPT_DONE_WAIT_SECONDS,
            presendWaitSeconds: DEFAULT_PRESEND_WAIT_SECONDS,
            promptText: DEFAULT_PROMPT,
            savePath: '',
            useDeepSeekDeepThink: false,
        };
        for (const [key, val] of Object.entries(defaults)) {
            if (config[key] === undefined) { config[key] = val; configChanged = true; }
        }
        if (configChanged) { saveConfig(); log('🔧 配置已补全新字段', 'info'); }

        // 恢复 UI 值
        STATE.ui.inputInterval.value = config.intervalMinutes;
        STATE.ui.inputMinWait.value = config.minWaitSeconds;
        STATE.ui.inputStable.value = config.stableThreshold;
        STATE.ui.inputCooldown.value = config.cooldownMinutes;
        STATE.ui.inputUploadWait.value = config.uploadWaitSeconds;
        STATE.ui.inputPromptDoneWait.value = config.promptDoneWaitSeconds;
        STATE.ui.inputPresendWait.value = config.presendWaitSeconds;
        STATE.ui.inputScheduleStart.value = config.scheduleStart || '';
        STATE.ui.inputScheduleEnd.value = config.scheduleEnd || '';
        updateScheduleStatus(config);
        STATE.ui.inputWakeup.value = config.wakeupPrompt;
        STATE.ui.checkboxDeepThink.checked = config.useDeepSeekDeepThink === true;
        STATE.ui.checkboxAutoPrompt.checked = config.autoPrompt !== false;
        STATE.ui.checkboxAutoSave.checked = config.autoSave !== false;

        // Prompt 标签页
        const activeTab = config.activePromptTab || 0;
        STATE.ui.textareaPrompt.value = PROMPT_POOL[activeTab];
        STATE.ui.promptTabs.querySelectorAll('.ds-prompt-tab').forEach(t => {
            t.classList.toggle('active', parseInt(t.dataset.tab) === activeTab);
        });
        STATE.ui.checkboxAutoRotate.checked = config.autoRotateEnabled !== false;
        updateRotateIndex();

        updateFolderDisplay();

        STATE.lastSavedHash = '';
        STATE.processedHashes = [];
        STATE.baselineFingerprints = new Set();
        STATE.prompt_index = gmGet('prompt_index', 0);
        updateRotateIndex();
        log(`🔄 Prompt 轮换恢复: 下一个变体 #${STATE.prompt_index}`, 'info');

        setupSSEInterceptor();

        // 恢复持久化日志
        if (STATE.logBuffer.length > 0) {
            const recent = STATE.logBuffer.slice(-50);
            for (const e of recent) {
                const t = new Date(e.time).toTimeString().slice(0, 8);
                const d = new Date(e.time).toISOString().slice(0, 10);
                const icons = { info: 'ℹ️', success: '✅', warn: '⚠️', error: '❌' };
                const icon = icons[e.level] || 'ℹ️';
                const entry = document.createElement('div');
                entry.className = `ds-log-entry ds-log-${e.level}`;
                entry.textContent = `[${d} ${t}] ${icon} ${e.msg}`;
                STATE.ui.logContainer.appendChild(entry);
            }
            STATE.ui.logContainer.scrollTop = STATE.ui.logContainer.scrollHeight;
        }

        // 恢复文件夹句柄
        const handle = await loadDirHandle();
        if (handle) {
            STATE.dirHandle = handle;
            STATE.config.folderDisplayName = handle.name;
            STATE.ui.folderDisplay.textContent = '📂 ' + handle.name;
            STATE.ui.folderDisplay.classList.add('active');
            STATE.ui.btnRefresh.disabled = false;
            saveConfig();
            log('📂 已恢复文件夹: ' + handle.name, 'success');
            await buildQueueFromDir();
            STATE.ui.btnStart.disabled = STATE.queue.length === 0;
        } else {
            log('📌 请选择 PDF 文件夹或拖拽 PDF 到页面', 'info');
        }

        STATE.totalUploaded = getUploadedSet().size;
        updateStats();
        updateQueueList();
        updateButtons();
        updateRetryFailedButton();

        if (STATE.totalUploaded > 0) {
            log(`📊 发现 ${STATE.totalUploaded} 条历史上传记录（断点续传就绪）`, 'info');
        }
        // v1.1.0: 断点自动恢复 — 上次运行被页面跳转/刷新中断时自动续传
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
        log('💡 提示: 如果上传按钮未自动找到，请手动点击 DeepSeek 的附件按钮一次', 'info');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
