#requires -Version 5.1
<#
  鬥陣特攻 2 + Discord 賽前優化腳本
  使用方式：雙擊同資料夾的「1_Start_Boost.bat」（會自動要求系統管理員權限）
  還原方式：雙擊「2_Restore.bat」
  這個腳本只做「可還原、無風險」的調整，不會修改 BIOS、不會超頻、不會刪除個人檔案。
#>
param([switch]$Restore)

$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Host.UI.RawUI.WindowTitle = '鬥陣特攻 + Discord 賽前優化'

$stateFile   = Join-Path $env:LOCALAPPDATA 'OWBoost_state.txt'
$BALANCED    = '381b4222-f694-41f0-9685-ff5bb260df2e'
$HIGH_PERF   = '8c5e7fc1-e8bb-4466-be4d-41a0c0b8c8aa'

function Title($t) { Write-Host ''; Write-Host "==== $t ====" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "  [OK] $t" -ForegroundColor Green }
function Warn($t)  { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Bad($t)   { Write-Host "  [X]  $t" -ForegroundColor Red }
function Info($t)  { Write-Host "       $t" }
function Ask($q, $default = 'Y') {
    $hint = if ($default -eq 'Y') { '[Y/n]' } else { '[y/N]' }
    $a = Read-Host "  $q $hint"
    if ([string]::IsNullOrWhiteSpace($a)) { $a = $default }
    return ($a -match '^[Yy]')
}
function FreeRamGB {
    $os = Get-CimInstance Win32_OperatingSystem
    return [math]::Round($os.FreePhysicalMemory / 1MB, 1)
}
function FolderSizeMB($path) {
    if (-not (Test-Path $path)) { return 0 }
    $s = (Get-ChildItem $path -Recurse -Force -File | Measure-Object Length -Sum).Sum
    return [math]::Round(($s / 1MB), 0)
}

# ------------------------------------------------------------------ 還原模式
if ($Restore) {
    Title '還原設定'
    $guid = $BALANCED
    if (Test-Path $stateFile) { $guid = (Get-Content $stateFile -Raw).Trim() }
    powercfg /setactive $guid | Out-Null
    if ($LASTEXITCODE -ne 0) { powercfg /setactive $BALANCED | Out-Null }
    Remove-Item $stateFile -Force
    Ok '電源計畫已還原成優化前的設定'
    Info '遊戲模式與關閉背景錄影維持開啟（對日常使用沒有壞處）。'
    Info '被關掉的程式（瀏覽器、OneDrive…）直接重新打開即可。'
    return
}

Write-Host ''
Write-Host '  鬥陣特攻 2 + Discord 賽前優化' -ForegroundColor Magenta
Write-Host '  建議：先關掉鬥陣特攻再執行。整個流程約 1 分鐘。' -ForegroundColor Magenta

# ------------------------------------------------------------------ 1. 健檢
Title '1/7 電腦健檢（找出「角色變光球」的原因）'

$os = Get-CimInstance Win32_OperatingSystem
$totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$freeGB  = FreeRamGB
Info "記憶體：總共 $totalGB GB，目前可用 $freeGB GB"
if ($freeGB -lt 6) { Warn '可用記憶體低於 6 GB，下一步會協助關閉背景程式。' } else { Ok '記憶體空間足夠' }

# 顯示卡與顯示記憶體（Win32_VideoController 的 AdapterRAM 最多只顯示 4GB，所以改讀登錄檔）
$vramByName = @{}
Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' |
    Where-Object { $_.PSChildName -match '^\d{4}$' } | ForEach-Object {
        $p = Get-ItemProperty $_.PSPath
        $m = $p.'HardwareInformation.qwMemorySize'
        if ($p.DriverDesc -and $m) { $vramByName[$p.DriverDesc] = [math]::Round([double]$m / 1GB, 1) }
    }

$gpus = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch 'Basic|Remote|Virtual|Parsec|Meta' }
$bestVram = $null
$hasDedicated = $false
foreach ($g in $gpus) {
    if ($g.Name -match 'NVIDIA|GeForce|RTX|GTX|Radeon RX|Radeon Pro|Arc') { $hasDedicated = $true }
}
foreach ($g in $gpus) {
    $vram = $vramByName[$g.Name]
    $vramText = if ($vram) { "$vram GB" } else { '未知' }
    Info "顯示卡：$($g.Name)（顯示記憶體 $vramText）"
    if ($vram -and ($null -eq $bestVram -or $vram -gt $bestVram)) { $bestVram = $vram }

    if (-not $hasDedicated -and $g.Name -match 'Intel\(R\) (UHD|HD|Iris)|Radeon\(TM\) Graphics|Radeon Graphics$|Vega \d+ Graphics') {
        Warn '這是內建顯示晶片：遊戲內請把「材質品質」設「低」，畫面設定整體用「低」。'
    }
    if ($g.DriverDate) {
        $age = (New-TimeSpan -Start $g.DriverDate -End (Get-Date)).Days
        if ($age -gt 180) { Warn "顯示卡驅動已經 $age 天沒更新，建議更新（連結見說明文件）。" }
        else { Ok "顯示卡驅動算新（$age 天前）" }
    }
}
if ($bestVram -and $bestVram -le 4) {
    Bad "顯示記憶體只有 $bestVram GB：『材質品質』設太高是角色變光球最常見的原因！請在遊戲內改成「中」或「低」。"
} elseif ($bestVram -and $bestVram -le 6) {
    Warn "顯示記憶體 $bestVram GB：『材質品質』建議設「中」。"
}

