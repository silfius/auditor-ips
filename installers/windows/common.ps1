Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

function Initialize-AuditorConsole {
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [Console]::InputEncoding = $utf8
        [Console]::OutputEncoding = $utf8
        $global:OutputEncoding = $utf8
    } catch {
    }
}

function Write-AuditorSection {
    param([string]$Title)
    Write-Host ""
    Write-Host ("== {0} ==" -f $Title) -ForegroundColor Cyan
}

function ConvertTo-AuditorArchitectureName {
    param([AllowNull()]$Value)

    $text = ([string]$Value).Trim().ToUpperInvariant()
    switch ($text) {
        "AMD64" { return "X64" }
        "X64" { return "X64" }
        "X86_64" { return "X64" }
        "ARM64" { return "ARM64" }
        "AARCH64" { return "ARM64" }
        "X86" { return "X86" }
        "I386" { return "X86" }
        "I686" { return "X86" }
        "ARM" { return "ARM" }
        "MIXED" { return "MIXED" }
        default { return $text }
    }
}

function Get-AuditorWindowsPlatformInfo {
    $runtimeRaw = ""
    try {
        $runtimeRaw = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    } catch {
    }

    $environmentRaw = if (-not [string]::IsNullOrWhiteSpace([string]$env:PROCESSOR_ARCHITEW6432)) {
        [string]$env:PROCESSOR_ARCHITEW6432
    } else {
        [string]$env:PROCESSOR_ARCHITECTURE
    }

    $processorRaw = ""
    try {
        $processorCodes = @(
            Get-CimInstance Win32_Processor -ErrorAction Stop |
            ForEach-Object { [int]$_.Architecture } |
            Select-Object -Unique
        )
        if ($processorCodes.Count -eq 1) {
            $processorRaw = switch ($processorCodes[0]) {
                0 { "X86" }
                5 { "ARM" }
                9 { "X64" }
                12 { "ARM64" }
                default { "UNKNOWN_{0}" -f $processorCodes[0] }
            }
        } elseif ($processorCodes.Count -gt 1) {
            $processorRaw = "MIXED"
        }
    } catch {
    }

    return [pscustomobject]@{
        IsWindows = ($env:OS -eq "Windows_NT")
        Build = [int][Environment]::OSVersion.Version.Build
        Is64BitOperatingSystem = [bool][Environment]::Is64BitOperatingSystem
        RuntimeArchitecture = ConvertTo-AuditorArchitectureName -Value $runtimeRaw
        EnvironmentArchitecture = ConvertTo-AuditorArchitectureName -Value $environmentRaw
        ProcessorArchitecture = ConvertTo-AuditorArchitectureName -Value $processorRaw
        RuntimeArchitectureRaw = $runtimeRaw
        EnvironmentArchitectureRaw = $environmentRaw
        ProcessorArchitectureRaw = $processorRaw
    }
}

function Assert-AuditorWindows11Amd64 {
    param([AllowNull()][pscustomobject]$PlatformInfo = $null)

    if ($null -eq $PlatformInfo) {
        $PlatformInfo = Get-AuditorWindowsPlatformInfo
    }
    if (-not $PlatformInfo.IsWindows) {
        throw "Este componente solo admite Windows."
    }
    if (-not $PlatformInfo.Is64BitOperatingSystem) {
        throw "Se requiere Windows 11 de 64 bits sobre arquitectura AMD64/x86-64."
    }
    if ([int]$PlatformInfo.Build -lt 22631) {
        throw ("Se requiere Windows 11 23H2 o posterior (build 22631+). Build detectada: {0}." -f $PlatformInfo.Build)
    }

    $evidence = New-Object System.Collections.Generic.List[string]
    foreach ($item in @(
        [pscustomobject]@{ Name = "Runtime"; Value = [string]$PlatformInfo.RuntimeArchitecture },
        [pscustomobject]@{ Name = "Entorno"; Value = [string]$PlatformInfo.EnvironmentArchitecture },
        [pscustomobject]@{ Name = "Procesador"; Value = [string]$PlatformInfo.ProcessorArchitecture }
    )) {
        if ([string]::IsNullOrWhiteSpace($item.Value)) { continue }
        $evidence.Add(("{0}={1}" -f $item.Name, $item.Value))
        if ($item.Value -ne "X64") {
            throw ("Arquitectura no compatible: {0}. Se requiere Windows 11 AMD64/x86-64; ARM64 y x86 no están soportados." -f ($evidence -join ", "))
        }
    }
    if ($evidence.Count -lt 2) {
        throw ("No se pudo acreditar la arquitectura nativa AMD64 con evidencia suficiente. Evidencias: {0}." -f ($evidence -join ", "))
    }
    return $PlatformInfo
}

