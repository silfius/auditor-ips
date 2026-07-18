[CmdletBinding()]
param(
    [string]$ServerIp = "",
    [string]$ScanCidr = "",
    [ValidateRange(1, 65535)][int]$Port = 9909,
    [string]$DnsName = "auditips.local",
    [string]$RepositoryRoot = "",
    [string]$InstallRoot = "",
    [string]$ExportsRoot = "",
    [string]$BackupsRoot = "",
    [string]$DiagnosticsRoot = "",
    [switch]$Yes,
    [switch]$NoBuild,
    [switch]$SkipBindMountValidation,
    [switch]$CheckOnly
)

. (Join-Path $PSScriptRoot "common.ps1")
. (Join-Path $PSScriptRoot "storage.ps1")
Initialize-AuditorConsole

$SourceRoot = Get-AuditorRepositoryRoot -Override $RepositoryRoot
$storage = $null
$network = $null
$stage = $null
$activeRoot = ""
$runtimeAttempted = $false
$operationStage = "inicialización"

function Assert-Preflight {
    Write-AuditorSection "Preflight"
    $platform = Assert-AuditorWindows11Amd64
    Write-AuditorOk ("Windows 11 AMD64 · build {0}" -f $platform.Build)
    foreach ($command in @("docker.exe", "curl.exe")) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw ("Dependencia ausente: {0}" -f $command)
        }
    }

    $compose = Invoke-AuditorDocker -RepositoryRoot $SourceRoot -Arguments @(
        "compose", "version", "--short"
    ) -Quiet
    $serverOs = Invoke-AuditorDocker -RepositoryRoot $SourceRoot -Arguments @(
        "version", "--format", "{{.Server.Os}}"
    ) -Quiet
    if ($serverOs.StdOut.Trim().ToLowerInvariant() -ne "linux") {
        throw "Docker Desktop debe usar contenedores Linux."
    }
    $kernel = Invoke-AuditorDocker -RepositoryRoot $SourceRoot -Arguments @(
        "info", "--format", "{{.KernelVersion}}"
    ) -Quiet
    if ($kernel.StdOut -notmatch '(?i)WSL2|microsoft-standard-WSL2') {
        throw ("No se acreditó backend WSL2. Kernel: {0}" -f $kernel.StdOut.Trim())
    }

    $container = Invoke-AuditorNative -FilePath "docker.exe" -Arguments @(
        "ps", "-a", "--filter", "name=^/auditor_ips$", "--format", "{{.ID}}"
    ) -AllowFailure -Quiet
    if ($container.ExitCode -ne 0) {
        throw ("No se pudo comprobar el contenedor existente: {0}" -f $container.StdErr.Trim())
    }
    if ($container.StdOut.Trim()) {
        throw "Ya existe auditor_ips. Usa migrate-installation.ps1 para trasladar la instalación activa."
    }

    foreach ($required in @(
        (Join-Path $SourceRoot "app\dockerfile"),
        (Join-Path $PSScriptRoot "docker-compose.windows.yml.example")
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw ("Fichero requerido ausente: {0}" -f $required)
        }
    }
    Write-AuditorOk ("Docker Compose {0}" -f $compose.StdOut.Trim())
    Write-AuditorOk ("Kernel {0}" -f $kernel.StdOut.Trim())
}

function Resolve-AllConfiguration {
    $script:storage = Resolve-AuditorStorageConfiguration `
        -InstallRoot $InstallRoot `
        -ExportsRoot $ExportsRoot `
        -BackupsRoot $BackupsRoot `
        -DiagnosticsRoot $DiagnosticsRoot `
        -NonInteractive:$Yes
    $script:InstallRoot = $storage.InstallRoot
    $script:ExportsRoot = $storage.ExportsRoot
    $script:BackupsRoot = $storage.BackupsRoot
    $script:DiagnosticsRoot = $storage.DiagnosticsRoot

    Assert-AuditorNewInstallationRoot -SourceRoot $SourceRoot -InstallRoot $storage.InstallRoot
    if (-not (Test-TcpPortFree -Port $Port)) {
        throw ("El puerto TCP {0} ya está ocupado." -f $Port)
    }

    $resolvedNetwork = Resolve-AuditorNetworkConfiguration `
        -ServerIp $ServerIp -ScanCidr $ScanCidr -NonInteractive:$Yes
    $script:ServerIp = $resolvedNetwork.ServerIp
    $script:ScanCidr = $resolvedNetwork.ScanCidr
    $script:network = $resolvedNetwork
    Assert-DnsName -Value $DnsName

    $volume = Invoke-AuditorNative -FilePath "docker.exe" -Arguments @(
        "volume", "inspect", "auditor_ips_data"
    ) -AllowFailure -Quiet
    if ($volume.ExitCode -eq 0) {
        Write-AuditorWarning "Se reutilizará el volumen de datos existente auditor_ips_data."
    }
}

