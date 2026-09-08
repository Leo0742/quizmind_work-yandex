/**
 * qm-logger.js — QM Logger subsystem for the content script.
 * Loaded as a content script BEFORE content.js.
 *
 * Registers: window.__QM_LOGGER
 *
 * Public API:
 *   qmLog(category, message, data)
 *   quizLog(scope, message, details, level)
 *   qmLogEnabled()
 *   qmDownloadLog()         → Promise<boolean>
 *   toggleQmLogPanel()
 *   destroyQmLogPanel()
 *   CAT_COLORS_QM           — category → CSS colour map
 *   init({ safeSendMessage, getWe, WindowManager })
 *   attachPanel(panelEl)    — called from ensureWidget() after DOM is built
 *   renderPanel()           — alias for _renderQmPanel
 *   installUpdate()         — alias for _installPanelUpdate
 *   applyFilter(panel, q)   — alias for _applyQmFilter
 *   clearCallbacks()        — nulls _qmPanelUpdate / _qmPanelStatus
 *   destroy()               — clearCallbacks + null _qmLogPanelInner
 */
(() => {
  // ── Injected dependencies (set via init()) ──────────────────────────────
  let _safeSendMessage = null;
  let _getWe           = null;
  let _WindowManager   = null;

  function init({ safeSendMessage, getWe, WindowManager }) {
    _safeSendMessage = safeSendMessage;
    _getWe           = getWe;
    _WindowManager   = WindowManager;
  }

  // ── Constants & log state ───────────────────────────────────────────────
  const QM_STORAGE_KEY      = 'qm_autosave_log';
  const QM_STORAGE_JSON_KEY = 'qm_autosave_log_json';
  let _qmLogEnabled = false;
  let _qmConfiguredEnabled = false;
  let _qmLogEntries = [];
  const QM_LOG_MAX  = 2000;

  let _qmPanelUpdate = null;
  let _qmPanelStatus = null;
  let _qmFlushTimer  = null;

  // ── Panel DOM reference (set via attachPanel()) ─────────────────────────
  let _qmLogPanelInner = null;

  function attachPanel(panelEl) {
    _qmLogPanelInner = panelEl;
  }

  // ── Flush timer ─────────────────────────────────────────────────────────
  function _qmScheduleFlush() {
    if (_qmFlushTimer) return;
    _qmFlushTimer = setTimeout(async () => {
      _qmFlushTimer = null;
      if (!_qmLogEntries.length) return;
      try {
        const text = _qmLogEntries.map(e => {
          const d = Object.keys(e.data).length ? ' ' + JSON.stringify(e.data) : '';
          return `[${e.ts}][${e.cat}] ${e.msg}${d}`;
        }).join('\n');
        await chrome.storage.local.set({
          [QM_STORAGE_KEY]:      text,
          [QM_STORAGE_JSON_KEY]: JSON.stringify(_qmLogEntries),
        });
        try { _qmPanelStatus?.(); } catch {}
      } catch {}
    }, 5_000);
  }

  function qmLogEnabled() {
    // Logging is privileged because prompts and answers can be sensitive. Never
    // let host-page localStorage or page-dispatched events override the trusted
    // extension setting loaded from chrome.storage.local.
    return _qmConfiguredEnabled;
  }

  function setEnabled(enabled) {
    _qmConfiguredEnabled = Boolean(enabled);
    _qmLogEnabled = qmLogEnabled();
    if (!_qmLogEnabled) {
      _qmLogEntries = [];
      if (_qmFlushTimer) { clearTimeout(_qmFlushTimer); _qmFlushTimer = null; }
      try { chrome.storage.local.remove([QM_STORAGE_KEY, QM_STORAGE_JSON_KEY]); } catch {}
    }
  }

  function qmLog(category, message, data = {}) {
    _qmLogEnabled = qmLogEnabled();
    if (!_qmLogEnabled) return;
    const entry = {
      ts: new Date().toISOString().slice(11, 23),
      cat: category,
      msg: message,
      data,
    };
    _qmLogEntries.push(entry);
    if (_qmLogEntries.length > QM_LOG_MAX) _qmLogEntries.shift();
    try { _qmPanelUpdate?.(entry); } catch {}
    _qmScheduleFlush();

    const style = _LOG_CONSOLE_COLORS[category] || 'color:#334155';
    const hasData = Object.keys(data).length > 0;
    if (hasData) {
      console.groupCollapsed(`%c[QM:${category}]%c ${entry.ts} ${message}`, style, 'color:#64748b');
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string' && v.length > 200) {
          console.log(`  ${k}:`, v.slice(0, 200) + '… [' + v.length + ' chars]');
        } else {
          console.log(`  ${k}:`, v);
        }
      }
      console.groupEnd();
    } else {
      console.log(`%c[QM:${category}]%c ${entry.ts} ${message}`, style, 'color:#64748b');
    }
  }

  /* Backward-compat wrapper — old quizLog(scope, message, details, level) calls */
  function quizLog(scope, message, details = null, _level = 'log') {
    qmLog(scope, message, details != null ? (typeof details === 'object' ? details : { value: details }) : {});
  }

  window.__QM_DUMP_LOG = function() {
    console.log('=== QuizMind Scan Log (' + _qmLogEntries.length + ' entries) ===');
    for (const e of _qmLogEntries) {
      console.log(`[${e.ts}][${e.cat}] ${e.msg}`, Object.keys(e.data).length ? e.data : '');
    }
    qmDownloadLog();
    return 'Logged ' + _qmLogEntries.length + ' entries';
  };
  window.__QM_CLEAR_LOG = function() {
    _qmLogEntries = [];
    try { chrome.storage.local.remove([QM_STORAGE_KEY, QM_STORAGE_JSON_KEY]); } catch {}
    try { _qmPanelUpdate?.({ _clear: true }); } catch {}
    return 'Log cleared';
  };
  window.__QM_ENABLE  = function() { setEnabled(true); return 'QM logging ENABLED for this content-script session'; };
  window.__QM_DISABLE = function() { setEnabled(false); return 'QM logging DISABLED'; };

  /**
   * Unified QM log export — used by BOTH the Logs window "Download" button
   * and the widget "Логи" button. Single source of truth for content and filename.
   */
  async function qmDownloadLog() {
    if (!_qmLogEntries.length) return false;

    const lines = _qmLogEntries.map(e => {
      const d = Object.keys(e.data).length ? '  ' + JSON.stringify(e.data) : '';
      return `[${e.ts}][${e.cat}] ${e.msg}${d}`;
    }).join('\n');

    let s = {};
    try { s = await window.TASettingsStorage?.getSettings() || {}; } catch {}

    const rawName = String(s.log_filename || 'qm-scan').trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'qm-scan';
    const ts = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const filename = `${rawName}_${ts}.log`;

    const mode   = s.log_location_mode || 'subfolder';
    const saveAs = s.log_save_mode === 'save_as';

    if (mode === 'subfolder' || saveAs) {
      const rawLoc = String(s.log_location || 'MyExtensionLogs')
        .trim().replace(/^\/+|\/+$/g, '') || 'MyExtensionLogs';
      const fullPath = (mode === 'subfolder') ? `${rawLoc}/${filename}` : filename;
      try {
        const r = await _safeSendMessage({
          type: 'DOWNLOAD_QM_LOGS',
          payload: { text: lines, filename: fullPath, saveAs }
        });
        if (r?.ok) return true;
      } catch {}
    }

    const blob = new Blob([lines], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return true;
  }

  // isQuizTextDebugEnabled → moved to content/qm-quiz.js

  const CAT_COLORS_QM = {
    SCAN:'#06b6d4',EXTRACT:'#8b5cf6',PROMPT:'#f59e0b',CACHE:'#6366f1',
    AI:'#10b981',HOVER:'#94a3b8',APPLY:'#ef4444',MATCH:'#f97316',
    ERROR:'#dc2626',BTN:'#0ea5e9',INIT:'#a3e635',FLOW:'#fb923c',
  };

  const _LOG_CONSOLE_COLORS = {
    'SCAN':    'color:#06b6d4;font-weight:bold',
    'EXTRACT': 'color:#8b5cf6;font-weight:bold',
    'PROMPT':  'color:#f59e0b;font-weight:bold',
    'CACHE':   'color:#6366f1;font-weight:bold',
    'AI':      'color:#10b981;font-weight:bold',
    'HOVER':   'color:#64748b;font-weight:bold',
    'APPLY':   'color:#ef4444;font-weight:bold',
    'MATCH':   'color:#f97316;font-weight:bold',
    'ERROR':   'color:#dc2626;font-weight:bold;background:#fef2f2',
    'BTN':     'color:#0ea5e9;font-weight:bold',
    'INIT':    'color:#a3e635;font-weight:bold',
    'FLOW':    'color:#fb923c;font-weight:bold',
  };

  function toggleQmLogPanel() {
    if (!_qmLogPanelInner) return;  // widget not yet ready
    if (_getWe()?.logsFab?.style.display === 'none') return;  // save_logs is off
    const visible = _qmLogPanelInner.style.display !== 'none';
    if (visible) {
      _WindowManager.hideWindow('logs', { persist:true, stopTimer:true });
      _qmPanelUpdate = null; _qmPanelStatus = null;
    } else {
      _WindowManager.showWindow('logs', { restore:true, display:'flex', startTimer:false });
      _renderQmPanel();
      _installPanelUpdate();
    }
  }

  function _makeQmRow(e) {
    const col = CAT_COLORS_QM[e.cat] || '#94a3b8';
    const row = document.createElement('div');
    row.className = 'qp-row' + (e.cat==='ERROR'?' err':(e.cat==='AI'?' ai':''));
    row.dataset.cat = e.cat;
    row.dataset.msg = (e.cat+' '+e.msg+' '+JSON.stringify(e.data)).toLowerCase();
    const ts  = document.createElement('span'); ts.className = 'qp-ts'; ts.textContent = e.ts;
    const cat = document.createElement('span'); cat.className = 'qp-cat-lbl'; cat.style.color = col; cat.textContent = e.cat;
    const msg = document.createElement('span'); msg.className = 'qp-msg';
    const hasData = e.data && Object.keys(e.data).length > 0;
    if (hasData) {
      const line   = document.createElement('span'); line.textContent = e.msg;
      const tog    = document.createElement('span'); tog.className = 'qp-tog'; tog.textContent = ' ▶';
      const detail = document.createElement('div');  detail.className = 'qp-detail';
      detail.textContent = Object.entries(e.data).map(([k,v])=>{
        const val = typeof v==='string'&&v.length>250?v.slice(0,250)+'…':JSON.stringify(v);
        return '  '+k+': '+val;
      }).join('\n');
      tog.onclick = (ev) => {
        ev.stopPropagation();
        const open = detail.classList.contains('open');
        detail.classList.toggle('open');
        tog.textContent = open?' ▶':' ▼';
      };
      msg.append(line, tog, detail);
    } else {
      msg.textContent = e.msg;
    }
    row.append(ts, cat, msg);
    return row;
  }

  function _renderQmPanel() {
    const panel = _qmLogPanelInner;
    if (!panel) return;
    const body  = panel.querySelector('.qp-body');
    if (!body)  return;
    const badge = panel._hdrBadge;
    body.innerHTML = '';
    if (!_qmLogEntries.length) {
      body.innerHTML = '<div class="qp-empty">Нет записей. Включи Quiz Page Scan и наведи на вопрос.</div>';
    } else {
      for (const e of _qmLogEntries) body.appendChild(_makeQmRow(e));
      body.scrollTop = body.scrollHeight;
    }
    if (badge) badge.textContent = _qmLogEntries.length + ' записей';
  }

  function _updateStatus(panel) {
    if (!panel) panel = _qmLogPanelInner;
    if (!panel) return;
    const badge = panel._hdrBadge;
    if (badge) badge.textContent = _qmLogEntries.length + ' записей';
  }

  function _installPanelUpdate() {
    const panel = _qmLogPanelInner;
    if (!panel) return;
    const body  = panel.querySelector('.qp-body');
    const badge = panel._hdrBadge;
    const srch  = panel._srch;
    const activeCats = panel._activeCats;
    _qmPanelUpdate = (entry) => {
      if (entry._clear) { _renderQmPanel(); return; }
      const row = _makeQmRow(entry);
      const q = srch ? srch.value.toLowerCase() : '';
      if (activeCats && !activeCats.has(entry.cat)) row.style.display = 'none';
      if (q && !row.dataset.msg.includes(q)) row.style.display = 'none';
      body.appendChild(row);
      if (badge) badge.textContent = _qmLogEntries.length + ' записей';
      if (row.style.display !== 'none') body.scrollTop = body.scrollHeight;
    };
    _qmPanelStatus = () => _updateStatus(panel);
  }

  function _applyQmFilter(panel, q) {
    const body = panel.querySelector('.qp-body');
    const activeCats = panel._activeCats;
    if(!body) return;
    q = (q||'').toLowerCase();
    let vis=0;
    for(const row of body.children) {
      const show = activeCats.has(row.dataset.cat) && (!q || row.dataset.msg.includes(q));
      row.style.display = show ? 'flex' : 'none';
      if(show) vis++;
    }
    const badge = panel._hdrBadge;
    if(badge) badge.textContent = vis+' / '+_qmLogEntries.length+' записей';
  }

  function destroyQmLogPanel() {
    _qmPanelUpdate = null; _qmPanelStatus = null;
    if (_qmLogPanelInner) _WindowManager.hideWindow('logs', { persist:false, stopTimer:true });
  }

  window.__QM_LOGGER = {
    qmLog,
    quizLog,
    qmLogEnabled,
    setEnabled,
    qmDownloadLog,
    toggleQmLogPanel,
    destroyQmLogPanel,
    CAT_COLORS_QM,
    init,
    attachPanel,
    renderPanel:    _renderQmPanel,
    installUpdate:  _installPanelUpdate,
    applyFilter:    _applyQmFilter,
    clearCallbacks() { _qmPanelUpdate = null; _qmPanelStatus = null; },
    destroy()       { _qmPanelUpdate = null; _qmPanelStatus = null; _qmLogPanelInner = null; },
  };
})();
