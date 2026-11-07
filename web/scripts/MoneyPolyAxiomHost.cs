using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Native, standalone WebView2 host. Authentication is performed by the user on
// Axiom itself and retained by WebView2 in this application's own local profile.
// This host never reads, imports, exports, or logs browser cookies or passwords.
internal sealed class MoneyPolyAxiomHost : Form
{
    private const string PulseUrl = "https://axiom.trade/pulse?chains=sol&pulseChains=sol&moneypolyReader=1";
    private readonly WebView2 view = new WebView2();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly string profilePath;
    private readonly string adapterPath;
    private readonly Timer timer = new Timer();
    private readonly NotifyIcon tray = new NotifyIcon();
    private CoreWebView2Environment environment;
    private CoreWebView2ControllerOptions controllerOptions;
    private bool polling, quitting, ready, userShown, loginShown;
    private string lastState = "starting";
    private DateTime stateSince = DateTime.UtcNow;

    public MoneyPolyAxiomHost(string profile, string adapter, bool show)
    {
        profilePath = profile; adapterPath = adapter; userShown = false;
        Text = "MoneyPoly / RADAR — Axiom";
        ClientSize = new Size(1280, 900);
        ShowInTaskbar = show;
        WindowState = show ? FormWindowState.Normal : FormWindowState.Minimized;
        view.Dock = DockStyle.Fill;
        Controls.Add(view);
        var menu = new ContextMenuStrip();
        menu.Items.Add("Abrir Axiom", null, (sender, args) => ShowReader(true));
        menu.Items.Add("Segundo plano", null, (sender, args) => HideReader());
        menu.Items.Add("Salir del lector", null, (sender, args) => Quit(true));
        tray.Icon = SystemIcons.Application;
        tray.Text = "MoneyPoly / RADAR";
        tray.ContextMenuStrip = menu;
        tray.DoubleClick += (sender, args) => ShowReader(true);
        tray.Visible = true;
        timer.Interval = 5000;
        timer.Tick += async (sender, args) => await Poll();
        Shown += async (sender, args) => await Initialize();
        FormClosing += (sender, args) => {
            if (!quitting && args.CloseReason == CloseReason.UserClosing) { args.Cancel = true; HideReader(); }
        };
    }

    private void Output(object data) { Console.WriteLine(json.Serialize(data)); Console.Out.Flush(); }

    private async Task Initialize()
    {
        try
        {
            environment = await CoreWebView2Environment.CreateAsync(null, profilePath);
            controllerOptions = environment.CreateCoreWebView2ControllerOptions();
            controllerOptions.ProfileName = "MoneyPoly";
            controllerOptions.IsInPrivateModeEnabled = false;
            await view.EnsureCoreWebView2Async(environment, controllerOptions);
            view.CoreWebView2.WebMessageReceived += Message;
            view.CoreWebView2.NewWindowRequested += Popup;
            view.CoreWebView2.ProcessFailed += (sender, args) => {
                Output(new { kind = "error", code = "webview_process_failed" });
                Environment.ExitCode = 1; Quit(false);
            };
            ready = true;
            Output(new { kind = "initialized", engine = "webview2", requiresChrome = false });
            view.CoreWebView2.Navigate(PulseUrl);
            timer.Start();
        }
        catch (Exception error)
        {
            Output(new { kind = "error", code = "initialization_failed", errorType = error.GetType().Name, hresult = error.HResult });
            quitting = true; Close();
        }
    }

    private async void Popup(object sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        var deferral = args.GetDeferral();
        try
        {
            var popup = new Form { Text = "MoneyPoly — Acceso a Axiom", Width = 640, Height = 800 };
            var browser = new WebView2 { Dock = DockStyle.Fill };
            popup.Controls.Add(browser);
            popup.Show(this);
            await browser.EnsureCoreWebView2Async(environment, controllerOptions);
            browser.CoreWebView2.WindowCloseRequested += (owner, e) => popup.Close();
            popup.FormClosed += (owner, e) => browser.Dispose();
            args.NewWindow = browser.CoreWebView2;
            args.Handled = true;
        }
        catch { Output(new { kind = "error", code = "sign_in_popup_failed" }); }
        finally { deferral.Complete(); }
    }

