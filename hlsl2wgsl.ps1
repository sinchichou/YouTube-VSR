# 設定資料夾路徑
$inputFolder = "effects"  # 你的 HLSL 檔案資料夾
$outputFolder = "effects_wgsl" # WGSL 輸出資料夾
$dxcPath = ".\compiler\dxc\bin\x86\dxc.exe"

# 建立輸出資料夾（如果不存在）
if (-not (Test-Path $outputFolder)) {
    New-Item -ItemType Directory -Path $outputFolder | Out-Null
}

# 遍歷所有 .hlsl 檔案
Get-ChildItem -Path $inputFolder -Filter *.hlsl -Recurse | ForEach-Object {
    $hlslFile = $_.FullName
    $fileNameWithoutExt = [System.IO.Path]::GetFileNameWithoutExtension($hlslFile)
    $spvFile = Join-Path $outputFolder "$fileNameWithoutExt.spv"
    $wgslFile = Join-Path $outputFolder "$fileNameWithoutExt.wgsl"

    # 使用 dxc 編譯成 SPIR-V
    & $dxcPath -T ps_6_2 -E main -spirv -Fo $spvFile $hlslFile

    if (Test-Path $spvFile) {
        # 使用 naga 將 SPIR-V 轉成 WGSL
        & naga $spvFile $wgslFile
        Write-Host "轉換完成: $hlslFile -> $wgslFile"
    } else {
        Write-Host "DXC 編譯失敗: $hlslFile"
    }
}
