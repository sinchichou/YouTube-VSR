// YouTube VSR - Refactored Architecture with WGFX Integration
(async function () {
    // === 防止重複注入 ===
    if (window.vsrInjected) {
        console.log("[VSR] 腳本已存在，跳過初始化");
        return;
    }
    window.vsrInjected = true;

    // === 模組載入 ===
    let WGFXClass;
    try {
        const moduleURL = chrome.runtime.getURL('wgfx.browser.esm.js');
        const module = await import(moduleURL);
        WGFXClass = module.default || module.WGFX;

        if (!WGFXClass) {
            throw new Error("WGFX 類別不存在");
        }
        console.log("[VSR] WGFX 模組已載入");
    } catch (error) {
        console.error("[VSR] 模組載入失敗", error);
        return;
    }

    // ===================================================================
    // WebGPU 設備管理器（單例模式）
    // ===================================================================
    class GPUDeviceManager {
        constructor() {
            this.device = null;
            this.initPromise = null;
            this.isDestroyed = false;
        }

        async initialize() {
            // 使用快取避免重複初始化
            if (this.initPromise) {
                return this.initPromise;
            }

            this.initPromise = this._doInitialize();
            return this.initPromise;
        }

        async _doInitialize() {
            try {
                if (!navigator.gpu) {
                    throw new Error("瀏覽器不支援 WebGPU");
                }

                const adapter = await navigator.gpu.requestAdapter();
                if (!adapter) {
                    throw new Error("無法取得 GPU 適配器");
                }

                this.device = await adapter.requestDevice({
                    requiredLimits: {
                        maxStorageTexturesPerShaderStage: Math.min(
                            8,
                            adapter.limits.maxStorageTexturesPerShaderStage
                        )
                    }
                });

                // 監聽設備遺失事件
                this.device.lost.then((info) => {
                    console.error("[VSR] GPU 設備遺失", info.reason, info.message);
                    this.reset();
                });

                console.log("[VSR] GPU 設備初始化成功");
                return this.device;

            } catch (error) {
                console.error("[VSR] GPU 設備初始化失敗", error);
                this.initPromise = null;
                throw error;
            }
        }

        getDevice() {
            return this.device;
        }

        reset() {
            this.device = null;
            this.initPromise = null;
        }

        destroy() {
            if (this.device && !this.isDestroyed) {
                try {
                    this.device.destroy();
                    console.log("[VSR] GPU 設備已銷毀");
                } catch (error) {
                    console.warn("[VSR] 設備銷毀失敗", error);
                }
                this.isDestroyed = true;
            }
            this.reset();
        }
    }

    // ===================================================================
    // Canvas 渲染器（封裝 WebGPU Context）
    // ===================================================================
    class CanvasRenderer {
        constructor(device) {
            this.device = device;
            this.canvas = null;
            this.context = null;
            this.configured = false;
        }

        createCanvas() {
            this.canvas = document.createElement('canvas');
            this.canvas.width = 1920;
            this.canvas.height = 1080;

            // 關鍵修改：初始化時不設定 top/left，將由 syncPosition 動態更新
            Object.assign(this.canvas.style, {
                position: 'absolute',
                zIndex: '10',
                pointerEvents: 'none',
                objectFit: 'contain',
                display: 'none'
            });

            this.context = this.canvas.getContext('webgpu');
            console.log("[VSR] Canvas 已建立");
            return this.canvas;
        }

        configure(width, height) {
            if (!this.context || !this.device) return false;

            try {
                // 更新 canvas 解析度
                this.canvas.width = width;
                this.canvas.height = height;

                // 配置 WebGPU context
                this.context.configure({
                    device: this.device,
                    format: 'rgba16float',
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
                    alphaMode: 'opaque'
                });

                this.configured = true;
                console.log(`[VSR] Canvas 已配置: ${width}x${height}`);
                return true;

            } catch (error) {
                console.error("[VSR] Canvas 配置失敗", error);
                this.configured = false;
                return false;
            }
        }

        /**
         * 同步 Canvas 與 Video 元素的位置和尺寸
         * @param {HTMLVideoElement} videoElement - Video 元素
         * @param {HTMLElement} containerElement - 父容器元素
         */
        syncPosition(videoElement, containerElement) {
            if (!this.canvas || !videoElement || !containerElement) {
                console.warn("[VSR] syncPosition: 缺少必要元素");
                return;
            }

            try {
                // 獲取 Video 相對於視口的位置
                const videoRect = videoElement.getBoundingClientRect();

                // 獲取容器相對於視口的位置
                const containerRect = containerElement.getBoundingClientRect();

                // 計算 Video 相對於容器的偏移量
                const offsetX = videoRect.left - containerRect.left;
                const offsetY = videoRect.top - containerRect.top;

                // 同步位置和尺寸
                Object.assign(this.canvas.style, {
                    left: `${offsetX}px`,
                    top: `${offsetY}px`,
                    width: `${videoRect.width}px`,
                    height: `${videoRect.height}px`
                });

                console.log(`[VSR] Canvas 位置已同步: (${offsetX.toFixed(1)}, ${offsetY.toFixed(1)}), ${videoRect.width.toFixed(1)}x${videoRect.height.toFixed(1)}`);

            } catch (error) {
                console.error("[VSR] 位置同步失敗", error);
            }
        }

        renderTexture(sourceTexture) {
            if (!this.configured || !this.device || !this.context) {
                return false;
            }

            try {
                const canvasTexture = this.context.getCurrentTexture();

                // 尺寸驗證
                if (sourceTexture.width !== canvasTexture.width ||
                    sourceTexture.height !== canvasTexture.height) {
                    console.warn("[VSR] 紋理尺寸不匹配");
                    return false;
                }

                // 複製紋理到 canvas
                const encoder = this.device.createCommandEncoder();
                encoder.copyTextureToTexture(
                    { texture: sourceTexture },
                    { texture: canvasTexture },
                    [sourceTexture.width, sourceTexture.height]
                );
                this.device.queue.submit([encoder.finish()]);

                return true;

            } catch (error) {
                console.error("[VSR] 渲染錯誤", error);
                return false;
            }
        }

        show() {
            if (this.canvas) {
                this.canvas.style.display = 'block';
            }
        }

        hide() {
            if (this.canvas) {
                this.canvas.style.display = 'none';
            }
        }

        dispose() {
            if (this.canvas && this.canvas.parentElement) {
                this.canvas.parentElement.removeChild(this.canvas);
            }
            this.canvas = null;
            this.context = null;
            this.configured = false;
        }
    }
    // ===================================================================
    // WGFX 處理引擎（封裝 WGFX 實例）
    // ===================================================================
    class WGFXProcessor {
        constructor(device) {
            this.device = device;
            this.wgfx = null;
            this.shaderCache = new Map();
            this.effectCode = null;
            this.parameters = {};
        }

        async compile(effectPath, width, height) {
            // 載入著色器代碼（快取機制）
            if (!this.shaderCache.has(effectPath)) {
                const response = await fetch(chrome.runtime.getURL(effectPath));
                if (!response.ok) {
                    throw new Error(`著色器載入失敗: ${effectPath}`);
                }
                const code = await response.text();
                this.shaderCache.set(effectPath, code);
            }

            this.effectCode = this.shaderCache.get(effectPath);

            // 建立 WGFX 實例
            try {
                const instance = await WGFXClass.create({
                    device: this.device,
                    effectCode: this.effectCode,
                    width: width,
                    height: height
                });

                // 初始化並提取參數資訊
                const metadata = instance.initialize();
                console.log(`[VSR] WGFX 編譯成功: ${width}x${height}, ${metadata.passes} passes`);

                // 設定預設參數
                if (metadata.uniforms) {
                    metadata.uniforms.forEach(uniform => {
                        if (this.parameters[uniform.name] === undefined) {
                            this.parameters[uniform.name] = uniform.default;
                        }
                    });
                    instance.updateUniforms(this.parameters);
                }

                this.wgfx = instance;
                return metadata;

            } catch (error) {
                console.error("[VSR] WGFX 編譯失敗", error);
                throw error;
            }
        }

        updateParameter(name, value) {
            this.parameters[name] = value;
            if (this.wgfx) {
                try {
                    this.wgfx.updateUniforms({[name]: value});
                } catch (error) {
                    console.warn(`[VSR] 參數更新失敗: ${name}`, error);
                }
            }
        }

        async processFrame(inputSource) {
            if (!this.wgfx) {
                throw new Error("WGFX 未初始化");
            }

            try {
                const outputTexture = await this.wgfx.process(inputSource);
                return outputTexture;
            } catch (error) {
                console.error("[VSR] 幀處理失敗", error);
                throw error;
            }
        }

        dispose() {
            if (this.wgfx) {
                try {
                    this.wgfx.dispose();
                    console.log("[VSR] WGFX 資源已釋放");
                } catch (error) {
                    console.warn("[VSR] WGFX 釋放失敗", error);
                }
                this.wgfx = null;
            }
            this.effectCode = null;
        }
    }

    // ===================================================================
    // 主控制器（生命週期管理）
    // ===================================================================
    class VSRController {
        constructor() {
            this.state = 'IDLE'; // IDLE | SEARCHING | READY | RUNNING | STOPPED
            this.abortController = null;

            // 核心元件
            this.deviceManager = new GPUDeviceManager();
            this.renderer = null;
            this.processor = null;

            // DOM 元素
            this.videoElement = null;
            this.playerContainer = null;

            // 配置
            this.pipeline = [];
            this.currentEffectPath = null;

            // 觀察器
            this.resizeObserver = null;
            this.searchInterval = null;

            // 渲染狀態
            this.frameRequestId = null;
        }

        // === 公開介面 ===

        async start() {
            if (this.state === 'RUNNING') {
                console.log("[VSR] 已在運行中");
                return;
            }

            console.log("[VSR] 啟動系統...");
            this.state = 'SEARCHING';
            this.abortController = new AbortController();

            try {
                // 1. 尋找視頻元素
                await this._findVideoElement();
                if (this._isAborted()) return;

                // 2. 初始化 GPU
                await this.deviceManager.initialize();
                if (this._isAborted()) return;

                // 3. 建立渲染器
                this.renderer = new CanvasRenderer(this.deviceManager.getDevice());
                const canvas = this.renderer.createCanvas();
                this.playerContainer.appendChild(canvas);

                // 4. 載入管線設定
                await this._loadPipelineConfig();
                if (this._isAborted()) return;

                // 5. 編譯特效
                await this._compileEffect();
                if (this._isAborted()) return;

                // 6. 設置監聽
                this._setupObservers();

                // 7. 啟動渲染
                this.state = 'RUNNING';
                this._startRenderLoop();
                this._hideOriginalVideo();

                console.log("[VSR] 系統已啟動");

            } catch (error) {
                console.error("[VSR] 啟動失敗", error);
                await this.stop();
            }
        }

        async stop() {
            console.log("[VSR] 停止系統...");

            // 中止進行中的操作
            if (this.abortController) {
                this.abortController.abort();
            }

            // 停止渲染
            this._stopRenderLoop();

            // 釋放資源（順序很重要）
            this._cleanupObservers();

            if (this.processor) {
                this.processor.dispose();
                this.processor = null;
            }

            if (this.renderer) {
                this.renderer.dispose();
                this.renderer = null;
            }

            // 恢復原始畫面
            this._showOriginalVideo();

            // 清理 DOM 引用
            this.videoElement = null;
            this.playerContainer = null;

            this.state = 'STOPPED';
            console.log("[VSR] 系統已停止");
        }

        async updatePipeline(newPipeline) {
            this.pipeline = newPipeline || [];

            if (this.state !== 'RUNNING') {
                return;
            }

            console.log("[VSR] 更新管線...");

            // 釋放舊的處理器
            if (this.processor) {
                this.processor.dispose();
                this.processor = null;
            }

            // 重新編譯
            try {
                await this._compileEffect();
            } catch (error) {
                console.error("[VSR] 管線更新失敗", error);
            }
        }

        updateParameter(name, value) {
            if (this.processor) {
                this.processor.updateParameter(name, value);
            }
        }

        // === 私有方法 ===

        async _findVideoElement() {
            return new Promise((resolve, reject) => {
                let attempts = 0;
                const maxAttempts = 20;

                this.searchInterval = setInterval(() => {
                    if (this._isAborted()) {
                        clearInterval(this.searchInterval);
                        reject(new Error("搜尋已中止"));
                        return;
                    }

                    const player = document.querySelector('.html5-video-player');
                    const video = document.querySelector('video');

                    if (player && video && video.readyState >= 1) {
                        clearInterval(this.searchInterval);
                        this.playerContainer = player;
                        this.videoElement = video;
                        console.log("[VSR] 視頻元素已找到");
                        resolve();
                        return;
                    }

                    attempts++;
                    if (attempts >= maxAttempts) {
                        clearInterval(this.searchInterval);
                        reject(new Error("找不到視頻元素"));
                    }
                }, 500);
            });
        }

        async _loadPipelineConfig() {
            if (this.pipeline.length === 0) {
                const settings = await chrome.storage.local.get(['pipeline']);
                this.pipeline = settings.pipeline || [];
            }

            if (this.pipeline.length > 0) {
                this.currentEffectPath = this.pipeline[0].path;
            }
        }

        async _compileEffect() {
            if (!this.currentEffectPath) {
                console.warn("[VSR] 無可用特效");
                return;
            }

            const width = this.videoElement.videoWidth;
            const height = this.videoElement.videoHeight;

            if (width === 0 || height === 0) {
                throw new Error("視頻尺寸無效");
            }

            // 建立處理器
            this.processor = new WGFXProcessor(this.deviceManager.getDevice());

            // 編譯特效
            await this.processor.compile(this.currentEffectPath, width, height);

            // 配置渲染器
            this.renderer.configure(width, height);

            // 應用參數
            const effectConfig = this.pipeline[0];
            if (effectConfig.params) {
                Object.entries(effectConfig.params).forEach(([name, value]) => {
                    this.processor.updateParameter(name, value);
                });
            }
        }

        _setupObservers() {
            // 尺寸監聽
            this.resizeObserver = new ResizeObserver(() => {
                this._handleResize();
            });
            this.resizeObserver.observe(this.videoElement);

            // 新增：監聽視窗大小調整
            this.windowResizeHandler = () => {
                if (this.renderer) {
                    this.renderer.syncPosition(this.videoElement, this.playerContainer);
                }
            };
            window.addEventListener('resize', this.windowResizeHandler);

            // 新增：監聽捲動事件（處理頁面捲動時的位置變化）
            this.scrollHandler = () => {
                if (this.renderer) {
                    this.renderer.syncPosition(this.videoElement, this.playerContainer);
                }
            };
            window.addEventListener('scroll', this.scrollHandler, {passive: true});

            // 視頻結束事件
            this.videoElement.addEventListener('ended', () => {
                console.log("[VSR] 視頻已結束");
                chrome.runtime.sendMessage({command: 'videoEnded'}).catch(() => {
                });
            }, {once: true});
        }

        _cleanupObservers() {
            if (this.resizeObserver) {
                this.resizeObserver.disconnect();
                this.resizeObserver = null;
            }

            if (this.searchInterval) {
                clearInterval(this.searchInterval);
                this.searchInterval = null;
            }

            // 清理視窗事件監聽器
            if (this.windowResizeHandler) {
                window.removeEventListener('resize', this.windowResizeHandler);
                this.windowResizeHandler = null;
            }

            if (this.scrollHandler) {
                window.removeEventListener('scroll', this.scrollHandler);
                this.scrollHandler = null;
            }
        }

        _handleResize() {
            if (!this.videoElement || !this.renderer || !this.renderer.canvas) {
                return;
            }

            // 關鍵修改：同步位置和尺寸
            this.renderer.syncPosition(this.videoElement, this.playerContainer);

            // 檢查解析度變化（video 內部解析度，非 DOM 尺寸）
            const vw = this.videoElement.videoWidth;
            const vh = this.videoElement.videoHeight;

            if (vw > 0 && vh > 0 &&
                (this.renderer.canvas.width !== vw || this.renderer.canvas.height !== vh)) {
                console.log(`[VSR] 解析度變更: ${vw}x${vh}`);

                // 防抖重新編譯
                clearTimeout(this._resizeDebounce);
                this._resizeDebounce = setTimeout(async () => {
                    if (this.state === 'RUNNING') {
                        await this._compileEffect();
                        // 重新編譯後再次同步位置
                        this.renderer.syncPosition(this.videoElement, this.playerContainer);
                    }
                }, 300);
            }
        }

        // === 渲染循環 ===

        _startRenderLoop() {
            if (!this.videoElement) return;

            // 初始化時同步一次位置
            if (this.renderer) {
                this.renderer.syncPosition(this.videoElement, this.playerContainer);
            }

            const renderFrame = async () => {
                if (this.state !== 'RUNNING') return;

                try {
                    await this._processAndRender();
                } catch (error) {
                    console.warn("[VSR] 渲染錯誤", error);
                }

                // 使用 rVFC 提升效能
                if (this.videoElement.requestVideoFrameCallback) {
                    this.frameRequestId = this.videoElement.requestVideoFrameCallback(renderFrame);
                } else {
                    this.frameRequestId = requestAnimationFrame(renderFrame);
                }
            };

            renderFrame();
        }
        _stopRenderLoop() {
            if (this.frameRequestId && this.videoElement) {
                if (this.videoElement.cancelVideoFrameCallback) {
                    this.videoElement.cancelVideoFrameCallback(this.frameRequestId);
                } else {
                    cancelAnimationFrame(this.frameRequestId);
                }
                this.frameRequestId = null;
            }
        }

        async _processAndRender() {
            if (!this.processor || !this.renderer) {
                // 降級顯示
                this.renderer?.hide();
                this._showOriginalVideo();
                return;
            }

            let frame = null;
            try {
                // 建立 VideoFrame（高效能）
                if (typeof VideoFrame !== 'undefined') {
                    frame = new VideoFrame(this.videoElement);
                } else {
                    frame = await createImageBitmap(this.videoElement);
                }

                // 處理幀
                const outputTexture = await this.processor.processFrame(frame);

                // 渲染到 canvas
                const success = this.renderer.renderTexture(outputTexture);

                if (success) {
                    this.renderer.show();
                    this._hideOriginalVideo();
                }

            } finally {
                // 釋放 frame
                if (frame?.close) {
                    frame.close();
                }
            }
        }

        _hideOriginalVideo() {
            if (this.videoElement) {
                this.videoElement.style.opacity = '0';
            }
        }

        _showOriginalVideo() {
            if (this.videoElement) {
                this.videoElement.style.opacity = '1';
            }
        }

        _isAborted() {
            return this.abortController?.signal.aborted;
        }
    }


    // ===================================================================
    // 訊息處理與初始化
    // ===================================================================

    const controller = new VSRController();

    // Chrome 擴充功能訊息處理
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        (async () => {
            try {
                switch (request.command) {
                    case 'setEnable':
                        if (request.isEnabled) {
                            await controller.start();
                            sendResponse({status: 'started'});
                        } else {
                            await controller.stop();
                            sendResponse({status: 'stopped'});
                        }
                        break;

                    case 'setPipeline':
                        await controller.updatePipeline(request.pipeline);
                        sendResponse({status: 'ok'});
                        break;

                    case 'updateParameter':
                        controller.updateParameter(request.paramName, request.value);
                        sendResponse({status: 'ok'});
                        break;

                    case 'navigation':
                        console.log('[VSR] 偵測到導航事件');
                        await controller.stop();
                        setTimeout(() => controller.start(), 100);
                        break;

                    default:
                        sendResponse({status: 'unknown_command'});
                }
            } catch (error) {
                console.error('[VSR] 訊息處理錯誤', error);
                sendResponse({status: 'error', message: error.message});
            }
        })();

        return true; // 保持訊息通道開啟
    });

    // 初始狀態檢查
    chrome.storage.local.get('isEnabled', (result) => {
        if (result.isEnabled) {
            controller.start();
        }
    });

    console.log("[VSR] 腳本已就緒");

})();