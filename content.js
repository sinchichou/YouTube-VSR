/**
 * @file YouTube VSR - Content Script
 * @description 整合 WGFX 引擎的 YouTube 影片超解析度處理器
 */

(async function () {
    /** @type {boolean} 防止重複注入 */
    if (window.vsrInjected) return;
    window.vsrInjected = true;

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
    let WGFXClass;
    try {
        const moduleURL = chrome.runtime.getURL('wgfx.browser.esm.js');
        const module = await import(moduleURL);
        WGFXClass = module.default || module.WGFX;

        if (!WGFXClass) throw new Error("WGFX 類別加載失敗");
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
        }

        async initialize() {
            if (this.initPromise) return this.initPromise;
            this.initPromise = (async () => {
                if (!navigator.gpu) throw new Error("瀏覽器不支援 WebGPU");
                const adapter = await navigator.gpu.requestAdapter();
                if (!adapter) throw new Error("找不到 GPU 適配器");

                this.device = await adapter.requestDevice({
                    requiredLimits: {
                        maxStorageTexturesPerShaderStage: Math.min(8, adapter.limits.maxStorageTexturesPerShaderStage)
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

            Object.assign(this.canvas.style, {
                position: 'absolute',
                zIndex: '10',
                pointerEvents: 'none',
                display: 'none'
            });
        }

        configure(width, height) {
            this.canvas.width = width;
            this.canvas.height = height;
            this.context.configure({
                device: this.device,
                format: 'rgba16float',
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
                alphaMode: 'opaque'
            });
            VSRLogger.debug(`Canvas 配置完成: ${width}x${height}`);
        }

        syncPosition(video, container) {
            const vRect = video.getBoundingClientRect();
            const cRect = container.getBoundingClientRect();
            Object.assign(this.canvas.style, {
                left: `${vRect.left - cRect.left}px`,
                top: `${vRect.top - cRect.top}px`,
                width: `${vRect.width}px`,
                height: `${vRect.height}px`
            });
        }

        render(sourceTexture) {
            const encoder = this.device.createCommandEncoder();
            encoder.copyTextureToTexture(
                {texture: sourceTexture},
                {texture: this.context.getCurrentTexture()},
                [sourceTexture.width, sourceTexture.height]
            );
            this.device.queue.submit([encoder.finish()]);
        }
    }

    /**
     * WGFX Processor
     * ---
     * 封裝 WGFX 實例，執行特效編譯與幀處理。
     */
    class WGFXProcessor {
        constructor(device) {
            this.device = device;
            this.wgfx = null;
            this.shaderCode = null;
        }

        async compile(effectPath, width, height, params = {}) {
            if (!this.shaderCode) {
                const resp = await fetch(chrome.runtime.getURL(effectPath));
                this.shaderCode = await resp.text();
            }

            this.wgfx = await WGFXClass.create({
                device: this.device,
                effectCode: this.shaderCode,
                width, height
            });

            this.wgfx.initialize();
            this.wgfx.updateUniforms(params);
        }

        async process(input) {
            return await this.wgfx.process(input);
        }

        dispose() {
            this.wgfx?.dispose();
            this.wgfx = null;
        }
    }

    // ===================================================================
    // [4] 主控制器 (生命週期與日誌切換)
    // ===================================================================

    class VSRController {
        constructor() {
            this.state = 'IDLE';
            this.deviceManager = new GPUDeviceManager();
            this.renderer = null;
            this.processor = null;
            this.video = null;
            this.container = null;
            this.frameId = null;
        }

        /**
         * 啟動系統並應用雙重日誌設定
         */
        async start() {
            if (this.state === 'RUNNING') return;
            VSRLogger.info("系統啟動中...");

            try {
                // 1. 載入設定與日誌開關
                const config = await chrome.storage.local.get(['pipeline', 'debugVSR', 'debugWGFX']);

                // --- 日誌切換處 ---
                VSRLogger.setDebug(!!config.debugVSR);
                if (WGFXClass.setDebug) {
                    WGFXClass.setDebug(!!config.debugWGFX);
                }
                VSRLogger.debug("日誌系統已更新: VSR=", !!config.debugVSR, "WGFX=", !!config.debugWGFX);

                // 2. 獲取元素
                await this._findElements();

                // 3. 初始化 GPU
                const device = await this.deviceManager.initialize();

                // 4. 建立渲染器與處理器
                this.renderer = new CanvasRenderer(device);
                this.container.appendChild(this.renderer.canvas);

                const pipeline = config.pipeline?.[0];
                if (!pipeline) throw new Error("無效的管線配置");

                this.processor = new WGFXProcessor(device);
                await this.processor.compile(
                    pipeline.path,
                    this.video.videoWidth,
                    this.video.videoHeight,
                    pipeline.params
                );

                this.renderer.configure(this.video.videoWidth, this.video.videoHeight);

                // 5. 啟動監聽與循環
                this._setupObservers();
                this.state = 'RUNNING';
                this._renderLoop();
                this.video.style.opacity = '0';

                VSRLogger.info("VSR 運行中");
            } catch (err) {
                VSRLogger.error("啟動失敗", err);
                this.stop();
            }
        }

        async stop() {
            VSRLogger.info("系統停止中...");
            if (this.frameId) cancelAnimationFrame(this.frameId);
            this.resizeObserver?.disconnect();

            this.processor?.dispose();
            this.renderer?.canvas?.remove();
            if (this.video) this.video.style.opacity = '1';

            this.state = 'STOPPED';
        }

        // --- 內部渲染與監聽邏輯 ---

        _renderLoop() {
            const frameFunc = async () => {
                if (this.state !== 'RUNNING') return;

                let frameSource = null;
                try {
                    // 同步位置
                    this.renderer.syncPosition(this.video, this.container);

                    // 獲取幀
                    frameSource = (typeof VideoFrame !== 'undefined')
                        ? new VideoFrame(this.video)
                        : await createImageBitmap(this.video);

                    const output = await this.processor.process(frameSource);
                    this.renderer.render(output);
                    this.renderer.canvas.style.display = 'block';
                } catch (e) {
                    VSRLogger.debug("幀跳過", e.message);
                } finally {
                    frameSource?.close?.();
                }

                this.frameId = this.video.requestVideoFrameCallback
                    ? this.video.requestVideoFrameCallback(frameFunc)
                    : requestAnimationFrame(frameFunc);
            };
            frameFunc();
        }

        async _findElements() {
            return new Promise((resolve, reject) => {
                const check = () => {
                    const v = document.querySelector('video');
                    const c = document.querySelector('.html5-video-player');
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
            this.resizeObserver = new ResizeObserver(() => {
                const {videoWidth: w, videoHeight: h} = this.video;
                if (w !== this.renderer.canvas.width || h !== this.renderer.canvas.height) {
                    VSRLogger.info(`解析度變更: ${w}x${h}，重新編譯...`);
                    this.stop().then(() => this.start());
                }
            });
            this.resizeObserver.observe(this.video);
        }
    }

    // ===================================================================
    // [5] 啟動與訊息監聽
    // ===================================================================
    const vsr = new VSRController();

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.command === 'setEnable') {
            msg.isEnabled ? vsr.start() : vsr.stop();
        } else if (msg.command === 'updateParameter') {
            vsr.processor?.wgfx?.updateUniforms({[msg.paramName]: msg.value});
        }
        sendResponse({status: 'received'});
        return true;
    });

    // 初始啟動檢查
    chrome.storage.local.get('isEnabled', (res) => {
        if (res.isEnabled) vsr.start();
    });

    VSRLogger.info("Content Script 已注入");

})();