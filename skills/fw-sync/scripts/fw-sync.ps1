[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'new', 'sync', 'pull', 'push', 'verify')]
    [string]$Action = 'status',
    [string]$ProjectRoot = (Get-Location).Path,
    [string]$FwRoot,
    [Alias('FwPath')][string]$FwcPath,
    [string]$FwePath,
    [string]$FwaPath,
    [string]$FwsPath,
    [Alias('FwUrl')][string]$FwcUrl,
    [string]$FweUrl,
    [string]$FwaUrl,
    [string]$FwsUrl,
    [Alias('FwTarget')][string]$FwcTarget,
    [string]$FweTarget,
    [string]$FwaTarget,
    [string]$FwsTarget,
    [ValidateSet('all', 'fwc', 'fwe', 'fwa', 'fws')]
    [string]$Component = 'all',
    [string]$Components = '',
    [switch]$Fetch,
    [switch]$Apply,
    [switch]$Json
)

# FWS supplies task guidance, not another Git engine. No network/bootstrap writes.
$ErrorActionPreference = 'Stop'
try {
    . (Join-Path $PSScriptRoot 'resolve-fw-root.ps1')
    $resolved = Resolve-FwsWorkspaceRoot -ExplicitPath $FwRoot -HasExplicitPath:$PSBoundParameters.ContainsKey('FwRoot')
    $engine = Join-Path $resolved 'tools/sync.ps1'
}
catch {
    Write-Error "FW Git engine was not found or verified. Install/check out FW separately, then pass -FwRoot <FW workbench or its fw program directory> or set FW_HOME. FWC's historical fw/ directory is not FW. No download was attempted. $($_.Exception.Message)" -ErrorAction Continue
    exit 2
}
$forward = @{} + $PSBoundParameters
$forward.Remove('FwRoot')
& $engine @forward
exit $LASTEXITCODE
