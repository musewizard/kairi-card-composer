// 卡牌制作工具 —— 独立启动器（.NET Framework 4.0 / C# 5 语法，用系统自带 csc.exe 编译）
//
// 为什么要有它：效果拼接器的后台是 node server.js，之前只能靠 DSH 会话来起，
// DSH 一重启后台就没了，网页自然打不开。这个程序不依赖任何开发环境：
//   双击 → 找 node → 起后台 → 等它就绪 → 开浏览器
// 关掉这个窗口不会关掉后台服务；要停就点「停止后台服务」。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Text;
using System.Windows.Forms;

static class Launcher
{
    const int Port = 8788;
    static string Root;          // exe 所在目录
    static Form Win;
    static Label LblStatus, LblHint;
    static TextBox TxtLog;
    static Button BtnStart, BtnOpen, BtnStop;
    static CheckBox ChkBrowser;
    static Timer Poll;
    static int PollLeft;
    static Process Child;
    /// 带 --no-browser 启动时不弹浏览器（脚本/自动化重启用，免得一直弹标签页）。
    static bool SuppressBrowser;

    [STAThread]
    static void Main()
    {
        Root = Path.GetDirectoryName(Application.ExecutablePath);
        foreach (string a in Environment.GetCommandLineArgs())
        {
            if (a == "--no-browser" || a == "/no-browser" || a == "-nobrowser") SuppressBrowser = true;
        }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        BuildUi();
        Application.Run(Win);
    }

    // ------------------------------------------------------------------ 界面
    static void BuildUi()
    {
        Font f = new Font("Microsoft YaHei UI", 9F);

        Win = new Form();
        Win.Text = "卡牌制作工具 · 启动器";
        Win.ClientSize = new Size(600, 384);
        Win.MinimumSize = new Size(600, 384);
        Win.StartPosition = FormStartPosition.CenterScreen;
        Win.MaximizeBox = false;
        Win.AutoScaleMode = AutoScaleMode.Font;
        Win.Font = f;
        Win.Icon = SystemIcons.Application;

        Label title = new Label();
        title.Text = "卡牌制作 · 效果拼接器";
        title.Font = new Font("Microsoft YaHei UI", 13F, FontStyle.Bold);
        title.AutoSize = true;
        title.Location = new Point(16, 14);
        Win.Controls.Add(title);

        LblStatus = new Label();
        LblStatus.Text = "正在检查后台服务…";
        LblStatus.AutoSize = false;
        LblStatus.Location = new Point(18, 52);
        LblStatus.Size = new Size(560, 24);
        LblStatus.ForeColor = Color.DimGray;
        Win.Controls.Add(LblStatus);

        BtnStart = new Button();
        BtnStart.Text = "▶  启动并打开网页";
        BtnStart.Location = new Point(16, 84);
        BtnStart.Size = new Size(180, 36);
        BtnStart.Click += delegate { StartServer(); };
        Win.Controls.Add(BtnStart);

        BtnOpen = new Button();
        BtnOpen.Text = "🌐  只打开网页";
        BtnOpen.Location = new Point(206, 84);
        BtnOpen.Size = new Size(150, 36);
        BtnOpen.Click += delegate { OpenBrowser(); };
        Win.Controls.Add(BtnOpen);

        BtnStop = new Button();
        BtnStop.Text = "⏹  停止后台服务";
        BtnStop.Location = new Point(366, 84);
        BtnStop.Size = new Size(160, 36);
        BtnStop.Click += delegate { StopServer(); };
        Win.Controls.Add(BtnStop);

        // 「启动后要不要自己打开网页」——用户点界面启动时默认打开；
        // 脚本重启会带 --no-browser（这一次不打开，也不改这里的勾）。
        ChkBrowser = new CheckBox();
        ChkBrowser.Text = "启动后台后自动打开网页";
        ChkBrowser.AutoSize = true;
        ChkBrowser.Location = new Point(18, 126);
        ChkBrowser.Checked = LoadBrowserPref();
        if (SuppressBrowser) ChkBrowser.Checked = false;
        ChkBrowser.CheckedChanged += delegate { SaveBrowserPref(ChkBrowser.Checked); };
        Win.Controls.Add(ChkBrowser);

        LblHint = new Label();
        LblHint.Text = "关掉这个窗口不会关掉后台服务；要停就点上面的「停止后台服务」。\r\n" +
                       "网址永远是 http://127.0.0.1:" + Port + "/ —— 浏览器收藏它就行。";
        LblHint.AutoSize = false;
        LblHint.Location = new Point(18, 152);
        LblHint.Size = new Size(560, 40);
        LblHint.ForeColor = Color.DimGray;
        Win.Controls.Add(LblHint);

        Label logTitle = new Label();
        logTitle.Text = "运行记录：";
        logTitle.AutoSize = true;
        logTitle.Location = new Point(16, 196);
        Win.Controls.Add(logTitle);

        TxtLog = new TextBox();
        TxtLog.Multiline = true;
        TxtLog.ReadOnly = true;
        TxtLog.ScrollBars = ScrollBars.Vertical;
        TxtLog.Location = new Point(16, 218);
        TxtLog.Size = new Size(566, 150);
        TxtLog.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
        TxtLog.BackColor = Color.FromArgb(20, 22, 26);
        TxtLog.ForeColor = Color.FromArgb(200, 210, 220);
        TxtLog.Font = new Font("Consolas", 9F);
        TxtLog.WordWrap = true;
        Win.Controls.Add(TxtLog);

        Poll = new Timer();
        Poll.Interval = 400;
        Poll.Tick += delegate { PollTick(); };

        Win.Shown += delegate { CheckOnStartup(); };
    }