# 鬥陣特攻安裝在哪顆硬碟？是不是傳統硬碟 (HDD)？
$owPath = $null
$uninstallKeys = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
                 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
$owReg = Get-ItemProperty $uninstallKeys | Where-Object { $_.DisplayName -like 'Overwatch*' -and $_.InstallLocation } | Select-Object -First 1
if ($owReg) { $owPath = $owReg.InstallLocation }
if (-not $owPath) {
    $guess = @('C:\Program Files (x86)\Overwatch', 'C:\Program Files\Overwatch',
               'C:\Program Files (x86)\Steam\steamapps\common\Overwatch')
    Get-PSDrive -PSProvider FileSystem | ForEach-Object {
        $guess += "$($_.Root)Overwatch", "$($_.Root)Games\Overwatch", "$($_.Root)SteamLibrary\steamapps\common\Overwatch"
    }
    $owPath = $guess | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if ($owPath) {
    Info "鬥陣特攻位置：$owPath"
    $dl = $owPath.Substring(0, 1)
    $disk = Get-Partition -DriveLetter $dl | Get-Disk
    $pd = Get-PhysicalDisk | Where-Object { $_.DeviceId -eq "$($disk.Number)" }
    switch ("$($pd.MediaType)") {
        'HDD' { Bad '遊戲裝在傳統硬碟 (HDD)！角色/地圖讀取太慢會變光球。強烈建議用 Battle.net 把遊戲移到 SSD。' }
        'SSD' { Ok '遊戲裝在 SSD' }
        default { Info '無法判斷硬碟類型（多半是 SSD，可忽略）。' }
    }
    $vol = Get-Volume -DriveLetter $dl
    if ($vol) {
        $freeDisk = [math]::Round($vol.SizeRemaining / 1GB, 0)
        if ($freeDisk -lt 20) { Warn "$dl 槽只剩 $freeDisk GB，建議至少保留 20 GB 空間。" } else { Ok "$dl 槽剩餘 $freeDisk GB" }
    }
} else {
    Info '找不到鬥陣特攻安裝位置（不影響後續步驟）。'
}

$cs = Get-CimInstance Win32_ComputerSystem
if (-not $cs.AutomaticManagedPagefile) {
    $pf = Get-CimInstance Win32_PageFileSetting
    if (-not $pf) { Bad '虛擬記憶體 (分頁檔) 被關閉了！16GB 電腦這樣很容易卡頓，請依說明文件改回「自動管理」。' }
    else { Warn '虛擬記憶體不是「系統自動管理」，建議依說明文件改回自動。' }
} else { Ok '虛擬記憶體為系統自動管理' }

# ------------------------------------------------------------------ 2. 電源計畫
Title '2/7 電源計畫 → 高效能'
$cur = (powercfg /getactivescheme) -join ' '
if ($cur -match '([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})' -and -not (Test-Path $stateFile)) {
    Set-Content -Path $stateFile -Value $Matches[1]
}
powercfg /setactive $HIGH_PERF 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    $dup = (powercfg -duplicatescheme $HIGH_PERF 2>$null) -join ' '
    if ($dup -match '([0-9a-fA-F]{8}-[0-9a-fA-F-]{27})') { powercfg /setactive $Matches[1] | Out-Null }
}
if ($LASTEXITCODE -eq 0) { Ok '已切換為「高效能」電源計畫（可用「2_Restore.bat」改回）' }
else { Warn '此電腦只支援「平衡」模式：請到 設定 > 系統 > 電源 > 電源模式 選「最佳效能」。' }
if (Get-CimInstance Win32_Battery) { Warn '這是筆電：打遊戲請一定要插電，不然顯示卡會降速！' }

