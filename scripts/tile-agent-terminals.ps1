param(
    [string]$PlanPath,
    [switch]$Probe
)

$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MbusWindows {
    public delegate bool EnumProc(IntPtr handle, IntPtr param);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    public static IntPtr Find(string title) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((handle, param) => {
            var text = new StringBuilder(1024);
            GetWindowText(handle, text, text.Capacity);
            if (IsWindowVisible(handle) && text.ToString().Contains(title)) {
                found = handle;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@
# Use physical monitor coordinates, including negative origins and mixed DPI.
$null = [MbusWindows]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms
$display = [System.Windows.Forms.Screen]::AllScreens |
    Where-Object { -not $_.Primary } |
    Sort-Object @{ Expression = { $_.WorkingArea.Width * $_.WorkingArea.Height }; Descending = $true }, DeviceName |
    Select-Object -First 1
if (-not $display) { throw 'No non-primary display is connected. Connect or enable a second display, then retry.' }
$terminal = (Get-Command wt.exe -CommandType Application -ErrorAction Stop).Source
if ($Probe) {
    @{ display = $display.DeviceName; width = $display.WorkingArea.Width; height = $display.WorkingArea.Height } | ConvertTo-Json -Compress
    exit 0
}
if (-not $PlanPath) { throw 'A launch plan is required.' }
$plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
$plan = @($plan)
if ($plan.Count -eq 0) { throw 'The launch plan is empty.' }
$area = $display.WorkingArea
$columns = [int][Math]::Ceiling([Math]::Sqrt($plan.Count * $area.Width / $area.Height))
$columns = [Math]::Min($columns, $plan.Count)
$rows = [int][Math]::Ceiling($plan.Count / [double]$columns)
$handles = @()

function Set-Tile([IntPtr]$handle, [int]$index) {
    $row = [int][Math]::Floor($index / [double]$columns)
    $column = $index % $columns
    # Fill the last row rather than leaving empty grid cells.
    $rowColumns = [Math]::Min($columns, $plan.Count - $row * $columns)
    $left = $area.Left + [int][Math]::Floor($column * $area.Width / [double]$rowColumns)
    $right = $area.Left + [int][Math]::Floor(($column + 1) * $area.Width / [double]$rowColumns)
    $top = $area.Top + [int][Math]::Floor($row * $area.Height / [double]$rows)
    $bottom = $area.Top + [int][Math]::Floor(($row + 1) * $area.Height / [double]$rows)
    $null = [MbusWindows]::ShowWindow($handle, 9)
    if (-not [MbusWindows]::SetWindowPos($handle, [IntPtr]::Zero, $left, $top, $right - $left, $bottom - $top, 0x0014)) {
        throw "Could not position agent window $($index + 1)."
    }
}

for ($i = 0; $i -lt $plan.Count; $i++) {
    $entry = $plan[$i]
    # Titles contain only launcher-generated IDs. Suppress application title
    # changes so Claude/Codex cannot replace the identity used for positioning.
    if ($entry.title -notmatch '^mbus-agent-[a-z0-9-]+$' -or $entry.encodedCommand -notmatch '^[A-Za-z0-9+/=]+$') {
        throw 'Invalid terminal launch plan.'
    }
    Start-Process -FilePath $terminal -WindowStyle Normal -ArgumentList @(
        '-w', 'new', 'new-tab', '--title', $entry.title, '--suppressApplicationTitle',
        'powershell.exe', '-NoProfile', '-NoExit', '-EncodedCommand', $entry.encodedCommand
    )
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $handle = [MbusWindows]::Find($entry.title)
        if ($handle -ne [IntPtr]::Zero) { break }
        Start-Sleep -Milliseconds 150
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($handle -eq [IntPtr]::Zero) {
        throw "Could not locate terminal $($entry.title). Earlier agents may already be running; inspect their windows before retrying."
    }
    $handles += $handle
    Set-Tile $handle $i
    Write-Host "Opened and tiled $($entry.title) on $($display.DeviceName)."
}
# Reapply after startup so initial terminal sizing cannot overwrite the layout.
Start-Sleep -Milliseconds 500
for ($i = 0; $i -lt $handles.Count; $i++) { Set-Tile $handles[$i] $i }
