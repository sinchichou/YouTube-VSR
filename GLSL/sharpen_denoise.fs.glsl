precision highp float;
varying vec2 v_texCoord;

uniform sampler2D u_inputPass;
uniform vec2 u_texelSize;
uniform float u_sharpenStrength;
uniform float u_denoiseStrength;
uniform float u_denoiseSigma; // 新增：降噪的顏色敏感度 (建議範圍 0.0 to 1.0)

vec3 fastBoxBlur(vec2 uv){
    vec3 blur = vec3(0.0);
    blur += texture2D(u_inputPass, uv + u_texelSize * vec2(-1.0, -1.0)).rgb;
    blur += texture2D(u_inputPass, uv + u_texelSize * vec2( 1.0, -1.0)).rgb;
    blur += texture2D(u_inputPass, uv + u_texelSize * vec2(-1.0,  1.0)).rgb;
    blur += texture2D(u_inputPass, uv + u_texelSize * vec2( 1.0,  1.0)).rgb;
    return blur / 4.0;
}

vec3 sharpen(vec3 color, vec2 uv){
    vec3 blur = fastBoxBlur(uv);
    vec3 highFreq = color - blur;
    return color + highFreq * u_sharpenStrength;
}

vec3 denoise(vec3 color, vec2 uv){
    vec3 center = color;
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    
    float sigma = u_denoiseSigma * u_denoiseSigma * 2.0;
    if (sigma < 1e-6) sigma = 1e-6;

    for(int y=-1; y<=1; y++){
        for(int x=-1; x<=1; x++){
            vec2 offset = vec2(float(x), float(y)) * u_texelSize;
            vec3 sample = texture2D(u_inputPass, uv + offset).rgb;
            float ws = exp(-(float(x*x + y*y))/(2.0*0.5*0.5));
            float wr = exp(-dot(sample-center,sample-center)/sigma);
            float w = ws * wr; 
            sum += sample * w; 
            wsum += w;
        }
    }
    return mix(center, sum/wsum, u_denoiseStrength);
}

void main(){
    vec3 color = texture2D(u_inputPass, v_texCoord).rgb;
    color = sharpen(color, v_texCoord);
    color = denoise(color, v_texCoord);
    gl_FragColor = vec4(color, 1.0);
}