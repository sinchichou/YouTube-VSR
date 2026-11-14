/**
 * @file YouTube VSR - Content Script
 * @description 整合 WGFX 引擎的 YouTube 影片超解析度處理器
 */

(async function () {
    /* 重複注入防護說明:
     * 舊版以 `window.vsrInjected` 早退 — 但擴充套件「重載」後該旗標殘留在隔離世界,
     * 而舊監聽器已隨舊 context 失效 → 分頁永久失聯,直到重新整理。
     * 現行策略:每次注入都重建 controller(先 teardown 舊實例),監聽器改經
     * `window.__vsrMessageHandler` 全域轉發 — 重載後新注入的腳本能重新接手。 */

    /* === 測試接縫 / Test seam ==========================================
     * scripts/verify-content.mjs 會以 `__VSR_CONTENT_TEST__` 旗標在 Node 中
     * 執行本檔:純函式(不碰 chrome/DOM/GPU)在此先行定義並輸出為 hooks,
     * 之後直接早退,讓單元測試不必 stub 整個瀏覽器環境。
     * 正式執行(瀏覽器)時 __VSR_CONTENT_TEST__ 未定義,行為完全不變。 */
    const TEST_MODE = typeof globalThis.__VSR_CONTENT_TEST__ !== 'undefined';

    /**
     * 從 WGFX 實例解析「實際」OUTPUT 紋理尺寸。
     * ---
     * 兩種實例形狀都要支援:
     *  - `.wgx` 套件實例(WGFXPackageInstance):`resourceManager` 是**直接**屬性,
     *    並額外提供 `outWidth` / `outHeight`(升頻效果為宣告後的實際尺寸)。
     *    舊版只找 `wgfx.runtime.resourceManager` — 套件實例沒有 `runtime`,
     *    於是永遠取不到 → Canvas 以影片尺寸配置,而升頻 OUTPUT 是 2x,
     *    每幀 copyTextureToTexture 驗證失敗(3840x2160 → 1920x1080)。
     *  - （歷史)原始 `.wgsl` 實例(WGFX):輸出在 `wgfx.runtime.resourceManager`。
     *    legacy .wgsl 路徑已移除,此分支保留以防禦未來的實例形狀。
     * @param {object|null} wgfx WGFXPackageInstance
     * @returns {{width:number, height:number}|null} 取不到時回傳 null(呼叫端自行後備)
     */
    function resolveOutputSize(wgfx) {
        if (!wgfx) return null;
        let tex = null;
        try {
            const rm = wgfx.resourceManager
                || (wgfx.runtime && wgfx.runtime.resourceManager)
                || null;
            if (rm && typeof rm.getTexture === 'function') {
                tex = rm.getTexture('OUTPUT');
            }
        } catch (e) {
            tex = null; // 內部結構變動時不讓尺寸解析炸掉整個啟動流程
        }
        if (tex && tex.width > 0 && tex.height > 0) {
            return { width: tex.width, height: tex.height };
        }
        if (wgfx.outWidth > 0 && wgfx.outHeight > 0) {
            return { width: Math.floor(wgfx.outWidth), height: Math.floor(wgfx.outHeight) };
        }
        return null;
    }

    /** base64 → Uint8Array(背景 service worker 代理取檔時的傳輸格式) */
    function base64ToUint8Array(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    /**
     * 影片「內在解析度」是否真的改變了。
     * ---
     * 重啟判斷只能比對 videoWidth/Height(串流本身的尺寸),
     * 不可拿來比對 canvas.width —— Canvas 內部解析度 = 效果 OUTPUT 尺寸
     * (升頻效果是影片的 2x),兩者本來就不相等;舊版拿 canvas.width 比對,
     * 會讓 ResizeObserver 的初始回呼直接觸發 stop/start → 無限重編譯循環。
     */
    function videoResolutionChanged(lastW, lastH, w, h) {
        return w !== lastW || h !== lastH;
    }

    /**
     * 鏈結尺寸規劃:效果 i 以 (inW,inH) 編譯,其實際輸出為 outSize(可能為 null =
     * 效果不改變尺寸),回傳下一個效果的輸入尺寸。
     * @returns {{inW:number, inH:number, outW:number, outH:number}}
     */
    function nextLinkSize(inW, inH, outSize) {
        const w = Math.floor(inW);
        const h = Math.floor(inH);
        const outW = (outSize && outSize.width > 0) ? Math.floor(outSize.width) : w;
        const outH = (outSize && outSize.height > 0) ? Math.floor(outSize.height) : h;
        return { inW: w, inH: h, outW, outH };
    }

    /**
     * updateParameter 路由:依 popup 傳來的 instanceId 找對應效果實例;
     * 舊版訊息沒有 instanceId(或找不到)→ 套用到第一個效果(向後相容)。
     */
    function pickProcessorEntry(entries, instanceId) {
        if (!Array.isArray(entries) || entries.length === 0) return null;
        if (instanceId) {
            const hit = entries.find((e) => e && e.instanceId === instanceId);
            if (hit) return hit;
        }
        return entries[0];
    }

    /** 兩個 {left,top,width,height} 是否不同(髒旗標判斷;任一未知視為已變) */
    function rectsDiffer(a, b) {
        if (!a || !b) return true;
        return a.left !== b.left || a.top !== b.top
            || a.width !== b.width || a.height !== b.height;
    }

    if (TEST_MODE) {
        globalThis.__VSR_CONTENT_HOOKS__ = {
            resolveOutputSize,
            base64ToUint8Array,
            videoResolutionChanged,
            nextLinkSize,
            pickProcessorEntry,
            rectsDiffer,
        };
        return; // 測試模式:只要純函式,不要觸碰 chrome / DOM / GPU
    }

    // ===================================================================
    // [1] VSRLogger - 外部日誌工具 (Host Logic)
    // ===================================================================
    const VSRLogger = {
        _enabled: false,
        _prefix: '%c[VSR-Host]',
        _style: 'color: #00ffa2; font-weight: bold;', // 亮綠色

        setDebug(enabled) {
            this._enabled = enabled;
        },
        debug(msg, ...args) {
            if (this._enabled) console.debug(this._prefix, this._style, msg, ...args);
        },
        info(msg, ...args) {
            console.log(this._prefix, this._style, msg, ...args);
        },
        warn(msg, ...args) {
            console.warn(this._prefix, this._style, `[WARN] ${msg}`, ...args);
        },
        error(msg, ...args) {
            console.error(this._prefix, this._style, `[ERROR] ${msg}`, ...args);
        }
    };

    // ===================================================================
    // [2] 模組載入
    // ===================================================================
    let WGFXClass, WGFXPackageClass;
    try {
        // WGFX 核心庫以 ESM 匯入。此檔案由 `npm run sync:wgfx` 從已安裝的
        // wgfx 套件(node_modules/wgfx/dist)同步到 vendor/ —— 請勿手動編輯
        // vendor/ 內的檔案;更新核心庫請執行 `npm run sync:wgfx`。
        // The core library is imported as ESM; vendor/ is generated by
        // `npm run sync:wgfx` from the installed wgfx package — never edit it by hand.
        const moduleURL = chrome.runtime.getURL('vendor/wgfx.browser.esm.js');
        const module = await import(moduleURL);
        WGFXClass = module.default || module.WGFX;
        WGFXPackageClass = module.WGFXPackage;

        if (!WGFXClass) throw new Error("WGFX 類別加載失敗");
        if (!WGFXPackageClass) throw new Error("WGFXPackage 類別加載失敗（請更新 WGFX 核心庫）");
        VSRLogger.info("WGFX 核心模組已就緒");
    } catch (error) {
        VSRLogger.error("初始化失敗，無法加載 WGFX 模組", error);
        return;
    }

    // ===================================================================
    // [3] 核心組件定義
    // ===================================================================

    /**
     * WebGPU Device Manager
     * ---
     * 單例模式管理 GPUDevice 生命週期。
     */
    class GPUDeviceManager {
        constructor() {
            this.device = null;
            this.initPromise = null;
            /** 裝置遺失回呼(由 controller 設定,initialize 前指定) */
            this.onDeviceLost = null;
            this._uncapturedErrors = 0;
        }

        async initialize() {
            if (this.initPromise) return this.initPromise;
            this.initPromise = (async () => {
                if (!navigator.gpu) throw new Error("瀏覽器不支援 WebGPU");
                const adapter = await navigator.gpu.requestAdapter({
                    powerPreference: 'high-performance'
                });
                if (!adapter) throw new Error("找不到 GPU 適配器");

                this.device = await adapter.requestDevice({
                    powerPreference: 'high-performance',
                    requiredLimits: {
                        maxStorageTexturesPerShaderStage: Math.min(8, adapter.limits.maxStorageTexturesPerShaderStage)
                    }
                });

                // 裝置遺失(驅動重置、GPU 除錯器、裝置被销毀)→ 通知 controller 自動重啟
                if (this.onDeviceLost) {
                    this.device.lost.then((info) => this.onDeviceLost(info));
                }
                // 未捕捉的驗證錯誤原本只在 WebGPU 內部 console 出現;在此節流記錄,
                // 保留前幾筆完整訊息,之後抽樣,避免每幀刷屏。
                this.device.addEventListener?.('uncapturederror', (e) => {
                    this._uncapturedErrors++;
                    if (this._uncapturedErrors <= 3 || this._uncapturedErrors % 100 === 0) {
                        VSRLogger.error('WebGPU uncaptured error',
                            (e.error && e.error.message) || e.message || e);
                    }
                });

                VSRLogger.info("WebGPU 設備已建立");
                return this.device;
            })();
            return this.initPromise;
        }
    }

    /**
     * Canvas Renderer
     * ---
     * 負責將 GPU 紋理呈現至畫面的 Overlay Canvas。
     */
    class CanvasRenderer {
        constructor(device) {
            this.device = device;
            this.canvas = document.createElement('canvas');
            this.context = this.canvas.getContext('webgpu');
            this.format = null;
            this.dstW = 0;
            this.dstH = 0;
            this._dstTex = null;
            this._dstView = null;
            this._dstPassDesc = null;
            this._dstPresent = null;

            Object.assign(this.canvas.style, {
                position: 'absolute',
                zIndex: '10',
                pointerEvents: 'none',
                display: 'none'
            });
        }

        configure(width, height) {
            width = Math.max(1, Math.floor(width));
            height = Math.max(1, Math.floor(height));
            this.canvas.width = width;
            this.canvas.height = height;
            // 畫布格式改用瀏覽器偏好格式(通常 bgra8unorm):合成器最快路徑,
            // 且 8bit 呈現的頻寬是 rgba16float 的一半(4K@60 ≈ 省 1GB/s)。
            // float→8bit 的轉換由「呈現 blit」在 GPU 上完成(processFrame 內)。
            this.format = (typeof navigator !== 'undefined' && navigator.gpu
                && typeof navigator.gpu.getPreferredCanvasFormat === 'function')
                ? navigator.gpu.getPreferredCanvasFormat()
                : 'bgra8unorm';
            this.context.configure({
                device: this.device,
                format: this.format,
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
                alphaMode: 'opaque'
            });
            // 重配後必須重新取得畫布紋理與 view/passDesc
            this._dstTex = null;
            this._dstView = null;
            this._dstPassDesc = null;
            this._dstPresent = null;
            this.dstW = width;
            this.dstH = height;
            VSRLogger.debug(`Canvas 配置完成: ${width}x${height} (${this.format})`);
        }

        /**
         * 取得本幀的呈現目標(熱路徑)。
         * ---
         * - 尺寸不符時自癒重配(取代舊 render() 內每幀的失敗驗證)。
         * - 畫布 swapchain 紋理在合成器回收後可能換新物件 → 以「紋理身分」快取
         *   view 與 render-pass 描述器,紋理沒換就完全零配置。
         * @param {number} width 預期輸出寬(管線尾端 outW)
         * @param {number} height 預期輸出高
         * @returns {{passDesc: object, format: string}} passDesc 可直接交給
         *          beginRenderPass;format 供 ensurePresent 建呈現 pipeline
         */
        prepareRenderTarget(width, height) {
            if (width !== this.dstW || height !== this.dstH) {
                VSRLogger.warn(
                    `輸出尺寸不一致 (${width}x${height} vs Canvas ${this.dstW}x${this.dstH}),自動重新配置 Canvas`);
                this.configure(width, height);
            }
            const tex = this.context.getCurrentTexture();
            if (this._dstTex !== tex) {
                this._dstTex = tex;
                this._dstView = tex.createView();
                this._dstPassDesc = {
                    colorAttachments: [{
                        view: this._dstView,
                        loadOp: 'clear',
                        storeOp: 'store',
                        clearValue: CLEAR_BLACK,
                    }],
                };
                // passDesc 與 format 必須一起重建(重配後兩者都可能變)
                this._dstPresent = { passDesc: this._dstPassDesc, format: this.format };
            }
            return this._dstPresent;
        }

        /**
         * 套用位置(效能:rects 由 controller 每次佈局變更時讀取一次並共用,
         * 熱路徑不再每幀呼叫 getBoundingClientRect 與寫入 style)。
         */
        applyPosition(vRect, cRect) {
            Object.assign(this.canvas.style, {
                left: `${vRect.left - cRect.left}px`,
                top: `${vRect.top - cRect.top}px`,
                width: `${vRect.width}px`,
                height: `${vRect.height}px`
            });
        }
    }

    /**
     * Watermark Overlay
     * ---
     * 「淺色水印」:表示 VSR 啟用中的小徽章,疊在影片右下角。
     * 以 2D canvas 繪製(零 GPU 成本;只在文字變化時重繪一次),CSS 尺寸固定、
     * 不隨影片縮放模糊。可由主控台 `VSR.watermark(false)` 關閉(永久保存於 storage)。
     */
    class WatermarkOverlay {
        constructor() {
            this.enabled = true;
            this.canvas = document.createElement('canvas');
            this._text = '';
            this._cssW = 0;
            this._cssH = 0;
            Object.assign(this.canvas.style, {
                position: 'absolute',
                zIndex: '11',          // WebGPU 覆蓋層是 10,水印在其上
                pointerEvents: 'none',
                display: 'none'
            });
        }

        setEnabled(on) {
            this.enabled = !!on;
            if (!this.enabled) this.canvas.style.display = 'none';
        }

        /** 首幀呈現後由 controller 呼叫:僅在啟用時顯示 */
        showIfEnabled() {
            if (this.enabled) this.canvas.style.display = 'block';
        }

        setText(text) {
            if (text === this._text) return;
            this._text = String(text);
            this._draw();
        }

        _draw() {
            const ctx = this.canvas.getContext('2d');
            if (!ctx) return;
            const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
            const font = `${13 * dpr}px -apple-system, 'Segoe UI', Roboto, 'Noto Sans', sans-serif`;
            // 先以目前的 canvas 量字寬,再調整尺寸(調整尺寸會重置 2D 狀態)
            ctx.font = font;
            const textW = ctx.measureText(this._text).width;
            const cssW = Math.ceil(textW / dpr) + 20;  // 左右各 10px padding
            const cssH = 25;                            // 13px 字 + 上下各 6px
            this.canvas.width = Math.ceil(cssW * dpr);
            this.canvas.height = Math.ceil(cssH * dpr);
            this._cssW = cssW;
            this._cssH = cssH;
            this.canvas.style.width = `${cssW}px`;
            this.canvas.style.height = `${cssH}px`;

            // 調整尺寸後重設字型再繪製
            ctx.font = font;
            const w = this.canvas.width, h = this.canvas.height;
            // 淺色膠囊底(黑 30%)
            ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
            ctx.beginPath();
            if (typeof ctx.roundRect === 'function') {
                ctx.roundRect(0.5 * dpr, 0.5 * dpr, w - dpr, h - dpr, 7 * dpr);
                ctx.fill();
            } else {
                ctx.fillRect(0, 0, w, h);
            }
            // 淺色文字(白 42%)——「淺淺」的視覺強度
            ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
            ctx.textBaseline = 'middle';
            ctx.fillText(this._text, 10 * dpr, h / 2 + 0.5 * dpr);
        }

        /** 與影片右下角對齊(rects 由 controller 快取後傳入,見 applyPosition) */
        applyPosition(vRect, cRect) {
            if (this._cssW === 0) return;
            const left = vRect.left - cRect.left + vRect.width - this._cssW - 12;
            const top = vRect.top - cRect.top + vRect.height - this._cssH - 12;
            Object.assign(this.canvas.style, {
                left: `${left}px`,
                top: `${top}px`
            });
        }
    }

    /**
     * 鏈結 blit 著色器:把上一個效果的 OUTPUT(rgba16float,儲存紋理)取樣寫入
     * 下一個效果的 INPUT(rgba8unorm,可當渲染目標)。
     * ---
     * 為何不用 copyTextureToTexture:兩者**格式不同**(rgba16float vs rgba8unorm),
     * WebGPU 規定 copy 必須同格式 → 以全螢幕三角 + 取樣做格式轉換。
     * 鏈結中上一級輸出與下一級輸入尺寸恆相等(下一級以該尺寸編譯),故 1:1 取樣。
     */
    const BLIT_WGSL = `
struct VSOut {
    @builtin(position) pos: vec4f,
};
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
    var pts = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
    var out: VSOut;
    out.pos = vec4f(pts[vi], 0.0, 1.0);
    return out;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment
fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
    let dims = vec2f(textureDimensions(tex, 0));
    return textureSample(tex, samp, fragCoord.xy / dims);
}
`;

    /** 熱路徑共用常數(每幀重複建立物件字面量會產生 GC 垃圾) */
    const CLEAR_BLACK = { r: 0, g: 0, b: 0, a: 1 };
    const ENCODER_DESC = { label: 'VSR frame' };

    /**
     * WGFX Processor(多效果管線)
     * ---
     * 把 popup 管線中的**每一個**效果依序編譯並串接:
     *   效果 1(輸入=影片)→ OUTPUT → blit → 效果 2(輸入=效果1 輸出)→ … → Canvas
     *
     * 執行策略(效能):
     *  - 第 1 個效果走 vendor 原生 `process()`(零內部依賴,含輸入上傳 + scene 寫入);
     *  - 第 2..n 個效果在**同一個 encoder** 內:advanceFrame → updateSceneBuffer
     *    (frame 計數器實際寫入點,vendor 的 updateTextureFromImage 原本代勞)→
     *    blit(上一級 OUTPUT → 本級 INPUT)→ 依序 dispatch 本級所有 pass,
     *    鏈尾一次 submit —— n 個效果只有 2 次 queue submit(首效果 1 + 鏈尾 1)。
     *
     * 內部欄位依賴聲明:第 2..n 效果使用 vendor 匯出類別的公開欄位
     * (`WGFXPackageInstance.resourceManager/pipelineManager/manifest`、
     * `WGFX.runtime.dispatchAllPasses`)——與 vendor 自己的 `process()` 完全同形,
     * 若上游改版會在**編譯期**拋錯(fail-fast),由啟動流程降級保護。
     */
    class WGFXProcessor {
        constructor(device) {
            this.device = device;
            /** 鏈: [{instanceId, name, inst, inW, inH, outW, outH, inputTex, outputTex, passes, presentBindGroup, presentPipeline}] */
            this.instances = [];
            /** 鏈結 blit 資源: links[i] 把 instances[i].outputTex 寫入 instances[i+1].inputTex */
            this.links = [];
            this.blitModule = null;
            this.linkPipeline = null;    // 鏈結 blit(目標 rgba8unorm = 各級 INPUT)
            this.presentPipeline = null; // 呈現 blit(目標 = 畫布偏好格式)
            this.presentFormat = null;
            this.blitSampler = null;
            /** 相容別名:最後一個實例(updateUniforms / getOutputSize 用) */
            this.wgfx = null;
        }

        /** 取得實例的 ResourceManager(兩種實例形狀) */
        _rm(inst) {
            return inst.resourceManager
                || (inst.runtime && inst.runtime.resourceManager)
                || null;
        }

        /**
         * 載入擴充套件內的資源位元組(.wgx 套件包)。
         * ---
         * 舊版在內容腳本(隔離世界)直接 fetch chrome-extension:// URL —— 雖然
         * web_accessible_resources 允許而載入成功,但 Blink 會對每個檔案記一條
         * 「Unsafe attempt to load URL … Domains, protocols and ports must match.」
         * 主控台錯誤。改由背景 service worker 代抓(擴充套件自己的 origin,無框架、
         * 無此警告),以 base64 傳回;訊息失敗(SW 未就緒、context 失效等)時
         * 退回原本的直接 fetch,行為不劣化。
         * @param {string} path 擴充套件相對路徑
         * @returns {Promise<Uint8Array>}
         */
        async loadExtensionBytes(path) {
            try {
                const resp = await chrome.runtime.sendMessage({ command: 'fetchResource', path });
                if (resp && resp.ok && typeof resp.data === 'string') {
                    return base64ToUint8Array(resp.data);
                }
                if (resp && resp.ok === false) {
                    VSRLogger.debug(`背景代理取檔失敗(${resp.error || '未知原因'}),改用直接 fetch: ${path}`);
                }
            } catch (e) {
                VSRLogger.debug('背景代理不可用,改用直接 fetch:', (e && e.message) || e);
            }
            const resp = await fetch(chrome.runtime.getURL(path));
            if (!resp.ok) {
                throw new Error(`載入資源失敗: ${path} (HTTP ${resp.status})`);
            }
            return new Uint8Array(await resp.arrayBuffer());
        }

        /** 編譯單一效果(一律 .wgx 套件包;legacy .wgsl 路徑已移除) */
        async _compileOne(effectPath, width, height, params = {}) {
            if (!effectPath.endsWith('.wgx')) {
                throw new Error(`不支援的效果路徑(僅接受 .wgx 套件包): ${effectPath}`);
            }
            const bytes = await this.loadExtensionBytes(effectPath);
            const pkg = await WGFXPackageClass.fromBytes(bytes);
            const inst = await pkg.createInstance({ device: this.device, width, height });
            VSRLogger.info(`已載入套件包: ${pkg.manifest.name} (${pkg.manifest.passes.length} passes) @ ${width}x${height}`);
            inst.updateUniforms(params);
            return inst;
        }

        /**
         * 編譯整條管線(依序串接;尺寸自動傳遞:效果 i 的實際輸出 = 效果 i+1 的輸入)。
         * @param {Array<{instanceId?:string, path:string, name?:string, params?:object}>} items
         */
        async compilePipeline(items, videoW, videoH) {
            if (!Array.isArray(items) || items.length === 0) {
                throw new Error('無效的管線配置');
            }
            this.instances = [];
            let inW = videoW;
            let inH = videoH;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (!item || typeof item.path !== 'string') {
                    throw new Error(`管線第 ${i + 1} 個效果無效(缺少 path)`);
                }
                const inst = await this._compileOne(item.path, inW, inH, item.params || {});
                const out = resolveOutputSize(inst);
                const size = nextLinkSize(inW, inH, out);
                this.instances.push({
                    instanceId: item.instanceId || `auto_${i}`,
                    name: item.name || item.id || item.path,
                    inst,
                    inW: size.inW,
                    inH: size.inH,
                    outW: size.outW,
                    outH: size.outH,
                    inputTex: null,
                    outputTex: null,
                    // 預解析的 pass 派發資料(熱路徑不再每幀對 manifest 做 find)
                    passes: null,
                    // 呈現 blit(最終 OUTPUT → 畫布)的 bind group 快取
                    presentBindGroup: null,
                    presentPipeline: null,
                });
                inW = size.outW;
                inH = size.outH;
            }
            // 快取紋理(GPUTexture 物件在實例生命週期內穩定;每幀免查表)
            for (const entry of this.instances) {
                const rm = this._rm(entry.inst);
                entry.inputTex = (rm && rm.getTexture) ? rm.getTexture('INPUT') : null;
                entry.outputTex = (rm && rm.getTexture) ? rm.getTexture('OUTPUT') : null;
                if (!entry.inputTex || !entry.outputTex) {
                    throw new Error(`效果 ${entry.name} 缺少 INPUT/OUTPUT 紋理,無法串接`);
                }
                // 預解析 pass 派發資料:套件實例逐 pass 攤平(vendor process 每幀
                // 做 metas.find;此處一次做完,熱路徑直接迭代陣列)
                if (entry.inst.manifest && entry.inst.pipelineManager && Array.isArray(entry.inst.manifest.passes)) {
                    const metas = (entry.inst.manifest.shaderInfo && entry.inst.manifest.shaderInfo.passes) || [];
                    entry.passes = entry.inst.manifest.passes.map((pass) => {
                        const meta = metas.find((m) => m.index === pass.index) || {};
                        return {
                            index: pass.index,
                            in: pass.inputs || meta.in || [],
                            out: pass.outputs || meta.out || [],
                            blockSize: meta.blockSize,
                            numThreads: meta.numThreads,
                            dispatch: pass.dispatch || meta.dispatch,
                        };
                    });
                }
            }
            // 建立鏈結 blit(僅多效果時)
            this.links = [];
            if (this.instances.length > 1) {
                this._ensureBlit();
                for (let i = 1; i < this.instances.length; i++) {
                    this.links.push(this._makeLink(this.instances[i - 1].outputTex, this.instances[i].inputTex));
                }
                VSRLogger.info(`多效果管線: ${this.instances.length} 個效果串接(鏈結 blit ×${this.links.length})`);
            }
            // 相容別名:最後一個實例
            this.wgfx = this.instances[this.instances.length - 1].inst;
        }

        /** 建立鏈結 blit 的 pipeline(rgba8unorm 目標)與共用 sampler(一次性) */
        _ensureBlit() {
            if (this.linkPipeline) return;
            this.blitModule = this.device.createShaderModule({ code: BLIT_WGSL });
            this.linkPipeline = this.device.createRenderPipeline({
                layout: 'auto',
                vertex: { module: this.blitModule, entryPoint: 'vs' },
                fragment: { module: this.blitModule, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
                primitive: { topology: 'triangle-list' },
            });
            this.blitSampler = this.device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear',
                addressModeU: 'clamp-to-edge',
                addressModeV: 'clamp-to-edge',
            });
        }

        /**
         * 呈現 pipeline(最終 OUTPUT → 畫布;目標格式 = 畫布偏好格式,通常 bgra8unorm)。
         * ---
         * 效能:畫布從 rgba16float(copy 用)改為 8bit 偏好格式 —— 4K@60 的呈現
         * 頻寬約省一半(每像素 8B vs 16B),且走瀏覽器合成器的最快路徑。
         * 呈現本身是取樣 blit(同一顆著色器),順帶完成 float→8bit 轉換。
         * @param {string} format 畫布格式(CanvasRenderer 提供)
         */
        ensurePresent(format) {
            if (this.presentPipeline && this.presentFormat === format) return this.presentPipeline;
            this._ensureBlit();
            this.presentPipeline = this.device.createRenderPipeline({
                layout: 'auto',
                vertex: { module: this.blitModule, entryPoint: 'vs' },
                fragment: { module: this.blitModule, entryPoint: 'fs', targets: [{ format }] },
                primitive: { topology: 'triangle-list' },
            });
            this.presentFormat = format;
            return this.presentPipeline;
        }

        /** 建立單一鏈結(上一級 OUTPUT → 下一級 INPUT;紋理穩定,bind group 與
         *  render-pass 描述器只建一次,熱路徑零物件配置) */
        _makeLink(prevOutTexture, nextInputTexture) {
            this._ensureBlit();
            return {
                passDesc: {
                    colorAttachments: [{
                        view: nextInputTexture.createView(),
                        loadOp: 'clear',
                        storeOp: 'store',
                        clearValue: CLEAR_BLACK,
                    }],
                },
                bindGroup: this.device.createBindGroup({
                    layout: this.linkPipeline.getBindGroupLayout(0),
                    entries: [
                        { binding: 0, resource: this.blitSampler },
                        { binding: 1, resource: prevOutTexture.createView() },
                    ],
                }),
            };
        }

        /** 在 encoder 內錄製鏈結 blit + 該級全部 pass(不 submit;整幀統一提交) */
        _recordChainStep(entry, link, encoder) {
            const rm = this._rm(entry.inst);
            if (!rm || typeof rm.advanceFrame !== 'function' || typeof rm.updateSceneBuffer !== 'function') {
                throw new Error(`效果 ${entry.name} 不支援鏈式派發(缺 resourceManager 生命週期 API)`);
            }
            // 影格計數器 + scene 資訊:vendor 的 process() 經 updateTextureFromImage 代寫;
            // 鏈式路徑跳過輸入上傳,須自行補寫(時間性效果讀 scene.frame)。
            rm.advanceFrame();
            rm.updateSceneBuffer(entry.inW, entry.inH, entry.outW, entry.outH);
            // blit:上一級 OUTPUT → 本級 INPUT(1:1 尺寸,格式轉換)
            const pass = encoder.beginRenderPass(link.passDesc);
            pass.setPipeline(this.linkPipeline);
            pass.setBindGroup(0, link.bindGroup);
            pass.draw(3);
            pass.end();
            // 本級所有 pass(與 vendor WGFXPackageInstance.process 同形)
            this._dispatchPasses(entry, encoder);
        }

        /** 派發單一效果的全部 pass(套件實例用預解析資料;原始實例走 runtime) */
        _dispatchPasses(entry, encoder) {
            const inst = entry.inst;
            if (entry.passes && inst.pipelineManager) {
                for (const p of entry.passes) {
                    inst.pipelineManager.dispatchPass(p, encoder);
                }
                return;
            }
            if (inst.runtime && typeof inst.runtime.dispatchAllPasses === 'function') {
                inst.runtime.dispatchAllPasses(encoder);
                return;
            }
            throw new Error('不支援的 WGFX 實例形狀,無法派發');
        }

        /**
         * 處理一幀 —— 整幀只做 **1 次 queue submit**:
         *   輸入上傳(queue 操作)→ 效果1 passes → 鏈結 blit+passes → 呈現 blit → submit
         * @param {HTMLVideoElement} videoSource 影片元素(copyExternalImageToTexture 原生支援)
         * @param {{passDesc: object, format: string}|null} present 畫布呈現目標
         *        (CanvasRenderer.prepareRenderTarget 的快取回傳;傳 null 只處理不呈現)
         * @returns {GPUTexture} 最終 OUTPUT 紋理
         */
        processFrame(videoSource, present) {
            const n = this.instances.length;
            if (n === 0) throw new Error('管線尚未編譯');
            const encoder = this.device.createCommandEncoder(ENCODER_DESC);

            // 效果 1:輸入上傳 + scene 寫入 + passes(與 vendor process() 同序:
            // advanceFrame → updateTextureFromImage(內含 updateSceneBuffer)→ dispatch)
            const e0 = this.instances[0];
            const rm0 = this._rm(e0.inst);
            if (!rm0 || typeof rm0.updateTextureFromImage !== 'function') {
                throw new Error(`效果 ${e0.name} 不支援直接輸入上傳`);
            }
            rm0.advanceFrame();
            rm0.updateTextureFromImage('INPUT', videoSource, undefined, undefined);
            this._dispatchPasses(e0, encoder);

            // 效果 2..n:scene 補寫 → 鏈結 blit → passes
            for (let i = 1; i < n; i++) {
                this._recordChainStep(this.instances[i], this.links[i - 1], encoder);
            }

            // 呈現:最終 OUTPUT 取樣 blit 到畫布(同一 encoder;float→8bit 轉換)
            if (present) {
                const last = this.instances[n - 1];
                const pipeline = this.ensurePresent(present.format);
                if (!last.presentBindGroup || last.presentPipeline !== pipeline) {
                    last.presentBindGroup = this.device.createBindGroup({
                        layout: pipeline.getBindGroupLayout(0),
                        entries: [
                            { binding: 0, resource: this.blitSampler },
                            { binding: 1, resource: last.outputTex.createView() },
                        ],
                    });
                    last.presentPipeline = pipeline;
                }
                const pass = encoder.beginRenderPass(present.passDesc);
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, last.presentBindGroup);
                pass.draw(3);
                pass.end();
            }

            this.device.queue.submit([encoder.finish()]);
            return this.instances[n - 1].outputTex;
        }

        /** 最終輸出尺寸(鏈尾效果的實際 OUTPUT) */
        getOutputSize() {
            const last = this.instances[this.instances.length - 1];
            if (last) return { width: last.outW, height: last.outH };
            return resolveOutputSize(this.wgfx);
        }

        /** 依 instanceId 更新參數(instanceId 省略時套用第一個效果) */
        updateParameter(instanceId, paramName, value) {
            const entry = pickProcessorEntry(this.instances, instanceId);
            if (entry && entry.inst) {
                entry.inst.updateUniforms({ [paramName]: value });
            }
        }

        dispose() {
            for (const entry of this.instances) {
                try { entry.inst?.dispose?.(); } catch (e) { /* 單一實例釋放失敗不阻斷整體 */ }
            }
            this.instances = [];
            this.links = [];
            this.linkPipeline = null;
            this.presentPipeline = null;
            this.presentFormat = null;
            this.blitModule = null;
            this.blitSampler = null;
            this.wgfx = null;
        }
    }

    // ===================================================================
    // [4] 主控制器 (生命週期與日誌切換)
    // ===================================================================

    /** 連續幀錯誤超過此數 → 降級回原影片(避免黑畫面 + 無限錯誤刷屏) */
    const MAX_CONSECUTIVE_FRAME_ERRORS = 120;

    class VSRController {
        constructor() {
            this.state = 'IDLE';
            this.deviceManager = new GPUDeviceManager();
            this.renderer = null;
            this.processor = null;
            this.watermark = null;
            this._watermarkEnabled = true;   // 預設開啟(storage 'watermark' === false 時關閉)
            this._lastFps = 0;
            this.video = null;
            this.container = null;
            this.frameId = null;
            this._usingRVFC = false;
            this._loopGen = 0;
            this._consecErrors = 0;
            this._firstFrameShown = false;
            this._fpsCount = 0;
            this._fpsLast = 0;
            this._posDirty = true;      // 佈局髒旗標:變化時才讀 rect / 寫 style(效能)
            this._cachedRects = null;
            this.lastVideoW = 0;
            this.lastVideoH = 0;
        }

        /**
         * 啟動系統並應用雙重日誌設定
         */
        async start() {
            if (this.state === 'RUNNING') return;
            VSRLogger.info("系統啟動中...");

            try {
                // 1. 載入設定與日誌開關
                const config = await chrome.storage.local.get(['pipeline', 'debugVSR', 'debugWGFX', 'watermark']);

                // --- 日誌切換處 ---
                if (WGFXClass.setLevel) {
                    // 例如從 config 讀取特定的 LogLevel (0: DEBUG, 1: INFO, ...)
                    const level = config.debugWGFX ? 0 : 1;
                    WGFXClass.setLevel(level);
                }
                VSRLogger.setDebug(!!config.debugVSR);
                VSRLogger.debug("日誌系統已更新: VSR=", !!config.debugVSR, "WGFX=", !!config.debugWGFX);

                // 2. 獲取元素
                await this._findElements();

                // 3. 初始化 GPU(先掛好裝置遺失回呼再建立裝置,避免錯過最早的 lost 事件)
                this.deviceManager.onDeviceLost = (info) => {
                    if (this.state !== 'RUNNING' && this.state !== 'ERROR') return;
                    VSRLogger.error('GPU 裝置遺失,自動重新啟動...', (info && info.message) || info);
                    setTimeout(() => {
                        if (this.state === 'RUNNING' || this.state === 'ERROR') {
                            this.restart().catch((e) => VSRLogger.error('重啟失敗', e));
                        }
                    }, 300);
                };
                const device = await this.deviceManager.initialize();

                // 4. 建立渲染器與處理器
                this.renderer = new CanvasRenderer(device);
                this.container.appendChild(this.renderer.canvas);

                // 淺色水印(表示 VSR 啟用中;主控台 VSR.watermark(false) 可關閉)
                this._watermarkEnabled = config.watermark !== false;
                this.watermark = new WatermarkOverlay();
                this.watermark.setEnabled(this._watermarkEnabled);
                this.container.appendChild(this.watermark.canvas);

                const pipelineItems = Array.isArray(config.pipeline) ? config.pipeline : [];
                if (pipelineItems.length === 0) throw new Error("無效的管線配置");

                this.processor = new WGFXProcessor(device);
                await this.processor.compilePipeline(pipelineItems, this.video.videoWidth, this.video.videoHeight);
                const chain = this.processor.instances;
                const last = chain[chain.length - 1];

                // Canvas 內部解析度 = 管線尾端效果「實際」OUTPUT 尺寸(鏈式串接下,
                // 中間效果的輸出尺寸已自動傳遞為下一效果的輸入)。
                // CSS 顯示尺寸由 applyPosition 以影片矩形控制,與內部解析度解耦。
                VSRLogger.info(`輸出尺寸: ${this.video.videoWidth}x${this.video.videoHeight} → ${last.outW}x${last.outH}`);
                this.renderer.configure(last.outW, last.outH);

                // 水印文字帶上實際放大倍率(例:VSR ×2.0;多效果為整條鏈的總倍率)
                const scale = this.video.videoWidth > 0 ? last.outW / this.video.videoWidth : 1;
                this.watermark.setText(`VSR ×${scale >= 10 ? Math.round(scale) : scale.toFixed(1)}`);

                // 5. 啟動監聽與循環
                this._setupObservers();
                this.state = 'RUNNING';
                this._consecErrors = 0;
                this._firstFrameShown = false;
                this._fpsCount = 0;
                this._fpsLast = 0;
                this._posDirty = true;      // 首幀前至少同步一次位置
                this._renderLoop();

                VSRLogger.info("VSR 運行中");
            } catch (err) {
                VSRLogger.error("啟動失敗", err);
                this.stop();
            }
        }

        /**
         * popup 送來新的管線 — 執行中則重編譯套用(管線資料已由 popup 寫入 storage)。
         */
        async setPipeline() {
            if (this.state === 'RUNNING' || this.state === 'ERROR') await this.restart();
        }

        /** 停止後重新啟動(管線變更、SPA 導覽、解析度變更共用) */
        async restart() {
            await this.stop();
            await this.start();
        }

        async stop() {
            VSRLogger.info("系統停止中...");
            // rVFC 的排程代號與 rAF 不相容 —— 必須用對應的 cancel API,否則
            // 取消無效:restart 時(stop→start)舊回呼醒來又排一幀,與新迴圈
            // 並行成雙迴圈(GPU 雙倍負擔、錯誤計數互相污染)。
            if (this.frameId !== null) {
                if (this._usingRVFC && this.video?.cancelVideoFrameCallback) {
                    this.video.cancelVideoFrameCallback(this.frameId);
                } else {
                    cancelAnimationFrame(this.frameId);
                }
            }
            this.frameId = null;
            // 迴圈代數 +1:所有已在執行中的舊 frameFunc 在下一個檢查點自動退出,
            // 徹底隔離 stop→start 競態。
            this._loopGen++;
            this.resizeObserver?.disconnect();

            this.processor?.dispose();
            this.renderer?.canvas?.remove();
            this.watermark?.canvas?.remove();
            this.watermark = null;
            if (this.video) this.video.style.opacity = '1';

            this.state = 'STOPPED';
        }

        // --- 水印與狀態(主控台 / popup 共用) ---

        /** 水印開關:即時生效,並由呼叫端負責寫入 storage('watermark') */
        setWatermarkEnabled(on) {
            this._watermarkEnabled = !!on;
            if (this.watermark) {
                this.watermark.setEnabled(this._watermarkEnabled);
                if (this._watermarkEnabled && this._firstFrameShown) this.watermark.showIfEnabled();
            }
        }

        isWatermarkEnabled() {
            return !!this._watermarkEnabled;
        }

        /** 主控台 `VSR.status()` 的狀態快照 */
        getStatus() {
            const chain = this.processor ? this.processor.instances : [];
            return {
                state: this.state,
                watermark: !!this._watermarkEnabled,
                pipeline: chain.map((e) => e.name),
                video: this.video ? { width: this.video.videoWidth, height: this.video.videoHeight } : null,
                output: chain.length
                    ? { width: chain[chain.length - 1].outW, height: chain[chain.length - 1].outH }
                    : null,
                fps: this._lastFps || null,
            };
        }

        /** 依 popup 傳來的 instanceId 把參數路由到對應效果(省略時套用第一個) */
        updateParameter(instanceId, paramName, value) {
            if (this.processor) {
                this.processor.updateParameter(instanceId, paramName, value);
            }
        }

        // --- 內部渲染與監聽邏輯 ---

        /**
         * 同步覆蓋層位置(髒旗標驅動)。
         * ---
         * 效能:rects 只在佈局變更後讀取一次並共用給所有覆蓋層;熱路徑(每幀)
         * 不再呼叫 getBoundingClientRect ×N、不再每幀寫 style —— 兩者都會觸發
         * 樣式/版面計算,是原本每幀最貴的 DOM 往返。
         */
        _syncPositions() {
            if (!this.video || !this.container) return;
            const vRect = this.video.getBoundingClientRect();
            const cRect = this.container.getBoundingClientRect();
            this._cachedRects = {
                video: { left: vRect.left, top: vRect.top, width: vRect.width, height: vRect.height },
                container: { left: cRect.left, top: cRect.top, width: cRect.width, height: cRect.height },
            };
            this.renderer?.applyPosition(vRect, cRect);
            this.watermark?.applyPosition(vRect, cRect);
        }

        /** 佈局可能變了 → 下一幀前重新同步位置(RO / 事件驅動) */
        _markPositionDirty() {
            this._posDirty = true;
        }

        /** 連續處理失敗時的降級:移除覆蓋層、還原原影片,停止循環並保留可重啟的狀態 */
        _degradeToVideo(lastError) {
            VSRLogger.error(
                `連續 ${this._consecErrors} 幀處理失敗,已降級回原影片。` +
                `請開啟 popup 的偵錯日誌檢查原因。最後錯誤:`,
                (lastError && lastError.message) || lastError);
            try {
                this.stop();
            } catch (e) { /* 降級路徑不再讓 cleanup 例外 */ }
            this.state = 'ERROR';
        }

        _renderLoop() {
            // 迴圈代數:每次 _renderLoop 啟動時遞增;舊代數的回呼(包括正在 await 的)
            // 在每個檢查點自行退出,保證任何時刻只有一條渲染迴圈。
            const gen = ++this._loopGen;
            const frameFunc = async () => {
                if (this.state !== 'RUNNING' || gen !== this._loopGen) return;

                try {
                    // 位置同步:僅在佈局變更後(髒旗標)讀 rect / 寫 style
                    if (this._posDirty) {
                        this._posDirty = false;
                        this._syncPositions();
                    }

                    // 整幀單一 submit:輸入上傳 → 效果 passes → 鏈結 blit → 呈現 blit。
                    // prepareRenderTarget 回傳快取的呈現描述器(畫布尺寸自癒在內);
                    // 呈現目標為瀏覽器偏好格式(通常 bgra8unorm)。
                    const last = this.processor.instances[this.processor.instances.length - 1];
                    const present = this.renderer.prepareRenderTarget(last.outW, last.outH);
                    this.processor.processFrame(this.video, present);

                    // 首幀成功才隱藏原影片 —— 編譯或首幀失敗時使用者至少看得到原片,
                    // 而不是一片黑。
                    if (!this._firstFrameShown) {
                        this._firstFrameShown = true;
                        this.video.style.opacity = '0';
                        this.renderer.canvas.style.display = 'block';
                        this.watermark?.showIfEnabled();
                        VSRLogger.info("首幀已呈現,覆蓋層啟用");
                    }

                    this._consecErrors = 0;

                    // 偵錯計數(僅 debugVSR 開啟時輸出)
                    this._fpsCount++;
                    const now = performance.now();
                    if (!this._fpsLast) this._fpsLast = now;
                    if (now - this._fpsLast >= 2000) {
                        const fps = Math.round(this._fpsCount * 1000 / (now - this._fpsLast));
                        this._lastFps = fps;
                        VSRLogger.debug(`處理效能: ${fps} FPS (${this.video.videoWidth}x${this.video.videoHeight})`);
                        this._fpsCount = 0;
                        this._fpsLast = now;
                    }
                } catch (e) {
                    this._consecErrors++;
                    // 單次失敗(取幀時影片尚未就緒等)屬常態 → debug;連續失敗才升級
                    if (this._consecErrors === 1 || this._consecErrors % 300 === 0) {
                        VSRLogger.debug(`幀跳過 (連續第 ${this._consecErrors} 次)`, (e && e.message) || e);
                    }
                    if (this._consecErrors >= MAX_CONSECUTIVE_FRAME_ERRORS) {
                        this._degradeToVideo(e);
                        return;
                    }
                }

                if (this.state === 'RUNNING' && gen === this._loopGen) {
                    if (this.video.requestVideoFrameCallback) {
                        this._usingRVFC = true;
                        this.frameId = this.video.requestVideoFrameCallback(frameFunc);
                    } else {
                        this._usingRVFC = false;
                        this.frameId = requestAnimationFrame(frameFunc);
                    }
                }
            };
            frameFunc();
        }

        async _findElements() {
            return new Promise((resolve, reject) => {
                const check = () => {
                    // 優先 YouTube 主影片;Twitch / 其他站點退回通用選擇器。
                    // container 一律從找到的 video 往上找,避免影片與容器錯配。
                    const v = document.querySelector('.html5-video-player video.html5-main-video')
                        || document.querySelector('video');
                    const c = v ? (v.closest('.html5-video-player') || v.parentElement) : null;
                    if (v && c && v.readyState >= 1) {
                        this.video = v;
                        this.container = c;
                        resolve();
                    } else {
                        setTimeout(check, 500);
                    }
                };
                check();
                setTimeout(() => reject(new Error("尋找元素超時")), 10000);
            });
        }

        _setupObservers() {
            // 記住「影片串流」的內在解析度;ResizeObserver 回呼只在其真正變化時重編譯。
            // 不可比對 canvas.width —— 升頻效果的 Canvas 內部尺寸本來就是影片的數倍
            // (例:1080p 影片 + 2x 效果 → canvas 2160p),拿它比對會在 RO 的初始回呼
            // 就誤判「解析度變更」→ stop/start 無限循環。
            this.lastVideoW = this.video.videoWidth;
            this.lastVideoH = this.video.videoHeight;
            this.resizeObserver = new ResizeObserver(() => {
                if (this.state !== 'RUNNING') return;
                // 佈局變了(影片框/播放器框尺寸)→ 下一幀前重新同步覆蓋層位置
                this._markPositionDirty();
                const w = this.video.videoWidth;
                const h = this.video.videoHeight;
                if (!videoResolutionChanged(this.lastVideoW, this.lastVideoH, w, h)) return;
                VSRLogger.info(`解析度變更: ${this.lastVideoW}x${this.lastVideoH} → ${w}x${h}，重新編譯...`);
                this.lastVideoW = w;
                this.lastVideoH = h;
                this.restart();
            });
            // 同時觀察影片元素與播放器容器:劇場模式/全螢幕/視窗縮放都會反映在兩者的
            // box 上,只需標記髒旗標,熱路徑不必每幀讀 rect。
            this.resizeObserver.observe(this.video);
            this.resizeObserver.observe(this.container);
        }
    }

    // ===================================================================
    // [5] 啟動與訊息監聽
    // ===================================================================
    const vsr = new VSRController();

    // 處理器經全域轉發:擴充套件重載後,舊注入的監聽器已隨舊 context 失效,
    // 新注入的腳本在此重新註冊監聽,handler 永遠分派到最新的 controller。
    window.__vsrMessageHandler = (msg, sender, sendResponse) => {
        if (msg.command === 'setEnable') {
            msg.isEnabled ? vsr.start() : vsr.stop();
        } else if (msg.command === 'updateParameter') {
            // popup 會帶 instanceId(管線中哪個效果);舊版訊息無此欄位 → 第一個效果
            vsr.updateParameter(msg.instanceId, msg.paramName, msg.value);
        } else if (msg.command === 'setPipeline') {
            vsr.setPipeline();   // 舊版漏接 — 管線變更從未生效的根源之一
        } else if (msg.command === 'navigation') {
            vsr.restart();       // 舊版漏接 — SPA 換影片後未重新初始化
        }
        sendResponse({ status: 'received' });
        return true;
    };
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        window.__vsrMessageHandler(msg, sender, sendResponse);
        return true;
    });

    // 重注入(擴充套件重載後):先拆掉舊 controller(孤兒 context)再全新啟動
    if (window.__vsrController) {
        try { await window.__vsrController.stop(); } catch (e) { /* 舊實例可能已失效 */ }
    }
    window.__vsrController = vsr;

    // ===================================================================
    // [5.5] 主控台控制(DevTools Console)
    // ===================================================================
    // DevTools 主控台預設在「頁面 MAIN world」執行,看不到隔離世界的物件。
    // 因此由背景以 chrome.scripting.executeScript(world:'MAIN') 注入 window.VSR
    // 橋接(見 background.js 的 vsrConsoleBridgeMain;可繞過頁面 CSP —— 用
    // <script src> 注入會被 YouTube 的 CSP 擋下)。橋接經 CustomEvent
    // ('vsr-console-cmd' → 'vsr-console-res')與本檔通訊。
    // 本檔另在隔離世界提供同組 API(DevTools context 下拉選單切到本擴充套件時可用)。

    async function handleConsoleCommand(d) {
        const command = d && d.command;
        try {
            if (command === 'watermark') {
                if (d.value === undefined) {
                    return { ok: true, result: vsr.isWatermarkEnabled() };
                }
                const on = !!d.value;
                vsr.setWatermarkEnabled(on);
                await chrome.storage.local.set({ watermark: on });
                VSRLogger.info(`水印已${on ? '開啟' : '關閉'}`);
                return { ok: true, result: on };
            }
            if (command === 'setEnable' || command === 'toggle') {
                let enable = !!d.value;
                if (command === 'toggle') {
                    const cur = await chrome.storage.local.get('isEnabled');
                    enable = !cur.isEnabled;
                }
                await chrome.storage.local.set({ isEnabled: enable });
                if (enable) await vsr.start(); else await vsr.stop();
                return { ok: true, result: enable };
            }
            if (command === 'status') {
                return { ok: true, result: vsr.getStatus() };
            }
            return { ok: false, error: `未知指令: ${command}` };
        } catch (e) {
            return { ok: false, error: String((e && e.message) || e) };
        }
    }

    window.addEventListener('vsr-console-cmd', (ev) => {
        const d = ev && ev.detail;
        if (!d || typeof d.id === 'undefined') return;
        handleConsoleCommand(d).then((r) => {
            window.dispatchEvent(new CustomEvent('vsr-console-res', {
                detail: { id: d.id, ok: r.ok !== false, result: r.result, error: r.error },
            }));
        });
    });

    /** 隔離世界直呼(不走事件;同一套指令處理) */
    async function callConsole(command, value) {
        const r = await handleConsoleCommand({ command, value });
        if (r.ok === false) throw new Error(r.error || '指令執行失敗');
        return r.result;
    }
    const vsrConsoleAPI = {
        /** 水印開關:VSR.watermark() 查詢;VSR.watermark(false) 關閉 */
        watermark: (on) => callConsole('watermark', on),
        enable: () => callConsole('setEnable', true),
        disable: () => callConsole('setEnable', false),
        toggle: () => callConsole('toggle'),
        status: () => callConsole('status'),
    };
    try {
        Object.defineProperty(window, 'VSR', {
            value: vsrConsoleAPI, configurable: true, writable: false, enumerable: true
        });
    } catch (e) {
        window.VSR = vsrConsoleAPI; // 極舊頁面 defineProperty 失敗時的後備
    }

    // 請背景在頁面 MAIN world 注入 window.VSR 橋接(預設 DevTools context 可用)
    chrome.runtime.sendMessage({ command: 'ensureConsoleBridge' })
        .then((r) => {
            if (!r || !r.ok) {
                VSRLogger.debug('主控台橋接(MAIN world)注入失敗:', (r && r.error) || '未知原因');
            }
        })
        .catch((e) => VSRLogger.debug('主控台橋接請求失敗:', (e && e.message) || e));

    // 初始啟動檢查
    chrome.storage.local.get('isEnabled', (res) => {
        if (res.isEnabled) vsr.start();
    });

    VSRLogger.info("Content Script 已注入");

})();
