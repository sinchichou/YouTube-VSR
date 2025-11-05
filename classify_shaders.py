import os
import shutil
import re

# --- 定義目標資料夾 ---
FOLDER_UPSCALING = "shader/Upscaling_Resamplers"
FOLDER_FILTERS_VISUALS = "shader/Post_Processing_Filters"
FOLDER_UTILITY_BASE = "shader/06_Utility_Base_Modules"

# --- 關鍵字分類規則 ---
UPSCALING_KEYWORDS = (
    "xbr", "xbrz", "sai", "epx", "mmpx", "mdapt", "sabr", "scalefx", "ddt", "gdapt",
    "nnedi3", "anime4k", "fsr", "rcas", "jinc2", "g-sharp", "hq2x", "hq3x", "hq4x",
    "lanczos", "bicubic", "b-spline", "catmull-rom", "spline", "sinc", "quad_interp",
    "drez-g-sharp", "super-xbr", "super-2xsai", "scale2x", "scale3x", "omniscale"
)

UTILITY_KEYWORDS = (
    "passthrough", "stock", "original", "int_stock", "transform", "resize", "shift-half-pixel",
    "downsample", "upsample", "frame", "history", "moving_avg", "feedback", "mix_frames",
    "motion_interpolation", "response-time", "linearize", "gamma-correct", "to_lin",
    "inverse_tonemap", "hdr10", "combine-passes", "present", "output-", "output\\.",
    "resolve", "custom-resolve", "screen_combine", "add-params", "cache-info", "pragma-name",
    "perf-pass", "frame_count", "pre-shaders", "post-crt-prep", "bufc", "bufd",
    "calculate_widths", "helper_pass", "primary", "decode-format", "format", "pack_unpack",
    "functions.include", "blooms.include", "pixel_glows.include", "hsm-",
    "box-", "crop-", "cut", "test-pattern", "print-resolution", "text-", "bevel",
    "gauss_2tap", "blur(?!\\d+x\\d+)", "blur-gauss", "blur\\d+fast", "blur\\d+resize",
    "bloom_blend", "bloom_pass_", "kawase", "bob-deinterlacing-lite", "pass[0-9]\\.slang"
)

CRT_OR_FILTER_PASSTHROUGH_EXCEPTIONS = (
    "crt-", "ntsc-", "pal-", "vhs", "gba-", "gbc-", "lcd-", "dot.", "slotmask",
    "bloom-", "afterglow", "deband", "sharpen", "deblur", "bilateral", "median"
)

# --- 函式定義 ---
def classify_folder(filename: str) -> str:
    """根據關鍵字分類檔案應該放的資料夾"""
    lower = filename.lower()
    
    # Upscaling
    if any(kw in lower for kw in UPSCALING_KEYWORDS):
        return FOLDER_UPSCALING
    
    # Utility/Base
    if any(re.search(kw, lower) for kw in UTILITY_KEYWORDS):
        if not any(exc in lower for exc in CRT_OR_FILTER_PASSTHROUGH_EXCEPTIONS):
            return FOLDER_UTILITY_BASE
    
    # 其他歸類為 Filters/Visuals
    return FOLDER_FILTERS_VISUALS

def move_file(source_path: str, target_dir: str):
    """移動檔案，遇到同名檔自動加數字避免覆蓋"""
    os.makedirs(target_dir, exist_ok=True)
    base_name = os.path.basename(source_path)
    name, ext = os.path.splitext(base_name)
    target_path = os.path.join(target_dir, base_name)
    
    counter = 1
    while os.path.exists(target_path):
        target_path = os.path.join(target_dir, f"{name}_{counter}{ext}")
        counter += 1

    shutil.move(source_path, target_path)
    print(f"Moved {source_path} -> {target_path}")

def main(input_dir: str):
    """遞迴分類輸入資料夾下的 .slang/.glsl 檔案"""
    for root, _, files in os.walk(input_dir):
        for file in files:
            if file.lower().endswith((".slang", ".glsl")):
                source = os.path.join(root, file)
                folder = classify_folder(file)
                move_file(source, folder)
    
    print("\n--- 分類完成 ---")

# --- 程式入口 ---
if __name__ == "__main__":
    input_dir = input("請輸入要分類的資料夾路徑: ").strip()
    if os.path.exists(input_dir) and os.path.isdir(input_dir):
        main(input_dir)
    else:
        print("資料夾不存在或路徑錯誤！")
