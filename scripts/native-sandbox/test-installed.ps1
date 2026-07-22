[CmdletBinding()]
param(
  [switch]$ElevatedLifecycle,
  [string]$OwnerSid,
  [string]$LifecycleResultPath,
  [switch]$SkipBuild,
  [switch]$SkipLifecycle,
  [switch]$KeepArtifactsOnFailure,
  [string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$nativeTarget = Join-Path $repoRoot 'native\sandbox-windows\target'
$releaseDirectory = Join-Path $nativeTarget 'release'
$setupPath = Join-Path $releaseDirectory 'lobster-sandbox-setup.exe'
$defaultReportPath = Join-Path $nativeTarget 'installed-test-report.json'
$script:results = New-Object 'System.Collections.Generic.List[object]'
$script:overallPassed = $true
$script:fatalMessage = $null

function Write-Utf8Json {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )

  $parent = Split-Path -Parent $Path
  if ($parent) {
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
  }
  $json = $Value | ConvertTo-Json -Depth 20
  [System.IO.File]::WriteAllText(
    $Path,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
  )
}

function Invoke-NativeProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @()
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { $_.ToString() })
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  [pscustomobject]@{
    ExitCode = $exitCode
    Output = $output
  }
}

function ConvertFrom-NativeJsonOutput {
  param([string[]]$Lines)

  $items = @($Lines)
  for ($index = $items.Count - 1; $index -ge 0; $index -= 1) {
    $candidate = $items[$index].Trim()
    if (-not $candidate.StartsWith('{')) {
      continue
    }
    try {
      return $candidate | ConvertFrom-Json
    } catch {
      continue
    }
  }
  return $null
}

function Invoke-SetupOperation {
  param(
    [Parameter(Mandatory = $true)][string]$Operation,
    [switch]$InternalElevated,
    [string]$RequestedOwnerSid
  )

  $arguments = @($Operation)
  if ($InternalElevated) {
    $arguments += '--elevated'
    $arguments += '--owner-sid'
    $arguments += $RequestedOwnerSid
  }
  $invocation = Invoke-NativeProcess -FilePath $setupPath -Arguments $arguments
  [pscustomobject]@{
    ExitCode = $invocation.ExitCode
    Output = $invocation.Output
    Report = ConvertFrom-NativeJsonOutput -Lines $invocation.Output
  }
}

