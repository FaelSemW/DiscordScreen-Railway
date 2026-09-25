$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$binaryDir = Join-Path $projectRoot 'desktop/bin'
New-Item -ItemType Directory -Force $binaryDir | Out-Null
$cloudflaredPath = Join-Path $binaryDir 'cloudflared.exe'
$expectedHash = '2837888CC0F5D58F15B6DC478376DE90B4D3BA5241C7947455D1E0A0DF429712'
if (!(Test-Path -LiteralPath $cloudflaredPath) -or (Get-FileHash -LiteralPath $cloudflaredPath -Algorithm SHA256).Hash -ne $expectedHash) {
    Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.1/cloudflared-windows-amd64.exe' -OutFile $cloudflaredPath
}
if ((Get-FileHash -LiteralPath $cloudflaredPath -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'O SHA256 do cloudflared não corresponde à versão esperada.'
}
dotnet publish (Join-Path $projectRoot 'desktop/native/DCSS.AudioCapture/DCSS.AudioCapture.csproj') -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $binaryDir
if ($LASTEXITCODE -ne 0) { throw 'Falha ao compilar o auxiliar de áudio.' }
Write-Host 'Binários preparados em desktop/bin.'
