# 修复 pnpm 在 Windows 上未创建顶层包链接的问题。
# pnpm 把真实包放进了 node_modules/.pnpm/<name>@<ver>/node_modules/<name>，
# 但顶层 node_modules/<name> 是空目录。本脚本把这些空目录替换为 junction。
$ErrorActionPreference = 'Stop'
$root = "C:\Users\生升\Desktop\西财金融投资协会网站"
$nm = Join-Path $root 'node_modules'
$store = Join-Path $nm '.pnpm'

$fixed = 0
$skipped = 0
$failed = @()

Get-ChildItem $nm -Directory | Where-Object { $_.Name -ne '.pnpm' -and $_.Name -notlike '@*' } | ForEach-Object {
    $pkgDir = $_
    $name = $pkgDir.Name

    # 只处理空目录
    $hasContent = (Get-ChildItem $pkgDir.FullName -Force -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0
    if ($hasContent) { $skipped++; return }

    # 在 .pnpm 中找该包的版本目录（取第一个匹配）
    $candidateDirs = Get-ChildItem $store -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "^$([regex]::Escape($name))@" }
    if (-not $candidateDirs) {
        $failed += "$name (在 .pnpm 中未找到)"
        return
    }

    $target = $null
    foreach ($c in $candidateDirs) {
        $inner = Join-Path $c.FullName "node_modules\$name"
        if (Test-Path $inner) { $target = $inner; break }
    }
    if (-not $target) {
        $failed += "$name (找到版本目录但缺少内层 node_modules\$name)"
        return
    }

    try {
        Remove-Item $pkgDir.FullName -Recurse -Force
        New-Item -ItemType Junction -Path $pkgDir.FullName -Target $target | Out-Null
        $fixed++
    } catch {
        $failed += "$name ($($_.Exception.Message))"
    }
}

Write-Output "已修复: $fixed  已有内容跳过: $skipped  失败: $($failed.Count)"
if ($failed.Count -gt 0) { $failed | ForEach-Object { Write-Output "  失败 -> $_" } }
