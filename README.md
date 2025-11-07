# YouTube VSR - Real-Time Video Shader Extension

This is a browser extension designed to apply real-time shaders and effects to online videos, primarily on platforms like YouTube. It allows users to select and customize various video processing filters, from simple color adjustments to complex upscaling and denoising algorithms.

## Features

- **Real-Time Processing**: Applies video effects on-the-fly without needing to download the video.
- **Extensive Shader Library**: Includes a wide variety of shaders from projects like Anime4K, FSR, CAS, and more.
- **Customizable Effects**: Each shader's parameters can be adjusted through a user-friendly interface.
- **wgsl Support**: Dynamically parses and applies shaders written in wgsl.
- **Modular Design**: Easily extendable with new shaders.
- **Video Playback Monitoring**: Detects when a video has ended playback.

---

## Key Modules Explanation

### `parser.js` - Shader Parser

This is the core module responsible for interpreting shader files (`.wgsl`). It reads the special comment-based header at the top of a shader file to understand its properties, parameters, and rendering passes. This allows the extension to dynamically build a UI for controlling the shader and to correctly execute the rendering pipeline.

#### How It Works

The parser scans a shader file for special comment lines starting with `//!`. These lines are not standard code but act as metadata directives.

#### Parser Directives

-   `//!EFFECT "Effect Name"`: **(Global)** Specifies the display name of the shader in the UI.
-   `//!VERSION "1.0"`: **(Global)** Defines the version of the shader.

-   `//!PARAMETER`: **(Block)** Declares the beginning of a shader parameter block. This is followed by the actual variable declaration in the code.
    -   `//!LABEL "Parameter Name"`: The display name for this parameter in the UI.
    -   `//!DEFAULT value`: The default numerical value for the parameter.
    -   `//!MIN value`: The minimum allowed value (for sliders).
    -   `//!MAX value`: The maximum allowed value (for sliders).
    -   `//!STEP value`: The increment/decrement step for the UI control.
    -   **Example**:
        ```wgsl
        //!PARAMETER
        //!LABEL "Sharpness"
        //!DEFAULT 0.8
        //!MIN 0.0
        //!MAX 1.0
        //!STEP 0.01
        float sharpness;
        ```

-   `//!TEXTURE`: **(Block)** Declares a texture resource.
    -   `//!WIDTH "1920"`: Specifies the width. Can also use variables like `VIDEO_WIDTH`.
    -   `//!HEIGHT "1080"`: Specifies the height. Can also use variables like `VIDEO_HEIGHT`.
    -   **Example**:
        ```wgsl
        //!TEXTURE
        //!WIDTH "VIDEO_WIDTH"
        //!HEIGHT "VIDEO_HEIGHT"
        Texture2D myTexture;
        ```

-   `//!SAMPLER`: **(Block)** Declares a sampler resource.
    -   `//!FILTER "LINEAR"`: Defines the filter mode (e.g., `LINEAR`, `POINT`).
    -   **Example**:
        ```wgsl
        //!SAMPLER
        //!FILTER "LINEAR"
        SamplerState mySampler;
        ```

-   `//!PASS <ID>`: **(Block)** Declares a rendering pass with a specific ID. Passes are executed in order of their ID.
    -   `//!IN "ResourceName"`: Specifies an input resource for this pass (e.g., a texture).
    -   `//!OUT "ResourceName"`: Specifies the output target for this pass.
    -   `//!BLOCK_SIZE "16 16"`: Defines the compute shader block size.
    -   **Example**:
        ```wgsl
        //!PASS 1
        //!IN "InputTexture"
        //!OUT "ProcessedTexture"
        //!BLOCK_SIZE "16 16"
        ```

### `effects_wgsl/` Directory

This directory is intended for shaders written in WGSL (WebGPU Shading Language). It signifies an experimental or future-proofed part of the project, allowing it to leverage the newer WebGPU API for potentially better performance.

---

# YouTube VSR - 即時影片著色器擴充功能

