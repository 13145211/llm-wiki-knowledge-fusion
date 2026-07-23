// ==UserScript==
// @name         千问 PDF 批量上传器 Pro
// @namespace    https://github.com/qclaw/qianwen-pdf-uploader
// @version      4.3.0
// @description  v4.3.0: 纯DOM通道|input.click+showPicker劫持|无网络拦截|修复文件注入
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
    prompt_index: 0
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
'你是 WGS（水煤气变换反应）催化剂领域的博士后研究员。\n'+
'你的任务是精读一篇催化文献，撰写 7 段结构化笔记。\n\n'+
'你必须完全忠实地报告**文献原文和图表中的信息**——不能编造任何数字、结论或引用。\n'+
'当文本和图像信息冲突时，以图像为准并注明矛盾。\n'+
'如果需要推断，必须标注"合理推断"或"作者未述"。\n\n'+
'## 1. 基本信息\n<标题/作者/机构/期刊/年份/DOI/通讯/关键词>\n\n'+
'## 2. 研究背景与问题\n<含(1)具体科学挑战 (2)已有方案不足 (3)本文目标>\n\n'+
'## 3. 方法/技术路线\n<制备条件(克数/温度/时间/前驱体) + 表征手段(XRD/TEM/TPR/XPS/...) + 性能测试条件>\n\n'+
'## 4. 核心结果\n<含具体数字 + 图表引用 + 图像解读。每项结果必须注明依据来源>\n\n'+
'## 5. 创新点\n<基于作者 abstract + conclusions 改写，用"作者报告/作者通过"+ 标"依据"。\n不得使用原文未出现的"首次/新发现/新路径"等绝对化措辞。>\n\n'+
'## 6. 局限与展望\n<作者自陈 + 合理推断(标"合理推断"或"作者未述")>\n\n'+
'## 7. 原始文本摘要\n<≤300 字，覆盖核心发现>\n\n'+
'当遇到以下类型图表时，必须从图像中读取具体值：\n\n'+
'【XRD 衍射图】读出各衍射峰 2θ 位置和晶面指数，Scherrer 晶粒尺寸与文本对比\n'+
'【TEM/HRTEM 照片】估算颗粒尺寸范围(nm)，HRTEM 晶格条纹间距\n'+
'【H₂-TPR 曲线】各还原峰的峰温和相对面积\n'+
'【XPS 谱图】核实结合能标注\n'+
'【活性曲线/Arrhenius/TOF】直接读取关键数据点，验证Eₐ值\n'+
'【Table 数据】验证文中引用数字与表一致\n\n'+
'完成 7 段后自检：数字反查 | 创新点clean check | 图表引用完整性 | 引号原话 | 零占位符';

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

  // ==================== ★ 网络拦截层（参考 WebAI2API 的 page.on('response') 思路） ====================

  /**
   * v3.0.0 核心：劫持 fetch 来拦截千问的 API 回答
   *
   * 千问聊天 API 特征：
   * - POST 请求，URL 通常包含 chat/completion 或 /api/ 等路径
   * - 响应是 SSE (text/event-stream) 或 JSON 流
   * - 我们在 fetch 返回后读取响应文本，提取 AI 回答
   *
   * 对于 SSE 流：
   * - 千问使用 ReadableStream，我们能拿到完整的 response body
   * - 监听 response.clone().text() 来获取完整内容
   *
   * 工作流程：
   * 1. 发送消息前，startCollecting() 激活拦截

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
    // aria-label
    var found = null;
    ['发送消息','发送','send'].forEach(function(l) {
      if (found) return;
      var b = document.querySelector('[aria-label="'+l+'"]');
      if (b && !inside(b) && visible(b)) found = b;
    });
    if (found) return found;
    // 输入框旁边最后一个按钮
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

  // ★ v4.3.0: 三通道劫持 — showOpenFilePicker + input.click + input.showPicker
  var _pwPendingFile = null;
  var _pwInjected = false;
  var _origSOFP = null;
  var _origInputClick = null;
  var _origShowPicker = null;

  function _doInject(f) {
    try {
      var inp = findFileInput();
      if (inp && setFileToInput(inp, f)) { _pwPendingFile = null; return true; }
      var all = document.querySelectorAll('input[type="file"]');
      for (var i = 0; i < all.length; i++) {
        if (all[i].files && all[i].files.length > 0) continue;
        if (setFileToInput(all[i], f)) { _pwPendingFile = null; return true; }
      }
      // 兜底: 创建临时 input
      var tmp = document.createElement('input');
      tmp.type = 'file'; tmp.multiple = true;
      if (setFileToInput(tmp, f)) {
        document.body.appendChild(tmp);
        tmp.style.display = 'none';
        tmp.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(function() { document.body.removeChild(tmp); }, 5000);
        _pwPendingFile = null; return true;
      }
    } catch(e) { log('inject error: '+e.message, 'error'); }
    return false;
  }

  function patchFileInputHooks(fileObj) {
    _pwPendingFile = fileObj;
    _pwInjected = false;

    if (!_origSOFP) _origSOFP = window.showOpenFilePicker;
    window.showOpenFilePicker = function(opts) {
      if (_pwPendingFile && !_pwInjected) {
        _pwInjected = true; var f = _pwPendingFile;
        log('intercept showOpenFilePicker, injecting', 'info');
        return new Promise(function(r) {
          setTimeout(function() { _doInject(f); r([{ name: f.name, kind: 'file', getFile: function() { return Promise.resolve(f); } }]); }, 200);
        });
      }
      if (_origSOFP) return _origSOFP.call(window, opts);
      return Promise.reject(new Error('AbortError'));
    };

    if (!_origInputClick) _origInputClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function() {
      if (this.type === 'file' && _pwPendingFile && !_pwInjected) {
        _pwInjected = true;
        log('intercept input.click(type=file), injecting', 'info');
        _doInject(_pwPendingFile);
        return;
      }
      return _origInputClick.apply(this, arguments);
    };

    if (HTMLInputElement.prototype.showPicker) {
      if (!_origShowPicker) _origShowPicker = HTMLInputElement.prototype.showPicker;
      HTMLInputElement.prototype.showPicker = function() {
        if (this.type === 'file' && _pwPendingFile && !_pwInjected) {
          _pwInjected = true;
          log('intercept input.showPicker(type=file), injecting', 'info');
          _doInject(_pwPendingFile);
          return;
        }
        return _origShowPicker.apply(this, arguments);
      };
    }
  }

  function unpatchFileInputHooks() {
    _pwPendingFile = null; _pwInjected = false;
    if (_origInputClick) { HTMLInputElement.prototype.click = _origInputClick; _origInputClick = null; }
    if (_origShowPicker) { HTMLInputElement.prototype.showPicker = _origShowPicker; _origShowPicker = null; }
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

  // ==================== ★ 回答等待（网络优先 + DOM兜底） ====================

  /**
   * v3.0.0: 双通道回答获取
   * 通道1 (主): 网络拦截 fetch → 直接读 API 流式响应 → 最准确
   * 通道2 (备): DOM 扫描 → 找 markdown 块 → 兜底
   */

  // DOM 快照
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

  // DOM 通道：获取新增回答
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
      var md = newRounds[k].querySelector('.qk-markdown, .qk-markdown-react, [class*="markdown"]');
      if (md && !inside(md)) { var t = (md.textContent||'').trim(); if (t.length > best.length && !isPrompt(t)) best = t; }
      if (best.length < 50) { var t2 = (newRounds[k].textContent||'').trim(); if (t2.length > best.length && !isPrompt(t2)) best = t2; }
    }

    var mdBlocks = document.querySelectorAll('.qk-markdown, .qk-markdown-react, [class*="markdown-content"]');
    if (best.length < 100 && mdBlocks.length > snapshot.markdowns) {
      for (var m = snapshot.markdowns; m < mdBlocks.length; m++) {
        if (inside(mdBlocks[m])) continue;
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

  function isPrompt(text) {
    if (!text) return false;
    if (text.indexOf('你是 WGS')===0) return true;
    if (text.indexOf('你是 ')===0 && text.indexOf('研究员')>5) return true;
    if (text.indexOf('<标题/作者')>=0 || text.indexOf('< 标题')>=0) return true;
    return false;
  }

  // v4.3.0: 纯 DOM 通道，不依赖网络拦截
  async function waitForResponseComplete(snapshot) {
    var cfg = getConfig();
    var timeoutMs = cfg.responseTimeoutMinutes * 60 * 1000;
    var stableMs = cfg.responseStableSeconds * 1000;
    var minWaitMs = cfg.responseMinWaitSeconds * 1000;
    var interval = 2000;

    var start = Date.now();
    var lastText = '';
    var lastChangeTime = 0;

    log('Waiting for answer (DOM, timeout='+cfg.responseTimeoutMinutes+'min)', 'info');

    while (Date.now() - start < timeoutMs) {
      while (STATE.paused && STATE.running) { await sleep(1000); }
      if (!STATE.running) return null;

      var domText = getNewAnswerText(snapshot);

      if (domText && domText.length > 100) {
        if (domText !== lastText) {
          lastText = domText;
          lastChangeTime = Date.now();
        }

        var stableDuration = Date.now() - lastChangeTime;
        var elapsed = Date.now() - start;

        if (stableDuration >= stableMs && elapsed >= minWaitMs) {
          log('Answer complete ('+domText.length+' chars, DOM)', 'success');
          return domText;
        }
      }

      await sleep(interval);
    }

    // timeout: return best from DOM
    var finalDom = getNewAnswerText(snapshot);
    if (finalDom.length > 100) {
      log('Timeout, returning DOM content ('+finalDom.length+' chars)', 'warn');
      return finalDom;
    }
    log('Timeout, no valid answer', 'error');
    return null;
  }

  // ==================== 提取标题 & 保存 ====================
  function extractTitle(text, fileName) {
    var m = text.match(/标题[：:]\s*(.+?)(?:\n|$)/);
    if (m) { var t=m[1].trim().replace(/\s+/g,' ').substring(0,80).replace(/[\\/:*?"<>|]/g,'_').trim(); if(t.length>2)return t; }
    var lines = text.split('\n'), inBI = false;
    for (var i=0; i<lines.length; i++) {
      if (/##\s*1\.\s*基本信息/i.test(lines[i]) || /^1\.\s*基本信息/.test(lines[i])) { inBI=true; continue; }
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

  // ★ v3.0.3: save with multi-tier fallback (clipboard first, then a.click, then GM_download)
  async function saveResponse(text, title, cfg) {
    if (!cfg.autoSave) return false;
    var fn = title.replace(/[\\/:*?"<>|]/g,'_').substring(0,60)+'.md';

    // Tier 0: clipboard backup (always try first, so content is never lost)
    try { if (typeof GM_setClipboard !== 'undefined') { GM_setClipboard(text); log('📋 已复制到剪贴板 (保底)', 'info'); } } catch(e) {}

    // Tier 1 (primary): Blob + a.click() — proven reliable in v3.0.2
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

    // Tier 2 (fallback): GM_download
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

    // Tier 3 (last resort): data: URI
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

  // ==================== ★ v3.0.2 主上传引擎（劫持原生文件对话框） ====================
  async function uploadOneFile(item) {
    var name=item.name, file=item.file, handle=item.handle, cfg=getConfig();
    log('📤 处理: '+name, 'info');

    try {
      var fileObj = file;
      if (!fileObj && handle) fileObj = await handle.getFile();
      if (!fileObj) { log('❌ 无法读取: '+name, 'error'); return false; }

      // ★ Step 1: 先劫持 file input，再触发上传流程
      //    千问内部会调用 input.showPicker() → 被我们拦截 → 直接注入文件
      patchFileInputHooks(fileObj);

      // Step 2: 找到附件按钮
      var ab = findAttachButton();
      if (!ab) { log('❌ 未找到附件按钮', 'error'); unpatchFileInputHooks(); return false; }
      log('🖱 点击附件按钮', 'info');
      nativeClick(ab);
      await sleep(800);

      // Step 3: 点击弹出菜单中的"上传文档"
      var menuItem = document.querySelector('[role="menuitem"]');
      if (!menuItem || (menuItem.textContent||'').trim() !== '上传文档') {
        // 尝试找所有 menuitem
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

      // Step 4: 等待千问 React 调用 showOpenFilePicker
      //     → 我们的劫持阻止原生对话框，直接注入文件
      await sleep(3500);

      // 检查文件是否被注入
      var fileWasSet = _pwInjected;
      if (fileWasSet) {
        log('✅ 文件劫持已触发, 千问正在处理...', 'success');
      } else {
        // 劫持未触发！尝试直接找 input 设置
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

      _pwPendingFile = null; // 清理

      // Step 5: 等待文件解析
      var parseWait = cfg.fileParseWaitSeconds * 1000;
      log('📎 等待'+Math.round(parseWait/1000)+'秒解析文件...', 'info');
      await sleep(parseWait);

      // Step 6: 输入 Prompt
      var promptOk = false;
      if (cfg.autoPrompt && cfg.promptText) {
        promptOk = await typePromptIntoChat(cfg.promptText);
        if (promptOk) {
          await sleep(800);
          var ed = findInputBox();
          if (ed) {
            var t = (ed.textContent||ed.value||'').trim();
            if (t.length < 20) {
              ed.focus();
              if (ed.contentEditable==='true') ed.textContent = cfg.promptText;
              else ed.value = cfg.promptText;
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
        return false;
      }

      // Step 7: 拍 DOM 快照 → 发送
      await sleep(cfg.sendDelaySeconds * 1000);
      var snapshot = countMessageBubbles();
      log('Snapshot: '+snapshot.rounds+' rounds', 'info');

      clickSendButton();

      // Step 8: 等待回答
      var responseText = await waitForResponseComplete(snapshot);

      if (responseText) {
        log('📝 收到回答('+responseText.length+'字符)', 'info');
        var title = extractTitle(responseText, name);
        await saveResponse(responseText, title, cfg);
      } else {
        log('⚠️ 未获取到回答', 'warn');
      }

      addUploaded(name); updateStats();
      unpatchFileInputHooks();
      return true;
    } catch(e) {
      unpatchFileInputHooks();
      log('❌ 异常: '+name+' - '+e.message, 'error'); return false;
    }
  }

  // ==================== 批量循环 ====================
  async function runUploadLoop() {
    var cfg = getConfig();
    STATE.running = true; STATE.paused = false; updateButtons();
    log('▶ 开始: '+STATE.queue.length+'个文件, 间隔'+cfg.intervalMinutes+'分, 网络拦截模式', 'info');

    for (var i=0; i<STATE.queue.length; i++) {
      while (STATE.paused && STATE.running) await sleep(1000);
      if (!STATE.running) { log('⏹ 已停止', 'warn'); break; }
      STATE.currentIndex = i; updateStats(); updateQueueList();
      var item = STATE.queue[i];
      if (getUploadedSet().has(item.name)) { log('⏭ 跳过: '+item.name, 'info'); continue; }
      await uploadOneFile(item);
      if (i < STATE.queue.length-1) {
        var wait = Math.max(30000, cfg.intervalMinutes*60000 + (Math.random()-0.5)*60000);
        log('⏰ 等待'+Math.round(wait/1000)+'秒...', 'info');
        var ws = Date.now();
        while (Date.now()-ws < wait) { while (STATE.paused && STATE.running) await sleep(1000); if (!STATE.running) break; await sleep(1000); }
      }
    }
    STATE.running = false; STATE.paused = false; STATE.currentIndex = -1;
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
'.qw-content::-webkit-scrollbar-thumb,.qw-log-container::-webkit-scrollbar-thumb,.qw-queue-list::-webkit-scrollbar-thumb{background:#3a3a5a;border-radius:2px;}'
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
' <span class="qw-header-icon">🌐</span><span class="qw-header-text">千问 PDF 批量上传器 Pro v4.3.0</span>'+
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
'  <div class="qw-section-title">📝 Prompt模板</div>'+
'  <textarea id="qw-textarea-prompt" style="width:100%;height:60px;background:#16213e;border:1px solid #2a2a4a;color:#e0e0e0;border-radius:6px;padding:6px 10px;font-size:11px;line-height:1.4;resize:vertical">'+escHtml(cfg.promptText||DEFAULT_PROMPT)+'</textarea>'+
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
' </div>'+
' <hr class="qw-divider">'+
' <div class="qw-section"><div class="qw-section-title">📜 日志</div><div class="qw-log-container" id="qw-log-container"><div class="qw-log-entry qw-log-info">🚀 Pro v3.0.3 已启动 (a.click+GM_download+剪贴板)</div><div class="qw-log-entry qw-log-info">📌 选择文件夹或拖拽PDF开始</div></div></div>'+
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
      checkboxAutoPrompt:panel.querySelector('#qw-checkbox-autoprompt'), checkboxAutoSave:panel.querySelector('#qw-checkbox-autosave'),
      textareaPrompt:panel.querySelector('#qw-textarea-prompt'),
      btnSavePrompt:panel.querySelector('#qw-btn-save-prompt'), btnResetPrompt:panel.querySelector('#qw-btn-reset-prompt'),
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
    ui.btnStop.addEventListener('click', function(){ STATE.running=false; STATE.paused=false; updateButtons(); log('Stopped','warn'); });
    ui.btnReset.addEventListener('click', function(){ if(confirm('清除上传记录？')){ clearUploaded(); updateStats(); updateQueueList(); log('🔄 已重置','warn'); } });
    ui.btnMinimize.addEventListener('click', function(){ STATE.ui.panel.classList.toggle('qw-collapsed'); });
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
    if (!STATE.queue.length) { l.innerHTML='<div style="color:#6a6a8a;font-size:11px;">暂无文件</div>'; return; }
    var show=STATE.queue.slice(0,50), h='';
    for(var i=0;i<show.length;i++){
      var cls='',dot='○';
      if(up.has(show[i].name)){cls='done';dot='●';}
      if(i===STATE.currentIndex&&STATE.running){cls='current';dot='▶';}
      h+='<div class="qw-queue-item '+cls+'"><span class="qw-queue-dot">'+dot+'</span><span>'+escHtml(show[i].name)+'</span></div>';
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
    log('Pro v4.3.0 started (DOM-only, triple-hook)', 'info');
    log('🌐 fetch劫持已激活 — 实时捕获千问API响应', 'info');

    createPanel();

    var h = await loadDirHandle();
    if (h) {
      STATE.dirHandle=h; STATE.config.folderDisplayName=h.name;
      STATE.ui.folderDisplay.textContent='📂 '+h.name; STATE.ui.folderDisplay.classList.add('active');
      STATE.ui.btnRefresh.disabled=false; saveConfig();
      log('📂 已恢复: '+h.name, 'success');
      await buildQueueFromDir(); STATE.ui.btnStart.disabled=STATE.queue.length===0;
    } else { log('📌 请选择文件夹或拖拽PDF', 'info'); }

    var up=getUploadedSet(); STATE.totalUploaded=up.size;
    updateStats(); updateQueueList(); updateButtons();
    if (up.size>0) log('📊 '+up.size+'条历史上传记录', 'info');

    await sleep(3000);
    var ed=findInputBox();
    if (ed) log('✅ 检测到千问输入框, 就绪', 'success');
    else log('⚠️ 未检测到输入框', 'warn');
  }

  // @run-at document-start → 需要等 DOM ready
  if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
