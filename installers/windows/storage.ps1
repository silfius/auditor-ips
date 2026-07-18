Set-StrictMode -Version 2.0

function ConvertTo-AuditorCanonicalWindowsPath {
    param([Parameter(Mandatory = $true)][string]$Value)

    $trimmed = $Value.Trim().Trim('"')
    if (-not $trimmed) { throw "La ruta no puede estar vacía." }
    $expanded = [Environment]::ExpandEnvironmentVariables($trimmed)
    if (-not [System.IO.Path]::IsPathRooted($expanded)) {
        throw ("La ruta debe ser absoluta: {0}" -f $Value)
    }
    $full = [System.IO.Path]::GetFullPath($expanded)
    if ($full -match '^[a-z]:\\') {
        $full = $full.Substring(0, 1).ToUpperInvariant() + $full.Substring(1)
    }
    if ($full -notmatch '^[A-Za-z]:\\') {
        throw ("Solo se admiten rutas locales con letra de unidad: {0}" -f $full)
    }
    if ($full.Length -gt 3) { $full = $full.TrimEnd('\') }
    return $full
}

function ConvertTo-AuditorComposeHostPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (ConvertTo-AuditorCanonicalWindowsPath -Value $Path).Replace('\', '/')
}

function Test-AuditorPathWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Parent
    )
    $child = (ConvertTo-AuditorCanonicalWindowsPath -Value $Path).TrimEnd('\')
    $root = (ConvertTo-AuditorCanonicalWindowsPath -Value $Parent).TrimEnd('\')
    if ($child.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $child.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Test-AuditorVolatilePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $full = ConvertTo-AuditorCanonicalWindowsPath -Value $Path
    foreach ($candidate in @(
        $env:TEMP,
        $env:TMP,
        [System.IO.Path]::GetTempPath()
    )) {
        if (-not [string]::IsNullOrWhiteSpace($candidate)) {
            try {
                if (Test-AuditorPathWithin -Path $full -Parent $candidate) { return $true }
            } catch {
            }
        }
    }
    return ($full -match '(?i)(^|\\)(temp|tmp|downloads)(\\|$)')
}

function Assert-AuditorStableLocalPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    $full = ConvertTo-AuditorCanonicalWindowsPath -Value $Path
    if (Test-AuditorVolatilePath -Path $full) {
        throw ("La ruta de {0} no puede estar bajo TEMP, TMP o Descargas: {1}" -f $Purpose, $full)
    }

    $root = [System.IO.Path]::GetPathRoot($full)
    $drive = New-Object System.IO.DriveInfo -ArgumentList $root
    if (-not $drive.IsReady) {
        throw ("La unidad de {0} no está disponible: {1}" -f $Purpose, $root)
    }
    if ($drive.DriveType -ne [System.IO.DriveType]::Fixed) {
        throw ("La ruta de {0} debe residir en una unidad local fija: {1}" -f $Purpose, $full)
    }
    return $full
}

function Get-AuditorFixedDriveInventory {
    $items = New-Object System.Collections.Generic.List[object]
    foreach ($drive in [System.IO.DriveInfo]::GetDrives()) {
        try {
            if ($drive.IsReady -and $drive.DriveType -eq [System.IO.DriveType]::Fixed) {
                $items.Add([pscustomobject]@{
                    Root = $drive.RootDirectory.FullName
                    Label = $drive.VolumeLabel
                    FreeGb = [Math]::Round($drive.AvailableFreeSpace / 1GB, 1)
                    TotalGb = [Math]::Round($drive.TotalSize / 1GB, 1)
                })
            }
        } catch {
        }
    }
    return @($items | Sort-Object Root)
}

function Show-AuditorFixedDriveInventory {
    $drives = @(Get-AuditorFixedDriveInventory)
    if ($drives.Count -eq 0) { return }
    Write-Host "Unidades locales disponibles:"
    foreach ($drive in $drives) {
        $label = if ($drive.Label) { " · " + $drive.Label } else { "" }
        Write-Host ("  {0}{1} — {2} GB libres de {3} GB" -f $drive.Root, $label, $drive.FreeGb, $drive.TotalGb)
    }
    Write-Host ""
}

function Get-AuditorDefaultStorageConfiguration {
    param([string]$InstallRoot = "")

    if (-not $InstallRoot) {
        $programData = if ($env:ProgramData) {
            [System.IO.Path]::GetFullPath($env:ProgramData)
        } else {
            "C:\ProgramData"
        }
        $InstallRoot = Join-Path $programData "AuditorIPs"
    }

    $install = ConvertTo-AuditorCanonicalWindowsPath -Value $InstallRoot
    $parent = Split-Path -Path $install -Parent
    $leaf = Split-Path -Path $install -Leaf
    if (-not $leaf) { $leaf = "AuditorIPs" }
    $data = Join-Path $parent ($leaf + "Data")

    return [pscustomobject]@{
        InstallRoot = $install
        DataRoot = $data
        ExportsRoot = Join-Path $data "exports"
        BackupsRoot = Join-Path $data "backups"
        DiagnosticsRoot = Join-Path $data "diagnostics"
    }
}
function Read-AuditorStoragePath {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [Parameter(Mandatory = $true)][string]$Default,
        [Parameter(Mandatory = $true)][string]$Purpose,
        [scriptblock]$InputProvider = $null
    )

    while ($true) {
        $raw = Read-AuditorInput -Prompt ("{0} [{1}]" -f $Prompt, $Default) -InputProvider $InputProvider
        $value = $raw.Trim()
        if ($value -eq "0") { throw "Operación cancelada por el usuario." }
        if (-not $value) { $value = $Default }
        try {
            return (Assert-AuditorStableLocalPath -Path $value -Purpose $Purpose)
        } catch {
            Write-AuditorWarning $_.Exception.Message
        }
    }
}
function Read-AuditorOperationalStoragePath {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [Parameter(Mandatory = $true)][string]$Default,
        [Parameter(Mandatory = $true)][string]$Purpose,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [object[]]$ExistingPaths = @(),
        [scriptblock]$InputProvider = $null
    )

    while ($true) {
        $candidate = Read-AuditorStoragePath -Prompt $Prompt -Default $Default `
            -Purpose $Purpose -InputProvider $InputProvider
        try {
            if (Test-AuditorPathWithin -Path $candidate -Parent $InstallRoot) {
                throw ("La ruta de {0} debe quedar fuera del directorio de instalación." -f $Purpose)
            }
            foreach ($existing in $ExistingPaths) {
                if ((Test-AuditorPathWithin -Path $candidate -Parent $existing.Value) -or
                    (Test-AuditorPathWithin -Path $existing.Value -Parent $candidate)) {
                    throw ("Las rutas de {0} y {1} deben ser independientes." -f $Purpose, $existing.Name)
                }
            }
            return $candidate
        } catch {
            Write-AuditorWarning $_.Exception.Message
            Write-AuditorWarning ("Sugerencia válida: {0}" -f $Default)
        }
    }
}
function Assert-AuditorStorageSeparation {
    param([Parameter(Mandatory = $true)][pscustomobject]$Storage)

    $paths = @(
        [pscustomobject]@{ Name = "exportaciones"; Value = $Storage.ExportsRoot },
        [pscustomobject]@{ Name = "backups"; Value = $Storage.BackupsRoot },
        [pscustomobject]@{ Name = "diagnósticos"; Value = $Storage.DiagnosticsRoot }
    )
    foreach ($entry in $paths) {
        if (Test-AuditorPathWithin -Path $entry.Value -Parent $Storage.InstallRoot) {
            throw ("La ruta de {0} debe quedar fuera del directorio de instalación: {1}" -f $entry.Name, $entry.Value)
        }
    }
    for ($left = 0; $left -lt $paths.Count; $left++) {
        for ($right = $left + 1; $right -lt $paths.Count; $right++) {
            if ((Test-AuditorPathWithin -Path $paths[$left].Value -Parent $paths[$right].Value) -or
                (Test-AuditorPathWithin -Path $paths[$right].Value -Parent $paths[$left].Value)) {
                throw ("Las rutas de {0} y {1} deben ser independientes." -f $paths[$left].Name, $paths[$right].Name)
            }
        }
    }
}

function Resolve-AuditorStorageConfiguration {
    param(
        [string]$InstallRoot = "",
        [string]$ExportsRoot = "",
        [string]$BackupsRoot = "",
        [string]$DiagnosticsRoot = "",
        [switch]$NonInteractive,
        [scriptblock]$InputProvider = $null
    )

    $baseDefaults = Get-AuditorDefaultStorageConfiguration
    if ($NonInteractive) {
        if (-not $InstallRoot) { $InstallRoot = $baseDefaults.InstallRoot }
        $InstallRoot = Assert-AuditorStableLocalPath -Path $InstallRoot -Purpose "instalación"
        $defaults = Get-AuditorDefaultStorageConfiguration -InstallRoot $InstallRoot
        if (-not $ExportsRoot) { $ExportsRoot = $defaults.ExportsRoot }
        if (-not $BackupsRoot) { $BackupsRoot = $defaults.BackupsRoot }
        if (-not $DiagnosticsRoot) { $DiagnosticsRoot = $defaults.DiagnosticsRoot }
        $storage = [pscustomobject]@{
            InstallRoot = $InstallRoot
            ExportsRoot = (Assert-AuditorStableLocalPath -Path $ExportsRoot -Purpose "exportaciones")
            BackupsRoot = (Assert-AuditorStableLocalPath -Path $BackupsRoot -Purpose "backups")
            DiagnosticsRoot = (Assert-AuditorStableLocalPath -Path $DiagnosticsRoot -Purpose "diagnósticos")
        }
        Assert-AuditorStorageSeparation -Storage $storage
        return $storage
    }

    Write-AuditorSection "Ubicación y almacenamiento"
    Write-Host "La base de datos y los certificados permanecerán en el volumen Docker auditor_ips_data."
    Write-Host "El código/configuración y las carpetas operativas se ubicarán en rutas permanentes separadas."
    Write-Host "Al cambiar la instalación, las demás rutas propuestas se adaptarán automáticamente."
    Write-Host "Escribe 0 en cualquier pregunta para cancelar."
    Show-AuditorFixedDriveInventory

    if (-not $InstallRoot) {
        $InstallRoot = Read-AuditorStoragePath -Prompt "Ruta permanente de instalación" `
            -Default $baseDefaults.InstallRoot -Purpose "instalación" -InputProvider $InputProvider
    } else {
        $InstallRoot = Assert-AuditorStableLocalPath -Path $InstallRoot -Purpose "instalación"
    }

    $defaults = Get-AuditorDefaultStorageConfiguration -InstallRoot $InstallRoot
    Write-Host ("Raíz operativa propuesta: {0}" -f $defaults.DataRoot)

    if (-not $ExportsRoot) {
        $ExportsRoot = Read-AuditorOperationalStoragePath -Prompt "Ruta de exportaciones" `
            -Default $defaults.ExportsRoot -Purpose "exportaciones" -InstallRoot $InstallRoot `
            -InputProvider $InputProvider
    } else {
        $ExportsRoot = Assert-AuditorStableLocalPath -Path $ExportsRoot -Purpose "exportaciones"
    }
    if (-not $BackupsRoot) {
        $BackupsRoot = Read-AuditorOperationalStoragePath -Prompt "Ruta de backups" `
            -Default $defaults.BackupsRoot -Purpose "backups" -InstallRoot $InstallRoot `
            -ExistingPaths @([pscustomobject]@{ Name = "exportaciones"; Value = $ExportsRoot }) `
            -InputProvider $InputProvider
    } else {
        $BackupsRoot = Assert-AuditorStableLocalPath -Path $BackupsRoot -Purpose "backups"
    }
    if (-not $DiagnosticsRoot) {
        $DiagnosticsRoot = Read-AuditorOperationalStoragePath -Prompt "Ruta de diagnósticos" `
            -Default $defaults.DiagnosticsRoot -Purpose "diagnósticos" -InstallRoot $InstallRoot `
            -ExistingPaths @(
                [pscustomobject]@{ Name = "exportaciones"; Value = $ExportsRoot },
                [pscustomobject]@{ Name = "backups"; Value = $BackupsRoot }
            ) -InputProvider $InputProvider
    } else {
        $DiagnosticsRoot = Assert-AuditorStableLocalPath -Path $DiagnosticsRoot -Purpose "diagnósticos"
    }
    $storage = [pscustomobject]@{
        InstallRoot = $InstallRoot
        ExportsRoot = $ExportsRoot
        BackupsRoot = $BackupsRoot
        DiagnosticsRoot = $DiagnosticsRoot
    }
    Assert-AuditorStorageSeparation -Storage $storage

    $installDrive = [System.IO.Path]::GetPathRoot($storage.InstallRoot)
    $backupDrive = [System.IO.Path]::GetPathRoot($storage.BackupsRoot)
    if ($installDrive.Equals($backupDrive, [StringComparison]::OrdinalIgnoreCase)) {
        Write-AuditorWarning "Los backups están en la misma unidad que la instalación. Replica las copias en otro disco o equipo."
    }
    return $storage
}

function Assert-AuditorNewInstallationRoot {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )

    if ((Test-AuditorPathWithin -Path $InstallRoot -Parent $SourceRoot) -or
        (Test-AuditorPathWithin -Path $SourceRoot -Parent $InstallRoot)) {
        throw "La ruta permanente no puede solaparse con el paquete desde el que se ejecuta el instalador."
    }
    if (Test-Path -LiteralPath $InstallRoot) {
        $items = @(Get-ChildItem -LiteralPath $InstallRoot -Force -ErrorAction Stop)
        if ($items.Count -gt 0) {
            throw ("La ruta de instalación ya contiene archivos: {0}" -f $InstallRoot)
        }
    }
}

function Assert-AuditorWritableDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    [void](New-Item -ItemType Directory -Path $Path -Force)
    $probe = Join-Path $Path (".auditor-write-probe-" + [Guid]::NewGuid().ToString("N"))
    try {
        Write-Utf8NoBom -Path $probe -Text "ok"
        if ([System.IO.File]::ReadAllText($probe) -ne "ok") {
            throw ("No se pudo verificar escritura en {0}" -f $Path)
        }
    } finally {
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    }
}

function Initialize-AuditorStorageDirectories {
    param([Parameter(Mandatory = $true)][pscustomobject]$Storage)
    foreach ($path in @($Storage.ExportsRoot, $Storage.BackupsRoot, $Storage.DiagnosticsRoot)) {
        Assert-AuditorWritableDirectory -Path $path
    }
}

function Get-AuditorInstallationParentPath {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)

    $install = ConvertTo-AuditorCanonicalWindowsPath -Value $InstallRoot
    $driveRoot = [System.IO.Path]::GetPathRoot($install)
    if ([string]::IsNullOrWhiteSpace($driveRoot)) {
        throw ("No se pudo determinar la raíz de la instalación: {0}" -f $install)
    }
    if ($install.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "La instalación no puede usar directamente la raíz de una unidad."
    }

    $relativeToDrive = $install.Substring($driveRoot.Length)
    if ($relativeToDrive.IndexOf('\') -lt 0) {
        return (ConvertTo-AuditorCanonicalWindowsPath -Value $driveRoot)
    }

    $parent = [System.IO.Path]::GetDirectoryName($install)
    if ([string]::IsNullOrWhiteSpace($parent)) {
        throw ("No se pudo determinar el directorio padre de la instalación: {0}" -f $install)
    }
    return (ConvertTo-AuditorCanonicalWindowsPath -Value $parent)
}

function ConvertTo-AuditorSafePayloadRelativePath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        throw "La ruta relativa del paquete no puede estar vacía."
    }
    $relative = $RelativePath.Replace('/', '\')
    if ([System.IO.Path]::IsPathRooted($relative) -or
        $relative.StartsWith('\') -or
        $relative -match '^[A-Za-z]:' -or
        $relative.Contains(':')) {
        throw ("La ruta del paquete debe ser realmente relativa: {0}" -f $RelativePath)
    }
    $segments = @($relative -split '\\')
    if ($segments.Count -eq 0) {
        throw ("La ruta relativa del paquete no es válida: {0}" -f $RelativePath)
    }
    foreach ($segment in $segments) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..') {
            throw ("La ruta relativa del paquete contiene un segmento no permitido: {0}" -f $RelativePath)
        }
    }
    return ($segments -join '\')
}

function Resolve-AuditorPayloadDestinationPath {
    param(
        [Parameter(Mandatory = $true)][string]$DestinationRoot,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    $destinationBase = ConvertTo-AuditorCanonicalWindowsPath -Value $DestinationRoot
    $relative = ConvertTo-AuditorSafePayloadRelativePath -RelativePath $RelativePath
    $target = [System.IO.Path]::GetFullPath((Join-Path $destinationBase $relative))
    if (-not (Test-AuditorPathWithin -Path $target -Parent $destinationBase)) {
        throw ("La ruta del paquete escaparía del staging: {0}" -f $RelativePath)
    }
    return $target
}

function Get-AuditorRepositoryPayloadFiles {
    param([Parameter(Mandatory = $true)][string]$SourceRoot)

    $sourceBase = ConvertTo-AuditorCanonicalWindowsPath -Value $SourceRoot
    $allowed = @(
        ".dockerignore", ".gitignore", ".github", "app", "docs", "installers",
        "CHANGELOG.md", "LICENSE", "README.md", "SNAPSHOT_MANIFEST.json", "SNAPSHOT_REVIEW.md"
    )
    $files = New-Object System.Collections.Generic.List[object]
    $seen = @{}
    foreach ($name in $allowed) {
        $source = Join-Path $sourceBase $name
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            $relative = ConvertTo-AuditorSafePayloadRelativePath -RelativePath $name
            $key = $relative.ToLowerInvariant()
            if ($seen.ContainsKey($key)) { throw ("Entrada duplicada en el paquete: {0}" -f $relative) }
            $seen[$key] = $true
            $files.Add([pscustomobject]@{ Source = $source; Relative = $relative })
            continue
        }
        if (-not (Test-Path -LiteralPath $source -PathType Container)) { continue }
        foreach ($file in Get-ChildItem -LiteralPath $source -File -Recurse -Force) {
            if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw ("Se rechaza un punto de reanálisis en el paquete: {0}" -f $file.FullName)
            }
            $relative = $file.FullName.Substring($sourceBase.Length).TrimStart('\')
            $relative = ConvertTo-AuditorSafePayloadRelativePath -RelativePath $relative
            $key = $relative.ToLowerInvariant()
            if ($seen.ContainsKey($key)) { throw ("Entrada duplicada en el paquete: {0}" -f $relative) }
            $seen[$key] = $true
            $files.Add([pscustomobject]@{ Source = $file.FullName; Relative = $relative })
        }
    }
    return @($files | Sort-Object Relative)
}

function Copy-AuditorRepositoryPayload {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $destinationBase = ConvertTo-AuditorCanonicalWindowsPath -Value $DestinationRoot
    [void](New-Item -ItemType Directory -Path $destinationBase -Force)
    $payload = @(Get-AuditorRepositoryPayloadFiles -SourceRoot $SourceRoot)
    if ($payload.Count -eq 0) { throw "El paquete no contiene ficheros copiables." }
    $expected = @{}

    foreach ($entry in $payload) {
        $relative = ConvertTo-AuditorSafePayloadRelativePath -RelativePath $entry.Relative
        $key = $relative.ToLowerInvariant()
        if ($expected.ContainsKey($key)) { throw ("Entrada duplicada en el paquete: {0}" -f $relative) }
        $target = Resolve-AuditorPayloadDestinationPath -DestinationRoot $destinationBase -RelativePath $relative
        $parent = [System.IO.Path]::GetDirectoryName($target)
        if ([string]::IsNullOrWhiteSpace($parent)) {
            throw ("No se pudo determinar el padre absoluto del destino: {0}" -f $target)
        }
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            [void](New-Item -ItemType Directory -Path $parent -Force)
        }
        [System.IO.File]::Copy($entry.Source, $target, $true)
        $sourceHash = Get-AuditorFileSha256 -Path $entry.Source
        $targetHash = Get-AuditorFileSha256 -Path $target
        if ($sourceHash -ne $targetHash) {
            throw ("Verificación SHA-256 fallida al copiar el paquete: {0}" -f $relative)
        }
        $expected[$key] = [pscustomobject]@{ Relative = $relative; Hash = $sourceHash; Target = $target }
    }

    foreach ($item in $expected.Values) {
        if (-not (Test-Path -LiteralPath $item.Target -PathType Leaf)) {
            throw ("El paquete copiado no contiene una entrada esperada: {0}" -f $item.Relative)
        }
    }

    $actualCount = 0
    foreach ($file in Get-ChildItem -LiteralPath $destinationBase -File -Recurse -Force) {
        $relative = $file.FullName.Substring($destinationBase.Length).TrimStart('\')
        if ($relative.Equals('.auditor-install-owner', [StringComparison]::OrdinalIgnoreCase)) { continue }
        $relative = ConvertTo-AuditorSafePayloadRelativePath -RelativePath $relative
        $key = $relative.ToLowerInvariant()
        if (-not $expected.ContainsKey($key)) {
            throw ("El staging contiene una entrada inesperada: {0}" -f $relative)
        }
        if ((Get-AuditorFileSha256 -Path $file.FullName) -ne $expected[$key].Hash) {
            throw ("Verificación SHA-256 final fallida en el staging: {0}" -f $relative)
        }
        $actualCount++
    }
    if ($actualCount -ne $expected.Count) {
        throw ("El staging no coincide con el manifest cerrado: esperados={0}; reales={1}" -f $expected.Count, $actualCount)
    }

    foreach ($required in @(
        (Join-Path $destinationBase "app\dockerfile"),
        (Join-Path $destinationBase "installers\windows\install.ps1"),
        (Join-Path $destinationBase "installers\windows\docker-compose.windows.yml.example")
    )) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw ("El paquete copiado está incompleto: {0}" -f $required)
        }
    }
}

function New-AuditorStagedInstallation {
    param(
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )

    $install = ConvertTo-AuditorCanonicalWindowsPath -Value $InstallRoot
    $parent = Get-AuditorInstallationParentPath -InstallRoot $install
    if ([string]::IsNullOrWhiteSpace($parent)) {
        throw "No se pudo determinar el directorio padre de la instalación."
    }
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $parent -Force)
    }
    $token = [Guid]::NewGuid().ToString("N")
    $stagePath = Join-Path $parent ("AuditorIPsStage-" + $token)
    [void](New-Item -ItemType Directory -Path $stagePath -Force)
    Write-Utf8NoBom -Path (Join-Path $stagePath ".auditor-install-owner") -Text $token
    try {
        Copy-AuditorRepositoryPayload -SourceRoot $SourceRoot -DestinationRoot $stagePath
        return [pscustomobject]@{ Path = $stagePath; Token = $token }
    } catch {
        try { Remove-AuditorOwnedInstallation -Path $stagePath -Token $token } catch { }
        throw
    }
}

function Activate-AuditorStagedInstallation {
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Stage,
        [Parameter(Mandatory = $true)][string]$InstallRoot
    )
    if (Test-Path -LiteralPath $InstallRoot) {
        $items = @(Get-ChildItem -LiteralPath $InstallRoot -Force)
        if ($items.Count -gt 0) { throw "La ruta de instalación dejó de estar vacía durante la operación." }
        Remove-Item -LiteralPath $InstallRoot -Force
    }
    Move-Item -LiteralPath $Stage.Path -Destination $InstallRoot
}

function Remove-AuditorOwnedInstallation {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Token
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
    $marker = Join-Path $Path ".auditor-install-owner"
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
        throw ("Se rechaza eliminar una ruta sin marcador de propiedad: {0}" -f $Path)
    }
    if ([System.IO.File]::ReadAllText($marker).Trim() -ne $Token) {
        throw ("El marcador de propiedad no coincide: {0}" -f $Path)
    }
    Remove-Item -LiteralPath $Path -Recurse -Force
}

function Complete-AuditorOwnedInstallation {
    param([Parameter(Mandatory = $true)][string]$InstallRoot)
    Remove-Item -LiteralPath (Join-Path $InstallRoot ".auditor-install-owner") -Force -ErrorAction SilentlyContinue
}

function Update-AuditorEnvText {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][hashtable]$Values
    )
    $seen = @{}
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($Text -split "`r?`n")) {
        if ($line -match '^([A-Za-z_][A-Za-z0-9_]*)=') {
            $key = $matches[1]
            if ($Values.ContainsKey($key)) {
                $lines.Add(("{0}={1}" -f $key, [string]$Values[$key]))
                $seen[$key] = $true
                continue
            }
        }
        $lines.Add($line)
    }
    foreach ($key in ($Values.Keys | Sort-Object)) {
        if (-not $seen.ContainsKey($key)) {
            $lines.Add(("{0}={1}" -f $key, [string]$Values[$key]))
        }
    }
    return (($lines -join "`n").TrimEnd() + "`n")
}

function Resolve-AuditorHostPathFromEnv {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $windowsValue = $Value.Replace('/', '\')
    if ([System.IO.Path]::IsPathRooted($windowsValue)) {
        return [System.IO.Path]::GetFullPath($windowsValue)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $RepositoryRoot $windowsValue))
}

function Get-AuditorFileSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString("x2") })
    } finally {
        $stream.Dispose()
        $sha.Dispose()
    }
}

function Copy-AuditorDirectoryContentVerified {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { return }
    $sourceFull = [System.IO.Path]::GetFullPath($Source).TrimEnd('\')
    $destinationFull = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\')
    if ($sourceFull.Equals($destinationFull, [StringComparison]::OrdinalIgnoreCase)) { return }
    if ((Test-AuditorPathWithin -Path $destinationFull -Parent $sourceFull) -or
        (Test-AuditorPathWithin -Path $sourceFull -Parent $destinationFull)) {
        throw "El origen y el destino de contenido persistente no pueden contenerse entre sí."
    }
    [void](New-Item -ItemType Directory -Path $destinationFull -Force)
    foreach ($directory in Get-ChildItem -LiteralPath $sourceFull -Directory -Recurse -Force) {
        if (($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw ("Se rechaza un punto de reanálisis en contenido persistente: {0}" -f $directory.FullName)
        }
        $relative = $directory.FullName.Substring($sourceFull.Length).TrimStart('\')
        [void](New-Item -ItemType Directory -Path (Join-Path $destinationFull $relative) -Force)
    }
    foreach ($file in Get-ChildItem -LiteralPath $sourceFull -File -Recurse -Force) {
        if (($file.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw ("Se rechaza un punto de reanálisis en contenido persistente: {0}" -f $file.FullName)
        }
        $relative = $file.FullName.Substring($sourceFull.Length).TrimStart('\')
        $target = Join-Path $destinationFull $relative
        [void](New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force)
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            if ((Get-AuditorFileSha256 -Path $file.FullName) -ne (Get-AuditorFileSha256 -Path $target)) {
                throw ("Conflicto al copiar contenido persistente: {0}" -f $target)
            }
        } else {
            Copy-Item -LiteralPath $file.FullName -Destination $target
        }
        if ((Get-AuditorFileSha256 -Path $file.FullName) -ne (Get-AuditorFileSha256 -Path $target)) {
            throw ("Verificación SHA-256 fallida al copiar: {0}" -f $relative)
        }
    }
}

function Get-AuditorComposeWorkingDirectory {
    param([string]$ContainerName = "auditor_ips")
    $result = Invoke-AuditorNative -FilePath "docker.exe" -Arguments @(
        "inspect", $ContainerName, "--format", '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
    ) -AllowFailure -Quiet
    if ($result.ExitCode -ne 0 -or -not $result.StdOut.Trim()) {
        throw "No se pudo detectar el directorio Compose de la instalación activa. Usa -CurrentRoot."
    }
    return [System.IO.Path]::GetFullPath($result.StdOut.Trim())
}

function Assert-AuditorBindMounts {
    param(
        [Parameter(Mandatory = $true)][string]$RepositoryRoot,
        [Parameter(Mandatory = $true)][pscustomobject]$Storage
    )
    $mappings = @(
        [pscustomobject]@{ Host = $Storage.ExportsRoot; Container = "/data/exports"; Name = "exportaciones" },
        [pscustomobject]@{ Host = $Storage.BackupsRoot; Container = "/data/backups"; Name = "backups" },
        [pscustomobject]@{ Host = $Storage.DiagnosticsRoot; Container = "/data/diagnostics"; Name = "diagnósticos" }
    )
    foreach ($mapping in $mappings) {
        $name = ".auditor-bind-probe-" + [Guid]::NewGuid().ToString("N")
        $containerPath = $mapping.Container + "/" + $name
        $hostPath = Join-Path $mapping.Host $name
        $script = "from pathlib import Path; Path(r'$containerPath').write_text('auditor-bind-ok', encoding='utf-8')"
        try {
            Invoke-AuditorDocker -RepositoryRoot $RepositoryRoot -Arguments @(
                "compose", "exec", "-T", "auditor_ips", "python", "-c", $script
            ) -Quiet | Out-Null
            if (-not (Test-Path -LiteralPath $hostPath -PathType Leaf)) {
                throw ("El bind mount de {0} no es visible en el host." -f $mapping.Name)
            }
            if ([System.IO.File]::ReadAllText($hostPath).Trim() -ne "auditor-bind-ok") {
                throw ("El bind mount de {0} no conserva el contenido esperado." -f $mapping.Name)
            }
        } finally {
            Remove-Item -LiteralPath $hostPath -Force -ErrorAction SilentlyContinue
        }
        Write-AuditorOk ("Bind mount verificado: {0}" -f $mapping.Name)
    }
}
