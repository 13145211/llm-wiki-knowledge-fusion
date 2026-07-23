// ==UserScript==
// @name         千问 PDF 批量上传器 Pro
// @namespace    https://github.com/qclaw/qianwen-pdf-uploader
// @version      4.2.0
// @description  v4.2.0: 修复Prompt泄漏|动态特征匹配|结构排除|断点恢复
// @author       QClaw
// @match        https://www.qianwen.com/*
// @match        https://qianwen.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        GM_listValues
// @grant        GM_setClipboard
// @grant        GM_download
// @run-at       document-start
// ==/UserScript==

(function() {
  'use strict';

  // ==================== 常量 ====================
  var STORE_PREFIX = 'qwpdf_';
  var PANEL_ID = 'qw-uploader-panel';
  var DROP_OVERLAY_ID = 'qw-drop-overlay';

  var DEFAULT_CONFIG = {
    folderDisplayName: '',
    intervalMinutes: 10,
    fileParseWaitSeconds: 10,
    sendDelaySeconds: 2,
    responseTimeoutMinutes: 25,
    responseStableSeconds: 10,
    responseMinWaitSeconds: 20,
    autoClearAfterComplete: false,
    autoPrompt: true,
    promptText: '',
    autoSave: true,
    cooldownMinutes: 120,
    wakeupPrompt: 'hello',
    uploadWaitSeconds: 5,
    promptDoneWaitSeconds: 2,
    presendWaitSeconds: 3,
    activePromptTab: 0,
    autoRotateEnabled: true,
    scheduleStart: '',
    scheduleEnd: ''
  };

  var STATE = {
    running: false, paused: false, queue: [], currentIndex: -1,
    totalUploaded: 0, dirHandle: null, config: null, ui: {},
    consecutiveFailures: 0,
    logBuffer: [], logLoaded: false,
    lastSavedHash: '', processedHashes: [], baselineFingerprints: new Set(),
    prompt_index: 0,
    lastSentPrompt: ''  // ★ v4.2.0: 记录本次发送的 prompt 文本
  };

  // 网络拦截器状态
  var NET = {
    collecting: false,
    collectedText: '',
    lastActivity: 0,
    targetReqId: '',
    reqStartTime: 0
  };

  var selectedFiles = {};

  // ==================== GM 存储 ====================
  function gmGet(key, fallback) {
    var val = GM_getValue(STORE_PREFIX + key, null);
    if (val === null || val === undefined) return fallback;
    try { return JSON.parse(val); } catch(e) { return val; }
  }
  function gmSet(key, value) { GM_setValue(STORE_PREFIX + key, JSON.stringify(value)); }

  var DEFAULT_PROMPT =
'## 角色设定\n'+
'你是专业严谨的科研助理，逻辑缜密、学术规范，严格依据论文**正文文字+所有实验图表**，撰写标准化7段式文献精读笔记，全程客观中立、有据可依。\n\n'+
'## 严格执行准则\n'+
'1. 所有内容**完全来源于原文图文**，绝不编造、杜撰任何数据与结论\n'+
'2. 文字描述与图表数据冲突时，**以文本为准**，并注明图文数据存在不一致\n'+
'3. 主观推导、延伸分析统一标注**合理推断**，文献未提及内容标注**原文未说明**\n'+
'4. 所有关键参数、数值均标注来源：Fig.XX / Table.XX\n'+
'5. 所有附图、附表均**系统性深度识别解读**，不遗漏结构、趋势、差异、对比规律，不局限单一材料图谱参数\n\n'+
'---\n'+
'### 1. 文献基本信息\n'+
'论文标题、第一作者、通讯作者、发表期刊、发表年份、DOI编号、文章核心关键词\n\n'+
'### 2. 研究背景与科学问题\n'+
'1. 该领域现阶段普遍存在的技术瓶颈、行业痛点与待解决科学难题\n'+
'2. 现有研究方案、材料、工艺、方法存在的短板与局限性\n'+
'3. 本文研究目的、核心待解决问题、验证假设与整体研究目标\n\n'+
'### 3. 实验方法与技术路线\n'+
'1. 样品制备、试验流程、分组对照、工艺条件、操作步骤与后处理方式\n'+
'2. 全部表征检测手段、测试仪器、实验工况与相关测试参数\n'+
'3. 数据分析、模型计算、机理推导、动力学与统计学处理方法\n\n'+
'### 4. 结果规律与图表全面解读\n'+
'按核心发现逐条撰写：结论规律 + 具体量化数值 + 图表出处\n'+
'**通用图表识别体系（全学科通用）**\n'+
'- 物相/光谱类图谱：识别特征峰位置、峰形强弱、峰偏移、物相组成、结构变化规律\n'+
'- 形貌显微图片：分析颗粒尺寸、形貌特征、分散状态、界面结构、微观形貌差异\n'+
'- 性能趋势曲线：读取关键节点数值、变化趋势、最优区间、稳定性、组间对比差异\n'+
'- 数据对比表格：逐一核对正文引用数据与表格原始数值是否吻合一致\n\n'+
'### 5. 研究创新点与学术价值\n'+
'基于摘要、结论客观总结，统一用词：作者探明……、作者验证……、作者得出……\n'+
'不擅自使用首次、突破性、开创性等绝对化夸张词汇，仅原文原话可引用\n\n'+
'### 6. 研究局限与未来展望\n'+
'1. 作者原文自述的研究不足、试验条件限制、体系适用范围短板\n'+
'2. 实验设计、数据完整性、机理深度等潜在问题，统一标注**合理推断**\n'+
'3. 作者规划后续研究方向、优化思路与拓展应用前景\n\n'+
'### 7. 全文高度摘要\n'+
'字数≤300字，完整概括研究背景、实验思路、核心规律、关键数据与最终研究结论';

  // ==================== 配置 ====================

  // PROMPT_POOL and rotation
  var PROMPT_POOL = [DEFAULT_PROMPT];
  var PROMPT_POOL_ORIG = [DEFAULT_PROMPT];
  function getOriginalPrompt(idx) { return PROMPT_POOL_ORIG[idx] || DEFAULT_PROMPT; }
  function getRotatedPrompt() {
    var cfg = getConfig();
    if (!cfg.autoRotateEnabled) return cfg.promptText || DEFAULT_PROMPT;
    var idx = STATE.prompt_index !== undefined ? STATE.prompt_index : 0;
    STATE.prompt_index = (idx + 1) % PROMPT_POOL.length;
    gmSet("prompt_index", STATE.prompt_index);
    return PROMPT_POOL[idx % PROMPT_POOL.length];
  }
  function updateRotateIndex() {
    if (!STATE.ui || !STATE.ui.rotateIndex) return;
    var cfg = getConfig();
    STATE.ui.rotateIndex.textContent = cfg.autoRotateEnabled !== false ? "next#" + STATE.prompt_index : "fixed";
  }

  function getConfig() {
    if (STATE.config) return STATE.config;
    var saved = gmGet('config', {});
    STATE.config = Object.assign({}, DEFAULT_CONFIG, saved);
    if (!STATE.config.promptText) STATE.config.promptText = DEFAULT_PROMPT;
    return STATE.config;
  }
  function saveConfig() { gmSet('config', STATE.config); }
  function getUploadedSet() { return new Set(gmGet('uploaded', [])); }
  function addUploaded(filename, status) {
    var records = gmGet('uploadRecords', []);
    var ei = records.findIndex(function(r){return r.name===filename;});
    var rec = {name:filename, status:status||'success', timestamp:new Date().toISOString(), attempts: ei>=0?(records[ei].attempts||0)+1:1};
    if(ei>=0) records[ei]=rec; else records.push(rec);
    gmSet('uploadRecords', records);
    var s=getUploadedSet(); s.add(filename); gmSet('uploaded', Array.from(s)); STATE.totalUploaded=s.size;
  }
  function clearUploaded() { gmSet('uploaded',[]); gmSet('uploadRecords',[]); STATE.totalUploaded=0; }
  function removeUploaded(filename) {
    var s=getUploadedSet(); s.delete(filename); gmSet('uploaded',Array.from(s));
    gmSet('uploadRecords',gmGet('uploadRecords',[]).filter(function(r){return r.name!==filename;}));
    STATE.totalUploaded=s.size;
  }
  function getUploadRecords(){return gmGet('uploadRecords',[]);}

  // ==================== 断点自动恢复（v4.1.0） ====================
  var RESUME_MAX_AGE_MS = 30*60*1000;
  function setResumeState(reason){ gmSet('resumeState', {active:true, savedAt:Date.now(), reason:reason||''}); }
  function clearResumeState(){ gmSet('resumeState', null); }
  function getResumeState(){
    var st = gmGet('resumeState', null);
    if(!st || !st.active) return null;
    if(Date.now()-(st.savedAt||0) > RESUME_MAX_AGE_MS) return null;
    return st;
  }
  function updateRetryFailedButton(){
    if(!STATE.ui.btnRetryFailed)return;
    var cnt=gmGet('uploadRecords',[]).filter(function(r){return r.status==='invalid'||r.status==='no_response';}).length;
    STATE.ui.btnRetryFailed.disabled=cnt===0;
    STATE.ui.btnRetryFailed.textContent='retry('+cnt+')';
  }
  // Persistence
  function persistLog(msg,lvl){
    STATE.logBuffer.push({time:new Date().toISOString(),level:lvl||'info',msg:msg});
    if(STATE.logBuffer.length>500)STATE.logBuffer.shift();
    gmSet('logBuffer',STATE.logBuffer);
  }
  function loadPersistedLog(){if(!STATE.logLoaded){STATE.logBuffer=gmGet('logBuffer',[]);STATE.logLoaded=true;}}
  function exportLogToFile(){
    var recs=getUploadRecords(),lines=[];
    lines.push('===== qianwen upload report =====','Time: '+new Date().toLocaleString(),'Queue: '+STATE.queue.length,'Done: '+getUploadedSet().size,'');
    for(var i=0;i<STATE.queue.length;i++){
      var item=STATE.queue[i],done=getUploadedSet().has(item.name),rec=recs.find(function(r){return r.name===item.name;});
      var st=done?(rec&&rec.status==='invalid'?'INVALID':(rec&&rec.status==='no_response'?'NOREPLY':'OK')):'PENDING';
      lines.push(st+' '+item.name+(rec?' ('+new Date(rec.timestamp).toLocaleString()+')':''));
    }
    lines.push('','-- LOGS --');
    var rl=STATE.logBuffer.slice(-200);
    for(var j=0;j<rl.length;j++){var e=rl[j];lines.push('['+e.time.slice(0,19)+'] '+e.level.toUpperCase()+' '+e.msg);}
    var blob=new Blob([lines.join('\n')],{type:'text/plain;charset=utf-8'});
    var url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='qw-log-'+new Date().toISOString().slice(0,10)+'.txt';a.style.display='none';
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }
  function parseLogAndRestore(txt){
    var lines=txt.split('\n'),records=[];
    for(var i=0;i<lines.length;i++){
      var m=lines[i].match(/^(OK|INVALID|NOREPLY)\s+(.+)$/);
      if(m){var st=m[1]==='OK'?'success':(m[1]==='INVALID'?'invalid':'no_response');records.push({name:m[2].trim(),status:st,timestamp:new Date().toISOString(),attempts:1});}
    }
    var existing=gmGet('uploadRecords',[]);
    for(var j=0;j<records.length;j++){var ri=existing.findIndex(function(r){return r.name===records[j].name;});if(ri>=0)existing[ri]=records[j];else existing.push(records[j]);}
    gmSet('uploadRecords',existing);
    var us=gmGet('uploaded',[]);for(var k=0;k<records.length;k++){if(us.indexOf(records[k].name)<0)us.push(records[k].name);}
    gmSet('uploaded',us);STATE.totalUploaded=us.length;
    return records.length;
  }
  function parseRange(str,maxLen){
    var result=[],parts=str.split(',');
    for(var i=0;i<parts.length;i++){
      var t=parts[i].trim(),rm=t.match(/^(\d+)\s*-\s*(\d+)$/);
      if(rm){for(var n=Math.max(1,parseInt(rm[1]));n<=Math.min(maxLen,parseInt(rm[2]));n++)result.push(n-1);}
      else{var num=parseInt(t);if(!isNaN(num)&&num>=1&&num<=maxLen)result.push(num-1);}
    }
    var seen={};return result.filter(function(x){if(seen[x])return false;seen[x]=true;return true;});
  }

  // ==================== 工具函数 ====================
  function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
  function inside(el) { return !!(el && el.closest && (el.closest('#'+PANEL_ID) || el.closest('#'+DROP_OVERLAY_ID))); }
  function visible(el) {
    if (!el || el.offsetParent === null) return false;
    var s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function nativeClick(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width/2, cy = r.top + r.height/2;
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t) {
      el.dispatchEvent(new MouseEvent(t, { bubbles:true, cancelable:true, clientX:cx, clientY:cy }));
    });
    return true;
  }

  // ==================== ★ v4.2.0 Prompt 泄漏防御层 ====================

  /**
   * 动态提取 prompt 的特征短语
   * 不再硬编码 prompt 内容，而是从当前使用的 prompt 中自动提取独特短语
   */
  function extractPromptFeatures(promptText) {
    if (!promptText) return [];
    var features = [];
    // 提取 ## 标题行
    var headingMatches = promptText.match(/#{1,4}\s+[^\n]{2,50}/g);
    if (headingMatches) {
      for (var i = 0; i < headingMatches.length && features.length < 15; i++) {
        features.push(headingMatches[i].trim());
      }
    }
    // 提取带编号的独特短语
    var lines = promptText.split('\n');
    for (var j = 0; j < lines.length && features.length < 30; j++) {
      var line = lines[j].trim();
      // 跳过太短或太长的行
      if (line.length < 6 || line.length > 80) continue;
      // 跳过纯标点/数字
      if (/^[\d\.\-\*\#\s]+$/.test(line)) continue;
      // 提取包含关键词的行
      if (/(角色|设定|准则|严格执行|绝不|编造|杜撰|冲突|以.*为准|注明|标注|来源|Fig|Table|系统性|深度|识别|解读|不遗漏|不局限|客观|中立|有据|探明|验证|得出|首次|突破|开创|绝对|夸张|原文|原话|引用|合理推断|原文未说明|潜在|规划|后续|优化|拓展|前景|高度摘要|概括)/.test(line)) {
        features.push(line.substring(0, 60));
      }
    }
    // 提取独特的关键词组合（从 prompt 中找连续的中英文短语）
    var phrases = promptText.match(/[\u4e00-\u9fa5]{2,15}/g);
    if (phrases) {
      var seen = {};
      for (var k = 0; k < phrases.length && features.length < 40; k++) {
        if (phrases[k].length >= 4 && !seen[phrases[k]]) {
          seen[phrases[k]] = true;
          features.push(phrases[k]);
        }
      }
    }
    return features;
  }

  /**
   * v4.2.0: 动态 isPrompt — 基于当前 prompt 的特征匹配
   * 不再硬编码，而是用 extractPromptFeatures 提取的特征做比对
   */
  function isPrompt(text) {
    if (!text || text.length < 30) return false;
    var promptText = STATE.lastSentPrompt || getConfig().promptText || DEFAULT_PROMPT;
    var features = extractPromptFeatures(promptText);
    if (features.length === 0) return false;
    var hits = 0;
    for (var i = 0; i < features.length; i++) {
      if (text.indexOf(features[i]) >= 0) hits++;
      // 命中3个特征，或命中特征占比>30%时判定为 prompt
      if (hits >= 3) return true;
    }
    if (features.length > 0 && hits / features.length > 0.3) return true;
    return false;
  }

  /**
   * v4.2.0: 检查 DOM 元素是否属于用户消息气泡
   * 通过4层祖先的 class/data-attribute 判断
   */
  function isUserMessage(el) {
    if (!el) return false;
    var node = el;
    for (var depth = 0; depth < 5 && node; depth++) {
      var cls = (node.className || '').toString().toLowerCase();
      // 千问用户消息气泡的特征 class
      var userPatterns = ['user', 'right', 'mine', 'self', 'human', 'question', 'query',
                          'sender-user', 'from-user', 'is-user', 'msg-user', 'chat-user'];
      for (var i = 0; i < userPatterns.length; i++) {
        if (cls.indexOf(userPatterns[i]) >= 0) return true;
      }
      // data 属性
      if (node.getAttribute) {
        var role = node.getAttribute('data-role') || node.getAttribute('data-sender') ||
                   node.getAttribute('data-from');
        if (role && role.toLowerCase() === 'user') return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  /**
   * v4.2.0: 检查文本是否与本次发送的 prompt 高度相似
   * 三向探测 + 子串检查 + 共享短语检查
   */
  function isTextSimilarToPrompt(text, prompt) {
    if (!text || !prompt) return false;
    var tl = text.toLowerCase(), pl = prompt.toLowerCase();

    // 检查1: text 包含 prompt 的大段内容（三向探测）
    if (pl.length > 200) {
      if (tl.indexOf(pl.substring(0, 200)) >= 0) return true;
      var mid = Math.floor(pl.length / 2);
      if (tl.indexOf(pl.substring(mid, mid + 200)) >= 0) return true;
      if (tl.indexOf(pl.substring(pl.length - 200)) >= 0) return true;
    }

    // 检查2: text 是 prompt 的子串（或反过来）
    if (tl.length < pl.length * 1.5 && tl.length > 80) {
      if (pl.indexOf(tl.substring(0, 120)) >= 0) return true;
    }
    if (pl.length < tl.length * 1.5 && pl.length > 80) {
      if (tl.indexOf(pl.substring(0, 120)) >= 0) return true;
    }

    // 检查3: 共享独特短语数量
    var features = extractPromptFeatures(prompt);
    if (features.length > 0) {
      var shared = 0;
      for (var i = 0; i < features.length; i++) {
        if (tl.indexOf(features[i].toLowerCase()) >= 0) shared++;
      }
      // 共享特征占比>40% 或绝对数量>5
      if (shared / features.length > 0.4) return true;
      if (shared > 5) return true;
    }

    return false;
  }

  // ==================== ★ 网络拦截层 ====================

  var _origFetch = window.fetch;

  window.fetch = function(url, opts) {
    var urlStr = (typeof url === 'string') ? url : (url.url || '');
    var fetchPromise = _origFetch.call(this, url, opts);

    if (NET.collecting && opts && opts.method === 'POST') {
      log('🔍 [调试] POST: ' + urlStr.substring(0, 120), 'info');

      var matchesChat = false;

      var skipPatterns = ['track.uc.cn', 'analytics', 'telemetry', 'beacon',
        'collect', 'log', 'metric', 'aplus', 'cnzz', 'pageview',
        '.png', '.jpg', '.gif', '.svg', '.woff', 'abtest',
        'fingerprint', 'rum', 'perf', 'trace',
      ];
      for (var si = 0; si < skipPatterns.length; si++) {
        if (urlStr.indexOf(skipPatterns[si]) !== -1) break;
      }
      if (si >= skipPatterns.length) {
        var chatKw = ['chat', 'completion', 'qwen', 'assistant', 'send',
          'generate', 'conversation', 'message', '/api/', '/v1/', '/v2/',
          'tongyi', 'dashscope', 'aliyun',
        ];
        for (var ck = 0; ck < chatKw.length; ck++) {
          if (urlStr.indexOf(chatKw[ck]) !== -1) { matchesChat = true; break; }
        }
        if (!matchesChat && opts.body && typeof opts.body === 'string' && opts.body.length > 200) {
          matchesChat = true;
        }
      }

      if (matchesChat) {
        var reqId = Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        NET.targetReqId = reqId;
        NET.reqStartTime = Date.now();
        NET.lastActivity = Date.now();
        log('🌐 ★ 拦截聊天API: ' + urlStr.substring(0, 80), 'success');

        fetchPromise.then(function(resp) {
          if (!NET.collecting || NET.targetReqId !== reqId) return;
          var ct = resp.headers.get('content-type') || '';
          log('🔍 [调试] Content-Type: ' + ct.substring(0, 60), 'info');
          var cloned = resp.clone();

          if (ct.indexOf('text/event-stream') !== -1) {
            log('🌐 SSE流, 解析中...', 'info');
            cloned.text().then(function(body) {
              if (!NET.collecting || NET.targetReqId !== reqId) return;
              var parsed = parseSSE(body);
              if (parsed.length > NET.collectedText.length) {
                NET.collectedText = parsed;
                NET.lastActivity = Date.now();
                log('🌐 SSE解析成功: ' + parsed.length + '字符', 'success');
              } else {
                log('⚠️ SSE解析为空('+(parsed.length)+'字符)', 'warn');
              }
            }).catch(function(e) { log('⚠️ SSE读取出错: '+e.message, 'warn'); });
          } else if (ct.indexOf('application/json') !== -1) {
            log('🌐 JSON响应, 解析中...', 'info');
            cloned.text().then(function(body) {
              if (!NET.collecting || NET.targetReqId !== reqId) return;
              var text = extractTextFromJSON(body);
              if (text.length > NET.collectedText.length) {
                NET.collectedText = text;
                NET.lastActivity = Date.now();
                log('🌐 JSON解析成功: ' + text.length + '字符', 'success');
              } else {
                log('⚠️ JSON解析为空('+(text.length)+'字符)', 'warn');
              }
            }).catch(function(e) { log('⚠️ JSON读取出错: '+e.message, 'warn'); });
          } else {
            log('🌐 其他类型('+ct.substring(0,40)+')...', 'info');
            cloned.text().then(function(body) {
              if (!NET.collecting || NET.targetReqId !== reqId) return;
              var text = extractTextFromBody(body);
              if (text.length > 50 && text.length > NET.collectedText.length) {
                NET.collectedText = text;
                NET.lastActivity = Date.now();
                log('🌐 文本提取成功: ' + text.length + '字符', 'success');
              }
            }).catch(function(e) { log('⚠️ 读取出错: '+e.message, 'warn'); });
          }
        }).catch(function(e) { log('⚠️ fetch错误: '+e.message, 'warn'); });
      }
    }

    return fetchPromise;
  };

  function parseSSE(body) {
    if (!body) return '';
    var lines = body.split('\n');
    var text = '';
    var reasoning = '';

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('data:') === 0) {
        var dataStr = line.substring(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        try {
          var data = JSON.parse(dataStr);
          if (data.choices && data.choices[0]) {
            var choice = data.choices[0];
            if (choice.delta && choice.delta.content) text += choice.delta.content;
            else if (choice.message && choice.message.content) text += choice.message.content;
            else if (choice.text) text += choice.text;
            if (choice.delta && choice.delta.reasoning_content) reasoning += choice.delta.reasoning_content;
          }
          if (data.output && data.output.text) text += data.output.text;
          if (data.text && typeof data.text === 'string') text += data.text;
          if (data.content && typeof data.content === 'string') text += data.content;
          if (data.msg && typeof data.msg === 'string') text += data.msg;
          if (data.message && typeof data.message === 'string') text += data.message;
          if (data.CHUNK_DELTA || data.text_block) {
            if (data.text) text += data.text;
          }
        } catch(e) {}
      }
      if (line && line.charAt(0) === '{') {
        try {
          var d = JSON.parse(line);
          if (d.choices && d.choices[0]) {
            var c = d.choices[0];
            if (c.delta && c.delta.content) text += c.delta.content;
            else if (c.message && c.message.content) text += c.message.content;
            else if (c.text) text += c.text;
          }
          if (d.text && typeof d.text === 'string') text += d.text;
          if (d.content && typeof d.content === 'string') text += d.content;
        } catch(e) {}
      }
    }
    return text.length > 0 ? text : reasoning;
  }

  function extractTextFromJSON(body) {
    if (!body) return '';
    try {
      var data = JSON.parse(body);
      if (data.choices && data.choices[0]) {
        var c = data.choices[0];
        if (c.message && c.message.content) return c.message.content;
        if (c.text) return c.text;
      }
      if (data.output && data.output.text) return data.output.text;
      if (data.text) return data.text;
      if (data.content) return data.content;
      if (data.data && data.data.text) return data.data.text;
      return findLongestString(data);
    } catch(e) { return ''; }
  }

  function extractTextFromBody(body) {
    if (!body || body.length < 50) return '';
    if (body.charAt(0) === '{') {
      var t = extractTextFromJSON(body);
      if (t.length > 50) return t;
    }
    return body.trim();
  }

  function findLongestString(obj, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 10 || !obj) return '';
    if (typeof obj === 'string') return obj;
    var best = '';
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        var s = findLongestString(obj[i], depth + 1);
        if (s.length > best.length) best = s;
      }
    } else if (typeof obj === 'object') {
      var keys = Object.keys(obj);
      for (var j = 0; j < keys.length; j++) {
        var s2 = findLongestString(obj[keys[j]], depth + 1);
        if (s2.length > best.length) best = s2;
      }
    }
    return best;
  }

  function startCollecting() {
    NET.collecting = true;
    NET.collectedText = '';
    NET.targetReqId = '';
    NET.reqStartTime = Date.now();
    NET.lastActivity = Date.now();
  }

  function stopCollecting() {
    NET.collecting = false;
    var text = NET.collectedText;
    NET.collectedText = '';
    NET.targetReqId = '';
    return text;
  }

  // ==================== 千问 DOM 查找 ====================

  function findInputBox() {
    var el = document.querySelector('[role="textbox"]');
    if (el && !inside(el)) return el;
    var eds = document.querySelectorAll('[contenteditable="true"]');
    for (var i = 0; i < eds.length; i++) {
      if (!inside(eds[i]) && visible(eds[i])) return eds[i];
    }
    var tas = document.querySelectorAll('textarea');
    for (var j = 0; j < tas.length; j++) {
      if (!inside(tas[j]) && visible(tas[j])) return tas[j];
    }
    return null;
  }

  function findAttachButton() {
    var btn = document.querySelector('button[aria-label="添加附件"]');
    if (btn && !inside(btn) && visible(btn)) return btn;
    var btns = document.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < btns.length; i++) {
      if (inside(btns[i]) || !visible(btns[i])) continue;
      var t = (btns[i].textContent||'') + (btns[i].getAttribute('aria-label')||'');
      if (t.indexOf('添加附件')>=0 || t.indexOf('上传文件')>=0 || t.indexOf('文件上传')>=0) return btns[i];
    }
    return null;
  }

  function findSendButton() {
    var uses = document.querySelectorAll('use');
    for (var i = 0; i < uses.length; i++) {
      var href = uses[i].getAttribute('href') ||
                 uses[i].getAttribute('xlink:href') ||
                 uses[i].getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
      if (href.indexOf('sendChat')>=0 || href.indexOf('send')>=0) {
        var btn = uses[i].closest('button');
        if (btn && btn.offsetParent && !inside(btn)) return btn;
      }
    }
    var found = null;
    ['发送消息','发送','send'].forEach(function(l) {
      if (found) return;
      var b = document.querySelector('[aria-label="'+l+'"]');
      if (b && !inside(b) && visible(b)) found = b;
    });
    if (found) return found;
    var ib = findInputBox();
    if (ib) {
      var c = ib.closest('form, [class*="input"], [class*="composer"], [class*="bottom"]');
      if (c) {
        var all = c.querySelectorAll('button');
        for (var j = all.length-1; j >= 0; j--) {
          if (visible(all[j]) && !isDanger(all[j])) return all[j];
        }
      }
    }
    return null;
  }

  function isDanger(el) {
    var t = ((el.textContent||'')+' '+(el.getAttribute('aria-label')||'')).toLowerCase();
    return ['朗读','语音','voice','播放','play','截图','screenshot','分享','share',
            '设置','settings','stop','停止','暂停','pause','取消','cancel'].some(function(w){return t.indexOf(w)>=0;});
  }

  function findFileInput() {
    var inputs = document.querySelectorAll('input[type="file"]');
    for (var i = 0; i < inputs.length; i++) {
      if (!inside(inputs[i])) return inputs[i];
    }
    return null;
  }

  function setFileToInput(input, file) {
    var dt = new DataTransfer();
    dt.items.add(file);
    try { input.files = dt.files; }
    catch(e) {
      try { Object.defineProperty(input, 'files', { value: dt.files, writable: false }); }
      catch(e2) { log('❌ 设置 files 失败: '+e2.message, 'error'); return false; }
    }
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    log('✅ 文件已设置, files.length='+input.files.length, 'info');
    return input.files.length > 0;
  }

  var _pwPendingFile = null;
  var _pwInjected = false;
  var _pwInjectionDone = null;

  var _origSOFP = null;

  function patchFileInputHooks(fileObj) {
    _pwPendingFile = fileObj;
    _pwInjected = false;
    _pwInjectionDone = null;

    if (!_origSOFP && window.showOpenFilePicker) {
      _origSOFP = window.showOpenFilePicker;
    }
    if (window.showOpenFilePicker) {
      window.showOpenFilePicker = function(opts) {
        if (_pwPendingFile && !_pwInjected) {
          _pwInjected = true;
          var f = _pwPendingFile;
          log('🎯 拦截 showOpenFilePicker, 阻止原生对话框', 'info');
          return new Promise(function(resolve) {
            setTimeout(function() {
              var inp = findFileInput();
              if (inp) {
                setFileToInput(inp, f);
                _pwPendingFile = null;
              }
              resolve([{ name: f.name, kind: 'file', getFile: function() { return Promise.resolve(f); } }]);
            }, 200);
          });
        }
        if (_origSOFP) return _origSOFP.call(window, opts);
        return Promise.reject(new Error('AbortError'));
      };
    }
  }

  function unpatchFileInputHooks() {
    _pwPendingFile = null;
    _pwInjected = false;
  }

  // ==================== 输入 Prompt ====================
  async function typePromptIntoChat(text) {
    var ed = findInputBox();
    if (!ed) { log('⚠️ 未找到输入框', 'warn'); return false; }
    ed.focus(); await sleep(300);
    try { if (typeof GM_setClipboard !== 'undefined') GM_setClipboard(text); } catch(e) {}

    // 方式1: paste
    try {
      var sel = window.getSelection(); sel.removeAllRanges();
      var rg = document.createRange(); rg.selectNodeContents(ed); sel.addRange(rg);
      document.execCommand('delete', false); await sleep(100);
      var pe = new ClipboardEvent('paste', { bubbles:true, composed:true, cancelable:true });
      var dt = new DataTransfer(); dt.setData('text/plain', text);
      Object.defineProperty(pe, 'clipboardData', { get: function(){return dt;} });
      ed.dispatchEvent(pe); await sleep(300);
      var tc = (ed.textContent||ed.value||'').trim();
      if (tc.length > 20) { log('✅ Prompt已输入 (paste, '+tc.length+'字符)', 'info'); return true; }
    } catch(e) {}

    // 方式2: 赋值
    try {
      ed.focus();
      if (ed.contentEditable==='true') ed.textContent = text; else ed.value = text;
      ed.dispatchEvent(new InputEvent('input', { bubbles:true, composed:true, inputType:'insertText' }));
      await sleep(200);
      var tc2 = (ed.textContent||ed.value||'').trim();
      if (tc2.length > 20) { log('✅ Prompt已输入 (赋值, '+tc2.length+'字符)', 'info'); return true; }
    } catch(e) {}

    // 方式3: execCommand
    try {
      ed.focus(); document.execCommand('selectAll', false); document.execCommand('delete', false);
      var lines = text.split('\n');
      for (var i=0; i<lines.length; i++) {
        if (i>0) document.execCommand('insertLineBreak', false);
        if (lines[i].length>0) document.execCommand('insertText', false, lines[i]);
      }
      ed.dispatchEvent(new InputEvent('input', { bubbles:true, composed:true, inputType:'insertText' }));
      await sleep(300);
      var tc3 = (ed.textContent||ed.value||'').trim();
      if (tc3.length >= 20) { log('✅ Prompt已输入 (execCommand, '+tc3.length+'字符)', 'info'); return true; }
    } catch(e) {}

    log('❌ 所有输入方式失败', 'error'); return false;
  }

  // ==================== 发送 ====================
  function clickSendButton() {
    var ed = findInputBox();
    if (ed) {
      ed.focus();
      ed.dispatchEvent(new KeyboardEvent('keydown', {
        key:'Enter', code:'Enter', keyCode:13, which:13,
        bubbles:true, composed:true, cancelable:true
      }));
      log('📨 发送(Enter)', 'info'); return true;
    }
    var btn = findSendButton();
    if (btn) { nativeClick(btn); log('📨 发送(按钮)', 'info'); return true; }
    log('⚠️ 未能发送', 'warn'); return false;
  }

  // ==================== ★ v4.2.0 回答等待（Prompt 泄漏防御） ====================

  function countMessageBubbles() {
    var rounds = document.querySelectorAll(
      '[class*="chat-round"], [class*="ChatRound"], ' +
      '[class*="message-item"], [class*="MessageItem"], ' +
      '[class*="conversation-turn"], [class*="ConversationTurn"]'
    );
    var mdBlocks = document.querySelectorAll(
      '.qk-markdown, .qk-markdown-react, [class*="markdown-content"]'
    );
    return {
      rounds: rounds.length,
      markdowns: mdBlocks.length,
      lastRound: rounds.length > 0 ? rounds[rounds.length-1] : null
    };
  }

  function getNewAnswerText(snapshot) {
    var rounds = document.querySelectorAll(
      '[class*="chat-round"], [class*="ChatRound"], ' +
      '[class*="message-item"], [class*="MessageItem"], ' +
      '[class*="conversation-turn"], [class*="ConversationTurn"]'
    );

    var newRounds = [];
    if (rounds.length > snapshot.rounds && snapshot.lastRound) {
      var startIdx = -1;
      for (var i = 0; i < rounds.length; i++) {
        if (rounds[i] === snapshot.lastRound) { startIdx = i+1; break; }
      }
      if (startIdx < 0) startIdx = snapshot.rounds;
      for (var j = startIdx; j < rounds.length; j++) {
        if (!inside(rounds[j])) newRounds.push(rounds[j]);
      }
    }

    var best = '';
    for (var k = 0; k < newRounds.length; k++) {
      // ★ v4.2.0: 跳过用户消息气泡
      if (isUserMessage(newRounds[k])) continue;
      var md = newRounds[k].querySelector('.qk-markdown, .qk-markdown-react, [class*="markdown"]');
      if (md && !inside(md)) { var t = (md.textContent||'').trim(); if (t.length > best.length && !isPrompt(t)) best = t; }
      if (best.length < 50) { var t2 = (newRounds[k].textContent||'').trim(); if (t2.length > best.length && !isPrompt(t2)) best = t2; }
    }

    var mdBlocks = document.querySelectorAll('.qk-markdown, .qk-markdown-react, [class*="markdown-content"]');
    if (best.length < 100 && mdBlocks.length > snapshot.markdowns) {
      for (var m = snapshot.markdowns; m < mdBlocks.length; m++) {
        if (inside(mdBlocks[m])) continue;
        // ★ v4.2.0: 跳过用户消息中的 markdown
        if (isUserMessage(mdBlocks[m])) continue;
        var t3 = (mdBlocks[m].textContent||'').trim();
        if (t3.length > best.length && !isPrompt(t3)) best = t3;
      }
    }

    if (best.length < 200) {
      var mains = document.querySelectorAll('main');
      for (var n = mains.length-1; n >= 0; n--) {
        if (inside(mains[n])) continue;
        var divs = mains[n].querySelectorAll('div');
        for (var p = divs.length-1; p >= 0; p--) {
          if (inside(divs[p])) continue;
          // ★ v4.2.0: 跳过用户消息
          if (isUserMessage(divs[p])) continue;
          var t4 = (divs[p].textContent||'').trim();
          if (t4.length < 300) continue;
          if (isPrompt(t4)) continue;
          if (t4.indexOf('新建对话')>=0 && t4.indexOf('智能体')>=0) continue;
          if (t4.indexOf('API 服务')>=0 && t4.length<500) continue;
          if (t4.length > best.length) best = t4;
        }
      }
    }
    return best;
  }

  // Validation
  function isValidResponse(text, promptText) {
    if (!text || text.length < 300) return { valid: false, reason: "short(" + (text?text.length:0) + ")" };
    // ★ v4.2.0: 最终验证 — 检查是否是 prompt 本身
    if (isPrompt(text)) return { valid: false, reason: "is_prompt" };
    if (promptText && isTextSimilarToPrompt(text, promptText)) return { valid: false, reason: "similar_to_prompt" };
    return { valid: true, reason: "ok:" + text.length };
  }

  // Time window
  function isWithinSchedule(cfg){
    if(!cfg.scheduleStart||!cfg.scheduleEnd)return true;
    var n=new Date(),nm=n.getHours()*60+n.getMinutes();
    var sh=parseInt(cfg.scheduleStart.split(":")[0]),sm=parseInt(cfg.scheduleStart.split(":")[1]);
    var eh=parseInt(cfg.scheduleEnd.split(":")[0]),em=parseInt(cfg.scheduleEnd.split(":")[1]);
    var smi=sh*60+sm,emi=eh*60+em;
    if(smi<=emi)return nm>=smi&&nm<=emi;else return nm>=smi||nm<=emi;
  }
  function getNextScheduleStart(cfg){
    if(!cfg.scheduleStart)return null;
    var sh=parseInt(cfg.scheduleStart.split(":")[0]),sm=parseInt(cfg.scheduleStart.split(":")[1]);
    var t=new Date();t.setHours(sh,sm,0,0);if(t<=new Date())t.setDate(t.getDate()+1);return t;
  }
  function formatTimeRemaining(ms){
    if(ms<=0)return "now";var h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000);
    if(h>0)return h+"h"+m+"m";return m+"m";
  }
  function updateScheduleStatus(cfg){
    if(!STATE.ui||!STATE.ui.scheduleStatus)return;
    var c=cfg||getConfig();
    if(!c.scheduleStart||!c.scheduleEnd){STATE.ui.scheduleStatus.textContent="(off)";STATE.ui.scheduleStatus.style.color="#aaa";return;}
    if(isWithinSchedule(c)){STATE.ui.scheduleStatus.textContent="OK";STATE.ui.scheduleStatus.style.color="#4ade80";}
    else{var n=getNextScheduleStart(c);STATE.ui.scheduleStatus.textContent="wait "+formatTimeRemaining(n?n-new Date():0);STATE.ui.scheduleStatus.style.color="#f59e0b";}
  }

  // New chat
  async function startNewChat(){
    log("new chat...","info");await sleep(3000);
    var bs=document.querySelectorAll("button, a, [role=\"button\"]");
    var kw=["new","new chat","+"];
    for(var i=0;i<bs.length;i++){
      if(inside(bs[i]))continue;var t=(bs[i].textContent||"").trim().toLowerCase();
      for(var k=0;k<kw.length;k++){if(t.indexOf(kw[k])>=0){bs[i].click();await sleep(3000);return true;}}
    }
    try{if(STATE.running)setResumeState('新建对话-URL跳转');window.location.href="/chat";await sleep(8000);return true;}catch(e){return false;}
  }

  // Cooldown
  async function cooldownAndWake(cfg){
    var cooldownMs=(cfg.cooldownMinutes||120)*60000;
    log("cooldown "+Math.round(cooldownMs/60000)+"min...","warn");
    persistLog("cooldown "+Math.round(cooldownMs/60000)+"min","warn");
    var start=Date.now();
    while(Date.now()-start<cooldownMs){if(!STATE.running)return;await sleep(1000);}
    if(!STATE.running)return;
    log("wakeup...","info");
    await startNewChat();await sleep(2000);
    var wp=cfg.wakeupPrompt||"hello";
    var ok=await typePromptIntoChat(wp);
    if(ok){await sleep(1500);startCollecting();clickSendButton();await sleep(180000);stopCollecting();log("wakeup done","success");}
    await sleep(2000);await startNewChat();
  }

  // Dedup helpers
  function hashText(text){var n=text.length;if(n<100)return text.substring(0,50)+"|"+n;return text.substring(0,80)+"|"+text.substring(Math.floor(n*.25),Math.floor(n*.25)+60)+"|"+text.substring(Math.floor(n*.5),Math.floor(n*.5)+60)+"|"+text.substring(Math.floor(n*.75),Math.floor(n*.75)+60)+"|"+text.substring(n-80)+"|"+n;}
  function isPreviouslySaved(text){var h=hashText(text);if(STATE.processedHashes.indexOf(h)>=0)return true;if(STATE.baselineFingerprints.has(h))return true;return false;}
  function markBaseline(){var fps=new Set(STATE.processedHashes);var ms=document.querySelectorAll(".qk-markdown,.qk-markdown-react,[class*=\"markdown\"]");for(var i=0;i<ms.length;i++){if(inside(ms[i]))continue;var t=(ms[i].textContent||"").trim();if(t.length>50)fps.add(hashText(t));}STATE.baselineFingerprints=fps;return fps;}


  /**
   * ★ v4.2.0: waitForResponseComplete — 增加 currentPrompt 参数和 Prompt 泄漏检查
   * 三层防御：
   * 1. isPrompt 动态特征匹配
   * 2. isTextSimilarToPrompt 三向探测比对
   * 3. isUserMessage 结构性排除（在 getNewAnswerText 中）
   */
  async function waitForResponseComplete(snapshot, currentPrompt) {
    var cfg = getConfig();
    var timeoutMs = cfg.responseTimeoutMinutes * 60 * 1000;
    var stableMs = cfg.responseStableSeconds * 1000;
    var minWaitMs = cfg.responseMinWaitSeconds * 1000;
    var interval = 2000;

    var start = Date.now();
    var lastNetText = '';
    var lastDomText = '';
    var lastChangeTime = 0;
    var promptSkipCount = 0;

    log('⏳ 等待回答(网络拦截+DOM双通道, 超时='+cfg.responseTimeoutMinutes+'分)', 'info');

    while (Date.now() - start < timeoutMs) {
      while (STATE.paused && STATE.running) { await sleep(1000); }
      if (!STATE.running) return null;

      var netText = NET.collectedText || '';
      var netActivity = NET.lastActivity;
      var domText = getNewAnswerText(snapshot);

      var currentText = (netText.length > domText.length) ? netText : domText;

      if (currentText && currentText.length > 100) {
        // ★ v4.2.0 防御层1: isPrompt 动态特征检查
        if (isPrompt(currentText)) {
          promptSkipCount++;
          if (promptSkipCount <= 3) {
            log('🛡️ 拦截到Prompt文本(isPrompt), 跳过继续等待AI回答... ['+promptSkipCount+']', 'warn');
            await sleep(interval);
            continue;
          } else {
            log('🛡️ Prompt跳过次数过多('+promptSkipCount+'), 可能是异常情况', 'warn');
            // 不直接 continue，继续往下走，让后续检查兜底
          }
        }

        // ★ v4.2.0 防御层2: isTextSimilarToPrompt 相似度比对
        if (currentPrompt && isTextSimilarToPrompt(currentText, currentPrompt)) {
          promptSkipCount++;
          if (promptSkipCount <= 3) {
            log('🛡️ 拦截到Prompt相似文本(isTextSimilarToPrompt), 跳过继续等待... ['+promptSkipCount+']', 'warn');
            await sleep(interval);
            continue;
          }
        }

        if (currentText !== lastNetText) {
          lastNetText = currentText;
          lastChangeTime = Date.now();
        }

        var stableDuration = Date.now() - lastChangeTime;
        var elapsed = Date.now() - start;

        if (netText && netText !== lastNetText) {
          lastDomText = netText;
        }

        if (stableDuration >= stableMs && elapsed >= minWaitMs) {
          var source = netText.length >= domText.length ? '网络拦截' : 'DOM扫描';
          // ★ v4.2.0 最终验证: 保存前再次检查
          if (isPrompt(currentText)) {
            log('🛡️ 最终验证: 文本是Prompt, 拒绝保存, 继续等待...', 'warn');
            await sleep(interval);
            continue;
          }
          if (currentPrompt && isTextSimilarToPrompt(currentText, currentPrompt)) {
            log('🛡️ 最终验证: 文本与Prompt高度相似, 拒绝保存, 继续等待...', 'warn');
            await sleep(interval);
            continue;
          }
          log('✅ 回答完成('+currentText.length+'字符, '+source+')', 'success');
          stopCollecting();
          return currentText;
        }

        if (currentText.length > (lastDomText||'').length) {
          var growth = currentText.length - (lastDomText||'').length;
          if (growth > 20) log('📝 生成中('+currentText.length+'字符, +'+growth+')', 'info');
          lastDomText = currentText;
        }
      }

      await sleep(interval);
    }

    var final = stopCollecting();
    // ★ v4.2.0: 超时返回前也做 prompt 检查
    if (final.length > 100) {
      if (isPrompt(final)) {
        log('🛡️ 超时返回内容是Prompt, 丢弃', 'warn');
        return null;
      }
      if (currentPrompt && isTextSimilarToPrompt(final, currentPrompt)) {
        log('🛡️ 超时返回内容与Prompt相似, 丢弃', 'warn');
        return null;
      }
      log('⚠️ 超时，返回网络拦截内容('+final.length+'字符)', 'warn');
      return final;
    }
    if (lastDomText.length > 100) {
      if (isPrompt(lastDomText)) {
        log('🛡️ 超时DOM内容是Prompt, 丢弃', 'warn');
        return null;
      }
      if (currentPrompt && isTextSimilarToPrompt(lastDomText, currentPrompt)) {
        log('🛡️ 超时DOM内容与Prompt相似, 丢弃', 'warn');
        return null;
      }
      log('⚠️ 超时，返回DOM扫描内容('+lastDomText.length+'字符)', 'warn');
      return lastDomText;
    }
    log('❌ 等待超时，无有效回答', 'error');
    return null;
  }

  // ==================== 提取标题 & 保存 ====================
  function extractTitle(text, fileName) {
    var m = text.match(/标题[：:]\s*(.+?)(?:\n|$)/);
    if (m) { var t=m[1].trim().replace(/\s+/g,' ').substring(0,80).replace(/[\\/:*?"<>|]/g,'_').trim(); if(t.length>2)return t; }
    var lines = text.split('\n'), inBI = false;
    for (var i=0; i<lines.length; i++) {
      if (/##\s*1\.\s*基本信息/i.test(lines[i]) || /^1\.\s*基本信息/.test(lines[i]) || /文献基本信息/.test(lines[i])) { inBI=true; continue; }
      if (inBI) {
        var line=lines[i].trim();
        if (!line || line[0]==='<' || line.indexOf('##')===0) continue;
        var m2=line.match(/标题[：:]\s*(.+)/);
        if (m2) { var t2=m2[1].trim().substring(0,80).replace(/[\\/:*?"<>|]/g,'_').trim(); if(t2.length>2)return t2; }
        var t3=line.substring(0,80).replace(/[\\/:*?"<>|]/g,'_').trim(); if(t3.length>2)return t3;
      }
    }
    var name=fileName.replace(/\.pdf$/i,''); name=name.replace(/^\d+\.\d+\/[^,]+,/,'').trim();
    return name.substring(0,80) || fileName.substring(0,60);
  }

  async function saveResponse(text, title, cfg, originalPdfName) {
    if (!cfg.autoSave) return false;
    var prefix = originalPdfName ? originalPdfName.replace(/\.pdf$/i,'').replace(/[\\/:*?"<>|]/g,'_').substring(0,50) : '';
    var titleClean = title.replace(/[\\/:*?"<>|]/g,'_').substring(0,50);
    var fn = (prefix ? prefix + '_' : '') + titleClean + '.md';

    try { if (typeof GM_setClipboard !== 'undefined') { GM_setClipboard(text); log('📋 已复制到剪贴板 (保底)', 'info'); } } catch(e) {}

    try {
      var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = fn; a.style.display = 'none';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function() { URL.revokeObjectURL(url); }, 2000);
      log('💾 已下载: ' + fn, 'success');
      return true;
    } catch(e) {
      log('⚠️ a.click 下载失败: ' + e.message + ', 尝试 GM_download', 'warn');
    }

    if (typeof GM_download !== 'undefined') {
      try {
        var blob2 = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        var url2 = URL.createObjectURL(blob2);
        await new Promise(function(resolve, reject) {
          GM_download({
            url: url2,
            name: fn,
            saveAs: false,
            onload: function() { resolve(); },
            onerror: function(err) { reject(err); },
            ontimeout: function() { reject(new Error('timeout')); }
          });
        });
        setTimeout(function() { URL.revokeObjectURL(url2); }, 2000);
        log('💾 GM_download 成功: ' + fn, 'success');
        return true;
      } catch(e2) {
        log('⚠️ GM_download 也失败: ' + (e2.message || JSON.stringify(e2)), 'warn');
      }
    }

    try {
      var dataUri = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(text);
      var a3 = document.createElement('a');
      a3.href = dataUri; a3.download = fn; a3.style.display = 'none';
      document.body.appendChild(a3); a3.click(); document.body.removeChild(a3);
      log('💾 data:URI 下载: ' + fn, 'success');
      return true;
    } catch(e3) {
      log('❌ 所有下载方式均失败: ' + e3.message + ', 回答已在剪贴板', 'error');
    }

    return false;
  }

  // ==================== ★ v4.2.0 主上传引擎 ====================
  async function uploadOneFile(item) {
    var name=item.name, file=item.file, handle=item.handle, cfg=getConfig();
    log('📤 处理: '+name, 'info');

    try {
      var fileObj = file;
      if (!fileObj && handle) fileObj = await handle.getFile();
      if (!fileObj) { log('❌ 无法读取: '+name, 'error'); return false; }

      patchFileInputHooks(fileObj);

      var ab = findAttachButton();
      if (!ab) { log('❌ 未找到附件按钮', 'error'); unpatchFileInputHooks(); return false; }
      log('🖱 点击附件按钮', 'info');
      nativeClick(ab);
      await sleep(800);

      var menuItem = document.querySelector('[role="menuitem"]');
      if (!menuItem || (menuItem.textContent||'').trim() !== '上传文档') {
        var menuItems = document.querySelectorAll('[role="menuitem"]');
        for (var mi = 0; mi < menuItems.length; mi++) {
          if ((menuItems[mi].textContent||'').trim() === '上传文档') {
            menuItem = menuItems[mi]; break;
          }
        }
      }
      if (menuItem) {
        log('🖱 点击菜单项: 上传文档', 'info');
        nativeClick(menuItem);
      } else {
        log('⚠️ 未找到"上传文档"菜单项', 'warn');
      }

      await sleep(3500);

      var fileWasSet = _pwInjected;
      if (fileWasSet) {
        log('✅ 文件劫持已触发, 千问正在处理...', 'success');
      } else {
        log('⚠️ showOpenFilePicker 拦截未触发, 尝试直接注入', 'warn');
        var directInput = findFileInput();
        if (directInput && _pwPendingFile) {
          setFileToInput(directInput, _pwPendingFile);
          _pwPendingFile = null;
          fileWasSet = true;
        }
      }

      if (!fileWasSet) {
        log('❌ 无法注入文件', 'error');
        unpatchFileInputHooks();
        return false;
      }

      _pwPendingFile = null;

      var parseWait = cfg.fileParseWaitSeconds * 1000;
      log('📎 等待'+Math.round(parseWait/1000)+'秒解析文件...', 'info');
      await sleep(parseWait);

      // ★ v4.2.0: 记录本次发送的 prompt
      var sentPrompt = '';
      var promptOk = false;
      if (cfg.autoPrompt && cfg.promptText) {
        sentPrompt = getRotatedPrompt();
        STATE.lastSentPrompt = sentPrompt;  // ★ 保存到全局状态供 isPrompt 使用
        promptOk = await typePromptIntoChat(sentPrompt);
        if (promptOk) {
          await sleep(800);
          var ed = findInputBox();
          if (ed) {
            var t = (ed.textContent||ed.value||'').trim();
            if (t.length < 20) {
              ed.focus();
              if (ed.contentEditable==='true') ed.textContent = sentPrompt;
              else ed.value = sentPrompt;
              ed.dispatchEvent(new InputEvent('input',{bubbles:true,composed:true,inputType:'insertText'}));
              await sleep(500);
              promptOk = ((ed.textContent||ed.value||'').trim().length > 20);
            }
          }
        }
      }
      if (cfg.autoPrompt && cfg.promptText && !promptOk) {
        log('⏭ 跳过(Prompt失败): '+name, 'warn');
        unpatchFileInputHooks();
        STATE.lastSentPrompt = '';
        return false;
      }

      await sleep(cfg.sendDelaySeconds * 1000);
      startCollecting();
      var snapshot = countMessageBubbles();
      log('📸 快照: '+snapshot.rounds+'轮, 网络拦截已启动', 'info');

      clickSendButton();

      // ★ v4.2.0: 传递 sentPrompt 给 waitForResponseComplete
      var responseText = await waitForResponseComplete(snapshot, sentPrompt);

      if (responseText) {
        var v = isValidResponse(responseText, sentPrompt);
        if (v.valid) {
          log('valid response: '+v.reason, 'success');
          var title = extractTitle(responseText, name);
          var s = await saveResponse(responseText, title, cfg, name);
          if(s) { log('saved: '+title+'.md', 'success'); persistLog('DONE: '+name, 'success'); }
          else { log('save failed', 'warn'); persistLog('SAVEFAIL: '+name, 'warn'); }
          addUploaded(name, 'success');
          STATE.consecutiveFailures=0; updateStats();
          unpatchFileInputHooks(); STATE.lastSentPrompt = ''; return true;
        } else {
          log('INVALID: '+v.reason, 'error');
          persistLog('INVALID: '+name+' - '+v.reason, 'error');
          addUploaded(name, 'invalid');
          STATE.consecutiveFailures++; updateStats();
          unpatchFileInputHooks(); STATE.lastSentPrompt = '';
          await cooldownAndWake(cfg); return false;
        }
      } else {
        log('no response', 'warn');
        persistLog('NOREPLY: '+name, 'warn');
        addUploaded(name, 'no_response');
        STATE.consecutiveFailures++; updateStats();
        if(STATE.consecutiveFailures>=2){unpatchFileInputHooks();STATE.lastSentPrompt='';await cooldownAndWake(cfg);return false;}
      }

      unpatchFileInputHooks();
      STATE.lastSentPrompt = '';
      return false;
    } catch(e) {
      stopCollecting();
      unpatchFileInputHooks();
      STATE.lastSentPrompt = '';
      log('❌ 异常: '+name+' - '+e.message, 'error'); return false;
    }
  }

  // ==================== 批量循环 ====================
  async function runUploadLoop() {
    var cfg = getConfig();
    STATE.running = true; STATE.paused = false; updateButtons();
    setResumeState('开始批量上传');
    log('▶ 开始: '+STATE.queue.length+'个文件, 间隔'+cfg.intervalMinutes+'分, 网络拦截模式', 'info');

    for (var i=0; i<STATE.queue.length; i++) {
      while (STATE.paused && STATE.running) await sleep(1000);
      if (!STATE.running) { log('⏹ 已停止', 'warn'); break; }
      STATE.currentIndex = i; updateStats(); updateQueueList();
      var item = STATE.queue[i];
      if (getUploadedSet().has(item.name)) { log('⏭ 跳过: '+item.name, 'info'); continue; }
      setResumeState('处理中: '+item.name);
      await uploadOneFile(item);
      if (i < STATE.queue.length-1) {
        var wait = Math.max(30000, cfg.intervalMinutes*60000 + (Math.random()-0.5)*60000);
        log('⏰ 等待'+Math.round(wait/1000)+'秒...', 'info');
        var ws = Date.now();
        while (Date.now()-ws < wait) { while (STATE.paused && STATE.running) await sleep(1000); if (!STATE.running) break; await sleep(1000); }
      }
    }
    STATE.running = false; STATE.paused = false; STATE.currentIndex = -1;
    clearResumeState();
    updateButtons(); updateStats(); log('✅ 上传结束', 'success');
  }

  // ==================== 队列管理 ====================
  async function buildQueueFromDir() {
    if (!STATE.dirHandle) return;
    var files = await listPdfFiles(STATE.dirHandle);
    STATE.queue = files.map(function(f){return{name:f.name,handle:f.handle};});
    log('📋 加载'+files.length+'个PDF', 'info'); updateStats(); updateQueueList();
  }
  function addToQueueFromDrop(files) {
    var ex = new Set(STATE.queue.map(function(q){return q.name;})), added=0;
    for (var i=0; i<files.length; i++) {
      if (!ex.has(files[i].name)) { STATE.queue.push({name:files[i].name,file:files[i].file}); added++; }
    }
    if (added>0) { log('📥 拖拽添加'+added+'个PDF', 'info'); updateStats(); updateQueueList(); }
  }

  // ==================== File System Access ====================
  async function pickFolder() {
    if (typeof showDirectoryPicker === 'undefined') { log('❌ 浏览器不支持, 请拖拽', 'error'); return null; }
    try {
      var h = await window.showDirectoryPicker({mode:'read'});
      await storeDirHandle(h);
      STATE.dirHandle = h; STATE.config.folderDisplayName = h.name; saveConfig(); updateFolderDisplay();
      log('📂 已选择: '+h.name, 'success'); return h;
    } catch(e) { if (e.name!=='AbortError') log('❌ 选择失败: '+e.message, 'error'); return null; }
  }
  async function listPdfFiles(h) {
    var files = [];
    for await (var e of h.entries()) { if (e[1].kind==='file' && e[0].toLowerCase().endsWith('.pdf')) files.push({name:e[0],handle:e[1]}); }
    files.sort(function(a,b){return a.name.localeCompare(b.name,'zh');});
    return files;
  }
  async function getFileFromHandle(h) { return h.getFile(); }

  // ==================== IndexedDB ====================
  function openDB() {
    return new Promise(function(ok,err) {
      var req = indexedDB.open('QwenPdf3',1);
      req.onupgradeneeded = function(){ if(!req.result.objectStoreNames.contains('h')) req.result.createObjectStore('h'); };
      req.onsuccess = function(){ok(req.result);}; req.onerror = function(){err(req.error);};
    });
  }
  async function storeDirHandle(h) {
    var db = await openDB();
    return new Promise(function(ok,err){var tx=db.transaction('h','readwrite'); tx.objectStore('h').put(h,'dir'); tx.oncomplete=ok; tx.onerror=err;});
  }
  async function loadDirHandle() {
    try {
      var db = await openDB();
      var h = await new Promise(function(res){var tx=db.transaction('h','readonly'); var r=tx.objectStore('h').get('dir'); r.onsuccess=function(){res(r.result);}; r.onerror=function(){res(null);};});
      if (!h) return null;
      var p = await h.queryPermission({mode:'read'});
      if (p==='granted') return h;
      if (p==='prompt' && await h.requestPermission({mode:'read'})==='granted') return h;
      var db2=await openDB(), tx=db2.transaction('h','readwrite'); tx.objectStore('h').delete('dir');
      return null;
    }catch(e){return null;}
  }

  // ==================== 拖拽 ====================
  async function handleDropEntries(items) {
    var files = [];
    for (var i=0; i<items.length; i++) {
      if (items[i].kind!=='file') continue;
      var entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (!entry) continue;
      var c = await collectFiles(entry);
      for (var j=0; j<c.length; j++) files.push(c[j]);
    }
    return files;
  }
  async function collectFiles(entry) {
    var r = [];
    if (entry.isFile) {
      if (entry.name.toLowerCase().endsWith('.pdf')) {
        var f = await new Promise(function(res){entry.file(res);});
        r.push({name:f.name,file:f});
      }
    } else if (entry.isDirectory) {
      var reader = entry.createReader();
      var batch;
      do {
        batch = await new Promise(function(res){reader.readEntries(res);});
        for (var i=0; i<batch.length; i++) { var sub = await collectFiles(batch[i]); for (var j=0; j<sub.length; j++) r.push(sub[j]); }
      } while (batch.length>0);
    }
    return r;
  }

  // ==================== 日志 ====================
  function log(msg, level) {
    var time = new Date().toTimeString().slice(0,8);
    var icons = {info:'ℹ️',success:'✅',warn:'⚠️',error:'❌'};
    var line = '['+time+'] '+(icons[level]||'ℹ️')+' '+msg;
    if (STATE.ui.logContainer) {
      var e = document.createElement('div');
      e.className = 'qw-log-entry qw-log-'+(level||'info');
      e.textContent = line;
      STATE.ui.logContainer.appendChild(e);
      STATE.ui.logContainer.scrollTop = STATE.ui.logContainer.scrollHeight;
    }
    if (level==='error') console.error(line); else if (level==='warn') console.warn(line); else console.log(line);
    persistLog(msg, level);
  }

  // ==================== UI ====================
  function createPanel() {
    GM_addStyle(
'#qw-uploader-panel{position:fixed;top:100px;right:20px;z-index:99999;width:440px;max-height:85vh;background:#1a1a2e;color:#e0e0e0;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.5);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.5;display:flex;flex-direction:column;overflow:hidden;border:1px solid #2a2a4a;user-select:none;}'+
'#qw-uploader-panel.qw-collapsed{width:48px;height:48px;border-radius:24px;}#qw-uploader-panel.qw-collapsed .qw-content{display:none;}#qw-uploader-panel.qw-collapsed .qw-header-text{display:none;}'+
'.qw-header{display:flex;align-items:center;padding:10px 14px;background:linear-gradient(135deg,#16213e 0%,#1a1a2e 100%);border-bottom:1px solid #2a2a4a;cursor:move;border-radius:12px 12px 0 0;gap:8px;}'+
'.qw-header-icon{font-size:18px;}.qw-header-text{font-weight:600;font-size:14px;white-space:nowrap;}.qw-header-spacer{flex:1;}'+
'.qw-header-btn{background:none;border:1px solid #3a3a5a;color:#aaa;border-radius:6px;cursor:pointer;padding:4px 8px;font-size:12px;}.qw-header-btn:hover{background:#3a3a5a;color:#fff;}'+
'.qw-content{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;}'+
'.qw-section{display:flex;flex-direction:column;gap:6px;}.qw-section-title{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6a6a8a;margin-bottom:2px;}'+
'.qw-row{display:flex;align-items:center;gap:8px;}.qw-label{color:#aaa;font-size:12px;min-width:54px;white-space:nowrap;}'+
'.qw-btn{padding:6px 14px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;}'+
'.qw-btn-primary{background:#10b981;color:#fff;}.qw-btn-success{background:#10b981;color:#fff;}'+
'.qw-btn-warn{background:#f59e0b;color:#fff;}.qw-btn-danger{background:#ef4444;color:#fff;}'+
'.qw-btn-outline{background:transparent;border:1px solid #10b981;color:#10b981;}.qw-btn-outline:hover{background:rgba(16,185,129,.1);}'+
'.qw-btn:disabled{opacity:.4;cursor:not-allowed;}.qw-btn-sm{padding:4px 10px;font-size:11px;}'+
'.qw-input{background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:6px 10px;font-size:12px;width:60px;text-align:center;}.qw-input:focus{outline:none;border-color:#10b981;}'+
'.qw-folder-display{flex:1;padding:6px 10px;background:#16213e;border:1px dashed #3a3a5a;border-radius:6px;color:#6a6a8a;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'+
'.qw-folder-display.active{color:#10b981;border-color:#10b981;border-style:solid;}'+
'.qw-stats{display:flex;gap:12px;padding:8px 12px;background:#16213e;border-radius:8px;font-size:12px;color:#aaa;}'+
'.qw-stat-value{color:#10b981;font-weight:600;}.qw-stat-value.warn{color:#f59e0b;}'+
'.qw-progress-bar{height:6px;background:#2a2a4a;border-radius:3px;overflow:hidden;margin-top:4px;}'+
'.qw-progress-fill{height:100%;background:linear-gradient(90deg,#10b981,#059669);border-radius:3px;transition:width .3s;}'+
'.qw-log-container{background:#0d0d1a;border-radius:8px;padding:8px;max-height:200px;overflow-y:auto;font-family:"JetBrains Mono","Fira Code","Consolas",monospace;font-size:11px;line-height:1.6;}'+
'.qw-log-info{color:#a0a0c0;}.qw-log-success{color:#10b981;}.qw-log-warn{color:#f59e0b;}.qw-log-error{color:#ef4444;font-weight:600;}'+
'.qw-queue-list{max-height:120px;overflow-y:auto;background:#16213e;border-radius:6px;padding:4px 8px;}'+
'.qw-queue-item{padding:3px 6px;border-radius:4px;font-size:11px;color:#aaa;display:flex;align-items:center;gap:6px;}'+
'.qw-queue-item.current{background:rgba(16,185,129,.15);color:#10b981;font-weight:600;}.qw-queue-item.done{color:#10b981;}'+
'.qw-divider{border:none;border-top:1px solid #2a2a4a;margin:4px 0;}'+
'.qw-drop-overlay{position:fixed;inset:0;z-index:99998;background:rgba(16,185,129,.15);border:3px dashed #10b981;display:none;align-items:center;justify-content:center;pointer-events:none;}.qw-drop-overlay.active{display:flex;}'+
'.qw-drop-text{background:rgba(26,26,46,.95);color:#10b981;padding:24px 48px;border-radius:16px;font-size:20px;font-weight:700;}'+
'.qw-content::-webkit-scrollbar,.qw-log-container::-webkit-scrollbar,.qw-queue-list::-webkit-scrollbar{width:4px;}'+
'.qw-content::-webkit-scrollbar-thumb,.qw-log-container::-webkit-scrollbar-thumb,.qw-queue-list::-webkit-scrollbar-thumb{background:#3a3a5a;border-radius:2px;}'+
'.qw-prompt-tab{padding:5px 10px;border-radius:6px 6px 0 0;background:#0d0d1a;color:#6a6a8a;font-size:11px;cursor:pointer;border:1px solid transparent;display:inline-block;}'+
'.qw-prompt-tab:hover{color:#aaa;background:#16213e;}.qw-prompt-tab.active{background:#16213e;color:#10b981;border-color:#2a2a4a;border-bottom-color:#16213e;font-weight:600;}'+
'.qw-queue-item{cursor:pointer;}.qw-queue-item.invalid{color:#ef4444;}.qw-queue-item.selected{background:rgba(245,158,11,.15);color:#f59e0b;}'
    );

    var dropOverlay = document.createElement('div');
    dropOverlay.id = DROP_OVERLAY_ID;
    dropOverlay.className = 'qw-drop-overlay';
    dropOverlay.innerHTML = '<div class="qw-drop-text">📂 释放以上传 PDF</div>';
    document.body.appendChild(dropOverlay);

    var cfg = getConfig();
    var panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML =
'<div class="qw-header" id="qw-header-drag">'+
' <span class="qw-header-icon">🌐</span><span class="qw-header-text">千问 PDF 批量上传器 Pro v4.2.0</span>'+
' <span class="qw-header-spacer"></span>'+
' <button class="qw-header-btn" id="qw-btn-minimize" title="最小化">−</button>'+
'</div>'+
'<div class="qw-content" id="qw-content">'+
' <div class="qw-section">'+
'  <div class="qw-section-title">📂 文件夹 (网络拦截模式)</div>'+
'  <div class="qw-row">'+
'   <span class="qw-folder-display" id="qw-folder-display">未选择（也支持拖拽）</span>'+
'   <button class="qw-btn qw-btn-outline qw-btn-sm" id="qw-btn-pick">选择</button>'+
'   <button class="qw-btn qw-btn-outline qw-btn-sm" id="qw-btn-refresh" disabled>🔄</button>'+
'  </div>'+
' </div>'+
' <hr class="qw-divider">'+
' <div class="qw-section">'+
'  <div class="qw-section-title">⏱ 时间设置</div>'+
'  <div class="qw-row"><span class="qw-label">文件解析</span><input type="number" class="qw-input" id="qw-input-parse" min="3" step="1" value="'+cfg.fileParseWaitSeconds+'"><span style="color:#999;font-size:11px;">秒 — 上传后等待</span></div>'+
'  <div class="qw-row"><span class="qw-label">发送延迟</span><input type="number" class="qw-input" id="qw-input-send-delay" min="1" step="1" value="'+cfg.sendDelaySeconds+'"><span style="color:#999;font-size:11px;">秒 — Prompt→发送</span></div>'+
'  <div class="qw-row"><span class="qw-label">回答超时</span><input type="number" class="qw-input" id="qw-input-timeout" min="1" step="1" value="'+cfg.responseTimeoutMinutes+'"><span style="color:#999;font-size:11px;">分</span></div>'+
'  <div class="qw-row"><span class="qw-label">稳定判定</span><input type="number" class="qw-input" id="qw-input-stable" min="3" step="1" value="'+cfg.responseStableSeconds+'"><span style="color:#999;font-size:11px;">秒 — N秒不变→完成</span></div>'+
'  <div class="qw-row"><span class="qw-label">最短等待</span><input type="number" class="qw-input" id="qw-input-minwait" min="10" step="1" value="'+cfg.responseMinWaitSeconds+'"><span style="color:#999;font-size:11px;">秒 — 至少等N秒</span></div>'+
'  <div class="qw-row"><span class="qw-label">冷却时间</span><input type="number" class="qw-input" id="qw-input-cooldown" min="10" step="10" value="'+(cfg.cooldownMinutes||120)+'" style="width:50px;"><span style="color:#999;font-size:11px;">分(无效后冷却)</span></div>'+
'  <div class="qw-row"><span class="qw-label">时间窗口</span><input type="time" id="qw-input-schedule-start" style="background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:4px 6px;font-size:11px;width:100px;" value="'+(cfg.scheduleStart||'')+'"><span style="color:#aaa;font-size:11px;">-</span><input type="time" id="qw-input-schedule-end" style="background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:4px 6px;font-size:11px;width:100px;" value="'+(cfg.scheduleEnd||'')+'"><span style="color:#aaa;font-size:10px;" id="qw-schedule-status">(off)</span></div>'+
' </div>'+
' <hr class="qw-divider">'+
' <div class="qw-section">'+
'  <div class="qw-section-title">⚙️ 其他</div>'+
'  <div class="qw-row"><span class="qw-label">文件间隔</span><input type="number" class="qw-input" id="qw-input-interval" min="0.1" step="0.5" value="'+cfg.intervalMinutes+'"><span style="color:#aaa;font-size:12px;">分钟</span></div>'+
'  <div class="qw-row"><label style="color:#aaa;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="qw-checkbox-autoprompt"'+(cfg.autoPrompt!==false?' checked':'')+'> 自动输入Prompt</label></div>'+
'  <div class="qw-row"><label style="color:#aaa;font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="qw-checkbox-autosave"'+(cfg.autoSave!==false?' checked':'')+'> 自动下载回答</label></div>'+
' </div>'+
' <hr class="qw-divider">'+
' <div class="qw-section">'+
'  <div class="qw-section-title">📝 Prompt模板 (轮换)</div>'+
'  <div style="display:flex;gap:2px;margin-bottom:2px;"><span class="qw-prompt-tab active" data-tab="0">#0</span><span class="qw-prompt-tab" data-tab="1">#1</span></div>'+
'  <textarea id="qw-textarea-prompt" style="width:100%;height:60px;background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:0 6px 6px 6px;padding:6px 10px;font-size:11px;line-height:1.4;resize:vertical">'+escHtml(cfg.promptText||DEFAULT_PROMPT)+'</textarea>'+
'  <div class="qw-row" style="gap:6px;margin-top:2px;"><label style="color:#aaa;font-size:11px;display:flex;align-items:center;gap:3px;"><input type="checkbox" id="qw-checkbox-auto-rotate" checked> 自动轮换</label><span style="color:#6a6a8a;font-size:10px;" id="qw-rotate-index">轮换: -</span></div>'+
'  <div class="qw-row" style="gap:6px"><button class="qw-btn qw-btn-outline qw-btn-sm" id="qw-btn-save-prompt">保存</button><button class="qw-btn qw-btn-outline qw-btn-sm" id="qw-btn-reset-prompt">恢复默认</button></div>'+
' </div>'+
' <hr class="qw-divider">'+
' <div class="qw-stats" id="qw-stats">'+
'  <span>队列:<span class="qw-stat-value" id="qw-queue-count">0</span></span>'+
'  <span>已完成:<span class="qw-stat-value" id="qw-uploaded-count">0</span></span>'+
'  <span>当前:<span class="qw-stat-value warn" id="qw-current-file">-</span></span>'+
' </div>'+
' <div class="qw-progress-bar"><div class="qw-progress-fill" id="qw-progress-fill" style="width:0%"></div></div>'+
' <div class="qw-section"><div class="qw-section-title">📋 队列</div><div class="qw-queue-list" id="qw-queue-list"><div style="color:#6a6a8a;font-size:11px;">暂无文件</div></div></div>'+
' <div class="qw-row" style="gap:6px;flex-wrap:wrap">'+
'  <button class="qw-btn qw-btn-success" id="qw-btn-start" disabled>▶ 开始</button>'+
'  <button class="qw-btn qw-btn-warn" id="qw-btn-pause" disabled>⏸ 暂停</button>'+
'  <button class="qw-btn qw-btn-danger" id="qw-btn-stop" disabled>⏹ 停止</button>'+
'  <button class="qw-btn qw-btn-outline qw-btn-sm" id="qw-btn-reset">🔄 重置</button>'+
'  <button class="qw-btn qw-btn-outline qw-btn-sm" id="qw-btn-export-log">📜 导出日志</button>'+
'  <button class="qw-btn qw-btn-outline qw-btn-sm" id="qw-btn-import-log">📥 读取日志</button>'+
'  <button class="qw-btn qw-btn-outline qw-btn-sm" id="qw-btn-retry-failed" disabled>🔁 重试失败</button>'+
'  <button class="qw-btn qw-btn-outline qw-btn-sm" id="qw-btn-upload-selected" disabled>📌 上传选中</button>'+
' </div>'+
' <div class="qw-row" style="gap:4px;margin-top:4px;"><input type="text" id="qw-input-range" style="flex:1;background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:4px 8px;font-size:11px;" placeholder="按序号: 1,3,5-10"><button class="qw-btn qw-btn-outline qw-btn-sm" id="qw-btn-upload-range">上传指定</button></div>'+
' <hr class="qw-divider">'+
' <div class="qw-section"><div class="qw-section-title">📜 日志</div><div class="qw-log-container" id="qw-log-container"><div class="qw-log-entry qw-log-info">🚀 Pro v4.2.0 已启动</div><div class="qw-log-entry qw-log-info">📌 选择文件夹或拖拽PDF开始</div><div class="qw-log-entry qw-log-info">🛡️ v4.2.0: Prompt泄漏防御层已激活</div></div></div>'+
'</div>';
    document.body.appendChild(panel);

    STATE.ui = {
      panel:panel,
      folderDisplay:panel.querySelector('#qw-folder-display'),
      btnPick:panel.querySelector('#qw-btn-pick'), btnRefresh:panel.querySelector('#qw-btn-refresh'),
      btnStart:panel.querySelector('#qw-btn-start'), btnPause:panel.querySelector('#qw-btn-pause'),
      btnStop:panel.querySelector('#qw-btn-stop'), btnReset:panel.querySelector('#qw-btn-reset'),
      btnMinimize:panel.querySelector('#qw-btn-minimize'),
      headerDrag:panel.querySelector('#qw-header-drag'),
      inputParse:panel.querySelector('#qw-input-parse'), inputSendDelay:panel.querySelector('#qw-input-send-delay'),
      inputTimeout:panel.querySelector('#qw-input-timeout'), inputStable:panel.querySelector('#qw-input-stable'),
      inputMinWait:panel.querySelector('#qw-input-minwait'), inputInterval:panel.querySelector('#qw-input-interval'),
      inputCooldown:panel.querySelector('#qw-input-cooldown'),
      inputScheduleStart:panel.querySelector('#qw-input-schedule-start'), inputScheduleEnd:panel.querySelector('#qw-input-schedule-end'),
      scheduleStatus:panel.querySelector('#qw-schedule-status'),
      checkboxAutoPrompt:panel.querySelector('#qw-checkbox-autoprompt'), checkboxAutoSave:panel.querySelector('#qw-checkbox-autosave'),
      checkboxAutoRotate:panel.querySelector('#qw-checkbox-auto-rotate'),
      rotateIndex:panel.querySelector('#qw-rotate-index'),
      textareaPrompt:panel.querySelector('#qw-textarea-prompt'),
      btnSavePrompt:panel.querySelector('#qw-btn-save-prompt'), btnResetPrompt:panel.querySelector('#qw-btn-reset-prompt'),
      btnExportLog:panel.querySelector('#qw-btn-export-log'), btnImportLog:panel.querySelector('#qw-btn-import-log'),
      btnRetryFailed:panel.querySelector('#qw-btn-retry-failed'), btnUploadSelected:panel.querySelector('#qw-btn-upload-selected'),
      btnUploadRange:panel.querySelector('#qw-btn-upload-range'), inputRange:panel.querySelector('#qw-input-range'),
      queueCount:panel.querySelector('#qw-queue-count'), uploadedCount:panel.querySelector('#qw-uploaded-count'),
      currentFile:panel.querySelector('#qw-current-file'), progressFill:panel.querySelector('#qw-progress-fill'),
      queueList:panel.querySelector('#qw-queue-list'), logContainer:panel.querySelector('#qw-log-container'),
      dropOverlay:dropOverlay
    };

    bindUI(); bindDrag(); bindDrop();
    return panel;
  }

  function bindUI() {
    var ui = STATE.ui;
    ui.btnPick.addEventListener('click', async function(){ var h=await pickFolder(); if(h){await buildQueueFromDir();ui.btnRefresh.disabled=false;ui.btnStart.disabled=STATE.queue.length===0;} });
    ui.btnRefresh.addEventListener('click', async function(){ if(STATE.dirHandle){await buildQueueFromDir();ui.btnStart.disabled=STATE.queue.length===0;} });

    function cfgInt(el, key, min) { el.addEventListener('change', function(){ var v=parseInt(el.value)||min; STATE.config[key]=Math.max(min,v); el.value=STATE.config[key]; saveConfig(); }); }
    cfgInt(ui.inputParse, 'fileParseWaitSeconds', 3);
    cfgInt(ui.inputSendDelay, 'sendDelaySeconds', 1);
    cfgInt(ui.inputTimeout, 'responseTimeoutMinutes', 1);
    cfgInt(ui.inputStable, 'responseStableSeconds', 3);
    cfgInt(ui.inputMinWait, 'responseMinWaitSeconds', 10);

    ui.inputInterval.addEventListener('change', function(){ var v=parseFloat(ui.inputInterval.value); if(v>0){STATE.config.intervalMinutes=v;saveConfig();} });
    ui.checkboxAutoPrompt.addEventListener('change', function(){ STATE.config.autoPrompt=ui.checkboxAutoPrompt.checked;saveConfig(); });
    ui.checkboxAutoSave.addEventListener('change', function(){ STATE.config.autoSave=ui.checkboxAutoSave.checked;saveConfig(); });
    ui.btnSavePrompt.addEventListener('click', function(){ STATE.config.promptText=ui.textareaPrompt.value;saveConfig();log('✅ Prompt已保存','success'); });
    ui.btnResetPrompt.addEventListener('click', function(){ ui.textareaPrompt.value=DEFAULT_PROMPT; STATE.config.promptText=DEFAULT_PROMPT;saveConfig();log('🔄 已恢复默认','info'); });

    ui.btnStart.addEventListener('click', async function(){
      if (STATE.queue.length===0) { log('⚠️ 队列为空','warn'); return; }
      if (STATE.running) return;
      ui.btnStart.disabled=true; ui.btnPause.disabled=false; ui.btnStop.disabled=false;
      await runUploadLoop();
    });
    ui.btnPause.addEventListener('click', function(){ if(!STATE.running)return; STATE.paused=!STATE.paused; ui.btnPause.textContent=STATE.paused?'▶ 继续':'⏸ 暂停'; log(STATE.paused?'⏸ 已暂停':'▶ 已恢复','warn'); });
    ui.btnStop.addEventListener('click', function(){ STATE.running=false; STATE.paused=false; stopCollecting(); clearResumeState(); updateButtons(); log('⏹ 已停止','warn'); });
    ui.btnReset.addEventListener('click', function(){ if(confirm('清除上传记录？')){ clearUploaded(); updateStats(); updateQueueList(); log('🔄 已重置','warn'); } });
    ui.btnMinimize.addEventListener('click', function(){ STATE.ui.panel.classList.toggle('qw-collapsed'); });

    if(ui.inputCooldown) ui.inputCooldown.addEventListener('change',function(){var v=parseInt(ui.inputCooldown.value)||120;STATE.config.cooldownMinutes=Math.max(10,v);saveConfig();});
    if(ui.inputScheduleStart) ui.inputScheduleStart.addEventListener('change',function(){STATE.config.scheduleStart=ui.inputScheduleStart.value;saveConfig();updateScheduleStatus();});
    if(ui.inputScheduleEnd) ui.inputScheduleEnd.addEventListener('change',function(){STATE.config.scheduleEnd=ui.inputScheduleEnd.value;saveConfig();updateScheduleStatus();});
    if(ui.checkboxAutoRotate) ui.checkboxAutoRotate.addEventListener('change',function(){STATE.config.autoRotateEnabled=ui.checkboxAutoRotate.checked;saveConfig();updateRotateIndex();});

    if(ui.textareaPrompt&&ui.textareaPrompt.parentElement){
      var tabs=ui.textareaPrompt.parentElement.querySelectorAll('.qw-prompt-tab');
      for(var ti=0;ti<tabs.length;ti++){
        tabs[ti].addEventListener('click',function(e){
          var t=parseInt(e.target.dataset.tab);
          if(!isNaN(t)){STATE.config.activePromptTab=t;ui.textareaPrompt.value=PROMPT_POOL[t]||DEFAULT_PROMPT;saveConfig();
            var allT=ui.textareaPrompt.parentElement.querySelectorAll('.qw-prompt-tab');
            for(var aj=0;aj<allT.length;aj++)allT[aj].classList.toggle('active',parseInt(allT[aj].dataset.tab)===t);
          }
        });
      }
    }

    if(ui.btnExportLog) ui.btnExportLog.addEventListener('click',function(){exportLogToFile();log('log exported','success');});
    if(ui.btnImportLog) ui.btnImportLog.addEventListener('click',function(){
      var inp=document.createElement('input');inp.type='file';inp.accept='.txt';inp.style.display='none';
      document.body.appendChild(inp);
      inp.addEventListener('change',async function(e){
        var f=e.target.files[0];if(!f){document.body.removeChild(inp);return;}
        try{var t=await f.text();var r=parseLogAndRestore(t);log('restored '+r+' records','success');updateStats();updateQueueList();updateRetryFailedButton();}catch(err){log('import fail: '+err.message,'error');}
        document.body.removeChild(inp);
      });
      inp.click();
    });

    if(ui.btnRetryFailed) ui.btnRetryFailed.addEventListener('click',async function(){
      if(STATE.running)return;
      var recs=getUploadRecords();
      var failed=recs.filter(function(r){return r.status==='invalid'||r.status==='no_response';}).map(function(r){return r.name;});
      if(!failed.length){log('no failed','warn');return;}
      for(var f=0;f<failed.length;f++)removeUploaded(failed[f]);
      updateStats();updateQueueList();
      var rq=STATE.queue.filter(function(q){return failed.indexOf(q.name)>=0;});
      STATE.running=true;STATE.paused=false;updateButtons();
      for(var ri=0;ri<rq.length;ri++){
        while(STATE.paused&&STATE.running)await sleep(1000);if(!STATE.running)break;
        log('retry['+(ri+1)+'/'+rq.length+']: '+rq[ri].name,'info');
        await uploadOneFile(rq[ri]);
        if(ri<rq.length-1&&STATE.running){var w=Math.max(30000,getConfig().intervalMinutes*60000);var ws=Date.now();while(Date.now()-ws<w){while(STATE.paused&&STATE.running)await sleep(1000);if(!STATE.running)break;await sleep(1000);}}
      }
      STATE.running=false;STATE.paused=false;updateButtons();updateStats();updateQueueList();updateRetryFailedButton();
    });

    if(ui.btnUploadSelected) ui.btnUploadSelected.addEventListener('click',async function(){
      var sel=Object.keys(selectedFiles).filter(function(k){return selectedFiles[k];});
      if(!sel.length){log('none selected','warn');return;}
      if(STATE.running)return;
      var sq=STATE.queue.filter(function(q){return selectedFiles[q.name];});
      for(var s=0;s<sq.length;s++)removeUploaded(sq[s].name);
      updateStats();updateQueueList();
      STATE.running=true;STATE.paused=false;updateButtons();
      for(var si=0;si<sq.length;si++){
        while(STATE.paused&&STATE.running)await sleep(1000);if(!STATE.running)break;
        log('sel['+(si+1)+'/'+sq.length+']: '+sq[si].name,'info');
        await uploadOneFile(sq[si]);
        if(si<sq.length-1&&STATE.running){var w2=Math.max(30000,getConfig().intervalMinutes*60000);var ws2=Date.now();while(Date.now()-ws2<w2){while(STATE.paused&&STATE.running)await sleep(1000);if(!STATE.running)break;await sleep(1000);}}
      }
      STATE.running=false;STATE.paused=false;
      for(var n=0;n<sel.length;n++)selectedFiles[sel[n]]=false;
      updateButtons();updateStats();updateQueueList();
    });

    if(ui.btnUploadRange) ui.btnUploadRange.addEventListener('click',async function(){
      var rt=ui.inputRange.value.trim();if(!rt){log('enter range','warn');return;};
      if(STATE.running)return;
      var idx=parseRange(rt,STATE.queue.length);
      if(!idx.length){log('bad range','warn');return;}
      var rq2=idx.map(function(x){return STATE.queue[x];});
      for(var rj=0;rj<rq2.length;rj++)removeUploaded(rq2[rj].name);
      updateStats();updateQueueList();
      STATE.running=true;STATE.paused=false;updateButtons();
      for(var rk=0;rk<rq2.length;rk++){
        while(STATE.paused&&STATE.running)await sleep(1000);if(!STATE.running)break;
        log('range['+(rk+1)+'/'+rq2.length+'] #'+(idx[rk]+1)+': '+rq2[rk].name,'info');
        await uploadOneFile(rq2[rk]);
        if(rk<rq2.length-1&&STATE.running){var w3=Math.max(30000,getConfig().intervalMinutes*60000);var ws3=Date.now();while(Date.now()-ws3<w3){while(STATE.paused&&STATE.running)await sleep(1000);if(!STATE.running)break;await sleep(1000);}}
      }
      STATE.running=false;STATE.paused=false;updateButtons();updateStats();updateQueueList();
    });

    if(ui.queueList) ui.queueList.addEventListener('click',function(e){
      var item=e.target.closest('.qw-queue-item');
      if(!item||!item.dataset.qwidx)return;
      var idx=parseInt(item.dataset.qwidx);
      if(isNaN(idx)||idx>=STATE.queue.length)return;
      var nm=STATE.queue[idx].name;
      if(selectedFiles[nm])selectedFiles[nm]=false;else selectedFiles[nm]=true;
      updateQueueList();
      if(ui.btnUploadSelected){var c=Object.keys(selectedFiles).filter(function(k){return selectedFiles[k];}).length;ui.btnUploadSelected.disabled=c===0;ui.btnUploadSelected.textContent=c>0?'upload('+c+')':'upload selected';}
    });
  }

  var dragState=null;
  function bindDrag() {
    STATE.ui.panel.addEventListener('mousedown', function(e){
      if (e.target.tagName==='BUTTON'||e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.closest('label')) return;
      if (!e.target.closest('#qw-header-drag')) return;
      dragState={sx:e.clientX,sy:e.clientY,sl:STATE.ui.panel.offsetLeft,st:STATE.ui.panel.offsetTop};
      document.addEventListener('mousemove', onDM); document.addEventListener('mouseup', onDU);
    });
  }
  function onDM(e){ if(!dragState)return; STATE.ui.panel.style.right='auto'; STATE.ui.panel.style.top=Math.max(0,dragState.st+(e.clientY-dragState.sy))+'px'; STATE.ui.panel.style.left=Math.max(0,dragState.sl+(e.clientX-dragState.sx))+'px'; }
  function onDU(){ dragState=null; document.removeEventListener('mousemove',onDM); document.removeEventListener('mouseup',onDU); }

  function bindDrop() {
    var dc=0;
    document.addEventListener('dragenter',function(e){e.preventDefault();dc++;if(e.dataTransfer&&e.dataTransfer.types.indexOf('Files')>=0)STATE.ui.dropOverlay.classList.add('active');});
    document.addEventListener('dragleave',function(e){dc--;if(dc===0)STATE.ui.dropOverlay.classList.remove('active');});
    document.addEventListener('dragover',function(e){e.preventDefault();});
    document.addEventListener('drop',async function(e){e.preventDefault();dc=0;STATE.ui.dropOverlay.classList.remove('active');if(!e.dataTransfer||!e.dataTransfer.items)return;var files=await handleDropEntries(Array.prototype.slice.call(e.dataTransfer.items));if(files.length>0){addToQueueFromDrop(files);STATE.ui.btnStart.disabled=false;}});
  }

  function updateFolderDisplay() {
    var d=STATE.ui.folderDisplay, n=getConfig().folderDisplayName;
    d.textContent=n?'📂 '+n:'未选择（也支持拖拽）'; d.classList.toggle('active',!!n);
  }
  function updateStats() {
    var up=getUploadedSet(), done=0;
    for(var i=0;i<STATE.queue.length;i++) if(up.has(STATE.queue[i].name)) done++;
    STATE.ui.queueCount.textContent=STATE.queue.length;
    STATE.ui.uploadedCount.textContent=done;
    STATE.ui.currentFile.textContent=(STATE.currentIndex>=0&&STATE.currentIndex<STATE.queue.length)?STATE.queue[STATE.currentIndex].name:'-';
    STATE.ui.progressFill.style.width=STATE.queue.length>0?(done/STATE.queue.length*100)+'%':'0%';
  }
  function updateQueueList() {
    var l=STATE.ui.queueList, up=getUploadedSet();
    var recs=getUploadRecords();
    if (!STATE.queue.length) { l.innerHTML='<div style="color:#6a6a8a;font-size:11px;">暂无文件</div>'; return; }
    var show=STATE.queue.slice(0,50), h='';
    for(var i=0;i<show.length;i++){
      var cls='',dot='○';
      var isUp=up.has(show[i].name);
      var rec=recs.find(function(r){return r.name===show[i].name;});
      if(isUp){
        if(rec&&(rec.status==='invalid'||rec.status==='no_response')){cls='invalid';dot='✗';}
        else{cls='done';dot='●';}
      }
      if(i===STATE.currentIndex&&STATE.running){cls='current';dot='▶';}
      if(selectedFiles[show[i].name]){cls='selected';dot='📌';}
      h+='<div class="qw-queue-item '+cls+'" data-qwidx="'+i+'"><span class="qw-queue-dot">'+dot+'</span><span>'+(i+1)+'. '+escHtml(show[i].name)+'</span></div>';
    }
    l.innerHTML=h+(STATE.queue.length>50?'<div style="color:#6a6a8a;font-size:11px;padding:3px 6px;">...还有'+(STATE.queue.length-50)+'个</div>':'');
  }
  function updateButtons() {
    var ui=STATE.ui;
    if(STATE.running){ui.btnStart.disabled=true;ui.btnPause.disabled=false;ui.btnStop.disabled=false;ui.btnPause.textContent=STATE.paused?'▶ 继续':'⏸ 暂停';}
    else{ui.btnStart.disabled=STATE.queue.length===0;ui.btnPause.disabled=true;ui.btnStop.disabled=true;ui.btnPause.textContent='⏸ 暂停';}
  }
  function escHtml(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML;}

  // ==================== 初始化 ====================
  async function init() {
    loadPersistedLog();
    var c=getConfig(),ch=false;
    if(!c.cooldownMinutes){c.cooldownMinutes=120;ch=true;}
    if(!c.autoRotateEnabled&&c.autoRotateEnabled!==false){c.autoRotateEnabled=true;ch=true;}
    if(ch)saveConfig();
    STATE.lastSavedHash='';STATE.processedHashes=[];STATE.baselineFingerprints=new Set();
    STATE.prompt_index=gmGet('prompt_index',0);

    createPanel();
    updateRotateIndex();
    log('v4.2.0 started','info');log('fetch hijack active','info');
    log('🛡️ Prompt泄漏防御层已激活 (动态特征+结构排除+相似度比对)', 'success');

    if(STATE.logBuffer.length>0&&STATE.ui.logContainer){
      var rl=STATE.logBuffer.slice(-50);
      for(var j=0;j<rl.length;j++){
        var e=rl[j],t=new Date(e.time).toTimeString().slice(0,8),d=new Date(e.time).toISOString().slice(0,10);
        var di=document.createElement('div');di.className='qw-log-entry qw-log-'+e.level;
        di.textContent='['+d+' '+t+'] '+({info:'i',success:'+',warn:'!',error:'X'})[e.level]+' '+e.msg;
        STATE.ui.logContainer.appendChild(di);
      }
      STATE.ui.logContainer.scrollTop=STATE.ui.logContainer.scrollHeight;
    }

    updateScheduleStatus();
    if(STATE.ui.inputScheduleStart)STATE.ui.inputScheduleStart.value=c.scheduleStart||'';
    if(STATE.ui.inputScheduleEnd)STATE.ui.inputScheduleEnd.value=c.scheduleEnd||'';

    var h = await loadDirHandle();
    if (h) {
      STATE.dirHandle=h; STATE.config.folderDisplayName=h.name;
      STATE.ui.folderDisplay.textContent='folder: '+h.name; STATE.ui.folderDisplay.classList.add('active');
      STATE.ui.btnRefresh.disabled=false; saveConfig();
      log('restored: '+h.name,'success');
      await buildQueueFromDir(); STATE.ui.btnStart.disabled=STATE.queue.length===0;
    } else { log('select folder or drag','info'); }

    var up=getUploadedSet(); STATE.totalUploaded=up.size;
    updateStats(); updateQueueList(); updateButtons(); updateRetryFailedButton();
    if(up.size>0)log(up.size+' history','info');

    await sleep(3000);
    var ed=findInputBox();
    if(ed)log('input ready','success');else log('no input','warn');

    window.addEventListener('beforeunload', function(){ if(STATE.running) setResumeState('页面卸载'); });
    var resume = getResumeState();
    if (resume) {
      clearResumeState();
      if (STATE.queue.length > 0) {
        var upSet = getUploadedSet(), remaining = 0;
        for (var qi=0; qi<STATE.queue.length; qi++) { if (!upSet.has(STATE.queue[qi].name)) remaining++; }
        if (remaining > 0) {
          log('🔁 检测到运行中断('+(resume.reason||'页面刷新')+')，8秒后自动恢复上传(剩余'+remaining+'个)。不需要恢复请点 ⏹ 停止', 'warn');
          persistLog('自动恢复: '+(resume.reason||'页面刷新')+'，剩余 '+remaining+' 个', 'warn');
          STATE.ui.btnStop.disabled = false;
          setTimeout(function(){ if(!STATE.running && STATE.queue.length>0) runUploadLoop(); }, 8000);
        } else {
          log('🔁 检测到中断标记，但队列已全部完成', 'info');
        }
      } else {
        log('⚠️ 检测到运行中断，但队列为空(文件夹权限可能失效)，请重新选择文件夹后点开始', 'warn');
      }
    }
  }

  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
