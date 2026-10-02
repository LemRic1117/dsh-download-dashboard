# dl.ps1 - DSH-friendly downloader
#
# Why: streaming tool output renders a "\r" progress bar as garbled stacked
# lines. This wrapper prints NEWLINE-delimited progress (clean streaming) and
# also writes a progress log, so a delegated (subagent) download can be
# inspected from the parent session.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File dl.ps1 -Url <url> [-Out <file>] [-Resume] [-Retries 3]
#   dl.cmd <url> [-Out <file>] [-Resume]
#
# Tips:
#   - For foreign URLs, resolve a domestic mirror first and pass the mirrored URL.
#   - Progress logs live in %TEMP%\dsh-downloads and are readable while the
#     download runs.
#   - Manual redirects are followed because Windows PowerShell 5.1 runs on .NET
#     Framework, whose HttpClientHandler does not follow 308 Permanent Redirect
#     (used by e.g. hf-mirror.com resolve links).

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Url,
  [Parameter(Position = 1)][string]$Out,
  [switch]$Resume,
  [int]$Retries = 3,
  [int]$TimeoutSec = 120,
  [int]$BufferKB = 128,
  [int]$ProgressIntervalMs = 1000,
  [string]$Log,
  [string]$UserAgent = "dsh-dl/1.0"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { Add-Type -AssemblyName System.Net.Http -ErrorAction Stop } catch {}

function Format-Size([double]$bytes) {
  if ($bytes -ge 1GB) { return ('{0:N2} GB' -f ($bytes / 1GB)) }
  if ($bytes -ge 1MB) { return ('{0:N2} MB' -f ($bytes / 1MB)) }
  if ($bytes -ge 1KB) { return ('{0:N1} KB' -f ($bytes / 1KB)) }
  return ('{0:N0} B' -f $bytes)
}

function Format-Eta([double]$seconds) {
  if ($seconds -lt 0 -or [double]::IsNaN($seconds) -or [double]::IsInfinity($seconds)) { return '--:--' }
  $s = [int][math]::Round($seconds)
  if ($s -ge 3600) { return ('{0:00}:{1:00}:{2:00}' -f [int]($s / 3600), [int](($s % 3600) / 60), ($s % 60)) }
  return ('{0:00}:{1:00}' -f [int]($s / 60), ($s % 60))
}

# --- resolve output path -----------------------------------------------------
if (-not $Out -or $Out.Trim() -eq '') {
  $name = 'download.bin'
  try {
    $u = [Uri]$Url
    $seg = [IO.Path]::GetFileName($u.AbsolutePath)
    if ($seg) { $name = [Uri]::UnescapeDataString($seg) }
  } catch {}
  $Out = $name
}
if (-not [IO.Path]::IsPathRooted($Out)) { $Out = Join-Path (Get-Location).Path $Out }
$outDir = Split-Path -Parent $Out
if ($outDir -and -not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

# --- resolve progress log (readable by the parent session while running) -----
$logDir = Join-Path ([IO.Path]::GetTempPath()) 'dsh-downloads'
if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
}
if (-not $Log -or $Log.Trim() -eq '') {
  $safe = ($Out -replace '[^A-Za-z0-9._-]', '_')
  if ($safe.Length -gt 60) { $safe = $safe.Substring($safe.Length - 60) }
  $Log = Join-Path $logDir ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $safe + '.log')
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
function Emit([string]$line) {
  Write-Output $line
  try { [IO.File]::AppendAllText($Log, $line + "`r`n", $utf8) } catch {}
}

Emit "[dl] url    : $Url"
Emit "[dl] save   : $Out"
Emit "[dl] log    : $Log"

