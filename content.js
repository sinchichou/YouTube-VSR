// YouTube VSR - WebGPU Multi-pass Engine
(function () {
    // 防止腳本重複注入
    if (window.vsrInjected) {
        console.log("YouTube VSR : VSR script already injected. Aborting.");
        return;
    }
    window.vsrInjected = true;

    // --- 狀態變數 ---
    let isRunning = false;
    let videoElement = null;
    let canvas = null;
    let device = null;
    let context = null;
    let animationFrameId = null;
    let resizeObserver = null;

    // --- WebGPU 相關變數 ---
    let pipeline = []; // 從 popup.js 接收的管線設定
    let gpuRenderables = []; // 儲存每個管線階段的 GPU 資源
    let sourceTexture = null; // 原始影片紋理
    let pingPongTextures = []; // 用於多通道渲染的紋理
    let fullscreenQuadVS = null; // 共用的頂點著色器
    let sampler = null;
    let finalPass = null; // 用於最終繪製到畫布的管線
    let parser = null; // ShaderParser 的實例

    console.log("YouTube VSR : YouTube VSR WebGPU Engine Loaded.");

    //================================================================================
    // 核心邏輯 (設定, 渲染, 清理)
    //================================================================================

    async function start() {
        if (isRunning) return;
        console.log("YouTube VSR : Start command received.");

        videoElement = document.querySelector('video');
        if (!videoElement) {
            console.error("YouTube VSR Error: Could not find a <video> element.");
            return;
        }

        if (videoElement.readyState < 1) {
            videoElement.addEventListener('loadedmetadata', initialize, { once: true });
            return;
        }
        await initialize();
    }

    async function initialize() {
        if (isRunning) return;
        if (!(await setupWebGPU())) return;

        try {
            const parserURL = chrome.runtime.getURL('wgfx/parser.js');
            const parserModule = await import(parserURL);
            parser = new parserModule.ShaderParser();
        } catch (e) {
            console.error("YouTube VSR Error: Could not load parser.js module.", e);
            stop();
            return;
        }

        const settings = await chrome.storage.local.get(['pipeline']);
        await buildRenderPipeline(settings.pipeline || []);

        resizeObserver = new ResizeObserver(syncCanvasDimensions);
        resizeObserver.observe(videoElement);

        videoElement.addEventListener('resize', recreateFrameTextures);

        // 首次手動觸發，確保初始狀態正確
        syncCanvasDimensions(); // 現在這個函式會處理所有尺寸問題
        recreateFrameTextures();

        videoElement.style.opacity = '0';
        isRunning = true;
        console.log("YouTube VSR : Initialization complete. Capture started.");
        renderLoop();
    }

    function stop() {
        if (!isRunning) return;
        console.log("YouTube VSR : Stop command received.");

        if (animationFrameId && videoElement) videoElement.cancelVideoFrameCallback(animationFrameId);

        if (resizeObserver) resizeObserver.disconnect();
        if (videoElement) videoElement.removeEventListener('resize', recreateFrameTextures);

        if (canvas) canvas.remove();
        if (device) device.destroy();
        if (videoElement) videoElement.style.opacity = '1';

        isRunning = false; videoElement = null; canvas = null; device = null;
        context = null; animationFrameId = null; resizeObserver = null;
        gpuRenderables = []; pipeline = []; finalPass = null;
        pingPongTextures.forEach(t => t.destroy());
        pingPongTextures = [];
        sourceTexture?.destroy();
        sourceTexture = null;
        console.log("YouTube VSR : Capture stopped and resources cleaned up.");
    }

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
                console.warn("YouTube VSR: copyExternalImageToTexture failed, likely due to page navigation. Stopping.", e);
                stop();
            } else {
                console.error("YouTube VSR Error:", e);
            }
            return;
        }

        const commandEncoder = device.createCommandEncoder({ label: 'VSR Command Encoder' });
        let currentSource = sourceTexture;

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

    async function setupWebGPU() {
        try {
            if (!navigator.gpu) throw new Error("WebGPU not supported.");
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error("No GPU adapter found.");
            device = await adapter.requestDevice();

            device.lost.then(info => {
                console.error(`WebGPU device was lost: ${info.message}`);
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
            console.error("YouTube VSR Error: WebGPU setup failed:", e);
            stop();
            return false;
        }
    }

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
                    console.error(`Error compiling ${step.path}:`, compilationInfo.messages);
                    continue;
                }

                let stepPipeline;
                const isCompute = shaderInfo.codeBody.includes('@compute');

                if (isCompute) {
                    stepPipeline = await device.createComputePipelineAsync({
                        label: `Pipeline (Compute) - ${step.path}`,
                        layout: 'auto',
                        compute: { module: fsModule, entryPoint: 'main' }
                    });
                } else {
                    stepPipeline = await device.createRenderPipelineAsync({
                        label: `Pipeline (Render) - ${step.path}`,
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
                console.error(`Failed to build pipeline for ${step.path}:`, e);
            }
        }
        console.log(`YouTube VSR : Built ${gpuRenderables.length} renderable steps.`);
    }

    function createComputeBindGroup(renderable, sourceTexture, destinationTexture) {
        const entries = [];
        if (renderable.uniformBuffer) entries.push({ binding: 0, resource: { buffer: renderable.uniformBuffer } });
        entries.push({ binding: 1, resource: sourceTexture.createView() });
        entries.push({ binding: 2, resource: destinationTexture.createView() });
        entries.push({ binding: 3, resource: sampler });

        return device.createBindGroup({ layout: renderable.pipeline.getBindGroupLayout(0), entries: entries });
    }

    function createRenderBindGroup(renderable, sourceTexture) {
        const entries = [];
        if (renderable.uniformBuffer) entries.push({ binding: 0, resource: { buffer: renderable.uniformBuffer } });
        entries.push({ binding: 1, resource: sourceTexture.createView() });
        entries.push({ binding: 3, resource: sampler });

        return device.createBindGroup({ layout: renderable.pipeline.getBindGroupLayout(0), entries: entries });
    }

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
     * *** KEY CHANGE: 更新此函式以同步畫布的兩種尺寸 ***
     * 現在它會設定繪圖緩衝區大小(canvas.width/height)和CSS顯示大小(style.width/height)
     */
    function syncCanvasDimensions() {
        if (!isRunning || !videoElement || !canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const newWidth = Math.round(videoElement.clientWidth * dpr);
        const newHeight = Math.round(videoElement.clientHeight * dpr);

        // 僅在尺寸實際改變時才更新，以避免不必要的重繪和資源消耗
        if (canvas.width !== newWidth || canvas.height !== newHeight) {
            canvas.width = newWidth;
            canvas.height = newHeight;
            console.log(`YouTube VSR : Canvas render buffer resized to ${newWidth}x${newHeight} (DPR: ${dpr})`);
        }

        // 同時更新 CSS 樣式以確保視覺覆蓋正確
        const computedStyle = getComputedStyle(videoElement);
        Object.assign(canvas.style, {
            width: computedStyle.width, height: computedStyle.height,
            top: computedStyle.top, left: computedStyle.left,
            position: 'absolute', zIndex: '10'
        });
    }

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
        console.log(`YouTube VSR : Recreated textures for new resolution: ${width}x${height}`);
    }

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
    async function loadShaderCode(path) {
        if (shaderCodeCache.has(path)) return shaderCodeCache.get(path);
        const fullPath = chrome.runtime.getURL(path);
        const response = await fetch(fullPath);
        if (!response.ok) throw new Error(`Shader not found at ${path} (${response.status})`);
        const code = await response.text();
        shaderCodeCache.set(path, code);
        return code;
    }

    //================================================================================
    // 訊息監聽器
    //================================================================================

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

            // *** NEW: 處理來自 background.js 的導航事件 ***
            case 'navigation':
                console.log('YouTube VSR: Navigation detected. Re-initializing...');
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

    chrome.storage.local.get('isEnabled', (result) => {
        if (result.isEnabled) {
            setTimeout(start, 1500);
        }
    });
})();