# BRO window maximizer
#
# Windows remembers each application's last window size, so apps often reopen
# small or restored. There is no single Windows setting that forces every
# program to open maximized, so BRO runs this small watcher while it is
# running. It watches for newly opened top-level windows and maximizes the
# normal ones — the same result as pressing the maximize button.
#
# It deliberately leaves alone:
#   - dialogs, message boxes, tooltips and owned popups (#32770 / #32768)
#   - tool windows and no-activate overlays (including the BRO popup)
#   - the Windows shell (taskbar, Start, desktop, notification area)
#   - windows that are already maximized or were already open at startup
#
# Disable it with BRO_AUTO_MAXIMIZE_WINDOWS=0 before starting BRO.

$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class BroWindowMaximizer
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr hWnd, int index);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

    private const int GWL_STYLE = -16;
    private const int GWL_EXSTYLE = -20;
    private const int WS_THICKFRAME = 0x00040000;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const uint GW_OWNER = 4;
    private const int DWMWA_CLOAKED = 14;
    private const int SW_MAXIMIZE = 3;

    private static readonly HashSet<string> ShellClasses = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd",
        "DV2ControlHost", "SysShadow", "ForegroundStaging"
    };

    private static readonly HashSet<string> ShellTitles = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
    {
        "Program Manager", "Taskbar", "Start", "Search", "Notification Center",
        "Action Center", "Windows Input Experience"
    };

    public static void Run()
    {
        // One watcher only, even if BRO and a logon entry both start it.
        bool created;
        using (var mutex = new Mutex(true, "BROWindowMaximizer", out created))
        {
            if (!created) return;

            var seen = new HashSet<long>();
            var initial = new List<IntPtr>();
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (IsWindowVisible(hWnd)) initial.Add(hWnd);
                return true;
            }, IntPtr.Zero);
            // Do not touch windows that were already open when BRO started.
            foreach (var hWnd in initial) seen.Add(hWnd.ToInt64());

            while (true)
            {
                var windows = new List<IntPtr>();
                EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
                {
                    if (IsWindowVisible(hWnd)) windows.Add(hWnd);
                    return true;
                }, IntPtr.Zero);

                foreach (var hWnd in windows)
                {
                    long key = hWnd.ToInt64();
                    if (seen.Contains(key)) continue;
                    // Wait until the window has a title; some apps create the
                    // frame a moment before they populate it.
                    if (GetWindowTextLength(hWnd) <= 0) continue;
                    seen.Add(key);
                    if (!ShouldMaximize(hWnd)) continue;

                    // Let the app finish placing its window, then maximize it
                    // the same way the maximize button would.
                    Thread.Sleep(400);
                    if (!IsWindow(hWnd) || !IsWindowVisible(hWnd) || IsZoomed(hWnd)) continue;
                    ShowWindowAsync(hWnd, SW_MAXIMIZE);
                }

                if (seen.Count > 400)
                {
                    var alive = new HashSet<long>();
                    foreach (var hWnd in windows) alive.Add(hWnd.ToInt64());
                    seen.IntersectWith(alive);
                }
                Thread.Sleep(300);
            }
        }
    }

    private static bool ShouldMaximize(IntPtr hWnd)
    {
        // Owned windows are dialogs or popups that belong to another window.
        if (GetWindow(hWnd, GW_OWNER) != IntPtr.Zero) return false;

        // A normal resizeable application frame.
        int style = GetWindowLong(hWnd, GWL_STYLE);
        if ((style & WS_THICKFRAME) == 0) return false;

        int exStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
        if ((exStyle & WS_EX_TOOLWINDOW) != 0) return false;
        if ((exStyle & WS_EX_NOACTIVATE) != 0) return false;

        // Skip cloaked UWP windows that are not actually on screen.
        int cloaked = 0;
        if (DwmGetWindowAttribute(hWnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0) return false;

        int length = GetWindowTextLength(hWnd);
        if (length <= 0) return false;
        var titleBuilder = new StringBuilder(length + 2);
        GetWindowText(hWnd, titleBuilder, titleBuilder.Capacity);
        string title = titleBuilder.ToString().Trim();
        if (title.Length == 0) return false;

        var classBuilder = new StringBuilder(256);
        GetClassName(hWnd, classBuilder, classBuilder.Capacity);
        string windowClass = classBuilder.ToString();
        if (ShellClasses.Contains(windowClass)) return false;
        if (ShellTitles.Contains(title)) return false;
        if (windowClass == "#32770" || windowClass == "#32768") return false;

        uint processId = 0;
        GetWindowThreadProcessId(hWnd, out processId);
        try
        {
            var process = Process.GetProcessById((int)processId);
            // The BRO popup is frameless and must never be maximized.
            if (string.Equals(process.ProcessName, "electron", StringComparison.OrdinalIgnoreCase)
                && title.StartsWith("BRO", StringComparison.OrdinalIgnoreCase)) return false;
            if (string.Equals(process.ProcessName, "explorer", StringComparison.OrdinalIgnoreCase)
                && (title == "Program Manager" || title == "Taskbar")) return false;
        }
        catch
        {
            // A process that is already gone cannot be maximized.
            return false;
        }

        return true;
    }
}
"@

[void][BroWindowMaximizer]::Run()