function Show-ConfigurationSummary {
    Write-AuditorSection "Resumen de la instalación"
    Write-Host ("  Instalación:       {0}" -f $storage.InstallRoot)
    Write-Host ("  Exportaciones:     {0}" -f $storage.ExportsRoot)
    Write-Host ("  Backups:           {0}" -f $storage.BackupsRoot)
    Write-Host ("  Diagnósticos:      {0}" -f $storage.DiagnosticsRoot)
    Write-Host "  Datos internos:    volumen Docker auditor_ips_data"
    Write-Host ("  Interfaz:          {0}" -f $network.InterfaceAlias)
    Write-Host ("  IP del servidor:   {0}" -f $ServerIp)
    Write-Host ("  Red de escaneo:    {0}" -f $ScanCidr)
    Write-Host ("  Máscara:           {0}" -f $network.ScanMask)
    Write-Host ("  Puerto HTTPS:      {0}" -f $Port)
    Write-Host ("  Nombre DNS:        {0}" -f $DnsName)
    Write-Host ("  URL prevista:      https://{0}:{1}/login" -f $ServerIp, $Port)

    if ($Yes) { return 1 }
    Write-Host ""
    Write-Host "  [1] Instalar con esta configuración"
    Write-Host "  [2] Volver a elegir las rutas"
    Write-Host "  [3] Volver a elegir IP y red"
    Write-Host "  [0] Cancelar"
    while ($true) {
        $raw = (Read-Host "Selecciona una opción [1]").Trim()
        if (-not $raw -or $raw -eq "1") { return 1 }
        if ($raw -eq "2") { return 2 }
        if ($raw -eq "3") { return 3 }
        if ($raw -eq "0") { throw "Operación cancelada por el usuario." }
        Write-AuditorWarning "Selección no válida. Escribe 1, 2, 3 o 0."
    }
}

function New-EnvironmentText {
    $instanceId = [Guid]::NewGuid().ToString("N")
    return @"
COMPOSE_PROJECT_NAME=auditor_ips
AUDITOR_CONTAINER_NAME=auditor_ips
AUDITOR_INSTANCE_ID=$instanceId
SESSION_COOKIE_NAME=auditor_ips_$($instanceId.Substring(0,12))
SESSION_COOKIE_SECURE=1
SESSION_COOKIE_SAMESITE=strict
SESSION_TTL_HOURS=8
PORT=$Port
DB_PATH=/data/auditor.db
DATA_VOLUME=auditor_ips_data
EXPORTS_HOST_DIR=$(ConvertTo-AuditorComposeHostPath -Path $storage.ExportsRoot)
BACKUPS_HOST_DIR=$(ConvertTo-AuditorComposeHostPath -Path $storage.BackupsRoot)
DIAGNOSTICS_HOST_DIR=$(ConvertTo-AuditorComposeHostPath -Path $storage.DiagnosticsRoot)
TLS_CERT_IP=$ServerIp
TLS_CERT_DNS=$DnsName
SERVER_IP=$ServerIp
SCAN_CIDR=$ScanCidr
NETWORK_INTERFACE=
DISCOVERY_PROBE_IP=
PLATFORM_PROFILE=windows_desktop
DISCOVERY_MODE=l3_compat
INSTALLATION_PROFILE=recommended
SCAN_RETENTION_DAYS=14
DISCORD_WEBHOOK_URL=
NOTIFY_NEW=1
NOTIFY_ONLINE=0
NOTIFY_OFFLINE=0
NOTIFY_MAC_CHANGE=0
"@
}

function Write-StagedConfiguration {
    $envPath = Join-Path $stage.Path ".env"
    $composePath = Join-Path $stage.Path "docker-compose.yml"
    $template = Join-Path $stage.Path "installers\windows\docker-compose.windows.yml.example"
    Write-Utf8NoBom -Path $envPath -Text ((New-EnvironmentText).TrimStart())
    Write-Utf8NoBom -Path $composePath -Text ([System.IO.File]::ReadAllText($template))
    Invoke-AuditorNative -FilePath "docker.exe" -WorkingDirectory $SourceRoot -Arguments @(
        "compose", "--project-directory", $stage.Path,
        "--env-file", $envPath, "-f", $composePath,
        "config", "--quiet"
    ) -Quiet | Out-Null
    Write-AuditorOk "Configuración provisional validada"
}

