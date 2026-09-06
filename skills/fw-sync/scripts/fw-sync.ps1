[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'new', 'pull', 'push', 'verify')]
    [string]$Action = 'status',

    [string]$ProjectRoot = (Get-Location).Path,

    [Alias('FwPath')]
    [string]$FwcPath,

    [string]$FwePath,

    [string]$FwaPath,

    [string]$FwsPath,

    [Alias('FwUrl')]
    [string]$FwcUrl = 'https://github.com/fiofiogamestudio/fwc.git',

    [string]$FweUrl = 'https://github.com/fiofiogamestudio/fwe.git',

    [string]$FwaUrl = 'https://github.com/fiofiogamestudio/fwa.git',

    [string]$FwsUrl = 'https://github.com/fiofiogamestudio/fws.git',

    [Alias('FwTarget')]
    [string]$FwcTarget = 'main',

    [string]$FweTarget = 'main',

    [string]$FwaTarget = 'main',

    [string]$FwsTarget = 'main',

    [ValidateSet('all', 'fw', 'fwc', 'fwe', 'fwa', 'fws')]
    [string]$Component = 'all',

    [switch]$Fetch,

    [switch]$Apply,

    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$explicitParameters = @{} + $PSBoundParameters
$mutationAttempted = $false
if ($Component -eq 'fw') { $Component = 'fwc' }

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,

        [Parameter(Mandatory = $true)]
        [string[]]$GitArguments,

        [switch]$AllowFailure
    )

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $rawOutput = & git -C $WorkingDirectory @GitArguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    $lines = @($rawOutput | ForEach-Object { $_.ToString() })

    if ($exitCode -ne 0 -and -not $AllowFailure) {
        $detail = ($lines -join [Environment]::NewLine).Trim()
        throw "git $($GitArguments -join ' ') failed in '$WorkingDirectory' (exit $exitCode).`n$detail"
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Lines = $lines
        Text = ($lines -join "`n").Trim()
    }
}

function Get-OptionalGitText {
    param(
        [string]$WorkingDirectory,
        [string[]]$GitArguments
    )

    $result = Invoke-Git -WorkingDirectory $WorkingDirectory -GitArguments $GitArguments -AllowFailure
    if ($result.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($result.Text)) {
        return $null
    }

    return $result.Text
}

function Assert-RepositoryUnchanged {
    param([string]$Path, [string]$Head, [string]$Branch)
    $currentHead = Get-OptionalGitText -WorkingDirectory $Path -GitArguments @('rev-parse', '--verify', 'HEAD^{commit}')
    $currentBranch = Get-OptionalGitText -WorkingDirectory $Path -GitArguments @('branch', '--show-current')
    if (-not $currentBranch) { $currentBranch = '(detached)' }
    $dirty = Invoke-Git -WorkingDirectory $Path -GitArguments @('status', '--porcelain=v1', '--untracked-files=normal')
    if ($currentHead -ne $Head -or $currentBranch -ne $Branch -or $dirty.Text) {
        throw "Repository changed after preflight: '$Path'. No further write was attempted."
    }
}

function Test-GitWorktree {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        return $false
    }

    $result = Invoke-Git -WorkingDirectory $Path -GitArguments @(
        'rev-parse', '--is-inside-work-tree'
    ) -AllowFailure
    if ($result.ExitCode -ne 0 -or $result.Text -ne 'true') { return $false }
    $top = Get-OptionalGitText -WorkingDirectory $Path -GitArguments @('rev-parse', '--show-toplevel')
    return $top -and [System.IO.Path]::GetFullPath($top).TrimEnd('\', '/') -eq [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Normalize-RelativePath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    $normalized = ($Path.Trim() -replace '\\', '/')
    while ($normalized.StartsWith('./')) {
        $normalized = $normalized.Substring(2)
    }

    if ([System.IO.Path]::IsPathRooted($normalized) -or $normalized -eq '..' -or $normalized.StartsWith('../')) {
        throw "Framework paths must be relative to the host repository: '$Path'."
    }

    return $normalized.TrimEnd('/')
}

function Get-FullComponentPath {
    param(
        [string]$Root,
        [string]$RelativePath
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $rootFull $RelativePath))
    if ($RelativePath -eq '.') { return $rootFull }
    if (-not $candidate.StartsWith($rootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Framework path escapes the host repository: '$RelativePath'."
    }

    return $candidate
}

function Get-SubmoduleDefinitions {
    param([string]$Root)

    $gitmodulesPath = Join-Path $Root '.gitmodules'
    if (-not (Test-Path -LiteralPath $gitmodulesPath -PathType Leaf)) {
        return @()
    }

    $entries = Invoke-Git -WorkingDirectory $Root -GitArguments @(
        'config', '-f', '.gitmodules', '--get-regexp', '^submodule\..*\.path$'
    ) -AllowFailure
    if ($entries.ExitCode -ne 0) {
        return @()
    }

    $definitions = foreach ($line in $entries.Lines) {
        if ($line -notmatch '^submodule\.(.+)\.path\s+(.+)$') {
            continue
        }

        $name = $Matches[1]
        $path = Normalize-RelativePath $Matches[2]
        [pscustomobject]@{
            Name = $name
            Path = $path
            Url = Get-OptionalGitText -WorkingDirectory $Root -GitArguments @(
                'config', '-f', '.gitmodules', '--get', "submodule.$name.url"
            )
            Branch = Get-OptionalGitText -WorkingDirectory $Root -GitArguments @(
                'config', '-f', '.gitmodules', '--get', "submodule.$name.branch"
            )
        }
    }

    return @($definitions)
}

