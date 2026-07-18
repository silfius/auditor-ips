[CmdletBinding()]
param(
    [string]$RepositoryRoot = "",
    [switch]$PurgeData,
    [switch]$RemoveConfiguration,
    [switch]$Yes
)

. (Join-Path $PSScriptRoot "common.ps1")
. (Join-Path $PSScriptRoot "storage.ps1")
Initialize-AuditorConsole
$RepositoryRoot = Get-AuditorRepositoryRoot -Override $RepositoryRoot
$EnvPath = Join-Path $RepositoryRoot ".env"
$ComposePath = Join-Path $RepositoryRoot "docker-compose.yml"
$StatePath = Join-Path $RepositoryRoot ".auditor-ips-windows-state.json"

try {
    Write-AuditorSection "Auditor IPs — desinstalación Windows"
    if ($env:OS -ne "Windows_NT") { throw "Este script solo admite Windows." }
    if (-not (Get-Command "docker.exe" -ErrorAction SilentlyContinue)) {
        throw "docker.exe no está disponible."
    }
    Invoke-AuditorNative -FilePath "docker.exe" -Arguments @(
        "info", "--format", "{{.ServerVersion}}"
    ) -Quiet | Out-Null
    if (-not (Test-Path -LiteralPath $ComposePath -PathType Leaf)) {
        throw "No existe docker-compose.yml en el repositorio indicado."
    }

    $envValues = Read-AuditorEnv -Path $EnvPath
    $volume = if ($envValues.ContainsKey("DATA_VOLUME")) {
        [string]$envValues["DATA_VOLUME"]
    } else { "auditor_ips_data" }
    $containerName = if ($envValues.ContainsKey("AUDITOR_CONTAINER_NAME")) {
        [string]$envValues["AUDITOR_CONTAINER_NAME"]
    } else { "auditor_ips" }
    if ($volume -notmatch '^auditor_ips(?:_[a-z0-9_-]+)?_data$') {
        throw ("Nombre de volumen rechazado por seguridad: {0}" -f $volume)
    }
    if ($containerName -ne "auditor_ips") {
        throw ("Nombre de contenedor rechazado por seguridad: {0}" -f $containerName)
    }

    $exports = if ($envValues.ContainsKey("EXPORTS_HOST_DIR")) { Resolve-AuditorHostPathFromEnv -RepositoryRoot $RepositoryRoot -Value ([string]$envValues["EXPORTS_HOST_DIR"]) } else { Join-Path $RepositoryRoot "exports" }
    $backups = if ($envValues.ContainsKey("BACKUPS_HOST_DIR")) { Resolve-AuditorHostPathFromEnv -RepositoryRoot $RepositoryRoot -Value ([string]$envValues["BACKUPS_HOST_DIR"]) } else { Join-Path $RepositoryRoot "backups" }
    $diagnostics = if ($envValues.ContainsKey("DIAGNOSTICS_HOST_DIR")) { Resolve-AuditorHostPathFromEnv -RepositoryRoot $RepositoryRoot -Value ([string]$envValues["DIAGNOSTICS_HOST_DIR"]) } else { Join-Path $RepositoryRoot "diagnostics" }

    Write-Host "  Runtime: eliminar"
    Write-Host ("  Volumen: {0}" -f $(if ($PurgeData) { "ELIMINAR $volume" } else { "conservar $volume" }))
    Write-Host ("  Configuración: {0}" -f $(if ($RemoveConfiguration) { "eliminar" } else { "conservar" }))
    Write-Host ("  Exportaciones: conservar {0}" -f $exports)
    Write-Host ("  Backups:       conservar {0}" -f $backups)
    Write-Host ("  Diagnósticos:  conservar {0}" -f $diagnostics)
    if (-not $Yes) {
        $answer = Read-Host "Escribe SI para continuar"
        if ($answer -cne "SI") { throw "Operación cancelada." }
    }

    Invoke-AuditorDocker -RepositoryRoot $RepositoryRoot `
        -Arguments @("compose", "down", "--remove-orphans") | Out-Null

    if ($PurgeData) {
        $before = Invoke-AuditorNative -FilePath "docker.exe" -Arguments @(
            "volume", "inspect", $volume
        ) -AllowFailure -Quiet
        if ($before.ExitCode -eq 0) {
            Invoke-AuditorNative -FilePath "docker.exe" -Arguments @(
                "volume", "rm", $volume
            ) -Quiet | Out-Null
        }
    }
    if ($RemoveConfiguration) {
        Remove-Item -LiteralPath $EnvPath, $ComposePath, $StatePath `
            -Force -ErrorAction SilentlyContinue
    }

    $container = Invoke-AuditorNative -FilePath "docker.exe" -Arguments @(
        "ps", "-a", "--filter", "name=^/$containerName$", "--format", "{{.ID}}"
    ) -Quiet
    if ($container.StdOut.Trim()) { throw ("El contenedor {0} sigue presente." -f $containerName) }
    if ($PurgeData) {
        $after = Invoke-AuditorNative -FilePath "docker.exe" -Arguments @(
            "volume", "inspect", $volume
        ) -AllowFailure -Quiet
        if ($after.ExitCode -eq 0) { throw "El volumen solicitado sigue presente." }
    }
    Write-AuditorOk "Desinstalación verificada"
    exit 0
} catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}