function Test-SetupInvocation {
  param([object]$Invocation)

  return $null -ne $Invocation.Report `
    -and $Invocation.ExitCode -eq 0 `
    -and $Invocation.Report.success -eq $true `
    -and $Invocation.Report.healthy -eq $true
}

function Get-OptionalPropertyValue {
  param(
    [object]$Object,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if ($null -eq $Object) {
    return $null
  }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Add-TestResult {
  param(
    [Parameter(Mandatory = $true)][string]$Test,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Actual,
    [Parameter(Mandatory = $true)][bool]$Passed
  )

  $script:results.Add([pscustomobject]@{
    Test = $Test
    Expected = $Expected
    Actual = $Actual
    Passed = $Passed
  })
  if (-not $Passed) {
    $script:overallPassed = $false
  }
}

function Format-SetupActual {
  param([object]$Invocation)

  if ($null -eq $Invocation.Report) {
    $text = (@($Invocation.Output) -join ' ').Trim()
    if ($text.Length -gt 240) {
      $text = $text.Substring(0, 240) + '...'
    }
    return "exit=$($Invocation.ExitCode), invalid report: $text"
  }
  $reportMessage = Get-OptionalPropertyValue -Object $Invocation.Report -Name 'message'
  $reportErrorCode = Get-OptionalPropertyValue -Object $Invocation.Report -Name 'errorCode'
  $message = if ($reportMessage) { ", $reportMessage" } else { '' }
  $errorCode = if ($reportErrorCode) { ", error=$reportErrorCode" } else { '' }
  return "exit=$($Invocation.ExitCode), success=$($Invocation.Report.success), healthy=$($Invocation.Report.healthy)$errorCode$message"
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-ElevatedLifecycleBody {
  if (-not (Test-IsAdministrator)) {
    throw 'The installed Sandbox lifecycle test requires an elevated process.'
  }
  if (-not $OwnerSid) {
    throw 'The original non-elevated owner SID was not provided.'
  }
  if (-not $LifecycleResultPath) {
    throw 'The elevated lifecycle result path was not provided.'
  }
  if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
    throw "The release setup helper is missing: $setupPath"
  }

  $steps = New-Object 'System.Collections.Generic.List[object]'
  $payload = [ordered]@{
    schemaVersion = 1
    success = $false
    ownerSid = $OwnerSid
    steps = $steps
    error = $null
  }

  try {
    $operations = @('repair', 'verify', 'repair', 'verify')
    for ($index = 0; $index -lt $operations.Count; $index += 1) {
      $operation = $operations[$index]
      $invocation = if ($operation -eq 'verify') {
        Invoke-SetupOperation -Operation $operation
      } else {
        Invoke-SetupOperation `
          -Operation $operation `
          -InternalElevated `
          -RequestedOwnerSid $OwnerSid
      }
      $passed = Test-SetupInvocation -Invocation $invocation
      $steps.Add([pscustomobject]@{
        name = "elevated-$operation-$($index + 1)"
        operation = $operation
        exitCode = $invocation.ExitCode
        passed = $passed
        report = $invocation.Report
        output = if ($null -eq $invocation.Report) { @($invocation.Output) } else { @() }
      })
      if (-not $passed) {
        break
      }
    }
    $payload.success = $steps.Count -eq $operations.Count `
      -and @($steps | Where-Object { -not $_.passed }).Count -eq 0
  } catch {
    $payload.error = $_.Exception.Message
  }

  Write-Utf8Json -Path $LifecycleResultPath -Value $payload
  if ($payload.success) {
    exit 0
  }
  exit 1
}

function Invoke-ElevatedLifecycle {
  param(
    [Parameter(Mandatory = $true)][string]$OriginalOwnerSid,
    [Parameter(Mandatory = $true)][string]$ResultPath
  )

  Remove-Item -LiteralPath $ResultPath -Force -ErrorAction SilentlyContinue
  $escapedScript = $PSCommandPath.Replace("'", "''")
  $escapedOwner = $OriginalOwnerSid.Replace("'", "''")
  $escapedResult = $ResultPath.Replace("'", "''")
  $command = "& '$escapedScript' -ElevatedLifecycle -OwnerSid '$escapedOwner' -LifecycleResultPath '$escapedResult'"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $process = Start-Process `
    -FilePath 'powershell.exe' `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded) `
    -Verb RunAs `
    -WindowStyle Hidden `
    -Wait `
    -PassThru

  if (-not (Test-Path -LiteralPath $ResultPath -PathType Leaf)) {
    throw "The elevated lifecycle process exited with code $($process.ExitCode) without a result."
  }
  return Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
}

function New-RunRequest {
  param(
    [Parameter(Mandatory = $true)][string]$Workspace,
    [Parameter(Mandatory = $true)][string[]]$Command,
    [string[]]$ReadableRoots = @(),
    [string[]]$AdditionalWritableRoots = @()
  )

  $profileHome = if ($env:HOME) { $env:HOME } else { $env:USERPROFILE }
  $writableRoots = @($Workspace)
  $writableRoots += @($AdditionalWritableRoots)
  return [ordered]@{
    protocolVersion = 4
    policy = [ordered]@{
      policyVersion = 'workspace-write-v4'
      taskId = 'installed-smoke'
      agentId = 'main'
      cwd = $Workspace
      writableRoots = $writableRoots
      readableRoots = @($ReadableRoots)
      protectedPaths = @()
      profile = [ordered]@{
        mode = 'inherit-host'
        homeDir = $profileHome
        userProfileDir = $env:USERPROFILE
        appDataDir = $env:APPDATA
        localAppDataDir = $env:LOCALAPPDATA
      }
      scratchDir = Join-Path $Workspace '.scratch'
      networkMode = 'disabled'
      limits = [ordered]@{
        timeoutMs = 30000
        maxProcesses = 16
        maxOutputBytes = 1048576
      }
    }
    command = [ordered]@{
      argv = $Command
      env = [ordered]@{}
    }
  }
}

function Read-JsonFile {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Write-FinalReport {
  $resolvedReportPath = if ($ReportPath) {
    [System.IO.Path]::GetFullPath($ReportPath)
  } else {
    $defaultReportPath
  }
  $report = [ordered]@{
    schemaVersion = 1
    passed = $script:overallPassed
    generatedAt = [DateTimeOffset]::Now.ToString('o')
    fatalMessage = $script:fatalMessage
    results = $script:results
  }
  Write-Utf8Json -Path $resolvedReportPath -Value $report
  Write-Host ''
  $script:results | Format-Table Test, Expected, Actual, Passed -AutoSize -Wrap
  Write-Host "`nInstalled Sandbox report: $resolvedReportPath"
  return $resolvedReportPath
}

