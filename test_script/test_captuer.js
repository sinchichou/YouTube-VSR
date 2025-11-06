// 優化效能 // 使用 IIFE (立即調用函式表達式) 來避免污染全域命名空間
(function () {
    // --- 變數定義 ---
    let videoElement = null;
    let gpuCanvas = null; // 改名為 gpuCanvas
    let gpuDevice = null; // GPU 設備
    let gpuContext = null; // GPU 上下文
    let animationFrameId = null;
    let resizeObserver = null;
    let isCaptureRunning = false;

    // 幀緩衝區，用於儲存前後幀
    const FRAME_BUFFER_SIZE = 3; // 儲存前一幀、當前幀、後一幀
    let frameBuffer = []; // 儲存 GPUTexture
    let currentFrameIndex = -1; // 目前在緩衝區中的索引

    console.log("YouTube VSR : 影格擷取與 GPU 推送腳本：開始執行...");

    // --- GPU 相關函式 ---

    // 1. 初始化 WebGPU
    async function setupGpu() {
        if (!navigator.gpu) {
            console.error("YouTube VSR Error: 錯誤：WebGPU 不支援此瀏覽器。");
            return false;
        }
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            console.error("YouTube VSR Error: 錯誤：找不到 GPU 適配器。");
            return false;
        }
        gpuDevice = await adapter.requestDevice();
        if (!gpuDevice) {
            console.error("YouTube VSR Error: 錯誤：無法取得 GPU 設備。");
            return false;
        }

        gpuCanvas = document.createElement('canvas');
        gpuContext = gpuCanvas.getContext('webgpu');
        if (!gpuContext) {
            console.error("YouTube VSR Error: 錯誤：無法取得 WebGPU 上下文。");
            return false;
        }

        console.log("YouTube VSR : WebGPU 初始化成功。");
        return true;
    }

    // 2. 建立幀緩衝區紋理
    function createFrameBufferTextures() {
        frameBuffer = [];
        for (let i = 0; i < FRAME_BUFFER_SIZE; i++) {
            const texture = gpuDevice.createTexture({
                size: [videoElement.videoWidth, videoElement.videoHeight],
                format: 'rgba8unorm', // YouTube 影片的常見格式
                usage: GPUTextureUsage.TEXTURE_BINDING |
                       GPUTextureUsage.COPY_DST |
                       GPUTextureUsage.RENDER_ATTACHMENT,
            });
            frameBuffer.push(texture);
        }
        console.log(`建立了 ${FRAME_BUFFER_SIZE} 個幀緩衝區紋理。`);
    }


    // --- 主要函式 ---

    // 3. 設定擷取環境
    async function setupCapture() {
        if (isCaptureRunning) {
            console.warn("警告：擷取程序已在執行中。");
            return false;
        }

        videoElement = document.querySelector('video');
        if (!videoElement) {
            console.error("YouTube VSR Error: 錯誤：在頁面上找不到 <video> 元素。");
            return false;
        }

        if (videoElement.readyState < 1) {
             console.log("YouTube VSR : 提示：影片元資料尚未載入，將在載入後自動嘗試。");
             videoElement.addEventListener('loadedmetadata', window.startFrameCapture, { once: true });
             return false;
        }

        // 初始化 GPU
        if (!(await setupGpu())) {
            return false;
        }

        const playerContainer = document.querySelector('.html5-video-player');
        if (!playerContainer) {
            console.error("YouTube VSR Error: 錯誤：找不到 YouTube 播放器容器。");
            return false;
        }
        playerContainer.appendChild(gpuCanvas);

        // 設定 Canvas 上下文
        const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        gpuContext.configure({
            device: gpuDevice,
            format: presentationFormat,
            alphaMode: 'premultiplied',
        });

        // 建立紋理
        createFrameBufferTextures();


        resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    // 當影片尺寸改變時，重新建立紋理
                    createFrameBufferTextures();
                    syncCanvasDimensions();
                }
            }
        });
        resizeObserver.observe(videoElement);
        syncCanvasDimensions();

        // 點擊事件監聽
        gpuCanvas.addEventListener('click', handleCanvasClick);

        videoElement.style.opacity = '0';
        console.log("YouTube VSR : 設定完成：GPU Canvas 已建立並覆蓋在影片上。");
        isCaptureRunning = true;
        return true;
    }

    function syncCanvasDimensions() {
        if (!videoElement || !gpuCanvas) return;
        if (videoElement.videoWidth > 0 && videoElement.videoHeight > 0) {
            const computedStyle = getComputedStyle(videoElement);
            gpuCanvas.style.width = computedStyle.width;
            gpuCanvas.style.height = computedStyle.height;
            gpuCanvas.style.top = computedStyle.top;
            gpuCanvas.style.left = computedStyle.left;
            gpuCanvas.style.position = 'absolute';
            gpuCanvas.style.zIndex = '10';
            console.log(`Canvas 顯示尺寸同步！顯示尺寸: ${computedStyle.width}x${computedStyle.height}`);
        }
    }

    // 4. 處理單一影格的迴圈
    function processFrame(now, metadata) {
        if (isCaptureRunning) {
            animationFrameId = videoElement.requestVideoFrameCallback(processFrame);
        } else {
            return;
        }

        if (videoElement.paused || videoElement.ended || videoElement.videoWidth === 0) {
            return;
        }

        // *** 核心擷取邏輯 ***
        // 更新當前幀索引 (環形緩衝區)
        currentFrameIndex = (currentFrameIndex + 1) % FRAME_BUFFER_SIZE;
        const destinationTexture = frameBuffer[currentFrameIndex];

        // 將當前的影片影格複製到 GPU 紋理
        gpuDevice.queue.copyExternalImageToTexture(
            { source: videoElement },
            { texture: destinationTexture },
            [videoElement.videoWidth, videoElement.videoHeight]
        );

        // *** Shader 處理 ***
        // 在這裡，你可以使用 frameBuffer 中的紋理
        // 例如，建立一個 bind group，將紋理傳遞給你的 shader
        const prevFrameIndex = (currentFrameIndex - 1 + FRAME_BUFFER_SIZE) % FRAME_BUFFER_SIZE;
        const nextFrameIndex = (currentFrameIndex + 1) % FRAME_BUFFER_SIZE; // 雖然我們是即時擷取，但可以想像成一個預測的幀或下一個要處理的幀

        const currentFrameTexture = frameBuffer[currentFrameIndex];
        const prevFrameTexture = frameBuffer[prevFrameIndex];
        // const nextFrameTexture = frameBuffer[nextFrameIndex]; // 'next' 幀實際上是 buffer 中最舊的幀

        // --- 渲染管線開始 (此處為示意) ---
        const commandEncoder = gpuDevice.createCommandEncoder();
        const textureView = gpuContext.getCurrentTexture().createView();
        const renderPassDescriptor = {
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
        };
        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

        // 在此處設定你的渲染管線 (pipeline) 和綁定組 (bind group)
        // passEncoder.setPipeline(yourPipeline);
        // passEncoder.setBindGroup(0, yourBindGroup); // 包含 prev, current 紋理
        // passEncoder.draw(6, 1, 0, 0); // 繪製一個全螢幕四邊形

        // 為了演示，我們只是將當前幀（未處理）繪製到畫布上
        // 這需要一個簡單的 "pass-through" shader，此處省略其實作
        // 如果沒有 shader，畫布將保持黑色
        
        passEncoder.end();
        gpuDevice.queue.submit([commandEncoder.finish()]);
        // --- 渲染管線結束 ---
    }

    // 5. 處理 Canvas 點擊
    function handleCanvasClick(event) {
        console.log(`Canvas 被點擊！`);
        // 這裡可以加入與影格相關的邏輯
        // 例如，凍結當前畫面，或將當前幀的資料送去做其他處理
        const frameInfo = {
            timestamp: videoElement.currentTime,
            bufferIndex: currentFrameIndex,
            texture: frameBuffer[currentFrameIndex]
        };
        console.log("YouTube VSR : 點擊時的影格資訊:", frameInfo);
        // 你可以觸發一個自訂事件，讓其他模組知道一個影格被選中了
        // window.dispatchEvent(new CustomEvent('frameSelected', { detail: frameInfo }));
    }


    // 6. 停止擷取並清理資源
    function stopCapture() {
        if (!isCaptureRunning) {
            console.warn("警告：擷取程序尚未執行或已被停止。");
            return;
        }
        console.log("YouTube VSR : 正在停止影格擷取...");
        if (animationFrameId && videoElement) {
            videoElement.cancelVideoFrameCallback(animationFrameId);
            animationFrameId = null;
        }
        if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver = null;
        }
        if (gpuCanvas) {
            gpuCanvas.removeEventListener('click', handleCanvasClick);
            gpuCanvas.remove();
            gpuCanvas = null;
        }
        if (gpuDevice) {
            gpuDevice.destroy(); // 釋放 GPU 資源
            gpuDevice = null;
        }
        if (videoElement) {
            videoElement.style.opacity = '1';
        }
        frameBuffer = [];
        isCaptureRunning = false;
        console.log("YouTube VSR : 擷取已停止，環境已清理。");
    }

    // --- 啟動與停止 ---

    window.startFrameCapture = async function() {
        if (await setupCapture()) {
            animationFrameId = videoElement.requestVideoFrameCallback(processFrame);
            console.log("YouTube VSR : 成功啟動！GPU 擷取正在執行。");
            console.log("YouTube VSR : 畫布將是黑色的，因為尚未實作渲染 shader。");
            console.log("YouTube VSR : 點擊畫布可在主控台查看當前影格資訊。");
            console.log("YouTube VSR : 若要停止，請在主控台輸入：stopFrameCapture()");
        }
    };
    window.stopFrameCapture = stopCapture;

    console.log("YouTube VSR : 腳本已載入。請在主控台輸入 startFrameCapture() 來啟動擷取。");

})();
