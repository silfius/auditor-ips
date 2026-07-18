[CmdletBinding()]
param([string]$RepositoryRoot = "")

. (Join-Path $PSScriptRoot "common.ps1")
. (Join-Path $PSScriptRoot "storage.ps1")
Initialize-AuditorConsole
$RepositoryRoot = Get-AuditorRepositoryRoot -Override $RepositoryRoot
$EnvPath = Join-Path $RepositoryRoot ".env"
$envValues = Read-AuditorEnv -Path $EnvPath
$DiagnosticsRoot = if ($envValues.ContainsKey("DIAGNOSTICS_HOST_DIR")) {
    Resolve-AuditorHostPathFromEnv -RepositoryRoot $RepositoryRoot -Value ([string]$envValues["DIAGNOSTICS_HOST_DIR"])
} else {
    Join-Path $RepositoryRoot "diagnostics"
}

function Redact-EnvText {
    param([string]$Text)
    return [regex]::Replace(
        $Text,
        '(?im)^(\s*[^:=\r\n]*(?:PASSWORD|PASSWD|SECRET|TOKEN|WEBHOOK|API_KEY|PRIVATE_KEY)[^:=\r\n]*\s*[:=]\s*).*$',
        '$1[REDACTED]'
    )
}

try {
    Write-AuditorSection "Auditor IPs — diagnóstico Windows"
    if ($env:OS -ne "Windows_NT") { throw "Este script solo admite Windows." }
    [void](New-Item -ItemType Directory -Path $DiagnosticsRoot -Force)
    $stamp = [DateTime]::UtcNow.ToString("yyyyMMdd-HHmmss")
    $work = Join-Path ([System.IO.Path]::GetTempPath()) ("auditor-diag-" + [Guid]::NewGuid().ToString("N"))
    [void](New-Item -ItemType Directory -Path $work)
    try {
        try {
            $windowsText = Get-CimInstance Win32_OperatingSystem | Format-List * | Out-String
        } catch {
            $windowsText = "OS=$([Environment]::OSVersion.VersionString)`nPS=$($PSVersionTable.PSVersion)"
        }
        Write-Utf8NoBom -Path (Join-Path $work "windows.txt") -Text $windowsText
        $commands = @(
            [pscustomobject]@{ Name = "docker-version.txt"; Args = @("version") },
            [pscustomobject]@{ Name = "compose-version.txt"; Args = @("compose", "version") },
            [pscustomobject]@{ Name = "docker-info.txt"; Args = @("info") },
            [pscustomobject]@{ Name = "compose-ps.txt"; Args = @("compose", "ps", "-a") },
            [pscustomobject]@{ Name = "compose-config.txt"; Args = @("compose", "config", "--no-interpolate") },
            [pscustomobject]@{ Name = "compose-logs.txt"; Args = @("compose", "logs", "--no-color", "--tail", "300") }
        )
        foreach ($entry in $commands) {
            $result = Invoke-AuditorDocker -RepositoryRoot $RepositoryRoot `
                -Arguments $entry.Args -AllowFailure -Quiet
            $content = "RC=$($result.ExitCode)`nSTDOUT:`n$($result.StdOut)`nSTDERR:`n$($result.StdErr)"
            Write-Utf8NoBom -Path (Join-Path $work $entry.Name) -Text (Redact-EnvText $content)
        }
        if (Test-Path -LiteralPath $EnvPath) {
            $envText = [System.IO.File]::ReadAllText($EnvPath)
            Write-Utf8NoBom -Path (Join-Path $work "env-redacted.txt") `
                -Text (Redact-EnvText $envText)
        }
        $state = Join-Path $RepositoryRoot ".auditor-ips-windows-state.json"
        if (Test-Path -LiteralPath $state) {
            Copy-Item -LiteralPath $state -Destination (Join-Path $work "install-state.json")
        }
        $zip = Join-Path $DiagnosticsRoot ("auditor-ips-diagnostic-{0}.zip" -f $stamp)
        New-AuditorZip -SourceDirectory $work -DestinationZip $zip
        Write-AuditorOk ("Diagnóstico generado: {0}" -f $zip)
    } finally {
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
    exit 0
} catch {
    Write-Host ("ERROR: {0}" -f $_.Exception.Message) -ForegroundColor Red
    exit 1
}
