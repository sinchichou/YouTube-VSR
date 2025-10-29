precision highp float;
varying vec2 v_texCoord;

uniform sampler2D u_frame;      // Pass 0: 原始影像
uniform sampler2D u_guide;      // Pass 1: 引導圖 (模糊版)
uniform vec2 u_texelSize;

// 引導式濾波參數
uniform float u_guideStrength;  // 濾波強度 (0-1)
uniform float u_guideSigma;     // 顏色敏感度 (0-1)

// CAS 銳化參數
uniform float u_casStrength;    // 銳化強度 (0-+)

// --- 1. 引導式雙邊濾波 (Guided Bilateral Filter) ---
vec3 guidedFilter(vec2 uv) {
    vec3 center_original = texture2D(u_frame, uv).rgb;
    vec3 center_guide = texture2D(u_guide, uv).rgb;
    
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    
    float sigma = u_guideSigma * u_guideSigma * 2.0;
    if (sigma < 1e-6) sigma = 1e-6;

    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 offset = vec2(float(x), float(y)) * u_texelSize;
            
            // 從「原圖」取顏色來混合
            vec3 sample_original = texture2D(u_frame, uv + offset).rgb;
            // 但用「引導圖」的顏色來判斷權重
            vec3 sample_guide = texture2D(u_guide, uv + offset).rgb;
            
            float ws = 1.0; // 簡化空間權重
            float wr = exp(-dot(sample_guide - center_guide, sample_guide - center_guide) / sigma);
            
            float w = ws * wr;
            sum += sample_original * w;
            wsum += w;
        }
    }
    return mix(center_original, sum / wsum, u_guideStrength);
}

// --- 2. 對比度自我調整銳化 (Contrast Adaptive Sharpening) ---
vec3 contrastAdaptiveSharpen(vec3 color, vec2 uv) {
    // 採樣周圍像素，找到局部亮度和對比度
    vec3 min_c = color;
    vec3 max_c = color;

    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) continue;
            vec2 offset = vec2(float(x), float(y)) * u_texelSize;
            vec3 sample = texture2D(u_frame, uv + offset).rgb; // 從原圖採樣細節
            min_c = min(min_c, sample);
            max_c = max(max_c, sample);
        }
    }
    
    // 計算局部對比度，對比度越高，w 值越接近 1
    float contrast = dot(max_c - min_c, vec3(0.333));
    float w = contrast * contrast; // 用平方加大對比
    
    // 計算銳化量 (簡化版拉普拉斯算子)
    vec3 laplacian = color * 4.0;
    laplacian -= texture2D(u_frame, uv + u_texelSize * vec2(0.0, 1.0)).rgb;
    laplacian -= texture2D(u_frame, uv + u_texelSize * vec2(0.0, -1.0)).rgb;
    laplacian -= texture2D(u_frame, uv + u_texelSize * vec2(1.0, 0.0)).rgb;
    laplacian -= texture2D(u_frame, uv + u_texelSize * vec2(-1.0, 0.0)).rgb;

    // 混合銳化結果，銳化強度由 u_casStrength 和局部對比度 w 共同決定
    return color - laplacian * u_casStrength * w;
}

void main() {
    // 步驟 1: 執行引導式濾波，去除大色塊並保護邊緣
    vec3 color = guidedFilter(v_texCoord);
    
    // 步驟 2: 在濾波後的影像上，執行智慧銳化
    color = contrastAdaptiveSharpen(color, v_texCoord);
    
    gl_FragColor = vec4(color, 1.0);
}