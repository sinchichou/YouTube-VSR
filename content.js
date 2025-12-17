// YouTube VSR - Refactored with WGFX Engine
(async function () {
    // Prevent script from being injected multiple times
    if (window.vsrInjected) {
        console.log("YouTube VSR : VSR script already injected, aborting.");
        return;
    }
    window.vsrInjected = true;

    // --- Module-level variables ---
    let WGFXClass; // Renamed to WGFXClass to avoid conflict with instance variable 'wgfx'
    try {
        const runtimeURL = chrome.runtime.getURL('wgfx.browser.esm.js');
        const runtimeModule = await import(runtimeURL);
        if (!runtimeModule.WGFX) {
            throw new Error("WGFX class not found in the module.");
        }
        WGFXClass = runtimeModule.WGFX;
        console.log("YouTube VSR : WGFX module loaded successfully.");
    } catch (e) {
        console.error("YouTube VSR Error: Could not load wgfx.browser.esm.js module.", e);
        return;
    }

    // --- State Variables ---
    let isRunning = false;
    let videoElement = null;
    let canvas = null;
    let device = null;
    let context = null;
    let animationFrameId = null;
    let resizeObserver = null;

    // --- WGFX Related Variables ---
    /** @type {WGFX | null} */
    let wgfx = null;
    let currentEffectCode = null;
    let effectParameters = {};
    let activePipeline = [];

    console.log("YouTube VSR : YouTube VSR WGFX Engine loaded.");

    //================================================================================
    // Core Logic (Setup, Render, Cleanup)
    //================================================================================

    function robustStart() {
        if (isRunning) return;
        const playerSelector = '.html5-video-player';
        const videoSelector = 'video';
        let retries = 20; // Try for 10 seconds (20 * 500ms)

        console.log("YouTube VSR : Looking for video element...");

        const intervalId = setInterval(() => {
            const playerContainer = document.querySelector(playerSelector);
            const video = document.querySelector(videoSelector);

            if (playerContainer && video && video.readyState >= 1) {
                clearInterval(intervalId);
                console.log("YouTube VSR : Player and video element found. Starting initialization...");
                start(playerContainer, video); // Pass elements to start
            } else {
                retries--;
                if (retries <= 0) {
                    clearInterval(intervalId);
                    console.error(`YouTube VSR Error: Could not find '${playerSelector}' or '${videoSelector}' after 10 seconds.`);
                }
            }
        }, 500);
    }

    async function start(playerContainer, video) {
        if (isRunning) return;
        console.log("YouTube VSR : Start command received.");

        videoElement = video;
        if (!videoElement) {
            console.error("YouTube VSR Error: <video> element not found.");
            return;
        }

        await initialize(playerContainer);
    }

    async function initialize(playerContainer) {
        if (isRunning) return;
        if (!(await setupWebGPU())) return;

        // Ensure canvas is set up for WebGPU output
        context.configure({
            device: device,
            format: navigator.gpu.getPreferredCanvasFormat(),
            alphaMode: 'opaque',
        });

        // Now that we know playerContainer exists, append the canvas
        try {
            playerContainer.appendChild(canvas);
        } catch (e) {
            console.error("YouTube VSR Error: Failed to append canvas to player container.", e);
            stop();
            return;
        }

        const settings = await chrome.storage.local.get(['pipeline']);
        // buildRenderPipeline will call WGFXClass.create and handle initial compilation
        await buildRenderPipeline(settings.pipeline || []);

        resizeObserver = new ResizeObserver(handleResize);
        resizeObserver.observe(videoElement);

        setupVideoEndedListener();

        // Perform initial sizing and setup
        handleResize();

        // Only hide video element if a pipeline was successfully built
        if (wgfx) {
            videoElement.style.opacity = '0';
        }

        isRunning = true;
        console.log("YouTube VSR : Initialization complete, starting frame capture.");
        renderLoop();
    }

    function stop() {
        if (!isRunning) return;
        console.log("YouTube VSR : Stop command received.");

        // NOTE: We rely on the internal WGFX dispose method for resource cleanup
        if (wgfx) {
            wgfx.dispose();
        }

        // Cleanup video frame callback
        if (animationFrameId && videoElement) {
            // Note: window.cancelAnimationFrame is used if videoElement.requestVideoFrameCallback is polyfilled,
            // but the callback ID should be managed internally if we use the native video frame callback.
            // Since there's no native cancel function for rVFC, we just stop calling requestVideoFrameCallback.
            // To be robust, we rely on the internal ID management if it existed, but here we just manage our loop flow.
            animationFrameId = null;
        }

        if (resizeObserver) resizeObserver.disconnect();

        if (videoElement) {
            videoElement.removeEventListener('ended', handleVideoEnded);
            videoElement.style.opacity = '1';
        }
        if (canvas && canvas.parentElement) canvas.parentElement.removeChild(canvas);

        if (device) {
            try {
                // IMPORTANT: Only destroy the device if we are sure no other script needs it.
                // context.unconfigure();
                device.destroy();
                console.log("YouTube VSR : WebGPU device destroyed.");
            } catch (e) {
                console.error("YouTube VSR Error destroying device:", e);
            }
        }


        // Reset all state variables
        isRunning = false;
        videoElement = null;
        canvas = null;
        device = null;
        context = null;
        animationFrameId = null;
        resizeObserver = null;
        wgfx = null;
        currentEffectCode = null;
        effectParameters = {};

        console.log("YouTube VSR : Capture stopped and resources cleaned up.");
    }

    /**
     * @param {number} now - The timestamp from requestVideoFrameCallback.
     */
    async function renderLoop(now) {
        // If there's no active shader, hide canvas and show original video
        if (!wgfx) {
            if (canvas) canvas.style.display = 'none';
            if (videoElement) videoElement.style.opacity = '1';
            if (isRunning && videoElement) {
                animationFrameId = videoElement.requestVideoFrameCallback(renderLoop);
            }
            return;
        }

        // Only proceed if running and video is ready
        if (!isRunning || !videoElement || videoElement.readyState < 2 || videoElement.videoWidth === 0) {
            if (isRunning && videoElement) {
                animationFrameId = videoElement.requestVideoFrameCallback(renderLoop);
            }
            return;
        }

        // Ensure canvas is visible
        if (canvas && canvas.style.display === 'none') {
            canvas.style.display = 'block';
            if (videoElement) videoElement.style.opacity = '0';
        }

        let frameBitmap;
        try {
            frameBitmap = await createImageBitmap(videoElement);
        } catch (e) {
            console.warn("YouTube VSR Warn: Failed to create ImageBitmap. Frame skipped.", e);
            animationFrameId = videoElement.requestVideoFrameCallback(renderLoop);
            return;
        }

        try {
            // Process frame through WGFX
            const outputTextureView = await wgfx.processFrame({
                frameBitmap: frameBitmap,
                uniforms: effectParameters
            });

            // Get canvas texture
            const canvasTexture = context.getCurrentTexture();
            const commandEncoder = device.createCommandEncoder();

            // CRITICAL FIX: Cannot directly copy between different formats
            // We need a render pass to convert rgba16float -> canvas format

            // Create a simple blit render pipeline if not exists
            if (!window._blitPipeline) {
                const blitShaderModule = device.createShaderModule({
                    code: `
                    @vertex
                    fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
                        // Full-screen triangle
                        var pos = array<vec2f, 3>(
                            vec2f(-1.0, -1.0),
                            vec2f( 3.0, -1.0),
                            vec2f(-1.0,  3.0)
                        );
                        return vec4f(pos[vertexIndex], 0.0, 1.0);
                    }

                    @group(0) @binding(0) var inputTexture: texture_2d<f32>;
                    @group(0) @binding(1) var inputSampler: sampler;

                    @fragment
                    fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
                        let uv = fragCoord.xy / vec2f(${canvas.width}.0, ${canvas.height}.0);
                        return textureSample(inputTexture, inputSampler, uv);
                    }
                `
                });

                const blitBindGroupLayout = device.createBindGroupLayout({
                    entries: [
                        {
                            binding: 0,
                            visibility: GPUShaderStage.FRAGMENT,
                            texture: {sampleType: 'float'}
                        },
                        {
                            binding: 1,
                            visibility: GPUShaderStage.FRAGMENT,
                            sampler: {type: 'filtering'}
                        }
                    ]
                });

                const blitPipelineLayout = device.createPipelineLayout({
                    bindGroupLayouts: [blitBindGroupLayout]
                });

                window._blitPipeline = device.createRenderPipeline({
                    layout: blitPipelineLayout,
                    vertex: {
                        module: blitShaderModule,
                        entryPoint: 'vs_main'
                    },
                    fragment: {
                        module: blitShaderModule,
                        entryPoint: 'fs_main',
                        targets: [{
                            format: navigator.gpu.getPreferredCanvasFormat()
                        }]
                    },
                    primitive: {
                        topology: 'triangle-list'
                    }
                });

                window._blitSampler = device.createSampler({
                    magFilter: 'linear',
                    minFilter: 'linear'
                });

                window._blitBindGroupLayout = blitBindGroupLayout;
            }

            // Create bind group for this frame
            const blitBindGroup = device.createBindGroup({
                layout: window._blitBindGroupLayout,
                entries: [
                    {
                        binding: 0,
                        resource: outputTextureView
                    },
                    {
                        binding: 1,
                        resource: window._blitSampler
                    }
                ]
            });

            // Render pass to blit output to canvas
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: canvasTexture.createView(),
                    loadOp: 'clear',
                    clearValue: {r: 0, g: 0, b: 0, a: 1},
                    storeOp: 'store'
                }]
            });

            renderPass.setPipeline(window._blitPipeline);
            renderPass.setBindGroup(0, blitBindGroup);
            renderPass.draw(3); // Full-screen triangle
            renderPass.end();

            // Submit commands
            device.queue.submit([commandEncoder.finish()]);

            // Close ImageBitmap
            frameBitmap.close();

        } catch (e) {
            console.error("YouTube VSR Error during frame processing:", e);
            if (frameBitmap && frameBitmap.close) frameBitmap.close();
            stop();
            return;
        }

        // Request next frame
        animationFrameId = videoElement.requestVideoFrameCallback(renderLoop);
    }
    //================================================================================
    // WebGPU Setup & Pipeline Management
    //================================================================================


    async function setupWebGPU() {
        try {
            if (!navigator.gpu) throw new Error("WebGPU is not supported.");
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error("Could not find a GPU adapter.");

            // Check adapter capabilities
            console.log("YouTube VSR : GPU Adapter Limits:");
            console.log("  - maxStorageTexturesPerShaderStage:", adapter.limits.maxStorageTexturesPerShaderStage);
            console.log("  - maxComputeWorkgroupSizeX:", adapter.limits.maxComputeWorkgroupSizeX);
            console.log("  - maxComputeWorkgroupSizeY:", adapter.limits.maxComputeWorkgroupSizeY);

            // CRITICAL FIX: Anime4K shaders require up to 8 storage textures per stage
            // Default WebGPU limit is only 4, which causes "exceeds the maximum per-stage limit" error
            const requiredStorageTextures = 8;
            const maxSupported = adapter.limits.maxStorageTexturesPerShaderStage;

            if (maxSupported < requiredStorageTextures) {
                console.warn(
                    `YouTube VSR Warning: GPU only supports ${maxSupported} storage textures per stage. ` +
                    `Anime4K requires ${requiredStorageTextures}. Some effects may fail.`
                );
            }

            device = await adapter.requestDevice({
                requiredFeatures: [],
                requiredLimits: {
                    // Request higher storage texture limit (up to hardware max)
                    maxStorageTexturesPerShaderStage: Math.min(
                        requiredStorageTextures,
                        maxSupported
                    )
                },
            });

            console.log("YouTube VSR : Device created successfully");
            console.log("  - Effective maxStorageTexturesPerShaderStage:", device.limits.maxStorageTexturesPerShaderStage);

            device.lost.then(info => {
                console.error(`WebGPU device lost: ${info.message}`);
                if (info.reason !== 'destroyed') stop();
            });

            canvas = document.createElement('canvas');
            canvas.style.position = 'absolute';
            canvas.style.zIndex = '10';
            canvas.style.pointerEvents = 'none';
            context = canvas.getContext('webgpu');

            return true;
        } catch (e) {
            console.error("YouTube VSR Error: WebGPU setup failed:", e);
            stop();
            return false;
        }
    }

    async function buildRenderPipeline(newPipeline) {
        if (!device) return;

        // Dispose of old WGFX instance if it exists
        if (wgfx) {
            wgfx.dispose();
            wgfx = null;
        }

        activePipeline = newPipeline || [];
        effectParameters = {};
        currentEffectCode = null;

        if (activePipeline.length === 0) {
            console.log("YouTube VSR : Pipeline is empty. Hiding canvas and showing original video.");
            if (videoElement) videoElement.style.opacity = '1';
            if (canvas) canvas.style.display = 'none';
            // Stop the render loop if it's running without a pipeline
            if (animationFrameId && videoElement) {
                animationFrameId = null; // Next renderLoop will stop itself
            }
            return;
        }

        // Show canvas and hide video
        if (canvas) canvas.style.display = 'block';
        if (videoElement) videoElement.style.opacity = '0';

        if (activePipeline.length > 1) {
            console.warn(`YouTube VSR : Multiple effects in pipeline detected. Only the first one ('${activePipeline[0].path}') will be used.`);
        }

        const effectStep = activePipeline[0];
        try {
            currentEffectCode = await loadShaderCode(effectStep.path);

            const params = effectStep.params || {};
            for (const key of Object.keys(params)) {
                effectParameters[key] = params[key];
            }

            console.log("YouTube VSR : Building render pipeline for:", effectStep.path);
            await recompileEffect(true); // Force recompile/recreate WGFX

            if (!animationFrameId && isRunning) {
                renderLoop();
            }

        } catch (e) {
            console.error(`YouTube VSR: Failed to build pipeline for ${effectStep.path}:`, e);
            currentEffectCode = null;
            if (videoElement) videoElement.style.opacity = '1';
            if (canvas) canvas.style.display = 'none';
        }
    }

    async function recompileEffect(isInitialBuild = false) {
        if (!currentEffectCode || !videoElement || !device) return;

        const width = videoElement.videoWidth;
        const height = videoElement.videoHeight;

        if (width === 0 || height === 0) {
            console.warn("YouTube VSR: Video dimensions are 0. Deferring compilation.");
            return;
        }

        if (!isInitialBuild && wgfx) return;

        try {
            const defines = {
                INPUT_WIDTH: width,
                INPUT_HEIGHT: height,
            };

            // CRITICAL FIX: Use rgba16float for OUTPUT texture to support storage write operations
            // rgba8unorm is NOT supported as a storage texture format in WebGPU
            const externalResources = {
                defines,
                textures: {
                    INPUT: {
                        size: [width, height],
                        format: 'rgba8unorm',  // INPUT 可以保持 rgba8unorm (僅用於讀取)
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
                    },
                    OUTPUT: {
                        size: [width, height],
                        format: 'rgba16float',  // *** 修正: 使用 rgba16float 而非 rgba8unorm ***
                        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING
                    }
                }
            };

            console.log("YouTube VSR : Creating WGFX with externalResources:", {
                defines,
                textureFormats: {
                    INPUT: externalResources.textures.INPUT.format,
                    OUTPUT: externalResources.textures.OUTPUT.format
                }
            });

            wgfx = await WGFXClass.create({
                device,
                effectCode: currentEffectCode,
                externalResources
            });

            const metadata = wgfx.initialize();

            if (metadata && metadata.uniforms) {
                for (const u of metadata.uniforms) {
                    if (effectParameters[u.name] === undefined && u.default !== undefined) {
                        effectParameters[u.name] = u.default;
                    }
                }
            }

            console.log("YouTube VSR : Effect compiled and initialized successfully.");

        } catch (e) {
            console.error("YouTube VSR : Effect compilation failed.", e);
            if (wgfx) {
                wgfx.dispose();
                wgfx = null;
            }
        }
    }

    //================================================================================
    // Utility & Event Handlers
    //================================================================================

    function syncCanvasDimensions() {
        if (!videoElement || !canvas) return;
        const computedStyle = getComputedStyle(videoElement);
        const rect = videoElement.getBoundingClientRect();

        // Sync CSS dimensions and position
        Object.assign(canvas.style, {
            width: computedStyle.width, height: computedStyle.height,
            top: `${rect.top}px`, left: `${rect.left}px`,
            position: 'fixed', // Use fixed to ensure it overlays correctly on YouTube's player
            zIndex: '10',
            pointerEvents: 'none'
        });

        // Sync native resolution
        const displayWidth = parseFloat(computedStyle.width);
        const displayHeight = parseFloat(computedStyle.height);

        if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
            canvas.width = displayWidth;
            canvas.height = displayHeight;

            // Reconfigure context if canvas size changes
            if (context) {
                context.configure({
                    device: device,
                    format: navigator.gpu.getPreferredCanvasFormat(),
                    alphaMode: 'opaque',
                    size: [displayWidth, displayHeight],
                });
            }
        }
    }

    let resizeTimeout;

    function handleResize() {
        if (!isRunning) return;
        syncCanvasDimensions();

        // Recompile WGFX when video element dimensions change (which changes INPUT texture size)
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            if (wgfx) {
                // If dimensions change, we need to rebuild WGFX instance completely
                wgfx.dispose();
                wgfx = null;
            }
            recompileEffect(true);
        }, 250);
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

    function handleVideoEnded() {
        console.log("YouTube VSR : Video playback ended.");
        chrome.runtime.sendMessage({command: 'videoEnded'}).catch(e => console.warn("Could not send videoEnded message:", e));
    }

    function setupVideoEndedListener() {
        if (videoElement) {
            videoElement.addEventListener('ended', handleVideoEnded, {once: true});
        }
    }


    //================================================================================
    // Message Listener
    //================================================================================

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        let isAsync = false;
        switch (request.command) {
            case 'setEnable':
                request.isEnabled ? robustStart() : stop();
                break;
            case 'setPipeline':
                isAsync = true;
                // Rebuild pipeline will dispose of old wgfx and create a new one
                buildRenderPipeline(request.pipeline).then(() => sendResponse({ status: 'ok' }));
                break;
            case 'updateParameter':
                if (effectParameters.hasOwnProperty(request.paramName)) {
                    effectParameters[request.paramName] = request.value;
                    // Note: updateUniform is handled implicitly on the next frame in processFrame
                }
                break;
            case 'navigation':
                console.log('YouTube VSR : Navigation detected, re-initializing...');
                if (isRunning) {
                    stop();
                }
                robustStart();
                break;
        }
        return isAsync;
    });

    chrome.storage.local.get('isEnabled', (result) => {
        if (result.isEnabled) {
            robustStart();
        }
    });

})();