function Write-InstallState {
    $state = [ordered]@{
        schema_version = 2
        installed_at_utc = [DateTime]::UtcNow.ToString("o")
        installation_root = $storage.InstallRoot
        exports_root = $storage.ExportsRoot
        backups_root = $storage.BackupsRoot
        diagnostics_root = $storage.DiagnosticsRoot
        server_ip = $ServerIp
        scan_cidr = $ScanCidr
        port = $Port
        dns_name = $DnsName
        discovery_mode = "l3_compat"
        data_volume = "auditor_ips_data"
    }
    Write-Utf8NoBom -Path (Join-Path $activeRoot ".auditor-ips-windows-state.json") `
        -Text ($state | ConvertTo-Json -Depth 4)
}

try {
    Write-AuditorSection "Auditor IPs — instalación Windows"
    Assert-Preflight
    if ($CheckOnly) {
        Write-AuditorOk "Preflight completado; no se modificó el sistema."
        exit 0
    }

    while ($true) {
        Resolve-AllConfiguration
        $decision = Show-ConfigurationSummary
        if ($decision -eq 1) { break }
        if ($decision -eq 2) {
            $script:InstallRoot = ""; $script:ExportsRoot = ""; $script:BackupsRoot = ""; $script:DiagnosticsRoot = ""
        } else {
            $script:ServerIp = ""; $script:ScanCidr = ""
        }
    }

    $operationStage = "copia verificada del paquete"
    $stage = New-AuditorStagedInstallation -SourceRoot $SourceRoot -InstallRoot $storage.InstallRoot
    $operationStage = "configuración provisional"
    Write-StagedConfiguration
    $operationStage = "preparación de carpetas operativas"
    Initialize-AuditorStorageDirectories -Storage $storage
    $operationStage = "activación de la instalación permanente"
    Activate-AuditorStagedInstallation -Stage $stage -InstallRoot $storage.InstallRoot
    $activeRoot = $storage.InstallRoot

    $operationStage = "validación de la configuración final"
    Invoke-AuditorDocker -RepositoryRoot $activeRoot -Arguments @(
        "compose", "config", "--quiet"
    ) -Quiet | Out-Null
    Write-AuditorOk "Configuración final validada"

    $up = @("compose", "up", "-d", "--remove-orphans")
    if (-not $NoBuild) { $up += "--build" }
    $operationStage = "build y arranque Docker"
    $runtimeAttempted = $true
    Invoke-AuditorDocker -RepositoryRoot $activeRoot -Arguments $up | Out-Null
    $operationStage = "health HTTPS"
    Wait-AuditorHealth -Port $Port
    $operationStage = "certificado TLS"
    Assert-AuditorTlsSan -RepositoryRoot $activeRoot -ServerIp $ServerIp -DnsName $DnsName
    if (-not $SkipBindMountValidation) {
        $operationStage = "bind mounts"
        Assert-AuditorBindMounts -RepositoryRoot $activeRoot -Storage $storage
    }
    $operationStage = "estado final"
    Write-InstallState
    Complete-AuditorOwnedInstallation -InstallRoot $activeRoot

    Write-Host ""
    Write-Host "Instalación permanente verificada." -ForegroundColor Green
    Write-Host ("Directorio: {0}" -f $activeRoot) -ForegroundColor Green
    Write-Host ("URL: https://{0}:{1}/login" -f $ServerIp, $Port) -ForegroundColor Green
    Write-Host ("CA:  https://{0}:{1}/api/tls/ca.crt" -f $ServerIp, $Port)
    Write-AuditorWarning "El firewall no se modifica automáticamente. Usa firewall.ps1 desde la instalación permanente."
    exit 0
} catch {
    if ($runtimeAttempted -and $activeRoot) {
        Invoke-AuditorDocker -RepositoryRoot $activeRoot -Arguments @(
            "compose", "down", "--remove-orphans"
        ) -AllowFailure -Quiet | Out-Null
    }
    if ($activeRoot -and $stage) {
        try { Remove-AuditorOwnedInstallation -Path $activeRoot -Token $stage.Token } catch { Write-AuditorWarning $_.Exception.Message }
    } elseif ($stage) {
        try { Remove-AuditorOwnedInstallation -Path $stage.Path -Token $stage.Token } catch { Write-AuditorWarning $_.Exception.Message }
    }
    Write-Host ("ERROR_STAGE: {0}" -f $operationStage) -ForegroundColor Red
    Write-Host ("ERROR_TYPE: {0}" -f $_.Exception.GetType().FullName) -ForegroundColor Red
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
        Write-Host ("ERROR_LOCATION: {0}" -f ($_.InvocationInfo.PositionMessage -replace "`r?`n", " | ")) -ForegroundColor Red
    }
    if ($_.ScriptStackTrace) {
        Write-Host ("ERROR_STACK: {0}" -f ($_.ScriptStackTrace -replace "`r?`n", " | ")) -ForegroundColor Red
    }
    exit 1
}
