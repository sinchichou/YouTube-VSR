# SCRIPT: clone_projects.ps1
# DESCRIPTION: Clones multiple shader project repositories from GitHub.

# --- 檢查先決條件 ---
# 檢查 Git 是否已安裝且在 PATH 中
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "[ERROR] Git 未安裝或未加入至系統 PATH 路徑。" -ForegroundColor Red
    Write-Host "        請先從 https://git-scm.com/downloads 安裝 Git。" -ForegroundColor Yellow
    Read-Host "按 Enter 鍵結束"
    exit
}

# --- 主要執行區塊 ---
$mainDir = "shader_projects"
Write-Host "[INFO] 建立資料夾: $mainDir" -ForegroundColor Green

# 如果資料夾不存在，則建立它
if (-not (Test-Path -Path $mainDir)) {
    New-Item -Path $mainDir -ItemType Directory | Out-Null
}

# 進入該資料夾
Set-Location -Path $mainDir

# --- 開始下載專案 ---
Write-Host ""
Write-Host "[INFO] 正在下載 Anime4K 專案..." -ForegroundColor Cyan
git clone https://github.com/bloc97/Anime4K.git

Write-Host ""
Write-Host "[INFO] 正在下載 FidelityFX-CAS 專案..." -ForegroundColor Cyan
git clone https://github.com/GPUOpen-Effects/FidelityFX-CAS.git

Write-Host ""
Write-Host "[INFO] 正在下載 FidelityFX-FSR 專案..." -ForegroundColor Cyan
git clone https://github.com/GPUOpen-Effects/FidelityFX-FSR.git

Write-Host ""
Write-Host "[INFO] 正在下載 RetroArch Slang Shaders 專案 (包含 CRT, FXAA, SMAA)..." -ForegroundColor Cyan
Write-Host "[WARN] 這個專案很大，可能需要一些時間..." -ForegroundColor Yellow
git clone https://github.com/libretro/slang-shaders.git

Write-Host ""
Write-Host "[INFO] 正在下載 mpv-prescalers 專案 (包含 NNEDI3, RAVU)..." -ForegroundColor Cyan
git clone https://github.com/bjin/mpv-prescalers.git

Write-Host ""
Write-Host "[INFO] 正在下載 RetroArch GLSL Shaders 專案 (包含 xBRZ)..." -ForegroundColor Cyan
git clone https://github.com/libretro/glsl-shaders.git

Write-Host ""
Write-Host "[INFO] 正在下載 mpv 專案 (包含 deband)..." -ForegroundColor Cyan
Write-Host "[WARN] 這個專案很大，可能需要一些時間..." -ForegroundColor Yellow
git clone https://github.com/mpv-player/mpv.git

# --- 完成訊息 ---
Write-Host ""
Write-Host "[SUCCESS] 所有專案已下載完成！" -ForegroundColor Green
Write-Host "檔案已儲存於 '$((Get-Location).Path)' 資料夾中。"
Write-Host ""
Read-Host "按 Enter 鍵結束"