# ------------------------------------------------------------------ 3. 遊戲模式 / 關背景錄影
Title '3/7 開啟遊戲模式、關閉 Xbox 背景錄影'
$gb = 'HKCU:\Software\Microsoft\GameBar'
if (-not (Test-Path $gb)) { New-Item $gb -Force | Out-Null }
Set-ItemProperty $gb -Name AutoGameModeEnabled -Value 1 -Type DWord
Set-ItemProperty $gb -Name AllowAutoGameMode   -Value 1 -Type DWord
Ok '遊戲模式：開啟'
$dvr = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GameDVR'
if (-not (Test-Path $dvr)) { New-Item $dvr -Force | Out-Null }
Set-ItemProperty $dvr -Name AppCaptureEnabled -Value 0 -Type DWord
Set-ItemProperty 'HKCU:\System\GameConfigStore' -Name GameDVR_Enabled -Value 0 -Type DWord
Ok 'Xbox 背景錄影：關閉（會吃顯示卡效能）'

# ------------------------------------------------------------------ 4. 關閉吃記憶體的背景程式
Title '4/7 關閉吃記憶體的背景程式'
$keep = 'Overwatch|Discord|Battle\.net|Agent|System|Idle|explorer|svchost|csrss|wininit|winlogon|lsass|services|smss|dwm|MsMpEng|Registry|Memory Compression|audiodg|nvcontainer|NVIDIA|RadeonSoftware|amdow|powershell|conhost|cmd'
Info '目前最吃記憶體的程式：'
Get-Process | Where-Object { $_.ProcessName -notmatch $keep } |
    Group-Object ProcessName | ForEach-Object {
        [pscustomobject]@{ Name = $_.Name; MB = [math]::Round((($_.Group | Measure-Object WorkingSet64 -Sum).Sum) / 1MB) }
    } | Sort-Object MB -Descending | Select-Object -First 8 | ForEach-Object {
        Info ("  {0,-28} {1,6} MB" -f $_.Name, $_.MB)
    }

$apps = [ordered]@{
    'OneDrive'           = 'OneDrive'
    'Teams'              = 'Teams|ms-teams'
    'Spotify'            = 'Spotify'
    'Epic Games'         = 'EpicGamesLauncher|EpicWebHelper'
    'EA App'             = 'EADesktop|EABackgroundService'
    'Ubisoft Connect'    = 'upc|UplayWebCore'
    'Wallpaper Engine'   = 'wallpaper32|wallpaper64'
    'Adobe Creative Cloud' = 'Creative Cloud|CCXProcess|CCLibrary|AdobeIPCBroker'
    'LINE'               = '^LINE$'
    'Telegram'           = 'Telegram'
    'Zoom'               = '^Zoom$'
    'Skype'              = 'Skype'
}
$browsers = [ordered]@{ 'Chrome' = '^chrome$'; 'Edge' = '^msedge$'; 'Firefox' = '^firefox$'; 'Opera' = '^opera$'; 'Brave' = '^brave$' }

function Close-Group($label, $pattern) {
    $procs = Get-Process | Where-Object { $_.ProcessName -match $pattern }
    if (-not $procs) { return }
    $procs | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }
    Start-Sleep -Milliseconds 1500
    Get-Process | Where-Object { $_.ProcessName -match $pattern } | Stop-Process -Force
    Ok "已關閉 $label"
}
function Running($map) {
    $found = @()
    foreach ($k in $map.Keys) {
        $p = Get-Process | Where-Object { $_.ProcessName -match $map[$k] }
        if ($p) { $found += [pscustomobject]@{ Label = $k; Pattern = $map[$k]; MB = [math]::Round((($p | Measure-Object WorkingSet64 -Sum).Sum) / 1MB) } }
    }
    return $found
}

$before = FreeRamGB
$bg = Running $apps
if ($bg) {
    Info ''
    Info '偵測到這些打遊戲時用不到的程式：'
    $bg | ForEach-Object { Info ("  - {0}（{1} MB）" -f $_.Label, $_.MB) }
    if (Ask '要全部關閉嗎？') { $bg | ForEach-Object { Close-Group $_.Label $_.Pattern } }
} else { Ok '沒有偵測到多餘的背景程式' }

