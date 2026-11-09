[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$SourceHead,
  [Parameter(Mandatory = $true)][string]$EvidenceDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$verifier = Join-Path $PSScriptRoot 'verify-windows-install-smoke.mjs'
$report = [ordered]@{
  schemaVersion = 1; status = 'running'; scope = 'private-exact-package-install'
  platform = 'win32'; arch = 'x64'; version = $Version; sourceHead = $SourceHead
  productionTouched = $false
  provenance = @{ sourceHead = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT }
  runner = @{ environment = $env:RUNNER_ENVIRONMENT; os = $env:RUNNER_OS; tempRoot = $env:RUNNER_TEMP }
  errors = [System.Collections.Generic.List[string]]::new()
  cleanup = @{ attempted = $false; ownedInstanceVerified = $false }
  profileSentinels = @()
}
$identity = $null
$target = $null
$shortcutPaths = @()
$ownedInstallation = $false
$installationStarted = $false

function Invoke-NodeJson([string[]]$Arguments) {
  $output = & node $verifier @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Package identity verification failed ($LASTEXITCODE)" }
  return (($output -join "`n") | ConvertFrom-Json)
}

function Read-RegistryEntry([string]$Hive, [string]$View, [string]$Key) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$Hive, [Microsoft.Win32.RegistryView]::$View)
  try {
    $entry = $base.OpenSubKey($Key, $false)
    if ($null -eq $entry) { return $null }
    try {
      $values = @{}
      foreach ($name in $entry.GetValueNames()) { $values[$name] = $entry.GetValue($name) }
      return @{ hive = $Hive; view = $View; key = $Key; values = $values }
    } finally { $entry.Dispose() }
  } finally { $base.Dispose() }
}

function Test-RegistryAbsent {
  foreach ($hive in @('CurrentUser', 'LocalMachine')) {
    foreach ($view in @('Registry64', 'Registry32')) {
      foreach ($key in @($identity.installRegistryKey, $identity.uninstallRegistryKey)) {
        if ($null -ne (Read-RegistryEntry $hive $view $key)) { return $false }
      }
    }
  }
  return $true
}

function Test-SamePath([string]$Actual, [string]$Expected) {
  if ([string]::IsNullOrWhiteSpace($Actual)) { return $false }
  return [string]::Equals([IO.Path]::GetFullPath($Actual).TrimEnd('\'), [IO.Path]::GetFullPath($Expected).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

function Read-VersionInfo([string]$Path) {
  $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
  return @{ productName = $info.ProductName; productVersion = $info.ProductVersion; fileVersion = $info.FileVersion }
}

function Read-Signature([string]$Path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  return @{ status = $signature.Status.ToString(); statusMessage = $signature.StatusMessage
    signerThumbprint = $(if ($null -ne $signature.SignerCertificate) { $signature.SignerCertificate.Thumbprint } else { $null }) }
}

function Invoke-OwnedProcess([string]$Path, [string]$Arguments, [int]$TimeoutSeconds) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Path
  $start.Arguments = $Arguments
  $start.UseShellExecute = $false
  $process = [Diagnostics.Process]::Start($start)
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      # This exact process object was created here; never find/kill by app name.
      $process.Kill($true)
      throw "Owned installer process exceeded $TimeoutSeconds seconds"
    }
    return $process.ExitCode
  } finally { $process.Dispose() }
}