    private async Task Poll()
    {
        if (!ready || polling || quitting) return;
        polling = true;
        try
        {
            string adapter = File.ReadAllText(adapterPath, Encoding.UTF8).Trim().TrimEnd(';');
            string script = @"(async()=>{
              if(globalThis.__moneyPolyPollRunning)return;
              globalThis.__moneyPolyPollRunning=true;
              try {
              const text=(document.body?.innerText||'').slice(0,4000);
              const originOk=location.origin==='https://axiom.trade';
              const state={path:location.pathname,
                challenge:/Un momento|Just a moment|Verificación de seguridad|Verify you are human/.test(document.title+' '+text),
                login:/The Gateway to DeFi|Start Trading/.test(text)&&/Login|Sign up/.test(text),
                app:originOk&&/Trackers/.test(text)&&/Portfolio/.test(text)};
              chrome.webview.postMessage({kind:'moneypoly-state',state});
              if(!originOk||state.challenge||state.login)return;
              if(state.app&&!location.pathname.includes('/pulse')){
                chrome.webview.postMessage({kind:'moneypoly-navigate-pulse'});return;
              }
              if(!location.pathname.includes('/pulse'))return;
              globalThis.__moneyPolyWorkerWindow=true;
              const data=await Promise.race([(" + adapter + @"),
                new Promise((_,reject)=>setTimeout(()=>reject(new Error('adapter_timeout')),20000))]);
              chrome.webview.postMessage({kind:'moneypoly-snapshot',data});
              } finally { globalThis.__moneyPolyPollRunning=false; }
            })().catch(()=>chrome.webview.postMessage({kind:'moneypoly-script-error'}));";
            await view.CoreWebView2.ExecuteScriptAsync(script);
        }
        catch (Exception error) { Output(new { kind = "error", code = "script_failed", errorType = error.GetType().Name }); }
        finally { polling = false; }
    }

    private void Message(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        Uri origin;
        if (!Uri.TryCreate(args.Source, UriKind.Absolute, out origin) || origin.Scheme != "https" || origin.Host != "axiom.trade") return;
        if (args.WebMessageAsJson.Length > 1000000) return;
        Dictionary<string, object> message;
        try { message = json.DeserializeObject(args.WebMessageAsJson) as Dictionary<string, object>; } catch { return; }
        if (message == null || !message.ContainsKey("kind")) return;
        string kind = Convert.ToString(message["kind"]);
        if (kind == "moneypoly-state")
        {
            var state = message["state"] as Dictionary<string, object>;
            if (state == null) return;
            string stage = Convert.ToBoolean(state["challenge"]) ? "browser_check" : Convert.ToBoolean(state["login"]) ? "awaiting_login" : "loading";
            if (stage != lastState) { lastState = stage; stateSince = DateTime.UtcNow; }
            if ((stage == "awaiting_login" || (stage == "browser_check" && (DateTime.UtcNow - stateSince).TotalSeconds > 15)) && !loginShown)
            { loginShown = true; ShowReader(false); }
            Output(new { kind = "state", state = stage, path = Convert.ToString(state["path"]), background = !Visible });
        }
        else if (kind == "moneypoly-navigate-pulse") view.CoreWebView2.Navigate(PulseUrl);
        else if (kind == "moneypoly-script-error") Output(new { kind = "error", code = "adapter_script_error" });
        else if (kind == "moneypoly-snapshot")
        {
            var data = message["data"] as Dictionary<string, object>;
            if (data == null) return;
            Output(new { kind = "snapshot", data = data });
            if (data.ContainsKey("ready") && Convert.ToBoolean(data["ready"]))
            {
                var diagnostics = data.ContainsKey("diagnostics") ? data["diagnostics"] as Dictionary<string, object> : null;
                if (diagnostics != null && diagnostics.ContainsKey("migratedLoaded") && Convert.ToInt32(diagnostics["migratedLoaded"]) > 0)
                { loginShown = false; if (!userShown) HideReader(); }
            }
        }
    }

    private void ShowReader(bool manual)
    {
        if (manual) userShown = true;
        ShowInTaskbar = true; Show(); WindowState = FormWindowState.Normal; Activate();
        Output(new { kind = "window", background = false });
    }
    private void HideReader()
    {
        userShown = false; Hide(); ShowInTaskbar = false;
        Output(new { kind = "window", background = true });
    }
    private void Quit(bool manual)
    {
        quitting = true;
        if (manual) Output(new { kind = "user_stop" });
        Close();
    }

    public void Command(string line)
    {
        try
        {
            var request = json.DeserializeObject(line) as Dictionary<string, object>;
            string type = request == null || !request.ContainsKey("type") ? "" : Convert.ToString(request["type"]);
            if (type == "show") ShowReader(true);
            else if (type == "hide") HideReader();
            else if (type == "stop") Quit(false);
        }
        catch { Output(new { kind = "error", code = "invalid_host_command" }); }
    }

    protected override void OnFormClosed(FormClosedEventArgs args)
    {
        ready = false; timer.Stop(); timer.Dispose(); tray.Visible = false; tray.Dispose(); view.Dispose();
        base.OnFormClosed(args);
    }

    [STAThread]
    private static void Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8; Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length < 2) return;
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var form = new MoneyPolyAxiomHost(args[0], args[1], args.Length > 2 && args[2] == "--show");
        var handle = form.Handle;
        Task.Run(async () => {
            string line;
            while ((line = await Console.In.ReadLineAsync()) != null)
            {
                string command = line;
                if (!form.IsDisposed) form.BeginInvoke(new Action(() => form.Command(command)));
            }
            if (!form.IsDisposed) form.BeginInvoke(new Action(() => form.Quit(false)));
        });
        Application.Run(form);
    }
}
