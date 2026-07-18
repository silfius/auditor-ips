[CmdletBinding()]
param([string]$WindowsRoot = "")

$ErrorActionPreference = "Stop"
if (-not $WindowsRoot) { $WindowsRoot = Split-Path $PSScriptRoot -Parent }
$errors = New-Object System.Collections.Generic.List[string]

function Require-Text {
    param([string]$File, [string]$Value, [string]$Code)
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { $errors.Add("missing:" + $File); return }
    if (-not [System.IO.File]::ReadAllText($File).Contains($Value)) { $errors.Add($Code) }
}
function Forbid-Text {
    param([string]$File, [string]$Value, [string]$Code)
    if ((Test-Path -LiteralPath $File -PathType Leaf) -and [System.IO.File]::ReadAllText($File).Contains($Value)) { $errors.Add($Code) }
}

$install = Join-Path $WindowsRoot "install.ps1"
$migrate = Join-Path $WindowsRoot "migrate-installation.ps1"
$storage = Join-Path $WindowsRoot "storage.ps1"
$uninstall = Join-Path $WindowsRoot "uninstall.ps1"
$diagnose = Join-Path $WindowsRoot "diagnose.ps1"
$common = Join-Path $WindowsRoot "common.ps1"
$firewall = Join-Path $WindowsRoot "firewall.ps1"
$compose = Join-Path $WindowsRoot "docker-compose.windows.yml.example"
$mocked = Join-Path $WindowsRoot "tests\test_mocked.ps1"
$validate = Join-Path $WindowsRoot "tests\validate.ps1"
$realPayload = Join-Path $WindowsRoot "tests\test_real_payload.ps1"

foreach ($path in @($install, $migrate, $storage, $uninstall, $diagnose, $common, $firewall, $compose, $mocked, $validate, $realPayload)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { $errors.Add("missing:" + $path) }
}

foreach ($limit in @(
    [pscustomobject]@{ Path = $install; Maximum = 400 },
    [pscustomobject]@{ Path = $migrate; Maximum = 360 },
    [pscustomobject]@{ Path = $storage; Maximum = 720 },
    [pscustomobject]@{ Path = $uninstall; Maximum = 180 },
    [pscustomobject]@{ Path = $diagnose; Maximum = 180 }
)) {
    if ((Get-Content -LiteralPath $limit.Path).Count -gt $limit.Maximum) {
        $errors.Add("line_limit:" + $limit.Path)
    }
}

foreach ($forbidden in @("winget", "Restart-Computer", "git.exe", "-Upgrade", "-Rollback")) {
    Forbid-Text -File $install -Value $forbidden -Code ("install_forbidden:" + $forbidden)
    Forbid-Text -File $migrate -Value $forbidden -Code ("migrate_forbidden:" + $forbidden)
}
foreach ($forbidden in @("Get-NetFirewallRule", "New-NetFirewallRule", "Remove-NetFirewallRule")) {
    Forbid-Text -File $install -Value $forbidden -Code ("install_firewall_forbidden:" + $forbidden)
    Forbid-Text -File $migrate -Value $forbidden -Code ("migrate_firewall_forbidden:" + $forbidden)
}

