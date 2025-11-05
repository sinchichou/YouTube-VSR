// YouTube VSR - WebGPU Multi-pass Engine
(function () {
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

    console.log("YouTube VSR : YouTube VSR WebGPU Engine Loaded.");

    //================================================================================
    // CORE LOGIC (SETUP, RENDER, CLEANUP)
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

        const settings = await chrome.storage.local.get(['pipeline']);
        await buildRenderPipeline(settings.pipeline || []);

        resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(videoElement);
        handleResize(); // 初始同步尺寸

        videoElement.style.opacity = '0';
        isRunning = true;
        console.log("YouTube VSR : Initialization complete. Capture started.");
        renderLoop();
    }

    function stop() {
        if (!isRunning) return;
        console.log("YouTube VSR : Stop command received.");

        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        if (resizeObserver) resizeObserver.disconnect();
        if (canvas) canvas.remove();
        if (device) device.destroy();
        if (videoElement) videoElement.style.opacity = '1';

        // Reset all state
        isRunning = false; videoElement = null; canvas = null; device = null;
        context = null; animationFrameId = null; resizeObserver = null;
        gpuRenderables = []; pipeline = [];
        console.log("YouTube VSR : Capture stopped and resources cleaned up.");
    }

    function renderLoop() {
        if (!isRunning) return;

        if (!videoElement.paused && !videoElement.ended && videoElement.videoWidth > 0) {
            // 將影片當前幀複製到 sourceTexture
            device.queue.copyExternalImageToTexture(
                { source: videoElement },
                { texture: sourceTexture },
                [videoElement.videoWidth, videoElement.videoHeight]
            );

            const commandEncoder = device.createCommandEncoder({ label: 'VSR Command Encoder' });
            let currentSource = sourceTexture;

            // --- 執行渲染管線 ---
            for (let i = 0; i < gpuRenderables.length; i++) {
                const renderable = gpuRenderables[i];
                const passEncoder = commandEncoder.beginRenderPass({
                    colorAttachments: [{
                        view: pingPongTextures[i % 2].createView(),
                        loadOp: 'clear', storeOp: 'store',
                        clearValue: { r: 0, g: 0, b: 0, a: 1 }
                    }]
                });
                passEncoder.setPipeline(renderable.pipeline);
                // 更新 bind group，將上一個 pass 的輸出作為輸入
                const bindGroup = createBindGroup(renderable, currentSource);
                passEncoder.setBindGroup(0, bindGroup);
                passEncoder.draw(6, 1, 0, 0);
                passEncoder.end();
                currentSource = pingPongTextures[i % 2];
            }

            // --- 將最終結果繪製到螢幕 ---
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
            finalPassEncoder.draw(6, 1, 0, 0);
            finalPassEncoder.end();

            device.queue.submit([commandEncoder.finish()]);
        }
        animationFrameId = requestAnimationFrame(renderLoop);
    }

    //================================================================================
    // WEBGPU SETUP & PIPELINE BUILDING
    //================================================================================

    async function setupWebGPU() {
        try {
            if (!navigator.gpu) throw new Error("WebGPU not supported.");
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error("No GPU adapter found.");
            device = await adapter.requestDevice();

            canvas = document.createElement('canvas');
            const playerContainer = document.querySelector('.html5-video-player');
            playerContainer.appendChild(canvas);
            context = canvas.getContext('webgpu');
            const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
            context.configure({ device, format: presentationFormat, alphaMode: 'premultiplied' });

            fullscreenQuadVS = device.createShaderModule({
                label: 'Fullscreen Quad VS',
                code: `@vertex fn main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
                    let pos = array<vec2<f32>, 6>(vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(-1,1),vec2(1,-1),vec2(1,1));
                    return vec4<f32>(pos[vi], 0.0, 1.0);
                }`
            });
            sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
            return true;
        } catch (e) {
            console.error("YouTube VSR Error: VSR WebGPU setup failed:", e);
            stop();
            return false;
        }
    }

    async function buildRenderPipeline(newPipeline) {
        if (!device) return;
        pipeline = newPipeline || [];
        gpuRenderables = [];

        for (const step of pipeline) {
            try {
                const code = await loadShaderCode(step.path);
                const fsModule = device.createShaderModule({ label: step.path, code });
                const compilationInfo = await fsModule.getCompilationInfo();
                if (compilationInfo.messages.some(m => m.type === 'error')) {
                    console.error(`Error compiling ${step.path}:`, compilationInfo.messages);
                    continue; // 跳過這個著色器
                }

                const renderPipeline = device.createRenderPipeline({
                    label: `Pipeline - ${step.path}`,
                    layout: 'auto',
                    vertex: { module: fullscreenQuadVS, entryPoint: 'main' },
                    fragment: { module: fsModule, entryPoint: 'main', targets: [{ format: 'rgba8unorm' }] }
                });

                const { uniforms } = parseUniforms(code); // 與 popup.js 中相同的解析邏輯
                let uniformBuffer = null;
                if (uniforms.size > 0) {
                    uniformBuffer = device.createBuffer({
                        label: `Uniforms - ${step.path}`,
                        size: uniforms.size,
                        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
                    });
                    // 寫入初始/儲存的參數值
                    updateUniformBuffer(uniformBuffer, uniforms, step.params);
                }

                gpuRenderables.push({ 
                    instanceId: step.instanceId, 
                    pipeline: renderPipeline, 
                    uniforms, 
                    uniformBuffer 
                });
            } catch (e) {
                console.error(`Failed to build pipeline for ${step.path}:`, e);
            }
        }
        console.log(`VSR: Built ${gpuRenderables.length} renderable steps.`);
        recreateFrameTextures();
    }

    function createBindGroup(renderable, texture) {
        const entries = [{ binding: 0, resource: sampler }, { binding: 1, resource: texture.createView() }];
        if (renderable.uniformBuffer) {
            entries.push({ binding: renderable.uniforms.binding, resource: { buffer: renderable.uniformBuffer } });
        }
        return device.createBindGroup({
            layout: renderable.pipeline.getBindGroupLayout(0),
            entries: entries
        });
    }
    
    // 為了將最終結果繪製到 canvas，需要一個簡單的 passthrough pipeline
    let finalPass = null;
    function getFinalPassRenderable(texture) {
        if (!finalPass) {
            const fsModule = device.createShaderModule({
                label: 'Final Pass FS',
                code: `@group(0) @binding(0) var s: sampler; @group(0) @binding(1) var t: texture_2d<f32>;
                       @fragment fn main(@builtin(position) p: vec4<f32>) -> @location(0) vec4<f32> {
                           return textureSample(t, s, p.xy / vec2<f32>(1920, 1080)); // TODO: Use actual resolution
                       }`
            });
            const pipeline = device.createRenderPipeline({
                layout: 'auto',
                vertex: { module: fullscreenQuadVS, entryPoint: 'main' },
                fragment: { module: fsModule, entryPoint: 'main', targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }] }
            });
            finalPass = { pipeline };
        }
        finalPass.bindGroup = device.createBindGroup({ layout: finalPass.pipeline.getBindGroupLayout(0), entries: [{binding: 0, resource: sampler}, {binding: 1, resource: texture.createView()}] });
        return finalPass;
    }

    //================================================================================
    // UTILITY & EVENT HANDLERS
    //================================================================================

    function handleResize() {
        if (!isRunning) return;
        const dpr = window.devicePixelRatio || 1;
        const newWidth = Math.round(videoElement.clientWidth * dpr);
        const newHeight = Math.round(videoElement.clientHeight * dpr);
        canvas.width = newWidth;
        canvas.height = newHeight;
        
        const computedStyle = getComputedStyle(videoElement);
        Object.assign(canvas.style, { width: computedStyle.width, height: computedStyle.height, top: computedStyle.top, left: computedStyle.left, position: 'absolute', zIndex: '10' });
        
        recreateFrameTextures();
    }

    function recreateFrameTextures() {
        if (!device || !videoElement || videoElement.videoWidth === 0) return;
        const width = videoElement.videoWidth;
        const height = videoElement.videoHeight;

        sourceTexture?.destroy();
        sourceTexture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });

        pingPongTextures.forEach(t => t.destroy());
        pingPongTextures = [
            device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT }),
            device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT })
        ];
    }

    function updateUniformBuffer(buffer, uniforms, params) {
        const data = new Float32Array(uniforms.size / 4);
        Object.values(uniforms.properties).forEach(prop => {
            const value = params[prop.name] !== undefined ? params[prop.name] : prop.value;
            data[prop.offset / 4] = value;
        });
        device.queue.writeBuffer(buffer, 0, data);
    }

    const shaderCodeCache = new Map();
    async function loadShaderCode(path) {
        if (shaderCodeCache.has(path)) return shaderCodeCache.get(path);
        const fullPath = chrome.runtime.getURL(`effects_wgsl/${path}`);
        const code = await fetch(fullPath).then(res => res.text());
        shaderCodeCache.set(path, code);
        return code;
    }

    function parseUniforms(shaderCode) { /* ... 和 popup.js 相同的解析邏輯 ... */ return { uniforms: { properties: {}, size: 0, binding: -1 } }; }

    //================================================================================
    // MESSAGE LISTENER
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
                    const params = { [request.paramName]: request.value };
                    updateUniformBuffer(renderable.uniformBuffer, renderable.uniforms, params);
                }
                break;
        }
        return isAsync;
    });

    // 自動根據儲存的狀態決定是否啟動
    chrome.storage.local.get('isEnabled', (result) => {
        if (result.isEnabled) {
            // 延遲一點啟動，給頁面足夠的載入時間
            setTimeout(start, 1000);
        }
    });
})();
