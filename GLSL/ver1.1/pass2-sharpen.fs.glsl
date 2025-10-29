precision highp float;
varying vec2 v_texCoord;

// Pass 1 修復後的乾淨影像
uniform sampler2D u_repairedPass; 
uniform vec2 u_texelSize;

// 銳化強度 (0.0 = 關閉, 1.0 = 強烈)
uniform float u_casSharpness;

// 用來獲取亮度的函式
float getLuma(vec3 rgb) {
    return dot(rgb, vec3(0.299, 0.587, 0.114));
}

void main() {
    // 從修復後的影像中取色
    vec3 color = texture2D(u_repairedPass, v_texCoord).rgb;
    
    // 如果銳化強度為0，直接返回，節省效能
    if (u_casSharpness < 0.01) {
        gl_FragColor = vec4(color, 1.0);
        return;
    }

    // --- AMD FidelityFX CAS 演算法 ---
    // 1. 採樣周圍像素
    vec3 b = texture2D(u_repairedPass, v_texCoord + u_texelSize * vec2( 0.0, -1.0)).rgb;
    vec3 d = texture2D(u_repairedPass, v_texCoord + u_texelSize * vec2(-1.0,  0.0)).rgb;
    vec3 e = color;
    vec3 f = texture2D(u_repairedPass, v_texCoord + u_texelSize * vec2( 1.0,  0.0)).rgb;
    vec3 h = texture2D(u_repairedPass, v_texCoord + u_texelSize * vec2( 0.0,  1.0)).rgb;

    // 2. 找到局部最小/最大亮度
    float min_luma = getLuma(e);
    float max_luma = getLuma(e);
    min_luma = min(min_luma, getLuma(b));
    max_luma = max(max_luma, getLuma(b));
    min_luma = min(min_luma, getLuma(d));
    max_luma = max(max_luma, getLuma(d));
    min_luma = min(min_luma, getLuma(f));
    max_luma = max(max_luma, getLuma(f));
    min_luma = min(min_luma, getLuma(h));
    max_luma = max(max_luma, getLuma(h));

    // 3. 計算銳化權重 A
    // (max - min) / max: 這就是「對比度自我調整」的關鍵
    // 如果 max_luma 接近 0，我們不進行銳化
    float A = 0.0;
    if (max_luma > 0.01) {
        A = min(1.0, (max_luma - min_luma) / max_luma);
    }
    
    // 4. 計算最終銳化量並混合
    // - A * A: 讓權重曲線更陡峭，只在對比度真的很高的地方才全力銳化
    // - u_casSharpness: 全域強度控制
    vec3 sharpened_color = (b + d + f + h) * 0.25 - e;
    float sharp_amount = -1.0 / (8.0 * (1.0 - u_casSharpness) + 2.0);
    
    gl_FragColor = vec4(color - sharpened_color * A * A * sharp_amount, 1.0);
}