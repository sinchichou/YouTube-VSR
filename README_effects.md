### 根目錄檔案詳解

這些檔案是構成各種效果的基礎或獨立的處理演算法。

*   **ACNet.hlsl**
    *   **說明**：ACNet 代表 Attentional Convolutional Network (注意力卷積網路)。這是一種基於深度學習的著色器，常用於影像修復任務，如去除壓縮失真 (artifact removal)。它透過「注意力機制」來識別影像中的重要區域 (例如，複雜的紋理或邊緣)，並在這些區域上投入更多的運算資源，以達到更好的修復或增強效果。

*   **Bicubic.hlsl**
    *   **說明**：雙三次插值法 (Bicubic Interpolation)。這是一種比雙線性插值更進階的影像縮放演算法。它會參考周圍 4x4 (16個) 像素點的資訊，並使用三次多項式來計算新像素的值。
    *   **優點**：放大後的影像邊緣更平滑，細節保留比雙線性更好，是畫質與效能之間一個很好的平衡點。
    *   **數學原理**：插值核心 (Kernel) 是一個在二維空間中的函數，常用的形式是：
        $$ W(x, y) = W_{1D}(x) \cdot W_{1D}(y) $$
        其中一維的 Cubic 卷積函數 $ W_{1D}(z) $ 為：
        $$ W_{1D}(z) = \begin{cases} (a+2)|z|^3 - (a+3)|z|^2 + 1 & \text{for } |z| \le 1 \\ a|z|^3 - 5a|z|^2 + 8a|z| - 4a & \text{for } 1 < |z| < 2 \\ 0 & \text{otherwise} \end{cases} $$
        參數 $ a $ 通常設為 -0.5 或 -0.75。

*   **Bilinear.hlsl**
    *   **說明**：雙線性插值法 (Bilinear Interpolation)。一種基礎的影像縮放演算法。它會參考目標像素點周圍最近的 2x2 (4個) 像素，並在水平和垂直方向上分別進行線性插值，以計算新像素的值。
    *   **優點**：速度快、實作簡單。
    *   **缺點**：放大後的影像容易變得模糊。

*   **Deband.hlsl**
    *   **說明**：去色帶 (Debanding) 演算法。色帶 (Banding) 現象通常發生在色彩漸層平緩的區域 (如天空)，因色彩深度不足而產生一條條明顯的分界線。此著色器透過在這些區域加入微量的隨機雜訊 (Dithering) 來打亂這些分界，使漸層看起來更平滑自然。

*   **ImageAdjustment.hlsl**
    *   **說明**：影像調整著色器。提供基礎的色彩校正功能，允許使用者調整畫面的亮度 (Brightness)、對比度 (Contrast)、飽和度 (Saturation)、色相 (Hue) 等參數。

*   **Jinc.hlsl / Lanczos.hlsl**
    *   **說明**：這兩者都是基於 Sinc 函數的高品質重採樣 (Resampling) 濾波器，常用於影像的放大或縮小。它們被認為是理論上最理想的濾波器之一，因為它們能最大程度地減少縮放過程中產生的鋸齒和失真。
    *   **Jinc**：是 Sinc 函數在二維極座標下的形式，特別適合處理圓形或放射狀的圖案。
    *   **Lanczos**：是 Sinc 函數的一個「加窗 (Windowed)」版本，它限制了 Sinc 函數的無限延伸範圍，使其可以在有限的像素範圍內進行計算 (例如，Lanczos3 會參考周圍 3x3 像素)。
    *   **數學原理**：理想的低通濾波器是 Sinc 函數：
        $$ \text{sinc}(x) = \frac{\sin(\pi x)}{\pi x} $$
        Lanczos 濾波器的核心為：
        $$ L(x) = \begin{cases} \text{sinc}(x) \cdot \text{sinc}(x/a) & \text{if } -a < x < a \\ 0 & \text{otherwise} \end{cases} $$
        其中 $ a $ 是控制窗口大小的整數 (例如 $ a=3 $ for Lanczos3)。

