[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 9909,
    [switch]$Remove
)

. (Join-Path $PSScriptRoot "common.ps1")
Initialize-AuditorConsole
$name = "Auditor IPs TCP $Port"

try {
    Write-AuditorSection "Auditor IPs — firewall Windows"
    if ($env:OS -ne "Windows_NT") { throw "Este script solo admite Windows." }

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Ejecuta PowerShell como administrador."
    }

    $existing = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)
    if ($Remove) {
        if ($existing.Count -gt 0) {
            $existing | Remove-NetFirewallRule
        }
        $remaining = @(Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)
        if ($remaining.Count -gt 0) { throw "La regla de firewall sigue presente." }
        Write-AuditorOk "Regla eliminada o ya ausente"
        exit 0
    }

    if ($existing.Count -gt 0) {
        $existing | Remove-NetFirewallRule
    }

    New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow `
        -Protocol TCP -LocalPort $Port -Profile Private -Enabled True | Out-Null

    $created = @(Get-NetFirewallRule -DisplayName $name -ErrorAction Stop)
    if ($created.Count -ne 1) { throw "No se creó exactamente una regla de firewall." }
    $filter = $created[0] | Get-NetFirewallPortFilter
    if ($created[0].Enabled -ne "True" -or
        $created[0].Direction -ne "Inbound" -or
        $created[0].Action -ne "Allow" -or
        $created[0].Profile -notmatch "Private" -or
        [string]$filter.Protocol -notmatch "TCP|6" -or
        [string]$filter.LocalPort -ne [string]$Port) {
        throw "La regla creada no coincide con el contrato Private/TCP/Inbound/Allow."
    }

    Write-AuditorOk ("Regla privada TCP {0} creada y verificada" -f $Port)
    exit 0
} catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}
