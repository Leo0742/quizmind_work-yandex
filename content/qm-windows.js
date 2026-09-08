/**
 * qm-windows.js  v1.0
 * QuizMind — window system controllers loaded before content.js.
 *
 * Exports onto window.__QM:
 *   DragResizeController — unified 8-direction drag+resize for any window panel
 *   LoaderController     — positions a floating loader near its parent window
 *
 * Both replace previously duplicated inline code:
 *   - DragResizeController replaces the ~130-line inline drag+resize in ensureMultiPanel()
 *   - LoaderController unifies applyFloatingLoaderSide() + placeLoader()
 *
 * Dependencies: window.__QM must already be defined (qm-shared.js must load first).
 */
(() => {
  'use strict';

  const QM = window.__QM;
  if (!QM) { console.error('[QuizMind] qm-shared.js must load before qm-windows.js'); return; }

  /* ═══ DRAG + RESIZE CONTROLLER ═══════════════════════════════════════
   *
   * DragResizeController
   *
   * Attaches 8-direction resize handles and a drag handler to a panel element.
   * Previously: bindDragResize() in content.js handled answer/history/chat/logs,
   * while ensureMultiPanel() had ~130 lines of inline duplicate code for multi.
   * Now: multi uses DragResizeController too — one system for all windows.
   *
   * Usage:
   *   const ctrl = new DragResizeController({
   *     el,                   // the panel element
   *     winKey,               // 'multi', 'answer', etc.
   *     cfg,                  // { minW, minH, maxH } from WINDOW_DEFAULTS[winKey]
   *     dragHandle,           // element that initiates drag (header)
   *     forbiddenNodes,       // [] nodes that block drag when clicked (buttons)
   *     onDragEnd,            // () => called after every drag (persist)
   *     onResizeEnd,          // (isUserResize) => called after every resize (persist + flag)
   *     addManagedListener,   // fn — use the app's managed listener registry
   *   });
   *   ctrl.bind();
   * ═══════════════════════════════════════════════════════════════════ */
  class DragResizeController {
    #el;
    #winKey;
    #cfg;
    #dragHandle;
    #forbiddenNodes;
    #onDragEnd;
    #onResizeEnd;
    #addManagedListener;

    constructor({ el, winKey, cfg, dragHandle, forbiddenNodes = [], onDragEnd = () => {}, onResizeEnd = () => {}, addManagedListener }) {
      this.#el                 = el;
      this.#winKey             = winKey;
      this.#cfg                = cfg;
      this.#dragHandle         = dragHandle;
      this.#forbiddenNodes     = forbiddenNodes;
      this.#onDragEnd          = onDragEnd;
      this.#onResizeEnd        = onResizeEnd;
      this.#addManagedListener = addManagedListener;
    }

    bind() {
      this.#attachResize();
      this.#attachDrag();
    }

    /* ── resize ──────────────────────────────────────────────────────── */
    #attachResize() {
      const el  = this.#el;
      const cfg = this.#cfg;

      if (el.dataset.resizeHandleAttached) return;
      el.dataset.resizeHandleAttached = 'true';

      el.style.resize  = 'none';
      el.style.overflow = 'visible';

      const minW = cfg.minW || 80;
      const minH = cfg.minH || 28;

      const handles = [
        { dir:'n',  style:{ top:'-4px',    left:'10px',  right:'10px',  height:'8px',  cursor:'ns-resize' } },
        { dir:'s',  style:{ bottom:'-4px', left:'10px',  right:'10px',  height:'8px',  cursor:'ns-resize' } },
        { dir:'w',  style:{ left:'-4px',   top:'10px',   bottom:'10px', width:'8px',   cursor:'ew-resize' } },
        { dir:'e',  style:{ right:'-4px',  top:'10px',   bottom:'10px', width:'8px',   cursor:'ew-resize' } },
        { dir:'nw', style:{ top:'-4px',    left:'-4px',  width:'12px',  height:'12px', cursor:'nwse-resize',
                            borderTop:'2px solid #94a3b8', borderLeft:'2px solid #94a3b8',   borderTopLeftRadius:'6px',    opacity:'1' } },
        { dir:'ne', style:{ top:'-4px',    right:'-4px', width:'12px',  height:'12px', cursor:'nesw-resize',
                            borderTop:'2px solid #94a3b8', borderRight:'2px solid #94a3b8',  borderTopRightRadius:'6px',   opacity:'1' } },
        { dir:'sw', style:{ bottom:'-4px', left:'-4px',  width:'12px',  height:'12px', cursor:'nesw-resize',
                            borderBottom:'2px solid #94a3b8', borderLeft:'2px solid #94a3b8',  borderBottomLeftRadius:'6px', opacity:'1' } },
        { dir:'se', style:{ bottom:'-4px', right:'-4px', width:'12px',  height:'12px', cursor:'nwse-resize',
                            borderRight:'2px solid #94a3b8', borderBottom:'2px solid #94a3b8', borderBottomRightRadius:'6px', opacity:'1' } },
      ];

      let resizing = false;
      let rDir = 'se', rsx = 0, rsy = 0, rbw = 0, rbh = 0, rbl = 0, rbt = 0;

      const startR = dir => e => {
        if (e.button !== 0) return;
        const r = el.getBoundingClientRect();
        resizing = true; rDir = dir; rsx = e.clientX; rsy = e.clientY;
        rbw = r.width; rbh = r.height; rbl = r.left; rbt = r.top;
        el.style.width  = `${rbw}px`; el.style.height = `${rbh}px`;
        el.style.left   = `${rbl}px`; el.style.top    = `${rbt}px`;
        el.style.right  = 'auto';     el.style.bottom = 'auto';
        e.preventDefault(); e.stopPropagation();
      };

      for (const h of handles) {
        const node = document.createElement('div');
        Object.assign(node.style, { position: 'absolute', zIndex: '3', opacity: '0', ...h.style });
        node.addEventListener('mousedown', startR(h.dir));
        el.appendChild(node);
      }

      this.#addManagedListener(document, 'mousemove', e => {
        if (!resizing) return;
        const dx = e.clientX - rsx, dy = e.clientY - rsy;
        let w = rbw, h = rbh, l = rbl, t = rbt;
        if (rDir.includes('e')) w = rbw + dx;
        if (rDir.includes('s')) h = rbh + dy;
        if (rDir.includes('w')) { w = rbw - dx; l = rbl + dx; }
        if (rDir.includes('n')) { h = rbh - dy; t = rbt + dy; }
        const maxH = cfg.maxH ? Math.min(cfg.maxH, window.innerHeight - 8) : window.innerHeight - 8;
        if (w < minW) { if (rDir.includes('w')) l -= (minW - w); w = minW; }
        if (h < minH) { if (rDir.includes('n')) t -= (minH - h); h = minH; }
        l = Math.max(0, Math.min(l, Math.max(0, window.innerWidth  - w)));
        t = Math.max(0, Math.min(t, Math.max(0, window.innerHeight - h)));
        h = Math.max(minH, Math.min(h, maxH));
        el.style.left  = `${l}px`; el.style.top    = `${t}px`;
        el.style.width = `${w}px`; el.style.height = `${h}px`;
      }, { passive: true });

      this.#addManagedListener(document, 'mouseup', () => {
        if (!resizing) return;
        resizing = false;
        this.#onResizeEnd(true);  // true = user intentionally resized
      });
    }

    /* ── drag ────────────────────────────────────────────────────────── */
    #attachDrag() {
      const el         = this.#el;
      const dragHandle = this.#dragHandle;
      const forbidden  = this.#forbiddenNodes;
      if (!dragHandle) return;

      let dragging = false, sx = 0, sy = 0, bx = 0, by = 0;

      dragHandle.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        if (forbidden.some(n => n && (n === e.target || n.contains(e.target)))) return;
        const r = el.getBoundingClientRect();
        dragging = true; sx = e.clientX; sy = e.clientY; bx = r.left; by = r.top;
        el.style.width  = `${r.width}px`;  el.style.height = `${r.height}px`;
        el.style.left   = `${bx}px`;       el.style.top    = `${by}px`;
        el.style.right  = 'auto';          el.style.bottom = 'auto';
        e.preventDefault();
      });

      this.#addManagedListener(document, 'mousemove', e => {
        if (!dragging) return;
        const w = el.offsetWidth  || 340;
        const h = el.offsetHeight || 220;
        const left = Math.max(0, Math.min(bx + (e.clientX - sx), Math.max(0, window.innerWidth  - w)));
        const top  = Math.max(0, Math.min(by + (e.clientY - sy), Math.max(0, window.innerHeight - h)));
        el.style.left = `${left}px`; el.style.top = `${top}px`;
        el.style.right = 'auto'; el.style.bottom = 'auto';
      }, { passive: true });

      this.#addManagedListener(document, 'mouseup', () => {
        if (!dragging) return;
        dragging = false;
        this.#onDragEnd();  // persist rect; do NOT set userResized flag here
      });
    }
  }

  /* ═══ LOADER CONTROLLER ═══════════════════════════════════════════════
   *
   * LoaderController
   *
   * Positions a floating loader element near the bottom corner of its parent window.
   * Previously: applyFloatingLoaderSide() (answer) and placeLoader() (multi) were
   * two separate implementations with duplicated math. Now unified.
   *
   * Usage:
   *   const lc = new LoaderController({
   *     loaderEl:      mloader,
   *     getWindowRect: () => windowLayoutState.multi,   // saved rect or null
   *     getZone:       () => resolveActiveZone(),        // 'left' | 'right'
   *     loaderSize:    46,
   *     fallback:      null,   // 'near-answer' | null
   *     // only for 'near-answer' fallback:
   *     getAnswerEl:   () => we?.widget,
   *     getAnswerRect: () => windowLayoutState.answer,
   *   });
   *   lc.place();   // called before showing the loader
   *   lc.show();    // display: inline-flex
   *   lc.hide();    // display: none
   * ═══════════════════════════════════════════════════════════════════ */
  class LoaderController {
    #loaderEl;
    #getWindowRect;
    #getZone;
    #loaderSize;
    #fallback;
    #getAnswerEl;
    #getAnswerRect;

    constructor({ loaderEl, getWindowRect, getZone, loaderSize = 46, fallback = null, getAnswerEl = null, getAnswerRect = null } = {}) {
      this.#loaderEl      = loaderEl;
      this.#getWindowRect = getWindowRect;
      this.#getZone       = getZone;
      this.#loaderSize    = loaderSize;
      this.#fallback      = fallback;
      this.#getAnswerEl   = getAnswerEl;
      this.#getAnswerRect = getAnswerRect;
    }

    get isActive() {
      const el = this.#loaderEl;
      return Boolean(el && el.isConnected && getComputedStyle(el).display !== 'none');
    }

    /**
     * Position the loader at the bottom corner of the saved window rect.
     * Zone 'left' → left edge, zone 'right' → right edge.
     * Falls back to screen corner (answer loader) or near-answer (multi loader).
     */
    place() {
      const el   = this.#loaderEl;
      if (!el) return;
      const size = this.#loaderSize;
      const zone = this.#getZone();
      const saved = this.#getWindowRect();

      if (saved && Number.isFinite(Number(saved.x)) && Number.isFinite(Number(saved.y))) {
        const winH = Number(saved.height) > size ? Number(saved.height) : 120;
        const winW = Number(saved.width)  > size ? Number(saved.width)  : 340;
        const rawX = zone === 'left'
          ? Number(saved.x)
          : Number(saved.x) + winW - size;
        const rawY = Number(saved.y) + winH - size;
        el.style.left   = `${Math.max(0, Math.min(rawX, Math.max(0, window.innerWidth  - size)))}px`;
        el.style.top    = `${Math.max(0, Math.min(rawY, Math.max(0, window.innerHeight - size)))}px`;
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
        return;
      }

      // Fallback: near-answer (for multi loader when multi has no saved position)
      if (this.#fallback === 'near-answer') {
        this.#placeNearAnswer(zone, size);
        return;
      }

      // Fallback: viewport corner — matches applyAnswerFrame's default position (right:0/left:0, bottom:0)
      el.style.left   = zone === 'left'  ? '0px' : 'auto';
      el.style.right  = zone === 'right' ? '0px' : 'auto';
      el.style.bottom = '0px';
      el.style.top    = 'auto';
    }

    show() {
      if (this.#loaderEl) this.#loaderEl.style.display = 'inline-flex';
    }

    hide() {
      if (this.#loaderEl) this.#loaderEl.style.display = 'none';
    }

    /* near-answer fallback: place above the answer window */
    #placeNearAnswer(zone, size) {
      const el     = this.#loaderEl;
      const margin = 20;
      const answerEl   = this.#getAnswerEl?.();
      const answerRect = this.#getAnswerRect?.();
      const ansVisible = answerEl && answerEl.style.display !== 'none';

      let x, y;
      if (ansVisible) {
        const ar = answerEl.getBoundingClientRect();
        x = zone === 'left' ? margin : Math.max(margin, window.innerWidth - size - margin);
        y = Math.max(margin, Math.min(ar.top - size - 8, window.innerHeight - size - margin));
      } else if (answerRect && Number.isFinite(Number(answerRect.x))) {
        x = Math.max(0, Math.min(Number(answerRect.x), Math.max(0, window.innerWidth  - size)));
        y = Math.max(margin, Math.min(Number(answerRect.y) - size - 8, window.innerHeight - size - margin));
      } else {
        x = zone === 'left' ? margin : Math.max(margin, window.innerWidth - size - margin);
        y = window.innerHeight - size - margin;
      }

      el.style.left   = `${x}px`;
      el.style.top    = `${y}px`;
      el.style.right  = 'auto';
      el.style.bottom = 'auto';
    }
  }

  /* ═══ EXPORTS ════════════════════════════════════════════════════════ */
  QM.DragResizeController = DragResizeController;
  QM.LoaderController     = LoaderController;

})();
