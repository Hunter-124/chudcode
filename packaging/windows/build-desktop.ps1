param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("windows-x64", "windows-arm64")]
    [string]$Target,

    [Parameter(Mandatory = $true)]
    [string]$BuildDir
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
$parallel = [Math]::Max(1, [Math]::Min(4, [Environment]::ProcessorCount))
if ($env:CMAKE_BUILD_PARALLEL_LEVEL) {
    $parallel = [int]$env:CMAKE_BUILD_PARALLEL_LEVEL
    if ($parallel -lt 1) { throw 'CMAKE_BUILD_PARALLEL_LEVEL must be positive' }
}

$expected = if ($Target -eq "windows-x64") {
    @{ Host = "X64"; CMake = "x64"; Machine = 0x8664 }
} else {
    @{ Host = "Arm64"; CMake = "ARM64"; Machine = 0xaa64 }
}

$hostArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($hostArchitecture -ne $expected.Host) {
    throw "Target $Target requires a native $($expected.Host) runner; this runner is $hostArchitecture. Refusing to cross-label a binary."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$absoluteBuildDir = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($repoRoot, $BuildDir))

cmake -S (Join-Path $repoRoot "gui") -B $absoluteBuildDir -G "Visual Studio 17 2022" -A $expected.CMake `
    -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON
if ($LASTEXITCODE -ne 0) { throw "CMake configure failed" }

cmake --build $absoluteBuildDir --config Release --parallel $parallel -- /nodeReuse:false
if ($LASTEXITCODE -ne 0) { throw "CMake build failed" }

# app_ini launches an interactive GLFW window and is exercised on the Linux/Xvfb
# leg. The remaining native unit executables run directly on each Windows arch.
ctest --test-dir $absoluteBuildDir -C Release --output-on-failure -E "^app_ini$"
if ($LASTEXITCODE -ne 0) { throw "Native GUI tests failed" }

$gui = Join-Path $absoluteBuildDir "Release/chudcode-gui.exe"
if (-not (Test-Path -LiteralPath $gui -PathType Leaf)) {
    throw "Native GUI build did not produce $gui"
}

# Read the PE COFF Machine field directly so packaging cannot turn an emulated or
# wrongly configured build into an artifact bearing another architecture's name.
$stream = [System.IO.File]::OpenRead($gui)
$reader = $null
try {
    $reader = [System.IO.BinaryReader]::new($stream)
    $stream.Position = 0x3c
    $peOffset = $reader.ReadUInt32()
    $stream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550) { throw "$gui is not a PE executable" }
    $machine = $reader.ReadUInt16()
} finally {
    if ($null -ne $reader) { $reader.Dispose() } else { $stream.Dispose() }
}
if ($machine -ne $expected.Machine) {
    throw ("$gui has PE machine 0x{0:x4}; expected 0x{1:x4} for {2}" -f $machine, $expected.Machine, $Target)
}

Write-Output $gui