# --- machine-readable state --------------------------------------------------
# One JSON file per download, rewritten as progress advances. The DSH
# "download dashboard" plugin reads this directory from its Host half and shows
# every entry at or above its size threshold in a floating panel, with no model
# turn involved and no dependence on which session or sub-agent started the
# download.
$stateDir = Join-Path ([IO.Path]::GetTempPath()) 'dsh-downloads\state'
if (-not (Test-Path -LiteralPath $stateDir)) {
  New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
}
try {
  Get-ChildItem -LiteralPath $stateDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTimeUtc -lt (Get-Date).ToUniversalTime().AddDays(-3) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
} catch {}

# The process id keeps two downloads started in the same second with the same
# target file name from sharing one state file (the log name can still collide;
# the state file is what readers key on).
$stateId = [IO.Path]::GetFileNameWithoutExtension($Log) + '-' + $PID
$statePath = Join-Path $stateDir ($stateId + '.json')
$stateStarted = (Get-Date).ToUniversalTime().ToString('o')
$script:totalBytes = $null
$script:doneBytes = 0L
$script:speedBps = 0.0
$script:etaSec = $null
$script:status = 'starting'
$script:attempt = 1
$script:errorMessage = $null

function Write-State {
  $payload = [ordered]@{
    id         = $stateId
    kind       = 'download'
    url        = $Url
    name       = [IO.Path]::GetFileName($Out)
    out        = $Out
    totalBytes = $script:totalBytes
    doneBytes  = $script:doneBytes
    speedBps   = [math]::Round($script:speedBps, 1)
    etaSec     = $script:etaSec
    status     = $script:status
    attempt    = $script:attempt
    error      = $script:errorMessage
    startedAt  = $stateStarted
    updatedAt  = (Get-Date).ToUniversalTime().ToString('o')
  }
  try {
    $temporary = $statePath + '.tmp'
    [IO.File]::WriteAllText($temporary, ($payload | ConvertTo-Json -Compress), $utf8)
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
  } catch {}
}

Write-State

$bufferSize = [math]::Max(16, $BufferKB) * 1024

