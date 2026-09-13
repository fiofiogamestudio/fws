# Resolve the physical FWS source before looking for its sibling workspace.
# Resolve-Path alone preserves Windows junction ancestors, including installed
# skill links such as <client>/skills/fw-sync -> <FW>/fws/skills/fw-sync.
function Resolve-FwsPhysicalDirectory {
    param([string]$Directory)
    $full = (Resolve-Path -LiteralPath $Directory).Path
    $visited = @{}
    for ($depth = 0; $depth -lt 32; $depth++) {
        if ($visited.ContainsKey($full)) { throw 'Cyclic skill/workspace directory link.' }
        $visited[$full] = $true
        $cursor = $full
        $redirected = $false
        while ($cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                $targets = @($item.Target)
                if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace($targets[0])) { throw "Cannot resolve directory link: $cursor" }
                $target = $targets[0]
                if ($target.StartsWith('\??\')) { $target = $target.Substring(4) }
                if (-not [System.IO.Path]::IsPathRooted($target)) { $target = Join-Path (Split-Path -Parent $cursor) $target }
                $suffix = $full.Substring($cursor.TrimEnd('\', '/').Length).TrimStart('\', '/')
                $next = if ($suffix) { Join-Path $target $suffix } else { $target }
                $full = (Resolve-Path -LiteralPath $next).Path
                $redirected = $true
                break
            }
            $parent = Split-Path -Parent $cursor
            if ($parent -eq $cursor) { break }
            $cursor = $parent
        }
        if (-not $redirected) { return $full }
    }
    throw 'Too many skill/workspace directory links.'
}

function Resolve-FwsWorkspaceRoot {
    param([string]$ExplicitPath, [switch]$HasExplicitPath)
    $candidate = if ($HasExplicitPath) { $ExplicitPath }
        elseif (-not [string]::IsNullOrWhiteSpace($env:FW_HOME)) { $env:FW_HOME }
        else { Join-Path (Resolve-FwsPhysicalDirectory -Directory $PSScriptRoot) '../../../..' }
    if ([string]::IsNullOrWhiteSpace($candidate)) { throw 'FW location is empty.' }
    $resolved = Resolve-FwsPhysicalDirectory -Directory $candidate
    # Accept either the FW program itself (including legacy flat checkouts),
    # or the workbench containing sibling fw/, fwc/, fwe/, fwa/ and fws/.
    # An explicit invalid root never falls back to FW_HOME or another checkout.
    foreach ($programCandidate in @($resolved, (Join-Path $resolved 'fw'))) {
        $packagePath = Join-Path $programCandidate 'package.json'
        if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) { continue }
        try { $package = Get-Content -Raw -LiteralPath $packagePath | ConvertFrom-Json }
        catch { continue }
        if ($package.PSObject.Properties['name'] -and $package.PSObject.Properties['fwWorkspace'] -and
            $package.name -eq 'fw' -and $package.fwWorkspace -is [bool] -and $package.fwWorkspace -eq $true -and
            (Test-Path -LiteralPath (Join-Path $programCandidate 'tools/sync.ps1') -PathType Leaf)) {
            return Resolve-FwsPhysicalDirectory -Directory $programCandidate
        }
    }
    throw 'Expected the FW program package (name=fw, fwWorkspace=true) with tools/sync.ps1, either at the supplied directory or its fw/ child.'
}
