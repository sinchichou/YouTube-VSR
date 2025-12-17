// YouTube VSR - Refactored with WGFX Engine (Architecture Optimized)
(async function () {
    // 1. 防止腳本重複注入 (Prevent script re-injection)
    if (window.vsrInjected) {
        console.log("YouTube VSR : Script already injected, skipping.");
        return;
    }
    window.vsrInjected = true;

    // --- Module Import ---
    let WGFXClass;
    try {
        const runtimeURL = chrome.runtime.getURL('wgfx.browser.esm.js');
        const runtimeModule = await import(runtimeURL);
        if (!runtimeModule.WGFX) {
            throw new Error("WGFX class not found in the module.");
        }
        WGFXClass = runtimeModule.WGFX;
        console.log("YouTube VSR : WGFX module loaded.");
    } catch (e) {
        console.error("YouTube VSR Critical Error: Module load failed.", e);
        return;
    }

    // --- Architecture Constants ---
    const STATE = {
        IDLE: 'IDLE',                 // 靜止狀態
        SEARCHING: 'SEARCHING',       // 正在尋找 video 元素
        INITIALIZING: 'INITIALIZING', // 正在建立 WebGPU Device 與 Pipeline
        RUNNING: 'RUNNING'            // 渲染迴圈執行中
    };

    // --- State Management ---
    let currentState = STATE.IDLE;

    // 核心物件引用
    let videoElement = null;
    let canvas = null;
    let device = null;
    let context = null;

    // 流程控制變數
    let searchTimer = null;         // 用於尋找影片元素的計時器
    let animationFrameId = null;    // requestVideoFrameCallback ID
    let resizeObserver = null;      // 監聽影片大小變化
    let resizeTimeout = null;       // 防抖動 (Debounce) 用

    // WGFX 相關變數
    let wgfx = null;
    let currentEffectCode = null;
    let effectParameters = {};
    let activePipeline = [];

    // Shader Cache
    const shaderCodeCache = new Map();

    console.log("YouTube VSR : Engine Ready.");

    //================================================================================
    // Lifecycle Management (核心生命週期控制)
    //================================================================================

    /**
     * 啟動流程的唯一入口。
     * 會先重置狀態，確保不會有重複的初始化流程。
     */
    function robustStart() {
        // 如果已經在運行或初始化中，先視為無效請求，除非強制重啟（此處邏輯為忽略）
        if (currentState !== STATE.IDLE) {
            console.log(`YouTube VSR : Request ignored. Current state: ${currentState}`);
            return;
        }

        console.log("YouTube VSR : Starting lifecycle...");
        currentState = STATE.SEARCHING;

        const playerSelector = '.html5-video-player';
        const videoSelector = 'video';
        let retries = 20; // 10秒超時 (20 * 500ms)

        // 清除可能殘留的計時器
        if (searchTimer) clearInterval(searchTimer);

        searchTimer = setInterval(() => {
            // 安全檢查：如果在搜尋過程中被停止
            if (currentState !== STATE.SEARCHING) {
                clearInterval(searchTimer);
                return;
            }

            const playerContainer = document.querySelector(playerSelector);
            const video = document.querySelector(videoSelector);

            if (playerContainer && video && video.readyState >= 1) {
                clearInterval(searchTimer);
                searchTimer = null;
                console.log("YouTube VSR : Target found. Proceeding to initialization.");
                initialize(playerContainer, video);
            } else {
                retries--;
                if (retries <= 0) {
                    clearInterval(searchTimer);
                    searchTimer = null;
                    console.warn("YouTube VSR : Timeout. Video element not found.");
                    resetState(); // 回到 IDLE
                }
            }
        }, 500);
    }

    /**
     * 初始化 WebGPU 與相關資源
     * 此函數包含多個 await，必須防止競爭條件(Race Conditions)
     */
    async function initialize(playerContainer, video) {
        if (currentState !== STATE.SEARCHING) return; // 再次確認狀態

        currentState = STATE.INITIALIZING;
        videoElement = video;

        try {
            // 1. Setup WebGPU
            const gpuSuccess = await setupWebGPU();
            if (!gpuSuccess) throw new Error("WebGPU setup failed");

            // CHECKPOINT: 檢查是否在 await 期間被停止
            if (currentState !== STATE.INITIALIZING) return;

            // 2. Config Canvas
            context.configure({
                device: device,
                format: navigator.gpu.getPreferredCanvasFormat(),
                alphaMode: 'opaque',
            });

            // 3. Mount DOM
            try {
                playerContainer.appendChild(canvas);
            } catch (e) {
                throw new Error("Failed to append canvas.");
            }

            // 4. Load Pipeline Settings
            const settings = await chrome.storage.local.get(['pipeline']);

            // CHECKPOINT
            if (currentState !== STATE.INITIALIZING) return;

            await buildRenderPipeline(settings.pipeline || []);

            // 5. Setup Observers
            resizeObserver = new ResizeObserver(handleResize);
            resizeObserver.observe(videoElement);
            videoElement.addEventListener('ended', handleVideoEnded, {once: true});

            // 6. Finalize
            handleResize(); // Initial sizing

            // 若 Pipeline 建立成功，隱藏原始影片
            if (wgfx) {
                videoElement.style.opacity = '0';
            }

            currentState = STATE.RUNNING;
            console.log("YouTube VSR : System Running.");
            renderLoop();

        } catch (error) {
            console.error("YouTube VSR : Initialization Error:", error);
            stop(); // 發生錯誤時執行完整清理
        }
    }

    /**
     * 停止並清理所有資源
     * 這是唯一的清理出口，確保狀態一致性
     */
    function stop() {
        console.log("YouTube VSR : Stopping...");

        // 1. 清理 WGFX
        if (wgfx) {
            try {
                wgfx.dispose();
            } catch (e) {
            }
            wgfx = null;
        }

        // 2. 停止渲染迴圈
        if (animationFrameId && videoElement) {
            // video.cancelVideoFrameCallback is not always standard, simpler to just ignore next ID
            animationFrameId = null;
        }

        // 3. 清理 Observers 與 Events
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
        if (videoElement) {
            videoElement.removeEventListener('ended', handleVideoEnded);
            videoElement.style.opacity = '1'; // 恢復原始影片顯示
        }
        if (searchTimer) {
            clearInterval(searchTimer);
            searchTimer = null;
        }
        if (resizeTimeout) {
            clearTimeout(resizeTimeout);
            resizeTimeout = null;
        }

        // 4. 清理 DOM
        if (canvas && canvas.parentElement) {
            canvas.parentElement.removeChild(canvas);
        }

        // 5. 銷毀 GPU Device (可選，但在 VSR 場景建議銷毀以釋放 VRAM)
        if (device) {
            try {
                device.destroy();
            } catch (e) {
            }
            device = null;
            context = null;
        }

        // 6. 重置變數
        resetState();
    }

    function resetState() {
        currentState = STATE.IDLE;
        videoElement = null;
        canvas = null;
        currentEffectCode = null;
        effectParameters = {};
        console.log("YouTube VSR : Stopped and Reset.");
    }

    //================================================================================
    // Render Loop (渲染迴圈)
    //================================================================================

    async function renderLoop() {
        // 如果狀態不是 RUNNING，立即停止迴圈
        if (currentState !== STATE.RUNNING) return;

        // 如果沒有 WGFX，隱藏 Canvas 並顯示原影片，但保持迴圈運作以等待 Pipeline 更新
        if (!wgfx) {
            if (canvas) canvas.style.display = 'none';
            if (videoElement) videoElement.style.opacity = '1';
            if (videoElement) {
                animationFrameId = videoElement.requestVideoFrameCallback(renderLoop);
            }
            return;
        }

        // 檢查影片狀態
        if (!videoElement || videoElement.readyState < 2 || videoElement.videoWidth === 0) {
            if (videoElement) {
                animationFrameId = videoElement.requestVideoFrameCallback(renderLoop);
            }
            return;
        }

        // 確保 Canvas 可見
        if (canvas && canvas.style.display === 'none') {
            canvas.style.display = 'block';
            videoElement.style.opacity = '0';
        }

        let frameBitmap = null;
        try {
            // 嘗試擷取 Frame
            frameBitmap = await createImageBitmap(videoElement);

            // WGFX 處理
            const outputTextureView = await wgfx.processFrame({
                frameBitmap: frameBitmap,
                uniforms: effectParameters
            });

            // 繪製到 Canvas (Blit)
            renderToCanvas(outputTextureView);

            frameBitmap.close();
        } catch (e) {
            // 如果是在 destroy 後發生的錯誤則忽略，否則印出警告
            if (currentState === STATE.RUNNING) {
                console.warn("YouTube VSR : Frame skipped.", e);
            }
            if (frameBitmap && frameBitmap.close) frameBitmap.close();
        }

        // 請求下一幀
        if (currentState === STATE.RUNNING && videoElement) {
            animationFrameId = videoElement.requestVideoFrameCallback(renderLoop);
        }
    }

    function renderToCanvas(sourceView) {
        if (!device || !context) return;

        const canvasTexture = context.getCurrentTexture();
        const commandEncoder = device.createCommandEncoder();

        // 懶加載 Blit Pipeline (只建立一次)
        if (!window._vsrBlitPipeline) {
            initBlitPipeline();
        }

        const blitBindGroup = device.createBindGroup({
            layout: window._vsrBlitBindGroupLayout,
            entries: [
                {binding: 0, resource: sourceView},
                {binding: 1, resource: window._vsrBlitSampler}
            ]
        });

        const renderPass = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: canvasTexture.createView(),
                loadOp: 'clear',
                clearValue: {r: 0, g: 0, b: 0, a: 1},
                storeOp: 'store'
            }]
        });

        renderPass.setPipeline(window._vsrBlitPipeline);
        renderPass.setBindGroup(0, blitBindGroup);
        renderPass.draw(3);
        renderPass.end();

        device.queue.submit([commandEncoder.finish()]);
    }

    function initBlitPipeline() {
        // 使用 window 全域緩存，避免重複編譯
        const blitShaderModule = device.createShaderModule({
            code: `
            @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
                var pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
                return vec4f(pos[vi], 0.0, 1.0);
            }
            @group(0) @binding(0) var tex: texture_2d<f32>;
            @group(0) @binding(1) var smp: sampler;
            @fragment fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
                let uv = pos.xy / vec2f(${canvas.width}.0, ${canvas.height}.0);
                return textureSample(tex, smp, uv);
            }
        `
        });

        window._vsrBlitBindGroupLayout = device.createBindGroupLayout({
            entries: [
                {binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: 'float'}},
                {binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {type: 'filtering'}}
            ]
        });

        window._vsrBlitPipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({bindGroupLayouts: [window._vsrBlitBindGroupLayout]}),
            vertex: {module: blitShaderModule, entryPoint: 'vs_main'},
            fragment: {
                module: blitShaderModule, entryPoint: 'fs_main',
                targets: [{format: navigator.gpu.getPreferredCanvasFormat()}]
            },
            primitive: {topology: 'triangle-list'}
        });

        window._vsrBlitSampler = device.createSampler({magFilter: 'linear', minFilter: 'linear'});
    }

    //================================================================================
    // WebGPU & Pipeline Logic
    //================================================================================

    async function setupWebGPU() {
        try {
            if (!navigator.gpu) throw new Error("WebGPU not supported");
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error("No GPU adapter found");

            device = await adapter.requestDevice({
                requiredLimits: {
                    maxStorageTexturesPerShaderStage: Math.min(8, adapter.limits.maxStorageTexturesPerShaderStage)
                }
            });

            device.lost.then(() => {
                console.error("YouTube VSR : Device lost.");
                stop();
            });

            canvas = document.createElement('canvas');
            Object.assign(canvas.style, {
                position: 'absolute', zIndex: '10', pointerEvents: 'none'
            });
            context = canvas.getContext('webgpu');

            return true;
        } catch (e) {
            console.error(e);
            return false;
        }
    }

    async function buildRenderPipeline(newPipeline) {
        if (!device) return;

        // 清理舊的 WGFX
        if (wgfx) {
            wgfx.dispose();
            wgfx = null;
        }

        activePipeline = newPipeline || [];
        effectParameters = {};
        currentEffectCode = null;

        if (activePipeline.length === 0) {
            console.log("YouTube VSR : Pipeline empty.");
            return;
        }

        // 目前範例只取第一個效果
        const effectStep = activePipeline[0];
        try {
            currentEffectCode = await loadShaderCode(effectStep.path);
            Object.assign(effectParameters, effectStep.params || {});

            console.log("YouTube VSR : Compiling pipeline:", effectStep.path);
            await recompileEffect(true);
        } catch (e) {
            console.error("YouTube VSR : Pipeline build failed", e);
        }
    }

    async function recompileEffect(isInitialBuild = false) {
        if (!currentEffectCode || !videoElement || !device) return;

        // 確保尺寸有效
        if (videoElement.videoWidth === 0 || videoElement.videoHeight === 0) return;

        if (!isInitialBuild && wgfx) return; // 如果不是強制重建且已有實例，跳過

        try {
            const width = videoElement.videoWidth;
            const height = videoElement.videoHeight;

            wgfx = await WGFXClass.create({
                device,
                effectCode: currentEffectCode,
                externalResources: {
                    defines: {INPUT_WIDTH: width, INPUT_HEIGHT: height},
                    textures: {
                        INPUT: {
                            size: [width, height],
                            format: 'rgba8unorm',
                            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                        },
                        OUTPUT: {
                            size: [width, height],
                            format: 'rgba16float',
                            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT
                        }
                    }
                }
            });

            // 初始化參數
            const metadata = wgfx.initialize();
            if (metadata?.uniforms) {
                metadata.uniforms.forEach(u => {
                    if (effectParameters[u.name] === undefined && u.default !== undefined) {
                        effectParameters[u.name] = u.default;
                    }
                });
            }

        } catch (e) {
            console.error("YouTube VSR : Shader compilation failed", e);
        }
    }

    async function loadShaderCode(path) {
        if (shaderCodeCache.has(path)) return shaderCodeCache.get(path);
        const res = await fetch(chrome.runtime.getURL(path));
        if (!res.ok) throw new Error("Shader 404");
        const code = await res.text();
        shaderCodeCache.set(path, code);
        return code;
    }

    //================================================================================
    // Utils & Event Handlers
    //================================================================================

    function handleResize() {
        if (currentState !== STATE.RUNNING || !videoElement || !canvas) return;

        const rect = videoElement.getBoundingClientRect();
        // 簡單同步位置
        Object.assign(canvas.style, {
            width: `${rect.width}px`, height: `${rect.height}px`,
            top: `${rect.top}px`, left: `${rect.left}px`
        });

        // 檢查解析度變更 (防抖動)
        if (canvas.width !== rect.width || canvas.height !== rect.height) {
            canvas.width = rect.width;
            canvas.height = rect.height;
            context.configure({
                device: device,
                format: navigator.gpu.getPreferredCanvasFormat(),
                alphaMode: 'opaque'
            });

            clearTimeout(resizeTimeout);
            resizeTimeout = setTimeout(() => {
                if (wgfx) {
                    wgfx.dispose();
                    wgfx = null;
                }
                recompileEffect(true);
            }, 250);
        }
    }

    function handleVideoEnded() {
        console.log("YouTube VSR : Video Ended");
        chrome.runtime.sendMessage({command: 'videoEnded'}).catch(() => {
        });
    }

    //================================================================================
    // Message & Event Listeners
    //================================================================================

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        // 重要：這裏不直接處理 async 邏輯，避免 Promise 懸空
        switch (request.command) {
            case 'setEnable':
                if (request.isEnabled) {
                    if (currentState === STATE.IDLE) robustStart();
                } else {
                    stop();
                }
                break;
            case 'setPipeline':
                // 這裡需要 async，但在事件監聽器中要小心處理
                buildRenderPipeline(request.pipeline).then(() => sendResponse({status: 'ok'}));
                return true; // 表示非同步回應
            case 'updateParameter':
                effectParameters[request.paramName] = request.value;
                break;
            case 'navigation':
                console.log('YouTube VSR : Navigation detected. Restarting...');
                stop();
                // 這裡給一點點延遲讓 DOM 穩定
                setTimeout(robustStart, 100);
                break;
        }
    });

    // 初始檢查
    chrome.storage.local.get('isEnabled', (result) => {
        if (result.isEnabled) {
            robustStart();
        }
    });

})();