function Get-ComponentKind {
    param(
        [string]$Name,
        [string]$Path,
        [string]$Url
    )

    # Origin is stronger identity evidence than a checkout's arbitrary folder name.
    foreach ($token in @($Url, $Name, $Path)) {
        if ([string]::IsNullOrWhiteSpace($token)) {
            continue
        }

        $leaf = [System.IO.Path]::GetFileNameWithoutExtension(($token -replace '\\', '/').TrimEnd('/'))
        if ($leaf -ieq 'fw') { return 'fwc' }
        if ($leaf -in @('fwc', 'fwe', 'fwa', 'fws')) { return $leaf.ToLowerInvariant() }
    }

    return $null
}

function Get-ComponentSpecs {
    param(
        [string]$Root,
        [object[]]$Definitions
    )

    $definitionList = @()
    if ($null -ne $Definitions) {
        $definitionList = @($Definitions | Where-Object { $null -ne $_ })
    }

    $settings = @(
        [pscustomobject]@{
            Kind = 'fwc'
            ExplicitPath = $FwcPath
            Url = $FwcUrl
            Target = $FwcTarget
            Defaults = @('fw', 'fwc')
        },
        [pscustomobject]@{
            Kind = 'fwe'
            ExplicitPath = $FwePath
            Url = $FweUrl
            Target = $FweTarget
            Defaults = @('fwe', 'Tools/Editor/runtime/fwe', 'AI/fwe')
        },
        [pscustomobject]@{ Kind = 'fwa'; ExplicitPath = $FwaPath; Url = $FwaUrl; Target = $FwaTarget; Defaults = @('fwa') },
        [pscustomobject]@{ Kind = 'fws'; ExplicitPath = $FwsPath; Url = $FwsUrl; Target = $FwsTarget; Defaults = @('fws') }
    )

    $rootIsRepo = Test-GitWorktree -Path $Root
    $rootUrl = if ($rootIsRepo) { Get-OptionalGitText -WorkingDirectory $Root -GitArguments @('remote', 'get-url', 'origin') } else { $null }
    $rootKind = Get-ComponentKind -Url $rootUrl
    # A directory named fw can also be a host/container. Only use its name when
    # no recognized child or submodule makes the root ambiguous.
    $hasKnownChildren = $definitionList.Count -gt 0
    foreach ($setting in $settings) {
        foreach ($candidate in $setting.Defaults) {
            if (Test-Path -LiteralPath (Join-Path $Root $candidate)) { $hasKnownChildren = $true }
        }
    }
    if (-not $rootKind -and $rootIsRepo -and -not $hasKnownChildren) {
        $rootKind = Get-ComponentKind -Path $Root
        if (-not $rootKind -and $Component -ne 'all' -and $Action -ne 'new') { $rootKind = $Component }
    }

    $specs = foreach ($setting in $settings) {
        if ($Component -ne 'all' -and $Component -ne $setting.Kind) {
            continue
        }

        $matchingDefinitions = @($definitionList | Where-Object {
            (Get-ComponentKind -Name $_.Name -Path $_.Path -Url $_.Url) -eq $setting.Kind
        })

        $path = Normalize-RelativePath $setting.ExplicitPath
        if (-not $path -and $matchingDefinitions.Count -gt 1) {
            throw "Multiple $($setting.Kind) submodules found; select an explicit component path."
        }
        if (-not $path -and $matchingDefinitions.Count -gt 0) {
            $path = $matchingDefinitions[0].Path
        }
        if (-not $path -and $rootKind -eq $setting.Kind) { $path = '.' }
        if (-not $path) {
            foreach ($candidate in $setting.Defaults) {
                if (Test-Path -LiteralPath (Join-Path $Root $candidate) -PathType Container) {
                    $path = $candidate
                    break
                }
            }
        }
        $configured = $explicitParameters.ContainsKey("$($setting.Kind)Path") -or
            $explicitParameters.ContainsKey("$($setting.Kind)Url") -or
            $explicitParameters.ContainsKey("$($setting.Kind)Target")
        if (-not $path -and ($configured -or ($Action -eq 'new' -and $Component -eq $setting.Kind))) {
            $path = $setting.Defaults[0]
        }
        if (-not $path) {
            continue
        }

        $definition = $definitionList | Where-Object { $_.Path -ieq $path } | Select-Object -First 1
        $hasGitlink = $rootIsRepo -and $path -ne '.' -and (
            (Get-HeadGitlink -Root $Root -RelativePath $path) -or (Get-IndexGitlink -Root $Root -RelativePath $path))
        [pscustomobject]@{
            Kind = $setting.Kind
            Path = $path
            FullPath = Get-FullComponentPath -Root $Root -RelativePath $path
            Url = if ($definition -and $definition.Url) { $definition.Url } else { $setting.Url }
            Target = $setting.Target
            Definition = $definition
            RepositoryMode = if ($definition -or $hasGitlink) { 'submodule' } else { 'standalone' }
        }
    }

    return @($specs)
}

function Get-HeadGitlink {
    param(
        [string]$Root,
        [string]$RelativePath
    )

    $entry = Get-OptionalGitText -WorkingDirectory $Root -GitArguments @(
        'ls-tree', 'HEAD', '--', $RelativePath
    )
    if ($entry -and $entry -match '^160000\s+commit\s+([0-9a-fA-F]{40})\s') {
        return $Matches[1].ToLowerInvariant()
    }

    return $null
}

