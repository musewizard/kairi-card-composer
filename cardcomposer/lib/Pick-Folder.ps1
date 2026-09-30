# Pick-Folder.ps1 -- 弹出一个真正的 Windows 文件夹选择框，把选中的路径打印到 stdout。
#
# 主方案：Vista 之后的 IFileOpenDialog + FOS_PICKFOLDERS，就是资源管理器里那个
#         带地址栏、左侧导航栏、右下角「选择文件夹」按钮的现代选择框。
# 备用方案：万一 COM 调用失败（老系统 / 环境异常），退回 .NET 的 FolderBrowserDialog，
#         样子旧一点，但一样能选到文件夹。
#
# -Title      对话框标题（留空用默认）
# -StartPath  起始目录（可以是个文件，会自动跳到它所在目录）
# -DryRun     只做编译/环境自检，不弹窗；成功打印 DRYRUN OK
# 输出：选中目录的绝对路径；用户取消则什么都不输出（退出码 0）。

param(
    [string]$Title = '',
    [string]$StartPath = '',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$defaultTitle = '选择 kairisei 服务端包文件夹（进到包目录里点「选择文件夹」）'

$code = @'
using System;
using System.Runtime.InteropServices;

public static class FolderPicker
{
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class FileOpenDialogRCW { }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    const uint FOS_PICKFOLDERS = 0x00000020;
    const uint FOS_FORCEFILESYSTEM = 0x00000040;
    const uint FOS_PATHMUSTEXIST = 0x00000800;
    const uint SIGDN_FILESYSPATH = 0x80058000;

    // Returns the chosen folder, or null when the user cancels.
    // Throws when the dialog itself cannot be created (caller falls back).
    public static string Pick(string title, string initial)
    {
        IFileDialog dlg = (IFileDialog)(new FileOpenDialogRCW());
        dlg.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
        if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);
        if (!string.IsNullOrEmpty(initial))
        {
            try
            {
                Guid iid = typeof(IShellItem).GUID;
                IShellItem item;
                SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out item);
                if (item != null) dlg.SetFolder(item);
            }
            catch { /* 起始目录无效就让它自己决定 */ }
        }
        int hr = dlg.Show(IntPtr.Zero);
        if (hr != 0) return null;              // 0x800704C7 = 用户取消
        IShellItem res;
        dlg.GetResult(out res);
        if (res == null) return null;
        string path;
        res.GetDisplayName(SIGDN_FILESYSPATH, out path);
        return path;
    }
}
'@

$pickerOk = $false
try {
    Add-Type -TypeDefinition $code -Language CSharp | Out-Null
    $pickerOk = $true
} catch {
    Write-Warning ('现代文件夹选择框不可用，改用备用方案: ' + $_.Exception.Message)
}

if ($DryRun) {
    if ($pickerOk) { Write-Output 'DRYRUN OK (IFileDialog)' }
    else { Write-Output 'DRYRUN OK (fallback only)' }
    exit 0
}

$title = if ($Title -ne '') { $Title } else { $defaultTitle }

if ($pickerOk) {
    try {
        $path = [FolderPicker]::Pick($title, $StartPath)
        if ($path) { Write-Output $path }
        exit 0
    } catch {
        Write-Warning ('现代文件夹选择框出错，改用备用方案: ' + $_.Exception.Message)
    }
}

# ---- 备用方案
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$fb = New-Object System.Windows.Forms.FolderBrowserDialog
$fb.Description = $title
$fb.ShowNewFolderButton = $false
if ($StartPath -ne '' -and (Test-Path -LiteralPath $StartPath)) {
    try {
        $full = (Resolve-Path -LiteralPath $StartPath).Path
        if (-not (Test-Path -LiteralPath $full -PathType Container)) { $full = Split-Path -Parent $full }
        $fb.SelectedPath = $full
    } catch { }
}
if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK -and $fb.SelectedPath -ne '') {
    Write-Output $fb.SelectedPath
}
