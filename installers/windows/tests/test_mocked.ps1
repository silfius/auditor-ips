[CmdletBinding()]
param([string]$WindowsRoot = "")

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") {
    Write-Host "WINDOWS_MOCKED_TESTS_SKIPPED_NON_WINDOWS"
    exit 0
}
if (-not $WindowsRoot) { $WindowsRoot = Split-Path $PSScriptRoot -Parent }

. (Join-Path $WindowsRoot "common.ps1")
. (Join-Path $WindowsRoot "storage.ps1")
$hostExe = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName

function Invoke-TestPowerShell {
    param([string]$ScriptPath, [string[]]$Arguments = @())
    return Invoke-AuditorNative -FilePath $hostExe -Arguments (@(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath
    ) + $Arguments) -AllowFailure -Quiet
}

function New-TestInputProvider {
    param([string[]]$Answers)
    $queue = New-Object 'System.Collections.Generic.Queue[string]'
    foreach ($answer in $Answers) { $queue.Enqueue($answer) }
    return {
        param($Prompt)
        if ($queue.Count -eq 0) { throw ("test_input_exhausted:{0}" -f $Prompt) }
        return $queue.Dequeue()
    }.GetNewClosure()
}

function Invoke-QuietSimulation {
    param([scriptblock]$Action)
    return & $Action 6>$null
}

function New-TestSourceRepository {
    param([string]$Path)
    [void](New-Item -ItemType Directory -Path (Join-Path $Path "app") -Force)
    [void](New-Item -ItemType Directory -Path (Join-Path $Path "installers\windows") -Force)
    Copy-Item -Path (Join-Path $WindowsRoot "*") -Destination (Join-Path $Path "installers\windows") -Recurse -Force
    Set-Content -LiteralPath (Join-Path $Path "app\dockerfile") -Value "FROM scratch" -Encoding ASCII
    Set-Content -LiteralPath (Join-Path $Path "README.md") -Value "test" -Encoding UTF8
}

function New-CurrentInstallation {
    param([string]$Path, [string]$Marker)
    New-TestSourceRepository -Path $Path
    $exports = Join-Path $Path "exports"
    $backups = Join-Path $Path "backups"
    $diagnostics = Join-Path $Path "diagnostics"
    [void](New-Item -ItemType Directory -Path $exports, $backups, $diagnostics -Force)
    Set-Content -LiteralPath (Join-Path $exports "existing-export.txt") -Value $Marker -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $backups "existing-backup.txt") -Value $Marker -Encoding UTF8
    Set-Content -LiteralPath (Join-Path $diagnostics "existing-diagnostic.txt") -Value $Marker -Encoding UTF8
    $envText = @"
COMPOSE_PROJECT_NAME=auditor_ips
AUDITOR_CONTAINER_NAME=auditor_ips
AUDITOR_INSTANCE_ID=current_instance
SESSION_COOKIE_NAME=auditor_ips_current
PORT=59991
DB_PATH=/data/auditor.db
DATA_VOLUME=auditor_ips_data
EXPORTS_HOST_DIR=./exports
BACKUPS_HOST_DIR=./backups
DIAGNOSTICS_HOST_DIR=./diagnostics
TLS_CERT_IP=192.168.50.20
TLS_CERT_DNS=auditips.local
SERVER_IP=192.168.50.20
SCAN_CIDR=192.168.50.0/24
DISCORD_WEBHOOK_URL=https://example.invalid/secret
"@
    Write-Utf8NoBom -Path (Join-Path $Path ".env") -Text ($envText.TrimStart())
    Write-Utf8NoBom -Path (Join-Path $Path "docker-compose.yml") -Text ([System.IO.File]::ReadAllText((Join-Path $WindowsRoot "docker-compose.windows.yml.example")))
}

function Get-LogText {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return "" }
    return [System.IO.File]::ReadAllText($Path)
}

