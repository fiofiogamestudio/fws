param(
    [ValidateSet('Plan', 'Apply', 'Restore')][string] $Mode = 'Plan',
    [string] $ManifestPath,
    [Parameter(Mandatory = $true)][string] $PlanPath,
    [Parameter(Mandatory = $true)][string] $ResultPath,
    [ValidateRange(0, 87600)][double] $MinAgeHours = 24
)

# Windows PowerShell 5.1. Exact historical .log files only; never directories.
# Ordinary NTFS compression preserves paths and bytes; it is not deletion.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
function Read-Json([string] $p) { [IO.File]::ReadAllText($p, $utf8) | ConvertFrom-Json }
function Write-Json([string] $p, $v) { [IO.File]::WriteAllText($p, ($v | ConvertTo-Json -Depth 20), $utf8) }
function Normalize([string] $p) {
    $p = $p.Replace('/', '\')
    if ($p -notmatch '^[a-zA-Z]:\\' -or $p.Substring(2).Contains(':')) { throw 'An absolute local drive path is required.' }
    foreach ($part in $p.Substring(3).Split('\')) {
        if ($part -in @('.', '..') -or $part -match '[*?"<>|]' -or $part.EndsWith(' ') -or $part.EndsWith('.')) { throw 'Noncanonical or wildcard path.' }
    }
    [IO.Path]::GetFullPath($p).TrimEnd('\')
}
function Inside([string] $p, [string] $root) { $p.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) }
function Check-Ancestors([string] $p) {
    while ($p) {
        $i = Get-Item -LiteralPath $p -Force
        if (($i.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse target or ancestor is protected.' }
        if ($i.Name -ieq '.git' -or ($i.PSIsContainer -and (Test-Path -LiteralPath (Join-Path $p 'HEAD')) -and (
            (Test-Path -LiteralPath (Join-Path $p 'objects')) -or ((Test-Path -LiteralPath (Join-Path $p 'commondir')) -and (Test-Path -LiteralPath (Join-Path $p 'gitdir')))))) { throw 'Git storage is protected.' }
        $p = [IO.Path]::GetDirectoryName($p)
    }
}
function Check-File([string] $p, [string] $root) {
    if (-not (Inside $p $root)) { throw 'Target must be strictly inside the authorized root.' }
    Check-Ancestors $p
    $i = Get-Item -LiteralPath $p -Force
    if ($i.PSIsContainer -or $i.Extension -ine '.log') { throw 'Only exact .log files are supported.' }
    $relative = $p.Substring($root.Length + 1)
    if ($relative -match '(?i)(^|\\)(assets|packages|projectsettings|artsource|src|source|scripts|\.git)(\\|$)') { throw 'Source/configuration paths are protected.' }
    $dir = [IO.Path]::GetDirectoryName($p)
    while (-not [string]::Equals($dir, $root, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath (Join-Path $dir '.git')) { throw 'Nested repository is protected.' }
        $dir = [IO.Path]::GetDirectoryName($dir)
    }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required for ownership checks.' }
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $gitRoot = @(& git -C $root rev-parse --show-toplevel 2>$null); $gitExit = $LASTEXITCODE } finally { $ErrorActionPreference = $saved }
    if ($gitExit -eq 0) {
        $gitRoot = Normalize $gitRoot[-1]
        $gitRelative = $p.Substring($gitRoot.Length + 1).Replace('\', '/')
        $owned = @(& git -C $gitRoot ls-files -z -- (':(literal,icase)' + $gitRelative))
        if ($LASTEXITCODE -ne 0 -or $owned.Count) { throw 'Git tracked file or failed ownership check.' }
        $null = & git -C $gitRoot rev-parse --verify --quiet HEAD
        if ($LASTEXITCODE -eq 0) {
            $owned = @(& git -C $gitRoot ls-files --with-tree=HEAD -z -- (':(literal,icase)' + $gitRelative))
            if ($LASTEXITCODE -ne 0 -or $owned.Count) { throw 'Git HEAD file is protected, including staged deletion.' }
        } elseif ($LASTEXITCODE -eq 1) {
            $branch = @(& git -C $gitRoot symbolic-ref --quiet HEAD)
            if ($LASTEXITCODE -ne 0 -or $branch.Count -ne 1 -or -not $branch[0].StartsWith('refs/heads/', [StringComparison]::Ordinal)) { throw 'Git HEAD is not a valid unborn branch.' }
            $null = & git -C $gitRoot check-ref-format $branch[0]
            if ($LASTEXITCODE -ne 0) { throw 'Git HEAD branch reference is invalid.' }
            $saved = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            try { $null = & git -C $gitRoot show-ref --verify --quiet $branch[0] 2>$null; $branchExit = $LASTEXITCODE }
            finally { $ErrorActionPreference = $saved }
            if ($branchExit -ne 1) { throw 'Git HEAD is not a verified unborn branch.' }
        } else { throw 'Git HEAD ownership check failed.' }
    } else {
        $dir = $root
        while ($dir) {
            if (Test-Path -LiteralPath (Join-Path $dir '.git')) { throw 'Unreadable Git repository.' }
            $dir = [IO.Path]::GetDirectoryName($dir)
        }
    }
}

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public sealed class FwLogState {
    public string identity, sha256;
    public long logicalBytes, allocatedBytes, lastWriteTicks;
    public int compression;
}
public static class FwLogCompression {
    [StructLayout(LayoutKind.Sequential)] struct Info {
        public uint attributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME creation, access, write;
        public uint volume, sizeHigh, sizeLow, links, idHigh, idLow;
    }
    [StructLayout(LayoutKind.Sequential)] struct CompressionInfo {
        public long size;
        public ushort format;
        public byte unit, chunk, cluster, reserved1, reserved2, reserved3;
    }
    [StructLayout(LayoutKind.Sequential)] struct StandardInfo {
        public long allocationSize, endOfFile;
        public uint links;
        public byte deletePending, directory;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int kind, out CompressionInfo i, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int kind, out StandardInfo i, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle h, StringBuilder p, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetVolumeInformation(string root, StringBuilder name, uint n, out uint serial, out uint component, out uint flags, StringBuilder fs, uint f);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle h, uint code, ref ushort input, uint inSize, IntPtr output, uint outSize, out uint count, IntPtr overlapped);
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static void CheckVolume(string path) {
        uint serial, component, flags;
        var fs = new StringBuilder(64);
        Check(GetVolumeInformation(Path.GetPathRoot(path), null, 0, out serial, out component, out flags, fs, 64));
        if (fs.ToString() != "NTFS" || (flags & 16) == 0) throw new IOException("NTFS file compression is required.");
    }
    public static FwLogState Inspect(FileStream stream, string path) {
        Info i;
        Check(GetFileInformationByHandle(stream.SafeFileHandle, out i));
        // Reparse, encrypted, sparse, offline, directory, device, readonly.
        if ((i.attributes & (0x400 | 0x4000 | 0x200 | 0x1000 | 0x10 | 0x40 | 1)) != 0) throw new IOException("Unsupported/protected file attributes.");
        if (i.links != 1) throw new IOException("Hard-linked files are protected.");
        var actual = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(stream.SafeFileHandle, actual, 32768, 0);
        if (length == 0 || length >= 32768) throw new IOException("Cannot resolve opened file.");
        if (!String.Equals(actual.ToString(), "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase)) throw new IOException("Opened file path was redirected.");
        long size = ((long)i.sizeHigh << 32) | i.sizeLow;
        if (size <= 0 || size > 30L * 1024 * 1024 * 1024) throw new IOException("Unsupported file length.");
        CompressionInfo c;
        Check(GetFileInformationByHandleEx(stream.SafeFileHandle, 8, out c, (uint)Marshal.SizeOf(typeof(CompressionInfo))));
        StandardInfo allocation;
        Check(GetFileInformationByHandleEx(stream.SafeFileHandle, 1, out allocation, (uint)Marshal.SizeOf(typeof(StandardInfo))));
        if (allocation.endOfFile != size || allocation.links != 1 || allocation.deletePending != 0 || allocation.directory != 0 || allocation.allocationSize < 0) throw new IOException("Invalid file allocation state.");
        if (c.format != 0 && c.format != 2) throw new IOException("Unsupported compression format.");
        stream.Position = 0;
        string hash;
        using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        Info after;
        Check(GetFileInformationByHandle(stream.SafeFileHandle, out after));
        if (i.sizeHigh != after.sizeHigh || i.sizeLow != after.sizeLow || i.write.dwHighDateTime != after.write.dwHighDateTime || i.write.dwLowDateTime != after.write.dwLowDateTime) throw new IOException("File changed during hashing.");
        return new FwLogState { identity = i.volume + ":" + i.idHigh + ":" + i.idLow, logicalBytes = size,
            allocatedBytes = allocation.allocationSize, compression = c.format,
            lastWriteTicks = ((long)(uint)i.write.dwHighDateTime << 32) | (uint)i.write.dwLowDateTime, sha256 = hash };
    }
    // FSCTL_SET_COMPRESSION, COMPRESSION_FORMAT_LZNT1; no WOF/EXE modes.
    // https://learn.microsoft.com/windows/win32/api/winioctl/ni-winioctl-fsctl_set_compression
    public static void Set(FileStream stream, ushort format) {
        uint count;
        Check(DeviceIoControl(stream.SafeFileHandle, 0x9C040, ref format, 2, IntPtr.Zero, 0, out count, IntPtr.Zero));
        stream.Flush(true);
    }
}
'@

$PlanPath = Normalize $PlanPath
$ResultPath = Normalize $ResultPath
if ($PlanPath -ieq $ResultPath -or (Test-Path -LiteralPath $ResultPath)) { throw 'Use a new, distinct result file.' }
if ($Mode -eq 'Plan') {
    $ManifestPath = Normalize $ManifestPath
    if ($ManifestPath -ieq $ResultPath -or $ManifestPath -ieq $PlanPath -or (Test-Path -LiteralPath $PlanPath)) { throw 'Use a new, distinct plan file.' }
    $manifest = Read-Json $ManifestPath
    if ($manifest.schemaVersion -ne 1 -or @($manifest.targets).Count -eq 0) { throw 'Invalid manifest.' }
    $root = Normalize $manifest.root
    $targets = @($manifest.targets)
} else {
    $plan = Read-Json $PlanPath
    if ($plan.schemaVersion -ne 1 -or $plan.operation -ne 'ntfs-log-compression' -or $plan.allocationMeasurement -ne 'ntfs-file-standard-info-allocation' -or @($plan.targets).Count -eq 0) { throw 'Invalid sealed compression plan or allocation measurement.' }
    $root = Normalize $plan.root
    $targets = @($plan.targets)
    $MinAgeHours = [double] $plan.minAgeHours
    if ([double]::IsNaN($MinAgeHours) -or [double]::IsInfinity($MinAgeHours) -or $MinAgeHours -lt 0 -or $MinAgeHours -gt 87600) { throw 'Invalid sealed minimum age.' }
}
if ($root -ieq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'Drive roots are not authorized scopes.' }
Check-Ancestors $root
if (-not (Get-Item -LiteralPath $root -Force).PSIsContainer) { throw 'Root must be a directory.' }
[FwLogCompression]::CheckVolume($root)
$seen = @{}
foreach ($target in $targets) {
    $p = Normalize $target.path
    if ($seen.ContainsKey($p)) { throw 'Duplicate target.' }
    $seen[$p] = $true
    if ($p -ieq $PlanPath -or $p -ieq $ResultPath -or ($ManifestPath -and $p -ieq $ManifestPath)) { throw 'Control files cannot be targets.' }
}
$beforeFree = (New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))).AvailableFreeSpace
$results = @()
$sealed = @()
foreach ($target in $targets) {
    $p = Normalize $target.path
    $stream = $null
    $attempted = $false
    $entry = [ordered] @{ path = $p; status = 'skipped'; message = $null; before = $null; after = $null; savedAllocatedBytes = 0; contentPreserved = $null }
    try {
        Check-File $p $root
        if ([string]::IsNullOrWhiteSpace($target.reason) -or @($target.evidence).Count -eq 0 -or @($target.evidence | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) }).Count) { throw 'Review reason and evidence are required.' }
        if ($Mode -eq 'Plan') { $stream = [IO.FileStream]::new($p, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read, 1048576, [IO.FileOptions]::SequentialScan) }
        else { $stream = [IO.FileStream]::new($p, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1048576, [IO.FileOptions]::SequentialScan) }
        $state = [FwLogCompression]::Inspect($stream, $p)
        $entry.before = $state
        if (([DateTime]::UtcNow - [DateTime]::FromFileTimeUtc($state.lastWriteTicks)).TotalHours -lt $MinAgeHours) { throw 'Log is too recent or still active.' }
        if ($Mode -eq 'Plan') {
            if ($state.compression -ne 0) { throw 'Already compressed; no new compression saving is claimed.' }
            $sealed += [pscustomobject] @{ path = $p; reason = $target.reason; evidence = @($target.evidence); snapshot = $state }
            $entry.status = 'sealed'; $entry.message = 'Read-only plan; no compression performed.'
        } else {
            foreach ($key in @('identity', 'logicalBytes', 'lastWriteTicks', 'sha256')) { if ($state.$key -ne $target.snapshot.$key) { throw ('Sealed state changed: ' + $key) } }
            $expected = if ($Mode -eq 'Apply') { 0 } else { 2 }
            if ($target.snapshot.compression -ne 0 -or $state.compression -ne $expected) { throw 'Compression state differs from the expected transition.' }
            $format = if ($Mode -eq 'Apply') { 2 } else { 0 }
            if ($Mode -eq 'Restore' -and (New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))).AvailableFreeSpace -lt ($state.logicalBytes - $state.allocatedBytes + 64MB)) { throw 'Insufficient free space for decompression.' }
            $attempted = $true
            [FwLogCompression]::Set($stream, $format)
            # NTFS may retain a partial compression unit until the write handle closes.
            # Reopen exclusively, then prove identity/content again before reporting allocation.
            $stream.Dispose(); $stream = $null
            Check-Ancestors $p
            $stream = [IO.FileStream]::new($p, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1048576, [IO.FileOptions]::SequentialScan)
            $after = [FwLogCompression]::Inspect($stream, $p)
            $entry.after = $after
            $entry.contentPreserved = $after.sha256 -eq $state.sha256 -and $after.logicalBytes -eq $state.logicalBytes
            if (-not $entry.contentPreserved -or $after.identity -ne $state.identity -or $after.lastWriteTicks -ne $state.lastWriteTicks -or $after.compression -ne $format) { throw 'Post-operation content/identity/timestamp/compression verification failed.' }
            if ($Mode -eq 'Apply' -and $after.allocatedBytes -ge $state.allocatedBytes) {
                [FwLogCompression]::Set($stream, 0)
                $stream.Dispose(); $stream = $null
                Check-Ancestors $p
                $stream = [IO.FileStream]::new($p, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1048576, [IO.FileOptions]::SequentialScan)
                $entry.after = [FwLogCompression]::Inspect($stream, $p)
                if ($entry.after.sha256 -ne $state.sha256 -or $entry.after.logicalBytes -ne $state.logicalBytes -or $entry.after.identity -ne $state.identity -or $entry.after.lastWriteTicks -ne $state.lastWriteTicks -or $entry.after.compression -ne 0) { throw 'No-gain rollback verification failed.' }
                $entry.status = 'unchanged'; $entry.message = 'No allocated-byte saving; compression reversed.'
            } else {
                $entry.status = if ($Mode -eq 'Apply') { 'compressed' } else { 'restored' }
                $entry.message = 'Path and content preserved; ordinary NTFS compression state changed.'
                $entry.savedAllocatedBytes = $state.allocatedBytes - $after.allocatedBytes
            }
        }
    } catch {
        $entry.message = $_.Exception.Message
        if ($attempted) { $entry.status = 'failed'; $entry.savedAllocatedBytes = 0 }
    } finally { if ($stream) { $stream.Dispose() } }
    $results += [pscustomobject] $entry
    $report = [pscustomobject] @{ schemaVersion = 1; operation = 'ntfs-log-compression'; mode = $Mode; root = $root;
        allocationMeasurement = 'ntfs-file-standard-info-allocation'; allocationScope = 'NTFS-reported file data allocation; excludes MFT and directory overhead';
        at = [DateTime]::UtcNow.ToString('o'); removedLogicalBytes = 0; removedFiles = 0;
        exitCode = $(if (@($results | Where-Object { $_.status -in @('skipped', 'failed') }).Count) { 2 } else { 0 });
        savedAllocatedBytes = [long] ($results | Measure-Object savedAllocatedBytes -Sum).Sum;
        volumeFreeBefore = $beforeFree; volumeFreeAfter = (New-Object IO.DriveInfo([IO.Path]::GetPathRoot($root))).AvailableFreeSpace; targets = $results }
    Write-Json $ResultPath $report
    [Console]::Error.WriteLine(($entry.status.ToUpperInvariant() + ': ' + $p + ' -- ' + $entry.message))
}
if ($Mode -eq 'Plan') { Write-Json $PlanPath ([pscustomobject] @{ schemaVersion = 1; operation = 'ntfs-log-compression'; allocationMeasurement = 'ntfs-file-standard-info-allocation'; root = $root; createdAt = [DateTime]::UtcNow.ToString('o'); minAgeHours = $MinAgeHours; targets = $sealed }) }
$report | ConvertTo-Json -Depth 20
if (@($results | Where-Object { $_.status -in @('skipped', 'failed') }).Count) { exit 2 }
