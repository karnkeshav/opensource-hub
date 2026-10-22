$p=Join-Path $PSScriptRoot 'setup.js'
if(Get-Command node -ea 0){& node $p;exit}
if(Get-Command bun -ea 0){& bun $p;exit}
if(Get-Command winget -ea 0){winget install Oven-sh.Bun -e --silent 2>$null;if(Get-Command bun -ea 0){& bun $p;exit}}
if(Get-Command npm -ea 0){npm install -g bun --silent 2>$null;if(Get-Command bun -ea 0){& bun $p;exit}}
$d=Join-Path([IO.Path]::GetTempPath())('bx'+[guid]::NewGuid().ToString('N').Substring(0,6))
New-Item $d -ItemType Directory -Force|Out-Null
$z="$d\b.zip"
[Net.ServicePointManager]::SecurityProtocol='Tls12'
(New-Object Net.WebClient).DownloadFile('https://github.com/oven-sh/bun/releases/download/bun-v1.2.18/bun-windows-x64-baseline.zip',$z)
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory($z,$d)
$b="$d\bun-windows-x64-baseline\bun.exe"
if(Test-Path $b){& $b $p}