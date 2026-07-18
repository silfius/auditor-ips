[CmdletBinding()]
param(
    [string]$CurrentRoot = "",
    [string]$RepositoryRoot = "",
    [string]$InstallRoot = "",
    [string]$ExportsRoot = "",
    [string]$BackupsRoot = "",
    [string]$DiagnosticsRoot = "",
    [switch]$Yes,
    [switch]$NoBuild,
    [switch]$SkipBindMountValidation
)

. (Join-Path $PSScriptRoot "common.ps1")
. (Join-Path $PSScriptRoot "storage.ps1")
Initialize-AuditorConsole

$PackageRoot = Get-AuditorRepositoryRoot -Override $RepositoryRoot
$storage = $null
$stage = $null
$targetRoot = ""
$sourceStopped = $false
$targetRuntimeAttempted = $false
$currentEnv = @{}
$currentEnvText = ""
$serverIp = ""
$scanCidr = ""
$dnsName = "auditips.local"
$port = 9909
$dataVolume = "auditor_ips_data"
$currentStorage = $null

function Get-RequiredEnvValue {
    param([string]$Key, [string]$Default = "")
    if ($currentEnv.ContainsKey($Key) -and -not [string]::IsNullOrWhiteSpace([string]$currentEnv[$Key])) {
        return [string]$currentEnv[$Key]
    }
    if ($Default) { return $Default }
    throw ("La instalación actual no contiene {0} en .env." -f $Key)
}

function Assert-MigrationPreflight {
    Write-AuditorSection "Preflight de reubicación"
    $platform = Assert-AuditorWindows11Amd64
    Write-AuditorOk ("Windows 11 AMD64 · build {0}" -f $platform.Build)
    foreach ($command in @("docker.exe", "curl.exe")) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw ("Dependencia ausente: {0}" -f $command)
        }
    }
    Invoke-AuditorNative -FilePath "docker.exe" -Arguments @(
        "info", "--format", "{{.ServerVersion}}"
    ) -Quiet | Out-Null

    if (-not $script:CurrentRoot) {
        $script:CurrentRoot = Get-AuditorComposeWorkingDirectory
    }
    $script:CurrentRoot = [System.IO.Path]::GetFullPath($script:CurrentRoot)
    foreach ($required in @(
        (Join-Path $CurrentRoot ".env"),
        (Join-Path $CurrentRoot "docker-compose.yml"),
        (Join-Path $CurrentRoot "app\dockerfile")
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw ("La instalación activa está incompleta: {0}" -f $required)
        }
    }

    $container = Invoke-AuditorNative -FilePath "docker.exe" -Arguments @(
        "ps", "-a", "--filter", "name=^/auditor_ips$", "--format", "{{.ID}}"
    ) -Quiet
    if (-not $container.StdOut.Trim()) {
        throw "No existe el contenedor auditor_ips que debe reubicarse."
    }
    Write-AuditorOk ("Instalación activa detectada: {0}" -f $CurrentRoot)
}

function Read-CurrentConfiguration {
    $envPath = Join-Path $CurrentRoot ".env"
    $script:currentEnvText = [System.IO.File]::ReadAllText($envPath)
    $script:currentEnv = Read-AuditorEnv -Path $envPath
    $script:serverIp = Get-RequiredEnvValue -Key "SERVER_IP"
    $script:scanCidr = Get-RequiredEnvValue -Key "SCAN_CIDR"
    $script:dnsName = Get-RequiredEnvValue -Key "TLS_CERT_DNS" -Default "auditips.local"
    $portText = Get-RequiredEnvValue -Key "PORT" -Default "9909"
    $parsedPort = 0
    if (-not [int]::TryParse($portText, [ref]$parsedPort) -or $parsedPort -lt 1 -or $parsedPort -gt 65535) {
        throw ("Puerto inválido en la instalación actual: {0}" -f $portText)
    }
    $script:port = $parsedPort
    $script:dataVolume = Get-RequiredEnvValue -Key "DATA_VOLUME" -Default "auditor_ips_data"
    if ($dataVolume -ne "auditor_ips_data") {
        throw ("Volumen no reconocido; se rechaza la migración automática: {0}" -f $dataVolume)
    }
    $containerName = Get-RequiredEnvValue -Key "AUDITOR_CONTAINER_NAME" -Default "auditor_ips"
    if ($containerName -ne "auditor_ips") {
        throw ("Contenedor no reconocido: {0}" -f $containerName)
    }

    $script:currentStorage = [pscustomobject]@{
        ExportsRoot = (Resolve-AuditorHostPathFromEnv -RepositoryRoot $CurrentRoot -Value (Get-RequiredEnvValue -Key "EXPORTS_HOST_DIR" -Default "./exports"))
        BackupsRoot = (Resolve-AuditorHostPathFromEnv -RepositoryRoot $CurrentRoot -Value (Get-RequiredEnvValue -Key "BACKUPS_HOST_DIR" -Default "./backups"))
        DiagnosticsRoot = (Resolve-AuditorHostPathFromEnv -RepositoryRoot $CurrentRoot -Value (Get-RequiredEnvValue -Key "DIAGNOSTICS_HOST_DIR" -Default "./diagnostics"))
    }
    Assert-IPv4Address -Value $serverIp -Name "SERVER_IP"
    Assert-IPv4Cidr -Value $scanCidr
    Assert-DnsName -Value $dnsName
}

