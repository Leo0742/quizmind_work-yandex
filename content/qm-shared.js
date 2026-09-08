/**
 * qm-shared.js  v1.0
 * QuizMind — shared utilities loaded before content.js.
 *
 * Sets up window.__QM namespace with:
 *   TimerController — unified RAF-based countdown timer (replaces 3 duplicate implementations)
 *
 * Content scripts run in an isolated world, so window.__QM is safe from page scripts.
 */
(() => {
  'use strict';

  /* ═══ NAMESPACE ══════════════════════════════════════════════════════ */
  window.__QM = window.__QM || {};

  /* ═══ TIMER CONTROLLER ══════════════════════════════════════════════ */
  /**
   * TimerController
   *
   * Unified RAF-based countdown timer with pause/resume.
   * Replaces the three separate timer implementations in the old content.js:
   *   1. timerRafId/timerEnd/timerPaused/timerRemaining globals + timerStart/Stop/Pause/Resume/Tick
   *   2. timerId/multiTimerEnd/multiTimerPaused/multiTimerRemaining in ensureMultiPanel() closure
   *
   * Usage:
   *   const t = new TimerController({
   *     onTick:    (ratio) => bar.style.transform = `scaleX(${ratio})`,
   *     onExpire:  () => WindowManager.hideWindow('answer'),
   *     getPinned: () => widgetPinned,
   *     getVisible: () => panel.style.display !== 'none',
   *   });
   *   t.start(5000);   // start 5-second countdown
   *   t.pause();       // on mouseenter (saves remaining time)
   *   t.resume();      // on mouseleave  (resumes from saved time)
   *   t.stop();        // cancel RAF
   */
  class TimerController {
    #rafId      = null;
    #endTime    = 0;
    #durationMs = 5000;
    #remaining  = 0;
    #paused     = false;

    #onTick;
    #onExpire;
    #getPinned;
    #getVisible;

    constructor({ onTick = () => {}, onExpire = () => {}, getPinned = () => false, getVisible = () => true } = {}) {
      this.#onTick    = onTick;
      this.#onExpire  = onExpire;
      this.#getPinned = getPinned;
      this.#getVisible = getVisible;
    }

    /** True if the RAF loop is currently running */
    get isRunning()  { return this.#rafId !== null; }

    /** True if paused (hover) */
    get isPaused()   { return this.#paused; }

    /** Milliseconds remaining (live) */
    get remaining()  { return Math.max(0, this.#endTime - Date.now()); }

    /** The duration that was last passed to start() */
    get durationMs() { return this.#durationMs; }

    /**
     * Start (or restart) the countdown.
     * @param {number} [ms] — duration; if omitted, re-uses the last value
     */
    start(ms) {
      this.stop();
      if (ms !== undefined) this.#durationMs = ms;
      this.#paused    = false;
      this.#remaining = this.#durationMs;
      this.#endTime   = Date.now() + this.#durationMs;
      if (this.#getPinned()) return;
      this.#onTick(1);  // reset bar to full
      this.#rafId = requestAnimationFrame(() => this.#tick());
    }

    /** Cancel the RAF loop (does not clear remaining). */
    stop() {
      if (this.#rafId) { cancelAnimationFrame(this.#rafId); this.#rafId = null; }
    }

    /**
     * Pause the countdown (call on mouseenter).
     * Saves the remaining time; the RAF loop stops.
     */
    pause() {
      if (this.#paused || this.#getPinned()) return;
      this.#paused    = true;
      this.#remaining = Math.max(0, this.#endTime - Date.now());
      this.stop();
    }

    /**
     * Resume from where it was paused (call on mouseleave).
     * Uses saved remaining time — NOT the original duration.
     */
    resume() {
      if (!this.#paused || this.#getPinned() || this.#remaining <= 0) return;
      this.#paused  = false;
      this.#endTime = Date.now() + this.#remaining;
      this.#rafId   = requestAnimationFrame(() => this.#tick());
    }

    /** Internal RAF tick — private. */
    #tick() {
      if (this.#paused || this.#getPinned() || !this.#getVisible()) {
        this.stop();
        return;
      }
      const left = Math.max(0, this.#endTime - Date.now());
      this.#onTick(left / this.#durationMs);
      if (left <= 0) {
        this.#rafId = null;
        this.#onExpire();
        return;
      }
      this.#rafId = requestAnimationFrame(() => this.#tick());
    }
  }

  /* ═══ EXPORTS ════════════════════════════════════════════════════════ */
  window.__QM.TimerController = TimerController;

})();
