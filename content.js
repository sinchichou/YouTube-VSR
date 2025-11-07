// YouTube VSR - WebGPU 多通道引擎
(function () {
    // 防止腳本重複注入
    if (window.vsrInjected) {
        console.log("YouTube VSR : VSR 腳本已注入，中止。");
        return;
    }
    window.vsrInjected = true;

    // --- 狀態變數 ---
    let isRunning = false; // 渲染引擎是否正在運行
    let videoElement = null; // 當前的 <video> 元素
    let canvas = null; // 用於 WebGPU 渲染的 <canvas> 元素
    let device = null; // WebGPU 設備
    let context = null; // WebGPU 畫布上下文
    let animationFrameId = null; // requestVideoFrameCallback 的 ID
    let resizeObserver = null; // 用於監聽影片元素尺寸變更
    let currentVideoElement = null; // 當前正在處理的影片元素

    // --- WebGPU 相關變數 ---
    let pipeline = []; // 從 popup.js 接收的管線設定
    let gpuRenderables = []; // 儲存每個管線階段的 GPU 資源
    let sourceTexture = null; // 原始影片紋理
    let pingPongTextures = []; // 用於多通道渲染的紋理
    let fullscreenQuadVS = null; // 共用的頂點著色器
    let sampler = null; // 共用的採樣器
    let finalPass = null; // 用於最終繪製到畫布的管線
    let parser = null; // ShaderParser 的實例

    console.log("YouTube VSR : YouTube VSR WebGPU 引擎已載入。");

    //================================================================================
    // 核心邏輯 (設定, 渲染, 清理)
    //================================================================================

    /**
     * 啟動 VSR 引擎。
     * 尋找影片元素並開始初始化流程。
     */
    async function start() {
        if (isRunning) return;
        console.log("YouTube VSR : 收到啟動指令。");

        videoElement = document.querySelector('video');
        if (!videoElement) {
            console.error("YouTube VSR 錯誤：找不到 <video> 元素。");
            return;
        }

        // 如果影片元數據尚未載入，則等待事件
        if (videoElement.readyState < 1) {
            videoElement.addEventListener('loadedmetadata', initialize, { once: true });
            return;
        }
        await initialize();
    }

    /**
     * 初始化 WebGPU、著色器管線和事件監聽器。
     */
    async function initialize() {
        if (isRunning) return;
        if (!(await setupWebGPU())) return;

        try {
            const parserURL = chrome.runtime.getURL('wgfx/parser.js');
            const parserModule = await import(parserURL);
            parser = new parserModule.ShaderParser();
        } catch (e) {
            console.error("YouTube VSR 錯誤：無法載入 parser.js 模組。", e);
            stop();
            return;
        }

        const settings = await chrome.storage.local.get(['pipeline']);
        await buildRenderPipeline(settings.pipeline || []);

        resizeObserver = new ResizeObserver(syncCanvasDimensions);
        resizeObserver.observe(videoElement);

        videoElement.addEventListener('resize', recreateFrameTextures);
        setupVideoEndedListener(); // NEW: 設定影片結束監聽器


        // 首次手動觸發，確保初始狀態正確
        syncCanvasDimensions(); // 現在這個函式會處理所有尺寸問題
        recreateFrameTextures();

        videoElement.style.opacity = '0'; // 隱藏原始影片
        isRunning = true;
        console.log("YouTube VSR : 初始化完成，開始擷取畫面。");
        renderLoop();
    }

    /**
     * 停止 VSR 引擎並清理所有資源。
     */
    function stop() {
        if (!isRunning) return;
        console.log("YouTube VSR : 收到停止指令。");

        if (animationFrameId && videoElement) videoElement.cancelVideoFrameCallback(animationFrameId);

        if (resizeObserver) resizeObserver.disconnect();
        if (videoElement) {
            videoElement.removeEventListener('resize', recreateFrameTextures);
            videoElement.removeEventListener('ended', handleVideoEnded); // REMOVE: 移除影片結束監聽器
        }

        if (canvas) canvas.remove();
        if (device) device.destroy();
        if (videoElement) videoElement.style.opacity = '1'; // 恢復原始影片可見度

        // 重設所有狀態變數
        isRunning = false; videoElement = null; canvas = null; device = null;
        context = null; animationFrameId = null; resizeObserver = null;
        gpuRenderables = []; pipeline = []; finalPass = null;
        pingPongTextures.forEach(t => t.destroy());
        pingPongTextures = [];
        sourceTexture?.destroy();
        sourceTexture = null;
        console.log("YouTube VSR : 擷取已停止並清理資源。");
    }

    /**
     * 主渲染迴圈。
     * 每一影格從影片元素複製紋理，並通過渲染管線處理，最後繪製到畫布上。
     */
    function renderLoop() {
        if (!isRunning || !device || !sourceTexture || videoElement.readyState < 2 || videoElement.videoWidth === 0) {
            if (isRunning && videoElement) {
                animationFrameId = videoElement.requestVideoFrameCallback(renderLoop);
            }
            return;
        }

        try {
            device.queue.copyExternalImageToTexture(
                { source: videoElement },
                { texture: sourceTexture },
                [videoElement.videoWidth, videoElement.videoHeight]
            );
        } catch (e) {
            if (e.name === "OperationError") {
                console.warn("YouTube VSR : copyExternalImageToTexture 失敗，可能因為頁面導航。正在停止。", e);
                stop();
            } else {
                console.error("YouTube VSR 錯誤：", e);
            }
            return;
        }

        const commandEncoder = device.createCommandEncoder({ label: 'VSR Command Encoder' });
        let currentSource = sourceTexture;

        // 執行每個渲染通道
        if (gpuRenderables.length > 0) {
            for (let i = 0; i < gpuRenderables.length; i++) {
                const renderable = gpuRenderables[i];
                const destinationTexture = pingPongTextures[i % 2];

                if (renderable.type === 'compute') {
                    const passEncoder = commandEncoder.beginComputePass();
                    passEncoder.setPipeline(renderable.pipeline);
                    const bindGroup = createComputeBindGroup(renderable, currentSource, destinationTexture);
                    passEncoder.setBindGroup(0, bindGroup);
                    const blockSize = renderable.shaderInfo?.passes[0]?.metadata?.block_size || 8;
                    const workgroupCountX = Math.ceil(videoElement.videoWidth / blockSize);
                    const workgroupCountY = Math.ceil(videoElement.videoHeight / blockSize);
                    passEncoder.dispatchWorkgroups(workgroupCountX, workgroupCountY);
                    passEncoder.end();
                } else { // 'render'
                    const passEncoder = commandEncoder.beginRenderPass({
                        colorAttachments: [{
                            view: destinationTexture.createView(),
                            loadOp: 'clear', storeOp: 'store',
                            clearValue: { r: 0, g: 0, b: 0, a: 1 }
                        }]
                    });
                    passEncoder.setPipeline(renderable.pipeline);
                    const bindGroup = createRenderBindGroup(renderable, currentSource);
                    passEncoder.setBindGroup(0, bindGroup);
                    passEncoder.draw(6, 1, 0, 0);
                    passEncoder.end();
                }
                currentSource = destinationTexture;
            }
        }

        // 最終通道，將結果繪製到畫布
        const finalPassEncoder = commandEncoder.beginRenderPass({
            colorAttachments: [{
                view: context.getCurrentTexture().createView(),
                loadOp: 'clear', storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 }
            }]
        });
        const finalRenderable = getFinalPassRenderable(currentSource);
        finalPassEncoder.setPipeline(finalRenderable.pipeline);
        finalPassEncoder.setBindGroup(0, finalRenderable.bindGroup);
        finalPassEncoder.draw(4, 1, 0, 0);
        finalPassEncoder.end();

        device.queue.submit([commandEncoder.finish()]);
        animationFrameId = videoElement.requestVideoFrameCallback(renderLoop);
    }

    //================================================================================
    // WEBGPU 設定 & 管線建立
    //================================================================================

    /**
     * 設定 WebGPU 設備、上下文和共用資源。
     * @returns {Promise<boolean>} 是否設定成功。
     */
    async function setupWebGPU() {
        try {
            if (!navigator.gpu) throw new Error("不支援 WebGPU。");
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error("找不到 GPU 適配器。");
            device = await adapter.requestDevice();

            device.lost.then(info => {
                console.error(`WebGPU 設備遺失: ${info.message}`);
                if (info.reason !== 'destroyed') stop();
            });

            canvas = document.createElement('canvas');
            const playerContainer = document.querySelector('.html5-video-player');
            playerContainer.appendChild(canvas);

            context = canvas.getContext('webgpu');
            const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
            context.configure({ device, format: presentationFormat, alphaMode: 'premultiplied' });

            fullscreenQuadVS = device.createShaderModule({
                label: 'Fullscreen Triangle VS',
                code: `@vertex fn main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
                    let pos = array<vec2<f32>, 6>(vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(-1,1),vec2(1,-1),vec2(1,1));
                    return vec4<f32>(pos[vi], 0.0, 1.0);
                }`
            });
            sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
            return true;
        } catch (e) {
            console.error("YouTube VSR 錯誤：WebGPU 設定失敗：", e);
            stop();
            return false;
        }
    }

    /**
     * 根據提供的管線設定建立渲染管線。
     * @param {Array} newPipeline - 新的管線設定。
     */
    async function buildRenderPipeline(newPipeline) {
        if (!device || !parser) return;
        pipeline = newPipeline || [];
        gpuRenderables = [];

        for (const step of pipeline) {
            try {
                const fullCode = await loadShaderCode(step.path);
                const shaderInfo = parser.parse(fullCode);
                const fsModule = device.createShaderModule({ label: step.path, code: shaderInfo.codeBody });

                const compilationInfo = await fsModule.getCompilationInfo();
                if (compilationInfo.messages.some(m => m.type === 'error')) {
                    console.error(`編譯 ${step.path} 時發生錯誤:`, compilationInfo.messages);
                    continue;
                }

                let stepPipeline;
                const isCompute = shaderInfo.codeBody.includes('@compute');

                if (isCompute) {
                    stepPipeline = await device.createComputePipelineAsync({
                        label: `管線 (Compute) - ${step.path}`,
                        layout: 'auto',
                        compute: { module: fsModule, entryPoint: 'main' }
                    });
                } else {
                    stepPipeline = await device.createRenderPipelineAsync({
                        label: `管線 (Render) - ${step.path}`,
                        layout: 'auto',
                        vertex: { module: fullscreenQuadVS, entryPoint: 'main' },
                        fragment: { module: fsModule, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] }
                    });
                }

                let uniformBuffer = null;
                const uniformBufferSize = shaderInfo.parameters.length * 4;
                if (uniformBufferSize > 0) {
                    uniformBuffer = device.createBuffer({
                        label: `Uniforms - ${step.path}`,
                        size: Math.max(16, uniformBufferSize),
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    });
                    updateUniformBuffer(uniformBuffer, shaderInfo.parameters, step.params);
                }

                gpuRenderables.push({
                    instanceId: step.instanceId,
                    pipeline: stepPipeline,
                    type: isCompute ? 'compute' : 'render',
                    shaderInfo: shaderInfo,
                    parameters: shaderInfo.parameters,
                    uniformBuffer,
                    params: step.params
                });
            } catch (e) {
                console.error(`為 ${step.path} 建立管線失敗:`, e);
            }
        }
        console.log(`YouTube VSR : 已建立 ${gpuRenderables.length} 個可渲染步驟。`);
    }

    /**
     * 為計算著色器建立綁定組。
     * @param {object} renderable - 可渲染物件。
     * @param {GPUTexture} sourceTexture - 輸入紋理。
     * @param {GPUTexture} destinationTexture - 輸出紋理。
     * @returns {GPUBindGroup} 綁定組。
     */
    function createComputeBindGroup(renderable, sourceTexture, destinationTexture) {
        const entries = [];
        if (renderable.uniformBuffer) entries.push({ binding: 0, resource: { buffer: renderable.uniformBuffer } });
        entries.push({ binding: 1, resource: sourceTexture.createView() });
        entries.push({ binding: 2, resource: destinationTexture.createView() });
        entries.push({ binding: 3, resource: sampler });

        return device.createBindGroup({ layout: renderable.pipeline.getBindGroupLayout(0), entries: entries });
    }

    /**
     * 為渲染著色器建立綁定組。
     * @param {object} renderable - 可渲染物件。
     * @param {GPUTexture} sourceTexture - 輸入紋理。
     * @returns {GPUBindGroup} 綁定組。
     */
    function createRenderBindGroup(renderable, sourceTexture) {
        const entries = [];
        if (renderable.uniformBuffer) entries.push({ binding: 0, resource: { buffer: renderable.uniformBuffer } });
        entries.push({ binding: 1, resource: sourceTexture.createView() });
        entries.push({ binding: 3, resource: sampler });

        return device.createBindGroup({ layout: renderable.pipeline.getBindGroupLayout(0), entries: entries });
    }

    /**
     * 取得或建立最終將結果繪製到畫布的渲染通道。
     * @param {GPUTexture} texture - 要繪製的最終紋理。
     * @returns {object} 最終通道的可渲染物件。
     */
    function getFinalPassRenderable(texture) {
        if (!finalPass) {
            const shaderModule = device.createShaderModule({
                label: 'Final Pass Shader',
                code: `
                    struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) uv: vec2<f32> };
                    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
                        let x = f32((vi << 1u) & 2u) - 1.0; let y = f32(vi & 2u) - 1.0;
                        var o: VertexOutput; o.position = vec4<f32>(x, y, 0.0, 1.0); o.uv = vec2<f32>(x*0.5+0.5, -y*0.5+0.5); return o;
                    }
                    @group(0)@binding(0) var s: sampler; @group(0)@binding(1) var t: texture_2d<f32>;
                    @fragment fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> { return textureSample(t, s, uv); }
                `,
            });
            const pipeline = device.createRenderPipeline({
                label: 'Final Pass Pipeline', layout: 'auto',
                vertex: { module: shaderModule, entryPoint: 'vs_main' },
                fragment: { module: shaderModule, entryPoint: 'fs_main', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] },
                primitive: { topology: 'triangle-strip' },
            });
            finalPass = { pipeline };
        }
        finalPass.bindGroup = device.createBindGroup({
            layout: finalPass.pipeline.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: sampler }, { binding: 1, resource: texture.createView() }]
        });
        return finalPass;
    }

    //================================================================================
    // 工具 & 事件處理
    //================================================================================

    /**
     * 同步畫布的渲染緩衝區大小和 CSS 顯示大小。
     */
    function syncCanvasDimensions() {
        if (!isRunning || !videoElement || !canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const newWidth = Math.round(videoElement.clientWidth * dpr);
        const newHeight = Math.round(videoElement.clientHeight * dpr);

        if (canvas.width !== newWidth || canvas.height !== newHeight) {
            canvas.width = newWidth;
            canvas.height = newHeight;
            console.log(`YouTube VSR : 畫布渲染緩衝區大小已調整為 ${newWidth}x${newHeight} (DPR: ${dpr})`);
        }

        const computedStyle = getComputedStyle(videoElement);
        Object.assign(canvas.style, {
            width: computedStyle.width, height: computedStyle.height,
            top: computedStyle.top, left: computedStyle.left,
            position: 'absolute', zIndex: '10',
            pointerEvents: 'none'
        });
    }

    /**
     * 當影片解析度變更時，重新建立影格紋理。
     */
    function recreateFrameTextures() {
        if (!device || !videoElement || videoElement.videoWidth === 0) return;
        const width = videoElement.videoWidth;
        const height = videoElement.videoHeight;

        if (sourceTexture && sourceTexture.width === width && sourceTexture.height === height) return;

        sourceTexture?.destroy();
        sourceTexture = device.createTexture({
            size: [width, height], format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });

        pingPongTextures.forEach(t => t.destroy());
        pingPongTextures = [
            device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING }),
            device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING })
        ];
        console.log(`YouTube VSR : 已為新解析度重新建立紋理: ${width}x${height}`);
    }

    /**
     * 更新著色器的 uniform 緩衝區。
     * @param {GPUBuffer} buffer - 要更新的緩衝區。
     * @param {Array} parameters - 著色器參數定義。
     * @param {object} storedParams - 儲存的參數值。
     */
    function updateUniformBuffer(buffer, parameters, storedParams) {
        if (!parameters || parameters.length === 0) return;
        const data = new Float32Array(parameters.length);
        parameters.forEach((param, i) => {
            const value = storedParams[param.name] !== undefined ? storedParams[param.name] : param.default;
            data[i] = value;
        });
        device.queue.writeBuffer(buffer, 0, data);
    }

    const shaderCodeCache = new Map();

    /**
     * 載入著色器程式碼，並使用快取。
     * @param {string} path - 著色器檔案的路徑。
     * @returns {Promise<string>} 著色器程式碼。
     */
    async function loadShaderCode(path) {
        if (shaderCodeCache.has(path)) return shaderCodeCache.get(path);
        const fullPath = chrome.runtime.getURL(path);
        const response = await fetch(fullPath);
        if (!response.ok) throw new Error(`在 ${path} 找不到著色器 (${response.status})`);
        const code = await response.text();
        shaderCodeCache.set(path, code);
        return code;
    }

    /**
     * 處理影片播放結束事件。
     */
    function handleVideoEnded() {
        console.log("YouTube VSR : 影片播放結束。");
        chrome.runtime.sendMessage({command: 'videoEnded'});
    }

    /**
     * 設定影片結束事件的監聽器。
     */
    function setupVideoEndedListener() {
        if (videoElement) {
            videoElement.addEventListener('ended', handleVideoEnded, {once: true});
            console.log("YouTube VSR : 已設定影片結束監聽器。");
        }
    }

    //================================================================================
    // 訊息監聽器
    //================================================================================

    /**
     * 監聽來自擴充功能其他部分的訊息 (例如 popup.js, background.js)。
     */
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        let isAsync = false;
        switch (request.command) {
            case 'setEnable':
                request.isEnabled ? start() : stop();
                break;
            case 'setPipeline':
                isAsync = true;
                buildRenderPipeline(request.pipeline).then(() => sendResponse({ status: 'ok' }));
                break;
            case 'updateParameter':
                const renderable = gpuRenderables.find(r => r.instanceId === request.instanceId);
                if (renderable && renderable.uniformBuffer) {
                    renderable.params[request.paramName] = request.value;
                    updateUniformBuffer(renderable.uniformBuffer, renderable.parameters, renderable.params);
                }
                break;

            // 處理來自 background.js 的導航事件
            case 'navigation':
                console.log('YouTube VSR : 偵測到導航，重新初始化...');
                // 先停止當前的實例來清理所有資源
                if (isRunning) {
                    stop();
                }
                // 使用一個小延遲來確保 YouTube 的 DOM 已經更新完畢，新的 <video> 元素已經可用
                setTimeout(() => {
                    // 只有在擴充功能是啟用狀態時才自動重啟
                    chrome.storage.local.get('isEnabled', (result) => {
                        if (result.isEnabled) {
                            start();
                        }
                    });
                }, 1000); // 1 秒的延遲通常足夠
                break;
        }
        return isAsync;
    });

    /**
     * 在腳本載入時檢查擴充功能是否已啟用，若是則啟動。
     */
    chrome.storage.local.get('isEnabled', (result) => {
        if (result.isEnabled) {
            setTimeout(start, 1500);
        }
    });
})();
