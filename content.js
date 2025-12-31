// YouTube VSR - Optimized Version with Race Condition Prevention
(async function () {
    // 防止腳本重複注入
    if (window.vsrInjected) {
        console.log("YouTube VSR: 腳本已注入，跳過");
        return;
    }
    window.vsrInjected = true;

    // --- 模組載入 ---
    let WGFXClass;
    try {
        const runtimeURL = chrome.runtime.getURL('wgfx.browser.esm.js');
        const runtimeModule = await import(runtimeURL);
        WGFXClass = runtimeModule.default || runtimeModule.WGFX;
        if (!WGFXClass) {
            throw new Error("找不到 WGFX 類別");
        }
        console.log("YouTube VSR: WGFX 模組已載入");
    } catch (e) {
        console.error("YouTube VSR 嚴重錯誤: 模組載入失敗", e);
        return;
    }

    // --- 狀態常數 ---
    const STATE = {
        IDLE: 'IDLE',
        SEARCHING: 'SEARCHING',
        INITIALIZING: 'INITIALIZING',
        RUNNING: 'RUNNING',
        STOPPING: 'STOPPING',
        ERROR: 'ERROR'
    };

    class VSRController {
        constructor() {
            this.state = STATE.IDLE;
            this.sequenceId = 0;
            this.isInitializing = false; // 初始化鎖

            // 核心 DOM 元素
            this.videoElement = null;
            this.canvas = null;
            this.playerContainer = null;

            // WebGPU 資源（全域共享）
            this.device = null;
            this.context = null;
            this.deviceInitPromise = null; // Promise 快取
            this.wgfx = null;

            // 循環與觀察器
            this.searchTimer = null;
            this.resizeTimeout = null;
            this.resizeObserver = null;

            // 狀態資料
            this.currentPipeline = [];
            this.currentEffectCode = null;
            this.effectParameters = {};
            this.shaderCache = new Map();

            // 事件包裝器
            this._handleVideoEndedWrapper = null;
        }

        // --- 公共介面 ---

        async start() {
            // 防止重複啟動
            if (this.isInitializing) {
                console.log("YouTube VSR: 初始化進行中，忽略啟動請求");
                return;
            }

            // 產生新的序列 ID
            const mySeq = ++this.sequenceId;

            // 如果正在運行，先停止
            if (this.state === STATE.RUNNING || this.state === STATE.INITIALIZING) {
                await this.stop(false);
            }

            console.log(`YouTube VSR [${mySeq}]: 啟動生命週期...`);
            this.state = STATE.SEARCHING;
            this.isInitializing = true;

            try {
                await this._findVideoTarget(mySeq);
            } catch (error) {
                console.error(`YouTube VSR [${mySeq}]: 啟動失敗`, error);
                this.isInitializing = false;
            }
        }

        async stop(completely = true) {
            console.log("YouTube VSR: 停止中...");

            // 設定停止狀態以中斷循環
            const previousState = this.state;
            this.state = STATE.STOPPING;
            this.isInitializing = false;

            // 停止渲染循環
            this._stopRenderLoop();

            // 釋放 WGFX
            this._disposeWGFX();

            // 清理觀察器
            this._cleanupObservers();

            // 恢復原始畫面
            await this._restoreOriginalDisplay();

            // 清理 DOM
            this._cleanupDOM();

            // 完全停止時銷毀設備
            if (completely && this.device) {
                try {
                    this.device.destroy();
                    console.log("YouTube VSR: GPU 設備已銷毀");
                } catch (e) {
                    console.warn("YouTube VSR: 設備銷毀失敗", e);
                }
                this.device = null;
                this.context = null;
                this.deviceInitPromise = null;
            }

            this.videoElement = null;

            if (completely) {
                this.state = STATE.IDLE;
                this.currentEffectCode = null;
                this.effectParameters = {};
                console.log("YouTube VSR: 已完全停止");
            } else {
                // 部分停止（保留設定）
                this.state = previousState === STATE.RUNNING ? STATE.IDLE : previousState;
            }
        }

        async setPipeline(pipeline) {
            const mySeq = ++this.sequenceId;
            this.currentPipeline = pipeline || [];

            if (this.state === STATE.IDLE || this.state === STATE.SEARCHING) {
                return;
            }

            console.log(`YouTube VSR [${mySeq}]: 更新管線...`);

            // 暫停渲染並重建
            this._disposeWGFX();
            await this._buildAndCompile(mySeq);
        }

        updateParameter(name, value) {
            this.effectParameters[name] = value;
            if (this.wgfx) {
                try {
                    this.wgfx.updateUniforms({ [name]: value });
                } catch (e) {
                    console.warn("YouTube VSR: 更新參數失敗", e);
                }
            }
        }

        // --- 私有邏輯 ---

        async _findVideoTarget(seqId) {
            const playerSelector = '.html5-video-player';
            const videoSelector = 'video';
            let retries = 20;

            return new Promise((resolve, reject) => {
                if (this.searchTimer) clearInterval(this.searchTimer);

                this.searchTimer = setInterval(async () => {
                    // 競態檢查
                    if (this.sequenceId !== seqId || this.state !== STATE.SEARCHING) {
                        clearInterval(this.searchTimer);
                        this.searchTimer = null;
                        reject(new Error("序列已過期"));
                        return;
                    }

                    const playerContainer = document.querySelector(playerSelector);
                    const video = document.querySelector(videoSelector);

                    if (playerContainer && video && video.readyState >= 1) {
                        clearInterval(this.searchTimer);
                        this.searchTimer = null;
                        console.log(`YouTube VSR [${seqId}]: 找到目標元素`);

                        try {
                            await this._initialize(seqId, playerContainer, video);
                            resolve();
                        } catch (error) {
                            reject(error);
                        }
                    } else {
                        retries--;
                        if (retries <= 0) {
                            clearInterval(this.searchTimer);
                            this.searchTimer = null;
                            console.warn(`YouTube VSR [${seqId}]: 逾時`);
                            reject(new Error("找不到視頻元素"));
                        }
                    }
                }, 500);
            });
        }

        async _initialize(seqId, playerContainer, video) {
            this.state = STATE.INITIALIZING;
            this.videoElement = video;
            this.playerContainer = playerContainer;

            try {
                // 1. 設置 WebGPU（單次初始化）
                if (!this.device) {
                    const success = await this._setupWebGPU();
                    if (!success) {
                        throw new Error("WebGPU 初始化失敗");
                    }
                }

                // 競態檢查
                if (this.sequenceId !== seqId) {
                    console.log(`YouTube VSR [${seqId}]: 序列已過期，中止初始化`);
                    return;
                }

                // 2. 配置 Canvas
                this._configureCanvas();

                // 3. 掛載 DOM
                if (this.canvas && !this.canvas.parentElement) {
                    this.playerContainer.appendChild(this.canvas);
                }

                // 4. 載入管線設定
                if (this.currentPipeline.length === 0) {
                    const settings = await chrome.storage.local.get(['pipeline']);
                    if (this.sequenceId !== seqId) return;
                    this.currentPipeline = settings.pipeline || [];
                }

                // 5. 建構與編譯
                await this._buildAndCompile(seqId);
                if (this.sequenceId !== seqId) return;

                // 6. 設置觀察器
                this._setupObservers();
                this._handleResize();

                // 7. 隱藏原始視頻
                if (this.wgfx) {
                    this.videoElement.style.opacity = '0';
                }

                this.state = STATE.RUNNING;
                this.isInitializing = false;
                console.log(`YouTube VSR [${seqId}]: 系統運行中`);

                this._renderLoop();

            } catch (error) {
                console.error(`YouTube VSR [${seqId}]: 初始化錯誤`, error);
                this.isInitializing = false;
                await this.stop();
            }
        }

        async _setupWebGPU() {
            // 使用 Promise 快取防止重複初始化
            if (this.deviceInitPromise) {
                console.log("YouTube VSR: 使用快取的設備初始化");
                return this.deviceInitPromise;
            }

            this.deviceInitPromise = (async () => {
                try {
                    if (!navigator.gpu) {
                        throw new Error("不支援 WebGPU");
                    }

                    const adapter = await navigator.gpu.requestAdapter();
                    if (!adapter) {
                        throw new Error("找不到 GPU 適配器");
                    }

                    this.device = await adapter.requestDevice({
                        requiredLimits: {
                            maxStorageTexturesPerShaderStage: Math.min(
                                8,
                                adapter.limits.maxStorageTexturesPerShaderStage
                            )
                        }
                    });

                    // 監聽設備丟失
                    this.device.lost.then((info) => {
                        console.error("YouTube VSR: GPU 設備丟失", info);
                        this.deviceInitPromise = null; // 允許重新初始化
                        this.stop();
                    });

                    // 建立 Canvas
                    this.canvas = document.createElement('canvas');
                    this.canvas.width = 1;
                    this.canvas.height = 1;
                    Object.assign(this.canvas.style, {
                        position: 'absolute',
                        zIndex: '10',
                        pointerEvents: 'none',
                        width: '100%',
                        height: '100%',
                        top: '0',
                        left: '0',
                        objectFit: 'contain'
                    });

                    this.context = this.canvas.getContext('webgpu');
                    console.log("YouTube VSR: WebGPU 設備已初始化");
                    return true;

                } catch (e) {
                    console.error("YouTube VSR: WebGPU 設置失敗", e);
                    this.deviceInitPromise = null;
                    return false;
                }
            })();

            return this.deviceInitPromise;
        }

        _configureCanvas() {
            if (!this.device || !this.context) return;

            try {
                this.context.configure({
                    device: this.device,
                    format: 'rgba16float',
                    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
                    alphaMode: 'opaque',
                });
            } catch (e) {
                console.error("YouTube VSR: Canvas 配置失敗", e);
            }
        }

        async _buildAndCompile(seqId) {
            if (this.currentPipeline.length === 0) return;

            const effectStep = this.currentPipeline[0];
            try {
                // 初始化參數
                Object.assign(this.effectParameters, effectStep.params || {});

                // 載入著色器代碼
                if (!this.shaderCache.has(effectStep.path)) {
                    const res = await fetch(chrome.runtime.getURL(effectStep.path));
                    if (!res.ok) throw new Error("著色器 404");
                    const code = await res.text();
                    this.shaderCache.set(effectStep.path, code);
                }

                // 競態檢查
                if (this.sequenceId !== seqId) {
                    console.log(`YouTube VSR [${seqId}]: 序列已過期，中止編譯`);
                    return;
                }

                this.currentEffectCode = this.shaderCache.get(effectStep.path);
                await this._compileEffect(seqId);

            } catch (e) {
                console.error("YouTube VSR: 管線建構失敗", e);
            }
        }

        async _compileEffect(seqId) {
            if (!this.currentEffectCode || !this.videoElement || !this.device) return;
            if (this.videoElement.videoWidth === 0 || this.videoElement.videoHeight === 0) return;

            try {
                const width = this.videoElement.videoWidth;
                const height = this.videoElement.videoHeight;

                // 呼叫 WGFX 介面
                const wgfxInstance = await WGFXClass.create({
                    device: this.device,
                    effectCode: this.currentEffectCode,
                    width,
                    height
                });

                // 競態檢查
                if (this.sequenceId !== seqId) {
                    console.log(`YouTube VSR [${seqId}]: 序列已過期，丟棄 WGFX 實例`);
                    wgfxInstance.dispose();
                    return;
                }

                this.wgfx = wgfxInstance;

                // 初始化 WGFX 與 Uniforms
                const metadata = this.wgfx.initialize();

                // 套用預設值
                if (metadata?.uniforms) {
                    metadata.uniforms.forEach(u => {
                        if (this.effectParameters[u.name] === undefined && u.default !== undefined) {
                            this.effectParameters[u.name] = u.default;
                        }
                    });
                }

                // 更新 uniforms
                this.wgfx.updateUniforms(this.effectParameters);

                console.log(`YouTube VSR [${seqId}]: WGFX 編譯完成 (${width}x${height})`);

            } catch (e) {
                console.error("YouTube VSR: 編譯錯誤", e);
            }
        }

        // --- 渲染循環 ---

        _renderLoop() {
            // 嚴格狀態檢查
            if (this.state !== STATE.RUNNING && this.state !== STATE.INITIALIZING) {
                return;
            }

            // 即使 wgfx 不存在也維持循環（等待編譯）
            if (!this.wgfx || !this.videoElement) {
                // 降級顯示
                if (this.canvas) this.canvas.style.display = 'none';
                if (this.videoElement) this.videoElement.style.opacity = '1';

                if (this.videoElement?.requestVideoFrameCallback) {
                    this.videoElement.requestVideoFrameCallback(() => this._renderLoop());
                } else if (this.state === STATE.RUNNING) {
                    requestAnimationFrame(() => this._renderLoop());
                }
                return;
            }

            // 正常運作
            if (this.canvas.style.display === 'none') {
                this.canvas.style.display = 'block';
                this.videoElement.style.opacity = '0';
            }

            this._processFrame().then(() => {
                if (this.state === STATE.RUNNING && this.videoElement) {
                    this.videoElement.requestVideoFrameCallback(() => this._renderLoop());
                }
            }).catch(() => {
                // 錯誤處理
                if (this.state === STATE.RUNNING) {
                    requestAnimationFrame(() => this._renderLoop());
                }
            });
        }

        async _processFrame() {
            if (!this.wgfx || !this.device) return;
            if (this.videoElement.videoWidth === 0) return;

            let frame = null;
            try {
                if (typeof VideoFrame !== 'undefined') {
                    frame = new VideoFrame(this.videoElement);
                } else {
                    frame = await createImageBitmap(this.videoElement);
                }

                const outputTexture = await this.wgfx.process(frame);
                this._renderToCanvas(outputTexture);

            } catch (e) {
                if (this.state === STATE.RUNNING) {
                    // console.warn("幀錯誤", e);
                }
            } finally {
                if (frame?.close) frame.close();
            }
        }

        _renderToCanvas(sourceTexture) {
            if (!this.device || !this.context) return;

            try {
                const canvasTexture = this.context.getCurrentTexture();

                // 驗證尺寸匹配
                if (sourceTexture.width !== canvasTexture.width ||
                    sourceTexture.height !== canvasTexture.height) {
                    return;
                }

                const commandEncoder = this.device.createCommandEncoder();
                commandEncoder.copyTextureToTexture(
                    { texture: sourceTexture },
                    { texture: canvasTexture },
                    [sourceTexture.width, sourceTexture.height]
                );
                this.device.queue.submit([commandEncoder.finish()]);
            } catch (e) {
                // WebGPU 驗證錯誤（忽略）
            }
        }

        // --- 事件處理與清理 ---

        _handleResize() {
            if (!this.videoElement || !this.canvas) return;

            // DOM 同步
            const rect = this.videoElement.getBoundingClientRect();
            Object.assign(this.canvas.style, {
                width: `${rect.width}px`,
                height: `${rect.height}px`,
                top: `${rect.top}px`,
                left: `${rect.left}px`
            });

            // 解析度同步
            const vw = this.videoElement.videoWidth;
            const vh = this.videoElement.videoHeight;

            if (vw > 0 && vh > 0 &&
                (this.canvas.width !== vw || this.canvas.height !== vh)) {
                console.log(`YouTube VSR: 偵測到尺寸變更 ${vw}x${vh}`);
                this.canvas.width = vw;
                this.canvas.height = vh;
                this._configureCanvas();

                // 防抖重新編譯
                if (this.resizeTimeout) clearTimeout(this.resizeTimeout);
                this.resizeTimeout = setTimeout(() => {
                    this._triggerRecompile();
                }, 250);
            }
        }

        async _triggerRecompile() {
            if (this.state !== STATE.RUNNING) return;

            console.log("YouTube VSR: 觸發重新編譯");
            this._disposeWGFX();
            await this._compileEffect(this.sequenceId);
        }

        async _restoreOriginalDisplay() {
            // 恢復原始視頻顯示
            if (this.videoElement) {
                this.videoElement.style.opacity = '1';
                console.log("YouTube VSR: 已恢復原始畫面");
            }

            // 隱藏 canvas
            if (this.canvas) {
                this.canvas.style.display = 'none';
            }

            // 等待下一幀確保 DOM 更新
            await new Promise(resolve => requestAnimationFrame(resolve));
        }

        _stopRenderLoop() {
            // 由狀態檢查處理
        }

        _disposeWGFX() {
            if (this.wgfx) {
                try {
                    this.wgfx.dispose();
                    console.log("YouTube VSR: WGFX 已釋放");
                } catch (e) {
                    console.warn("YouTube VSR: WGFX 釋放失敗", e);
                }
                this.wgfx = null;
            }
        }

        _cleanupObservers() {
            if (this.resizeObserver) {
                this.resizeObserver.disconnect();
                this.resizeObserver = null;
            }
            if (this.searchTimer) {
                clearInterval(this.searchTimer);
                this.searchTimer = null;
            }
            if (this.resizeTimeout) {
                clearTimeout(this.resizeTimeout);
                this.resizeTimeout = null;
            }
            if (this.videoElement && this._handleVideoEndedWrapper) {
                this.videoElement.removeEventListener('ended', this._handleVideoEndedWrapper);
                this._handleVideoEndedWrapper = null;
            }
        }

        _cleanupDOM() {
            if (this.canvas && this.canvas.parentElement) {
                this.canvas.parentElement.removeChild(this.canvas);
            }
        }

        _setupObservers() {
            if (this.resizeObserver) this.resizeObserver.disconnect();

            this.resizeObserver = new ResizeObserver(() => this._handleResize());
            this.resizeObserver.observe(this.videoElement);

            this._handleVideoEndedWrapper = () => {
                console.log("YouTube VSR: 視頻已結束");
                chrome.runtime.sendMessage({ command: 'videoEnded' }).catch(() => { });
            };
            this.videoElement.addEventListener('ended', this._handleVideoEndedWrapper, { once: true });
        }
    }

    // --- 單例實例與全域訊息處理器 ---

    const controller = new VSRController();

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        switch (request.command) {
            case 'setEnable':
                if (request.isEnabled) {
                    controller.start().then(() => sendResponse({ status: 'started' }));
                } else {
                    controller.stop().then(() => sendResponse({ status: 'stopped' }));
                }
                return true; // 保持訊息通道開啟

            case 'setPipeline':
                controller.setPipeline(request.pipeline)
                    .then(() => sendResponse({ status: 'ok' }))
                    .catch(error => sendResponse({ status: 'error', error: error.message }));
                return true;

            case 'updateParameter':
                controller.updateParameter(request.paramName, request.value);
                sendResponse({ status: 'ok' });
                break;

            case 'navigation':
                console.log('YouTube VSR: 導航事件 -> 重新啟動');
                controller.stop(false).then(() => {
                    setTimeout(() => controller.start(), 100);
                });
                break;
        }
    });

    // 初始檢查
    chrome.storage.local.get('isEnabled', (result) => {
        if (result.isEnabled) {
            controller.start();
        }
    });

})();