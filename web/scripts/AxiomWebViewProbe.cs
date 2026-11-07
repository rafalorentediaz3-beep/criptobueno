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

// Diagnostic only. The Node launcher requires explicit session-use consent.
// The access cookie arrives through stdin, is used only in an InPrivate profile,
// and is never written to a file, command line, console, or regular profile.
internal sealed class AxiomWebViewProbe : Form
{
    private readonly WebView2 view = new WebView2();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly string profilePath;
    private readonly string readerPath;
    private readonly Dictionary<string, object> cookieInput;
    private readonly Timer timer = new Timer();
    private DateTime started = DateTime.UtcNow;
    private bool polling;

    public AxiomWebViewProbe(string profile, string reader, Dictionary<string, object> cookie)
    {
        profilePath = profile; readerPath = reader; cookieInput = cookie;
        Text = "MoneyPoly embedded reader probe";
        ClientSize = new Size(1280, 900);
        ShowInTaskbar = false;
        WindowState = FormWindowState.Minimized;
        view.Dock = DockStyle.Fill;
        Controls.Add(view);
        Shown += async (sender, args) => await Initialize();
        timer.Interval = 5000;
        timer.Tick += async (sender, args) => await Poll();
    }

    private string Field(string name) { return cookieInput.ContainsKey(name) ? Convert.ToString(cookieInput[name]) : ""; }
    private void Output(object data) { Console.WriteLine(json.Serialize(data)); Console.Out.Flush(); }

    private async Task Initialize()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, profilePath);
            var options = environment.CreateCoreWebView2ControllerOptions();
            options.ProfileName = "MoneyPolyProbe";
            options.IsInPrivateModeEnabled = true;
            await view.EnsureCoreWebView2Async(environment, options);
            view.CoreWebView2.WebMessageReceived += Message;
            view.CoreWebView2.NavigationStarting += (sender, args) => {
                Uri url;
                if (!Uri.TryCreate(args.Uri, UriKind.Absolute, out url) ||
                    (url.Scheme != "about" && (url.Scheme != "https" ||
                    !(url.Host == "axiom.trade" || url.Host.EndsWith(".axiom.trade"))))) args.Cancel = true;
            };
            if (!String.IsNullOrEmpty(Field("name")))
            {
                if (Field("name") != "auth-access-token") throw new InvalidOperationException("Unexpected session field");
                var cookie = view.CoreWebView2.CookieManager.CreateCookie(Field("name"), Field("value"), Field("domain"), Field("path"));
                cookie.IsHttpOnly = true;
                cookie.IsSecure = true;
                CoreWebView2CookieSameSiteKind sameSite;
                if (Enum.TryParse(Field("sameSite"), out sameSite)) cookie.SameSite = sameSite;
                view.CoreWebView2.CookieManager.AddOrUpdateCookie(cookie);
            }
            cookieInput.Clear();
            Output(new { stage = "embedded_initialized", inPrivate = true });
            view.CoreWebView2.Navigate("https://axiom.trade/pulse?chains=sol&pulseChains=sol&moneypolyReader=1");
            started = DateTime.UtcNow;
            timer.Start();
        }
        catch (Exception error)
        {
            cookieInput.Clear();
            Output(new { stage = "initialization_failed", errorType = error.GetType().Name });
            Close();
        }
    }

    private async Task Poll()
    {
        if (polling || view.CoreWebView2 == null) return;
        if ((DateTime.UtcNow - started).TotalSeconds >= 35) { timer.Stop(); Close(); return; }
        polling = true;
        try
        {
            string reader = File.ReadAllText(readerPath, Encoding.UTF8);
            string code = @"(async()=>{
                const text=(document.body?.innerText||'').slice(0,3000);
                const state={path:location.pathname,
                  challenge:/Un momento|Just a moment|Verificacion de seguridad|Verificación de seguridad|Verify you are human/.test(document.title+' '+text),
                  login:/The Gateway to DeFi|Start Trading/.test(text)&&/Login|Sign up/.test(text),
                  pulse:/New Pairs|Final Stretch|Migrated/.test(text)};
                chrome.webview.postMessage({kind:'moneypoly-state',state});
                if(!state.challenge&&!state.login&&state.pulse){
                  globalThis.__moneyPolyWorkerWindow=true;
                  const snapshot=await (" + reader.Trim().TrimEnd(';') + @");
                  chrome.webview.postMessage({kind:'moneypoly-snapshot',snapshot});
                }
              })().catch(()=>chrome.webview.postMessage({kind:'moneypoly-error'}));";
            await view.CoreWebView2.ExecuteScriptAsync(code);
        }
        catch (Exception error) { Output(new { stage = "poll_failed", errorType = error.GetType().Name }); }
        finally { polling = false; }
    }

    private void Message(object sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        Uri origin;
        if (!Uri.TryCreate(args.Source, UriKind.Absolute, out origin) || origin.Host != "axiom.trade") return;
        var message = json.DeserializeObject(args.WebMessageAsJson) as Dictionary<string, object>;
        if (message == null || !message.ContainsKey("kind")) return;
        string kind = Convert.ToString(message["kind"]);
        if (kind == "moneypoly-state") Output(new { stage = "embedded_state", state = message["state"] });
        if (kind == "moneypoly-error") Output(new { stage = "embedded_script_error" });
        if (kind == "moneypoly-snapshot")
        {
            var data = message["snapshot"] as Dictionary<string, object>;
            if (data != null) Output(new { stage = "embedded_snapshot", ready = data.ContainsKey("ready") ? data["ready"] : null,
                diagnostics = data.ContainsKey("diagnostics") ? data["diagnostics"] : null });
        }
    }

    protected override void OnFormClosed(FormClosedEventArgs args)
    {
        timer.Stop(); timer.Dispose(); cookieInput.Clear(); view.Dispose(); base.OnFormClosed(args);
    }

    [STAThread]
    private static void Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8; Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length != 2) return;
        var parser = new JavaScriptSerializer();
        var input = parser.DeserializeObject(Console.ReadLine() ?? "{}") as Dictionary<string, object>;
        if (input == null || !input.ContainsKey("cookie")) return;
        var cookie = input["cookie"] as Dictionary<string, object>;
        if (cookie == null) return;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new AxiomWebViewProbe(args[0], args[1], cookie));
    }
}