*   **Nearest.hlsl**
    *   **說明**：最近鄰插值法 (Nearest-neighbor Interpolation)。最簡單、最快速的影像縮放演算法。它直接選取目標位置最接近的原始像素顏色作為新像素的值。
    *   **優點**：速度極快，能完美保留原始像素的銳利度。
    *   **缺點**：放大後影像會產生明顯的馬賽克或像素塊。非常適合像素藝術風格的影像。

*   **SSimDownscaler.hlsl**
    *   **說明**：基於結構相似性 (Structural Similarity, SSIM) 的影像縮小演算法。傳統的縮小演算法可能會丟失過多細節。SSIM 是一種衡量兩張圖片相似度的指標，此演算法在縮小影像時會以 SSIM 為目標進行最佳化，盡可能保留原始影像的結構與感知品質，產生比傳統方法更清晰的縮圖。
    *   **數學原理**：SSIM 的計算公式為：
        $$ \text{SSIM}(x, y) = [l(x, y)]^\alpha \cdot [c(x, y)]^\beta \cdot [s(x, y)]^\gamma $$
        其中 $ l, c, s $ 分別代表亮度、對比度和結構的比較函數。

### 各目錄詳解

#### Anime4K
*   **專長**：專為動畫設計的高效能即時放大與畫質增強演算法。
*   **檔案解析**：
    *   **核心功能**：`Upscale` (放大), `Denoise` (降噪), `Restore` (修復，通常是放大+降噪+線條處理)。
    *   **GAN 版本**：`_GAN_` 檔案使用生成對抗網路模型，能創造更豐富的細節，但對效能要求更高。
    *   **強度後綴**：`S` (小), `M` (中), `L` (大), `UL` (超大), `VL` (極大) 代表演算法的複雜度和強度。越複雜，處理效果越精細，但 GPU 負載越高。
    *   **特殊版本**：
        *   `_3D_`: 針對 3D 渲染的動畫進行最佳化。
        *   `_Soft_`: 提供較柔和的處理效果，避免過度銳化。
        *   `_Thin_HQ`: 高品質線條細化，讓線條更纖細清晰。

#### CAS
*   **專長**：對比度自適應銳化 (Contrast Adaptive Sharpening)。
*   **檔案解析**：
    *   `CAS.hlsl`: 核心的智慧銳化演算法，只銳化低對比度區域，避免在高對比度邊緣產生光暈。
    *   `CAS_Scaling.hlsl`: 結合了 CAS 銳化與影像縮放功能，可以在放大影像的同時進行高品質銳化。

#### CRT
*   **專長**：模擬老式陰極射線管 (CRT) 螢幕的顯示效果。
*   **檔案解析**：
    *   `CRT_Geom`: 注重模擬 CRT 的幾何失真，如枕形失真和螢幕曲面。
    *   `CRT_Lottes` / `CRT_Hyllian`: 由不同作者開發的著名 CRT 濾鏡，各自在掃描線、磷光體殘影、色彩滲透等方面有獨特的風格。
    *   `CRT_Easymode`: 一個簡化、易於配置的 CRT 效果。
    *   `GTU_v050`: 專注於模擬老式電視訊號的模糊和柔和感。

#### CuNNy / CuNNy2
*   **專長**：基於卷積神經網路 (CNN) 的高品質影像放大器。
*   **檔案解析**：
    *   **命名規則**：檔名中的數字，如 `16x16C`，代表神經網路的結構 (例如，核心大小、通道數)。數字越大，模型越複雜，效果可能越好，但速度越慢。
    *   `DN`: 代表 Denoise (降噪)，表示該模型在放大同時具備降噪能力。
    *   `fast`, `faster`, `veryfast`: 效能最佳化版本，犧牲部分品質以換取更高速度。

#### FSR
*   **專長**：AMD 的 FidelityFX Super Resolution 1.0 技術，用於影像放大與銳化。
*   **檔案解析**：
    *   `FSR_EASU.hlsl`: 核心的放大演算法 (Edge-Adaptive Spatial Upsampling)，能有效重建平滑的邊緣。
    *   `FSR_RCAS.hlsl`: 銳化演算法 (Robust Contrast Adaptive Sharpening)，在放大後恢復影像的清晰度。