foreach ($contract in @(
    [pscustomobject]@{ File=$common; Value="RedirectStandardOutput"; Code="native_stdout_missing" },
    [pscustomobject]@{ File=$common; Value="RedirectStandardError"; Code="native_stderr_missing" },
    [pscustomobject]@{ File=$common; Value="ExitCode = 127"; Code="native_start_failure_missing" },
    [pscustomobject]@{ File=$common; Value="function Get-AuditorWindowsPlatformInfo"; Code="windows_platform_detection_missing" },
    [pscustomobject]@{ File=$common; Value="function Assert-AuditorWindows11Amd64"; Code="windows_amd64_guard_missing" },
    [pscustomobject]@{ File=$common; Value="Win32_Processor"; Code="windows_native_processor_evidence_missing" },
    [pscustomobject]@{ File=$common; Value="RuntimeInformation"; Code="windows_runtime_architecture_evidence_missing" },
    [pscustomobject]@{ File=$common; Value="22631"; Code="windows_23h2_build_guard_missing" },
    [pscustomobject]@{ File=$install; Value="Assert-AuditorWindows11Amd64"; Code="install_windows_platform_guard_missing" },
    [pscustomobject]@{ File=$migrate; Value="Assert-AuditorWindows11Amd64"; Code="migrate_windows_platform_guard_missing" },
    [pscustomobject]@{ File=$common; Value="function Get-AuditorIPv4Candidates"; Code="network_detection_missing" },
    [pscustomobject]@{ File=$common; Value="function Wait-AuditorHealth"; Code="health_helper_missing" },
    [pscustomobject]@{ File=$common; Value="/api/system/healthz"; Code="health_endpoint_missing" },
    [pscustomobject]@{ File=$common; Value="function Assert-AuditorTlsSan"; Code="tls_helper_missing" },
    [pscustomobject]@{ File=$storage; Value="function Resolve-AuditorStorageConfiguration"; Code="storage_assistant_missing" },
    [pscustomobject]@{ File=$storage; Value="function Get-AuditorDefaultStorageConfiguration"; Code="dynamic_storage_defaults_missing" },
    [pscustomobject]@{ File=$storage; Value="DataRoot"; Code="dynamic_data_root_missing" },
    [pscustomobject]@{ File=$storage; Value="function Read-AuditorOperationalStoragePath"; Code="operational_path_retry_missing" },
    [pscustomobject]@{ File=$storage; Value="Raíz operativa propuesta"; Code="adapted_storage_prompt_missing" },
    [pscustomobject]@{ File=$storage; Value="Ruta permanente de instalación"; Code="install_path_prompt_missing" },
    [pscustomobject]@{ File=$storage; Value="Ruta de exportaciones"; Code="exports_path_prompt_missing" },
    [pscustomobject]@{ File=$storage; Value="Ruta de backups"; Code="backups_path_prompt_missing" },
    [pscustomobject]@{ File=$storage; Value="Ruta de diagnósticos"; Code="diagnostics_path_prompt_missing" },
    [pscustomobject]@{ File=$storage; Value="function Test-AuditorVolatilePath"; Code="volatile_path_guard_missing" },
    [pscustomobject]@{ File=$storage; Value="unidad local fija"; Code="fixed_drive_guard_missing" },
    [pscustomobject]@{ File=$storage; Value="function Get-AuditorInstallationParentPath"; Code="root_parent_resolver_missing" },
    [pscustomobject]@{ File=$storage; Value="function ConvertTo-AuditorSafePayloadRelativePath"; Code="safe_relative_payload_path_missing" },
    [pscustomobject]@{ File=$storage; Value="function Resolve-AuditorPayloadDestinationPath"; Code="payload_destination_guard_missing" },
    [pscustomobject]@{ File=$storage; Value="El staging no coincide con el manifest cerrado"; Code="closed_payload_manifest_check_missing" },
    [pscustomobject]@{ File=$storage; Value='Test-Path -LiteralPath $parent -PathType Container'; Code="parent_creation_guard_missing" },
    [pscustomobject]@{ File=$storage; Value="function Get-AuditorRepositoryPayloadFiles"; Code="payload_inventory_missing" },
    [pscustomobject]@{ File=$storage; Value="[System.IO.File]::Copy"; Code="deterministic_file_copy_missing" },
    [pscustomobject]@{ File=$storage; Value="Verificación SHA-256 fallida al copiar el paquete"; Code="payload_hash_verification_missing" },
    [pscustomobject]@{ File=$storage; Value="AuditorIPsStage-"; Code="short_stage_path_missing" },
    [pscustomobject]@{ File=$storage; Value="function Copy-AuditorRepositoryPayload"; Code="payload_copy_missing" },
    [pscustomobject]@{ File=$storage; Value=".auditor-install-owner"; Code="owned_cleanup_marker_missing" },
    [pscustomobject]@{ File=$storage; Value="function Copy-AuditorDirectoryContentVerified"; Code="persistent_copy_verification_missing" },
    [pscustomobject]@{ File=$storage; Value="function Assert-AuditorBindMounts"; Code="bind_mount_validation_missing" },
    [pscustomobject]@{ File=$install; Value="Instalación permanente"; Code="permanent_install_result_missing" },
    [pscustomobject]@{ File=$install; Value="schema_version = 2"; Code="state_schema_2_missing" },
    [pscustomobject]@{ File=$install; Value="installation_root"; Code="state_install_root_missing" },
    [pscustomobject]@{ File=$install; Value="Assert-AuditorBindMounts"; Code="install_bind_validation_missing" },
    [pscustomobject]@{ File=$install; Value="--project-directory"; Code="explicit_compose_project_directory_missing" },
    [pscustomobject]@{ File=$install; Value="ERROR_STAGE:"; Code="detailed_error_stage_missing" },
    [pscustomobject]@{ File=$install; Value="ERROR_STACK:"; Code="detailed_error_stack_missing" },
    [pscustomobject]@{ File=$migrate; Value="Get-AuditorComposeWorkingDirectory"; Code="active_install_detection_missing" },
    [pscustomobject]@{ File=$migrate; Value="Copy-PersistentContent"; Code="migration_persistent_copy_missing" },
    [pscustomobject]@{ File=$migrate; Value="Restore-CurrentRuntime"; Code="migration_rollback_missing" },
    [pscustomobject]@{ File=$migrate; Value="migrated_from"; Code="migration_state_missing" },
    [pscustomobject]@{ File=$migrate; Value=".auditor-ips-migrated-to.txt"; Code="migration_source_marker_missing" },
    [pscustomobject]@{ File=$diagnose; Value="DIAGNOSTICS_HOST_DIR"; Code="diagnostic_external_path_missing" },
    [pscustomobject]@{ File=$diagnose; Value="[REDACTED]"; Code="diagnostic_redaction_missing" },
    [pscustomobject]@{ File=$uninstall; Value="Exportaciones: conservar"; Code="uninstall_preservation_summary_missing" },
    [pscustomobject]@{ File=$uninstall; Value="PurgeData"; Code="purge_data_missing" },
    [pscustomobject]@{ File=$firewall; Value="-Profile Private"; Code="private_firewall_profile_missing" },
    [pscustomobject]@{ File=$compose; Value="source: auditor_data"; Code="logical_volume_missing" },
    [pscustomobject]@{ File=$compose; Value='name: ${DATA_VOLUME:-auditor_ips_data}'; Code="physical_volume_missing" },
    [pscustomobject]@{ File=$mocked; Value="WINDOWS_PLATFORM_NATIVE_OK"; Code="windows_native_platform_validation_missing" },
    [pscustomobject]@{ File=$mocked; Value="WINDOWS_PLATFORM_NATIVE="; Code="windows_native_platform_evidence_missing" },
    [pscustomobject]@{ File=$mocked; Value="WINDOWS_PLATFORM_AMD64_OK"; Code="windows_amd64_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="WINDOWS_PLATFORM_ARM64_REJECTED_OK"; Code="windows_arm64_rejection_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="WINDOWS_PLATFORM_MISMATCH_REJECTED_OK"; Code="windows_architecture_mismatch_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="WINDOWS_PLATFORM_BUILD_REJECTED_OK"; Code="windows_build_rejection_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="WINDOWS_ROOT_PARENT_RESOLUTION_OK"; Code="root_parent_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="WINDOWS_PAYLOAD_SAFE_RELATIVE_PATHS_OK"; Code="safe_payload_path_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="WINDOWS_PAYLOAD_PATH_TRAVERSAL_REJECTED_MOCK_OK"; Code="payload_traversal_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="STORAGE_ASSISTANT_SIMULATION_OK"; Code="storage_mock_closure_missing" },
    [pscustomobject]@{ File=$mocked; Value="STORAGE_DYNAMIC_DEFAULTS_OK"; Code="storage_dynamic_defaults_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="STORAGE_NESTED_PATH_RETRY_OK"; Code="storage_nested_retry_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="STORAGE_NONINTERACTIVE_DYNAMIC_DEFAULTS_OK"; Code="storage_noninteractive_defaults_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="FRESH_PERMANENT_INSTALL_MOCK_OK"; Code="fresh_install_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="MIGRATION_SUCCESS_MOCK_OK"; Code="migration_success_mock_missing" },
    [pscustomobject]@{ File=$mocked; Value="MIGRATION_ROLLBACK_MOCK_OK"; Code="migration_rollback_mock_missing" },
    [pscustomobject]@{ File=$realPayload; Value="WINDOWS_ROOT_LEVEL_PAYLOAD_PARENT_OK"; Code="root_level_payload_parent_test_missing" },
    [pscustomobject]@{ File=$realPayload; Value="WINDOWS_NESTED_TEMPORARY_PAYLOAD_PATH_OK"; Code="nested_temporary_payload_test_missing" },
    [pscustomobject]@{ File=$realPayload; Value="WINDOWS_PAYLOAD_PATH_WITH_SPACES_OK"; Code="payload_spaces_test_missing" },
    [pscustomobject]@{ File=$realPayload; Value="WINDOWS_PAYLOAD_PATH_TRAVERSAL_REJECTED_OK"; Code="payload_traversal_real_test_missing" },
    [pscustomobject]@{ File=$realPayload; Value="REAL_PACKAGE_STAGING_ROOT_OK"; Code="root_real_payload_staging_missing" },
    [pscustomobject]@{ File=$realPayload; Value="REAL_PACKAGE_STAGING_NESTED_OK"; Code="nested_real_payload_staging_missing" },
    [pscustomobject]@{ File=$realPayload; Value="REAL_PACKAGE_STAGING_OK"; Code="real_payload_staging_test_missing" },
    [pscustomobject]@{ File=$realPayload; Value="REAL_PACKAGE_COMPOSE_CONFIG_OK"; Code="real_payload_compose_test_missing" },
    [pscustomobject]@{ File=$validate; Value="WINDOWS_REAL_PAYLOAD_STAGING_VALIDATION_OK"; Code="real_payload_validation_closure_missing" },
    [pscustomobject]@{ File=$validate; Value="WINDOWS_ROOT_PARENT_FIX_VALIDATION_OK"; Code="root_parent_validation_closure_missing" }
)) {
    Require-Text -File $contract.File -Value $contract.Value -Code $contract.Code
}

Forbid-Text -File $storage -Value '$parent = Split-Path $install -Parent' -Code "provider_root_parent_resolution_forbidden"
Forbid-Text -File $common -Value "2>&1 | Out-String" -Code "native_pipeline_forbidden"
Forbid-Text -File $compose -Value 'source: ${DATA_VOLUME' -Code "dynamic_logical_volume_forbidden"
Forbid-Text -File $compose -Value "network_mode:" -Code "host_network_forbidden"


$prerequisites = Join-Path (Split-Path $WindowsRoot -Parent) "PREREQUISITES.md"
$installersReadme = Join-Path (Split-Path $WindowsRoot -Parent) "README.md"
$windowsReadme = Join-Path $WindowsRoot "README.md"
foreach ($documentContract in @(
    [pscustomobject]@{ File=$prerequisites; Value="Windows 11 AMD64/x86-64"; Code="central_windows_amd64_prerequisites_missing" },
    [pscustomobject]@{ File=$prerequisites; Value="Linux x86_64/amd64 y arm64/aarch64"; Code="central_linux_architectures_missing" },
    [pscustomobject]@{ File=$prerequisites; Value="WSL 2.1.5"; Code="central_wsl_requirement_missing" },
    [pscustomobject]@{ File=$windowsReadme; Value="ARM64"; Code="windows_arm64_scope_missing" },
    [pscustomobject]@{ File=$installersReadme; Value="../install.sh"; Code="linux_entrypoint_link_missing" }
)) {
    Require-Text -File $documentContract.File -Value $documentContract.Value -Code $documentContract.Code
}

if ($errors.Count -gt 0) {
    $errors | ForEach-Object { Write-Host $_ -ForegroundColor Red }
    throw ("Contratos fallidos: {0}" -f $errors.Count)
}
Write-Host "WINDOWS_STORAGE_REWRITE_CONTRACTS_OK" -ForegroundColor Green
Write-Host "WINDOWS_PLATFORM_PREREQUISITES_CONTRACTS_OK" -ForegroundColor Green