try {
  # The smoke installs/uninstalls only on an ephemeral hosted runner. It must
  # never be used against a maintainer machine or an existing user installation.
  if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Exact installer smoke requires a clean GitHub-hosted Windows runner'
  }
  if ($env:GITHUB_SHA -ne $SourceHead) { throw 'Requested source differs from this workflow commit' }
  if ([string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) { throw 'RUNNER_TEMP is unavailable' }
  $EvidenceDir = [IO.Path]::GetFullPath($EvidenceDir)
  $tempPrefix = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
  if (-not $EvidenceDir.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must stay in RUNNER_TEMP' }
  New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null
  $Installer = (Resolve-Path -LiteralPath $Installer).Path
  $identity = Invoke-NodeJson -Arguments @('config', $Version, $SourceHead, $Installer)
  $report.installer = $identity.installer
  $report.installer | Add-Member -NotePropertyName versionInfo -NotePropertyValue (Read-VersionInfo $Installer)
  $report.installer | Add-Member -NotePropertyName authenticode -NotePropertyValue (Read-Signature $Installer)

  $token = [Guid]::NewGuid().ToString('N')
  $target = Join-Path $env:RUNNER_TEMP "railwise-install-$token\$($identity.productName)"
  $executable = Join-Path $target $identity.executableName
  $uninstaller = Join-Path $target $identity.uninstallerName
  $locations = @(
    @{ kind = 'desktop'; scope = 'current-user'; directory = [Environment]::GetFolderPath('DesktopDirectory') },
    @{ kind = 'start-menu'; scope = 'current-user'; directory = [Environment]::GetFolderPath('Programs') },
    @{ kind = 'desktop'; scope = 'all-users'; directory = [Environment]::GetFolderPath('CommonDesktopDirectory') },
    @{ kind = 'start-menu'; scope = 'all-users'; directory = [Environment]::GetFolderPath('CommonPrograms') }
  )
  $shortcutPaths = @($locations | ForEach-Object { Join-Path $_.directory $identity.shortcutName })
  $report.cleanScope = @{ registryAbsent = (Test-RegistryAbsent); targetAbsent = (-not (Test-Path -LiteralPath $target))
    shortcutsAbsent = (@($shortcutPaths | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0) }
  if (-not $report.cleanScope.registryAbsent -or -not $report.cleanScope.targetAbsent -or -not $report.cleanScope.shortcutsAbsent) {
    throw 'An existing installation, registry identity or shortcut is present; refusing to change it'
  }
  # Synthetic sentinels prove uninstall preserves both current and legacy
  # profile directories. No real settings, credentials or user files are used.
  foreach ($profileName in @($identity.productName, $identity.packageName)) {
    $profileDir = Join-Path $env:APPDATA $profileName
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
    $sentinel = Join-Path $profileDir "railwise-install-smoke-$token.txt"
    [IO.File]::WriteAllText($sentinel, "Synthetic private installation preservation probe: $token")
    $report.profileSentinels += @{ path = $sentinel; beforeSha256 = (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash.ToLowerInvariant(); afterSha256 = $null }
  }

  $report.target = @{ directory = $target; executable = $executable; uninstaller = $uninstaller }
  $installationStarted = $true
  # NSIS /D must be last and consumes the remainder, including spaces. Passing
  # this raw argument string avoids quoting /D into a different directory.
  $exitCode = Invoke-OwnedProcess $Installer "/S /currentuser /D=$target" 300
  $report.install = @{ exitCode = $exitCode }
  $report.registry = @{ install = (Read-RegistryEntry 'CurrentUser' 'Registry64' $identity.installRegistryKey)
    uninstall = (Read-RegistryEntry 'CurrentUser' 'Registry64' $identity.uninstallRegistryKey) }
  $ownedInstallation = $null -ne $report.registry.install -and (Test-SamePath $report.registry.install.values.InstallLocation $target)
  $report.cleanup.ownedInstanceVerified = $ownedInstallation
  if ($exitCode -ne 0) { throw "Installer exited with $exitCode" }
  if (-not $ownedInstallation) { throw 'Registry does not identify this exact temporary installation' }
  foreach ($path in @($target, $executable, $uninstaller)) {
    $item = Get-Item -LiteralPath $path
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Installed target is a reparse point: $path" }
  }
  $report.target.versionInfo = Read-VersionInfo $executable
  $report.target.authenticode = Read-Signature $executable
  $report.target.package = Invoke-NodeJson -Arguments @('inspect', $Version, $SourceHead, $target)
  $shell = New-Object -ComObject WScript.Shell
  try {
    $report.shortcuts = @($locations | Where-Object { $_.scope -eq 'current-user' } | ForEach-Object {
      $path = Join-Path $_.directory $identity.shortcutName
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required shortcut is missing: $path" }
      $link = $shell.CreateShortcut($path)
      @{ kind = $_.kind; scope = $_.scope; path = $path; name = $identity.shortcutName; target = $link.TargetPath }
    })
    foreach ($location in @($locations | Where-Object { $_.scope -eq 'all-users' })) {
      if (Test-Path -LiteralPath (Join-Path $location.directory $identity.shortcutName)) { throw 'Current-user install created an all-users shortcut' }
    }
  } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null }
} catch {
  $report.errors.Add($_.Exception.Message)
} finally {
  if ($installationStarted -and $ownedInstallation) {
    try {
      $installed = Read-RegistryEntry 'CurrentUser' 'Registry64' $identity.installRegistryKey
      if ($null -eq $installed -or -not (Test-SamePath $installed.values.InstallLocation $target)) { throw 'Installation ownership changed before cleanup' }
      $uninstaller = Join-Path $target $identity.uninstallerName
      $item = Get-Item -LiteralPath $uninstaller
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Owned uninstaller is a reparse point' }
      $report.cleanup.attempted = $true
      # Never execute a command obtained from an arbitrary UninstallString.
      $report.cleanup.exitCode = Invoke-OwnedProcess $uninstaller '/S /currentuser' 120
      # NSIS can return after spawning its temporary uninstaller copy. Observe
      # actual removal instead of treating the parent process exit as success.
      $deadline = [DateTime]::UtcNow.AddSeconds(120)
      do {
        $registryAbsent = Test-RegistryAbsent
        $shortcutsAbsent = @($shortcutPaths | Where-Object { Test-Path -LiteralPath $_ }).Count -eq 0
        $executableAbsent = -not (Test-Path -LiteralPath (Join-Path $target $identity.executableName))
        if ($registryAbsent -and $shortcutsAbsent -and $executableAbsent) { break }
        Start-Sleep -Milliseconds 500
      } while ([DateTime]::UtcNow -lt $deadline)
      $report.cleanup.registryAbsent = $registryAbsent
      $report.cleanup.shortcutsAbsent = $shortcutsAbsent
      $report.cleanup.appExecutableAbsent = $executableAbsent
    } catch { $report.errors.Add("Owned-instance cleanup: $($_.Exception.Message)") }
  }
  foreach ($sentinel in $report.profileSentinels) {
    if (Test-Path -LiteralPath $sentinel.path -PathType Leaf) {
      $sentinel.afterSha256 = (Get-FileHash -LiteralPath $sentinel.path -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  $report.status = 'failed'
  if (Test-Path -LiteralPath $EvidenceDir -PathType Container) {
    $reportPath = Join-Path $EvidenceDir 'windows-install-smoke.json'
    $report | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $reportPath -Encoding utf8
    if ($report.errors.Count -eq 0) {
      & node $verifier verify $Version $SourceHead $reportPath
      if ($LASTEXITCODE -ne 0) { $report.errors.Add('Final evidence verification failed') }
      else { $report.status = 'passed' }
    }
    if ($report.status -ne 'passed') {
      $report | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $reportPath -Encoding utf8
    }
  }
}
if ($report.status -ne 'passed') { throw "Exact Windows installation smoke failed: $($report.errors -join '; ')" }
