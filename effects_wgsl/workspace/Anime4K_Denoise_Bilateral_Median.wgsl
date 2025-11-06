// 移植自 https://github.com/bloc97/Anime4K/blob/master/glsl/Denoise/Anime4K_Denoise_Bilateral_Median.glsl

//!Magpie-Web EFFECT
//!VERSION 1.0

//!PARAMETER
//!LABEL Strength
//!DEFAULT 0.1
//!MIN 0.01
//!MAX 5
//!STEP 0.01
float intensitySigma;

//!TEXTURE
Texture2D INPUT;

//!TEXTURE
//!WIDTH INPUT_WIDTH
//!HEIGHT INPUT_HEIGHT
Texture2D OUTPUT;

//!SAMPLER
//!FILTER POINT
SamplerState sam;

//!PASS 1
//!IN INPUT
//!OUT OUTPUT
//!BLOCK_SIZE 8 // 翻譯為 @workgroup_size(8, 8)
//!NUM_THREADS 64

// --- 寫死的資源綁定 (供第一階段原型驗證) ---
struct Params {
    intensitySigma: f32,
};

@group(0) @binding(0) var<uniform> params: Params; // intensitySigma 參數
@group(0) @binding(1) var INPUT: texture_2d<f32>; // 輸入紋理 (讀取)
@group(0) @binding(2) var OUTPUT: texture_storage_2d<rgba8unorm, write>; // 輸出紋理 (寫入)
@group(0) @binding(3) var sam: sampler; // 取樣器

// --- 宏替換為 WGSL const 和 var 宣告 ---

// intensitySigma 替換為 params.intensitySigma

const SPATIAL_SIGMA: f32 = 1.0;
const HISTOGRAM_REGULARIZATION: f32 = 0.0;
const INTENSITY_POWER_CURVE: f32 = 1.0;

// KERNELSIZE: uint(max(uint(SPATIAL_SIGMA), 1) * 2 + 1)
const KERNELSIZE: u32 = 3u; // 因為 SPATIAL_SIGMA = 1.0, 所以 KERNELSIZE = 3
const KERNELHALFSIZE: i32 = i32(KERNELSIZE / 2u); // 1
const KERNELLEN: u32 = KERNELSIZE * KERNELSIZE; // 9

// --- 輔助函式 ---

// 替換 #define GETOFFSET(i) int2(...)
fn get_offset(i: u32) -> vec2<i32> {
    return vec2<i32>(i32(i % KERNELSIZE) - KERNELHALFSIZE, i32(i / KERNELSIZE) - KERNELHALFSIZE);
}

// 替換 float get_luma(float3 rgb)
fn get_luma(rgb: vec3<f32>) -> f32 {
    return dot(vec3<f32>(0.299, 0.587, 0.114), rgb);
}

// 替換 float gaussian(float x, float s, float m)
fn gaussian(x: f32, s: f32, m: f32) -> f32 {
    let scaled = (x - m) / s;
    return exp(-0.5 * scaled * scaled);
}

// 替換 float3 getMedian(float3 v[KERNELLEN], float w[KERNELLEN], float n)
// 注意：WGSL 不允許直接傳遞陣列作為函式參數，必須使用指標
fn getMedian(v: ptr<function, array<vec3<f32>, KERNELLEN>>, w: ptr<function, array<f32, KERNELLEN>>, n: f32) -> vec3<f32> {
    var result = vec3<f32>(0.0, 0.0, 0.0);

    // [unroll] 替換為 WGSL 的迴圈
    for (var i: u32 = 0u; i < KERNELLEN; i = i + 1u) {
        var w_above: f32 = 0.0;
        var w_below: f32 = 0.0;
        
        // [unroll]
        for (var j: u32 = 0u; j < KERNELLEN; j = j + 1u) {
            if ((*v)[j].x > (*v)[i].x) {
                w_above = w_above + (*w)[j];
            } else if ((*v)[j].x < (*v)[i].x) {
                w_below = w_below + (*w)[j];
            }
        }

        if ((n - w_above) / n >= 0.5 && w_below / n <= 0.5) {
            result = (*v)[i];
            break;
        }
    }

    return result;
}