if ($ElevatedLifecycle) {
  Invoke-ElevatedLifecycleBody
}

if ($env:OS -ne 'Windows_NT') {
  throw 'The installed Sandbox integration test only supports Windows.'
}
if (Test-IsAdministrator) {
  throw 'Run this command from the same non-elevated user context as LobsterAI.'
}

$testRoot = $null
$policyRequestPath = $null
try {
  if (-not $SkipBuild) {
    $build = Invoke-NativeProcess -FilePath 'npm.cmd' -Arguments @('run', 'sandbox-native:build')
    $buildPassed = $build.ExitCode -eq 0 -and (Test-Path -LiteralPath $setupPath -PathType Leaf)
    Add-TestResult `
      -Test 'Release runtime build' `
      -Expected 'release setup and runner are available' `
      -Actual "exit=$($build.ExitCode)" `
      -Passed $buildPassed
    if (-not $buildPassed) {
      throw (@($build.Output) -join [Environment]::NewLine)
    }
  }

  if (-not $SkipLifecycle) {
    $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $lifecyclePath = Join-Path $nativeTarget 'installed-lifecycle-result.json'
    $lifecycle = Invoke-ElevatedLifecycle -OriginalOwnerSid $ownerSid -ResultPath $lifecyclePath
    foreach ($step in @($lifecycle.steps)) {
      $actual = if ($step.report) {
        $reportMessage = Get-OptionalPropertyValue -Object $step.report -Name 'message'
        $reportErrorCode = Get-OptionalPropertyValue -Object $step.report -Name 'errorCode'
        $message = if ($reportMessage) { ", $reportMessage" } else { '' }
        $errorCode = if ($reportErrorCode) { ", error=$reportErrorCode" } else { '' }
        "exit=$($step.exitCode), healthy=$($step.report.healthy)$errorCode$message"
      } else {
        "exit=$($step.exitCode), no setup report"
      }
      Add-TestResult `
        -Test $step.name `
        -Expected 'setup succeeds and reports healthy' `
        -Actual $actual `
        -Passed ([bool]$step.passed)
    }
    if (-not $lifecycle.success) {
      $detail = if ($lifecycle.error) { $lifecycle.error } else { 'Elevated lifecycle validation failed.' }
      throw $detail
    }
  }

  $ownerVerify = Invoke-SetupOperation -Operation 'verify'
  $ownerVerifyPassed = Test-SetupInvocation -Invocation $ownerVerify
  Add-TestResult `
    -Test 'Non-elevated owner verification' `
    -Expected 'the LobsterAI user can verify the protected installation' `
    -Actual (Format-SetupActual -Invocation $ownerVerify) `
    -Passed $ownerVerifyPassed
  if (-not $ownerVerifyPassed) {
    throw 'The protected installation is not usable by the original non-elevated owner.'
  }

  $runnerPath = $ownerVerify.Report.runnerPath
  if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "The installed runner is missing: $runnerPath"
  }

  $testId = [Guid]::NewGuid().ToString('N')
  $testRoot = Join-Path $nativeTarget "installed-smoke-$testId"
  $workspace = Join-Path $testRoot 'workspace'
  $outside = Join-Path $testRoot 'outside'
  [System.IO.Directory]::CreateDirectory($workspace) | Out-Null
  [System.IO.Directory]::CreateDirectory($outside) | Out-Null
  & icacls.exe $testRoot /grant '*S-1-5-32-545:(OI)(CI)M' | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Could not prepare the broad ordinary-user ACL on $testRoot"
  }

  $insideFile = Join-Path $workspace 'inside-ok.txt'
  $outsideFile = Join-Path $outside 'outside-should-deny.txt'
  $skillsRoot = Join-Path $env:APPDATA 'LobsterAI\SKILLs'
  $skillFile = if (Test-Path -LiteralPath $skillsRoot -PathType Container) {
    Get-ChildItem -LiteralPath $skillsRoot -Filter 'SKILL.md' -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
  } else {
    $null
  }
  $readableRoots = @()
  if ($skillFile) {
    $readableRoots += $skillsRoot
  }
  $npmCacheRoot = Join-Path $env:LOCALAPPDATA 'npm-cache'
  $additionalWritableRoots = @()
  if (Test-Path -LiteralPath $npmCacheRoot -PathType Container) {
    $additionalWritableRoots += $npmCacheRoot
  }
  $insideCommand = @(
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "`$ErrorActionPreference='Stop'; Write-Output 'sandbox-stdout-ok'; [Console]::Error.WriteLine('sandbox-stderr-ok'); Set-Content -LiteralPath '$insideFile' -Value 'inside-ok' -NoNewline"
  )
  $outsideCommand = @(
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "`$ErrorActionPreference='Stop'; Set-Content -LiteralPath '$outsideFile' -Value 'outside-bad' -NoNewline"
  )
  $policyRequestPath = Join-Path $workspace 'inside-request.json'
  $outsideRequestPath = Join-Path $workspace 'outside-request.json'
  Write-Utf8Json -Path $policyRequestPath -Value (
    New-RunRequest `
      -Workspace $workspace `
      -Command $insideCommand `
      -ReadableRoots $readableRoots `
      -AdditionalWritableRoots $additionalWritableRoots
  )
  Write-Utf8Json -Path $outsideRequestPath -Value (
    New-RunRequest `
      -Workspace $workspace `
      -Command $outsideCommand `
      -ReadableRoots $readableRoots `
      -AdditionalWritableRoots $additionalWritableRoots
  )

  $runnerVerify = Invoke-NativeProcess -FilePath $runnerPath -Arguments @('verify', $policyRequestPath)
  $runnerVerification = ConvertFrom-NativeJsonOutput -Lines $runnerVerify.Output
  $runnerVerifyPassed = $runnerVerify.ExitCode -eq 0 `
    -and $null -ne $runnerVerification `
    -and $runnerVerification.restrictedToken `
    -and $runnerVerification.writeRestricted `
    -and $runnerVerification.ownerPreserved `
    -and $runnerVerification.dedicatedIdentity `
    -and $runnerVerification.runtimeIntegrityVerified `
    -and $runnerVerification.networkIsolated
  Add-TestResult `
    -Test 'Installed runner verification' `
    -Expected 'dedicated identity, restricted token, integrity and network boundary are active' `
    -Actual "exit=$($runnerVerify.ExitCode), report=$($null -ne $runnerVerification)" `
    -Passed $runnerVerifyPassed
  if (-not $runnerVerifyPassed) {
    throw (@($runnerVerify.Output) -join [Environment]::NewLine)
  }

  $insideReportPath = Join-Path $workspace 'inside-report.json'
  $insideRun = Invoke-NativeProcess `
    -FilePath $runnerPath `
    -Arguments @('run', $policyRequestPath, '--report-file', $insideReportPath)
  $insideReport = Read-JsonFile -Path $insideReportPath
  $insidePassed = $insideRun.ExitCode -eq 0 `
    -and $null -ne $insideReport `
    -and $insideReport.outcome -eq 'completed' `
    -and $insideReport.exitCode -eq 0 `
    -and (@($insideRun.Output) -join "`n").Contains('sandbox-stdout-ok') `
    -and (@($insideRun.Output) -join "`n").Contains('sandbox-stderr-ok') `
    -and (Test-Path -LiteralPath $insideFile -PathType Leaf) `
    -and (Get-Content -LiteralPath $insideFile -Raw) -eq 'inside-ok'
  Add-TestResult `
    -Test 'Workspace write' `
    -Expected 'PowerShell writes inside the selected workspace' `
    -Actual "runnerExit=$($insideRun.ExitCode), fileCreated=$(Test-Path -LiteralPath $insideFile), outputForwarded=$((@($insideRun.Output) -join "`n").Contains('sandbox-stdout-ok') -and (@($insideRun.Output) -join "`n").Contains('sandbox-stderr-ok'))" `
    -Passed $insidePassed

  $outsideReportPath = Join-Path $workspace 'outside-report.json'
  $outsideRun = Invoke-NativeProcess `
    -FilePath $runnerPath `
    -Arguments @('run', $outsideRequestPath, '--report-file', $outsideReportPath)
  $outsideReport = Read-JsonFile -Path $outsideReportPath
  $outsidePassed = $outsideRun.ExitCode -ne 0 `
    -and $null -ne $outsideReport `
    -and $outsideReport.outcome -eq 'completed' `
    -and $outsideReport.exitCode -ne 0 `
    -and -not (Test-Path -LiteralPath $outsideFile)
  Add-TestResult `
    -Test 'Outside-workspace write denial' `
    -Expected 'PowerShell cannot write to a broadly writable sibling directory' `
    -Actual "runnerExit=$($outsideRun.ExitCode), fileCreated=$(Test-Path -LiteralPath $outsideFile)" `
    -Passed $outsidePassed

  if ($skillFile) {
    $skillReadMarker = Join-Path $workspace 'skill-read-ok.txt'
    $skillReadCommand = @(
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "`$ErrorActionPreference='Stop'; [void][IO.File]::ReadAllBytes('$($skillFile.FullName)'); Set-Content -LiteralPath '$skillReadMarker' -Value 'skill-read-ok' -NoNewline"
    )
    $skillReadRequestPath = Join-Path $workspace 'skill-read-request.json'
    $skillReadReportPath = Join-Path $workspace 'skill-read-report.json'
    Write-Utf8Json -Path $skillReadRequestPath -Value (
      New-RunRequest `
        -Workspace $workspace `
        -Command $skillReadCommand `
        -ReadableRoots $readableRoots `
        -AdditionalWritableRoots $additionalWritableRoots
    )
    $skillReadRun = Invoke-NativeProcess `
      -FilePath $runnerPath `
      -Arguments @('run', $skillReadRequestPath, '--report-file', $skillReadReportPath)
    $skillReadReport = Read-JsonFile -Path $skillReadReportPath
    $skillReadPassed = $skillReadRun.ExitCode -eq 0 `
      -and $null -ne $skillReadReport `
      -and $skillReadReport.exitCode -eq 0 `
      -and (Test-Path -LiteralPath $skillReadMarker -PathType Leaf)
    Add-TestResult `
      -Test 'LobsterAI Skill read root' `
      -Expected 'an existing SKILL.md is readable without exposing its contents' `
      -Actual "runnerExit=$($skillReadRun.ExitCode), markerCreated=$(Test-Path -LiteralPath $skillReadMarker)" `
      -Passed $skillReadPassed

    $skillWriteProbe = Join-Path $skillsRoot "lobster-installed-sandbox-$testId.tmp"
    $skillWriteCommand = @(
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "`$ErrorActionPreference='Stop'; Set-Content -LiteralPath '$skillWriteProbe' -Value 'must-not-write' -NoNewline"
    )
    $skillWriteRequestPath = Join-Path $workspace 'skill-write-request.json'
    $skillWriteReportPath = Join-Path $workspace 'skill-write-report.json'
    Write-Utf8Json -Path $skillWriteRequestPath -Value (
      New-RunRequest `
        -Workspace $workspace `
        -Command $skillWriteCommand `
        -ReadableRoots $readableRoots `
        -AdditionalWritableRoots $additionalWritableRoots
    )
    $skillWriteRun = Invoke-NativeProcess `
      -FilePath $runnerPath `
      -Arguments @('run', $skillWriteRequestPath, '--report-file', $skillWriteReportPath)
    $skillWriteReport = Read-JsonFile -Path $skillWriteReportPath
    $skillWriteCreated = Test-Path -LiteralPath $skillWriteProbe
    $skillWritePassed = $skillWriteRun.ExitCode -ne 0 `
      -and $null -ne $skillWriteReport `
      -and $skillWriteReport.exitCode -ne 0 `
      -and -not $skillWriteCreated
    if ($skillWriteCreated) {
      Remove-Item -LiteralPath $skillWriteProbe -Force -ErrorAction SilentlyContinue
    }
    Add-TestResult `
      -Test 'LobsterAI Skill write denial' `
      -Expected 'the declared Skill root remains read-only' `
      -Actual "runnerExit=$($skillWriteRun.ExitCode), fileCreated=$skillWriteCreated" `
      -Passed $skillWritePassed
  } else {
    Add-TestResult `
      -Test 'LobsterAI Skill read root' `
      -Expected 'an existing SKILL.md is readable when the product root exists' `
      -Actual 'SKILLs root is absent; scenario skipped' `
      -Passed $true
  }

  $toolMarker = Join-Path $workspace 'node-npm-ok.txt'
  $cacheProbe = if (@($additionalWritableRoots).Count -gt 0) {
    Join-Path $npmCacheRoot "lobster-installed-sandbox-$testId.tmp"
  } else {
    $null
  }
  $cacheScript = if ($cacheProbe) {
    "Set-Content -LiteralPath '$cacheProbe' -Value 'cache-ok' -NoNewline; Remove-Item -LiteralPath '$cacheProbe' -Force; "
  } else {
    ''
  }
  $toolCommand = @(
    'powershell.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    "`$ErrorActionPreference='Stop'; & node --version; if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }; & npm --version; if (`$LASTEXITCODE -ne 0) { exit `$LASTEXITCODE }; $cacheScript Set-Content -LiteralPath '$toolMarker' -Value 'tools-ok' -NoNewline"
  )
  $toolRequestPath = Join-Path $workspace 'node-npm-request.json'
  $toolReportPath = Join-Path $workspace 'node-npm-report.json'
  Write-Utf8Json -Path $toolRequestPath -Value (
    New-RunRequest `
      -Workspace $workspace `
      -Command $toolCommand `
      -ReadableRoots $readableRoots `
      -AdditionalWritableRoots $additionalWritableRoots
  )
  $toolRun = Invoke-NativeProcess `
    -FilePath $runnerPath `
    -Arguments @('run', $toolRequestPath, '--report-file', $toolReportPath)
  $toolReport = Read-JsonFile -Path $toolReportPath
  $toolPassed = $toolRun.ExitCode -eq 0 `
    -and $null -ne $toolReport `
    -and $toolReport.exitCode -eq 0 `
    -and (Test-Path -LiteralPath $toolMarker -PathType Leaf) `
    -and (-not $cacheProbe -or -not (Test-Path -LiteralPath $cacheProbe))
  if ($cacheProbe -and (Test-Path -LiteralPath $cacheProbe)) {
    Remove-Item -LiteralPath $cacheProbe -Force -ErrorAction SilentlyContinue
  }
  Add-TestResult `
    -Test 'Node/npm and shared cache' `
    -Expected 'Node/npm execute and the declared npm cache is writable' `
    -Actual "runnerExit=$($toolRun.ExitCode), markerCreated=$(Test-Path -LiteralPath $toolMarker), cacheDeclared=$($null -ne $cacheProbe)" `
    -Passed $toolPassed

  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $acceptTask = $listener.AcceptTcpClientAsync()
    $networkCommand = @(
      'powershell.exe',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "`$client=New-Object Net.Sockets.TcpClient; try { `$task=`$client.ConnectAsync('127.0.0.1',$port); if (-not `$task.Wait(2000)) { exit 20 }; if (`$client.Connected) { exit 0 }; exit 21 } catch { exit 22 } finally { `$client.Dispose() }"
    )
    $networkRequestPath = Join-Path $workspace 'network-request.json'
    $networkReportPath = Join-Path $workspace 'network-report.json'
    Write-Utf8Json -Path $networkRequestPath -Value (
      New-RunRequest `
        -Workspace $workspace `
        -Command $networkCommand `
        -ReadableRoots $readableRoots `
        -AdditionalWritableRoots $additionalWritableRoots
    )
    $networkRun = Invoke-NativeProcess `
      -FilePath $runnerPath `
      -Arguments @('run', $networkRequestPath, '--report-file', $networkReportPath)
    $networkReport = Read-JsonFile -Path $networkReportPath
    Start-Sleep -Milliseconds 200
    $networkPassed = $networkRun.ExitCode -ne 0 `
      -and $null -ne $networkReport `
      -and $networkReport.exitCode -ne 0 `
      -and -not $acceptTask.IsCompleted
    Add-TestResult `
      -Test 'Loopback network denial' `
      -Expected 'the dedicated identity cannot connect to a live host loopback listener' `
      -Actual "runnerExit=$($networkRun.ExitCode), hostAccepted=$($acceptTask.IsCompleted)" `
      -Passed $networkPassed
  } finally {
    $listener.Stop()
  }

  $cleanup = Invoke-NativeProcess -FilePath $runnerPath -Arguments @('cleanup', $policyRequestPath)
  Add-TestResult `
    -Test 'Workspace capability cleanup' `
    -Expected 'temporary capability ACLs are revoked' `
    -Actual "exit=$($cleanup.ExitCode)" `
    -Passed ($cleanup.ExitCode -eq 0)
} catch {
  $script:overallPassed = $false
  $script:fatalMessage = $_.Exception.Message
} finally {
  if (
    $testRoot `
    -and (Test-Path -LiteralPath $testRoot) `
    -and ($script:overallPassed -or -not $KeepArtifactsOnFailure)
  ) {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($testRoot -and (Test-Path -LiteralPath $testRoot)) {
    $artifactMessage = "Preserved failed Sandbox artifacts at $testRoot"
    $script:fatalMessage = if ($script:fatalMessage) {
      "$($script:fatalMessage) $artifactMessage"
    } else {
      $artifactMessage
    }
  }
  Write-FinalReport | Out-Null
}

if ($script:overallPassed) {
  exit 0
}
exit 1