# Windows platform and architecture contracts.
$nativePlatform = Get-AuditorWindowsPlatformInfo
[void](Assert-AuditorWindows11Amd64 -PlatformInfo $nativePlatform)
Write-Host ("WINDOWS_PLATFORM_NATIVE={0}|{1}|{2}|{3}" -f `
    $nativePlatform.Build,
    $nativePlatform.RuntimeArchitecture,
    $nativePlatform.EnvironmentArchitecture,
    $nativePlatform.ProcessorArchitecture
)
Write-Host "WINDOWS_PLATFORM_NATIVE_OK"

$amd64Platform = [pscustomobject]@{
    IsWindows = $true
    Build = 22631
    Is64BitOperatingSystem = $true
    RuntimeArchitecture = "X64"
    EnvironmentArchitecture = "X64"
    ProcessorArchitecture = "X64"
}
[void](Assert-AuditorWindows11Amd64 -PlatformInfo $amd64Platform)
Write-Host "WINDOWS_PLATFORM_AMD64_OK"

$arm64Rejected = $false
try {
    [void](Assert-AuditorWindows11Amd64 -PlatformInfo ([pscustomobject]@{
        IsWindows = $true
        Build = 26100
        Is64BitOperatingSystem = $true
        RuntimeArchitecture = "ARM64"
        EnvironmentArchitecture = "ARM64"
        ProcessorArchitecture = "ARM64"
    }))
} catch {
    $arm64Rejected = ($_.Exception.Message -match "AMD64/x86-64")
}
if (-not $arm64Rejected) { throw "windows_arm64_was_not_rejected" }
Write-Host "WINDOWS_PLATFORM_ARM64_REJECTED_OK"

$mismatchRejected = $false
try {
    [void](Assert-AuditorWindows11Amd64 -PlatformInfo ([pscustomobject]@{
        IsWindows = $true
        Build = 26100
        Is64BitOperatingSystem = $true
        RuntimeArchitecture = "X64"
        EnvironmentArchitecture = "X64"
        ProcessorArchitecture = "ARM64"
    }))
} catch {
    $mismatchRejected = ($_.Exception.Message -match "Arquitectura no compatible")
}
if (-not $mismatchRejected) { throw "windows_architecture_mismatch_was_not_rejected" }
Write-Host "WINDOWS_PLATFORM_MISMATCH_REJECTED_OK"

$oldBuildRejected = $false
try {
    [void](Assert-AuditorWindows11Amd64 -PlatformInfo ([pscustomobject]@{
        IsWindows = $true
        Build = 22000
        Is64BitOperatingSystem = $true
        RuntimeArchitecture = "X64"
        EnvironmentArchitecture = "X64"
        ProcessorArchitecture = "X64"
    }))
} catch {
    $oldBuildRejected = ($_.Exception.Message -match "22631")
}
if (-not $oldBuildRejected) { throw "windows_old_build_was_not_rejected" }
Write-Host "WINDOWS_PLATFORM_BUILD_REJECTED_OK"

# Pure network contracts.
$network24 = Get-AuditorIPv4NetworkInfo -IpAddress "192.168.50.20" -PrefixLength 24
if ($network24.Cidr -ne "192.168.50.0/24" -or $network24.Mask -ne "255.255.255.0") { throw "network_math_failed" }
$ethernet = New-AuditorIPv4Candidate -InterfaceAlias "Ethernet" -IpAddress "192.168.50.20" -PrefixLength 24 -Gateway "192.168.50.1" -Profile "Private" -InterfaceMetric 10 -Virtual:$false
$virtual = New-AuditorIPv4Candidate -InterfaceAlias "vEthernet (WSL)" -IpAddress "172.30.0.1" -PrefixLength 20 -Profile "Private" -InterfaceMetric 5 -Virtual:$true
$sorted = @(Sort-AuditorIPv4Candidates -Candidates @($virtual, $ethernet))
if ($sorted[0].InterfaceAlias -ne "Ethernet") { throw "network_ranking_failed" }
$provider = New-TestInputProvider -Answers @("3", "si", "10.20.30.40")
$manual = Invoke-QuietSimulation -Action { Select-AuditorServerNetwork -Candidates $sorted -InputProvider $provider }
if ($manual.IpAddress -ne "10.20.30.40") { throw "network_retry_failed" }
Write-Host "NETWORK_ASSISTANT_SIMULATION_OK"
Write-Host "HOST_NETWORK_DISCOVERY_BEGIN"
$nativeCandidates = @(Get-AuditorIPv4Candidates)
Write-Host ("NETWORK_DISCOVERY_CANDIDATES={0}" -f $nativeCandidates.Count)
foreach ($candidate in $nativeCandidates) {
    Write-Host ("NETWORK_DISCOVERY_ITEM={0}|{1}|{2}|{3}|{4}" -f $candidate.InterfaceAlias, $candidate.IpAddress, $candidate.Cidr, $candidate.ProfileLabel, $candidate.Recommended)
}
if ($nativeCandidates.Count -eq 0) { Write-Host "NETWORK_DISCOVERY_FALLBACK=MANUAL_INPUT" }
Write-Host "HOST_NETWORK_DISCOVERY_END"

# Root-parent and payload-path contracts without touching the E: drive.
$rootParent = Get-AuditorInstallationParentPath -InstallRoot "E:\AuditorIps_Automate"
if ($rootParent -ne "E:\") { throw ("windows_root_parent_resolution_failed:{0}" -f $rootParent) }
$nestedParent = Get-AuditorInstallationParentPath -InstallRoot "E:\Applications\Auditor Ips"
if ($nestedParent -ne "E:\Applications") { throw ("windows_nested_parent_resolution_failed:{0}" -f $nestedParent) }
$safeUnicode = Resolve-AuditorPayloadDestinationPath `
    -DestinationRoot "E:\Auditor Stage" `
    -RelativePath "docs\Manual con espacios y ünicode.md"
if ($safeUnicode -ne "E:\Auditor Stage\docs\Manual con espacios y ünicode.md") {
    throw ("windows_payload_unicode_path_failed:{0}" -f $safeUnicode)
}
foreach ($unsafe in @("..\escape.txt", "\rooted.txt", "C:\absolute.txt")) {
    $rejected = $false
    try {
        [void](Resolve-AuditorPayloadDestinationPath `
            -DestinationRoot "E:\Auditor Stage" -RelativePath $unsafe)
    } catch {
        $rejected = $true
    }
    if (-not $rejected) { throw ("windows_payload_unsafe_path_accepted:{0}" -f $unsafe) }
}
Write-Host "WINDOWS_ROOT_PARENT_RESOLUTION_OK"
Write-Host "WINDOWS_PAYLOAD_SAFE_RELATIVE_PATHS_OK"
Write-Host "WINDOWS_PAYLOAD_PATH_TRAVERSAL_REJECTED_MOCK_OK"

