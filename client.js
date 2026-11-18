// dsh-dpi-tuner — Client half.
//
// Touch-first display tuning for the DSH Web GUI, built for Android viewports.
//
// Two independent knobs, one compact surface:
//
//   1. Interface zoom, 50–200 % in 5 % steps. One CSS `zoom` property on the
//      document root: Chromium scales layout, text, and fixed/overlay surfaces
//      together, so the whole Web UI (dialogs and the settings panel included)
//      follows one ratio and text is re-rasterized at the larger size instead
//      of being stretched. A geometry shim keeps JS-placed overlays (menus,
//      popovers, tooltips) honest while the document is zoomed.
//
//   2. Conversation font size, 10–22 px, written through the official Client
//      theme service `setFontSize('text', px)`. The service persists the value
//      in the durable `ui-theme` settings scope, so no plugin-side copy is
//      stored and the size survives a reload and an app restart.
//
// Entry points, touch-first (32 px targets, no hover-only affordances):
//   * a compact cluster in `conversation.composer.dock` — always visible:
//     `[A− 14px A+]  |  [− 100% +]  [⟲]`; a value tap resets that knob;
//   * two preference rows in `settings.general.item`, with a live
//     `devicePixelRatio` readout on the zoom row;
//   * Ctrl(⌘) + wheel on desktop, which owns the gesture so the browser's own
//     page zoom does not fire in parallel.
//
// The zoom preference is a browser-side value: a host-scoped cookie (so it
// survives the per-launch random loopback port) with a same-origin
// localStorage mirror. The font size has no plugin storage on purpose.
(function () {
  'use strict';

  /** The Loader row name, which is also this browser artifact's module id. */
  var PLUGIN_ID = 'dsh-dpi-tuner';

  /** Locale namespace owned by this plugin (registered in apply). */
  var LOCALE_NS = 'dpi-tuner';

  /** Versioned preference key; a future shape change cannot misread old data. */
  var STORAGE_KEY = 'dsh-dpi-tuner:v1';

  /**
   * Cookie mirror of the zoom preference. The desktop shell serves the GUI on
   * a random loopback port each launch, and `localStorage` is origin-scoped —
   * the port is part of the origin, but a cookie's scope is the host only.
   * The cookie is therefore what keeps the chosen scale across app restarts.
   */
  var COOKIE_NAME = 'dsh_dpi_tuner_zoom';
  var COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

  /** Accepted interface zoom range, as whole percent, and its step. */
  var MIN_SCALE = 50;
  var MAX_SCALE = 200;
  var STEP = 5;
  var DEFAULT_SCALE = 100;

  /**
   * Mirrored from the theme service's text-role spec (min 10 / default 14 /
   * max 22). The service throws outside this range, so these are hard bounds,
   * not preferences.
   */
  var FONT_MIN = 10;
  var FONT_MAX = 22;
  var FONT_DEFAULT = 14;

  /** Ctrl(⌘)+wheel: accumulated wheel delta for one step, and the idle reset. */
  var WHEEL_STEP_DELTA = 20;
  var WHEEL_RESET_MS = 400;

  var EN = {
    menuLabel: 'Zoom',
    zoomTitle: 'Interface zoom',
    zoomDesc: 'Scale the whole interface on high-DPI displays (current display: {dpi}).',
    fontTitle: 'Conversation font size',
    fontDesc: 'Conversation text, code and the composer follow one size (10–22 px, persisted by the theme settings).',
    increaseZoom: 'Zoom in',
    decreaseZoom: 'Zoom out',
    increaseFont: 'Increase font size',
    decreaseFont: 'Decrease font size',
    resetZoom: 'Reset zoom to 100%',
    resetFont: 'Restore default font size',
    resetAll: 'Reset zoom and font size',
    zoomValueLabel: 'Current interface zoom',
    valueUnit: '%'
  };

  var ZH = {
    menuLabel: '缩放',
    zoomTitle: '界面缩放',
    zoomDesc: '按比例缩放整个界面，适配高 DPI 屏幕（当前显示：{dpi}）。',
    fontTitle: '对话字号',
    fontDesc: '对话正文、代码与输入框同步步进（10–22px，由主题设置持久化）。',
    increaseZoom: '放大界面',
    decreaseZoom: '缩小界面',
    increaseFont: '增大字号',
    decreaseFont: '减小字号',
    resetZoom: '重置为 100%',
    resetFont: '恢复默认字号',
    resetAll: '恢复默认缩放与字号',
    zoomValueLabel: '当前界面缩放',
    valueUnit: '%'
  };

  //#region preference state -------------------------------------------------

  /** Clamp to the supported range and snap to the step grid. */
  function normalizeScale(value) {
    var number = Number(value);
    if (!isFinite(number)) return DEFAULT_SCALE;
    var clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, number));
    return Math.round(clamped / STEP) * STEP;
  }

  /** Reader for one localStorage key; null when absent or unreadable. */
  function readStoredScale(key) {
    try {
      var raw = window.localStorage.getItem(key);
      if (raw === null) return null;
      var parsed = JSON.parse(raw);
      return normalizeScale(parsed !== null && typeof parsed === 'object' ? parsed.scale : parsed);
    } catch (error) {
      return null;
    }
  }

  /** Reader for one cookie; null when absent or unreadable. */
  function readCookieScale(name) {
    try {
      var match = new RegExp('(?:^|;\\s*)' + name + '=(\\d{1,3})(?:;|$)').exec(document.cookie);
      if (match === null) return null;
      return normalizeScale(match[1]);
    } catch (error) {
      return null;
    }
  }

  function writeCookieScale(scale) {
    try {
      var secure = window.location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = COOKIE_NAME + '=' + scale + '; Path=/; Max-Age=' + COOKIE_MAX_AGE + '; SameSite=Lax' + secure;
    } catch (error) {
      // Cookies can be disabled; the localStorage mirror still carries the value.
    }
  }

  function writeStoredScale(scale) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ scale: scale }));
    } catch (error) {
      // A disabled/unavailable storage must not break the controls; the scale
      // still applies for this page life and the cookie mirror may have succeeded.
    }
    writeCookieScale(scale);
  }

  /**
   * The remembered zoom. The cookie is read first because it survives the
   * per-launch port change; localStorage is the fallback for builds where
   * cookies are unavailable. Whatever is found is written back to both stores.
   */
  function readPreference() {
    var scale = readCookieScale(COOKIE_NAME);
    if (scale === null) scale = readStoredScale(STORAGE_KEY);
    if (scale === null) scale = DEFAULT_SCALE;
    writeStoredScale(scale);
    return scale;
  }

  var currentScale = readPreference();
  var scaleListeners = [];


  function subscribeScale(listener) {
    scaleListeners.push(listener);
    return function () {
      var index = scaleListeners.indexOf(listener);
      if (index !== -1) scaleListeners.splice(index, 1);
    };
  }

  function notifyScale() {
    var snapshot = scaleListeners.slice();
    for (var index = 0; index < snapshot.length; index += 1) {
      try {
        snapshot[index]();
      } catch (error) {
        console.error('[' + PLUGIN_ID + '] scale listener failed:', error);
      }
    }
  }

  function getScale() {
    return currentScale;
  }

  /** Adopt a value learned from another tab without writing it back. */
  function adoptExternalScale(value) {
    var normalized = normalizeScale(value);
    if (normalized === currentScale) return;
    currentScale = normalized;
    applyDocumentScale(normalized);
    nudgeOverlayLayout();
    notifyScale();
  }

  function setScale(value) {
    var normalized = normalizeScale(value);
    if (normalized === currentScale) return;
    currentScale = normalized;
    writeStoredScale(normalized);
    applyDocumentScale(normalized);
    nudgeOverlayLayout();
    notifyScale();
  }

  //#endregion

  //#region ctrl+wheel -------------------------------------------------------

  var wheelRemainder = 0;
  var wheelResetTimer = null;

  /** Clear the accumulated wheel delta after a gesture ends. */
  function resetWheelRemainder() {
    wheelRemainder = 0;
    wheelResetTimer = null;
  }

  /**
   * Ctrl (⌘ on macOS) + wheel adjusts the interface zoom directly and
   * `preventDefault()` keeps the browser's own page zoom from firing in
   * parallel. A conventional wheel notch is one step; trackpad and pinch
   * events (many small deltas) accumulate so a gesture does not race through
   * the range. (Touchscreens have no wheel: the dock cluster and the
   * settings rows are the Android-first entry points.)
   * @param {WheelEvent} event - the window wheel event.
   * @returns {void}
   */
  function handleZoomWheel(event) {
    if (!event.ctrlKey && !event.metaKey) return;
    if (event.deltaY === 0) return;
    event.preventDefault();
    if (wheelResetTimer !== null) clearTimeout(wheelResetTimer);
    wheelResetTimer = setTimeout(resetWheelRemainder, WHEEL_RESET_MS);
    wheelRemainder += Math.abs(event.deltaY);
    if (wheelRemainder < WHEEL_STEP_DELTA) return;
    wheelRemainder = 0;
    setScale(getScale() + (event.deltaY < 0 ? STEP : -STEP));
  }

  //#endregion

  //#region geometry space shim ----------------------------------------------
  /**
   * Under a CSS `zoom` on the document root, Chromium reports two different
   * coordinate spaces for the same DOM: CSS lengths and layout metrics are in
   * layout pixels while `getBoundingClientRect()` and
   * `window.innerWidth`/`innerHeight` are reported in visual pixels
   * (layout × zoom). The shell sizes and places its `position: fixed`
   * tooltips, hover cards and menus from a rect it just measured, so under a
   * zoom the rect is already visual while the fixed offset is zoomed a second
   * time — the menu drifts by (scale − 1) × distance from the top-left
   * corner. This shim makes the JS-visible geometry match the layout space
   * CSS uses; every getter is the identity at 100 %, and unload restores the
   * prototypes.
   */
  var geometryShimRestore = null;
  var pointerCoordinatesAreVisual = null;

  /**
   * Escape hatch: set this key to "1" in the DevTools console and reload to run
   * the zoom without the geometry shim (for diagnosing an unrelated
   * regression):
   *   localStorage.setItem('dsh-dpi-tuner:no-geometry-shim', '1')
   * and remove it with `removeItem` to turn the shim back on.
   */
  var SHIM_OPT_OUT_KEY = 'dsh-dpi-tuner:no-geometry-shim';

  function geometryShimDisabled() {
    try {
      return window.localStorage.getItem(SHIM_OPT_OUT_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  /** The zoom applied to the document, as a layout→visual multiplier. */
  function layoutFactor() {
    return currentScale === DEFAULT_SCALE ? 1 : currentScale / 100;
  }

  function rectContainsPoint(rect, x, y) {
    return x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2;
  }

  function installZoomGeometryShim() {
    if (geometryShimRestore !== null) return;
    if (geometryShimDisabled()) return;
    if (typeof Element === 'undefined' || typeof MouseEvent === 'undefined') return;
    var restores = [];
    var originalRect = Element.prototype.getBoundingClientRect;

    Element.prototype.getBoundingClientRect = function () {
      var rect = originalRect.call(this);
      var factor = layoutFactor();
      if (factor === 1) return rect;
      return new DOMRect(rect.x / factor, rect.y / factor, rect.width / factor, rect.height / factor);
    };
    restores.push(function () {
      Element.prototype.getBoundingClientRect = originalRect;
    });

    function patchWindowDimension(name) {
      var owner = window;
      var descriptor = null;
      while (owner !== null) {
        descriptor = Object.getOwnPropertyDescriptor(owner, name);
        if (descriptor !== undefined) break;
        owner = Object.getPrototypeOf(owner);
      }
      if (descriptor === undefined || typeof descriptor.get !== 'function') return;
      var nativeGetter = descriptor.get;
      var ownDescriptor = owner === window ? descriptor : null;
      try {
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: descriptor.enumerable === true,
          get: function () {
            var value = nativeGetter.call(window);
            var factor = layoutFactor();
            return factor === 1 ? value : Math.round(value / factor);
          }
        });
      } catch (error) {
        return;
      }
      restores.push(function () {
        try {
          if (ownDescriptor !== null) Object.defineProperty(window, name, ownDescriptor);
          else delete window[name];
        } catch (error) {
          // A fresh page realm restores everything on reload anyway.
        }
      });
    }
    patchWindowDimension('innerWidth');
    patchWindowDimension('innerHeight');

    /**
     * The host's anchored panel system (model picker, permissions, session
     * stats, token usage, context-used) places its `position: fixed` panels
     * from `anchor.getBoundingClientRect()` (shimmed, layout space) MIXED with
     * `visualViewport.offsetLeft/offsetTop/width/height` (natively physical).
     * Under a zoom the two disagree, so the panels float. The host code is
     * written on the assumption that BOTH are in layout space (it emits them
     * straight into CSS px inside the zoomed document), so we bring the four
     * visualViewport dimensions into layout space too. We deliberately do NOT
     * wrap `visualViewport.getBoundingClientRect` (a `new DOMRect(...)` there
     * is a WebView crash risk and nothing in the host path calls it). The
     * factor check makes every getter an identity at 100 %, so the default
     * (un-zoomed) case is byte-for-byte unchanged.
     */
    function patchVisualViewportDims() {
      var vv = null;
      try {
        vv = window.visualViewport;
      } catch (error) {
        return;
      }
      if (vv === null || vv === undefined) return;

      var dims = ['width', 'height', 'offsetLeft', 'offsetTop'];
      for (var i = 0; i < dims.length; i += 1) {
        (function (name) {
          var owner = vv;
          var descriptor = null;
          while (owner !== null) {
            descriptor = Object.getOwnPropertyDescriptor(owner, name);
            if (descriptor !== undefined) break;
            owner = Object.getPrototypeOf(owner);
          }
          // Patch only a getter we can safely wrap; skip data props / locked ones.
          if (descriptor === undefined || typeof descriptor.get !== 'function') return;
          if (descriptor.configurable === false) return;
          var nativeGetter = descriptor.get;
          try {
            Object.defineProperty(vv, name, {
              configurable: true,
              enumerable: true,
              get: function () {
                var value;
                try {
                  value = nativeGetter.call(vv);
                } catch (error) {
                  return 0;
                }
                var factor = layoutFactor();
                if (factor === 1) return value;
                var out = value / factor;
                // Guard: never hand back a degenerate number that could collapse
                // a consumer's layout. If the native read is already degenerate,
                // return it unchanged.
                if (!isFinite(out) || out < 0) return value;
                return out;
              }
            });
          } catch (error) {
            return;
          }
          restores.push((function (restoredName) {
            return function () {
              try {
                delete vv[restoredName];
              } catch (restoreError) { /* ignore */ }
            };
          })(name));
        })(dims[i]);
      }
    }
    patchVisualViewportDims();

    function patchPointerCoordinate(name) {
      var descriptor = Object.getOwnPropertyDescriptor(MouseEvent.prototype, name);
      if (descriptor === undefined || typeof descriptor.get !== 'function') return;
      var nativeGetter = descriptor.get;
      try {
        Object.defineProperty(MouseEvent.prototype, name, {
          configurable: true,
          enumerable: descriptor.enumerable === true,
          get: function () {
            var value = nativeGetter.call(this);
            var factor = layoutFactor();
            if (factor === 1 || pointerCoordinatesAreVisual !== true) return value;
            return value / factor;
          }
        });
      } catch (error) {
        return;
      }
      restores.push(function () {
        Object.defineProperty(MouseEvent.prototype, name, descriptor);
      });
    }
    patchPointerCoordinate('clientX');
    patchPointerCoordinate('clientY');

    // Learn once whether this Chromium reports pointer coordinates in visual
    // pixels. A mouse event only falls inside the target's native (visual) rect
    // or the shimmed (layout) rect, never both, for targets away from the
    // origin, so this converges after a few events.
    function detectPointerSpace(event) {
      if (pointerCoordinatesAreVisual !== null) return;
      var target = event.target;
      if (target === null || target === undefined || typeof target.getBoundingClientRect !== 'function') return;
      var visualRect = originalRect.call(target);
      var layoutRect = target.getBoundingClientRect();
      var inVisual = rectContainsPoint(visualRect, event.clientX, event.clientY);
      var inLayout = rectContainsPoint(layoutRect, event.clientX, event.clientY);
      if (inVisual && !inLayout) pointerCoordinatesAreVisual = true;
      else if (inLayout && !inVisual) pointerCoordinatesAreVisual = false;
    }
    window.addEventListener('pointermove', detectPointerSpace, true);
    window.addEventListener('pointerdown', detectPointerSpace, true);
    restores.push(function () {
      window.removeEventListener('pointermove', detectPointerSpace, true);
      window.removeEventListener('pointerdown', detectPointerSpace, true);
    });

    geometryShimRestore = function () {
      for (var index = restores.length - 1; index >= 0; index -= 1) {
        try {
          restores[index]();
        } catch (error) {
          // Best effort; a reload restores the realm.
        }
      }
      geometryShimRestore = null;
    };
  }

  function uninstallZoomGeometryShim() {
    if (geometryShimRestore !== null) geometryShimRestore();
  }

  //#endregion

  //#region document scale ---------------------------------------------------

  /**
   * The root element's pre-existing inline zoom and heights, so unloading the
   * plugin restores exactly what was there before it touched the document.
   */
  var replacedZoom = null;
  var replacedHtmlHeight = null;
  var replacedBodyHeight = null;
  var compensatedFrame = null;

  function captureDocumentStyles(root) {
    if (replacedZoom === null) replacedZoom = root.style.getPropertyValue('zoom');
    if (replacedHtmlHeight === null) replacedHtmlHeight = root.style.getPropertyValue('height');
    var body = document.body;
    if (replacedBodyHeight === null && body !== null) {
      replacedBodyHeight = body.style.getPropertyValue('height');
    }
  }

  function applyDocumentScale(scale) {
    if (typeof document === 'undefined' || document.documentElement === null) return;
    var root = document.documentElement;
    captureDocumentStyles(root);
    if (scale === DEFAULT_SCALE) {
      if (replacedZoom) root.style.setProperty('zoom', replacedZoom);
      else root.style.removeProperty('zoom');
      if (replacedHtmlHeight) root.style.setProperty('height', replacedHtmlHeight);
      else root.style.removeProperty('height');
      if (document.body !== null) {
        if (replacedBodyHeight) document.body.style.setProperty('height', replacedBodyHeight);
        else document.body.style.removeProperty('height');
      }
      // Back to 100 %: release the main-frame height override so the host /
      // dsh-web-mobile own the frame's height again.
      if (compensatedFrame !== null && compensatedFrame.style) {
        compensatedFrame.style.removeProperty('height');
        compensatedFrame = null;
      }
      stopAttachPolling();
      root.removeAttribute('data-dsh-dpi-tuner');
      // The frame just changed height: let host-owned fixed panels (model
      // picker, stats/usage menus) re-measure against the new layout.
      nudgeOverlayLayout();
      return;
    }
    root.style.setProperty('zoom', String(scale / 100));
    root.setAttribute('data-dsh-dpi-tuner', String(scale));
    // Defer to one frame so the zoomed layout settles, then measure the real
    // content bottom and stretch only as much as needed (see below).
    scheduleAdaptiveCompensation();
    // The host frame may mount after the rAF retry window: poll until it
    // exists, then let the ResizeObserver own the trigger.
    startAttachPolling();
  }

  /**
   * Adaptive height compensation. A CSS `zoom` on `<html>` re-scales the
   * rendering without changing layout heights. For a clean `100%` height
   * chain the browser already re-resolves the `100%`s against the zoomed
   * initial containing block, so the app fills the viewport with no help —
   * and a fixed `100/zoom %` stretch would OVER-stretch it (pushing the
   * composer below the fold, confirmed in a headless Chromium test). But if
   * the host's main frame is tied to viewport units (100vh/dvh) instead of
   * the `100%` chain, zooming leaves a blank strip at the bottom.
   *
   * So: measure the app's natural (un-stretched) bottom in layout space, and
   * stretch `<html>` by exactly `viewport / naturalBottom` — filling a real
   * gap and leaving a clean chain untouched. Measured once per change, never
   * re-measured after the stretch, so it cannot oscillate.
   * @returns {void}
   */
  var compFrame = null;
  var compRetries = 0;
  var COMP_RETRY_CAP = 240; // ~4 s of rAFs: slow mobile mounts can exceed 670 ms.

  function scheduleAdaptiveCompensation() {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      adaptiveHeightCompensation();
      return;
    }
    if (compFrame !== null) window.cancelAnimationFrame(compFrame);
    compFrame = window.requestAnimationFrame(function () {
      compFrame = null;
      var settled = adaptiveHeightCompensation();
      // On a page refresh the client materializes before the host app (and
      // dsh-web-mobile's main frame) has mounted, so the first compensation
      // finds nothing. Keep retrying on the next frames until the frame
      // exists and is compensated — bounded, then stop.
      if (!settled && currentScale !== DEFAULT_SCALE && compRetries < COMP_RETRY_CAP) {
        compRetries += 1;
        scheduleAdaptiveCompensation();
      }
    });
  }

  /** True once the host DOM is ready to expose its main frame: dsh-web-mobile
   *  has mounted its pinned frame, or the app root has children. */
  function hostDomSettled() {
    try {
      if (document.querySelector('[data-mobile-nav="frame"]')) return true;
      var root = document.getElementById('root');
      if (root && root.childElementCount > 0) return true;
    } catch (error) { /* ignore */ }
    return false;
  }

  /**
   * Whether the host (dsh-web-mobile) has reserved a bottom band — i.e. it set
   * its authoritative `--dsha-mobile-visible-vh` to a value meaningfully
   * smaller than the physical viewport (the soft keyboard, a bottom toolbar,
   * or split-view is up). When it has, the host owns the frame's height and
   * we must not pin it ourselves (we'd cover the input). Reads the host's own
   * variable rather than a raw visualViewport heuristic, which misfires on
   * browsers that always keep chrome. @returns {boolean}
   */
  function hostBandActive() {
    var de = null;
    try {
      de = document.documentElement;
    } catch (error) {
      return false;
    }
    if (de === null) return false;
    var band = 0;
    try {
      band = parseFloat(de.style.getPropertyValue('--dsha-mobile-visible-vh'));
    } catch (error) {
      return false;
    }
    if (!isFinite(band) || band <= 0) return false;
    // The band dsh-web-mobile publishes is min(shimmed innerHeight, shimmed
    // visualViewport.height) — both now in LAYOUT space (÷ zoom), so the band is
    // layout too. Compare it against the shimmed innerHeight (also layout): a
    // keyboard-reserved band is strictly shorter than the full layout viewport.
    // This is correct under both keyboard models: resizes-content (innerHeight
    // and the band shrink together → not "active", the frame already fits the
    // shrunk layout) and overlays-content (innerHeight full, band shrunk →
    // "active", release so we don't stretch over the keyboard).
    // Degenerate visualViewport guard: some engines expose a 0×0 stub
    // (headless / pre-attach). There no band can be trusted and there is no
    // real keyboard to reserve space for — treat the host band as inactive so
    // the frame keeps compensating.
    try {
      var vvH = window.visualViewport ? window.visualViewport.height : 1;
      if (!vvH || vvH < 32) return false;
    } catch (error) { /* fall through to the band compare */ }
    var raw = 0;
    try {
      raw = window.innerHeight;
    } catch (error) {
      return false;
    }
    return raw > 0 && band < raw - 4;
  }

  /** Clear every compensation we applied (html/body heights + the pinned
   *  frame's height) so the host owns its layout again. @returns {void} */
  function releaseFrameCompensation() {
    var de = document.documentElement;
    if (compensatedFrame !== null && compensatedFrame.style) {
      compensatedFrame.style.removeProperty('height');
      compensatedFrame = null;
    }
    if (typeof de !== 'undefined' && de) de.style.removeProperty('height');
    if (document.body) document.body.style.removeProperty('height');
  }

  /**
   * @returns {boolean} true when settled (compensated, or a clean chain /
   *  keyboard / host-owning state that needs nothing from us, or the host DOM
   *  is ready); false when the host DOM is not mounted yet and the caller
   *  should retry on a later frame.
   */
  function adaptiveHeightCompensation() {
    if (typeof document === 'undefined' || document.documentElement === null) return false;

    if (currentScale === DEFAULT_SCALE) {
      // 100 % zoom: the host and dsh-web-mobile own the frame's height again.
      releaseFrameCompensation();
      compRetries = 0;
      return true;
    }

    // The host has reserved a bottom band (soft keyboard up, etc.): it
    // deliberately shrinks the main frame to the band above the keyboard.
    // Pinning it ourselves would cover the input, so hand the frame back to
    // the host (and stop compensating for now — the band event re-fires when
    // the keyboard closes and the host re-publishes the full height).
    if (hostBandActive()) {
      releaseFrameCompensation();
      compRetries = 0;
      watchMainFrame(); // keep watching so we re-engage when the keyboard closes
      nudgeOverlayLayout(); // host resized the frame: let fixed panels re-measure
      return true;
    }

    var zoom = currentScale / 100;
    var target = 'calc(100dvh / ' + zoom + ')';
    // Idempotency: if the frame we pinned is still there and already at the
    // exact height this zoom wants, leave it — no reflow churn on a band event
    // where nothing actually moved.
    if (
      compensatedFrame !== null &&
      document.body !== null &&
      document.body.contains(compensatedFrame) &&
      compensatedFrame.style.getPropertyValue('height') === target
    ) {
      compRetries = 0;
      watchMainFrame();
      return true;
    }

    releaseFrameCompensation();
    var de = document.documentElement;
    void de.offsetHeight; // force reflow after clearing, to measure the natural state
    var frame = findMainFrame();
    if (frame === null) {
      // No gap right now. Either the host DOM isn't mounted yet (keep the rAF
      // retry going), or the frame element exists but currently fills the
      // viewport (clean chain, or web-mobile hasn't pinned it shorter yet).
      // In the latter case attach the ResizeObserver so we catch the moment it
      // later collapses — that is exactly the refresh + dsh-web-mobile case.
      var frameEl = findFrameElement();
      watchMainFrame();
      if (frameEl === null && !hostDomSettled()) return false; // host not mounted yet: caller retries.
      compRetries = 0;
      return true;
    }
    // A viewport-pinned main frame (dvh/vh, or a JS-maintained pixel variable
    // like dsh-web-mobile's --dsha-mobile-visible-vh) does not follow a CSS
    // zoom, so it renders at `zoom × viewport` and floats above a blank
    // bottom strip. Stretch the frame itself to `100dvh / zoom` so its
    // rendered height is the full viewport. The `!important` priority is
    // required: dsh-web-mobile pins the frame's height with a stylesheet
    // `!important`, which a plain inline style would lose to.
    frame.style.setProperty('height', target, 'important');
    compensatedFrame = frame;
    compRetries = 0;
    watchMainFrame(); // keep tracking the frame so any later collapse re-runs us
    // The frame (and the dock row / trigger inside it) just moved: nudge any
    // open overlays (the portaled panel, host menus) to re-measure.
    nudgeOverlayLayout();
    return true;
  }

  /**
   * Find the main-frame element REGARDLESS of whether it currently has a
   * bottom gap: prefer dsh-web-mobile's `[data-mobile-nav="frame"]`, else the
   * outermost large near-top full-width element. Used to attach the
   * ResizeObserver even before the frame collapses. @returns {Element|null}
   */
  function findFrameElement() {
    var m = null;
    try {
      m = document.querySelector('[data-mobile-nav="frame"]');
    } catch (error) {
      m = null;
    }
    if (m !== null) return m;

    var root = null;
    try {
      root = document.getElementById('root') || document.body;
    } catch (error) {
      root = document.body;
    }
    if (root === null) return null;
    var vw = 0;
    var vh = 0;
    try {
      vw = window.innerWidth;
      vh = window.innerHeight;
    } catch (error) {
      return null;
    }
    if (!isFinite(vw) || !isFinite(vh) || vw === 0 || vh === 0) return null;
    var frontier = [root];
    for (var depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
      var next = [];
      for (var i = 0; i < frontier.length; i += 1) {
        var el = frontier[i];
        var r = null;
        try {
          r = el.getBoundingClientRect();
        } catch (error) {
          r = null;
        }
        // Outermost large near-top full-width element, no bottom-gap required.
        if (r && r.width >= vw * 0.7 && r.height >= vh * 0.25 && r.top <= 8) return el;
        if (el.children && el.children.length > 0) {
          for (var c = 0; c < el.children.length; c += 1) next.push(el.children[c]);
        }
      }
      frontier = next;
    }
    return null;
  }

  /**
   * Watch the main frame with a ResizeObserver so any height change —
   * dsh-web-mobile pinning it shorter on refresh, the soft keyboard up/down,
   * a rotation — re-runs the compensation. This is the reliable trigger that
   * the band event alone misses (the band event fires the instant the host
   * writes the height variable, before the frame's layout has actually
   * collapsed, so a compensation run at that moment sees "no gap yet" and
   * no-ops). The idempotency check in adaptiveHeightCompensation (already at
   * the target value → no DOM write) prevents a set→observe→set loop.
   * @returns {void}
   */
  var frameObserver = null;
  var watchedFrame = null;

  function watchMainFrame() {
    if (typeof ResizeObserver === 'undefined') return;
    var el = findFrameElement();
    if (el === null) return;
    if (watchedFrame === el && frameObserver !== null) return; // already watching it
    watchedFrame = el;
    if (frameObserver !== null) {
      try {
        frameObserver.disconnect();
      } catch (error) { /* ignore */ }
    }
    frameObserver = new ResizeObserver(function () {
      scheduleAdaptiveCompensation();
    });
    frameObserver.observe(el);
  }

  /**
   * The main frame (and dsh-web-mobile's pinning of it) mount LATER than the
   * bounded rAF retry window, so `watchMainFrame` is usually a no-op on first
   * runs — the frame element does not exist yet. Poll until the frame element
   * exists, then hand over to the ResizeObserver (which re-fires on any
   * later collapse, e.g. dsh-web-mobile pinning the height on refresh). The
   * poll is cheap (a couple of property reads) and stops once the RO is
   * attached to a real frame, when zoom returns to 100 %, or when the host
   * DOM is clearly settled with a clean chain.
   * @returns {void}
   */
  var attachPollTimer = null;

  function startAttachPolling() {
    if (typeof window === 'undefined' || typeof window.setInterval !== 'function') return;
    if (attachPollTimer !== null) return;
    var hasRO = typeof ResizeObserver !== 'undefined';
    attachPollTimer = window.setInterval(function () {
      // No longer zooming: stop.
      if (currentScale === DEFAULT_SCALE) {
        stopAttachPolling();
        return;
      }
      // The element we should watch is dsh-web-mobile's pinned main frame. It
      // may be marked LATE (the attribute is added after mount), so early ticks
      // find only a generic full element via the BFS fallback. Keep polling —
      // re-running watchMainFrame each tick — until the marked frame exists AND
      // is the element we are watching. Only then does the RO reliably catch the
      // moment the frame collapses under zoom.
      var marked = null;
      try {
        marked = document.querySelector('[data-mobile-nav="frame"]');
      } catch (error) {
        marked = null;
      }
      if (hasRO) {
        watchMainFrame(); // re-attaches to the preferred (marked) element when it appears
        if (marked !== null && watchedFrame === marked && frameObserver !== null) {
          stopAttachPolling();
          adaptiveHeightCompensation(); // one pass in case it already collapsed
          return;
        }
      } else {
        // No ResizeObserver: the interval itself is the compensation driver.
        adaptiveHeightCompensation();
      }
    }, 400);
  }

  function stopAttachPolling() {
    if (attachPollTimer !== null) {
      window.clearInterval(attachPollTimer);
      attachPollTimer = null;
    }
  }

  /** True if the element is a large near-top full-width box whose bottom edge
   *  sits above the viewport bottom (i.e. a zoom left it floating). @returns
   *  {boolean} */
  function hasBottomGap(el) {
    var vw = 0;
    var vh = 0;
    try {
      vw = window.innerWidth;
      vh = window.innerHeight;
    } catch (error) {
      return false;
    }
    if (!isFinite(vw) || !isFinite(vh) || vw === 0 || vh === 0) return false;
    var r = null;
    try {
      r = el.getBoundingClientRect();
    } catch (error) {
      return false;
    }
    if (!r) return false;
    return r.width >= vw * 0.7 && r.height >= vh * 0.25 && r.top <= 8 && r.bottom < vh - 1;
  }

  /**
   * Find the main frame a zoom left floating. Prefer dsh-web-mobile's pinned
   * frame (`[data-mobile-nav="frame"]`, whose height comes from a JS-maintained
   * viewport variable that zoom does not rescale); otherwise fall back to the
   * outermost large near-top element with a bottom gap. A clean 100% chain
   * fills the viewport, so no such element exists and null is returned.
   * @returns {Element|null}
   */
  function findMainFrame() {
    var m = null;
    try {
      m = document.querySelector('[data-mobile-nav="frame"]');
    } catch (error) {
      m = null;
    }
    if (m !== null && hasBottomGap(m)) return m;

    var root = null;
    try {
      root = document.getElementById('root') || document.body;
    } catch (error) {
      root = document.body;
    }
    if (root === null) return null;
    var vw = 0;
    var vh = 0;
    try {
      vw = window.innerWidth;
      vh = window.innerHeight;
    } catch (error) {
      return null;
    }
    if (!isFinite(vw) || !isFinite(vh) || vw === 0 || vh === 0) return null;
    var frontier = [root];
    for (var depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
      var next = [];
      for (var i = 0; i < frontier.length; i += 1) {
        var el = frontier[i];
        if (hasBottomGap(el)) return el; // outermost qualifying frame
        if (el.children && el.children.length > 0) {
          for (var c = 0; c < el.children.length; c += 1) next.push(el.children[c]);
        }
      }
      frontier = next;
    }
    return null;
  }

  /** Plugin unload leaves no trace on the document. */
  function restoreDocumentScale() {
    if (typeof document === 'undefined' || document.documentElement === null) return;
    var root = document.documentElement;
    if (replacedZoom) root.style.setProperty('zoom', replacedZoom);
    else root.style.removeProperty('zoom');
    if (replacedHtmlHeight) root.style.setProperty('height', replacedHtmlHeight);
    else root.style.removeProperty('height');
    if (document.body !== null) {
      if (replacedBodyHeight) document.body.style.setProperty('height', replacedBodyHeight);
      else document.body.style.removeProperty('height');
    }
    if (compensatedFrame !== null && compensatedFrame.style) {
      compensatedFrame.style.removeProperty('height');
      compensatedFrame = null;
    }
    root.removeAttribute('data-dsh-dpi-tuner');
  }

  /** Pending animation frame for the post-zoom resize nudge. */
  var resizeFrame = null;

  /**
   * Changing CSS zoom fires no window `resize`, but the shell positions
   * JS-placed overlays (menus, popovers, tooltips) from window metrics when
   * it opens them. One resize nudge after the scale settles lets an overlay
   * that is already open reposition into the zoomed coordinate space.
   * @returns {void}
   */
  function nudgeOverlayLayout() {
    if (typeof window === 'undefined') return;
    if (typeof window.requestAnimationFrame !== 'function') {
      window.dispatchEvent(new Event('resize'));
      return;
    }
    if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(function () {
      resizeFrame = null;
      window.dispatchEvent(new Event('resize'));
    });
  }

  /** The display scale the window is currently rendered at, e.g. "300%". */
  function detectDisplayScale() {
    var ratio = typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
      ? window.devicePixelRatio
      : 1;
    return Math.round(ratio * 100) + '%';
  }

  //#endregion

  //#region font size (official theme service) -------------------------------

  /**
   * The current conversation font size, read from the live theme snapshot.
   * The theme service speaks in font roles since DSH 0.2.1; the conversation
   * content is the `text` role.
   * @param {object} ctx - the plugin's client cordis context.
   * @returns {number} the current size in px, or the default when the service
   *   or the value is unavailable.
   */
  function readFont(ctx) {
    var theme = ctx.get('theme');
    if (theme === undefined || theme === null) return FONT_DEFAULT;
    var snapshot = null;
    try {
      snapshot = typeof theme.getTheme === 'function' ? theme.getTheme() : null;
    } catch (error) {
      snapshot = null;
    }
    var value = snapshot && snapshot.fontSizes ? Number(snapshot.fontSizes.text) : NaN;
    return isFinite(value) ? value : FONT_DEFAULT;
  }

  /**
   * Write one clamped size through the official write entry. The service
   * persists it in the durable `ui-theme` settings scope, so there is
   * deliberately no second copy of the value in this plugin.
   * @param {object} ctx - the plugin's client cordis context.
   * @param {number} px - desired size; clamped to the text-role range.
   * @returns {void}
   */
  function writeFont(ctx, px) {
    var theme = ctx.get('theme');
    if (theme === undefined || theme === null || typeof theme.setFontSize !== 'function') return;
    var next = Math.round(Number(px));
    if (!isFinite(next)) next = FONT_DEFAULT;
    next = Math.min(FONT_MAX, Math.max(FONT_MIN, next));
    if (next === readFont(ctx)) return;
    try {
      // `setFontSize(role, px)`, not `setFontSize(px)`: a bare number is read
      // as the role by the service.
      theme.setFontSize('text', next);
    } catch (error) {
      console.error('[' + PLUGIN_ID + '] font size write failed:', error);
    }
  }

  /** Re-render a control when the theme publishes a new snapshot. */
  function useThemeChange(ctx) {
    var state = React.useState(0);
    var setTick = state[1];
    React.useEffect(function () {
      if (typeof ctx.on !== 'function') return undefined;
      var off = ctx.on('theme/change', function () {
        setTick(function (tick) { return tick + 1; });
      });
      return typeof off === 'function' ? off : undefined;
    }, []);
    return state[0];
  }

  //#endregion

  //#region locale fallback ---------------------------------------------------

  /** The active locale service, captured on apply for the fallback translator. */
  var localeFace = null;

  /** React runtime, assigned when the loader materializes this module. */
  var React = null;

  /** Fallback translator used only if the slot's bound `t` prop is missing. */
  function fallbackTranslate(key, params) {
    var active = localeFace !== null && typeof localeFace.getLocale === 'function'
      ? String(localeFace.getLocale().active || '')
      : '';
    var dict = active.indexOf('zh') === 0 ? ZH : EN;
    var text = dict[key];
    if (text === undefined) return key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, function (match, name) {
      return name in params ? String(params[name]) : match;
    });
  }

  //#endregion

  //#region control styling ----------------------------------------------------

  /**
   * Dock trigger + floating panel styling. The dock keeps one small
   * "缩放" (Zoom) trigger; tapping it opens a fixed-position glass panel
   * (bottom-right, above the composer dock) holding the two capsule chip
   * rows — modeled on dsh-purge's floating dock panel: translucent layer
   * background, backdrop blur/saturate, 65%-mix border, 12px radius and a
   * deep soft shadow. Host theme tokens with neutral fallbacks; no
   * hover-only affordances, tap-highlight suppressed for Android.
   */
  var DOCK_CSS = [
    /* The dock occupant is a normal in-flow flex item (registered at
       order 0.5, i.e. between the host's activity(0) and usage(1) stats),
       so it takes its own space in the row and never overlays the host's
       statistics. flex:1 + justify-content:center makes the "缩放" pill sit
       dead-center in the space between the two stat groups. */
    '.dt_root{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;min-height:28px;overflow:visible}',
    /* The trigger's positioning anchor: a zero-margin inline box exactly
       the trigger's size, so the panel's `bottom:100%` / `left:50%` resolve
       against the trigger's own top-center. Being in the document flow (not
       `position:fixed`), it zooms with everything else and stays dead
       relative to the trigger at any interface scale — no measurement. */
    '.dt_anchor{position:relative;display:inline-flex;align-items:center;overflow:visible}',
    /* In-flow trigger. Resting state is background-TRANSPARENT so the
       capsule reads exactly like the host's own dock statistics (no fill
       until pressed/hovered); hover and the open state take the filled
       module-platform surface — same direction as the system's buttons. */
    '.dt_trigger{display:inline-flex;align-items:center;gap:4px;height:26px;padding:0 8px;',
    'border:none;border-radius:var(--dsw-radius-md);background:transparent;',
    'font:inherit;font-size:12px;font-weight:500;line-height:1;color:var(--dsw-alias-label-secondary);cursor:pointer}',
    /* Resting (closed, untouched) capsule is fully transparent — matches the
       host's own dock statistics exactly, no fill. The filled module-platform
       surface appears only when pressed (:active), while open
       (aria-expanded), or on a genuine pointer hover on a device that hovers
       (gated so Android/touch never sticks a hover fill after a tap). */
    '.dt_trigger:active,.dt_trigger[aria-expanded="true"]{',
    'background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}',
    '@media (hover:hover){.dt_trigger:hover{',
    'background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}}',
    /* The glass panel: portaled to <body> and positioned `fixed` so it lives
       in the ROOT stacking context — the host's composer input card builds
       its own stacking context and, being a DOM sibling of the dock row,
       covers any in-document overlay that stays inside the composer. Fixed
       + a very high z-index (just under dsh-web-mobile's topmost 2147483000
       error badge) guarantees it is never buried. JS positions it in
       LAYOUT space (the geometry shim's coordinate system) snapped to the
       trigger's top edge, dead-center; the ::after arrow bridges the touch
       point. Very small shadow, per the host's own quiet elevation. */
    '.dt_panel{position:fixed;left:16px;bottom:96px;z-index:2147482000;display:flex;flex-direction:column;',
    'gap:5px;min-width:196px;padding:8px;box-sizing:border-box;',
    'border-radius:12px;pointer-events:auto;',
    'background:color-mix(in srgb, var(--dsw-alias-bg-layer-1, #1c1c1c) 52%, transparent);',
    '-webkit-backdrop-filter:blur(22px) saturate(1.35);backdrop-filter:blur(22px) saturate(1.35);',
    'border:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, #555) 65%, transparent);',
    'box-shadow:0 1px 3px color-mix(in srgb, #000 28%, transparent),',
    '0 0 0 1px color-mix(in srgb, #fff 5%, transparent);',
    'color:var(--dsw-alias-label-primary, #f2f2f2)}',
    /* A chip row: three equal-width cells, evenly spaced — content centers
       in each cell with no ragged edges. Tight padding, roomy touch height. */
    '.dt_group{display:flex;gap:5px;padding:3px;border-radius:10px;',
    'background:var(--dsw-alias-bg-module-platform)}',
    /* Every cell stretches to the same width (flex:1) and centers its
       content; action glyphs 15px, values 14px — larger and touch-friendly. */
    '.dt_btn,.dt_val{flex:1;min-width:0;display:inline-flex;align-items:center;justify-content:center;',
    'height:38px;padding:0 5px;border:none;border-radius:9px;background:0 0;font:inherit;',
    'font-size:18px;font-weight:500;line-height:1;text-align:center;',
    'color:var(--dsw-alias-label-secondary);cursor:pointer}',
    '.dt_val{font-size:18px;font-variant-numeric:tabular-nums}',
    /* Uniform cell size: the 4 action cells are <button> and the 2 value cells
       are <span>. The host dock's own button typography can out-specificity a
       flat `.dt_btn` rule, leaving the buttons smaller than the value spans
       ("only the percentage looks big"). Scope to the panel and force every
       cell to the same 18px so the row reads as one uniform control. */
    '.dt_panel .dt_btn,.dt_panel .dt_val,.dt_panel .dt_val_static{font-size:18px !important;line-height:1 !important}',
    /* Belt-and-braces: pin any wrapper span inside a cell too, so a glyph
       that is not a direct text node cannot fall back to a host span size. */
    '.dt_panel .dt_btn span,.dt_panel .dt_val span{font-size:18px !important;line-height:1 !important}',
    '.dt_btn:hover:not(:disabled),.dt_val:hover:not(.dt_val_static){background:var(--dsw-alias-bg-layer-1);',
    'color:var(--dsw-alias-label-primary)}',
    '.dt_btn:disabled{color:var(--dsw-alias-label-caption);cursor:default}',
    /* A non-interactive value readout (the panel zoom number): no pointer, no
       hover fill, no tap action — the reset lives only in the settings row. */
    '.dt_val_static{cursor:default}',
    '.dt_val_static:hover{background:0 0;color:var(--dsw-alias-label-secondary)}',
    '.dt_trigger:focus-visible,.dt_btn:focus-visible{',
    'outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}',
    '.dt_trigger,.dt_btn,.dt_val{-webkit-tap-highlight-color:transparent;touch-action:manipulation}',
    /* Down-pointing arrow on the panel's bottom edge, centered, aimed at
       the trigger directly below. */
    '.dt_panel::after{content:"";position:absolute;bottom:-5px;left:50%;width:9px;height:9px;',
    'transform:translateX(-50%) rotate(45deg);',
    'background:color-mix(in srgb, var(--dsw-alias-bg-layer-1, #1c1c1c) 85%, transparent);',
    'border-right:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, #555) 65%, transparent);',
    'border-bottom:1px solid color-mix(in srgb, var(--dsw-alias-border-l1, #555) 65%, transparent)}'
  ].join('');

  /**
   * The two control stylesheets are injected into <head> as one plain DOM
   * node at module materialization — never rendered inside a slot's React
   * tree. Slot composers own how they render registrant output; a
   * `<style>` element inside that output is not guaranteed to survive
   * (some composers flatten or isolate it, and its CSS source has been
   * observed leaking to the visible page as plain text). Head injection
   * keeps the styling out of the slot system entirely, like the host's
   * own bootstrap stylesheet does.
   */
  var controlStyleElement = null;

  function installControlStyles() {
    if (controlStyleElement !== null || typeof document === 'undefined') return;
    var el = document.createElement('style');
    el.textContent = DOCK_CSS + '\n' + ROW_CSS;
    el.setAttribute('data-dsh-dpi-tuner', 'controls');
    var parent = document.head !== null ? document.head : document.documentElement;
    if (parent === null) return;
    parent.appendChild(el);
    controlStyleElement = el;
  }

  function restoreControlStyles() {
    if (controlStyleElement === null) return;
    var el = controlStyleElement;
    controlStyleElement = null;
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  /**
   * Settings-row styling copied from the host's own General preference rows
   * (the same paddings, type sizes, border and hover behavior, with only
   * `--dsw-*` theme tokens so light/dark themes both apply).
   */
  var ROW_CSS = [
    '.dt_row{display:flex;align-items:center;gap:8px;padding:16px 0;',
    'border-bottom:.5px solid var(--dsw-alias-border-l2)}',
    '.dt_text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}',
    '.dt_title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
    '.dt_desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
    '.dt_control{display:inline-flex;align-items:center;gap:8px}',
    '.dt_stepper{display:inline-flex;align-items:center;justify-content:center;min-width:96px;',
    'height:36px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);position:relative}',
    '.dt_value{min-width:48px;text-align:center;font-variant-numeric:tabular-nums;',
    'color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}',
    '.dt_arrows{position:absolute;right:8px;display:flex;flex-direction:column;gap:2px;opacity:0}',
    '.dt_stepper:hover .dt_arrows,.dt_stepper:focus-within .dt_arrows{opacity:1}',
    '@media (hover:none){.dt_arrows{opacity:1}}',
    '.dt_arrow{display:inline-flex;align-items:center;justify-content:center;width:17px;height:12px;',
    'padding:0;border:none;border-radius:var(--dsw-radius-xs);',
    'background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 75%, transparent);',
    'color:var(--dsw-alias-label-primary);cursor:pointer}',
    '.dt_arrow:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
    '.dt_arrow:disabled{color:var(--dsw-alias-label-caption);cursor:default}',
    '.dt_reset{font:inherit;font-size:12px;line-height:18px;padding:6px 8px;',
    'border:none;border-radius:var(--dsw-radius-sm);background:0 0;',
    'color:var(--dsw-alias-label-secondary);cursor:pointer}',
    '.dt_reset:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);',
    'color:var(--dsw-alias-label-primary)}',
    '.dt_reset:disabled{color:var(--dsw-alias-label-caption);cursor:default}',
    '.dt_arrow:focus-visible,.dt_reset:focus-visible{',
    'outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));outline-offset:2px}'
  ].join('');

  /** One chevron, sized for the stepper's arrow cells. */
  function chevron(direction) {
    var up = direction === 'up';
    return React.createElement(
      'svg',
      {
        viewBox: '0 0 12 8',
        width: 8,
        height: 6,
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block' }
      },
      React.createElement('path', {
        d: up ? 'M1 6.5 6 1.5 11 6.5' : 'M1 1.5 6 6.5 11 1.5',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round'
      })
    );
  }

  /**
   * The live zoom value for one control: subscribes to scale changes for the
   * component lifetime.
   * @returns {number} the current zoom percentage.
   */
  function useZoomScale() {
    var state = React.useState(getScale());
    var setLocalScale = state[1];
    React.useEffect(function () {
      var unsubscribeScale = subscribeScale(function () {
        setLocalScale(getScale());
      });
      return unsubscribeScale;
    }, []);
    return state[0];
  }

  //#endregion

  //#region dock control -------------------------------------------------------

  /**
   * The compact dock control: one "缩放" (Zoom) trigger button that sits at
   * the exact horizontal center of the composer dock row — the row is
   * marked position:relative at mount and the trigger is absolutely
   * centered on it, so it is the visual middle of the row regardless of
   * the host's own left-anchored statistics. Tapping it opens a floating
   * glass panel (the dsh-purge launcher's glass treatment: translucent
   * layer fill, backdrop blur/saturate, 65%-mix border, 12px radius, deep
   * soft shadow, and a small down-pointing arrow) snapped directly above
   * the trigger with no gap — right-edge aligned, re-measured on every
   * open, zoom change and window resize — so it reads as a menu that
   * unfolds upward out of the button. The panel holds the two capsule
   * chip rows, `[A− 14px A+]` (font) and `[− 100% +]` (zoom), stacked in
   * a column. A tap outside the panel or a second tap on the trigger
   * closes it. Tapping a value resets that knob (font → 14 px, zoom →
   * 100 %); full reset and the DPI readout live in the General settings
   * rows, where there is room.
   * @param {object} ctx - the plugin's client cordis context (closure).
   * @returns {Function} the registered slot component.
   */
  function makeDockCluster(ctx) {
    function DpiDock(props) {
      var translate = typeof props.t === 'function' ? props.t : fallbackTranslate;
      var scale = useZoomScale();
      useThemeChange(ctx);
      var font = readFont(ctx);

      var openState = React.useState(false);
      var open = openState[0];
      var setOpen = openState[1];
      var rootRef = React.useRef(null);
      var triggerRef = React.useRef(null);
      var panelRef = React.useRef(null);
      var posState = React.useState(null);
      var panelPos = posState[0];
      var setPanelPos = posState[1];

      /**
       * Position the (body-portaled, position:fixed) panel snapped to the
       * trigger's top edge, dead-center, with no gap. All values are in
       * LAYOUT space: the geometry shim makes getBoundingClientRect and the
       * inner dimensions report layout pixels, and a fixed offset resolves
       * against the zoomed document's layout viewport — so the two agree at
       * any interface scale. Re-measured on open, on every scale change and
       * on resize. @returns {void}
       */
      function measurePanel() {
        var trigger = triggerRef.current;
        if (trigger === null || trigger === undefined || typeof trigger.getBoundingClientRect !== 'function') return;
        var rect = null;
        try {
          rect = trigger.getBoundingClientRect();
        } catch (error) {
          return;
        }
        var vw = 0;
        var vh = 0;
        try {
          vw = window.innerWidth;
          vh = window.innerHeight;
        } catch (error) {
          return;
        }
        if (!isFinite(vw) || !isFinite(vh) || !rect) return;
        var panelW = (panelRef.current && panelRef.current.offsetWidth) || 176;
        var centerX = (rect.left + rect.right) / 2;
        var left = Math.round(centerX - panelW / 2);
        left = Math.max(8, Math.min(vw - panelW - 8, left));
        var bottom = Math.max(0, Math.round(vh - rect.top));
        setPanelPos({ left: left, bottom: bottom });
      }

      // While open: position the panel now and keep it in place through a
      // zoom change (layout rescales) or a window resize (dock moves). The
      // composer can also finish laying out a beat after the panel opens
      // (and a successful height compensation shifts the dock row), so settle
      // the position across two rAFs plus a short timer — cheap, and it
      // removes the "first open after a refresh is off" case.
      React.useEffect(function () {
        if (!open) return undefined;
        measurePanel();
        var r1 = null;
        var r2 = null;
        var timer = null;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          r1 = window.requestAnimationFrame(function () {
            measurePanel();
            r2 = window.requestAnimationFrame(measurePanel);
          });
        }
        if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
          timer = window.setTimeout(measurePanel, 60);
        }
        window.addEventListener('resize', measurePanel);
        return function () {
          window.removeEventListener('resize', measurePanel);
          if (r1 !== null && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(r1);
          if (r2 !== null && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(r2);
          if (timer !== null && typeof window.clearTimeout === 'function') window.clearTimeout(timer);
        };
      }, [open, scale]);

      // A tap outside the control collapses the menu; the trigger toggles
      // it. The panel lives in a body portal, so "inside" is either the
      // dock root OR the portaled panel.
      React.useEffect(function () {
        if (!open) return undefined;
        function onPointerDown(event) {
          var target = event.target;
          var root = rootRef.current;
          var panel = panelRef.current;
          if (root && root.contains(target)) return;
          if (panel && panel.contains(target)) return;
          setOpen(false);
        }
        document.addEventListener('pointerdown', onPointerDown, true);
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true);
        };
      }, [open]);

      var dockButton = function (className, label, title, disabled, onClick, child) {
        return React.createElement(
          'button',
          {
            type: 'button',
            className: className,
            'aria-label': label,
            title: title,
            disabled: disabled,
            onClick: onClick
          },
          child
        );
      };

      var chip = function (key, label, items) {
        return React.createElement(
          'div',
          { key: key, className: 'dt_group', role: 'group', 'aria-label': label },
          items
        );
      };

      // A single plain div in the dock — no <style> or Fragment at the
      // slot root (style elements inside slot output have been observed
      // leaking their CSS source to the visible page; control styles live
      // in <head> via installControlStyles). The open panel is portaled to
      // the app root so it escapes the composer's own stacking context
      // (the input card would otherwise bury an in-document overlay); it is
      // position:fixed with a z-index far above the composer, JS-positioned
      // in layout space and snapped to the trigger's top edge.
      function portalTarget() {
        var t = null;
        try {
          t = document.getElementById('root') || document.body;
        } catch (error) {
          t = document.body;
        }
        return t;
      }

      // Mount the panel in the app root / body so it escapes the composer's
      // stacking context. Fall back to rendering in place if this React
      // build has no createPortal (still position:fixed, so it just loses the
      // z-index escape).
      function mountPanel(panelElement) {
        if (typeof React.createPortal === 'function') {
          return React.createPortal(panelElement, portalTarget());
        }
        return panelElement;
      }

      return React.createElement(
        'div',
        {
          ref: rootRef,
          className: 'dt_root',
          role: 'group',
          'aria-label': translate('menuLabel')
        },
          React.createElement(
            'div',
            { className: 'dt_anchor' },
              React.createElement(
                'button',
                {
                  key: 'trigger',
                  ref: triggerRef,
                  type: 'button',
                  className: 'dt_trigger',
                  'aria-expanded': open,
                  'aria-haspopup': 'true',
                  title: translate('menuLabel'),
                  onClick: function () {
                    setOpen(!open);
                  }
                },
                translate('menuLabel'),
                chevron(open ? 'up' : 'down')
              )
          ),
          open
            ? mountPanel(
                React.createElement(
                  'div',
                  {
                    key: 'panel',
                    ref: panelRef,
                    className: 'dt_panel',
                    role: 'group',
                    'aria-label': translate('zoomTitle'),
                    style: panelPos !== null
                      ? { left: panelPos.left + 'px', bottom: panelPos.bottom + 'px' }
                      : undefined
                  },
                  chip('font', translate('fontTitle'), [
                    dockButton('dt_btn', translate('decreaseFont'), translate('decreaseFont'),
                      font <= FONT_MIN, function () { writeFont(ctx, font - 1); },
                      'A\u2212'),
                    dockButton('dt_val', translate('resetFont'), translate('resetFont'),
                      font === FONT_DEFAULT, function () { writeFont(ctx, FONT_DEFAULT); },
                      String(font) + 'px'),
                    dockButton('dt_btn', translate('increaseFont'), translate('increaseFont'),
                      font >= FONT_MAX, function () { writeFont(ctx, font + 1); },
                      'A+')
                  ]),
                  chip('zoom', translate('zoomTitle'), [
                    dockButton('dt_btn', translate('decreaseZoom'), translate('decreaseZoom'),
                      scale <= MIN_SCALE, function () { setScale(scale - STEP); }, '\u2212'),
                    // The zoom value is a plain readout, not a tap target:
                    // tapping it to reset to 100 % was removed (at a small
                    // interface zoom the panel is easy to mis-tap). The reset
                    // is reachable only from the General settings row.
                    React.createElement(
                      'span',
                      {
                        key: 'zoom-value',
                        className: 'dt_val dt_val_static',
                        'aria-label': translate('zoomValueLabel')
                      },
                      String(scale) + translate('valueUnit')
                    ),
                    dockButton('dt_btn', translate('increaseZoom'), translate('increaseZoom'),
                      scale >= MAX_SCALE, function () { setScale(scale + STEP); }, '+')
                  ])
                )
              )
            : null
      );
    }
    return DpiDock;
  }

  //#endregion

  //#region settings rows ------------------------------------------------------

  /**
   * The two General-settings rows: interface zoom (with the detected display
   * scale) and conversation font size, each a stepper plus a reset.
   * @param {object} ctx - the plugin's client cordis context (closure).
   * @returns {Function} the registered slot component.
   */
  function makeSettingsRows(ctx) {
    function DpiRows(props) {
      var translate = typeof props.t === 'function' ? props.t : fallbackTranslate;
      var scale = useZoomScale();
      useThemeChange(ctx);
      var font = readFont(ctx);
      var displayState = React.useState(detectDisplayScale());
      var displayScale = displayState[0];
      var setDisplayScale = displayState[1];

      React.useEffect(function () {
        function refreshDisplayScale() {
          setDisplayScale(detectDisplayScale());
        }
        window.addEventListener('resize', refreshDisplayScale);
        return function () {
          window.removeEventListener('resize', refreshDisplayScale);
        };
      }, []);

      var stepper = function (value, unit, increaseLabel, decreaseLabel, atMin, atMax, onStep) {
        return React.createElement(
          'div',
          { className: 'dt_stepper' },
          React.createElement('span', {
            className: 'dt_value',
            children: String(value) + unit
          }),
          React.createElement(
            'span',
            { className: 'dt_arrows', 'aria-hidden': 'true' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dt_arrow',
                'aria-label': increaseLabel,
                title: increaseLabel,
                disabled: atMax,
                onClick: function () { onStep(1); }
              },
              chevron('up')
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dt_arrow',
                'aria-label': decreaseLabel,
                title: decreaseLabel,
                disabled: atMin,
                onClick: function () { onStep(-1); }
              },
              chevron('down')
            )
          )
        );
      };

      // No <style> child: row styles come from the <head> injection
      // (installControlStyles), keeping the slot tree plain elements.
      return React.createElement(
        React.Fragment,
        null,
        // Row 1: interface zoom
        React.createElement(
          'div',
          { key: 'zoom-row', className: 'dt_row' },
          React.createElement(
            'div',
            { className: 'dt_text' },
            React.createElement('div', { className: 'dt_title', children: translate('zoomTitle') }),
            React.createElement('div', {
              className: 'dt_desc',
              children: translate('zoomDesc', { dpi: displayScale })
            })
          ),
          React.createElement(
            'div',
            { className: 'dt_control' },
            stepper(scale, translate('valueUnit'), translate('increaseZoom'), translate('decreaseZoom'),
              scale <= MIN_SCALE, scale >= MAX_SCALE, function (dir) {
                setScale(scale + dir * STEP);
              }),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dt_reset',
                title: translate('resetZoom'),
                disabled: scale === DEFAULT_SCALE,
                onClick: function () { setScale(DEFAULT_SCALE); }
              },
              translate('resetZoom')
            )
          )
        ),
        // Row 2: conversation font size
        React.createElement(
          'div',
          { key: 'font-row', className: 'dt_row' },
          React.createElement(
            'div',
            { className: 'dt_text' },
            React.createElement('div', { className: 'dt_title', children: translate('fontTitle') }),
            React.createElement('div', {
              className: 'dt_desc',
              children: translate('fontDesc')
            })
          ),
          React.createElement(
            'div',
            { className: 'dt_control' },
            stepper(font, 'px', translate('increaseFont'), translate('decreaseFont'),
              font <= FONT_MIN, font >= FONT_MAX, function (dir) {
                writeFont(ctx, font + dir);
              }),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dt_reset',
                title: translate('resetFont'),
                disabled: font === FONT_DEFAULT,
                onClick: function () { writeFont(ctx, FONT_DEFAULT); }
              },
              translate('resetFont')
            )
          )
        )
      );
    }
    return DpiRows;
  }

  //#endregion

  // Install the geometry shim as early as this artifact materializes, then
  // apply the stored preference before the shell's first React mount, so the
  // app is never painted at the wrong scale and then corrected. Control
  // styles go into <head> the same way, ahead of the first dock paint.
  installZoomGeometryShim();
  applyDocumentScale(currentScale);
  installControlStyles();

  // A window resize changes the viewport the zoom must fill, so re-measure the
  // adaptive height compensation. Cheap no-op while at 100 % zoom.
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', function () {
      scheduleAdaptiveCompensation();
    });
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({
      id: PLUGIN_ID,
      factory: function (require) {
        React = require('react');

        return {
          inject: ['slots', 'locale'],
          /**
           * Client plugin body: keep the document at the remembered scale, own
           * the locale dictionaries, and contribute the dock cluster and the
           * General rows.
           * @param {object} ctx - the plugin's client cordis context.
           */
          apply: function (ctx) {
            localeFace = ctx.locale;

            // Keep JS-visible geometry in the coordinate space CSS uses while
            // the document is zoomed (see the shim region above).
            ctx.effect(function () {
              installZoomGeometryShim();
              return uninstallZoomGeometryShim;
            }, PLUGIN_ID + ': zoom geometry shim');

            ctx.effect(function () {
              applyDocumentScale(getScale());
              return restoreDocumentScale;
            }, PLUGIN_ID + ': document scale');

            // Control styles live in <head>, not inside any slot's React
            // tree; the effect (re-)installs them and removes the node on
            // unload so the page keeps no trace.
            ctx.effect(function () {
              installControlStyles();
              return restoreControlStyles;
            }, PLUGIN_ID + ': control styles');

            // Another tab (same origin) changed the preference: follow it.
            ctx.effect(function () {
              function onStorage(event) {
                if (!event || event.key !== STORAGE_KEY) return;
                var next = readStoredScale(STORAGE_KEY);
                if (next !== null) adoptExternalScale(next);
              }
              window.addEventListener('storage', onStorage);
              return function () {
                window.removeEventListener('storage', onStorage);
              };
            }, PLUGIN_ID + ': storage sync');

            // dsh-web-mobile publishes a new visible-viewport height every time
            // the physical viewport or the soft keyboard settles (it dispatches
            // the `dsh-mobile-visible-band` document event). Re-run the
            // adaptive compensation at that moment. This covers the refresh
            // case where the host's main frame height is set only *after* the
            // initial rAF retries have given up — the band event fires when
            // web-mobile publishes the value, so we catch it no matter how
            // late. No-op on a host without dsh-web-mobile.
            ctx.effect(function () {
              function onVisibleBand() {
                scheduleAdaptiveCompensation();
              }
              document.addEventListener('dsh-mobile-visible-band', onVisibleBand);
              return function () {
                document.removeEventListener('dsh-mobile-visible-band', onVisibleBand);
              };
            }, PLUGIN_ID + ': web-mobile visible band');

            // Ctrl(⌘)+wheel adjusts the interface zoom; the capture listener
            // also cancels the platform's own wheel zoom for this page.
            ctx.effect(function () {
              window.addEventListener('wheel', handleZoomWheel, { capture: true, passive: false });
              return function () {
                window.removeEventListener('wheel', handleZoomWheel, { capture: true });
                if (wheelResetTimer !== null) {
                  clearTimeout(wheelResetTimer);
                  wheelResetTimer = null;
                }
              };
            }, PLUGIN_ID + ': ctrl+wheel');

            ctx.effect(function () {
              return ctx.locale.register(LOCALE_NS, 'en', EN);
            }, PLUGIN_ID + ': en dictionary');
            ctx.effect(function () {
              return ctx.locale.register(LOCALE_NS, 'zh', ZH);
            }, PLUGIN_ID + ': zh dictionary');

            // The "缩放" trigger button, below the composer; tapping it opens
            // the floating glass panel with the two capsule chip rows.
            // order 0.5 sorts it numerically between the host's two dock
            // stats (activity=0, usage=1), so the in-flow occupant lands in
            // the middle of the row and its flex:1 root centers the pill
            // there — without overlaying the host's statistics.
            ctx.slots.inject('conversation.composer.dock', function () {
              return ctx.slots.register({
                name: 'conversation.composer.dock',
                id: 'dpi-tuner',
                order: 0.5,
                locale: LOCALE_NS
              }, makeDockCluster(ctx));
            });

            // The two detailed preference rows, General section.
            ctx.slots.inject('settings.general.item', function () {
              return ctx.slots.register({
                name: 'settings.general.item',
                id: 'dpi-tuner',
                order: 14,
                locale: LOCALE_NS
              }, makeSettingsRows(ctx));
            });
          }
        };
      }
    });
  }
})();