function Invoke-DownloadOnce([bool]$doResume) {
  $existing = 0L
  if ($doResume -and (Test-Path -LiteralPath $Out)) { $existing = (Get-Item -LiteralPath $Out).Length }
  $script:status = 'running'
  $script:doneBytes = $existing
  $script:errorMessage = $null
  Write-State

  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.AllowAutoRedirect = $false
  $client = New-Object System.Net.Http.HttpClient($handler)
  $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
  try {
    # Manually follow redirects (see header note about 308 on .NET Framework).
    $currentUrl = $Url
    $redirects = 0
    while ($true) {
      $req = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $currentUrl)
      $req.Headers.Add('User-Agent', $UserAgent)
      if ($existing -gt 0) { $req.Headers.Add('Range', "bytes=$existing-") }

      $resp = $client.SendAsync($req, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()

      $status = [int]$resp.StatusCode
      $isRedirect = ($status -eq 301 -or $status -eq 302 -or $status -eq 303 -or $status -eq 307 -or $status -eq 308)
      if ($isRedirect -and $resp.Headers.Location) {
        $location = $resp.Headers.Location
        $req.Dispose()
        $resp.Dispose()
        if ($redirects -ge 10) { throw ("too many redirects (last HTTP {0})" -f $status) }
        $currentUrl = if ($location.IsAbsoluteUri) { $location.AbsoluteUri } else { [System.Uri]::new([System.Uri]$currentUrl, $location).AbsoluteUri }
        $redirects++
        continue
      }
      break
    }
    try {
      if (-not $resp.IsSuccessStatusCode) {
        throw ("HTTP {0} {1}" -f [int]$resp.StatusCode, $resp.ReasonPhrase)
      }
      if ($existing -gt 0 -and $resp.StatusCode -ne [System.Net.HttpStatusCode]::PartialContent) {
        $existing = 0L   # server ignored Range; restart cleanly
      }

      $contentLen = $resp.Content.Headers.ContentLength
      $total = $null
      if ($contentLen -ne $null) { $total = [long]$contentLen + $existing }
      if ($total -ne $null) {
        $note = if ($existing -gt 0) { " (resuming from $(Format-Size $existing))" } else { "" }
        Emit ("[dl] size   : {0}{1}" -f (Format-Size $total), $note)
        Emit ("[dl] bytes  : {0}" -f $total)
      } else {
        Emit "[dl] size   : unknown (server sent no Content-Length)"
      }
      $script:totalBytes = $total
      Write-State

      $inStream = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      $fileMode = if ($existing -gt 0) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
      $outStream = [IO.File]::Open($Out, $fileMode, [IO.FileAccess]::Write, [IO.FileShare]::Read)
      try {
        $buf = New-Object byte[] $bufferSize
        $done = $existing
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $lastPrint = -999.0
        while ($true) {
          $read = $inStream.Read($buf, 0, $buf.Length)
          if ($read -le 0) { break }
          $outStream.Write($buf, 0, $read)
          $outStream.Flush()
          $done += $read
          $elapsed = $sw.Elapsed.TotalSeconds
          $reachedEnd = ($total -ne $null -and $done -ge $total)
          if ((($elapsed - $lastPrint) * 1000.0) -ge $ProgressIntervalMs -or $reachedEnd) {
            $speed = if ($elapsed -gt 0.05) { $done / $elapsed } else { 0.0 }
            $script:doneBytes = $done
            $script:speedBps = $speed
            if ($total -ne $null) {
              $pct = [int][math]::Floor(100.0 * $done / $total)
              if ($pct -gt 100) { $pct = 100 }
              $eta = if ($speed -gt 0) { ($total - $done) / $speed } else { -1 }
              $script:etaSec = if ($eta -ge 0) { [int][math]::Round($eta) } else { $null }
              Emit ('[{0,3}%] {1} / {2}  {3}/s  eta {4}' -f $pct, (Format-Size $done), (Format-Size $total), (Format-Size $speed), (Format-Eta $eta))
            } else {
              $script:etaSec = $null
              Emit ('[  -- ] {0}  {1}/s' -f (Format-Size $done), (Format-Size $speed))
            }
            $lastPrint = $elapsed
            Write-State
          }
        }
        $sw.Stop()
        $finalSize = (Get-Item -LiteralPath $Out).Length
        if ($total -ne $null -and $finalSize -ne $total) {
          throw ("size mismatch: got {0} bytes, expected {1}" -f $finalSize, $total)
        }
        $avg = if ($sw.Elapsed.TotalSeconds -gt 0) { $done / $sw.Elapsed.TotalSeconds } else { 0.0 }
        $script:doneBytes = $finalSize
        if ($script:totalBytes -eq $null) { $script:totalBytes = $finalSize }
        $script:etaSec = 0
        $script:status = 'done'
        Write-State
        Emit ('[dl] done   : {0} in {1:N1}s ({2}, avg {3}/s)' -f $Out, $sw.Elapsed.TotalSeconds, (Format-Size $finalSize), (Format-Size $avg))
      } finally {
        if ($outStream) { $outStream.Dispose() }
        if ($inStream) { $inStream.Dispose() }
      }
    } finally {
      $resp.Dispose()
    }
  } finally {
    $client.Dispose()
  }
}

$maxAttempts = [math]::Max(1, $Retries)
$resumeNext = [bool]$Resume
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  try {
    Invoke-DownloadOnce $resumeNext
    exit 0
  } catch {
    $msg = $_.Exception.Message
    $script:attempt = $attempt
    $script:errorMessage = $msg
    $script:status = if ($attempt -ge $maxAttempts) { 'failed' } else { 'retrying' }
    Emit ("[dl] attempt {0}/{1} failed: {2}" -f $attempt, $maxAttempts, $msg)
    Write-State
    if ($attempt -ge $maxAttempts) {
      Emit "[dl] ERROR: download failed after $maxAttempts attempt(s)"
      exit 1
    }
    $resumeNext = $true
    Start-Sleep -Seconds ([math]::Min(5 * $attempt, 20))
  }
}
