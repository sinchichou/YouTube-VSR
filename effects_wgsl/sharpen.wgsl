// MAGPIE WebGPU EFFECT
//!VERSION 1
//!SORT_NAME Sharpen

//!TEXTURE
//!WIDTH INPUT_WIDTH
//!HEIGHT INPUT_HEIGHT
@group(0) @binding(0) var INPUT: texture_2d<f32>;

//!TEXTURE
//!WIDTH INPUT_WIDTH
//!HEIGHT INPUT_HEIGHT
@group(0) @binding(1) var OUTPUT: texture_storage_2d<rgba16float, write>;

//! COMMON
// --- Integer Types (整數類型) ---
alias uint2 = vec2<u32>;
alias uint3 = vec3<u32>;
alias uint4 = vec4<u32>;

alias int2  = vec2<i32>;
alias int3  = vec3<i32>;
alias int4  = vec4<i32>;

// 向量 (Vectors)
alias MF2 = vec2<f32>;
alias MF3 = vec3<f32>;
alias MF4 = vec4<f32>;

struct SceneInfo {
    inputSize: uint2,
    inputPt: MF2,
    outputSize: uint2,
    outputPt: MF2,
    scale: MF2,
}

// FIX 1: Change Binding from 3 to 2
// Magpie default bindings: 0=Input, 1=Output, 2=CommonParams
@group(0) @binding(2) var<uniform> scene: SceneInfo;

fn GetInputPt() -> MF2 {
    return scene.inputPt;
}

fn Rmp8x8(a: u32) -> uint2 {
    let x: u32 = a % 8u;
    let y: u32 = a / 8u;
    return uint2(x, y);
}
//! END COMMON

//!PASS 1
//!DESC Sharpening Pass
//!IN INPUT
//!OUT OUTPUT
//!BLOCK_SIZE 16
//!NUM_THREADS 256
@compute @workgroup_size(256, 1, 1)
fn Pass1(@builtin(workgroup_id) workgroup_id: uint3, @builtin(local_invocation_id) local_id: uint3) {
    let gxy: uint2 = (Rmp8x8(local_id.x) << uint2(1u)) + (workgroup_id.xy * 8u);
    let outputSize: uint2 = textureDimensions(OUTPUT);

    // if gxy.x >= outputSize.x || gxy.y >= outputSize.y {
    //     return;
    // }

    // FIX 2: Coordinate Logic
    // We are using textureLoad, which needs Integer coordinates (0, 1, 2...).
    // Do NOT multiply by inputPt (which would convert it to 0.0 ~ 1.0).

    let dims: MF2 = MF2(textureDimensions(INPUT));

    let x: f32 = f32(gxy.x);
    let y: f32 = f32(gxy.y);

    // 3. Prepare convolution coordinates (Clamp to prevent out of bounds)
    let l = max(x - 1.0, 0.0);          // Left
    let r = min(x + 1.0, dims.x - 1.0); // Right
    let t = max(y - 1.0, 0.0);          // Top
    let b = min(y + 1.0, dims.y - 1.0); // Bottom

    // 4. Read Pixels
    let center = textureLoad(INPUT, int2(i32(x), i32(y)), 0).rgb;
    let top = textureLoad(INPUT, int2(i32(x), i32(t)), 0).rgb;
    let bottom = textureLoad(INPUT, int2(i32(x), i32(b)), 0).rgb;
    let left = textureLoad(INPUT, int2(i32(l), i32(y)), 0).rgb;
    let right = textureLoad(INPUT, int2(i32(r), i32(y)), 0).rgb;

    // 5. Sharpening Logic
    // Kernel:
    // [  0, -1,  0 ]
    // [ -1,  5, -1 ]
    // [  0, -1,  0 ]

    var color = center * 5.0 - (top + bottom + left + right);

    // 6. Clamp result
    color = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));

    // 7. Store Output
    let originalAlpha = textureLoad(INPUT, int2(i32(x), i32(y)), 0).a;
    textureStore(OUTPUT, int2(gxy), vec4<f32>(color, originalAlpha));
}
//!END PASS 1