// Anime4K_Denoise_Bilateral_Median
// 移植自 https://github.com/bloc97/Anime4K/blob/master/glsl/Denoise/Anime4K_Denoise_Bilateral_Median.glsl

// Magpie WebGPU EFFECT
//!VERSION 1.0
//!SORT_NAME Anime4K_Denoise_Bilateral_Median

//! COMMON
alias uint2 = vec2<u32>;
alias uint3 = vec3<u32>;
alias int2 = vec2<i32>;
alias MF = f32;
alias MF2 = vec2<f32>;
alias MF3 = vec3<f32>;
alias MF4 = vec4<f32>;

// 注意：GetInputSize 和 GetInputPt 通常會被預處理器自動替換或定義，
// 如果編譯器報錯重複定義，請將其註解掉。
fn GetInputSize() -> uint2 {
    return uint2(0, 0);
}

fn GetInputPt() -> MF2 {
    return MF2(0, 0);
}

fn Rmp8x8(idx: u32) -> uint2 {
    return uint2(idx / 8u, idx % 8u);
}

const SPATIAL_SIGMA: f32 = 1.0;
const HISTOGRAM_REGULARIZATION: f32 = 0.0;
const INTENSITY_POWER_CURVE: f32 = 1.0;

const KERNELSIZE: u32 = 3u;
const KERNELHALFSIZE: i32 = 1;
const KERNELLEN: u32 = 9u;

fn get_offset(i: u32) -> int2 {
    return int2(i32(i % KERNELSIZE) - KERNELHALFSIZE, i32(i / KERNELSIZE) - KERNELHALFSIZE);
}

fn get_luma(rgb: MF3) -> f32 {
    return dot(MF3(0.299, 0.587, 0.114), rgb);
}

fn gaussian(x: f32, s: f32, m: f32) -> f32 {
    let scaled = (x - m) / s;
    return exp(-0.5 * scaled * scaled);
}

fn getMedian(v: ptr<function, array<MF3, KERNELLEN>>, w: ptr<function, array<f32, KERNELLEN>>, n: f32) -> MF3 {
    var result = MF3(0.0, 0.0, 0.0);
    for (var i: u32 = 0u; i < KERNELLEN; i = i + 1u) {
        var w_above: f32 = 0.0;
        var w_below: f32 = 0.0;
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
//!END COMMON

// --- 修正後的參數區塊 ---
//! PARAMETER intensitySigma
//! DEFAULT 0.1
//! MIN 0.01
//! MAX 5.0
//! STEP 0.01
//! LABEL "Intensity Sigma"
float intensitySigma;
// ^ 這裡不要加 //!END PARAMETER，也不要寫 = 0.1

//!TEXTURE
@group(0) @binding(0) var INPUT: texture_2d<f32>;

//!TEXTURE
//!WIDTH INPUT_WIDTH
//!HEIGHT INPUT_HEIGHT
@group(0) @binding(1) var OUTPUT: texture_storage_2d<rgba16float, write>;

//!SAMPLER
//!FILTER POINT
@group(0) @binding(10) var sam: sampler;

//!PASS 1
//!DESC Bilateral Median Denoise
//!IN INPUT
//!OUT OUTPUT
//!BLOCK_SIZE 8
//!NUM_THREADS 64

@compute @workgroup_size(64, 1, 1)
fn Pass1(@builtin(workgroup_id) workgroup_id: uint3, @builtin(local_invocation_id) local_id: uint3) {
    let gxy = Rmp8x8(local_id.x) + workgroup_id.xy * 8u;
    let inputSize = GetInputSize();

    if (gxy.x >= inputSize.x || gxy.y >= inputSize.y) {
        return;
    }

    let inputPt = GetInputPt();
    let pos = (MF2(gxy) + 0.5) * inputPt;

    var histogram_v: array<MF3, KERNELLEN>;
    var histogram_l: array<f32, KERNELLEN>;
    var histogram_w: array<f32, KERNELLEN>;
    var n: f32 = 0.0;

    let vc = get_luma(textureSampleLevel(INPUT, sam, pos, 0.0).rgb);

    // 預處理器正確解析後，會自動生成 params 結構體
    let is = pow(vc + 0.0001, INTENSITY_POWER_CURVE) * params.intensitySigma;
    let ss = SPATIAL_SIGMA;

    var i: u32;
    for (i = 0u; i < KERNELLEN; i = i + 1u) {
        let ipos = get_offset(i);
        histogram_v[i] = textureSampleLevel(INPUT, sam, pos + MF2(ipos) * inputPt, 0.0).rgb;
        histogram_l[i] = get_luma(histogram_v[i]);
        histogram_w[i] = gaussian(histogram_l[i], is, vc) * gaussian(length(MF2(ipos)), ss, 0.0);
        n = n + histogram_w[i];
    }

    if (HISTOGRAM_REGULARIZATION > 0.0) {
        var histogram_wn: array<f32, KERNELLEN>;
        n = 0.0;
        for (i = 0u; i < KERNELLEN; i = i + 1u) {
            histogram_wn[i] = 0.0;
        }
        for (i = 0u; i < KERNELLEN; i = i + 1u) {
            histogram_wn[i] = histogram_wn[i] + gaussian(0.0, HISTOGRAM_REGULARIZATION, 0.0) * histogram_w[i];
            for (var j: u32 = (i + 1u); j < KERNELLEN; j = j + 1u) {
                let d = gaussian(histogram_l[j], HISTOGRAM_REGULARIZATION, histogram_l[i]);
                histogram_wn[j] = histogram_wn[j] + d * histogram_w[i];
                histogram_wn[i] = histogram_wn[i] + d * histogram_w[j];
            }
            n = n + histogram_wn[i];
        }
        textureStore(OUTPUT, gxy, MF4(getMedian(&histogram_v, &histogram_wn, n), 1.0));
        return;
    }

    textureStore(OUTPUT, gxy, MF4(getMedian(&histogram_v, &histogram_w, n), 1.0));
}
//!END PASS 1