    // ------------------------------------------------------------------ 小工具
    static void SetStatus(string text, Color c)
    {
        if (Win.InvokeRequired) { Win.BeginInvoke(new Action<string, Color>(SetStatus), text, c); return; }
        LblStatus.Text = text;
        LblStatus.ForeColor = c;
    }

    static void LogLine(string s)
    {
        if (Win.InvokeRequired) { Win.BeginInvoke(new Action<string>(LogLine), s); return; }
        TxtLog.AppendText(DateTime.Now.ToString("HH:mm:ss") + "  " + s + "\r\n");
    }

    static void OnOut(object sender, DataReceivedEventArgs e)
    {
        if (e.Data != null) LogLine("[后台] " + e.Data);
    }

    static void OnErr(object sender, DataReceivedEventArgs e)
    {
        if (e.Data != null) LogLine("[后台!] " + e.Data);
    }

    /// 0 = 我们的后台在跑；1 = 端口有东西但不是我们的；2 = 没人监听
    static int Probe()
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + Port + "/api/state");
            req.Timeout = 2500;
            req.Proxy = null;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                string body = sr.ReadToEnd();
                return body.IndexOf("cardCount") >= 0 ? 0 : 1;
            }
        }
        catch (WebException we)
        {
            if (we.Response != null) return 1;   // 有响应，但不是这个工具
            return 2;                            // 连不上
        }
        catch
        {
            return 2;
        }
    }

    static string FindNode()
    {
        string cfg = Path.Combine(Root, "node-path.txt");
        if (File.Exists(cfg))
        {
            try
            {
                string p = File.ReadAllText(cfg).Trim();
                if (p.Length > 0 && File.Exists(p)) return p;
            }
            catch { }
        }
        string[] cands = new string[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"nodejs\node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
            @"D:\DSH\DSH Desktop\resources\app\node_modules\node\bin\node.exe",
            @"C:\Program Files\nodejs\node.exe"
        };
        foreach (string c in cands)
        {
            try { if (File.Exists(c)) return c; }
            catch { }
        }
        string path = Environment.GetEnvironmentVariable("PATH");
        if (path != null)
        {
            string[] dirs = path.Split(';');
            foreach (string d in dirs)
            {
                string t = d.Trim().Trim('"');
                if (t.Length == 0) continue;
                try
                {
                    string p = Path.Combine(t, "node.exe");
                    if (File.Exists(p)) return p;
                }
                catch { }
            }
        }
        return null;
    }

    /// 界面上的「启动后台后自动打开网页」勾选状态存在 exe 旁边的 launcher-pref.txt。
    static string PrefPath() { return Path.Combine(Root, "launcher-pref.txt"); }
    static bool LoadBrowserPref()
    {
        try
        {
            if (File.Exists(PrefPath()))
            {
                string s = File.ReadAllText(PrefPath()).Trim().ToLowerInvariant();
                if (s.IndexOf("browser=0") >= 0) return false;
            }
        }
        catch { }
        return true;                       // 默认打开（用户双击就是要用网页）
    }
    static void SaveBrowserPref(bool on)
    {
        try { File.WriteAllText(PrefPath(), "browser=" + (on ? "1" : "0") + "\r\n", Encoding.UTF8); }
        catch { }
    }

    static void OpenBrowser()
    {
        // 只有在界面上勾了「启动后台后自动打开网页」才弹；带 --no-browser 的那一次强制不弹
        if (SuppressBrowser)
        {
            LogLine("（--no-browser：这次不打开浏览器，网页在 http://127.0.0.1:" + Port + "/）");
            return;
        }
        if (ChkBrowser != null && !ChkBrowser.Checked)
        {
            LogLine("（没有勾选「自动打开网页」，网页在 http://127.0.0.1:" + Port + "/）");
            return;
        }
        try
        {
            Process.Start(new ProcessStartInfo("http://127.0.0.1:" + Port + "/") { UseShellExecute = true });
            LogLine("已打开浏览器：http://127.0.0.1:" + Port + "/");
        }
        catch (Exception ex)
        {
            LogLine("打开浏览器失败：" + ex.Message + "（手动在浏览器输入 http://127.0.0.1:" + Port + "/）");
        }
    }

    static List<int> FindServerPids()
    {
        List<int> list = new List<int>();
        try
        {
            ManagementObjectSearcher q = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'");
            foreach (ManagementBaseObject o in q.Get())
            {
                object cl = o["CommandLine"];
                object id = o["ProcessId"];
                if (cl == null || id == null) continue;
                string s = cl.ToString();
                // 只认「跑 server.js 且带这个端口」的 node —— 绝不误杀别的 node
                if (s.IndexOf("server.js", StringComparison.OrdinalIgnoreCase) >= 0 &&
                    s.IndexOf(Port.ToString(), StringComparison.Ordinal) >= 0)
                {
                    list.Add(Convert.ToInt32(id));
                }
            }
        }
        catch (Exception ex)
        {
            LogLine("查进程失败：" + ex.Message);
        }
        return list;
    }

    // ------------------------------------------------------------------ 动作
    /// 一打开就自己把后台拉起来（用户要的就是「双击就能用」，不该还要再点一下）。
    /// 如果后台已经在跑，就只是把网页打开。
    static void CheckOnStartup()
    {
        LogLine("启动器目录：" + Root);
        int st = Probe();
        if (st == 0)
        {
            SetStatus("后台已经在跑了（127.0.0.1:" + Port + "）。", Color.SeaGreen);
            LogLine("后台服务已就绪，直接打开网页。");
            OpenBrowser();
        }
        else if (st == 1)
        {
            SetStatus("端口 " + Port + " 被别的程序占用了。", Color.Firebrick);
            LogLine("端口上确实有东西在响应，但不是这个工具。先关掉它再试。");
        }
        else
        {
            LogLine("后台没在跑，自动启动。");
            StartServer();
        }
    }

    static void StartServer()
    {
        int st = Probe();
        if (st == 0)
        {
            SetStatus("后台已经在跑了（127.0.0.1:" + Port + "）。", Color.SeaGreen);
            OpenBrowser();
            return;
        }
        if (st == 1)
        {
            SetStatus("端口 " + Port + " 被别的程序占用了。", Color.Firebrick);
            LogLine("8788 上有别的程序，起不来。请先把它关掉。");
            return;
        }

        string node = FindNode();
        if (node == null)
        {
            SetStatus("找不到 node.exe，无法启动后台。", Color.Firebrick);
            LogLine("在这些地方都没找到 node.exe。");
            DialogResult r = MessageBox.Show(
                "这台电脑上没找到 node.exe。\r\n\r\n点「确定」手动选一个 node.exe（一般在 C:\\Program Files\\nodejs\\node.exe）。",
                "找不到 node", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning);
            if (r == DialogResult.OK) PickNode();
            return;
        }

        string server = Path.Combine(Root, "server.js");
        if (!File.Exists(server))
        {
            SetStatus("这个目录里没有 server.js。", Color.Firebrick);
            LogLine("找不到：" + server + " —— 启动器必须和 server.js 放在同一个目录。");
            return;
        }

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(node, "server.js --port " + Port);
            psi.WorkingDirectory = Root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            // ★ node 往管道里写的是 UTF-8；不指定的话 .NET 按系统 OEM 代码页(936)解码，中文全乱码
            try { psi.StandardOutputEncoding = Encoding.UTF8; psi.StandardErrorEncoding = Encoding.UTF8; }
            catch { }

            Child = new Process();
            Child.StartInfo = psi;
            Child.OutputDataReceived += OnOut;
            Child.ErrorDataReceived += OnErr;
            Child.Start();
            Child.BeginOutputReadLine();
            Child.BeginErrorReadLine();

            LogLine("用这个 node：" + node);
            LogLine("已启动后台（pid=" + Child.Id + "），等它就绪…");
            SetStatus("正在启动后台服务…", Color.DarkOrange);
            PollLeft = 40;
            Poll.Start();
        }
        catch (Exception ex)
        {
            SetStatus("启动失败：" + ex.Message, Color.Firebrick);
            LogLine("启动失败：" + ex.Message);
        }
    }

    static void PickNode()
    {
        OpenFileDialog d = new OpenFileDialog();
        d.Title = "选择 node.exe";
        d.Filter = "node.exe|node.exe|所有程序 (*.exe)|*.exe";
        d.InitialDirectory = @"C:\Program Files\nodejs";
        if (d.ShowDialog() == DialogResult.OK)
        {
            try
            {
                File.WriteAllText(Path.Combine(Root, "node-path.txt"), d.FileName, Encoding.UTF8);
                LogLine("已记住 node 位置：" + d.FileName);
                StartServer();
            }
            catch (Exception ex)
            {
                LogLine("写入 node-path.txt 失败：" + ex.Message);
            }
        }
    }

    static void PollTick()
    {
        PollLeft--;
        int st = Probe();
        if (st == 0)
        {
            Poll.Stop();
            SetStatus("后台已就绪（127.0.0.1:" + Port + "）。", Color.SeaGreen);
            LogLine("后台就绪。");
            OpenBrowser();
            return;
        }
        if (PollLeft <= 0)
        {
            Poll.Stop();
            SetStatus("启动超时 —— 看下面的运行记录。", Color.Firebrick);
            LogLine("等了十几秒还没就绪。常见原因：node 版本太老、端口被占、包路径不对。");
            if (Child != null && Child.HasExited)
                LogLine("后台进程已经退出了（exit code " + Child.ExitCode + "）。");
        }
    }

    static void StopServer()
    {
        List<int> pids = FindServerPids();
        if (pids.Count == 0)
        {
            SetStatus("没有在跑的后台服务。", Color.DimGray);
            LogLine("没找到在跑的后台服务。");
            return;
        }
        DialogResult r = MessageBox.Show(
            "要停止后台服务吗？\r\n\r\n网页会打不开，但已经注入好的卡不受影响，随时可以再启动。",
            "停止后台服务", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
        if (r != DialogResult.OK) return;
        foreach (int pid in pids)
        {
            try
            {
                Process.GetProcessById(pid).Kill();
                LogLine("已停止后台服务（pid=" + pid + "）。");
            }
            catch (Exception ex)
            {
                LogLine("停止 pid=" + pid + " 失败：" + ex.Message);
            }
        }
        Child = null;
        SetStatus("后台服务已停止。", Color.DimGray);
    }
}