#### FSRCNNX
*   **專長**：一種輕量且快速的卷積神經網路超解析度演算法。
*   **檔案解析**：
    *   `FSRCNNX.hlsl`: 標準模型。
    *   `FSRCNNX_LineArt.hlsl`: 專為線條稿和動畫最佳化的版本。

#### FXAA
*   **專長**：快速近似反鋸齒 (Fast Approximate Anti-Aliasing)。
*   **檔案解析**：一種效能極高的後處理反鋸齒技術。它透過偵測畫面中的亮度對比來找到鋸齒邊緣並將其平滑化。`Low` 到 `Ultra` 是不同品質等級的預設。

#### NIS
*   **專長**：NVIDIA Image Scaling，NVIDIA 的影像放大與銳化技術。
*   **檔案解析**：
    *   `NIS.hlsl` / `NIS_Scaler.hlsli`: 核心的縮放與銳化著色器。
    *   `Coef_Scale.dds` / `Coef_USM.dds`: 紋理檔案 (.dds)，儲存了縮放和銳化濾波器所需的預計算係數。
    *   `NVSharpen.hlsl`: 獨立的銳化組件。

#### NNEDI3
*   **專長**：利用神經網路進行邊緣導向插值 (Neural Network Edge Directed Interpolation) 的高品質倍線器。
*   **檔案解析**：
    *   `nns16`...`nns256`: `nns` (neurons) 代表神經元的數量，數字越大，網路越複雜，邊緣預測越準確，但效能開銷也越大。
    *   `win8x4` / `win8x6`: 代表在預測一個像素時所參考的周圍像素視窗大小。

#### Pixel Art
*   **專長**：專為像素藝術風格設計的濾鏡。
*   **檔案解析**：
    *   `MMPX.hlsl`: 一種像素藝術放大演算法。
    *   `Pixellate.hlsl`: 馬賽克化濾鏡，將高解析度影像轉為低解析度像素風格。
    *   `SharpBilinear.hlsl`: 雙線性插值的改良版，在平滑的同時盡力保持銳利度。

#### RAVU
*   **專長**：一套追求速度與品質平衡的模式比對 (Pattern-based) 放大演算法。
*   **檔案解析**：
    *   **版本**：`R2` 到 `R4` 代表品質等級。
    *   **變體**：`Lite` (輕量版), `Zoom` (動態縮放), `AR` (長寬比修正), `RGB` (在RGB色彩空間處理)。
    *   `.dds` 檔案：是查找表 (Look-Up Tables, LUTs)，儲存了預先計算好的像素模式和對應的輸出結果，是演算法高效運作的關鍵。

#### Sharpen
*   **專長**：提供多種銳化濾鏡。
*   **檔案解析**：
    *   `AdaptiveSharpen`: 自適應銳化，避免過度銳化平坦區域。
    *   `FineSharp`: 提供更精細、控制項更多的銳化效果。
    *   `LCAS`: Luma Contrast Adaptive Sharpening，一種僅作用於亮度通道的對比度自適應銳化。
    *   `LumaSharpen`: 僅對亮度進行銳化，避免產生色彩失真。

#### SMAA
*   **專長**：增強型子像素形態學反鋸齒 (Subpixel Morphological Anti-Aliasing)。
*   **檔案解析**：比 FXAA 更先進的後處理反鋸齒技術，畫質更好，模糊更少。
    *   `AreaTex.dds` / `SearchTex.dds`: 預計算紋理，用於加速邊緣模式的偵測與混合。
    *   `Low` 到 `Ultra`: 不同品質等級的預設。

#### xBRZ
*   **專長**：專為像素藝術設計的放大演算法，"BRZ" 代表 "Scale by rules"。
*   **檔案解析**：它透過一系列規則來辨識像素圖案，並將其平滑地放大，產生類似向量圖的清晰外觀。
    *   `2x`...`6x`: 代表固定的放大倍率。
    *   `xBRZ_Freescale.hlsl`: 允許任意倍率的縮放。