function Resolve-TargetStorage {
    $script:storage = Resolve-AuditorStorageConfiguration `
        -InstallRoot $InstallRoot `
        -ExportsRoot $ExportsRoot `
        -BackupsRoot $BackupsRoot `
        -DiagnosticsRoot $DiagnosticsRoot `
        -NonInteractive:$Yes
    Assert-AuditorNewInstallationRoot -SourceRoot $PackageRoot -InstallRoot $storage.InstallRoot
    if (Test-AuditorPathWithin -Path $storage.InstallRoot -Parent $CurrentRoot) {
        throw "La instalación permanente no puede ubicarse dentro de la instalación temporal actual."
    }
}

function Show-MigrationSummary {
    Write-AuditorSection "Resumen de la reubicación"
    Write-Host ("  Instalación actual:     {0}" -f $CurrentRoot)
    Write-Host ("  Instalación permanente: {0}" -f $storage.InstallRoot)
    Write-Host ("  Exportaciones actuales: {0}" -f $currentStorage.ExportsRoot)
    Write-Host ("  Exportaciones nuevas:   {0}" -f $storage.ExportsRoot)
    Write-Host ("  Backups actuales:       {0}" -f $currentStorage.BackupsRoot)
    Write-Host ("  Backups nuevos:         {0}" -f $storage.BackupsRoot)
    Write-Host ("  Diagnósticos actuales:  {0}" -f $currentStorage.DiagnosticsRoot)
    Write-Host ("  Diagnósticos nuevos:    {0}" -f $storage.DiagnosticsRoot)
    Write-Host ("  Volumen reutilizado:    {0}" -f $dataVolume)
    Write-Host ("  URL conservada:         https://{0}:{1}/login" -f $serverIp, $port)
    Write-AuditorWarning "El contenedor se detendrá brevemente durante el cambio. La instalación actual se conservará para rollback."
    if ($Yes) { return }
    $answer = Read-Host "Escribe MIGRAR para continuar"
    if ($answer -cne "MIGRAR") { throw "Operación cancelada por el usuario." }
}

function Copy-PersistentContent {
    Write-AuditorSection "Copia verificada de contenido persistente"
    Initialize-AuditorStorageDirectories -Storage $storage
    Copy-AuditorDirectoryContentVerified -Source $currentStorage.ExportsRoot -Destination $storage.ExportsRoot
    Write-AuditorOk "Exportaciones copiadas y verificadas"
    Copy-AuditorDirectoryContentVerified -Source $currentStorage.BackupsRoot -Destination $storage.BackupsRoot
    Write-AuditorOk "Backups copiados y verificados"
    Copy-AuditorDirectoryContentVerified -Source $currentStorage.DiagnosticsRoot -Destination $storage.DiagnosticsRoot
    Write-AuditorOk "Diagnósticos copiados y verificados"
}

function Write-TargetConfiguration {
    $values = @{
        EXPORTS_HOST_DIR = ConvertTo-AuditorComposeHostPath -Path $storage.ExportsRoot
        BACKUPS_HOST_DIR = ConvertTo-AuditorComposeHostPath -Path $storage.BackupsRoot
        DIAGNOSTICS_HOST_DIR = ConvertTo-AuditorComposeHostPath -Path $storage.DiagnosticsRoot
        DATA_VOLUME = $dataVolume
        AUDITOR_CONTAINER_NAME = "auditor_ips"
        COMPOSE_PROJECT_NAME = "auditor_ips"
    }
    $updatedEnv = Update-AuditorEnvText -Text $currentEnvText -Values $values
    Write-Utf8NoBom -Path (Join-Path $stage.Path ".env") -Text $updatedEnv
    $template = Join-Path $stage.Path "installers\windows\docker-compose.windows.yml.example"
    Write-Utf8NoBom -Path (Join-Path $stage.Path "docker-compose.yml") `
        -Text ([System.IO.File]::ReadAllText($template))
    Invoke-AuditorDocker -RepositoryRoot $stage.Path -Arguments @(
        "compose", "config", "--quiet"
    ) -Quiet | Out-Null
    Write-AuditorOk "Configuración permanente provisional validada"
}

