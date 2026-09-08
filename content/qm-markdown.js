/**
 * qm-markdown.js — Markdown + LaTeX renderer for the content script.
 * Loaded as a content script BEFORE content.js.
 *
 * Registers: window.__QM_MARKDOWN = { renderMarkdown, normalizeAnswerText }
 *
 * renderLatex is intentionally kept private (only called by renderMarkdown).
 * No shared state, no DOM access, no side effects — pure rendering utilities.
 */
(() => {
  function renderLatex(text) {
    if (!text?.includes('$')) return null;
    const S = {'\\alpha':'α','\\beta':'β','\\gamma':'γ','\\delta':'δ','\\pi':'π','\\mu':'μ',
      '\\sigma':'σ','\\omega':'ω','\\Omega':'Ω','\\Sigma':'Σ','\\Delta':'Δ','\\infty':'∞',
      '\\partial':'∂','\\nabla':'∇','\\pm':'±','\\times':'×','\\div':'÷','\\leq':'≤',
      '\\geq':'≥','\\neq':'≠','\\approx':'≈','\\in':'∈','\\subset':'⊂','\\cup':'∪',
      '\\cap':'∩','\\forall':'∀','\\exists':'∃','\\to':'→','\\rightarrow':'→',
      '\\leftarrow':'←','\\sqrt':'√','\\ldots':'…','\\cdot':'·','\\int':'∫',
    };
    const SUP={'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','n':'ⁿ'};
    const SUB={'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉'};
    function conv(s) {
      s = s.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, (_, a, b) => `(${conv(a)})/(${conv(b)})`);
      s = s.replace(/\\sqrt\{([^}]*)\}/g, (_, x) => `√${conv(x)}`);
      Object.keys(S).sort((a, b) => b.length - a.length).forEach(k => { s = s.split(k).join(S[k]); });
      s = s.replace(/\^\{([^}]{1,4})\}/g, (_, x) => [...x].map(c => SUP[c] || c).join(''));
      s = s.replace(/_\{([^}]{1,4})\}/g,  (_, x) => [...x].map(c => SUB[c] || c).join(''));
      s = s.replace(/\{([^}]*)\}/g, '$1');
      return s;
    }
    text = text.replace(/\$\$([^$]+)\$\$/g, (_, i) => `\x00B:${encodeURIComponent(conv(i))}\x00`);
    text = text.replace(/\$([^$\n]+)\$/g,   (_, i) => `\x00I:${encodeURIComponent(conv(i))}\x00`);
    return text;
  }

  function renderMarkdown(text) {
    if (!text) return '';
    const lx  = renderLatex(text);
    const src = lx || text;
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    function restore(s) {
      const parts = s.split(/\x00(B|I):([^\x00]*)\x00/);
      let r = '';
      for (let i = 0; i < parts.length; i++) {
        if (i % 3 === 0) { r += esc(parts[i]); }
        else if (i % 3 === 1) {
          const c = decodeURIComponent(parts[i + 1] || '');
          r += parts[i] === 'B' ? `<span class="ta-math-b">${esc(c)}</span>` : `<code class="ta-math-i">${esc(c)}</code>`;
          i++;
        }
      }
      return r;
    }
    function inline(s) {
      return restore(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/__(.+?)__/g, '<strong>$1</strong>')
        .replace(/_(.+?)_/g, '<em>$1</em>');
    }
    const lines = src.split('\n'), html = [];
    let inCode = false, code = [], inUl = false, inOl = false;
    const closeList = () => {
      if (inUl) { html.push('</ul>'); inUl = false; }
      if (inOl) { html.push('</ol>'); inOl = false; }
    };
    for (const raw of lines) {
      if (raw.trimStart().startsWith('```')) {
        if (!inCode) { closeList(); inCode = true; code = []; }
        else { html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); inCode = false; code = []; }
        continue;
      }
      if (inCode) { code.push(raw); continue; }
      if (/^[-*_]{3,}\s*$/.test(raw)) { closeList(); html.push('<hr>'); continue; }
      const hm = raw.match(/^(#{1,3})\s+(.+)/);
      if (hm) { closeList(); html.push(`<h${hm[1].length}>${inline(hm[2])}</h${hm[1].length}>`); continue; }
      const um = raw.match(/^[\-*+]\s+(.+)/);
      if (um) { if (inOl) { html.push('</ol>'); inOl = false; } if (!inUl) { html.push('<ul>'); inUl = true; } html.push(`<li>${inline(um[1])}</li>`); continue; }
      const om = raw.match(/^\d+[.)]\s+(.+)/);
      if (om) { if (inUl) { html.push('</ul>'); inUl = false; } if (!inOl) { html.push('<ol>'); inOl = true; } html.push(`<li>${inline(om[1])}</li>`); continue; }
      if (!raw.trim()) { closeList(); html.push('<br>'); continue; }
      closeList(); html.push(`<p>${inline(raw)}</p>`);
    }
    closeList();
    if (inCode && code.length) html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    return html.join('');
  }

  function normalizeAnswerText(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd();
  }

  window.__QM_MARKDOWN = { renderMarkdown, normalizeAnswerText };
})();