function Get-IndexGitlink {
    param(
        [string]$Root,
        [string]$RelativePath
    )

    $entry = Get-OptionalGitText -WorkingDirectory $Root -GitArguments @(
        'ls-files', '--stage', '--', $RelativePath
    )
    if ($entry -and $entry -match '^160000\s+([0-9a-fA-F]{40})\s+\d+\s') {
        return $Matches[1].ToLowerInvariant()
    }

    return $null
}

function Get-RemoteBranch {
    param(
        [string]$RepositoryPath,
        [string]$ConfiguredBranch
    )

    if ($ConfiguredBranch -and $ConfiguredBranch -ne '.') {
        return $ConfiguredBranch
    }

    $head = Get-OptionalGitText -WorkingDirectory $RepositoryPath -GitArguments @(
        'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'
    )
    if ($head -and $head.StartsWith('origin/')) {
        return $head.Substring('origin/'.Length)
    }

    foreach ($candidate in @('main', 'master')) {
        $exists = Invoke-Git -WorkingDirectory $RepositoryPath -GitArguments @(
            'show-ref', '--verify', '--quiet', "refs/remotes/origin/$candidate"
        ) -AllowFailure
        if ($exists.ExitCode -eq 0) {
            return $candidate
        }
    }

    return $null
}

function Resolve-GitTarget {
    param(
        [string]$RepositoryPath,
        [string]$Target
    )

    if ([string]::IsNullOrWhiteSpace($Target)) {
        return $null
    }

    $candidates = @()
    if ($Target -match '^[0-9a-fA-F]{7,40}$' -or $Target.StartsWith('refs/') -or $Target.StartsWith('origin/')) {
        $candidates += $Target
    }
    else {
        $candidates += "refs/remotes/origin/$Target"
        $candidates += "refs/tags/$Target"
        $candidates += $Target
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        $resolved = Get-OptionalGitText -WorkingDirectory $RepositoryPath -GitArguments @(
            'rev-parse', '--verify', "$candidate^{commit}"
        )
        if ($resolved -and $resolved -match '^[0-9a-fA-F]{40}$') {
            return $resolved.ToLowerInvariant()
        }
    }

    return $null
}

function Get-AheadBehind {
    param(
        [string]$RepositoryPath,
        [string]$LocalCommit,
        [string]$RemoteCommit
    )

    if (-not $LocalCommit -or -not $RemoteCommit) {
        return [pscustomobject]@{ Ahead = $null; Behind = $null }
    }

    $counts = Get-OptionalGitText -WorkingDirectory $RepositoryPath -GitArguments @(
        'rev-list', '--left-right', '--count', "$LocalCommit...$RemoteCommit"
    )
    if ($counts -and $counts -match '^(\d+)\s+(\d+)$') {
        return [pscustomobject]@{
            Ahead = [int]$Matches[1]
            Behind = [int]$Matches[2]
        }
    }

    return [pscustomobject]@{ Ahead = $null; Behind = $null }
}

