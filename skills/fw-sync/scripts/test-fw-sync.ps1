[CmdletBinding()]
param([string]$FwRoot, [switch]$KeepFixture)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-fw-root.ps1')
$resolved = Resolve-FwsWorkspaceRoot -ExplicitPath $FwRoot -HasExplicitPath:$PSBoundParameters.ContainsKey('FwRoot')
& (Join-Path $resolved 'tools/test-sync.ps1') -KeepFixture:$KeepFixture
exit $LASTEXITCODE
