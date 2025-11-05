# 確保目標資料夾存在
$dest = "D:\YouTube VSR\shader\backup"
if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Path $dest | Out-Null }

# 遞迴抓取所有檔案並複製到 backup
Get-ChildItem -Path "D:\YouTube VSR\shader" -Recurse -File |
    Where-Object { $_.Extension -in ".wgsl", ".slang", ".glsl" } |
    ForEach-Object { Copy-Item $_.FullName -Destination $dest -Force }