function Write-AuditorOk {
    param([string]$Message)
    Write-Host ("  OK    {0}" -f $Message) -ForegroundColor Green
}

function Write-AuditorWarning {
    param([string]$Message)
    Write-Host ("  AVISO {0}" -f $Message) -ForegroundColor Yellow
}

function Get-AuditorRepositoryRoot {
    param([string]$Override = "")
    if ($Override) {
        return [System.IO.Path]::GetFullPath($Override)
    }
    return [System.IO.Path]::GetFullPath(
        (Join-Path $PSScriptRoot "..\..")
    )
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )
    [System.IO.File]::WriteAllText(
        $Path,
        $Text,
        (New-Object System.Text.UTF8Encoding($false))
    )
}

function Convert-ToNativeArgument {
    param([AllowEmptyString()][string]$Value)
    if ($null -eq $Value -or $Value.Length -eq 0) {
        return '""'
    }
    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    $builder = New-Object System.Text.StringBuilder
    [void]$builder.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $slashes++
            continue
        }
        if ($character -eq '"') {
            if ($slashes -gt 0) {
                [void]$builder.Append(('\' * ($slashes * 2)))
                $slashes = 0
            }
            [void]$builder.Append('\"')
            continue
        }
        if ($slashes -gt 0) {
            [void]$builder.Append(('\' * $slashes))
            $slashes = 0
        }
        [void]$builder.Append($character)
    }
    if ($slashes -gt 0) {
        [void]$builder.Append(('\' * ($slashes * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function Invoke-AuditorNative {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = "",
        [switch]$AllowFailure,
        [switch]$Quiet
    )

    $encoded = New-Object System.Collections.Generic.List[string]
    foreach ($argument in $Arguments) {
        $encoded.Add((Convert-ToNativeArgument ([string]$argument)))
    }

    $token = [Guid]::NewGuid().ToString("N")
    $stdoutPath = Join-Path ([System.IO.Path]::GetTempPath()) ($token + ".stdout")
    $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) ($token + ".stderr")
    $process = $null
    $stdout = ""
    $stderr = ""
    try {
        $start = @{
            FilePath = $FilePath
            ArgumentList = ($encoded -join " ")
            NoNewWindow = $true
            Wait = $true
            PassThru = $true
            RedirectStandardOutput = $stdoutPath
            RedirectStandardError = $stderrPath
        }
        if ($WorkingDirectory) {
            $start["WorkingDirectory"] = $WorkingDirectory
        }
        try {
            $process = Start-Process @start
        } catch {
            if (-not $AllowFailure) { throw }
            return [pscustomobject]@{
                ExitCode = 127
                StdOut = ""
                StdErr = $_.Exception.Message
            }
        }
        $stdout = if (Test-Path -LiteralPath $stdoutPath) {
            [System.IO.File]::ReadAllText($stdoutPath)
        } else { "" }
        $stderr = if (Test-Path -LiteralPath $stderrPath) {
            [System.IO.File]::ReadAllText($stderrPath)
        } else { "" }

        if (-not $Quiet) {
            if ($stdout.Trim()) { Write-Host $stdout.TrimEnd() }
            if ($stderr.Trim()) { Write-Host $stderr.TrimEnd() }
        }
        if ($process.ExitCode -ne 0 -and -not $AllowFailure) {
            throw ("Comando fallido rc={0}: {1} {2}`nSTDOUT:`n{3}`nSTDERR:`n{4}" -f
                $process.ExitCode, $FilePath, ($Arguments -join " "), $stdout, $stderr)
        }
        return [pscustomobject]@{
            ExitCode = [int]$process.ExitCode
            StdOut = $stdout
            StdErr = $stderr
        }
    } finally {
        Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Invoke-AuditorDocker {
    param(
        [string[]]$Arguments,
        [string]$RepositoryRoot,
        [switch]$AllowFailure,
        [switch]$Quiet
    )
    return Invoke-AuditorNative -FilePath "docker.exe" -Arguments $Arguments `
        -WorkingDirectory $RepositoryRoot -AllowFailure:$AllowFailure -Quiet:$Quiet
}

function Assert-IPv4Address {
    param([string]$Value, [string]$Name)

    if ($Value -notmatch '^\d{1,3}(?:\.\d{1,3}){3}$') {
        throw ("{0} no es una IPv4 válida: {1}" -f $Name, $Value)
    }

    foreach ($part in $Value.Split('.')) {
        $octet = 0
        if (-not [int]::TryParse($part, [ref]$octet) -or
            $octet -lt 0 -or $octet -gt 255) {
            throw ("{0} no es una IPv4 válida: {1}" -f $Name, $Value)
        }
    }
}

function Test-AuditorUsableIPv4Address {
    param([string]$Value)

    try {
        Assert-IPv4Address -Value $Value -Name "IPv4"
    } catch {
        return $false
    }

    $octets = @($Value.Split('.') | ForEach-Object { [int]$_ })
    if ($octets[0] -eq 0 -or
        $octets[0] -eq 127 -or
        $octets[0] -ge 224 -or
        ($octets[0] -eq 169 -and $octets[1] -eq 254) -or
        $Value -eq "255.255.255.255") {
        return $false
    }
    return $true
}

function Test-AuditorPrivateIPv4Address {
    param([string]$Value)
    if (-not (Test-AuditorUsableIPv4Address -Value $Value)) {
        return $false
    }
    $octets = @($Value.Split('.') | ForEach-Object { [int]$_ })
    return (
        $octets[0] -eq 10 -or
        ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or
        ($octets[0] -eq 192 -and $octets[1] -eq 168)
    )
}

function Get-AuditorIPv4NetworkInfo {
    param(
        [Parameter(Mandatory = $true)][string]$IpAddress,
        [Parameter(Mandatory = $true)][int]$PrefixLength
    )

    Assert-IPv4Address -Value $IpAddress -Name "IPv4"
    if ($PrefixLength -lt 0 -or $PrefixLength -gt 32) {
        throw ("Prefijo CIDR inválido: {0}" -f $PrefixLength)
    }

    $ipBytes = [System.Net.IPAddress]::Parse($IpAddress).GetAddressBytes()
    $maskBytes = New-Object byte[] 4
    $networkBytes = New-Object byte[] 4

    for ($index = 0; $index -lt 4; $index++) {
        $remaining = $PrefixLength - ($index * 8)
        $bits = [Math]::Min(8, [Math]::Max(0, $remaining))
        $mask = if ($bits -eq 0) {
            0
        } elseif ($bits -eq 8) {
            255
        } else {
            256 - [int][Math]::Pow(2, 8 - $bits)
        }
        $maskBytes[$index] = [byte]$mask
        $networkBytes[$index] = [byte]($ipBytes[$index] -band $mask)
    }

    $network = ($networkBytes -join ".")
    $maskText = ($maskBytes -join ".")
    return [pscustomobject]@{
        IpAddress = $IpAddress
        PrefixLength = $PrefixLength
        NetworkAddress = $network
        Cidr = ("{0}/{1}" -f $network, $PrefixLength)
        Mask = $maskText
    }
}

function ConvertTo-AuditorCanonicalCidr {
    param([Parameter(Mandatory = $true)][string]$Value)

    $parts = $Value.Trim().Split('/')
    if ($parts.Count -ne 2) {
        throw "La red debe usar formato IPv4/prefijo, por ejemplo 192.168.1.0/24."
    }

    Assert-IPv4Address -Value $parts[0] -Name "Red"
    $prefix = 0
    if (-not [int]::TryParse($parts[1], [ref]$prefix) -or
        $prefix -lt 0 -or $prefix -gt 32) {
        throw ("Prefijo CIDR inválido: {0}" -f $parts[1])
    }

    return (Get-AuditorIPv4NetworkInfo `
        -IpAddress $parts[0] `
        -PrefixLength $prefix).Cidr
}

function Assert-IPv4Cidr {
    param([string]$Value)
    [void](ConvertTo-AuditorCanonicalCidr -Value $Value)
}

function ConvertTo-AuditorProfileLabel {
    param([string]$Profile)
    switch ($Profile) {
        "Private" { return "Privado" }
        "Public" { return "Público" }
        "DomainAuthenticated" { return "Dominio" }
        default { return "Desconocido" }
    }
}

function New-AuditorIPv4Candidate {
    param(
        [Parameter(Mandatory = $true)][string]$InterfaceAlias,
        [string]$InterfaceDescription = "",
        [Parameter(Mandatory = $true)][string]$IpAddress,
        [Parameter(Mandatory = $true)][int]$PrefixLength,
        [string]$Gateway = "",
        [string]$Profile = "Unknown",
        [int]$InterfaceMetric = 9999,
        [bool]$Virtual = $false
    )

    if (-not (Test-AuditorUsableIPv4Address -Value $IpAddress)) {
        throw ("IPv4 no utilizable: {0}" -f $IpAddress)
    }

    $network = Get-AuditorIPv4NetworkInfo `
        -IpAddress $IpAddress `
        -PrefixLength $PrefixLength
    $combinedName = ("{0} {1}" -f $InterfaceAlias, $InterfaceDescription)
    $looksVirtual = (
        $Virtual -or
        $combinedName -match '(?i)vEthernet|Hyper-V|Docker|WSL|Loopback|VirtualBox|VMware|Npcap|Teredo|isatap|VPN|WireGuard|TAP-Windows|OpenVPN|Tailscale|NetBird|ZeroTier|Hamachi'
    )
    $hasGateway = -not [string]::IsNullOrWhiteSpace($Gateway)
    $isPrivate = Test-AuditorPrivateIPv4Address -Value $IpAddress
    $profileLabel = ConvertTo-AuditorProfileLabel -Profile $Profile

    $score = 0
    if ($hasGateway) { $score += 100 }
    if ($isPrivate) { $score += 40 }
    if ($Profile -eq "Private") { $score += 30 }
    if ($Profile -eq "DomainAuthenticated") { $score += 25 }
    if ($looksVirtual) { $score -= 150 } else { $score += 20 }
    if ($InterfaceMetric -lt 9999) {
        $score += [Math]::Max(0, 20 - [Math]::Min(20, $InterfaceMetric))
    }

    return [pscustomobject]@{
        InterfaceAlias = $InterfaceAlias
        InterfaceDescription = $InterfaceDescription
        IpAddress = $IpAddress
        PrefixLength = $PrefixLength
        Cidr = $network.Cidr
        Mask = $network.Mask
        Gateway = $Gateway
        Profile = $Profile
        ProfileLabel = $profileLabel
        InterfaceMetric = $InterfaceMetric
        Virtual = $looksVirtual
        HasGateway = $hasGateway
        PrivateAddress = $isPrivate
        Recommended = (
            -not $looksVirtual -and
            $hasGateway -and
            $isPrivate -and
            ($Profile -eq "Private" -or $Profile -eq "DomainAuthenticated")
        )
        Score = $score
    }
}

function Sort-AuditorIPv4Candidates {
    param([object[]]$Candidates)
    return @(
        $Candidates |
        Sort-Object `
            @{ Expression = { $_.Score }; Descending = $true },
            @{ Expression = { $_.InterfaceMetric }; Ascending = $true },
            @{ Expression = { $_.InterfaceAlias }; Ascending = $true },
            @{ Expression = { $_.IpAddress }; Ascending = $true }
    )
}

function Get-AuditorRecommendedCandidateIndex {
    param([object[]]$Candidates)
    for ($index = 0; $index -lt $Candidates.Count; $index++) {
        if ($Candidates[$index].Recommended) {
            return ($index + 1)
        }
    }
    for ($index = 0; $index -lt $Candidates.Count; $index++) {
        if (-not $Candidates[$index].Virtual -and $Candidates[$index].HasGateway) {
            return ($index + 1)
        }
    }
    if ($Candidates.Count -gt 0) { return 1 }
    return 0
}

function Get-AuditorIPv4Candidates {
    $candidates = New-Object System.Collections.Generic.List[object]
    $seen = @{}

    try {
        $configurations = @(Get-NetIPConfiguration -ErrorAction Stop)
    } catch {
        Write-AuditorWarning (
            "No se pudieron enumerar las interfaces automáticamente: {0}" -f
            $_.Exception.Message
        )
        return @()
    }

    foreach ($configuration in $configurations) {
        $adapter = $configuration.NetAdapter
        if ($null -eq $adapter) {
            try {
                $adapter = Get-NetAdapter `
                    -InterfaceIndex $configuration.InterfaceIndex `
                    -ErrorAction Stop
            } catch {
                $adapter = $null
            }
        }

        if ($null -ne $adapter -and
            $adapter.PSObject.Properties.Name -contains "Status" -and
            [string]$adapter.Status -ne "Up") {
            continue
        }

        $alias = [string]$configuration.InterfaceAlias
        if (-not $alias -and $null -ne $adapter) {
            $alias = [string]$adapter.Name
        }
        if (-not $alias) {
            $alias = ("Interfaz {0}" -f $configuration.InterfaceIndex)
        }

        $description = ""
        $virtual = $false
        if ($null -ne $adapter) {
            $description = [string]$adapter.InterfaceDescription
            if ($adapter.PSObject.Properties.Name -contains "Virtual") {
                $virtual = [bool]$adapter.Virtual
            }
        }

        $profile = "Unknown"
        try {
            $profileObject = Get-NetConnectionProfile `
                -InterfaceIndex $configuration.InterfaceIndex `
                -ErrorAction Stop |
                Select-Object -First 1
            if ($null -ne $profileObject) {
                $profile = [string]$profileObject.NetworkCategory
            }
        } catch {
        }

        $metric = 9999
        if ($null -ne $configuration.NetIPv4Interface -and
            $configuration.NetIPv4Interface.PSObject.Properties.Name -contains "InterfaceMetric") {
            $metric = [int]$configuration.NetIPv4Interface.InterfaceMetric
        }

        $gateway = ""
        $gateways = @($configuration.IPv4DefaultGateway)
        if ($gateways.Count -gt 0 -and $null -ne $gateways[0]) {
            $gateway = [string]$gateways[0].NextHop
        }

        foreach ($address in @($configuration.IPv4Address)) {
            if ($null -eq $address) { continue }
            $ip = [string]$address.IPAddress
            if (-not (Test-AuditorUsableIPv4Address -Value $ip)) { continue }
            if ($seen.ContainsKey($ip)) { continue }

            $prefix = [int]$address.PrefixLength
            $candidate = New-AuditorIPv4Candidate `
                -InterfaceAlias $alias `
                -InterfaceDescription $description `
                -IpAddress $ip `
                -PrefixLength $prefix `
                -Gateway $gateway `
                -Profile $profile `
                -InterfaceMetric $metric `
                -Virtual $virtual
            $seen[$ip] = $true
            $candidates.Add($candidate)
        }
    }

    return @(Sort-AuditorIPv4Candidates -Candidates $candidates.ToArray())
}

function Read-AuditorInput {
    param(
        [Parameter(Mandatory = $true)][string]$Prompt,
        [scriptblock]$InputProvider = $null
    )
    if ($null -ne $InputProvider) {
        return [string](& $InputProvider $Prompt)
    }
    return [string](Read-Host $Prompt)
}

function Read-AuditorValidatedIPv4 {
    param(
        [string]$Prompt = "IPv4 del equipo accesible desde la LAN (ejemplo: 192.168.1.35)",
        [scriptblock]$InputProvider = $null
    )
    while ($true) {
        $value = (Read-AuditorInput -Prompt $Prompt -InputProvider $InputProvider).Trim()
        if ($value -eq "0") { throw "Operación cancelada por el usuario." }
        if (Test-AuditorUsableIPv4Address -Value $value) {
            return $value
        }
        Write-AuditorWarning (
            "Entrada no válida. Escribe una IPv4, por ejemplo 192.168.1.35, o 0 para cancelar."
        )
    }
}

function Read-AuditorValidatedCidr {
    param(
        [string]$Prompt = "Red que analizará Auditor IPs (ejemplo: 192.168.1.0/24)",
        [scriptblock]$InputProvider = $null
    )
    while ($true) {
        $value = (Read-AuditorInput -Prompt $Prompt -InputProvider $InputProvider).Trim()
        if ($value -eq "0") { throw "Operación cancelada por el usuario." }
        try {
            $canonical = ConvertTo-AuditorCanonicalCidr -Value $value
            if ($canonical -ne $value) {
                Write-AuditorWarning (
                    "La red se ha normalizado a {0}." -f $canonical
                )
            }
            return $canonical
        } catch {
            Write-AuditorWarning (
                "Entrada no válida. Usa red/prefijo, por ejemplo 192.168.1.0/24, o 0 para cancelar."
            )
        }
    }
}

function Write-AuditorIPv4Candidates {
    param([object[]]$Candidates)

    Write-AuditorSection "Selección de la conexión del servidor"
    Write-Host "Se han detectado estas IPv4 activas del equipo:"
    Write-Host ""

    $recommended = Get-AuditorRecommendedCandidateIndex -Candidates $Candidates
    for ($index = 0; $index -lt $Candidates.Count; $index++) {
        $candidate = $Candidates[$index]
        $labels = New-Object System.Collections.Generic.List[string]
        if (($index + 1) -eq $recommended) { $labels.Add("RECOMENDADA") }
        if ($candidate.Virtual) { $labels.Add("VIRTUAL/AVANZADA") }
        if ($candidate.ProfileLabel -eq "Público") { $labels.Add("PERFIL PÚBLICO") }
        $suffix = if ($labels.Count -gt 0) {
            " [" + ($labels -join ", ") + "]"
        } else { "" }

        Write-Host ("  [{0}] {1}{2}" -f ($index + 1), $candidate.InterfaceAlias, $suffix)
        Write-Host ("      IP:               {0}" -f $candidate.IpAddress)
        Write-Host ("      Red:              {0}" -f $candidate.Cidr)
        Write-Host ("      Máscara:          {0}" -f $candidate.Mask)
        Write-Host ("      Puerta de enlace: {0}" -f $(if ($candidate.Gateway) { $candidate.Gateway } else { "No detectada" }))
        Write-Host ("      Perfil:           {0}" -f $candidate.ProfileLabel)
        Write-Host ""
    }
}

function Select-AuditorServerNetwork {
    param(
        [object[]]$Candidates,
        [scriptblock]$InputProvider = $null
    )

    if ($Candidates.Count -eq 0) {
        Write-AuditorWarning "No se detectaron IPv4 utilizables. Se solicitará la dirección manualmente."
        $manualIp = Read-AuditorValidatedIPv4 -InputProvider $InputProvider
        return [pscustomobject]@{
            InterfaceAlias = "Introducción manual"
            IpAddress = $manualIp
            PrefixLength = $null
            Cidr = ""
            Mask = ""
            Gateway = ""
            Profile = "Manual"
            ProfileLabel = "Manual"
            Virtual = $false
            Recommended = $false
            Score = 0
        }
    }

    Write-AuditorIPv4Candidates -Candidates $Candidates
    $recommended = Get-AuditorRecommendedCandidateIndex -Candidates $Candidates
    $manualOption = $Candidates.Count + 1
    Write-Host ("  [{0}] Introducir otra IPv4 manualmente" -f $manualOption)
    Write-Host "  [0] Cancelar"
    Write-Host ""

    while ($true) {
        $defaultText = if ($recommended -gt 0) { " [{0}]" -f $recommended } else { "" }
        $raw = (Read-AuditorInput `
            -Prompt ("Selecciona la conexión que utilizará Auditor IPs{0}" -f $defaultText) `
            -InputProvider $InputProvider).Trim()
        if (-not $raw -and $recommended -gt 0) {
            return $Candidates[$recommended - 1]
        }

        $choice = -1
        if (-not [int]::TryParse($raw, [ref]$choice)) {
            Write-AuditorWarning "Selección no válida. Escribe el número de una opción."
            continue
        }
        if ($choice -eq 0) { throw "Operación cancelada por el usuario." }
        if ($choice -eq $manualOption) {
            $manualIp = Read-AuditorValidatedIPv4 -InputProvider $InputProvider
            return [pscustomobject]@{
                InterfaceAlias = "Introducción manual"
                IpAddress = $manualIp
                PrefixLength = $null
                Cidr = ""
                Mask = ""
                Gateway = ""
                Profile = "Manual"
                ProfileLabel = "Manual"
                Virtual = $false
                Recommended = $false
                Score = 0
            }
        }
        if ($choice -ge 1 -and $choice -le $Candidates.Count) {
            return $Candidates[$choice - 1]
        }
        Write-AuditorWarning "Selección fuera de rango."
    }
}

function Select-AuditorScanCidr {
    param(
        [Parameter(Mandatory = $true)][object]$ServerCandidate,
        [object[]]$Candidates,
        [scriptblock]$InputProvider = $null
    )

    $networks = New-Object System.Collections.Generic.List[object]
    $seen = @{}

    if ($ServerCandidate.Cidr) {
        $networks.Add([pscustomobject]@{
            Cidr = $ServerCandidate.Cidr
            Mask = $ServerCandidate.Mask
            Interfaces = $ServerCandidate.InterfaceAlias
            Recommended = $true
        })
        $seen[$ServerCandidate.Cidr] = $true
    }

    foreach ($candidate in $Candidates) {
        if (-not $candidate.Cidr -or $seen.ContainsKey($candidate.Cidr)) {
            continue
        }
        $networks.Add([pscustomobject]@{
            Cidr = $candidate.Cidr
            Mask = $candidate.Mask
            Interfaces = $candidate.InterfaceAlias
            Recommended = $false
        })
        $seen[$candidate.Cidr] = $true
    }

    Write-AuditorSection "Red que analizará Auditor IPs"
    if ($networks.Count -gt 0) {
        Write-Host "Selecciona una red detectada o introdúcela manualmente:"
        Write-Host ""
        for ($index = 0; $index -lt $networks.Count; $index++) {
            $network = $networks[$index]
            $suffix = if ($network.Recommended) { " [MISMA RED · RECOMENDADA]" } else { "" }
            Write-Host ("  [{0}] {1}{2}" -f ($index + 1), $network.Cidr, $suffix)
            Write-Host ("      Máscara:   {0}" -f $network.Mask)
            Write-Host ("      Interfaz:  {0}" -f $network.Interfaces)
        }
        $manualOption = $networks.Count + 1
        Write-Host ("  [{0}] Introducir otra red manualmente" -f $manualOption)
        Write-Host "  [0] Cancelar"
        Write-Host ""

        while ($true) {
            $default = if ($networks.Count -gt 0) { " [1]" } else { "" }
            $raw = (Read-AuditorInput `
                -Prompt ("Selecciona la red que debe escanear Auditor IPs{0}" -f $default) `
                -InputProvider $InputProvider).Trim()
            if (-not $raw -and $networks.Count -gt 0) {
                return $networks[0].Cidr
            }
            $choice = -1
            if (-not [int]::TryParse($raw, [ref]$choice)) {
                Write-AuditorWarning "Selección no válida. Escribe el número de una opción."
                continue
            }
            if ($choice -eq 0) { throw "Operación cancelada por el usuario." }
            if ($choice -eq $manualOption) {
                return Read-AuditorValidatedCidr -InputProvider $InputProvider
            }
            if ($choice -ge 1 -and $choice -le $networks.Count) {
                return $networks[$choice - 1].Cidr
            }
            Write-AuditorWarning "Selección fuera de rango."
        }
    }

    Write-AuditorWarning "No se pudo deducir una red desde la IPv4 elegida."
    return Read-AuditorValidatedCidr -InputProvider $InputProvider
}

function Resolve-AuditorNetworkConfiguration {
    param(
        [string]$ServerIp = "",
        [string]$ScanCidr = "",
        [switch]$NonInteractive,
        [scriptblock]$InputProvider = $null
    )

    if ($NonInteractive) {
        if (-not $ServerIp) { throw "-ServerIp es obligatorio en modo no interactivo." }
        if (-not $ScanCidr) { throw "-ScanCidr es obligatorio en modo no interactivo." }
        if (-not (Test-AuditorUsableIPv4Address -Value $ServerIp)) {
            throw ("ServerIp no es una IPv4 utilizable: {0}" -f $ServerIp)
        }
        $canonical = ConvertTo-AuditorCanonicalCidr -Value $ScanCidr
        $networkInfo = Get-AuditorIPv4NetworkInfo `
            -IpAddress $canonical.Split('/')[0] `
            -PrefixLength ([int]$canonical.Split('/')[1])
        return [pscustomobject]@{
            ServerIp = $ServerIp
            ScanCidr = $canonical
            ScanMask = $networkInfo.Mask
            InterfaceAlias = "Parámetros"
            Gateway = ""
            ProfileLabel = "No consultado"
            Candidates = @()
        }
    }

    $candidates = @(Get-AuditorIPv4Candidates)
    $selected = $null

    if ($ServerIp) {
        if (-not (Test-AuditorUsableIPv4Address -Value $ServerIp)) {
            throw ("ServerIp no es una IPv4 utilizable: {0}" -f $ServerIp)
        }
        $selected = $candidates |
            Where-Object { $_.IpAddress -eq $ServerIp } |
            Select-Object -First 1
        if ($null -eq $selected) {
            Write-AuditorWarning (
                "La IPv4 indicada no coincide con una interfaz detectada; se tratará como entrada manual."
            )
            $selected = [pscustomobject]@{
                InterfaceAlias = "Introducción manual"
                IpAddress = $ServerIp
                PrefixLength = $null
                Cidr = ""
                Mask = ""
                Gateway = ""
                Profile = "Manual"
                ProfileLabel = "Manual"
                Virtual = $false
                Recommended = $false
                Score = 0
            }
        }
    } else {
        $selected = Select-AuditorServerNetwork `
            -Candidates $candidates `
            -InputProvider $InputProvider
    }

    $resolvedCidr = if ($ScanCidr) {
        ConvertTo-AuditorCanonicalCidr -Value $ScanCidr
    } else {
        Select-AuditorScanCidr `
            -ServerCandidate $selected `
            -Candidates $candidates `
            -InputProvider $InputProvider
    }
    $parts = $resolvedCidr.Split('/')
    $scanInfo = Get-AuditorIPv4NetworkInfo `
        -IpAddress $parts[0] `
        -PrefixLength ([int]$parts[1])

    return [pscustomobject]@{
        ServerIp = $selected.IpAddress
        ScanCidr = $resolvedCidr
        ScanMask = $scanInfo.Mask
        InterfaceAlias = $selected.InterfaceAlias
        Gateway = $selected.Gateway
        ProfileLabel = $selected.ProfileLabel
        Candidates = $candidates
    }
}

function Assert-DnsName {
    param([string]$Value)
    if ($Value -notmatch '^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
        throw "Nombre DNS inválido: $Value"
    }
}

function Test-TcpPortFree {
    param([int]$Port)
    $listener = $null
    try {
        $listener = New-Object -TypeName System.Net.Sockets.TcpListener `
            -ArgumentList @([System.Net.IPAddress]::Any, $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $listener) { $listener.Stop() }
    }
}

function Read-AuditorEnv {
    param([string]$Path)
    $result = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $result }
    foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
        if (-not $line -or $line.TrimStart().StartsWith('#') -or $line -notmatch '=') { continue }
        $pair = $line.Split('=', 2)
        $result[$pair[0].Trim()] = $pair[1]
    }
    return $result
}

function Wait-AuditorHealth {
    param([int]$Port, [int]$Attempts = 45)
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $probe = Invoke-AuditorNative -FilePath "curl.exe" -Arguments @(
            "-k", "-fsS", "--max-time", "5",
            ("https://127.0.0.1:{0}/api/system/healthz" -f $Port)
        ) -AllowFailure -Quiet
        if ($probe.ExitCode -eq 0 -and $probe.StdOut -match '"ok"\s*:\s*true') {
            Write-AuditorOk ("healthz respondió en el intento {0}" -f $attempt)
            return
        }
        Start-Sleep -Seconds 2
    }
    throw "healthz no respondió correctamente. Ejecuta diagnose.ps1."
}

function Assert-AuditorTlsSan {
    param([string]$RepositoryRoot, [string]$ServerIp, [string]$DnsName)
    $result = Invoke-AuditorDocker -RepositoryRoot $RepositoryRoot -Arguments @(
        "compose", "exec", "-T", "auditor_ips", "openssl", "x509",
        "-in", "/data/certs/server.crt", "-noout", "-ext", "subjectAltName"
    ) -Quiet
    foreach ($required in @(
        "DNS:localhost",
        ("DNS:{0}" -f $DnsName),
        "IP Address:127.0.0.1",
        ("IP Address:{0}" -f $ServerIp)
    )) {
        if ($result.StdOut -notlike ("*{0}*" -f $required)) {
            throw ("El certificado TLS no contiene el SAN requerido: {0}" -f $required)
        }
    }
    Write-AuditorOk "SAN TLS verificados"
}

function New-AuditorZip {
    param([string]$SourceDirectory, [string]$DestinationZip)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $DestinationZip) {
        Remove-Item -LiteralPath $DestinationZip -Force
    }
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $SourceDirectory,
        $DestinationZip,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )
}