這是一個瀏覽器擴充功能，旨在為線上影片（主要是在 YouTube 等平台上）套用即時著色器和效果。它允許使用者選擇和自訂各種影片處理濾鏡，從簡單的色彩調整到複雜的升頻和降噪演算法。

## 功能

-   **即時處理**：無需下載影片，即時套用各種影片效果。
-   **豐富的著色器庫**：包含了來自 Anime4K、FSR、CAS 等專案的多種著色器。
-   **可自訂的效果**：每個著色器的參數都可以透過使用者友好的介面進行調整。
-   **支援 wgsl**：能夠動態解析和套用以 wgsl 編寫的著色器。
-   **模組化設計**：可以輕鬆地透過添加新的著色器來擴充功能。
- **影片播放監測**：偵測影片播放結束。

---

## 關鍵模組說明

### `parser.js` - 著色器解析器

這是本專案的核心模組，負責解讀著色器檔案（`.wgsl`）。它會讀取位於著色器檔案頂部的特殊註解標頭，以理解其屬性、參數和渲染通道（Rendering Pass）。這使得擴充功能能夠動態建立用於控制著色器的 UI，並正確執行渲染管線。

#### 運作方式

解析器會掃描著色器檔案，尋找以 `//!` 開頭的特殊註解行。這些行不是標準程式碼，而是作為元數據指令。

#### 解析器指令

-   `//!EFFECT "效果名稱"`：**(全域)** 指定著色器在 UI 中顯示的名稱。
-   `//!VERSION "1.0"`：**(全域)** 定義著色器的版本。

-   `//!PARAMETER`：**(區塊)** 宣告一個著色器參數區塊的開始。其後需要跟著實際的變數宣告程式碼。
    -   `//!LABEL "參數名稱"`：此參數在 UI 中顯示的名稱。
    -   `//!DEFAULT 數值`：參數的預設數值。
    -   `//!MIN 數值`：允許的最小值（用於滑桿）。
    -   `//!MAX 數值`：允許的最大值（用於滑桿）。
    -   `//!STEP 數值`：UI 控制項的增減步長。
    -   **範例**：
        ```wgsl
        //!PARAMETER
        //!LABEL "銳利度"
        //!DEFAULT 0.8
        //!MIN 0.0
        //!MAX 1.0
        //!STEP 0.01
        float sharpness;
        ```

-   `//!TEXTURE`：**(區塊)** 宣告一個紋理資源。
    -   `//!WIDTH "1920"`：指定寬度。也可以使用 `VIDEO_WIDTH` 等變數。
    -   `//!HEIGHT "1080"`：指定高度。也可以使用 `VIDEO_HEIGHT` 等變數。
    -   **範例**：
        ```wgsl
        //!TEXTURE
        //!WIDTH "VIDEO_WIDTH"
        //!HEIGHT "VIDEO_HEIGHT"
        Texture2D myTexture;
        ```

-   `//!SAMPLER`：**(區塊)** 宣告一個採樣器資源。
    -   `//!FILTER "LINEAR"`：定義濾波模式（例如 `LINEAR`、`POINT`）。
    -   **範例**：
        ```wgsl
        //!SAMPLER
        //!FILTER "LINEAR"
        SamplerState mySampler;
        ```

-   `//!PASS <ID>`：**(區塊)** 宣告一個帶有特定 ID 的渲染通道。通道會根據其 ID 順序執行。
    -   `//!IN "資源名稱"`：指定此通道的輸入資源（例如一個紋理）。
    -   `//!OUT "資源名稱"`：指定此通道的輸出目標。
    -   `//!BLOCK_SIZE "16 16"`：定義計算著色器（Compute Shader）的區塊大小。
    -   **範例**：
        ```wgsl
        //!PASS 1
        //!IN "InputTexture"
        //!OUT "ProcessedTexture"
        //!BLOCK_SIZE "16 16"
        ```

### `effects_wgsl/` 目錄

此目錄用於存放以 WGSL（WebGPU Shading Language）編寫的著色器。它代表了專案中實驗性或為未來做準備的部分，使其能夠利用更新的 WebGPU API 以獲得潛在的更佳效能。