$br = Running $browsers
if ($br) {
    Info ''
    $br | ForEach-Object { Info ("  - 瀏覽器 {0}（{1} MB）" -f $_.Label, $_.MB) }
    Warn '瀏覽器通常最吃記憶體。關閉前請確認分頁都存好了（重開可按 Ctrl+Shift+T 復原分頁）。'
    if (Ask '要關閉瀏覽器嗎？' 'N') { $br | ForEach-Object { Close-Group $_.Label $_.Pattern } }
}
$after = FreeRamGB
Info "可用記憶體：$before GB → $after GB"

# ------------------------------------------------------------------ 5. 清暫存檔
Title '5/7 清除暫存檔'
$tmpTargets = @($env:TEMP, (Join-Path $env:WINDIR 'Temp'))
$freed = 0
foreach ($t in $tmpTargets) {
    $b = FolderSizeMB $t
    Get-ChildItem $t -Force | Remove-Item -Recurse -Force
    $freed += ($b - (FolderSizeMB $t))
}
Ok "清出約 $freed MB（正在使用中的檔案會自動略過）"

# ------------------------------------------------------------------ 6. 著色器快取
Title '6/7 重建顯示卡著色器快取（解決光球 / 貼圖錯誤）'
Info '如果「角色變光球」已經發生過，建議選 Y 做一次。'
Info '做完後第一場遊戲開頭可能會小卡幾秒（正在重建快取），之後就會順。'
if (Get-Process -Name 'Overwatch') {
    Warn '鬥陣特攻正在執行中，略過此步驟（請關遊戲後再執行一次）。'
} elseif (Ask '要清除著色器快取嗎？' 'N') {
    $caches = @(
        "$env:LOCALAPPDATA\NVIDIA\DXCache", "$env:LOCALAPPDATA\NVIDIA\GLCache",
        "$env:LOCALAPPDATA\AMD\DxCache",    "$env:LOCALAPPDATA\AMD\DxcCache", "$env:LOCALAPPDATA\AMD\GLCache",
        "$env:LOCALAPPDATA\Intel\ShaderCache", "$env:LOCALAPPDATA\D3DSCache"
    )
    $sum = 0
    foreach ($c in $caches) {
        if (Test-Path $c) { $sum += FolderSizeMB $c; Get-ChildItem $c -Force | Remove-Item -Recurse -Force }
    }
    Ok "著色器快取已清除（約 $sum MB）"
}

# ------------------------------------------------------------------ 7. 網路
Title '7/7 網路'
ipconfig /flushdns | Out-Null
Ok '已清除 DNS 快取'

# ------------------------------------------------------------------ 遊戲啟動後提高優先順序
Title '最後一步：自動提高遊戲與 Discord 的優先順序'
Info '現在請打開 Discord，然後從 Battle.net / Steam 啟動鬥陣特攻。'
Info '這個視窗偵測到遊戲後，會自動把：鬥陣特攻 → 高、Discord → 高於標準。'
Info '（最多等 20 分鐘；不需要的話直接關掉這個視窗即可）'

$deadline = (Get-Date).AddMinutes(20)
$owDone = $false
while ((Get-Date) -lt $deadline -and -not $owDone) {
    $ow = Get-Process -Name 'Overwatch'
    if ($ow) {
        Start-Sleep -Seconds 5
        $ow | ForEach-Object { $_.PriorityClass = 'High' }
        Ok '鬥陣特攻 → 高優先順序'
        $owDone = $true
    }
    Start-Sleep -Seconds 3
}
$dc = Get-Process -Name 'Discord'
if ($dc) { $dc | ForEach-Object { $_.PriorityClass = 'AboveNormal' }; Ok 'Discord → 高於標準優先順序' }
if (-not $owDone) { Warn '20 分鐘內沒偵測到鬥陣特攻，略過。' }

Write-Host ''
Write-Host '  ==== 全部完成！別忘了檢查遊戲內設定 ====' -ForegroundColor Magenta
Info '選項 > 影像：'
Info '  材質品質 → 中（顯示記憶體 4GB 以下設「低」）   ← 光球問題最關鍵'
Info '  動態反射 → 關  /  陰影細節 → 低  /  局部霧氣細節 → 低'
Info '  算圖比例 → 100%（或自訂；不要超過 100%）'
Info '  幀數上限 → 自訂，設成螢幕更新率（例如 144），留餘裕給 Discord'
Info '  NVIDIA Reflex → 開啟 + 加速；減少緩衝 → 開'
Info 'Discord：設定 > 進階 > 關閉「硬體加速」；設定 > 遊戲疊加 > 關閉'
Info '更詳細的說明請看同資料夾的 README.md'
Write-Host ''