function Write-MigrationState {
    $state = [ordered]@{
        schema_version = 2
        installed_at_utc = [DateTime]::UtcNow.ToString("o")
        migrated_at_utc = [DateTime]::UtcNow.ToString("o")
        migrated_from = $CurrentRoot
        installation_root = $storage.InstallRoot
        exports_root = $storage.ExportsRoot
        backups_root = $storage.BackupsRoot
        diagnostics_root = $storage.DiagnosticsRoot
        server_ip = $serverIp
        scan_cidr = $scanCidr
        port = $port
        dns_name = $dnsName
        discovery_mode = "l3_compat"
        data_volume = $dataVolume
    }
    Write-Utf8NoBom -Path (Join-Path $targetRoot ".auditor-ips-windows-state.json") `
        -Text ($state | ConvertTo-Json -Depth 4)
}

function Restore-CurrentRuntime {
    Write-AuditorWarning "Se restaura el runtime de la instalación anterior."
    Invoke-AuditorDocker -RepositoryRoot $CurrentRoot -Arguments @(
        "compose", "up", "-d", "--remove-orphans"
    ) | Out-Null
    Wait-AuditorHealth -Port $port
    Assert-AuditorTlsSan -RepositoryRoot $CurrentRoot -ServerIp $serverIp -DnsName $dnsName
    Write-AuditorOk "Rollback verificado; la instalación anterior vuelve a estar activa"
}

try {
    Write-AuditorSection "Auditor IPs — reubicación Windows"
    Assert-MigrationPreflight
    Read-CurrentConfiguration
    Resolve-TargetStorage
    Show-MigrationSummary
    Copy-PersistentContent

    $stage = New-AuditorStagedInstallation -SourceRoot $PackageRoot -InstallRoot $storage.InstallRoot
    Write-TargetConfiguration

    Write-AuditorSection "Cambio transaccional de runtime"
    Invoke-AuditorDocker -RepositoryRoot $CurrentRoot -Arguments @(
        "compose", "down", "--remove-orphans"
    ) | Out-Null
    $sourceStopped = $true

    Activate-AuditorStagedInstallation -Stage $stage -InstallRoot $storage.InstallRoot
    $targetRoot = $storage.InstallRoot
    Invoke-AuditorDocker -RepositoryRoot $targetRoot -Arguments @(
        "compose", "config", "--quiet"
    ) -Quiet | Out-Null

    $up = @("compose", "up", "-d", "--remove-orphans")
    if (-not $NoBuild) { $up += "--build" }
    $targetRuntimeAttempted = $true
    Invoke-AuditorDocker -RepositoryRoot $targetRoot -Arguments $up | Out-Null
    Wait-AuditorHealth -Port $port
    Assert-AuditorTlsSan -RepositoryRoot $targetRoot -ServerIp $serverIp -DnsName $dnsName
    if (-not $SkipBindMountValidation) {
        Assert-AuditorBindMounts -RepositoryRoot $targetRoot -Storage $storage
    }
    Write-MigrationState
    Write-Utf8NoBom -Path (Join-Path $CurrentRoot ".auditor-ips-migrated-to.txt") -Text ($targetRoot + "`n")
    Complete-AuditorOwnedInstallation -InstallRoot $targetRoot

    Write-Host ""
    Write-Host "Reubicación verificada." -ForegroundColor Green
    Write-Host ("Instalación permanente: {0}" -f $targetRoot) -ForegroundColor Green
    Write-Host ("URL: https://{0}:{1}/login" -f $serverIp, $port) -ForegroundColor Green
    Write-AuditorWarning "La carpeta anterior se conserva. No la borres hasta completar la aceptación final."
    exit 0
} catch {
    $failure = $_.Exception.Message
    if ($targetRuntimeAttempted -and $targetRoot) {
        Invoke-AuditorDocker -RepositoryRoot $targetRoot -Arguments @(
            "compose", "down", "--remove-orphans"
        ) -AllowFailure -Quiet | Out-Null
    }
    if ($targetRoot -and $stage) {
        try { Remove-AuditorOwnedInstallation -Path $targetRoot -Token $stage.Token } catch { Write-AuditorWarning $_.Exception.Message }
    } elseif ($stage) {
        try { Remove-AuditorOwnedInstallation -Path $stage.Path -Token $stage.Token } catch { Write-AuditorWarning $_.Exception.Message }
    }
    if ($sourceStopped) {
        try { Restore-CurrentRuntime } catch { Write-Host ("ERROR CRÍTICO DE ROLLBACK: {0}" -f $_.Exception.Message) -ForegroundColor Red }
    }
    Write-Host ("ERROR: {0}" -f $failure) -ForegroundColor Red
    exit 1
}
