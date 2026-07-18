[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$WindowsRoot,
    [Parameter(Mandatory = $true)][string]$RepositoryRoot
)

$ErrorActionPreference = "Stop"
. (Join-Path $WindowsRoot "common.ps1")
. (Join-Path $WindowsRoot "storage.ps1")

$testToken = [Guid]::NewGuid().ToString("N")
$tempTestRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("Auditor IPs R10 real payload " + $testToken)
$tempMarker = Join-Path $tempTestRoot ".auditor-real-payload-owner"
$sourceFiles = @(Get-AuditorRepositoryPayloadFiles -SourceRoot $RepositoryRoot)
$rootFiles = @($sourceFiles | Where-Object { $_.Relative -notmatch '\\' })
$nestedFiles = @($sourceFiles | Where-Object { $_.Relative -match '\\' })

function Get-StagePayloadFiles {
    param([Parameter(Mandatory = $true)][string]$StageRoot)

    $base = (ConvertTo-AuditorCanonicalWindowsPath -Value $StageRoot).TrimEnd('\')
    return @(Get-ChildItem -LiteralPath $base -File -Recurse -Force |
        ForEach-Object {
            $relative = $_.FullName.Substring($base.Length).TrimStart('\')
            if (-not $relative.Equals('.auditor-install-owner', [StringComparison]::OrdinalIgnoreCase)) {
                [pscustomobject]@{
                    Relative = ConvertTo-AuditorSafePayloadRelativePath -RelativePath $relative
                    FullName = $_.FullName
                }
            }
        } | Sort-Object Relative)
}

function Assert-StageMatchesRealPayload {
    param(
        [Parameter(Mandatory = $true)][string]$StageRoot,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $targets = @(Get-StagePayloadFiles -StageRoot $StageRoot)
    if ($sourceFiles.Count -ne $targets.Count) {
        throw ("real_payload_count_mismatch:{0}:{1}:{2}" -f $Label, $sourceFiles.Count, $targets.Count)
    }

    $targetByRelative = @{}
    foreach ($target in $targets) {
        $key = $target.Relative.ToLowerInvariant()
        if ($targetByRelative.ContainsKey($key)) {
            throw ("real_payload_duplicate_target:{0}:{1}" -f $Label, $target.Relative)
        }
        $targetByRelative[$key] = $target
    }

    foreach ($source in $sourceFiles) {
        $relative = ConvertTo-AuditorSafePayloadRelativePath -RelativePath $source.Relative
        $key = $relative.ToLowerInvariant()
        if (-not $targetByRelative.ContainsKey($key)) {
            throw ("real_payload_missing_target:{0}:{1}" -f $Label, $relative)
        }
        if ((Get-AuditorFileSha256 -Path $source.Source) -ne
            (Get-AuditorFileSha256 -Path $targetByRelative[$key].FullName)) {
            throw ("real_payload_hash_mismatch:{0}:{1}" -f $Label, $relative)
        }
    }

    foreach ($target in $targets) {
        $key = $target.Relative.ToLowerInvariant()
        $known = @($sourceFiles | Where-Object {
            (ConvertTo-AuditorSafePayloadRelativePath -RelativePath $_.Relative).ToLowerInvariant() -eq $key
        })
        if ($known.Count -ne 1) {
            throw ("real_payload_unexpected_target:{0}:{1}" -f $Label, $target.Relative)
        }
    }

    foreach ($required in @("README.md", "installers\windows\storage.ps1")) {
        if (-not $targetByRelative.ContainsKey($required.ToLowerInvariant())) {
            throw ("real_payload_required_file_missing:{0}:{1}" -f $Label, $required)
        }
    }

    Write-Host ("REAL_PACKAGE_STAGING_{0}_FILES={1}" -f $Label, $targets.Count)
    Write-Host ("REAL_PACKAGE_STAGING_{0}_HASHES_OK" -f $Label) -ForegroundColor Green
}

function Assert-StageComposeConfig {
    param(
        [Parameter(Mandatory = $true)][string]$StageRoot,
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $exports = Join-Path $DataRoot "exports"
    $backups = Join-Path $DataRoot "backups"
    $diagnostics = Join-Path $DataRoot "diagnostics"
    foreach ($path in @($exports, $backups, $diagnostics)) {
        [void](New-Item -ItemType Directory -Path $path -Force)
    }
    $envPath = Join-Path $StageRoot ".env"
    $composePath = Join-Path $StageRoot "docker-compose.yml"
    $composeTemplate = Join-Path $StageRoot "installers\windows\docker-compose.windows.yml.example"
    $envText = @"
COMPOSE_PROJECT_NAME=auditor_ips_validation
AUDITOR_CONTAINER_NAME=auditor_ips_validation
PORT=59999
DB_PATH=/data/auditor.db
DATA_VOLUME=auditor_ips_validation_data
EXPORTS_HOST_DIR=$(ConvertTo-AuditorComposeHostPath -Path $exports)
BACKUPS_HOST_DIR=$(ConvertTo-AuditorComposeHostPath -Path $backups)
DIAGNOSTICS_HOST_DIR=$(ConvertTo-AuditorComposeHostPath -Path $diagnostics)
TLS_CERT_IP=192.168.1.40
TLS_CERT_DNS=auditips.local
SERVER_IP=192.168.1.40
SCAN_CIDR=192.168.1.0/24
PLATFORM_PROFILE=windows_desktop
DISCOVERY_MODE=l3_compat
"@
    Write-Utf8NoBom -Path $envPath -Text $envText
    Write-Utf8NoBom -Path $composePath -Text ([System.IO.File]::ReadAllText($composeTemplate))
    Invoke-AuditorNative -FilePath "docker.exe" -WorkingDirectory $RepositoryRoot -Arguments @(
        "compose", "--project-directory", $StageRoot,
        "--env-file", $envPath, "-f", $composePath,
        "config", "--quiet"
    ) -Quiet | Out-Null
    Write-Host ("REAL_PACKAGE_COMPOSE_CONFIG_{0}_OK" -f $Label) -ForegroundColor Green
}


function Get-WritableFixedDriveRoot {
    param([Parameter(Mandatory = $true)][string]$Token)

    $preferredRoot = [System.IO.Path]::GetPathRoot(
        (ConvertTo-AuditorCanonicalWindowsPath -Value $RepositoryRoot)
    )
    $roots = New-Object System.Collections.Generic.List[string]
    if ($preferredRoot) { $roots.Add($preferredRoot) }
    foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
        if (-not $drive.IsReady -or $drive.DriveType -ne [System.IO.DriveType]::Fixed) {
            continue
        }
        if (-not $roots.Contains($drive.RootDirectory.FullName)) {
            $roots.Add($drive.RootDirectory.FullName)
        }
    }

    foreach ($root in $roots) {
        $probe = Join-Path $root ("AuditorIPsValidationProbe-" + $Token)
        $marker = Join-Path $probe ".auditor-validation-owner"
        try {
            [void](New-Item -ItemType Directory -Path $probe -ErrorAction Stop)
            Write-Utf8NoBom -Path $marker -Text $Token
            if ([System.IO.File]::ReadAllText($marker).Trim() -ne $Token) {
                throw "probe_marker_mismatch"
            }
            return $root
        } catch {
            continue
        } finally {
            if (Test-Path -LiteralPath $probe -PathType Container) {
                if (Test-Path -LiteralPath $marker -PathType Leaf) {
                    if ([System.IO.File]::ReadAllText($marker).Trim() -eq $Token) {
                        Remove-Item -LiteralPath $probe -Recurse -Force
                    }
                }
            }
        }
    }
    return ""
}

function Invoke-RealPayloadScenario {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedStageParent,
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $stage = $null
    try {
        $stage = New-AuditorStagedInstallation -SourceRoot $RepositoryRoot -InstallRoot $InstallRoot
        $actualParent = ConvertTo-AuditorCanonicalWindowsPath -Value ([System.IO.Path]::GetDirectoryName($stage.Path))
        $expectedParent = ConvertTo-AuditorCanonicalWindowsPath -Value $ExpectedStageParent
        if (-not $actualParent.Equals($expectedParent, [StringComparison]::OrdinalIgnoreCase)) {
            throw ("real_payload_stage_parent_mismatch:{0}:{1}:{2}" -f $Label, $expectedParent, $actualParent)
        }
        Assert-StageMatchesRealPayload -StageRoot $stage.Path -Label $Label
        Assert-StageComposeConfig -StageRoot $stage.Path -DataRoot $DataRoot -Label $Label
        Write-Host ("REAL_PACKAGE_STAGING_{0}_OK" -f $Label) -ForegroundColor Green
    } finally {
        if ($stage) {
            Remove-AuditorOwnedInstallation -Path $stage.Path -Token $stage.Token
        }
    }
}

[void](New-Item -ItemType Directory -Path $tempTestRoot -Force)
Write-Utf8NoBom -Path $tempMarker -Text $testToken
try {
    if ($sourceFiles.Count -eq 0) { throw "real_payload_source_empty" }
    if ($rootFiles.Count -eq 0) { throw "real_payload_root_files_missing" }
    if ($nestedFiles.Count -eq 0) { throw "real_payload_nested_files_missing" }

    Write-Host ("REAL_PACKAGE_STAGING_FILES={0}" -f $sourceFiles.Count)
    Write-Host ("REAL_PACKAGE_ROOT_LEVEL_FILES={0}" -f $rootFiles.Count)
    Write-Host ("REAL_PACKAGE_NESTED_FILES={0}" -f $nestedFiles.Count)
    Write-Host ("REAL_PACKAGE_ROOT_LEVEL_SAMPLE={0}" -f $rootFiles[0].Relative)
    Write-Host ("REAL_PACKAGE_NESTED_SAMPLE={0}" -f $nestedFiles[0].Relative)

    $driveRoot = Get-WritableFixedDriveRoot -Token $testToken
    if ($driveRoot) {
        $rootInstall = Join-Path $driveRoot ("AuditorIps_R10_RootParent_" + $testToken)
        $rootData = Join-Path $tempTestRoot "root scenario data"
        Invoke-RealPayloadScenario -InstallRoot $rootInstall -ExpectedStageParent $driveRoot `
            -DataRoot $rootData -Label "ROOT"
        Write-Host ("WINDOWS_ROOT_LEVEL_PAYLOAD_DRIVE={0}" -f $driveRoot)
        Write-Host "REAL_PACKAGE_STAGING_ROOT_OK" -ForegroundColor Green
        Write-Host "WINDOWS_ROOT_LEVEL_PAYLOAD_PARENT_OK" -ForegroundColor Green
    } else {
        Write-Host "REAL_PACKAGE_STAGING_ROOT_SKIPPED_NO_WRITABLE_FIXED_ROOT" `
            -ForegroundColor Yellow
    }

    $nestedContainer = Join-Path $tempTestRoot "nested temporary path with spaces"
    $nestedInstall = Join-Path $nestedContainer "level one\level two\installation target"
    $nestedParent = [System.IO.Path]::GetDirectoryName($nestedInstall)
    $nestedData = Join-Path $tempTestRoot "nested scenario data"
    Invoke-RealPayloadScenario -InstallRoot $nestedInstall -ExpectedStageParent $nestedParent `
        -DataRoot $nestedData -Label "NESTED"
    Write-Host "REAL_PACKAGE_STAGING_NESTED_OK" -ForegroundColor Green
    Write-Host "WINDOWS_NESTED_TEMPORARY_PAYLOAD_PATH_OK" -ForegroundColor Green
    Write-Host "WINDOWS_PAYLOAD_PATH_WITH_SPACES_OK" -ForegroundColor Green

    foreach ($malicious in @("..\escape.txt", "\rooted.txt", "C:\absolute.txt")) {
        $rejected = $false
        try {
            [void](Resolve-AuditorPayloadDestinationPath -DestinationRoot $tempTestRoot -RelativePath $malicious)
        } catch {
            $rejected = $true
        }
        if (-not $rejected) { throw ("payload_unsafe_path_accepted:{0}" -f $malicious) }
    }
    Write-Host "WINDOWS_PAYLOAD_PATH_TRAVERSAL_REJECTED_OK" -ForegroundColor Green
    Write-Host "REAL_PACKAGE_STAGING_OK" -ForegroundColor Green
    Write-Host "REAL_PACKAGE_COMPOSE_CONFIG_OK" -ForegroundColor Green
} finally {
    if (Test-Path -LiteralPath $tempTestRoot -PathType Container) {
        if (-not (Test-Path -LiteralPath $tempMarker -PathType Leaf)) {
            throw "real_payload_test_cleanup_marker_missing"
        }
        if ([System.IO.File]::ReadAllText($tempMarker).Trim() -ne $testToken) {
            throw "real_payload_test_cleanup_marker_mismatch"
        }
        Remove-Item -LiteralPath $tempTestRoot -Recurse -Force
    }
}
