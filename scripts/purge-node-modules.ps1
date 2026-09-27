# 彻底删除 node_modules（可重试版本）。
#
# 本机环境下：
#  - cmd.exe 无法从 Git Bash 直接调用（安全策略拦截）
#  - Node 的 fs.rmSync 被包装为“移到回收站”，大量文件时会 ETIMEDOUT
#  - PowerShell 单次 Remove-Item 也会在文件数过多时超时
# 因此这里用 .NET 逐目录删除并重试，直到删净。
#
# 用法：powershell -File scripts/purge-node-modules.ps1

$target = Join-Path (Split-Path -Parent $PSScriptRoot) 'node_modules'

if (-not (Test-Path $target)) {
    Write-Output "node_modules 不存在，无需删除。"
    exit 0
}

Write-Output "开始删除：$target"

for ($round = 1; $round -le 10; $round++) {
    if (-not (Test-Path $target)) { break }

    # 先解除只读属性，避免权限导致的删除失败
    try {
        Get-ChildItem -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue |
            ForEach-Object { $_.Attributes = 'Normal' }
    } catch { }

    try {
        # 逐个顶层子项删除，比一次性删整棵树更不容易超时
        Get-ChildItem -LiteralPath $target -Force -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
            } catch { }
        }
    } catch { }

    Start-Sleep -Milliseconds 800
    Write-Output "第 $round 轮完成"
}

if (Test-Path $target) {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

if (Test-Path $target) {
    Write-Output "RESULT: STILL_EXISTS"
    exit 1
} else {
    Write-Output "RESULT: DELETED"
    exit 0
}