# Pure storage contracts on a stable local user path.
$validationBase = Join-Path $env:LOCALAPPDATA ("AuditorIPsValidation-" + [Guid]::NewGuid().ToString("N"))
$assistantRoot = Join-Path $validationBase "assistant"
$assistantDefaults = Get-AuditorDefaultStorageConfiguration -InstallRoot $assistantRoot
$storageProvider = New-TestInputProvider -Answers @(
    $assistantRoot,
    (Join-Path $assistantRoot "exports"),
    "",
    "",
    ""
)
$assistantStorage = Invoke-QuietSimulation -Action {
    Resolve-AuditorStorageConfiguration -InputProvider $storageProvider
}
if ($assistantStorage.InstallRoot -ne [System.IO.Path]::GetFullPath($assistantRoot)) { throw "storage_assistant_install_path_failed" }
if ($assistantStorage.ExportsRoot -ne $assistantDefaults.ExportsRoot -or
    $assistantStorage.BackupsRoot -ne $assistantDefaults.BackupsRoot -or
    $assistantStorage.DiagnosticsRoot -ne $assistantDefaults.DiagnosticsRoot) {
    throw "storage_dynamic_defaults_failed"
}
if (Test-AuditorPathWithin -Path $assistantStorage.ExportsRoot -Parent $assistantStorage.InstallRoot) {
    throw "storage_nested_path_retry_failed"
}
$nonInteractiveStorage = Resolve-AuditorStorageConfiguration `
    -InstallRoot $assistantRoot -NonInteractive
if ($nonInteractiveStorage.ExportsRoot -ne $assistantDefaults.ExportsRoot -or
    $nonInteractiveStorage.BackupsRoot -ne $assistantDefaults.BackupsRoot -or
    $nonInteractiveStorage.DiagnosticsRoot -ne $assistantDefaults.DiagnosticsRoot) {
    throw "storage_noninteractive_dynamic_defaults_failed"
}
if (-not (Test-AuditorVolatilePath -Path "C:\TEMP\AuditorIPs")) { throw "volatile_path_detection_failed" }
if ((ConvertTo-AuditorComposeHostPath -Path $assistantStorage.ExportsRoot) -match '\\') { throw "compose_path_normalization_failed" }
$preserved = Update-AuditorEnvText -Text "SECRET_TOKEN=keep`nEXPORTS_HOST_DIR=old`n" -Values @{ EXPORTS_HOST_DIR = "C:/new" }
if ($preserved -notmatch 'SECRET_TOKEN=keep' -or $preserved -notmatch 'EXPORTS_HOST_DIR=C:/new') { throw "env_update_preservation_failed" }
Write-Host "STORAGE_DYNAMIC_DEFAULTS_OK"
Write-Host "STORAGE_NESTED_PATH_RETRY_OK"
Write-Host "STORAGE_NONINTERACTIVE_DYNAMIC_DEFAULTS_OK"
Write-Host "STORAGE_ASSISTANT_SIMULATION_OK"

$tempRoot = Join-Path $env:LOCALAPPDATA ("AuditorIPsNativeMock-" + [Guid]::NewGuid().ToString("N"))
$bin = Join-Path $tempRoot "bin"
$log = Join-Path $tempRoot "native.log"
[void](New-Item -ItemType Directory -Path $bin -Force)

$nativeSource = @'
using System;
using System.IO;

public static class FakeNative {
    public static int Main(string[] args) {
        string exe = Path.GetFileNameWithoutExtension(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName).ToLowerInvariant();
        string joined = String.Join(" ", args);
        string cwd = Environment.CurrentDirectory;
        string log = Environment.GetEnvironmentVariable("AUDITOR_FAKE_LOG");
        if (!String.IsNullOrEmpty(log)) File.AppendAllText(log, cwd + "|" + exe + " " + joined + Environment.NewLine);
        if (exe == "curl") { Console.WriteLine("{\"ok\":true,\"status\":\"ok\"}"); return 0; }
        if (joined.StartsWith("compose version")) { Console.WriteLine("5.3.0"); return 0; }
        if (joined.StartsWith("version --format")) { Console.WriteLine("linux"); return 0; }
        if (joined == "info --format {{.KernelVersion}}") { Console.WriteLine("6.18.0-microsoft-standard-WSL2"); return 0; }
        if (joined == "info --format {{.ServerVersion}}") { Console.WriteLine("99.0"); return 0; }
        if (joined.StartsWith("inspect auditor_ips")) { Console.WriteLine(Environment.GetEnvironmentVariable("AUDITOR_FAKE_CURRENT_ROOT") ?? ""); return 0; }
        if (joined.StartsWith("ps -a")) {
            if (Environment.GetEnvironmentVariable("AUDITOR_FAKE_CONTAINER_PRESENT") == "1") Console.WriteLine("fake-container-id");
            return 0;
        }
        if (joined.StartsWith("volume inspect")) {
            if (Environment.GetEnvironmentVariable("AUDITOR_FAKE_VOLUME_PRESENT") == "1") {
                if (!String.IsNullOrEmpty(log) && File.Exists(log) && File.ReadAllText(log).Contains("volume rm auditor_ips_data")) return 1;
                return 0;
            }
            return 1;
        }
        if (joined.StartsWith("volume rm")) return 0;
        if (joined.Contains("config --quiet")) return 0;
        if (joined.StartsWith("compose config --no-interpolate")) { Console.WriteLine("API_TOKEN: MOCK_SECRET"); return 0; }
        if (joined.StartsWith("compose config")) return 0;
        if (joined.StartsWith("compose up")) {
            Console.Error.WriteLine("normal docker progress on stderr");
            string fail = Environment.GetEnvironmentVariable("AUDITOR_FAKE_FAIL_TARGET_ROOT");
            if (!String.IsNullOrEmpty(fail) && String.Equals(Path.GetFullPath(fail).TrimEnd('\\'), Path.GetFullPath(cwd).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) return 17;
            return 0;
        }
        if (joined.Contains("openssl x509")) {
            Console.WriteLine("DNS:localhost, DNS:auditips.local, IP Address:127.0.0.1, IP Address:192.168.50.20");
            return 0;
        }
        if (joined.StartsWith("compose logs")) { Console.WriteLine("API_TOKEN=MOCK_SECRET"); return 0; }
        if (joined.StartsWith("compose ps") || joined.StartsWith("compose down")) return 0;
        if (joined == "version" || joined == "info") { Console.WriteLine("fake docker"); return 0; }
        Console.Error.WriteLine("unexpected fake command: " + joined);
        return 91;
    }
}
'@
$sourcePath = Join-Path $tempRoot "fake.cs"
$compilePath = Join-Path $tempRoot "compile.ps1"
$dockerExe = Join-Path $bin "docker.exe"
$curlExe = Join-Path $bin "curl.exe"
Write-Utf8NoBom -Path $sourcePath -Text $nativeSource
Write-Utf8NoBom -Path $compilePath -Text @'
param([string]$SourcePath,[string]$OutputPath)
$ErrorActionPreference="Stop"
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($SourcePath)) -Language CSharp -OutputAssembly $OutputPath -OutputType ConsoleApplication
'@
$compile = Invoke-AuditorNative -FilePath "powershell.exe" -Arguments @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $compilePath,
    "-SourcePath", $sourcePath, "-OutputPath", $dockerExe
) -AllowFailure -Quiet
if ($compile.ExitCode -ne 0) { throw ("fake_native_compile_failed:`n" + $compile.StdErr) }
Copy-Item -LiteralPath $dockerExe -Destination $curlExe -Force

