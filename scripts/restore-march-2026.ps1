$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Web.Extensions

$reportPath = Join-Path $PSScriptRoot "..\data\report.json"
$archivePath = Join-Path $PSScriptRoot "..\data\archive\2026-03.json"

$reportFullPath = (Resolve-Path $reportPath).Path
$archiveFullPath = (Resolve-Path $archivePath).Path

$serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$serializer.MaxJsonLength = 200000000
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Copy-PlainRow($row) {
  $copy = @{}
  foreach ($key in $row.Keys) {
    $copy[$key] = $row[$key]
  }
  return $copy
}

$reportText = [System.IO.File]::ReadAllText($reportFullPath, [System.Text.Encoding]::UTF8)
$archiveText = [System.IO.File]::ReadAllText($archiveFullPath, [System.Text.Encoding]::UTF8)

$report = $serializer.DeserializeObject($reportText)
$archive = $serializer.DeserializeObject($archiveText)

$reportRows = @($report["rows"] | ForEach-Object { Copy-PlainRow $_ })
$archiveRows = @($archive["rows"] | ForEach-Object { Copy-PlainRow $_ })

if ($archiveRows.Count -eq 0) {
  throw "Archive file is empty."
}

$invalidArchiveRows = @($archiveRows | Where-Object { ($_["date"] -as [string]) -notlike "2026-03-*" })
if ($invalidArchiveRows.Count -gt 0) {
  throw "Archive contains non-March rows."
}

$reportNonMarchRows = @($reportRows | Where-Object { ($_["date"] -as [string]) -notlike "2026-03-*" })
$combinedRows = @($reportNonMarchRows + $archiveRows | Sort-Object { $_["created_at"] } -Descending | ForEach-Object { Copy-PlainRow $_ })

$payload = @{
  ok = $true
  rows = $combinedRows
}

$json = $serializer.Serialize($payload)
[System.IO.File]::WriteAllText($reportFullPath, $json, $utf8NoBom)

$marchDates = @($archiveRows | ForEach-Object { $_["date"] } | Sort-Object -Unique)
$nonMarchDates = @($reportNonMarchRows | ForEach-Object { $_["date"] } | Sort-Object -Unique)

Write-Output ("restored_archive_rows={0}" -f $archiveRows.Count)
Write-Output ("preserved_non_march_rows={0}" -f $reportNonMarchRows.Count)
Write-Output ("march_first_date={0}" -f $marchDates[0])
Write-Output ("march_last_date={0}" -f $marchDates[-1])
Write-Output ("march_unique_dates={0}" -f $marchDates.Count)
Write-Output ("non_march_dates={0}" -f ($nonMarchDates -join ","))
