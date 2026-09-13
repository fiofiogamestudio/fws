$ErrorActionPreference = 'Stop'
$componentRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$checkOnly = $false

try {
    foreach ($argument in $args) {
        switch ($argument) {
            '--check' { $checkOnly = $true }
            '--help' {
                Write-Host 'Usage: start.bat [--check | --help]'
                Write-Host 'Opens the FWS skills folder and prints the installation command.'
                Write-Host '--check validates paths without opening windows or installing skills.'
                exit 0
            }
            default { throw "Unknown option: $argument. Use --help." }
        }
    }
    foreach ($required in @('README.md', 'skills', 'tools/install.mjs', 'package.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $componentRoot $required))) { throw "Incomplete FWS source: missing $required." }
    }
    $package = Get-Content -Raw -LiteralPath (Join-Path $componentRoot 'package.json') | ConvertFrom-Json
    if ($package.name -ne 'fws') { throw 'Expected the FWS package (name=fws).' }
    Set-Location -LiteralPath $componentRoot
    $skillsPath = Join-Path $componentRoot 'skills'
    Write-Host "FWS skills: $skillsPath"
    Write-Host 'Read each SKILL.md or README.md for usage and installation.'
    Write-Host 'Install preview (requires Node.js 20.10+; choose your actual client skills folder):'
    Write-Host ('  node "' + (Join-Path $componentRoot 'tools/install.mjs') + '" --target "C:\path\to\client\skills"')
    Write-Host 'After reviewing the preview, add --apply to install. This launcher does not install skills.'
    if ($checkOnly) { Write-Host 'FWS_CHECK_OK: skill and installer paths exist.' }
    else { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"' + $skillsPath + '"') -ErrorAction Stop | Out-Null }
    exit 0
}
catch {
    [Console]::Error.WriteLine("FWS launch failed: $($_.Exception.Message)")
    exit 1
}