$old = @{
    PATH = $env:PATH
    LOG = $env:AUDITOR_FAKE_LOG
    CONTAINER = $env:AUDITOR_FAKE_CONTAINER_PRESENT
    VOLUME = $env:AUDITOR_FAKE_VOLUME_PRESENT
    CURRENT = $env:AUDITOR_FAKE_CURRENT_ROOT
    FAIL = $env:AUDITOR_FAKE_FAIL_TARGET_ROOT
}
try {
    $env:PATH = $bin + ";" + $env:PATH
    $env:AUDITOR_FAKE_LOG = $log
    $env:AUDITOR_FAKE_VOLUME_PRESENT = "1"
    $env:AUDITOR_FAKE_CONTAINER_PRESENT = $null
    $env:AUDITOR_FAKE_CURRENT_ROOT = $null
    $env:AUDITOR_FAKE_FAIL_TARGET_ROOT = $null

    # Fresh permanent installation.
    $sourceRepo = Join-Path $tempRoot "source package"
    New-TestSourceRepository -Path $sourceRepo
    $freshRoot = Join-Path $validationBase "fresh-install"
    $freshData = Join-Path $validationBase "fresh-data"
    $port = 0
    foreach ($candidate in 55000..59900 | Sort-Object { Get-Random }) {
        if (Test-TcpPortFree -Port $candidate) { $port = $candidate; break }
    }
    if (-not $port) { throw "no_free_port" }
    $fresh = Invoke-TestPowerShell -ScriptPath (Join-Path $WindowsRoot "install.ps1") -Arguments @(
        "-RepositoryRoot", $sourceRepo,
        "-InstallRoot", $freshRoot,
        "-ExportsRoot", (Join-Path $freshData "exports"),
        "-BackupsRoot", (Join-Path $freshData "backups"),
        "-DiagnosticsRoot", (Join-Path $freshData "diagnostics"),
        "-ServerIp", "192.168.50.20", "-ScanCidr", "192.168.50.0/24",
        "-Port", ([string]$port), "-DnsName", "auditips.local",
        "-Yes", "-SkipBindMountValidation"
    )
    if ($fresh.ExitCode -ne 0) { throw ("fresh_install_failed:`n" + $fresh.StdOut + "`n" + $fresh.StdErr) }
    foreach ($required in @(".env", "docker-compose.yml", ".auditor-ips-windows-state.json", "app\dockerfile", "installers\windows\migrate-installation.ps1")) {
        if (-not (Test-Path -LiteralPath (Join-Path $freshRoot $required) -PathType Leaf)) { throw ("fresh_missing:" + $required) }
    }
    if (Test-Path -LiteralPath (Join-Path $freshRoot ".auditor-install-owner")) { throw "fresh_owner_marker_leaked" }
    if (Test-Path -LiteralPath (Join-Path $sourceRepo ".env")) { throw "source_package_modified" }
    $freshEnv = [System.IO.File]::ReadAllText((Join-Path $freshRoot ".env"))
    if ($freshEnv -notmatch 'EXPORTS_HOST_DIR=[A-Za-z]:/' -or $freshEnv -match 'EXPORTS_HOST_DIR=\.\/exports') { throw "fresh_absolute_bind_paths_missing" }
    $freshState = Get-Content -LiteralPath (Join-Path $freshRoot ".auditor-ips-windows-state.json") -Raw | ConvertFrom-Json
    if ($freshState.schema_version -ne 2 -or $freshState.installation_root -ne $freshRoot) { throw "fresh_state_invalid" }
    Write-Host "FRESH_PERMANENT_INSTALL_MOCK_OK"

    # Diagnostics must use the configured external path.
    $diag = Invoke-TestPowerShell -ScriptPath (Join-Path $freshRoot "installers\windows\diagnose.ps1") -Arguments @("-RepositoryRoot", $freshRoot)
    if ($diag.ExitCode -ne 0) { throw "diagnose_external_path_failed" }
    if (@(Get-ChildItem -LiteralPath (Join-Path $freshData "diagnostics") -Filter "auditor-ips-diagnostic-*.zip").Count -lt 1) { throw "diagnostic_zip_not_external" }

    # Migration success with automatic current-root detection.
    $current = Join-Path $tempRoot "current R4 installation"
    New-CurrentInstallation -Path $current -Marker "success"
    $migrationRoot = Join-Path $validationBase "migrated-install"
    $migrationData = Join-Path $validationBase "migrated-data"
    $env:AUDITOR_FAKE_CONTAINER_PRESENT = "1"
    $env:AUDITOR_FAKE_CURRENT_ROOT = $current
    $migrate = Invoke-TestPowerShell -ScriptPath (Join-Path $WindowsRoot "migrate-installation.ps1") -Arguments @(
        "-RepositoryRoot", $sourceRepo,
        "-InstallRoot", $migrationRoot,
        "-ExportsRoot", (Join-Path $migrationData "exports"),
        "-BackupsRoot", (Join-Path $migrationData "backups"),
        "-DiagnosticsRoot", (Join-Path $migrationData "diagnostics"),
        "-Yes", "-SkipBindMountValidation"
    )
    if ($migrate.ExitCode -ne 0) { throw ("migration_success_failed:`n" + $migrate.StdOut + "`n" + $migrate.StdErr) }
    if (-not (Test-Path -LiteralPath (Join-Path $migrationData "exports\existing-export.txt"))) { throw "migration_exports_not_copied" }
    if (-not (Test-Path -LiteralPath (Join-Path $current ".auditor-ips-migrated-to.txt"))) { throw "migration_source_marker_missing" }
    $migratedEnv = [System.IO.File]::ReadAllText((Join-Path $migrationRoot ".env"))
    if ($migratedEnv -notmatch 'DISCORD_WEBHOOK_URL=https://example.invalid/secret') { throw "migration_secret_not_preserved" }
    if ($migratedEnv -match 'EXPORTS_HOST_DIR=\.\/exports') { throw "migration_bind_path_not_updated" }
    $migrationState = Get-Content -LiteralPath (Join-Path $migrationRoot ".auditor-ips-windows-state.json") -Raw | ConvertFrom-Json
    if ($migrationState.migrated_from -ne $current) { throw "migration_state_source_missing" }
    Write-Host "MIGRATION_SUCCESS_MOCK_OK"

    # Migration failure must remove the target and restore the source runtime.
    $rollbackCurrent = Join-Path $tempRoot "rollback R4 installation"
    New-CurrentInstallation -Path $rollbackCurrent -Marker "rollback"
    $rollbackRoot = Join-Path $validationBase "rollback-target"
    $rollbackData = Join-Path $validationBase "rollback-data"
    $env:AUDITOR_FAKE_CURRENT_ROOT = $rollbackCurrent
    $env:AUDITOR_FAKE_FAIL_TARGET_ROOT = $rollbackRoot
    $beforeRollback = (Get-LogText -Path $log).Length
    $rollback = Invoke-TestPowerShell -ScriptPath (Join-Path $WindowsRoot "migrate-installation.ps1") -Arguments @(
        "-RepositoryRoot", $sourceRepo,
        "-InstallRoot", $rollbackRoot,
        "-ExportsRoot", (Join-Path $rollbackData "exports"),
        "-BackupsRoot", (Join-Path $rollbackData "backups"),
        "-DiagnosticsRoot", (Join-Path $rollbackData "diagnostics"),
        "-Yes", "-SkipBindMountValidation"
    )
    if ($rollback.ExitCode -eq 0) { throw "migration_failure_was_accepted" }
    if (Test-Path -LiteralPath $rollbackRoot) { throw "failed_migration_target_not_removed" }
    if (Test-Path -LiteralPath (Join-Path $rollbackCurrent ".auditor-ips-migrated-to.txt")) { throw "failed_migration_source_marked" }
    $delta = (Get-LogText -Path $log).Substring($beforeRollback)
    $sourceUp = $rollbackCurrent + "|docker compose up -d --remove-orphans"
    if (-not $delta.Contains($sourceUp)) { throw "source_runtime_not_restored" }
    Write-Host "MIGRATION_ROLLBACK_MOCK_OK"

    # Uninstall preserves external folders and can explicitly purge the volume.
    $env:AUDITOR_FAKE_CONTAINER_PRESENT = $null
    $env:AUDITOR_FAKE_FAIL_TARGET_ROOT = $null
    $uninstall = Invoke-TestPowerShell -ScriptPath (Join-Path $freshRoot "installers\windows\uninstall.ps1") -Arguments @("-RepositoryRoot", $freshRoot, "-Yes")
    if ($uninstall.ExitCode -ne 0) { throw "uninstall_preserve_failed" }
    if (-not (Test-Path -LiteralPath (Join-Path $freshData "exports"))) { throw "external_exports_removed" }
    $purge = Invoke-TestPowerShell -ScriptPath (Join-Path $freshRoot "installers\windows\uninstall.ps1") -Arguments @("-RepositoryRoot", $freshRoot, "-PurgeData", "-Yes")
    if ($purge.ExitCode -ne 0) { throw "uninstall_purge_failed" }

    Write-Host "WINDOWS_STORAGE_REWRITE_MOCKED_OK" -ForegroundColor Green
    Write-Host "WINDOWS_PLATFORM_PREREQUISITES_MOCKED_OK" -ForegroundColor Green
} finally {
    $env:PATH = $old.PATH
    $env:AUDITOR_FAKE_LOG = $old.LOG
    $env:AUDITOR_FAKE_CONTAINER_PRESENT = $old.CONTAINER
    $env:AUDITOR_FAKE_VOLUME_PRESENT = $old.VOLUME
    $env:AUDITOR_FAKE_CURRENT_ROOT = $old.CURRENT
    $env:AUDITOR_FAKE_FAIL_TARGET_ROOT = $old.FAIL
    Remove-Item -LiteralPath $tempRoot, $validationBase -Recurse -Force -ErrorAction SilentlyContinue
}
