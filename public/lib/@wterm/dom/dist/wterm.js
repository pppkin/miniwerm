import { WasmBridge } from "@wterm/core";
import { Renderer } from "./renderer.js";
import { InputHandler } from "./input.js";
import { DebugAdapter } from "./debug.js";
import { isLinkActivationModifier } from "./hyperlink.js";
const SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 1000;
const PROGRAMMATIC_SCROLL_TOLERANCE = 1;
const WINDOW_SIZE_QUERIES = ["\x1b[14t", "\x1b[16t"];
export class WTerm {
    constructor(element, options = {}) {
        this.bridge = null;
        this.debug = null;
        this.renderer = null;
        this.input = null;
        this.rafId = null;
        this._synchronizedOutputTimer = null;
        this._synchronizedOutputState = "idle";
        this._synchronizedOutputGeneration = 0;
        this._rendererNeedsSetup = false;
        this.resizeObserver = null;
        this._destroyed = false;
        this._shouldScrollToBottom = false;
        this._scrollbackDiscardedCount = 0;
        this._programmaticScrollTop = null;
        this._pendingResizeScrollTop = null;
        this._rowHeight = 0;
        this._charWidth = 0;
        this._windowSizeQueryBuffer = "";
        this.element = element;
        this._coreOption = options.core;
        this.wasmUrl = options.wasmUrl;
        this.maxImageWidth = options.maxImageWidth;
        this.maxImageHeight = options.maxImageHeight;
        this.cols = options.cols || 80;
        this.rows = options.rows || 24;
        this.autoResize = options.autoResize !== false;
        this._debugEnabled = options.debug ?? false;
        this.onData = options.onData || null;
        this.onTitle = options.onTitle || null;
        this.onResize = options.onResize || null;
        this._container = document.createElement("div");
        this._container.className = "term-grid";
        this.element.appendChild(this._container);
        this.element.classList.add("wterm");
        if (options.cursorBlink)
            this.element.classList.add("cursor-blink");
        this._onClickFocus = (event) => {
            const target = event.target;
            if (target instanceof Element && target.closest(".term-link")) {
                if (isLinkActivationModifier(event, this.element.ownerDocument.defaultView?.navigator ?? navigator) ||
                    event.detail === 0) {
                    return;
                }
                event.preventDefault();
            }
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed)
                this.input?.focus();
        };
        this.element.addEventListener("click", this._onClickFocus);
        this._onModifierChange = (event) => {
            this.element.classList.toggle("link-modifier-active", isLinkActivationModifier(event, this.element.ownerDocument.defaultView?.navigator ?? navigator));
        };
        this._onWindowBlur = () => {
            this.element.classList.remove("link-modifier-active");
        };
        this.element.ownerDocument.addEventListener("keydown", this._onModifierChange);
        this.element.ownerDocument.addEventListener("keyup", this._onModifierChange);
        this.element.ownerDocument.defaultView?.addEventListener("blur", this._onWindowBlur);
        this._onScroll = () => {
            if (this._pendingResizeScrollTop !== null)
                return;
            if (this._shouldScrollToBottom && this._isScrolledToBottom()) {
                this._programmaticScrollTop = null;
                return;
            }
            if (this._programmaticScrollTop !== null &&
                Math.abs(this.element.scrollTop - this._programmaticScrollTop) <=
                    PROGRAMMATIC_SCROLL_TOLERANCE) {
                this._programmaticScrollTop = null;
                return;
            }
            this._programmaticScrollTop = null;
            this._shouldScrollToBottom = false;
            this._scheduleRender();
        };
        this.element.addEventListener("scroll", this._onScroll, { passive: true });
    }
    async init() {
        try {
            if (this._coreOption) {
                this.bridge = this._coreOption;
            }
            else {
                this.bridge = await WasmBridge.load(this.wasmUrl);
            }
            if (this._destroyed)
                return this;
            this.bridge.init(this.cols, this.rows);
            if (this._debugEnabled) {
                this.debug = new DebugAdapter();
                this.debug.setBridge(this.bridge);
                globalThis.__wterm = this;
            }
            this._setRowHeight();
            this._measureCharSize();
            this.renderer = new Renderer(this._container, {
                maxImageWidth: this.maxImageWidth,
                maxImageHeight: this.maxImageHeight,
            });
            this.renderer.setup(this.cols, this.rows);
            this.input = new InputHandler(this.element, (data) => {
                this._scrollToBottom();
                if (this.onData) {
                    this.onData(data);
                }
                else {
                    this.write(data);
                }
            }, () => this.bridge, () => this._charWidth > 0 && this._rowHeight > 0
                ? { charWidth: this._charWidth, rowHeight: this._rowHeight }
                : null);
            if (this.autoResize) {
                this._setupResizeObserver();
            }
            else {
                this._lockHeight();
            }
            this.input.focus();
            this._initialRender();
        }
        catch (err) {
            this.destroy();
            throw new Error(`wterm: failed to initialize: ${err instanceof Error ? err.message : err}`);
        }
        return this;
    }
    _isScrolledToBottom() {
        const el = this.element;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 5;
    }
    _scrollToBottom() {
        this._setScrollTop(this.element.scrollHeight);
    }
    _setScrollTop(value) {
        const before = this.element.scrollTop;
        this.element.scrollTop = value;
        const after = this.element.scrollTop;
        if (after === before)
            return;
        this._programmaticScrollTop = after;
    }
    write(data) {
        if (!this.bridge)
            return;
        if (this.debug)
            this.debug.traceWrite(data);
        this._shouldScrollToBottom = this._isScrolledToBottom();
        const windowSizeQueries = this._collectWindowSizeQueries(data);
        let deliveryError;
        let hasDeliveryError = false;
        const drain = () => {
            const result = this._drainResponses();
            if (!hasDeliveryError && result.hasError) {
                hasDeliveryError = true;
                deliveryError = result.error;
            }
        };
        if (typeof data === "string") {
            this.bridge.writeString(data, drain);
        }
        else {
            this.bridge.writeRaw(data, drain);
        }
        const synchronized = this.bridge.synchronizedOutput?.() ?? false;
        const generation = this.bridge.synchronizedOutputGeneration?.() ?? 0;
        this._updateSynchronizedOutput(synchronized, generation);
        if (this._synchronizedOutputState !== "held") {
            this._setupRendererIfNeeded();
            this._scheduleRender();
        }
        drain();
        for (const query of windowSizeQueries) {
            try {
                this.onData?.(this._windowSizeResponse(query));
            }
            catch (error) {
                if (!hasDeliveryError) {
                    hasDeliveryError = true;
                    deliveryError = error;
                }
            }
        }
        if (hasDeliveryError)
            throw deliveryError;
    }
    resize(cols, rows) {
        if (!this.bridge)
            return;
        this._shouldScrollToBottom =
            this._pendingResizeScrollTop === null && this._isScrolledToBottom();
        this.cols = cols;
        this.rows = rows;
        this.bridge.resize(cols, rows);
        const synchronized = this.bridge.synchronizedOutput?.() ?? false;
        const generation = this.bridge.synchronizedOutputGeneration?.() ?? 0;
        if (this._updateSynchronizedOutput(synchronized, generation)) {
            this._rendererNeedsSetup = true;
        }
        else {
            this._setupRenderer(cols, rows);
            this._scheduleRender();
        }
        if (this.onResize)
            this.onResize(cols, rows);
    }
    focus() {
        if (this.input) {
            this.input.focus();
        }
        else {
            this.element.focus();
        }
    }
    _scheduleRender() {
        if (this.rafId != null)
            return;
        this.rafId = requestAnimationFrame(() => {
            this.rafId = null;
            this._doRender();
        });
    }
    _cancelScheduledRender() {
        if (this.rafId != null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }
    _updateSynchronizedOutput(synchronized, generation) {
        if (!synchronized) {
            if (this._synchronizedOutputState === "held") {
                this._cancelSynchronizedOutputFallback();
            }
            this._synchronizedOutputState = "idle";
            return false;
        }
        if (this._synchronizedOutputState === "held" &&
            generation !== this._synchronizedOutputGeneration) {
            this._armSynchronizedOutputFallback(generation);
            return true;
        }
        else if (this._synchronizedOutputState === "passthrough" &&
            generation !== this._synchronizedOutputGeneration) {
            this._synchronizedOutputState = "idle";
        }
        if (this._synchronizedOutputState !== "idle") {
            return this._synchronizedOutputState === "held";
        }
        this._synchronizedOutputState = "held";
        this._cancelScheduledRender();
        this._armSynchronizedOutputFallback(generation);
        return true;
    }
    _armSynchronizedOutputFallback(generation) {
        this._cancelSynchronizedOutputFallback();
        this._synchronizedOutputGeneration = generation;
        this._synchronizedOutputTimer = setTimeout(() => {
            if (this._synchronizedOutputState !== "held" ||
                this._synchronizedOutputGeneration !== generation) {
                return;
            }
            this._synchronizedOutputTimer = null;
            this._synchronizedOutputState = "passthrough";
            this._setupRendererIfNeeded();
            this._cancelScheduledRender();
            this._doRender();
        }, SYNCHRONIZED_OUTPUT_TIMEOUT_MS);
    }
    _cancelSynchronizedOutputFallback() {
        if (this._synchronizedOutputTimer == null)
            return;
        clearTimeout(this._synchronizedOutputTimer);
        this._synchronizedOutputTimer = null;
    }
    _setupRendererIfNeeded() {
        if (!this._rendererNeedsSetup)
            return;
        this._setupRenderer(this.cols, this.rows);
        this._rendererNeedsSetup = false;
    }
    _setupRenderer(cols, rows) {
        if (!this._shouldScrollToBottom && this._pendingResizeScrollTop === null) {
            this._pendingResizeScrollTop = this.element.scrollTop;
        }
        this.renderer?.setup(cols, rows);
    }
    _initialRender() {
        this._doRender();
    }
    _doRender() {
        if (!this.bridge || !this.renderer)
            return;
        let dirtyCount = 0;
        const t0 = this.debug ? performance.now() : 0;
        if (this.debug) {
            for (let r = 0; r < this.rows; r++) {
                if (this.bridge.isDirtyRow(r))
                    dirtyCount++;
            }
        }
        const rowHeight = this._rowHeight || 17;
        const scrollbackCount = this.bridge.getScrollbackCount();
        const discardedCount = this.bridge.getScrollbackDiscardedCount?.();
        const discardedDelta = discardedCount !== undefined &&
            discardedCount >= this._scrollbackDiscardedCount
            ? discardedCount - this._scrollbackDiscardedCount
            : 0;
        if (discardedCount !== undefined) {
            this._scrollbackDiscardedCount = discardedCount;
        }
        let scrollTop = this._pendingResizeScrollTop !== null
            ? this._pendingResizeScrollTop
            : this.element.scrollTop;
        if (!this._shouldScrollToBottom && discardedDelta > 0) {
            scrollTop = Math.max(0, scrollTop - discardedDelta * rowHeight);
            if (this._pendingResizeScrollTop !== null) {
                this._pendingResizeScrollTop = scrollTop;
            }
            else {
                this._setScrollTop(scrollTop);
            }
        }
        this.renderer.render(this.bridge, {
            scrollTop: this._shouldScrollToBottom
                ? Math.max(0, (scrollbackCount + this.rows) * rowHeight -
                    this.element.clientHeight)
                : scrollTop,
            clientHeight: this.element.clientHeight,
            rowHeight,
            scrollbackDiscardedCount: discardedCount,
            charWidth: this._charWidth,
        });
        if (this.debug) {
            this.debug.recordRender(performance.now() - t0, dirtyCount);
        }
        const hasScrollback = scrollbackCount > 0 || this.renderer.hasImageFlow;
        this.element.classList.toggle("has-scrollback", hasScrollback);
        if (this._shouldScrollToBottom) {
            this._scrollToBottom();
        }
        else if (this._pendingResizeScrollTop !== null) {
            const pendingScrollTop = this._pendingResizeScrollTop;
            this._pendingResizeScrollTop = null;
            this._setScrollTop(pendingScrollTop);
        }
        else if (!hasScrollback && this.element.scrollTop !== 0) {
            this._setScrollTop(0);
        }
        const title = this.bridge.getTitle();
        if (title !== null && this.onTitle) {
            this.onTitle(title);
        }
        this._drainResponses();
    }
    _drainResponses() {
        if (!this.bridge)
            return { hasError: false };
        let response;
        let firstError;
        let hasError = false;
        while ((response = this.bridge.getResponse()) !== null) {
            try {
                if (this.onData)
                    this.onData(response);
            }
            catch (error) {
                if (!hasError) {
                    hasError = true;
                    firstError = error;
                }
            }
        }
        return { hasError, error: firstError };
    }
    /**
     * Kitty uses xterm window reports to discover the pixel geometry needed for
     * image placement. The core intentionally does not know about the browser
     * viewport, so these two queries are answered at the DOM boundary.
     */
    _collectWindowSizeQueries(data) {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        const input = this._windowSizeQueryBuffer + text;
        this._windowSizeQueryBuffer = "";
        const queries = [];
        let index = 0;
        while (index < input.length) {
            const query = WINDOW_SIZE_QUERIES.find((candidate) => input.startsWith(candidate, index));
            if (query) {
                queries.push(query === "\x1b[14t" ? 14 : 16);
                index += query.length;
            }
            else {
                index++;
            }
        }
        // Keep only a possible prefix of a query so an escape sequence split
        // across WebSocket/WASM writes is recognized on the next write.
        for (let start = Math.max(0, input.length - 4); start < input.length; start++) {
            const suffix = input.slice(start);
            if (suffix.length < 5 &&
                WINDOW_SIZE_QUERIES.some((candidate) => candidate.startsWith(suffix))) {
                this._windowSizeQueryBuffer = suffix;
                break;
            }
        }
        return queries;
    }
    _windowSizeResponse(query) {
        const { width, height } = this._pixelSize();
        if (query === 14) {
            return `\x1b[4;${height};${width}t`;
        }
        const cellWidth = Math.max(1, Math.round(this._charWidth));
        const cellHeight = Math.max(1, Math.round(this._rowHeight));
        return `\x1b[6;${cellHeight};${cellWidth}t`;
    }
    _pixelSize() {
        const style = getComputedStyle(this.element);
        const horizontalPadding = (parseFloat(style.paddingLeft) || 0) +
            (parseFloat(style.paddingRight) || 0);
        const verticalPadding = (parseFloat(style.paddingTop) || 0) +
            (parseFloat(style.paddingBottom) || 0);
        let width = this.element.clientWidth - horizontalPadding;
        let height = this.element.clientHeight - verticalPadding;
        if (width <= 0 || height <= 0) {
            const rect = this.element.getBoundingClientRect();
            width = rect.width - horizontalPadding;
            height = rect.height - verticalPadding;
        }
        // A hidden element has no layout box. The measured cell geometry still
        // gives Kitty a useful answer while the terminal is being mounted.
        if (width <= 0 && this._charWidth > 0)
            width = this.cols * this._charWidth;
        if (height <= 0 && this._rowHeight > 0)
            height = this.rows * this._rowHeight;
        return {
            width: Math.max(1, Math.round(width)),
            height: Math.max(1, Math.round(height)),
        };
    }
    _lockHeight() {
        const rh = this._rowHeight || 17;
        const gridHeight = this.rows * rh;
        const cs = getComputedStyle(this.element);
        let extra = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        if (cs.boxSizing === "border-box") {
            extra +=
                (parseFloat(cs.borderTopWidth) || 0) +
                    (parseFloat(cs.borderBottomWidth) || 0);
        }
        this.element.style.height = `${gridHeight + extra}px`;
    }
    _setRowHeight() {
        const probe = document.createElement("div");
        probe.className = "term-row";
        probe.style.visibility = "hidden";
        probe.style.position = "absolute";
        probe.textContent = "W";
        this._container.appendChild(probe);
        const h = probe.getBoundingClientRect().height;
        probe.remove();
        if (h > 0) {
            const rh = Math.ceil(h);
            this._rowHeight = rh;
            this.element.style.setProperty("--term-row-height", `${rh}px`);
        }
    }
    _measureCharSize() {
        const row = document.createElement("div");
        row.className = "term-row";
        row.style.visibility = "hidden";
        row.style.position = "absolute";
        const probe = document.createElement("span");
        probe.textContent = "W";
        row.appendChild(probe);
        this._container.appendChild(row);
        const charWidth = probe.getBoundingClientRect().width;
        const rowHeight = row.getBoundingClientRect().height;
        row.remove();
        if (charWidth === 0 || rowHeight === 0)
            return null;
        this._charWidth = charWidth;
        this._rowHeight = rowHeight;
        return { charWidth, rowHeight };
    }
    _setupResizeObserver() {
        const initial = this._measureCharSize();
        if (!initial)
            return;
        let { charWidth, rowHeight } = initial;
        this.resizeObserver = new ResizeObserver((entries) => {
            const measured = this._measureCharSize();
            if (measured) {
                charWidth = measured.charWidth;
                rowHeight = measured.rowHeight;
            }
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                const newCols = Math.max(1, Math.floor(width / charWidth));
                const newRows = Math.max(1, Math.floor(height / rowHeight));
                if (newCols !== this.cols || newRows !== this.rows) {
                    this.resize(newCols, newRows);
                }
            }
        });
        this.resizeObserver.observe(this.element);
    }
    destroy() {
        this._destroyed = true;
        this._windowSizeQueryBuffer = "";
        this._cancelScheduledRender();
        this._cancelSynchronizedOutputFallback();
        if (this.resizeObserver)
            this.resizeObserver.disconnect();
        if (this.input)
            this.input.destroy();
        this.renderer?.destroy();
        this.renderer = null;
        this.element.removeEventListener("click", this._onClickFocus);
        this.element.removeEventListener("scroll", this._onScroll);
        this.element.ownerDocument.removeEventListener("keydown", this._onModifierChange);
        this.element.ownerDocument.removeEventListener("keyup", this._onModifierChange);
        this.element.ownerDocument.defaultView?.removeEventListener("blur", this._onWindowBlur);
        this.element.classList.remove("link-modifier-active");
        this.element.innerHTML = "";
        if (this.debug &&
            globalThis.__wterm === this) {
            delete globalThis.__wterm;
        }
        this.debug = null;
    }
}
