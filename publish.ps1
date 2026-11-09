# 发布 MCP-Skills-DSH 到 npmjs.org
# 用法: pwsh -NoProfile -File publish.ps1 [-DryRun]
# 前置: 已在 npmjs.com 生成 Granular Access Token(Read and Write / 允许 publish)，
#       并写入 ~/.npmrc 的 //registry.npmjs.org/:_authToken=
#       或设置环境变量 NPM_TOKEN（脚本会临时使用，不落盘）。
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$Registry = 'https://registry.npmjs.org'
$Plugin = Join-Path $PSScriptRoot 'plugin'

$TokenArgs = @()
if ($env:NPM_TOKEN) { $TokenArgs = @("--//registry.npmjs.org/:_authToken=$env:NPM_TOKEN") }

Write-Host "=== 1/5 登录态 ==="
& npm whoami --registry $Registry @TokenArgs
if ($LASTEXITCODE -ne 0) { throw "npm 未登录或 token 失效。先执行 npm login --registry $Registry，或更新 ~/.npmrc 的 _authToken" }

Write-Host "=== 2/5 单元测试 ==="
Push-Location $Plugin
try {
    & npm test
    if ($LASTEXITCODE -ne 0) { throw '单元测试未通过，中止发布' }

    Write-Host "=== 3/5 自包含检查 ==="
    & node test/isolation.check.mjs
    if ($LASTEXITCODE -ne 0) { throw '自包含检查未通过，中止发布' }

    Write-Host "=== 4/5 打包预检 ==="
    & npm pack --dry-run --json | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'pack 预检失败，中止发布' }

    Write-Host "=== 5/5 发布 ==="
    if ($DryRun) {
        Write-Host '[DryRun] 将执行: npm publish --access public --registry https://registry.npmjs.org'
        & npm publish --dry-run --access public --registry $Registry @TokenArgs
    }
    else {
        & npm publish --access public --registry $Registry @TokenArgs
        if ($LASTEXITCODE -ne 0) { throw 'npm publish 失败' }
        Write-Host "已发布: $((Get-Content package.json -Raw | ConvertFrom-Json).name)@$((Get-Content package.json -Raw | ConvertFrom-Json).version)"
    }
}
finally { Pop-Location }