function Get-ComponentStatus {
    param(
        [string]$Root,
        [object]$Spec,
        [switch]$ShouldFetch
    )

    $tracked = $null -ne $Spec.Definition
    $isSubmodule = $Spec.RepositoryMode -eq 'submodule'
    $present = Test-Path -LiteralPath $Spec.FullPath -PathType Container
    $headGitlink = if ($isSubmodule) { Get-HeadGitlink -Root $Root -RelativePath $Spec.Path } else { $null }
    $indexGitlink = if ($isSubmodule) { Get-IndexGitlink -Root $Root -RelativePath $Spec.Path } else { $null }
    $notes = @()

    $status = [ordered]@{
        component = $Spec.Kind
        path = $Spec.Path
        fullPath = $Spec.FullPath
        repositoryMode = $Spec.RepositoryMode
        verificationScope = if ($isSubmodule) { 'host-gitlink' } else { 'remote-reachability' }
        trackedAsSubmodule = $tracked
        present = $present
        initialized = $false
        configuredUrl = if ($tracked) { $Spec.Definition.Url } else { $null }
        configuredBranch = if ($tracked) { $Spec.Definition.Branch } else { $null }
        headGitlink = $headGitlink
        indexGitlink = $indexGitlink
        localHead = $null
        localBranch = $null
        localMatchesHeadGitlink = $null
        originUrl = $null
        remoteBranch = $null
        remoteHead = $null
        remoteContainsLocal = $null
        ahead = $null
        behind = $null
        dirty = $null
        changeCount = $null
        fetchAttempted = [bool]$ShouldFetch
        fetchSucceeded = $null
        target = $Spec.Target
        targetHead = $null
        notes = $notes
    }

    if ($tracked -and -not $headGitlink) {
        $status.notes += 'The host HEAD does not contain a gitlink for this path.'
    }
    if ($isSubmodule -and -not $tracked) { $status.notes += 'Gitlink exists but its .gitmodules registration is missing.' }

    if (-not $present) {
        $status.notes += 'Directory is missing.'
        return [pscustomobject]$status
    }

    if (-not (Test-GitWorktree -Path $Spec.FullPath)) {
        $status.notes += 'Directory is not an initialized Git worktree.'
        return [pscustomobject]$status
    }

    $status.initialized = $true
    $status.localHead = Get-OptionalGitText -WorkingDirectory $Spec.FullPath -GitArguments @('rev-parse', '--verify', 'HEAD^{commit}')
    $status.localBranch = Get-OptionalGitText -WorkingDirectory $Spec.FullPath -GitArguments @('branch', '--show-current')
    if (-not $status.localBranch) {
        $status.localBranch = '(detached)'
    }
    if ($headGitlink -and $status.localHead) {
        $status.localMatchesHeadGitlink = $headGitlink -eq $status.localHead
    }

    $status.originUrl = Get-OptionalGitText -WorkingDirectory $Spec.FullPath -GitArguments @(
        'remote', 'get-url', 'origin'
    )

    $porcelain = Invoke-Git -WorkingDirectory $Spec.FullPath -GitArguments @(
        'status', '--porcelain=v1', '--untracked-files=normal'
    )
    $status.changeCount = @($porcelain.Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
    $status.dirty = $status.changeCount -gt 0

    if ($ShouldFetch -and $status.originUrl) {
        $fetchResult = Invoke-Git -WorkingDirectory $Spec.FullPath -GitArguments @(
            'fetch', '--prune', 'origin'
        ) -AllowFailure
        $status.fetchSucceeded = $fetchResult.ExitCode -eq 0
        if (-not $status.fetchSucceeded) {
            $status.notes += "Fetch failed: $($fetchResult.Text)"
        }
    }

    $status.remoteBranch = Get-RemoteBranch -RepositoryPath $Spec.FullPath -ConfiguredBranch $status.configuredBranch
    if ($status.remoteBranch) {
        $status.remoteHead = Get-OptionalGitText -WorkingDirectory $Spec.FullPath -GitArguments @(
            'rev-parse', '--verify', "refs/remotes/origin/$($status.remoteBranch)"
        )
        $counts = Get-AheadBehind -RepositoryPath $Spec.FullPath -LocalCommit $status.localHead -RemoteCommit $status.remoteHead
        $status.ahead = $counts.Ahead
        $status.behind = $counts.Behind
    }

    if ($status.localHead) {
        $contains = Invoke-Git -WorkingDirectory $Spec.FullPath -GitArguments @(
            'branch', '-r', '--contains', $status.localHead
        ) -AllowFailure
        $status.remoteContainsLocal = $contains.ExitCode -eq 0 -and @(
            $contains.Lines | Where-Object { $_ -match '^\s*origin/' }
        ).Count -gt 0
    }

    $status.targetHead = Resolve-GitTarget -RepositoryPath $Spec.FullPath -Target $Spec.Target
    return [pscustomobject]$status
}

function Get-HostStatus {
    param(
        [string]$Root,
        [bool]$IsGit
    )

    if (-not $IsGit) {
        return [pscustomobject]@{
            isGitRepository = $false
            head = $null
            branch = $null
            dirty = $null
            changeCount = $null
        }
    }

    $porcelain = Invoke-Git -WorkingDirectory $Root -GitArguments @(
        'status', '--porcelain=v1', '--untracked-files=normal'
    )
    $changeCount = @($porcelain.Lines | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
    $branch = Get-OptionalGitText -WorkingDirectory $Root -GitArguments @('branch', '--show-current')
    if (-not $branch) {
        $branch = '(detached or unborn)'
    }

    return [pscustomobject]@{
        isGitRepository = $true
        head = Get-OptionalGitText -WorkingDirectory $Root -GitArguments @('rev-parse', '--verify', 'HEAD^{commit}')
        branch = $branch
        dirty = $changeCount -gt 0
        changeCount = $changeCount
    }
}

function New-Report {
    param(
        [string]$Root,
        [bool]$IsGit
    )

    return [pscustomobject][ordered]@{
        generatedAt = [DateTime]::UtcNow.ToString('o')
        action = $Action
        applyRequested = [bool]$Apply
        applied = $false
        partial = $false
        success = $false
        projectRoot = $Root
        host = Get-HostStatus -Root $Root -IsGit $IsGit
        components = @()
        operations = @()
        blockers = @()
        recovery = @()
    }
}

function Add-Operation {
    param(
        [object]$Report,
        [string]$ComponentName,
        [string]$Operation,
        [string]$Detail
    )

    $item = [pscustomobject]@{
        component = $ComponentName
        operation = $Operation
        detail = $Detail
        executed = $false
        rolledBack = $false
    }
    $Report.operations += $item
    return $item
}

function Add-Blocker {
    param(
        [object]$Report,
        [string]$ComponentName,
        [string]$Message
    )

    $Report.blockers += [pscustomobject]@{
        component = $ComponentName
        message = $Message
    }
}

function Assert-ExpectedComponents {
    param(
        [object]$Report,
        [object[]]$Specs
    )

    $expected = if ($Component -eq 'all') { @() } else { @($Component) }
    if (@($Specs).Count -eq 0) {
        Add-Blocker -Report $Report -ComponentName $Component -Message 'No components discovered or explicitly configured. Select -Component or pass a component path/URL; new does not add optional components automatically.'
    }
    foreach ($kind in $expected) {
        if (@($Specs | Where-Object { $_.Kind -eq $kind }).Count -eq 0) {
            Add-Blocker -Report $Report -ComponentName $kind -Message 'Component path was not discovered. Pass an explicit path or use new to register it.'
        }
    }
}

function Resolve-RemoteTarget {
    param([string]$Url, [string]$Target)

    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $null
    }

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $result = & git ls-remote -- $Url 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
    if ($exitCode -ne 0) { return $null }
    $references = @{}
    foreach ($line in $result) {
        if ($line.ToString() -match '^([0-9a-fA-F]{40})\s+(.+)$') { $references[$Matches[2]] = $Matches[1].ToLowerInvariant() }
    }
    $name = $Target -replace '^(refs/remotes/)?origin/', ''
    $candidates = if ($name.StartsWith('refs/')) { @("$name^{}", $name) } else { @("refs/heads/$name", "refs/tags/$name^{}", "refs/tags/$name", $name) }
    foreach ($candidate in $candidates) { if ($references.ContainsKey($candidate)) { return $references[$candidate] } }
    if ($Target -notmatch '^[0-9a-fA-F]{7,40}$') { return $null }
    # A pinned ancestor need not be an advertised tip. Validate it in an isolated
    # object database, never by partially adding a submodule to the user's host.
    $probeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('fw-sync-target-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $probeRoot | Out-Null
    try {
        Invoke-Git -WorkingDirectory $probeRoot -GitArguments @('init', '--bare') | Out-Null
        if ($Target.Length -eq 40) {
            $fetched = Invoke-Git -WorkingDirectory $probeRoot -GitArguments @('fetch', '--no-tags', '--', $Url, $Target) -AllowFailure
        }
        else {
            $fetched = Invoke-Git -WorkingDirectory $probeRoot -GitArguments @('fetch', '--no-tags', '--', $Url, '+refs/heads/*:refs/remotes/origin/*', '+refs/tags/*:refs/tags/*') -AllowFailure
        }
        if ($fetched.ExitCode -eq 0) { return Get-OptionalGitText -WorkingDirectory $probeRoot -GitArguments @('rev-parse', '--verify', "$Target^{commit}") }
        return $null
    }
    finally {
        $tempParent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
        if ([System.IO.Path]::GetDirectoryName($probeRoot) -ne $tempParent -or -not [System.IO.Path]::GetFileName($probeRoot).StartsWith('fw-sync-target-')) { throw 'Unsafe target probe cleanup path.' }
        Remove-Item -LiteralPath $probeRoot -Recurse -Force
    }
}

function Write-Report {
    param([object]$Report)

    if ($Json) {
        $Report | ConvertTo-Json -Depth 10
        return
    }

    Write-Output "Action:  $($Report.action)"
    Write-Output "Project: $($Report.projectRoot)"
    Write-Output "Apply:   $($Report.applyRequested)"
    Write-Output "Success: $($Report.success)"
    Write-Output "Partial: $($Report.partial)"

    foreach ($item in $Report.operations) {
        $state = if ($item.executed) { 'done' } else { 'plan' }
        Write-Output "  [$state][$($item.component)] $($item.operation): $($item.detail)"
    }
    foreach ($blocker in $Report.blockers) {
        Write-Output "  [blocked][$($blocker.component)] $($blocker.message)"
    }
    foreach ($recovery in $Report.recovery) { Write-Output "  [recovery] $recovery" }

    foreach ($status in $Report.components) {
        Write-Output ''
        Write-Output "[$($status.component)] $($status.path)"
        Write-Output "  mode / verification:  $($status.repositoryMode) / $($status.verificationScope)"
        Write-Output "  tracked/head gitlink: $($status.trackedAsSubmodule) / $($status.headGitlink)"
        Write-Output "  index gitlink:        $($status.indexGitlink)"
        Write-Output "  local:                $($status.localBranch) @ $($status.localHead)"
        Write-Output "  remote:               $($status.remoteBranch) @ $($status.remoteHead)"
        Write-Output "  ahead/behind:         $($status.ahead) / $($status.behind)"
        Write-Output "  dirty:                $($status.dirty) ($($status.changeCount) changes)"
        Write-Output "  target:               $($status.target) @ $($status.targetHead)"
        if ($status.notes.Count -gt 0) {
            Write-Output "  notes:                $($status.notes -join ' | ')"
        }
    }
}

$requestedRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$rootExists = Test-Path -LiteralPath $requestedRoot -PathType Container

if (-not $rootExists -and $Action -ne 'new') {
    throw "Project root does not exist: '$requestedRoot'."
}

$isGit = $rootExists -and (Test-GitWorktree -Path $requestedRoot)
$root = $requestedRoot

$report = New-Report -Root $root -IsGit $isGit

if ($Action -eq 'new' -and -not $isGit) {
    Add-Operation -Report $report -ComponentName 'host' -Operation 'git init' -Detail $requestedRoot | Out-Null
}

$definitions = if ($isGit) { Get-SubmoduleDefinitions -Root $root } else { @() }
$specs = @(Get-ComponentSpecs -Root $root -Definitions $definitions)

foreach ($spec in $specs) {
    foreach ($other in $specs) {
        if ($spec.Kind -eq $other.Kind) { continue }
        if ($spec.FullPath -eq $other.FullPath -or $spec.FullPath.StartsWith($other.FullPath.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
            Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Selected component paths overlap; choose independent repository roots.'
        }
    }
}

try {
switch ($Action) {
    'status' {
        Assert-ExpectedComponents -Report $report -Specs $specs
        $report.components = @($specs | ForEach-Object {
            Get-ComponentStatus -Root $root -Spec $_ -ShouldFetch:$Fetch
        })
        foreach ($status in $report.components) {
            if ($Fetch -and $status.fetchSucceeded -eq $false) {
                Add-Blocker -Report $report -ComponentName $status.component -Message 'Fetch failed.'
            }
        }
        $report.success = $report.blockers.Count -eq 0
    }

    'new' {
        Assert-ExpectedComponents -Report $report -Specs $specs
        $newTargets = @{}

        foreach ($spec in $specs) {
            if ($spec.Definition) {
                $operation = Add-Operation -Report $report -ComponentName $spec.Kind -Operation 'initialize' -Detail "sync/init/update $($spec.Path) at the host gitlink"
                if (Test-GitWorktree -Path $spec.FullPath) {
                    $dirty = Invoke-Git -WorkingDirectory $spec.FullPath -GitArguments @(
                        'status', '--porcelain=v1', '--untracked-files=normal'
                    )
                    if (@($dirty.Lines | Where-Object { $_ }).Count -gt 0) {
                        Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Existing submodule is dirty; initialization/update was not attempted.'
                    }
                }
                $locked = Get-IndexGitlink -Root $root -RelativePath $spec.Path
                if (-not $locked) {
                    Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Registered path has no index gitlink; cannot initialize an unpinned submodule.'
                }
                elseif (-not (Resolve-RemoteTarget -Url $spec.Url -Target $locked)) {
                    Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Locked submodule commit is not fetchable from its configured remote.'
                }
                continue
            }

            if (Test-Path -LiteralPath $spec.FullPath) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message "Path already exists but is not a registered submodule: $($spec.Path)"
                continue
            }
            $resolved = Resolve-RemoteTarget -Url $spec.Url -Target $spec.Target
            if (-not $resolved) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message "Remote/target is missing or unreachable: $($spec.Url) @ $($spec.Target)"
                continue
            }
            $newTargets[$spec.Kind] = $resolved

            Add-Operation -Report $report -ComponentName $spec.Kind -Operation 'submodule add' -Detail "$($spec.Url) -> $($spec.Path), target $($spec.Target)" | Out-Null
        }

        if ($Apply -and $report.blockers.Count -eq 0) {
            if (-not $isGit) {
                $mutationAttempted = $true
                if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
                Invoke-Git -WorkingDirectory $root -GitArguments @('init') | Out-Null
                $isGit = $true
                ($report.operations | Where-Object { $_.component -eq 'host' } | Select-Object -First 1).executed = $true
            }
            foreach ($spec in $specs) {
                $operation = $report.operations | Where-Object { $_.component -eq $spec.Kind } | Select-Object -First 1
                $mutationAttempted = $true
                if ($spec.Definition) {
                    Invoke-Git -WorkingDirectory $root -GitArguments @('submodule', 'sync', '--', $spec.Path) | Out-Null
                    Invoke-Git -WorkingDirectory $root -GitArguments @('submodule', 'update', '--init', '--recursive', '--', $spec.Path) | Out-Null
                }
                else {
                    Invoke-Git -WorkingDirectory $root -GitArguments @('submodule', 'add', '--', $spec.Url, $spec.Path) | Out-Null
                    $operation.executed = $true
                    Invoke-Git -WorkingDirectory $spec.FullPath -GitArguments @('fetch', '--prune', 'origin') | Out-Null
                    $targetCommit = $newTargets[$spec.Kind]
                    if (-not (Resolve-GitTarget -RepositoryPath $spec.FullPath -Target $targetCommit)) {
                        Invoke-Git -WorkingDirectory $spec.FullPath -GitArguments @('fetch', 'origin', $targetCommit) | Out-Null
                    }
                    Invoke-Git -WorkingDirectory $spec.FullPath -GitArguments @('checkout', '--detach', $targetCommit) | Out-Null
                    # submodule add staged its default branch, not necessarily our
                    # pinned target. Stage only this new gitlink after checkout.
                    Invoke-Git -WorkingDirectory $root -GitArguments @('add', '--', $spec.Path) | Out-Null
                }
                $operation.executed = $true
            }

            $definitions = Get-SubmoduleDefinitions -Root $root
            $specs = @(Get-ComponentSpecs -Root $root -Definitions $definitions)
            $report.applied = $true
        }

        if ($isGit) {
            $report.host = Get-HostStatus -Root $root -IsGit $true
            $report.components = @($specs | ForEach-Object {
                Get-ComponentStatus -Root $root -Spec $_
            })
        }
        $report.success = $report.blockers.Count -eq 0
    }

    'pull' {
        Assert-ExpectedComponents -Report $report -Specs $specs
        $statuses = @($specs | ForEach-Object {
            Get-ComponentStatus -Root $root -Spec $_ -ShouldFetch
        })
        $report.components = $statuses
        $targets = @()

        foreach ($spec in $specs) {
            $status = $statuses | Where-Object { $_.component -eq $spec.Kind } | Select-Object -First 1
            if ($status.repositoryMode -eq 'submodule' -and -not $status.trackedAsSubmodule) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Existing gitlink is missing its .gitmodules registration.'
                continue
            }
            if (-not $status.initialized) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Component is not initialized; run new first.'
                continue
            }
            if ($status.dirty) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Component is dirty.'
                continue
            }
            if (-not $status.localHead -or -not $status.originUrl -or $status.fetchSucceeded -ne $true) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'A committed HEAD and successful origin fetch are required.'
                continue
            }
            if (-not $status.targetHead) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message "Target could not be resolved: $($spec.Target)"
                continue
            }
            if (-not $status.trackedAsSubmodule) {
                if ($status.localBranch -eq '(detached)') {
                    Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Standalone pull requires an attached branch.'
                    continue
                }
                $fastForward = Invoke-Git -WorkingDirectory $spec.FullPath -GitArguments @('merge-base', '--is-ancestor', $status.localHead, $status.targetHead) -AllowFailure
                if ($fastForward.ExitCode -ne 0) {
                    Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Standalone pull is not a fast-forward; reconcile the branch manually.'
                    continue
                }
            }

            $operationName = if ($status.trackedAsSubmodule) { 'checkout' } else { 'fast-forward' }
            $operation = Add-Operation -Report $report -ComponentName $spec.Kind -Operation $operationName -Detail "$($status.localHead) -> $($status.targetHead)"
            $targets += [pscustomobject]@{
                Spec = $spec
                Original = $status.localHead
                OriginalBranch = $status.localBranch
                Target = $status.targetHead
                Operation = $operation
            }
        }

        if ($Apply -and $report.blockers.Count -eq 0) {
            $moved = @()
            try {
                foreach ($target in $targets) {
                    Assert-RepositoryUnchanged -Path $target.Spec.FullPath -Head $target.Original -Branch $target.OriginalBranch
                    if ($target.Original -ne $target.Target) {
                        $mutationAttempted = $true
                        $moved += $target
                        if ($target.Spec.RepositoryMode -eq 'standalone') {
                            Invoke-Git -WorkingDirectory $target.Spec.FullPath -GitArguments @('merge', '--ff-only', '--no-edit', $target.Target) | Out-Null
                        }
                        else {
                            Invoke-Git -WorkingDirectory $target.Spec.FullPath -GitArguments @('checkout', '--detach', $target.Target) | Out-Null
                        }
                    }
                    $target.Operation.executed = $true
                }
                $report.applied = $true
            }
            catch {
                $originalFailure = $_
                [array]::Reverse($moved)
                foreach ($target in $moved) {
                    try {
                        $current = Get-OptionalGitText -WorkingDirectory $target.Spec.FullPath -GitArguments @('rev-parse', '--verify', 'HEAD^{commit}')
                        $currentBranch = Get-OptionalGitText -WorkingDirectory $target.Spec.FullPath -GitArguments @('branch', '--show-current')
                        if (-not $currentBranch) { $currentBranch = '(detached)' }
                        if ($current -eq $target.Original -and $currentBranch -eq $target.OriginalBranch) {
                            $target.Operation.rolledBack = $true
                            continue
                        }
                        $changed = Invoke-Git -WorkingDirectory $target.Spec.FullPath -GitArguments @('status', '--porcelain=v1', '--untracked-files=normal')
                        if ($changed.Text -or ($current -ne $target.Target -and $current -ne $target.Original)) { throw 'Repository changed during pull; automatic recovery would overwrite newer work.' }
                        $expectedBranch = if ($target.Spec.RepositoryMode -eq 'standalone') { $target.OriginalBranch } else { '(detached)' }
                        if ($currentBranch -ne $expectedBranch) { throw 'Repository branch changed during pull; automatic recovery was not attempted.' }
                        Invoke-Git -WorkingDirectory $target.Spec.FullPath -GitArguments @('checkout', '--detach', $target.Original) | Out-Null
                        if ($target.OriginalBranch -ne '(detached)') {
                            if ($target.Spec.RepositoryMode -eq 'standalone' -and $current -eq $target.Target) {
                                Invoke-Git -WorkingDirectory $target.Spec.FullPath -GitArguments @('update-ref', "refs/heads/$($target.OriginalBranch)", $target.Original, $target.Target) | Out-Null
                            }
                            Invoke-Git -WorkingDirectory $target.Spec.FullPath -GitArguments @('checkout', $target.OriginalBranch) | Out-Null
                        }
                        $target.Operation.rolledBack = $true
                    }
                    catch {
                        $report.recovery += "$($target.Spec.Kind): restore $($target.OriginalBranch) @ $($target.Original) manually; $($_.Exception.Message)"
                    }
                }
                throw $originalFailure
            }

            $report.host = Get-HostStatus -Root $root -IsGit $isGit
            $report.components = @($specs | ForEach-Object {
                Get-ComponentStatus -Root $root -Spec $_
            })
        }

        $report.success = $report.blockers.Count -eq 0
    }

    'push' {
        Assert-ExpectedComponents -Report $report -Specs $specs
        $statuses = @($specs | ForEach-Object {
            Get-ComponentStatus -Root $root -Spec $_ -ShouldFetch
        })
        $report.components = $statuses
        $pushes = @()

        foreach ($spec in $specs) {
            $status = $statuses | Where-Object { $_.component -eq $spec.Kind } | Select-Object -First 1
            if (-not $status.initialized) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Component repository is missing or uninitialized.'
                continue
            }
            if ($status.dirty) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Component is dirty; classify, test and commit changes before push.'
                continue
            }
            if ($status.localBranch -eq '(detached)') {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Component is detached; publish from an explicit branch.'
                continue
            }
            if (-not $status.localHead) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Component has no committed HEAD.'
                continue
            }
            if (-not $status.originUrl) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Component has no origin remote.'
                continue
            }
            if ($status.fetchAttempted -and $status.fetchSucceeded -eq $false) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Fetch failed.'
                continue
            }
            $pushUrls = Invoke-Git -WorkingDirectory $spec.FullPath -GitArguments @('remote', 'get-url', '--push', '--all', 'origin')
            $mirror = Get-OptionalGitText -WorkingDirectory $spec.FullPath -GitArguments @('config', '--bool', 'remote.origin.mirror')
            if ($pushUrls.Lines.Count -ne 1 -or $pushUrls.Text -ne $status.originUrl -or $mirror -eq 'true') {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message 'Push requires one origin push URL matching its fetched URL, with mirror mode disabled.'
                continue
            }

            $remoteBranchCommit = Get-OptionalGitText -WorkingDirectory $spec.FullPath -GitArguments @(
                'rev-parse', '--verify', "refs/remotes/origin/$($status.localBranch)"
            )
            $counts = Get-AheadBehind -RepositoryPath $spec.FullPath -LocalCommit $status.localHead -RemoteCommit $remoteBranchCommit
            if ($remoteBranchCommit -and $counts.Behind -gt 0) {
                Add-Blocker -Report $report -ComponentName $spec.Kind -Message "Local branch is behind origin/$($status.localBranch); resolve it before push."
                continue
            }

            $detail = if ($remoteBranchCommit -eq $status.localHead) {
                "origin/$($status.localBranch) already contains $($status.localHead)"
            }
            else {
                "$($status.localHead) -> origin/$($status.localBranch)"
            }
            $operation = Add-Operation -Report $report -ComponentName $spec.Kind -Operation 'push' -Detail $detail
            $pushes += [pscustomobject]@{
                Spec = $spec
                Status = $status
                RemoteExists = $null -ne $remoteBranchCommit
                NeedsPush = $remoteBranchCommit -ne $status.localHead
                Operation = $operation
            }
        }

        if ($Apply -and $report.blockers.Count -eq 0) {
            foreach ($push in $pushes) {
                Assert-RepositoryUnchanged -Path $push.Spec.FullPath -Head $push.Status.localHead -Branch $push.Status.localBranch
                if ($push.NeedsPush) {
                    $mutationAttempted = $true
                    if ($push.RemoteExists) {
                        Invoke-Git -WorkingDirectory $push.Spec.FullPath -GitArguments @(
                            'push', '--no-follow-tags', 'origin', "HEAD:refs/heads/$($push.Status.localBranch)"
                        ) | Out-Null
                    }
                    else {
                        Invoke-Git -WorkingDirectory $push.Spec.FullPath -GitArguments @(
                            'push', '--no-follow-tags', '--set-upstream', 'origin', "HEAD:refs/heads/$($push.Status.localBranch)"
                        ) | Out-Null
                    }
                }
                $push.Operation.executed = $true

                $previousPreference = $ErrorActionPreference
                try {
                    $ErrorActionPreference = 'Continue'
                    $remoteLine = & git ls-remote --heads $push.Status.originUrl "refs/heads/$($push.Status.localBranch)" 2>&1
                    $remoteExitCode = $LASTEXITCODE
                }
                finally {
                    $ErrorActionPreference = $previousPreference
                }
                if ($remoteExitCode -ne 0 -or ($remoteLine -join "`n") -notmatch '^([0-9a-fA-F]{40})\s') {
                    throw "Could not verify remote branch for $($push.Spec.Kind)."
                }
                if ($Matches[1].ToLowerInvariant() -ne $push.Status.localHead) {
                    throw "Remote branch for $($push.Spec.Kind) does not point to the local commit after push."
                }
                $push.Operation.executed = $true
            }

            $report.applied = $true
            $report.components = @($specs | ForEach-Object {
                Get-ComponentStatus -Root $root -Spec $_ -ShouldFetch
            })
        }

        $report.success = $report.blockers.Count -eq 0
    }

    'verify' {
        Assert-ExpectedComponents -Report $report -Specs $specs
        $statuses = @($specs | ForEach-Object {
            Get-ComponentStatus -Root $root -Spec $_ -ShouldFetch
        })
        $report.components = $statuses

        foreach ($status in $statuses) {
            if ($status.repositoryMode -eq 'submodule' -and -not $status.trackedAsSubmodule) {
                Add-Blocker -Report $report -ComponentName $status.component -Message 'Existing gitlink is missing its .gitmodules registration.'
            }
            if (-not $status.initialized -or -not $status.localHead) {
                Add-Blocker -Report $report -ComponentName $status.component -Message 'Component is not initialized.'
            }
            else {
                if ($status.dirty) {
                    Add-Blocker -Report $report -ComponentName $status.component -Message 'Component is dirty.'
                }
                if ($status.repositoryMode -eq 'submodule' -and $status.localMatchesHeadGitlink -ne $true) {
                    Add-Blocker -Report $report -ComponentName $status.component -Message 'Local HEAD does not match the gitlink recorded by the host HEAD.'
                }
                if ($status.remoteContainsLocal -ne $true) {
                    Add-Blocker -Report $report -ComponentName $status.component -Message 'Local commit is not reachable from an origin branch.'
                }
                if ($status.fetchSucceeded -ne $true) {
                    Add-Blocker -Report $report -ComponentName $status.component -Message 'Successful origin fetch is required; cached reachability cannot prove delivery.'
                }
            }
        }

        $report.success = $report.blockers.Count -eq 0
    }
}
}
catch {
    Add-Blocker -Report $report -ComponentName 'operation' -Message $_.Exception.Message
    $report.success = $false
    if ($mutationAttempted -and $Action -in @('new', 'push')) { $report.recovery += 'Completed operations are retained. Inspect the reported repository/remote state before retrying; no destructive cleanup or remote rollback was attempted.' }
    try {
        $isGit = Test-GitWorktree -Path $root
        $report.host = Get-HostStatus -Root $root -IsGit $isGit
        if ($Action -eq 'new' -and $isGit) { $specs = @(Get-ComponentSpecs -Root $root -Definitions @(Get-SubmoduleDefinitions -Root $root)) }
        $report.components = @($specs | ForEach-Object { Get-ComponentStatus -Root $root -Spec $_ })
    }
    catch { $report.recovery += "Could not refresh final repository state: $($_.Exception.Message)" }
}
$report.partial = $mutationAttempted -and -not $report.success -and (@($report.operations | Where-Object { $_.executed -and -not $_.rolledBack }).Count -gt 0 -or $report.recovery.Count -gt 0)

Write-Report -Report $report
if ($report.success) {
    exit 0
}
exit 2
