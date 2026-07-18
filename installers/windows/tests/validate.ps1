[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$windowsRoot = Split-Path $PSScriptRoot -Parent
$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $windowsRoot "..\.."))
$packageRoot = Split-Path $repositoryRoot -Parent
$manifestPath = Join-Path $packageRoot "BUNDLE_MANIFEST.sha256"
$phaseErrors = New-Object System.Collections.Generic.List[string]

function Get-Sha256Hex {
    param([string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return -join ($sha.ComputeHash($stream) |
            ForEach-Object { $_.ToString("x2") })
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

Write-Host (
    "ENGINE={0} {1}" -f
    $PSVersionTable.PSEdition,
    $PSVersionTable.PSVersion
) -ForegroundColor Cyan

if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    foreach ($line in Get-Content -LiteralPath $manifestPath -Encoding UTF8) {
        if (-not $line.Trim()) { continue }
        $parts = $line -split '  ', 2
        if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[0-9a-f]{64}$') {
            throw ("Línea de manifest inválida: {0}" -f $line)
        }
        $relative = $parts[1].Replace(
            '/',
            [System.IO.Path]::DirectorySeparatorChar
        )
        $target = Join-Path $packageRoot $relative
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw ("Fichero del manifest ausente: {0}" -f $parts[1])
        }
        $actual = Get-Sha256Hex -Path $target
        if ($actual -ne $parts[0]) {
            throw ("SHA-256 incorrecto: {0}" -f $parts[1])
        }
    }
    Write-Host "BUNDLE_MANIFEST_OK" -ForegroundColor Green
} else {
    Write-Host "BUNDLE_MANIFEST_SKIPPED_NOT_PRESENT" -ForegroundColor Yellow
}

$parseErrorsFound = $false
$targets = Get-ChildItem -LiteralPath $windowsRoot `
    -Filter "*.ps1" -File -Recurse
foreach ($target in $targets) {
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        $target.FullName,
        [ref]$tokens,
        [ref]$errors
    )
    if ($errors.Count -gt 0) {
        $parseErrorsFound = $true
        foreach ($errorItem in $errors) {
            Write-Host (
                "{0}:{1}:{2}: {3}" -f
                $target.FullName,
                $errorItem.Extent.StartLineNumber,
                $errorItem.Extent.StartColumnNumber,
                $errorItem.Message
            ) -ForegroundColor Red
        }
    } else {
        Write-Host ("PARSE_OK: {0}" -f $target.Name)
    }
}
if ($parseErrorsFound) {
    throw "Parser nativo falló; no se ejecutarán contratos ni mocks."
}

Write-Host ""
Write-Host "=== Contratos estáticos ===" -ForegroundColor Cyan
try {
    & (Join-Path $PSScriptRoot "test_contracts.ps1") `
        -WindowsRoot $windowsRoot
} catch {
    $phaseErrors.Add(("contracts:{0}" -f $_.Exception.Message))
}

Write-Host ""
Write-Host "=== Copia nativa del paquete real — no usa Docker ===" -ForegroundColor Cyan
try {
    & (Join-Path $PSScriptRoot "test_real_payload.ps1") `
        -WindowsRoot $windowsRoot -RepositoryRoot $repositoryRoot
} catch {
    $phaseErrors.Add(("real_payload:{0}" -f $_.Exception.Message))
}

Write-Host ""
Write-Host "=== Pruebas automáticas simuladas — no requieren interacción ===" `
    -ForegroundColor Cyan
try {
    & (Join-Path $PSScriptRoot "test_mocked.ps1") `
        -WindowsRoot $windowsRoot
} catch {
    $phaseErrors.Add(("mocked:{0}" -f $_.Exception.Message))
}

if ($phaseErrors.Count -gt 0) {
    Write-Host ""
    Write-Host "VALIDATION_PHASE_FAILURES" -ForegroundColor Red
    $phaseErrors | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    throw ("Validación fallida en {0} fase(s)." -f $phaseErrors.Count)
}

Write-Host "WINDOWS_STORAGE_REWRITE_VALIDATION_OK" -ForegroundColor Green
Write-Host "WINDOWS_PLATFORM_PREREQUISITES_VALIDATION_OK" -ForegroundColor Green
Write-Host "WINDOWS_REAL_PAYLOAD_STAGING_VALIDATION_OK" -ForegroundColor Green
Write-Host "WINDOWS_ROOT_PARENT_FIX_VALIDATION_OK" -ForegroundColor Green