// --- 主要計算著色器入口點 ---

// 替換 void Pass1(uint2 blockStart, uint3 threadId)
// 假設 Rmp8x8, blockStart, GetOutputSize, GetInputPt 都在 JavaScript/生成器中處理了
// 在 WebGPU Compute Shader 中，我們直接使用 global_invocation_id
@compute @workgroup_size(8, 8, 1) // BLOCK_SIZE 8
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let gxy = global_id.xy;
    let outputSize = vec2<u32>(textureDimensions(OUTPUT));
    
    // 邊界檢查
    if (gxy.x >= outputSize.x || gxy.y >= outputSize.y) {
        return;
    }

    let inputSize = vec2<f32>(textureDimensions(INPUT));
    let inputPt = 1.0 / inputSize; // 替換 GetInputPt()
    let pos = (vec2<f32>(gxy) + 0.5) * inputPt;

    // 陣列宣告
    var histogram_v: array<vec3<f32>, KERNELLEN>;
    var histogram_l: array<f32, KERNELLEN>;
    var histogram_w: array<f32, KERNELLEN>;
    var n: f32 = 0.0;

    // 替換 INPUT.SampleLevel(sam, pos, 0)
    let vc = get_luma(textureSampleLevel(INPUT, sam, pos, 0.0).rgb);

    let is = pow(vc + 0.0001, INTENSITY_POWER_CURVE) * params.intensitySigma; // 替換 INTENSITY_SIGMA
    let ss = SPATIAL_SIGMA;

    var i: u32;

    // [unroll]
    for (i = 0u; i < KERNELLEN; i = i + 1u) {
        let ipos = get_offset(i); // 替換 GETOFFSET(i)
        
        // 替換 INPUT.SampleLevel(sam, pos + ipos * inputPt, 0).rgb
        histogram_v[i] = textureSampleLevel(INPUT, sam, pos + vec2<f32>(ipos) * inputPt, 0.0).rgb;
        
        histogram_l[i] = get_luma(histogram_v[i]);
        // 替換 length(ipos)
        histogram_w[i] = gaussian(histogram_l[i], is, vc) * gaussian(length(vec2<f32>(ipos)), ss, 0.0);
        n = n + histogram_w[i];
    }

    // HISTOGRAM_REGULARIZATION 區塊
    if (HISTOGRAM_REGULARIZATION > 0.0) {
        var histogram_wn: array<f32, KERNELLEN>;
        n = 0.0;

        // [unroll]
        for (i = 0u; i < KERNELLEN; i = i + 1u) {
            histogram_wn[i] = 0.0;
        }

        // [unroll]
        for (i = 0u; i < KERNELLEN; i = i + 1u) {
            histogram_wn[i] = histogram_wn[i] + gaussian(0.0, HISTOGRAM_REGULARIZATION, 0.0) * histogram_w[i];
            
            // [unroll]
            for (var j: u32 = (i + 1u); j < KERNELLEN; j = j + 1u) {
                let d = gaussian(histogram_l[j], HISTOGRAM_REGULARIZATION, histogram_l[i]);
                histogram_wn[j] = histogram_wn[j] + d * histogram_w[i];
                histogram_wn[i] = histogram_wn[i] + d * histogram_w[j];
            }
            n = n + histogram_wn[i];
        }

        // 替換 OUTPUT[gxy] = float4(...)
        textureStore(OUTPUT, gxy, vec4<f32>(getMedian(&histogram_v, &histogram_wn, n), 1.0));
        return;
    }

    // 替換 OUTPUT[gxy] = float4(...)
    textureStore(OUTPUT, gxy, vec4<f32>(getMedian(&histogram_v, &histogram_w, n), 1.0));
}