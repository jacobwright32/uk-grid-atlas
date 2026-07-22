# Creates Grid Atlas labels + 30 issues on GitHub from issues.json (same folder).
# Usage (from the repo root, in PowerShell):
#   powershell -ExecutionPolicy Bypass -File _to_delete\create-issues.ps1 -Token "github_pat_..."
param([Parameter(Mandatory = $true)][string]$Token)

$repo = "jacobwright32/uk-grid-atlas"
$headers = @{
  Authorization            = "Bearer $Token"
  Accept                   = "application/vnd.github+json"
  "X-GitHub-Api-Version"   = "2022-11-28"
}
$data = Get-Content -Raw -Path (Join-Path $PSScriptRoot "issues.json") -Encoding UTF8 | ConvertFrom-Json

foreach ($l in $data.labels) {
  $body = [System.Text.Encoding]::UTF8.GetBytes(($l | ConvertTo-Json))
  try {
    Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/labels" -Headers $headers -Body $body -ContentType "application/json" | Out-Null
    Write-Host "label $($l.name): created"
  } catch {
    Write-Host "label $($l.name): skipped (probably exists already)"
  }
}

$made = 0
foreach ($i in $data.issues) {
  $body = [System.Text.Encoding]::UTF8.GetBytes(($i | ConvertTo-Json -Depth 4))
  try {
    $r = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/issues" -Headers $headers -Body $body -ContentType "application/json"
    $made++
    Write-Host ("#{0,-4} {1}" -f $r.number, $i.title)
  } catch {
    Write-Host "FAILED: $($i.title)"
    Write-Host $_.Exception.Message
    exit 1
  }
  Start-Sleep -Seconds 1.3   # stay under GitHub's secondary rate limits
}
Write-Host ""
Write-Host "$made issues created. Delete this folder and revoke the token when done."
