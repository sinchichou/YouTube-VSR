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

// 2xN 矩陣 (HLSL Row x Col -> WGSL Col x Row)
alias MF2x1 = vec2<f32>;
alias MF2x2 = mat2x2<f32>;
alias MF2x3 = mat3x2<f32>;
alias MF2x4 = mat4x2<f32>;

// 3xN 矩陣
alias MF3x1 = vec3<f32>;
alias MF3x2 = mat2x3<f32>;
alias MF3x3 = mat3x3<f32>;
alias MF3x4 = mat4x3<f32>;

// 4xN 矩陣
alias MF4x1 = vec4<f32>;
alias MF4x2 = mat2x4<f32>;
alias MF4x3 = mat3x4<f32>;
alias MF4x4 = mat4x4<f32>;

struct SceneInfo {
    inputSize: uint2,
    inputPt: MF2,
    outputSize: uint2,
    outputPt: MF2,
    scale: MF2,
}

@group(0) @binding(3) var<uniform> scene: SceneInfo;

fn GetInputSize() -> uint2 {
    return scene.inputSize;
}

fn GetInputPt() -> MF2 {
    return scene.inputPt;
}

fn GetFrameCount() -> u32 {
    return 0u;
}

fn GetOutputSize() -> uint2 {
    return scene.outputSize;
}

fn GetOutputPt() -> MF2 {
    return scene.outputPt;
}

fn Rmp8x8(a: u32) -> uint2 {
    let x: u32 = a % 8u;
    let y: u32 = a / 8u; 
    return uint2(x, y);
}
//! END COMMON