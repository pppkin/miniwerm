import { WASM_BASE64 } from "./wasm-inline.js";
function decodeBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++)
        bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}
export class WasmBridge {
    get dv() {
        if (this._dvBuffer !== this.memory.buffer) {
            this._dvBuffer = this.memory.buffer;
            this._dv = new DataView(this.memory.buffer);
        }
        return this._dv;
    }
    constructor(instance) {
        this.gridPtr = 0;
        this.dirtyPtr = 0;
        this.writeBufferPtr = 0;
        this.cellSize = 12;
        this.maxCols = 256;
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this._dvBuffer = null;
        this.linkCache = new Map();
        this.exports = instance.exports;
        this.memory = this.exports.memory;
    }
    static async load(url) {
        let bytes;
        if (url) {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`[wterm] Failed to load WASM from ${url}: ${response.status} ${response.statusText}`);
            }
            bytes = await response.arrayBuffer();
        }
        else {
            bytes = decodeBase64(WASM_BASE64);
        }
        const { instance } = await WebAssembly.instantiate(bytes);
        return new WasmBridge(instance);
    }
    init(cols, rows) {
        this.exports.init(cols, rows);
        this.linkCache.clear();
        this._updatePointers();
    }
    _updatePointers() {
        this.gridPtr = this.exports.getGridPtr();
        this.dirtyPtr = this.exports.getDirtyPtr();
        this.writeBufferPtr = this.exports.getWriteBuffer();
        this.cellSize = this.exports.getCellSize();
        this.maxCols = this.exports.getMaxCols();
    }
    writeString(str, afterChunk) {
        const encoded = this.encoder.encode(str);
        this.writeRaw(encoded, afterChunk);
    }
    writeRaw(data, afterChunk) {
        let offset = 0;
        while (offset < data.length) {
            const chunk = Math.min(data.length - offset, 8192);
            const buf = new Uint8Array(this.memory.buffer, this.writeBufferPtr, 8192);
            buf.set(data.subarray(offset, offset + chunk));
            this.exports.writeBytes(chunk);
            offset += chunk;
            afterChunk?.();
        }
    }
    getCell(row, col) {
        const offset = this.gridPtr + (row * this.maxCols + col) * this.cellSize;
        const dv = this.dv;
        const result = {
            char: dv.getUint32(offset, true),
            fg: dv.getUint16(offset + 4, true),
            bg: dv.getUint16(offset + 6, true),
            flags: dv.getUint8(offset + 8),
            width: dv.getUint8(offset + 9),
        };
        Object.assign(result, this._readLink(dv.getUint16(offset + 10, true)));
        return result;
    }
    isDirtyRow(row) {
        return new Uint8Array(this.memory.buffer, this.dirtyPtr, 256)[row] !== 0;
    }
    clearDirty() {
        this.exports.clearDirty();
    }
    getCursor() {
        return {
            row: this.exports.getCursorRow(),
            col: this.exports.getCursorCol(),
            visible: this.exports.getCursorVisible() !== 0,
        };
    }
    getCols() {
        return this.exports.getCols();
    }
    getRows() {
        return this.exports.getRows();
    }
    cursorKeysApp() {
        return this.exports.getCursorKeysApp() !== 0;
    }
    bracketedPaste() {
        return this.exports.getBracketedPaste() !== 0;
    }
    usingAltScreen() {
        return this.exports.getUsingAltScreen() !== 0;
    }
    mouseTracking() {
        const mode = this.exports.getMouseTracking();
        return mode === 1000 || mode === 1002 ? mode : 0;
    }
    mouseSgr() {
        return this.exports.getMouseSgr() !== 0;
    }
    focusEvents() {
        return this.exports.getFocusEvents() !== 0;
    }
    synchronizedOutput() {
        return this.exports.getSynchronizedOutput() !== 0;
    }
    synchronizedOutputGeneration() {
        return this.exports.getSynchronizedOutputGeneration();
    }
    kittyKeyboardFlags() {
        return this.exports.getKittyKeyboardFlags?.() ?? 0;
    }
    getTitle() {
        if (this.exports.getTitleChanged() === 0)
            return null;
        const ptr = this.exports.getTitlePtr();
        const len = this.exports.getTitleLen();
        const bytes = new Uint8Array(this.memory.buffer, ptr, len);
        return this.decoder.decode(bytes);
    }
    getResponse() {
        const len = this.exports.getResponseLen();
        if (len === 0)
            return null;
        const ptr = this.exports.getResponsePtr();
        const bytes = new Uint8Array(this.memory.buffer, ptr, len);
        const str = this.decoder.decode(bytes);
        this.exports.clearResponse();
        return str;
    }
    getResourceState() {
        const capacity = this.exports.getHyperlinkCapacity?.();
        const used = this.exports.getHyperlinkCount?.();
        const rejected = this.exports.getHyperlinkRejectedCount?.();
        if (capacity === undefined ||
            used === undefined ||
            rejected === undefined) {
            return {};
        }
        return {
            hyperlinks: {
                capacity,
                used,
                rejected,
                saturated: used >= capacity,
            },
        };
    }
    getScrollbackCount() {
        return this.exports.getScrollbackCount();
    }
    getScrollbackDiscardedCount() {
        return this.exports.getScrollbackDiscardedCount();
    }
    getScrollbackCell(offset, col) {
        const ptr = this.exports.getScrollbackLine(offset);
        const off = ptr + col * this.cellSize;
        const dv = this.dv;
        const result = {
            char: dv.getUint32(off, true),
            fg: dv.getUint16(off + 4, true),
            bg: dv.getUint16(off + 6, true),
            flags: dv.getUint8(off + 8),
            width: dv.getUint8(off + 9),
        };
        Object.assign(result, this._readLink(dv.getUint16(off + 10, true)));
        return result;
    }
    getScrollbackLineLen(offset) {
        return this.exports.getScrollbackLineLen(offset);
    }
    getUnhandledSequences() {
        const count = this.exports.getDebugLogCount();
        if (count === 0)
            return [];
        const ptr = this.exports.getDebugLogPtr();
        const entrySize = this.exports.getDebugLogEntrySize();
        const maxEntries = this.exports.getDebugLogMax();
        const total = Math.min(count, maxEntries);
        const dv = new DataView(this.memory.buffer);
        const entries = [];
        const startIdx = count >= maxEntries ? count % maxEntries : 0;
        for (let i = 0; i < total; i++) {
            const idx = (startIdx + i) % maxEntries;
            const off = ptr + idx * entrySize;
            const finalByte = dv.getUint8(off);
            if (finalByte === 0)
                continue;
            const privateByte = dv.getUint8(off + 1);
            const paramCount = dv.getUint8(off + 2);
            const params = [];
            for (let p = 0; p < Math.min(paramCount, 4); p++) {
                params.push(dv.getUint16(off + 4 + p * 2, true));
            }
            entries.push({
                final: String.fromCharCode(finalByte),
                private: privateByte ? String.fromCharCode(privateByte) : "",
                paramCount,
                params,
            });
        }
        return entries;
    }
    resize(cols, rows) {
        this.exports.resizeTerminal(cols, rows);
        this._updatePointers();
    }
    _readLink(index) {
        if (index === 0)
            return undefined;
        const cached = this.linkCache.get(index);
        if (cached)
            return cached;
        const uriLen = this.exports.getLinkUriLen(index);
        if (uriLen === 0)
            return undefined;
        const uri = this.decoder.decode(new Uint8Array(this.memory.buffer, this.exports.getLinkUriPtr(index), uriLen));
        const idLen = this.exports.getLinkIdLen(index);
        const linkId = idLen === 0
            ? undefined
            : this.decoder.decode(new Uint8Array(this.memory.buffer, this.exports.getLinkIdPtr(index), idLen));
        const value = {
            linkUri: uri,
            linkId,
            linkKey: linkId ? `e\0${linkId}\0${uri}` : `b\0${index}`,
        };
        this.linkCache.set(index, value);
        return value;
    }
}
