#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 fragColor;

// Uniforms
uniform sampler2D u_inputPass;      // Pass 1 (Deblock) 的輸出紋理
uniform vec2 u_texelSize;            // 像素大小 (1.0 / 解析度)
uniform float u_sharpenStrength;    // 銳化強度
uniform float u_denoiseStrength;    // 降噪強度

// 快速 Box Blur 函數 (4點採樣)，用於 Unsharp Mask
vec3 fastBoxBlur(vec2 uv){
    vec3 blur = vec3(0.0);
    // 採樣 Pass 1 的結果
    blur += texture(u_inputPass, uv + u_texelSize * vec2(-1.0, -1.0)).rgb;
    blur += texture(u_inputPass, uv + u_texelSize * vec2( 1.0, -1.0)).rgb;
    blur += texture(u_inputPass, uv + u_texelSize * vec2(-1.0,  1.0)).rgb;
    blur += texture(u_inputPass, uv + u_texelSize * vec2( 1.0,  1.0)).rgb;
    return blur / 4.0;
}

// 銳化細節 (Unsharp Mask)
vec3 sharpen(vec3 color, vec2 uv){
    vec3 blur = fastBoxBlur(uv);
    vec3 highFreq = color - blur; // 提取高頻細節
    return color + highFreq * u_sharpenStrength;
}

// 輕度降噪 (簡化版雙邊濾波)
vec3 denoise(vec3 color, vec2 uv){
    vec3 center = color; // 銳化後的顏色
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    
    // 遍歷 3x3 區域
    for(int y=-1; y<=1; y++){
        for(int x=-1; x<=1; x++){
            vec2 offset = vec2(float(x), float(y)) * u_texelSize;
            
            // 採樣 Pass 1 (去色塊後) 的影像作為鄰居參考
            vec3 sample = texture(u_inputPass, uv + offset).rgb;
            
            float ws = exp(-(float(x*x + y*y))/(2.0*0.5*0.5));
            // 顏色權重比較的是銳化後的中心點和去色塊的鄰居點
            float wr = exp(-dot(sample-center,sample-center)/(2.0*0.05*0.05));
            
            float w = ws * wr; 
            sum += sample * w; 
            wsum += w;
        }
    }
    // 根據降噪強度混合
    return mix(center, sum/wsum, u_denoiseStrength * 0.1);
}

void main(){
    // 1. 讀取 Pass 1 的結果 (已去色塊)
    vec3 color = texture(u_inputPass, v_texCoord).rgb;
    
    // 2. 應用銳化
    color = sharpen(color, v_texCoord);
    
    // 3. 應用降噪
    color = denoise(color, v_texCoord);
    
    fragColor = vec4(color, 1.0);
}