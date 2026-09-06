[CmdletBinding()]
param(
    [switch]$KeepFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$tool = Join-Path $PSScriptRoot 'fw-sync.ps1'
$testRoot = Join-Path $env:TEMP ('fw-sync-regression-' + [guid]::NewGuid().ToString('N'))
$previousProtocol = $env:GIT_ALLOW_PROTOCOL
$env:GIT_ALLOW_PROTOCOL = 'file:https:ssh'

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Invoke-TestGit {
    param(
        [string]$WorkingDirectory,
        [string[]]$GitArguments
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

    $text = (@($rawOutput | ForEach-Object { $_.ToString() }) -join "`n").Trim()
    if ($exitCode -ne 0) {
        throw "git $($GitArguments -join ' ') failed in '$WorkingDirectory' (exit $exitCode).`n$text"
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Text = $text
    }
}

function Invoke-FwSync {
    param(
        [string[]]$ToolArguments,
        [int[]]$ExpectedExitCodes = @(0)
    )

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $rawOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $tool @ToolArguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    $text = (@($rawOutput | ForEach-Object { $_.ToString() }) -join "`n").Trim()
    if ($exitCode -notin $ExpectedExitCodes) {
        throw "fw-sync.ps1 $($ToolArguments -join ' ') returned $exitCode.`n$text"
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Report = $text | ConvertFrom-Json
    }
}

function New-TestRemote {
    param([string]$Name)

    $barePath = Join-Path $testRoot "$Name.git"
    $seedPath = Join-Path $testRoot "$Name-seed"
    Invoke-TestGit -WorkingDirectory $testRoot -GitArguments @('init', '--bare', $barePath) | Out-Null
    New-Item -ItemType Directory -Path $seedPath | Out-Null
    Invoke-TestGit -WorkingDirectory $seedPath -GitArguments @('init') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedPath -GitArguments @('config', 'user.email', 'fw-sync@test.local') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedPath -GitArguments @('config', 'user.name', 'FW Sync Test') | Out-Null
    Set-Content -Encoding UTF8 -LiteralPath (Join-Path $seedPath 'README.md') -Value $Name
    Invoke-TestGit -WorkingDirectory $seedPath -GitArguments @('add', 'README.md') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedPath -GitArguments @('commit', '-m', 'initial') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedPath -GitArguments @('branch', '-M', 'main') | Out-Null
    Invoke-TestGit -WorkingDirectory $seedPath -GitArguments @('remote', 'add', 'origin', $barePath) | Out-Null
    Invoke-TestGit -WorkingDirectory $seedPath -GitArguments @('push', '-u', 'origin', 'main') | Out-Null
    Invoke-TestGit -WorkingDirectory $barePath -GitArguments @('symbolic-ref', 'HEAD', 'refs/heads/main') | Out-Null

    return [pscustomobject]@{
        Bare = $barePath
        Seed = $seedPath
    }
}

function Update-TestRemote {
    param(
        [object]$Remote,
        [string]$Label
    )

    Add-Content -Encoding UTF8 -LiteralPath (Join-Path $Remote.Seed 'README.md') -Value $Label
    Invoke-TestGit -WorkingDirectory $Remote.Seed -GitArguments @('add', 'README.md') | Out-Null
    Invoke-TestGit -WorkingDirectory $Remote.Seed -GitArguments @('commit', '-m', $Label) | Out-Null
    Invoke-TestGit -WorkingDirectory $Remote.Seed -GitArguments @('push', 'origin', 'main') | Out-Null
}

function Remove-TestFixture {
    param([string]$Path)

    if (-not [System.IO.Directory]::Exists($Path)) {
        return
    }

    $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ([System.IO.Path]::GetDirectoryName($fullPath) -ne $tempRoot -or
        -not [System.IO.Path]::GetFileName($fullPath).StartsWith('fw-sync-regression-')) {
        throw "Unsafe test cleanup target: '$fullPath'."
    }

    Get-ChildItem -LiteralPath $fullPath -Recurse -Force -File -ErrorAction SilentlyContinue |
        ForEach-Object { $_.IsReadOnly = $false }
    Get-ChildItem -LiteralPath $fullPath -Recurse -Force -Directory -ErrorAction SilentlyContinue |
        ForEach-Object { $_.Attributes = [System.IO.FileAttributes]::Directory }
    [System.IO.File]::SetAttributes($fullPath, [System.IO.FileAttributes]::Directory)
    [System.IO.Directory]::Delete($fullPath, $true)
}

New-Item -ItemType Directory -Path $testRoot | Out-Null

try {
    $fw = New-TestRemote -Name 'fw'
    $fwe = New-TestRemote -Name 'fwe'
    $hostRepo = Join-Path $testRoot 'host'
    New-Item -ItemType Directory -Path $hostRepo | Out-Null
    Invoke-TestGit -WorkingDirectory $hostRepo -GitArguments @('init') | Out-Null
    Invoke-TestGit -WorkingDirectory $hostRepo -GitArguments @('config', 'user.email', 'fw-sync@test.local') | Out-Null
    Invoke-TestGit -WorkingDirectory $hostRepo -GitArguments @('config', 'user.name', 'FW Sync Test') | Out-Null
    Set-Content -Encoding UTF8 -LiteralPath (Join-Path $hostRepo 'README.md') -Value 'host'
    Invoke-TestGit -WorkingDirectory $hostRepo -GitArguments @('add', 'README.md') | Out-Null
    Invoke-TestGit -WorkingDirectory $hostRepo -GitArguments @('commit', '-m', 'host initial') | Out-Null

    $common = @(
        '-ProjectRoot', $hostRepo,
        '-FwPath', 'fw',
        '-FwePath', 'tools/fwe',
        '-FwUrl', $fw.Bare,
        '-FweUrl', $fwe.Bare,
        '-Json'
    )

    $newPlan = Invoke-FwSync -ToolArguments (@('new') + $common)
    Assert-True -Condition $newPlan.Report.success -Message 'new plan failed.'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $hostRepo '.gitmodules'))) -Message 'new plan modified the host.'

    $newApply = Invoke-FwSync -ToolArguments (@('new') + $common + @('-Apply'))
    Assert-True -Condition $newApply.Report.applied -Message 'new apply did not run.'
    Invoke-TestGit -WorkingDirectory $hostRepo -GitArguments @('commit', '-m', 'add framework submodules') | Out-Null
    $verifyNew = Invoke-FwSync -ToolArguments (@('verify') + $common)
    Assert-True -Condition $verifyNew.Report.success -Message 'verify failed after new.'

    Update-TestRemote -Remote $fw -Label 'fw update 1'
    Update-TestRemote -Remote $fwe -Label 'fwe update 1'
    $fwBefore = (Invoke-TestGit -WorkingDirectory (Join-Path $hostRepo 'fw') -GitArguments @('rev-parse', 'HEAD')).Text
    $fweBefore = (Invoke-TestGit -WorkingDirectory (Join-Path $hostRepo 'tools/fwe') -GitArguments @('rev-parse', 'HEAD')).Text

    $pullPlan = Invoke-FwSync -ToolArguments (@('pull') + $common)
    Assert-True -Condition $pullPlan.Report.success -Message 'pull plan failed.'
    Assert-True -Condition ((Invoke-TestGit -WorkingDirectory (Join-Path $hostRepo 'fw') -GitArguments @('rev-parse', 'HEAD')).Text -eq $fwBefore) -Message 'pull plan moved fw.'
    Assert-True -Condition ((Invoke-TestGit -WorkingDirectory (Join-Path $hostRepo 'tools/fwe') -GitArguments @('rev-parse', 'HEAD')).Text -eq $fweBefore) -Message 'pull plan moved fwe.'

    $pullApply = Invoke-FwSync -ToolArguments (@('pull') + $common + @('-Apply'))
    Assert-True -Condition $pullApply.Report.applied -Message 'pull apply did not run.'
    $verifyPending = Invoke-FwSync -ToolArguments (@('verify') + $common) -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $verifyPending.Report.success) -Message 'verify should require a host gitlink commit.'
    Invoke-TestGit -WorkingDirectory $hostRepo -GitArguments @('add', 'fw', 'tools/fwe') | Out-Null
    Invoke-TestGit -WorkingDirectory $hostRepo -GitArguments @('commit', '-m', 'update framework pair') | Out-Null
    $verifyPull = Invoke-FwSync -ToolArguments (@('verify') + $common)
    Assert-True -Condition $verifyPull.Report.success -Message 'verify failed after the host gitlink commit.'

    Update-TestRemote -Remote $fw -Label 'fw update 2'
    Update-TestRemote -Remote $fwe -Label 'fwe update 2'
    $fwBeforeBlock = (Invoke-TestGit -WorkingDirectory (Join-Path $hostRepo 'fw') -GitArguments @('rev-parse', 'HEAD')).Text
    $fweBeforeBlock = (Invoke-TestGit -WorkingDirectory (Join-Path $hostRepo 'tools/fwe') -GitArguments @('rev-parse', 'HEAD')).Text
    $dirtyFile = Join-Path $hostRepo 'fw/local-dirty.txt'
    Set-Content -Encoding UTF8 -LiteralPath $dirtyFile -Value 'dirty'
    $blockedPull = Invoke-FwSync -ToolArguments (@('pull') + $common + @('-Apply')) -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $blockedPull.Report.success) -Message 'dirty pull was not blocked.'
    Assert-True -Condition ((Invoke-TestGit -WorkingDirectory (Join-Path $hostRepo 'fw') -GitArguments @('rev-parse', 'HEAD')).Text -eq $fwBeforeBlock) -Message 'fw moved despite dirty preflight.'
    Assert-True -Condition ((Invoke-TestGit -WorkingDirectory (Join-Path $hostRepo 'tools/fwe') -GitArguments @('rev-parse', 'HEAD')).Text -eq $fweBeforeBlock) -Message 'fwe moved despite dirty preflight.'
    Remove-Item -LiteralPath $dirtyFile

    $fweRepo = Join-Path $hostRepo 'tools/fwe'
    Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('switch', '-c', 'feature-sync-test') | Out-Null
    Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('config', 'user.email', 'fw-sync@test.local') | Out-Null
    Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('config', 'user.name', 'FW Sync Test') | Out-Null
    Set-Content -Encoding UTF8 -LiteralPath (Join-Path $fweRepo 'feature.txt') -Value 'feature'
    Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('add', 'feature.txt') | Out-Null
    Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('commit', '-m', 'feature publish') | Out-Null
    $pushArguments = @('push', '-ProjectRoot', $hostRepo, '-FwePath', 'tools/fwe', '-Component', 'fwe', '-Json')
    $pushPlan = Invoke-FwSync -ToolArguments $pushArguments
    Assert-True -Condition $pushPlan.Report.success -Message 'push plan failed.'
    $remoteBeforePush = (Invoke-TestGit -WorkingDirectory $testRoot -GitArguments @('ls-remote', '--heads', $fwe.Bare, 'refs/heads/feature-sync-test')).Text
    Assert-True -Condition ([string]::IsNullOrWhiteSpace($remoteBeforePush)) -Message 'push plan modified the remote.'
    $pushApply = Invoke-FwSync -ToolArguments ($pushArguments + @('-Apply'))
    Assert-True -Condition $pushApply.Report.applied -Message 'push apply did not run.'
    $featureHead = (Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('rev-parse', 'HEAD')).Text
    $remoteAfterPush = (Invoke-TestGit -WorkingDirectory $testRoot -GitArguments @('ls-remote', '--heads', $fwe.Bare, 'refs/heads/feature-sync-test')).Text
    Assert-True -Condition $remoteAfterPush.StartsWith($featureHead) -Message 'pushed commit is not reachable from the remote branch.'

    $clonePath = Join-Path $testRoot 'host-clone'
    Invoke-TestGit -WorkingDirectory $testRoot -GitArguments @('clone', '--no-recurse-submodules', $hostRepo, $clonePath) | Out-Null
    $cloneNew = Invoke-FwSync -ToolArguments @('new', '-ProjectRoot', $clonePath, '-FwPath', 'fw', '-FwePath', 'tools/fwe', '-Json', '-Apply')
    Assert-True -Condition $cloneNew.Report.success -Message 'new failed on an existing cloned host.'

    $brandNewPath = Join-Path $testRoot 'brand-new-host'
    $brandNew = Invoke-FwSync -ToolArguments @(
        'new', '-ProjectRoot', $brandNewPath,
        '-FwPath', 'fw', '-FwePath', 'tools/fwe',
        '-FwUrl', $fw.Bare, '-FweUrl', $fwe.Bare,
        '-Json', '-Apply'
    )
    Assert-True -Condition $brandNew.Report.success -Message 'new failed for an absent host directory.'

    # Legacy FW paths/URLs remain aliases; reports use the canonical FWC identity.
    Assert-True -Condition ($newApply.Report.components[0].component -eq 'fwc') -Message 'Legacy FW parameters did not normalize to FWC.'
    $discoveredLegacy = Invoke-FwSync -ToolArguments @('status', '-ProjectRoot', $hostRepo, '-Json')
    Assert-True -Condition (@($discoveredLegacy.Report.components).Count -eq 2) -Message 'all introduced undiscovered optional components.'
    Assert-True -Condition (@($discoveredLegacy.Report.components | Where-Object { $_.component -eq 'fwc' -and $_.path -eq 'fw' }).Count -eq 1) -Message 'Legacy fw.git identity/path was not discovered.'

    $emptyPath = Join-Path $testRoot 'ambiguous-empty-host'
    $emptyNew = Invoke-FwSync -ToolArguments @('new', '-ProjectRoot', $emptyPath, '-Apply', '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $emptyNew.Report.success -and -not (Test-Path -LiteralPath $emptyPath)) -Message 'new all silently created a host or selected optional components.'

    $fwc = New-TestRemote -Name 'fwc'
    $fwa = New-TestRemote -Name 'fwa'
    $fws = New-TestRemote -Name 'fws'
    $onlyPath = Join-Path $testRoot 'fwc-only-host'
    $onlyNew = Invoke-FwSync -ToolArguments @('new', '-ProjectRoot', $onlyPath, '-Component', 'fwc', '-FwcUrl', $fwc.Bare, '-Apply', '-Json')
    Assert-True -Condition (@($onlyNew.Report.components).Count -eq 1 -and $onlyNew.Report.components[0].path -eq 'fw') -Message 'FWC-only new did not preserve the default fw path.'
    Assert-True -Condition (-not (Test-Path -LiteralPath (Join-Path $onlyPath 'fwe')) -and -not (Test-Path -LiteralPath (Join-Path $onlyPath 'fwa')) -and -not (Test-Path -LiteralPath (Join-Path $onlyPath 'fws'))) -Message 'FWC-only new added an optional component.'
    $unbornVerify = Invoke-FwSync -ToolArguments @('verify', '-ProjectRoot', $onlyPath, '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $unbornVerify.Report.host.head -and $unbornVerify.Report.components[0].verificationScope -eq 'host-gitlink') -Message 'An unborn host was treated as a verified standalone repository.'
    $onlyModulesPath = Join-Path $onlyPath '.gitmodules'
    $onlyModulesBytes = [System.IO.File]::ReadAllBytes($onlyModulesPath)
    Remove-Item -LiteralPath $onlyModulesPath
    $brokenRegistration = Invoke-FwSync -ToolArguments @('verify', '-ProjectRoot', $onlyPath, '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition ($brokenRegistration.Report.components[0].repositoryMode -eq 'submodule' -and $brokenRegistration.Report.components[0].verificationScope -eq 'host-gitlink') -Message 'Missing registration silently downgraded a gitlink to standalone verification.'
    [System.IO.File]::WriteAllBytes($onlyModulesPath, $onlyModulesBytes)
    $missingSelection = Invoke-FwSync -ToolArguments @('status', '-ProjectRoot', $onlyPath, '-Component', 'fwa', '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition (@($missingSelection.Report.components).Count -eq 0) -Message 'Explicit selection silently used another component.'

    $configuredOnlyPath = Join-Path $testRoot 'configured-only-host'
    $configuredOnly = Invoke-FwSync -ToolArguments @('new', '-ProjectRoot', $configuredOnlyPath, '-FwcUrl', $fwc.Bare, '-Apply', '-Json')
    Assert-True -Condition (@($configuredOnly.Report.components).Count -eq 1) -Message 'all should select only explicitly configured components on an empty host.'
    $badTargetPath = Join-Path $testRoot 'bad-target-host'
    $badTarget = Invoke-FwSync -ToolArguments @('new', '-ProjectRoot', $badTargetPath, '-FwcUrl', $fwc.Bare, '-FwaUrl', $fwa.Bare, '-FwaTarget', 'does-not-exist', '-Apply', '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $badTarget.Report.success -and -not (Test-Path -LiteralPath $badTargetPath)) -Message 'new wrote a partial host before all targets passed preflight.'

    $pinnedHead = (Invoke-TestGit -WorkingDirectory $fwc.Seed -GitArguments @('rev-parse', 'HEAD')).Text
    Update-TestRemote -Remote $fwc -Label 'newer than pinned target'
    $pinnedPath = Join-Path $testRoot 'pinned-host'
    $pinnedNew = Invoke-FwSync -ToolArguments @('new', '-ProjectRoot', $pinnedPath, '-Component', 'fw', '-FwUrl', $fwc.Bare, '-FwTarget', $pinnedHead, '-Apply', '-Json')
    Assert-True -Condition ($pinnedNew.Report.components[0].indexGitlink -eq $pinnedHead -and $pinnedNew.Report.components[0].localHead -eq $pinnedHead) -Message 'new staged the default remote tip instead of the selected commit.'
    $initializedOnlyPath = Join-Path $testRoot 'initialized-empty-host'
    New-Item -ItemType Directory -Path $initializedOnlyPath | Out-Null
    Invoke-TestGit -WorkingDirectory $initializedOnlyPath -GitArguments @('init') | Out-Null
    $initializedOnly = Invoke-FwSync -ToolArguments @('new', '-ProjectRoot', $initializedOnlyPath, '-Component', 'fw', '-FwUrl', $fwc.Bare, '-FwTarget', $pinnedHead.Substring(0, 7), '-Apply', '-Json')
    Assert-True -Condition ($initializedOnly.Report.components[0].path -eq 'fw' -and $initializedOnly.Report.components[0].indexGitlink -eq $pinnedHead) -Message 'Explicit new misclassified an initialized empty host or lost a legacy short commit target.'

    foreach ($entry in @(@('fwa', $fwa), @('fws', $fws))) {
        $kind = $entry[0]
        $remote = $entry[1]
        $standalone = Join-Path $testRoot "independent-$kind"
        Invoke-TestGit -WorkingDirectory $testRoot -GitArguments @('clone', $remote.Bare, $standalone) | Out-Null
        $standaloneStatus = Invoke-FwSync -ToolArguments @('status', '-ProjectRoot', $standalone, '-Component', $kind, '-Json')
        Assert-True -Condition ($standaloneStatus.Report.components[0].repositoryMode -eq 'standalone' -and $standaloneStatus.Report.components[0].path -eq '.') -Message "$kind standalone was not discovered as its own Git root."
        $standaloneVerify = Invoke-FwSync -ToolArguments @('verify', '-ProjectRoot', $standalone, '-Json')
        Assert-True -Condition ($standaloneVerify.Report.components[0].verificationScope -eq 'remote-reachability' -and -not $standaloneVerify.Report.components[0].headGitlink) -Message "$kind standalone verify invented a host gitlink."
        Invoke-TestGit -WorkingDirectory $standalone -GitArguments @('config', 'user.email', 'fw-sync@test.local') | Out-Null
        Invoke-TestGit -WorkingDirectory $standalone -GitArguments @('config', 'user.name', 'FW Sync Test') | Out-Null
        Invoke-TestGit -WorkingDirectory $standalone -GitArguments @('switch', '-c', 'publish-test') | Out-Null
        Set-Content -Encoding UTF8 -LiteralPath (Join-Path $standalone 'published.txt') -Value $kind
        Invoke-TestGit -WorkingDirectory $standalone -GitArguments @('add', 'published.txt') | Out-Null
        Invoke-TestGit -WorkingDirectory $standalone -GitArguments @('commit', '-m', 'publish independent component') | Out-Null
        $unpublished = Invoke-FwSync -ToolArguments @('verify', '-ProjectRoot', $standalone, '-Json') -ExpectedExitCodes @(2)
        Assert-True -Condition (-not $unpublished.Report.success) -Message 'Unpublished standalone commit was falsely verified.'
        $standalonePlan = Invoke-FwSync -ToolArguments @('push', '-ProjectRoot', $standalone, '-Component', $kind, '-Json')
        Assert-True -Condition $standalonePlan.Report.success -Message "$kind standalone push plan failed."
        $beforePublish = (Invoke-TestGit -WorkingDirectory $testRoot -GitArguments @('ls-remote', '--heads', $remote.Bare, 'refs/heads/publish-test')).Text
        Assert-True -Condition (-not $beforePublish) -Message 'Standalone push preview wrote its remote.'
        $standalonePush = Invoke-FwSync -ToolArguments @('push', '-ProjectRoot', $standalone, '-Component', $kind, '-Apply', '-Json')
        Assert-True -Condition $standalonePush.Report.applied -Message "$kind standalone publish failed."
        $publishedVerify = Invoke-FwSync -ToolArguments @('verify', '-ProjectRoot', $standalone, '-Json')
        Assert-True -Condition $publishedVerify.Report.success -Message "$kind published commit is not verified reachable."
        Invoke-TestGit -WorkingDirectory $standalone -GitArguments @('checkout', '--detach') | Out-Null
        $detachedPush = Invoke-FwSync -ToolArguments @('push', '-ProjectRoot', $standalone, '-Apply', '-Json') -ExpectedExitCodes @(2)
        Assert-True -Condition (-not $detachedPush.Report.applied) -Message 'Detached standalone push was not blocked.'
        Invoke-TestGit -WorkingDirectory $standalone -GitArguments @('checkout', 'main') | Out-Null
    }

    # A container may itself be a Git host, but ordinary child directories are
    # not component repositories merely because git -C finds that parent.
    $container = Join-Path $testRoot 'container'
    New-Item -ItemType Directory -Path $container | Out-Null
    Invoke-TestGit -WorkingDirectory $container -GitArguments @('init') | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $container 'fwc') | Out-Null
    Invoke-TestGit -WorkingDirectory $container -GitArguments @('clone', $fwa.Bare, 'fwa') | Out-Null
    Invoke-TestGit -WorkingDirectory $container -GitArguments @('clone', $fws.Bare, 'fws') | Out-Null
    $containerStatus = Invoke-FwSync -ToolArguments @('status', '-ProjectRoot', $container, '-Json')
    Assert-True -Condition (@($containerStatus.Report.components).Count -eq 3) -Message 'Container all discovery was incomplete or added FWE.'
    $nonRepo = $containerStatus.Report.components | Where-Object { $_.component -eq 'fwc' }
    Assert-True -Condition (-not $nonRepo.initialized) -Message 'Ordinary child directory was mistaken for its parent repository.'
    $selectedStatus = Invoke-FwSync -ToolArguments @('status', '-ProjectRoot', $container, '-Component', 'fwa', '-FweUrl', (Join-Path $testRoot 'unreachable-unused.git'), '-Json')
    Assert-True -Condition (@($selectedStatus.Report.components).Count -eq 1 -and $selectedStatus.Report.success) -Message 'Explicit component selection included unrelated settings.'
    $selectedVerify = Invoke-FwSync -ToolArguments @('verify', '-ProjectRoot', $container, '-Component', 'fwa', '-Json')
    Assert-True -Condition $selectedVerify.Report.success -Message 'Container standalone verification incorrectly required an unrelated host gitlink.'
    $oldStandaloneHead = (Invoke-TestGit -WorkingDirectory (Join-Path $container 'fwa') -GitArguments @('rev-parse', 'HEAD')).Text
    Update-TestRemote -Remote $fwa -Label 'standalone fast-forward update'
    $standalonePullPlan = Invoke-FwSync -ToolArguments @('pull', '-ProjectRoot', $container, '-Component', 'fwa', '-Json')
    Assert-True -Condition ((Invoke-TestGit -WorkingDirectory (Join-Path $container 'fwa') -GitArguments @('rev-parse', 'HEAD')).Text -eq $oldStandaloneHead) -Message 'Standalone pull preview moved a branch.'
    $standalonePull = Invoke-FwSync -ToolArguments @('pull', '-ProjectRoot', $container, '-Component', 'fwa', '-Apply', '-Json')
    Assert-True -Condition ($standalonePull.Report.applied -and $standalonePull.Report.components[0].localBranch -eq 'main') -Message 'Standalone FF pull detached or failed to update the branch.'
    $behindPush = Invoke-FwSync -ToolArguments @('push', '-ProjectRoot', (Join-Path $testRoot 'independent-fwa'), '-Apply', '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $behindPush.Report.applied) -Message 'Non-fast-forward standalone push was not blocked.'
    $cachedRepo = Join-Path $testRoot 'independent-fws'
    Invoke-TestGit -WorkingDirectory $cachedRepo -GitArguments @('remote', 'set-url', 'origin', (Join-Path $testRoot 'missing-remote.git')) | Out-Null
    $staleVerify = Invoke-FwSync -ToolArguments @('verify', '-ProjectRoot', $cachedRepo, '-Component', 'fws', '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition ($staleVerify.Report.components[0].remoteContainsLocal -and $staleVerify.Report.components[0].fetchSucceeded -eq $false -and -not $staleVerify.Report.success) -Message 'A failed fetch was masked by cached reachability.'
    Invoke-TestGit -WorkingDirectory $cachedRepo -GitArguments @('remote', 'set-url', 'origin', $fws.Bare) | Out-Null
    Invoke-TestGit -WorkingDirectory $cachedRepo -GitArguments @('remote', 'set-url', '--push', 'origin', $fwc.Bare) | Out-Null
    $differentPushUrl = Invoke-FwSync -ToolArguments @('push', '-ProjectRoot', $cachedRepo, '-Component', 'fws', '-Apply', '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $differentPushUrl.Report.applied) -Message 'Push validated one remote but allowed publication to a different push URL.'
    Invoke-TestGit -WorkingDirectory $cachedRepo -GitArguments @('config', '--unset', 'remote.origin.pushurl') | Out-Null
    Invoke-TestGit -WorkingDirectory (Join-Path $container 'fwa') -GitArguments @('checkout', '--detach') | Out-Null
    $detachedPull = Invoke-FwSync -ToolArguments @('pull', '-ProjectRoot', $container, '-Component', 'fwa', '-Apply', '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $detachedPull.Report.applied) -Message 'Detached standalone pull was not blocked.'

    # Inject a checkout-hook failure after the second submodule has moved. Both
    # the first checkout and the failed checkout must restore HEAD AND branch.
    $fwRepo = Join-Path $hostRepo 'fw'
    Invoke-TestGit -WorkingDirectory $fwRepo -GitArguments @('switch', '-c', 'rollback-original') | Out-Null
    $rollbackFw = (Invoke-TestGit -WorkingDirectory $fwRepo -GitArguments @('rev-parse', 'HEAD')).Text
    $rollbackFwe = (Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('rev-parse', 'HEAD')).Text
    $failTarget = (Invoke-TestGit -WorkingDirectory $fwe.Seed -GitArguments @('rev-parse', 'HEAD')).Text
    $hooks = Join-Path $testRoot 'checkout-hooks'
    New-Item -ItemType Directory -Path $hooks | Out-Null
    $hookText = '#!/bin/sh' + "`n" + 'if test "$2" = "' + $failTarget + '"; then exit 1; fi' + "`nexit 0`n"
    [System.IO.File]::WriteAllText((Join-Path $hooks 'post-checkout'), $hookText, [System.Text.UTF8Encoding]::new($false))
    Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('config', 'core.hooksPath', $hooks) | Out-Null
    $rolledBack = Invoke-FwSync -ToolArguments (@('pull') + $common + @('-Apply')) -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $rolledBack.Report.success -and -not $rolledBack.Report.partial) -Message 'Recoverable pull failure was not reported accurately.'
    Assert-True -Condition ((Invoke-TestGit -WorkingDirectory $fwRepo -GitArguments @('rev-parse', 'HEAD')).Text -eq $rollbackFw -and (Invoke-TestGit -WorkingDirectory $fwRepo -GitArguments @('branch', '--show-current')).Text -eq 'rollback-original') -Message 'Pull rollback did not restore the first component branch/HEAD.'
    Assert-True -Condition ((Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('rev-parse', 'HEAD')).Text -eq $rollbackFwe -and (Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('branch', '--show-current')).Text -eq 'feature-sync-test') -Message 'Pull rollback did not restore the failed component branch/HEAD.'
    Invoke-TestGit -WorkingDirectory $fweRepo -GitArguments @('config', '--unset', 'core.hooksPath') | Out-Null

    # Standalone branch recovery is different from a detached gitlink checkout.
    # The first FF hook locks the second repository after global preflight;
    # recovery must restore the first branch without removing another lock.
    $standalonePair = Join-Path $testRoot 'standalone-pair'
    New-Item -ItemType Directory -Path $standalonePair | Out-Null
    Invoke-TestGit -WorkingDirectory $standalonePair -GitArguments @('clone', $fwa.Bare, 'fwa') | Out-Null
    Invoke-TestGit -WorkingDirectory $standalonePair -GitArguments @('clone', $fws.Bare, 'fws') | Out-Null
    $pairFwa = Join-Path $standalonePair 'fwa'
    $pairFws = Join-Path $standalonePair 'fws'
    $pairFwaHead = (Invoke-TestGit -WorkingDirectory $pairFwa -GitArguments @('rev-parse', 'HEAD')).Text
    $pairFwsHead = (Invoke-TestGit -WorkingDirectory $pairFws -GitArguments @('rev-parse', 'HEAD')).Text
    Update-TestRemote -Remote $fwa -Label 'paired FWA update'
    Update-TestRemote -Remote $fws -Label 'paired FWS update'
    $pairHooks = Join-Path $testRoot 'merge-hooks'
    New-Item -ItemType Directory -Path $pairHooks | Out-Null
    $otherLock = (Join-Path $pairFws '.git/index.lock') -replace '\\', '/'
    $mergeHookText = '#!/bin/sh' + "`n" + 'printf locked > "' + $otherLock + '"' + "`nexit 0`n"
    [System.IO.File]::WriteAllText((Join-Path $pairHooks 'post-merge'), $mergeHookText, [System.Text.UTF8Encoding]::new($false))
    Invoke-TestGit -WorkingDirectory $pairFwa -GitArguments @('config', 'core.hooksPath', $pairHooks) | Out-Null
    $pairRollback = Invoke-FwSync -ToolArguments @('pull', '-ProjectRoot', $standalonePair, '-Apply', '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $pairRollback.Report.success -and -not $pairRollback.Report.partial) -Message 'Standalone branch rollback did not finish.'
    Assert-True -Condition ((Invoke-TestGit -WorkingDirectory $pairFwa -GitArguments @('rev-parse', 'HEAD')).Text -eq $pairFwaHead -and (Invoke-TestGit -WorkingDirectory $pairFwa -GitArguments @('branch', '--show-current')).Text -eq 'main') -Message 'Standalone rollback lost the original branch or commit.'
    Assert-True -Condition ((Invoke-TestGit -WorkingDirectory $pairFws -GitArguments @('rev-parse', 'HEAD')).Text -eq $pairFwsHead -and (Test-Path -LiteralPath $otherLock)) -Message 'Standalone rollback modified an unchanged repository or removed an external lock.'
    Remove-Item -LiteralPath $otherLock
    Invoke-TestGit -WorkingDirectory $pairFwa -GitArguments @('config', '--unset', 'core.hooksPath') | Out-Null

    $pairDirty = Join-Path $pairFws 'do-not-delete.txt'
    Set-Content -Encoding UTF8 -LiteralPath $pairDirty -Value 'preserve caller work'
    $wholePairBlocked = Invoke-FwSync -ToolArguments @('pull', '-ProjectRoot', $standalonePair, '-Apply', '-Json') -ExpectedExitCodes @(2)
    Assert-True -Condition (-not $wholePairBlocked.Report.applied -and (Invoke-TestGit -WorkingDirectory $pairFwa -GitArguments @('rev-parse', 'HEAD')).Text -eq $pairFwaHead -and (Test-Path -LiteralPath $pairDirty)) -Message 'Standalone pair did not preflight all components before writing.'

    [pscustomobject]@{
        success = $true
        newPlanNoWrite = $true
        newApply = $true
        existingCloneInit = $true
        absentHostInit = $true
        pullPlanNoWrite = $true
        pullApply = $true
        verifyRequiresHostCommit = $true
        dirtyBlocksWholePull = $true
        pushPlanNoWrite = $true
        pushApplyAndRemoteReachability = $true
        canonicalFwcAndLegacyAliases = $true
        allUsesOnlyDiscoveredOrConfigured = $true
        emptyNewRequiresExplicitSelection = $true
        fwcOnlyHasNoOptionalDependencies = $true
        unbornHostIsNotVerified = $true
        missingRegistrationCannotBypassHostGitlink = $true
        newPreflightsAllTargetsBeforeWriting = $true
        pinnedNewStagesSelectedCommit = $true
        initializedEmptyHostAndLegacyShortTarget = $true
        independentFwaAndFwsStatusPushVerify = $true
        standaloneReachabilityWithoutGitlink = $true
        containerSelectionAndExactGitRoots = $true
        standaloneFastForwardPull = $true
        detachedAndNonFastForwardBlocked = $true
        pullFailureRestoresBranchesAndHeads = $true
        standaloneFailureRestoresBranchAndPreservesExternalLock = $true
        standaloneDirtyBlocksWholePull = $true
        cachedReachabilityCannotMaskFetchFailure = $true
        mismatchedPushRemoteBlocked = $true
        fixture = if ($KeepFixture) { $testRoot } else { $null }
    } | ConvertTo-Json
}
finally {
    $env:GIT_ALLOW_PROTOCOL = $previousProtocol
    if (-not $KeepFixture) {
        Remove-TestFixture -Path $testRoot
    }
}
