param(
    [string] $PlanPath = (Join-Path $PSScriptRoot 'cleanup-plan.json'),
    [switch] $Apply,
    [switch] $Seal,
    [string] $ManifestPath
)

# ASCII source is intentional: Windows PowerShell 5.1 can parse it without a BOM.
# All user/project path data lives in explicitly decoded UTF-8 JSON, never in BAT syntax.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8

function Read-Json([string] $Filename) {
    return ([IO.File]::ReadAllText($Filename, $utf8) | ConvertFrom-Json)
}

function Write-Json([string] $Filename, $Value) {
    [IO.File]::WriteAllText($Filename, ($Value | ConvertTo-Json -Depth 20), $utf8)
}

function Has-Property($Value, [string] $Name) {
    return $null -ne $Value -and $null -ne $Value.PSObject.Properties[$Name]
}

function Normalize-Path([string] $Value) {
    if ($null -ne $Value) { $Value = $Value.Replace('/', '\') }
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[a-zA-Z]:\\') { throw 'Expected an absolute local drive path.' }
    # Device paths, alternate data streams, wildcards and ambiguous Windows names
    # are outside this exact-path contract. Unicode, spaces, &, %, ! remain valid.
    if ($Value.StartsWith('\\') -or $Value.Substring(2).Contains(':')) { throw 'UNC, device paths, and alternate streams are unsupported.' }
    $full = [IO.Path]::GetFullPath($Value)
    foreach ($component in $full.Substring(3).Split('\')) {
        if ($component -match '[*?"<>|]' -or $component.EndsWith(' ') -or $component.EndsWith('.')) { throw 'Ambiguous or wildcard path is unsupported.' }
    }
    return $full.TrimEnd('\')
}

function Same-Path([string] $Left, [string] $Right) {
    return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase)
}

function Within-Path([string] $Child, [string] $Root) {
    return (Same-Path $Child $Root) -or $Child.StartsWith(($Root.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)
}

function Check-Ancestors([string] $Target) {
    $current = $Target
    while ($current) {
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point in target or ancestor.' }
        if ($item.Name -eq '.git') { throw 'Git metadata cannot be a cleanup target.' }
        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) { break }
        $current = $parent.FullName
    }
}

function Check-Root([string] $Root) {
    if (Same-Path ($Root.TrimEnd('\')) ([IO.Path]::GetPathRoot($Root).TrimEnd('\'))) { throw 'An authorized root cannot be a drive root.' }
    Check-Ancestors $Root
    if (-not (Get-Item -LiteralPath $Root -Force).PSIsContainer) { throw 'Authorized root must be an existing directory.' }
}

function Resolve-Root([string] $Target, $Roots) {
    $matches = @($Roots | Where-Object { (Within-Path $Target $_) -and -not (Same-Path $Target $_) })
    if ($matches.Count -eq 0) { throw 'Target must be strictly inside an authorized root.' }
    return @($matches | Sort-Object Length -Descending)[0]
}

function Check-NestedRepository([string] $Target, [string] $Root) {
    $current = if ((Get-Item -LiteralPath $Target -Force).PSIsContainer) { $Target } else { [IO.Path]::GetDirectoryName($Target) }
    while (-not (Same-Path $current $Root)) {
        if (Test-Path -LiteralPath (Join-Path $current '.git')) { throw 'Nested Git repository is protected.' }
        $current = [IO.Path]::GetDirectoryName($current)
    }
}

function Get-GitRoot([string] $Root) {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required to verify tracked ownership.' }
    # Native stderr from a non-repository is expected here, not a PowerShell error.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = @(& git -C $Root rev-parse --show-toplevel 2>$null)
        if ($LASTEXITCODE -eq 0) { return (Normalize-Path ($output[-1].Replace('/', '\'))) }
        # Do not treat a broken/unreadable repository as a plain folder.
        $current = $Root
        while ($current) {
            if (Test-Path -LiteralPath (Join-Path $current '.git')) { throw 'Unable to read Git repository.' }
            $current = [IO.Path]::GetDirectoryName($current)
        }
        return $null
    } finally { $ErrorActionPreference = $savedPreference }
}

function Check-Tracked([string] $Target, [string] $GitRoot) {
    if (-not $GitRoot) { return }
    $relative = $Target.Substring($GitRoot.Length + 1).Replace('\', '/')
    $output = @(& git -C $GitRoot ls-files -z -- (':(literal,icase)' + $relative))
    if ($LASTEXITCODE -ne 0) { throw 'Git tracked-file check failed.' }
    if ($output.Count -gt 0) { throw 'Git tracked files are protected, including modified tracked files.' }
}

# Native cached FileSystemInfo metadata avoids PowerShell per-file overhead for
# large Unity caches. The identical routine seals and revalidates; no file data
# is read, no links are followed, and the JSON only stores an aggregate digest.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Collections.Generic;
using System.Security.Cryptography;
public sealed class FWSClearSnapshot {
    public string digest { get; set; }
    public long files { get; set; }
    public long directories { get; set; }
    public long logicalBytes { get; set; }
    public string algorithm { get; set; }
    public static FWSClearSnapshot Capture(string target) {
        var result = new FWSClearSnapshot { algorithm = "sha256-sorted-path-type-length-mtimeUtcTicks-v1" };
        var pending = new Stack<FileSystemInfo>();
        var attributes = File.GetAttributes(target);
        pending.Push((attributes & FileAttributes.Directory) != 0 ? (FileSystemInfo)new DirectoryInfo(target) : new FileInfo(target));
        var records = new List<string>();
        while (pending.Count != 0) {
            var item = pending.Pop();
            if ((item.Attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("Reparse point in target subtree.");
            if (String.Equals(item.Name, ".git", StringComparison.OrdinalIgnoreCase)) throw new IOException("Git metadata or nested repository in target subtree.");
            var relative = String.Equals(item.FullName, target, StringComparison.OrdinalIgnoreCase) ? "." : item.FullName.Substring(target.Length + 1);
            long length = 0;
            var directory = (item.Attributes & FileAttributes.Directory) != 0;
            if (directory) {
                result.directories++;
                foreach (var child in ((DirectoryInfo)item).EnumerateFileSystemInfos()) pending.Push(child);
            } else {
                result.files++;
                length = ((FileInfo)item).Length;
                result.logicalBytes += length;
            }
            records.Add((directory ? "D" : "F") + "\0" + relative + "\0" + length.ToString(CultureInfo.InvariantCulture) + "\0" + item.LastWriteTimeUtc.Ticks.ToString(CultureInfo.InvariantCulture));
        }
        records.Sort(StringComparer.Ordinal);
        var encoding = new UTF8Encoding(false);
        using (var sha = SHA256.Create()) {
            foreach (var record in records) {
                var buffer = encoding.GetBytes(record + "\n");
                sha.TransformBlock(buffer, 0, buffer.Length, null, 0);
            }
            sha.TransformFinalBlock(new byte[0], 0, 0);
            result.digest = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
        }
        return result;
    }
}
'@

function Get-Snapshot([string] $Target) { return [FWSClearSnapshot]::Capture($Target) }

function Validate-Guards($Guards, $Roots) {
    if ($null -eq $Guards) { return }
    foreach ($guard in @($Guards)) {
        if (-not (Has-Property $guard 'processName') -or [string]::IsNullOrWhiteSpace($guard.processName) -or $guard.processName -notmatch '^[a-zA-Z0-9_. -]+$') { throw 'Guard requires a literal processName.' }
        $hasProject = Has-Property $guard 'projectRoot'
        $hasExecutable = Has-Property $guard 'executableRoot'
        if ($hasProject -eq $hasExecutable) { throw 'Each guard requires exactly one projectRoot or executableRoot.' }
        $field = if ($hasProject) { 'projectRoot' } else { 'executableRoot' }
        $guard.$field = Normalize-Path $guard.$field
        if (@($Roots | Where-Object { Within-Path $guard.$field $_ }).Count -eq 0) { throw 'Guard path is outside authorized roots.' }
    }
}

function Validate-Shape($Plan, [switch] $Sealed) {
    if ($Plan.schemaVersion -ne 1 -or -not (Has-Property $Plan 'roots') -or -not (Has-Property $Plan 'targets') -or @($Plan.roots).Count -eq 0 -or @($Plan.targets).Count -eq 0) { throw 'Invalid or empty manifest.' }
    $roots = @($Plan.roots | ForEach-Object { Normalize-Path $_ })
    foreach ($root in $roots) { Check-Root $root }
    $targets = New-Object 'System.Collections.Generic.List[string]'
    foreach ($target in @($Plan.targets)) {
        if (-not (Has-Property $target 'reason') -or [string]::IsNullOrWhiteSpace($target.reason)) { throw 'Each target requires a review reason.' }
        $target.path = Normalize-Path $target.path
        $root = Resolve-Root $target.path $roots
        if ($target.path.Split('\') -contains '.git') { throw 'Git metadata cannot be a cleanup target.' }
        foreach ($earlier in $targets) {
            if ((Within-Path $target.path $earlier) -or (Within-Path $earlier $target.path)) { throw 'Duplicate or overlapping cleanup targets.' }
        }
        $targets.Add($target.path)
        if (Has-Property $target 'processGuards') { Validate-Guards $target.processGuards $roots }
        if ($Sealed) {
            if (-not (Has-Property $target 'authorizedRoot') -or -not (Same-Path $root $target.authorizedRoot) -or -not (Has-Property $target 'gitRoot') -or -not (Has-Property $target 'snapshot') -or $target.snapshot.digest -notmatch '^[a-f0-9]{64}$' -or $target.snapshot.algorithm -ne 'sha256-sorted-path-type-length-mtimeUtcTicks-v1') { throw 'Invalid sealed target.' }
            foreach ($field in @('files', 'directories', 'logicalBytes')) {
                if (-not (Has-Property $target.snapshot $field) -or $target.snapshot.$field -is [string] -or $target.snapshot.$field -lt 0 -or [decimal] $target.snapshot.$field -ne [decimal] [long] $target.snapshot.$field) { throw 'Invalid sealed snapshot count.' }
            }
            if (-not (Has-Property $target 'processGuards')) { throw 'Missing sealed process guards.' }
        }
    }
    return ,$roots
}

function Guard-Reason($Guards) {
    if ($null -eq $Guards -or @($Guards).Count -eq 0) { return $null }
    try { $processes = @(Get-CimInstance Win32_Process) } catch { return 'Process ownership query unavailable; guarded target retained.' }
    foreach ($guard in @($Guards)) {
        $wanted = [IO.Path]::GetFileNameWithoutExtension($guard.processName)
        foreach ($process in $processes) {
            if ($process.ProcessId -eq $PID) { continue }
            if (-not [string]::Equals([IO.Path]::GetFileNameWithoutExtension($process.Name), $wanted, [StringComparison]::OrdinalIgnoreCase)) { continue }
            if (Has-Property $guard 'executableRoot') {
                if ([string]::IsNullOrWhiteSpace($process.ExecutablePath)) { return 'Matching process executable ownership unavailable; guarded target retained.' }
                if (Within-Path (Normalize-Path $process.ExecutablePath) $guard.executableRoot) { return 'A matching guarded process is active.' }
            } else {
                if ([string]::IsNullOrWhiteSpace($process.CommandLine)) { return 'Matching process project ownership unavailable; guarded target retained.' }
                $match = [regex]::Match($process.CommandLine, '(?i)(?:^|\s)-projectPath\s+(?:"(?<quoted>[^"]+)"|(?<plain>\S+))')
                if (-not $match.Success) { return 'Matching process has no readable projectPath; guarded target retained.' }
                $project = if ($match.Groups['quoted'].Success) { $match.Groups['quoted'].Value } else { $match.Groups['plain'].Value }
                if (Same-Path (Normalize-Path $project.Replace('/', '\')) $guard.projectRoot) { return 'A matching guarded process is active.' }
            }
        }
    }
    return $null
}

function Volume-Free($Roots) {
    $result = @()
    foreach ($drive in @($Roots | ForEach-Object { [IO.Path]::GetPathRoot($_) } | Select-Object -Unique)) {
        try { $info = New-Object IO.DriveInfo($drive); $result += [pscustomobject] @{ volume = $drive; freeBytes = $info.AvailableFreeSpace } }
        catch { $result += [pscustomobject] @{ volume = $drive; freeBytes = $null } }
    }
    return $result
}

$results = @()
$errorBundle = $null
try {
    if ($Seal) {
        if ($Apply -or [string]::IsNullOrWhiteSpace($ManifestPath)) { throw 'Seal requires ManifestPath and cannot delete.' }
        if (Test-Path -LiteralPath $PlanPath) { throw 'Refusing to overwrite a sealed plan.' }
        $manifest = Read-Json $ManifestPath
        $roots = Validate-Shape $manifest
        $sealedTargets = @()
        foreach ($target in @($manifest.targets)) {
            $root = Resolve-Root $target.path $roots
            Check-Ancestors $target.path
            Check-NestedRepository $target.path $root
            $gitRoot = Get-GitRoot $root
            Check-Tracked $target.path $gitRoot
            Write-Host ('Sealing: ' + $target.path)
            $snapshot = Get-Snapshot $target.path
            $guards = @()
            if (Has-Property $target 'processGuards') { $guards = @($target.processGuards) }
            $sealedTargets += [pscustomobject] @{ path = $target.path; reason = $target.reason; authorizedRoot = $root; gitRoot = $gitRoot; processGuards = $guards; snapshot = $snapshot }
        }
        Write-Json $PlanPath ([pscustomobject] @{ schemaVersion = 1; createdAtUtc = [DateTime]::UtcNow.ToString('o'); roots = $roots; targets = $sealedTargets })
        exit 0
    }

    if (Test-Path -LiteralPath $PlanPath) { $errorBundle = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PlanPath)) }
    $plan = Read-Json $PlanPath
    $roots = Validate-Shape $plan -Sealed
    $bundle = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PlanPath))
    foreach ($target in @($plan.targets)) {
        if (Within-Path $bundle $target.path) { throw 'Cleanup bundle cannot be inside a target.' }
    }
    $before = @(Volume-Free $roots)
    $results = @()
    foreach ($target in @($plan.targets)) {
        $status = 'failed'
        $message = ''
        [long] $removedBytes = 0
        try {
            # Revalidate root and ancestry for every item, before even deciding
            # that a missing target is an idempotent skip.
            Check-Root $target.authorizedRoot
            $parent = [IO.Path]::GetDirectoryName($target.path)
            while (-not (Test-Path -LiteralPath $parent)) { $parent = [IO.Path]::GetDirectoryName($parent) }
            Check-Ancestors $parent
            if (-not (Test-Path -LiteralPath $target.path)) { $status = 'skipped'; $message = 'Target already absent.' }
            else {
                Check-Ancestors $target.path
                Check-NestedRepository $target.path $target.authorizedRoot
                $currentGitRoot = Get-GitRoot $target.authorizedRoot
                if (-not [string]::Equals([string] $currentGitRoot, [string] $target.gitRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Git repository ownership changed since sealing.' }
                Check-Tracked $target.path $currentGitRoot
                $guardReason = Guard-Reason $target.processGuards
                if ($guardReason) { $status = 'skipped'; $message = $guardReason }
                else {
                    $snapshot = Get-Snapshot $target.path
                    if ($snapshot.digest -ne $target.snapshot.digest -or $snapshot.logicalBytes -ne $target.snapshot.logicalBytes -or $snapshot.files -ne $target.snapshot.files -or $snapshot.directories -ne $target.snapshot.directories) { throw 'Target contents or metadata changed; review and generate a new bundle.' }
                    if ($Apply) {
                        # Metadata revalidation cannot lock out a concurrent writer.
                        # Guards reduce that risk; never close user applications here.
                        Remove-Item -LiteralPath $target.path -Force -Recurse
                        if (Test-Path -LiteralPath $target.path) { throw 'Target remains after deletion.' }
                        $status = 'deleted'; $message = 'Deleted exact sealed target.'; $removedBytes = $snapshot.logicalBytes
                    } else { $status = 'ready'; $message = 'Preview passed; no files deleted.' }
                }
            }
        } catch { $message = $_.Exception.Message }
        $result = [pscustomobject] @{ path = $target.path; status = $status; message = $message; plannedLogicalBytes = $target.snapshot.logicalBytes; removedLogicalBytes = $removedBytes }
        $results += $result
        Write-Host ($status.ToUpperInvariant() + ': ' + $target.path + ' -- ' + $message)
    }
    $exitCode = if (@($results | Where-Object { $_.status -in @('failed', 'skipped') }).Count -gt 0) { 2 } else { 0 }
    $report = [pscustomobject] @{ schemaVersion = 1; finishedAtUtc = [DateTime]::UtcNow.ToString('o'); mode = $(if ($Apply) { 'apply' } else { 'preview' }); exitCode = $exitCode; removedLogicalBytes = [long] ($results | Measure-Object -Property removedLogicalBytes -Sum).Sum; volumeBefore = $before; volumeAfter = @(Volume-Free $roots); targets = $results }
    Write-Json (Join-Path $bundle 'cleanup-results.json') $report
    $archiveStem = 'cleanup-results-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff') + '-' + $report.mode
    Write-Json (Join-Path $bundle ($archiveStem + '.json')) $report
    [IO.File]::WriteAllLines((Join-Path $bundle 'cleanup-results.log'), [string[]] @($results | ForEach-Object { $_.status.ToUpperInvariant() + ': ' + $_.path + ' -- ' + $_.message }), $utf8)
    [IO.File]::Copy((Join-Path $bundle 'cleanup-results.log'), (Join-Path $bundle ($archiveStem + '.log')), $false)
    Write-Host ('Removed logical bytes: ' + $report.removedLogicalBytes + '. Exit code: ' + $exitCode)
    exit $exitCode
} catch {
    $fatalMessage = $_.Exception.Message
    [Console]::Error.WriteLine('Cleanup stopped: ' + $fatalMessage)
    if (-not $Seal -and $errorBundle) {
        # Preserve fatal evidence too, so a later invalid plan cannot leave the
        # previous successful run looking like the latest result.
        try {
            Check-Ancestors $errorBundle
            $fatal = [pscustomobject] @{ schemaVersion = 1; finishedAtUtc = [DateTime]::UtcNow.ToString('o'); mode = $(if ($Apply) { 'apply' } else { 'preview' }); exitCode = 1; fatalError = $fatalMessage; targets = $results }
            $stem = 'cleanup-results-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fffffff') + '-fatal'
            Write-Json (Join-Path $errorBundle 'cleanup-results.json') $fatal
            Write-Json (Join-Path $errorBundle ($stem + '.json')) $fatal
            [IO.File]::WriteAllText((Join-Path $errorBundle 'cleanup-results.log'), ('FATAL: ' + $fatalMessage + [Environment]::NewLine), $utf8)
            [IO.File]::Copy((Join-Path $errorBundle 'cleanup-results.log'), (Join-Path $errorBundle ($stem + '.log')), $false)
        } catch { [Console]::Error.WriteLine('Result log could not be written; inspect the console error above.') }
    }
    exit 1
}
