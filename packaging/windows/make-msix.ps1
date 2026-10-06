# Build the Microsoft Store package (MSIX) from the PyInstaller output in dist\FlashcardViewer.
#
#   pwsh packaging/windows/make-msix.ps1 -IdentityName "12345Naved124.Riffle" `
#        -Publisher "CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" -PublisherDisplayName "Naved124"
#
# The three identity values are on Partner Center's "Product identity" page for the app. The package is
# not signed: the Store signs it when you submit it. Needs the Windows SDK (makeappx, makepri).
param(
  [string]$IdentityName = "Riffle.Local",
  [string]$Publisher = "CN=Riffle",
  [string]$PublisherDisplayName = "Naved124",
  [string]$Out = "dist"
)
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$app = Join-Path $root "dist\FlashcardViewer"
if (-not (Test-Path (Join-Path $app "FlashcardViewer.exe"))) { throw "Build the app with PyInstaller first ($app not found)" }

$ver = (Select-String -Path (Join-Path $root "flashcard_viewer\__init__.py") -Pattern '__version__ = "(.+)"').Matches[0].Groups[1].Value
$parts = @($ver.Split(".") | ForEach-Object { [int]$_ })
while ($parts.Count -lt 3) { $parts += 0 }
$msixVersion = "{0}.{1}.{2}.0" -f $parts[0], $parts[1], $parts[2]  # the Store needs the 4th number to be 0

$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $sdk) { throw "Windows SDK (makeappx.exe) not found" }
$makeappx = $sdk.FullName
$makepri = Join-Path $sdk.DirectoryName "makepri.exe"

$layout = Join-Path $root "build\msix\layout"
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory -Path $layout | Out-Null
Copy-Item (Join-Path $app "*") $layout -Recurse
Copy-Item (Join-Path $PSScriptRoot "msix\Assets") (Join-Path $layout "Assets") -Recurse

$esc = { param($s) [Security.SecurityElement]::Escape($s) }
$manifest = Get-Content (Join-Path $PSScriptRoot "msix\AppxManifest.xml") -Raw
$manifest = $manifest.Replace("__IDENTITY_NAME__", (& $esc $IdentityName))
$manifest = $manifest.Replace("__PUBLISHER_DISPLAY_NAME__", (& $esc $PublisherDisplayName))
$manifest = $manifest.Replace("__PUBLISHER__", (& $esc $Publisher))
$manifest = $manifest.Replace("__VERSION__", $msixVersion)
Set-Content -Path (Join-Path $layout "AppxManifest.xml") -Value $manifest -Encoding UTF8

# Index the scale-100/200 and taskbar-size images so Windows picks the right one (resources.pri).
$pri = Join-Path $root "build\msix\priconfig.xml"
& $makepri createconfig /cf $pri /dq en-US /pv 10.0.0 /o
if ($LASTEXITCODE -ne 0) { throw "makepri createconfig failed" }
& $makepri new /pr $layout /cf $pri /mn (Join-Path $layout "AppxManifest.xml") /of (Join-Path $layout "resources.pri") /o
if ($LASTEXITCODE -ne 0) { throw "makepri new failed" }

New-Item -ItemType Directory -Force -Path (Join-Path $root $Out) | Out-Null
$msix = Join-Path $root "$Out\Riffle-$ver.msix"
& $makeappx pack /d $layout /p $msix /o
if ($LASTEXITCODE -ne 0) { throw "makeappx pack failed" }
Write-Host "Built $msix (identity $IdentityName, version $msixVersion)"
