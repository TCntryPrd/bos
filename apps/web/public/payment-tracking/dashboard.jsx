// dashboard.jsx — Payment Tracking Dashboard (Industry Rockstar MVP, v2)

const { useState, useMemo, useEffect } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "pastDueStyle": "buckets",
  "accent": "#2D5BFF"
}/*EDITMODE-END*/;

// ───────────────────────────────────────── Sample data ─────────────────────────────────────────
// Each row carries: sales count, returns, refunds, stopped
const MONTHLY = [
  { name:"Jan", sales: 312, returns: 4, refunds: 7,  stopped: 11 },
  { name:"Feb", sales: 298, returns: 6, refunds: 5,  stopped: 9  },
  { name:"Mar", sales: 341, returns: 3, refunds: 9,  stopped: 14 },
  { name:"Apr", sales: 388, returns: 8, refunds: 6,  stopped: 12 },
  { name:"May", sales: 402, returns: 5, refunds: 8,  stopped: 16 },
];

const BY_PROGRAM = [
  { name:"Course A", sales: 412, returns: 7, refunds: 12, stopped: 21 },
  { name:"Course B", sales: 268, returns: 4, refunds: 6,  stopped: 11 },
  { name:"Course C", sales: 384, returns: 9, refunds: 8,  stopped: 17 },
  { name:"Course D", sales: 196, returns: 2, refunds: 5,  stopped: 8  },
  { name:"Course E", sales: 481, returns: 4, refunds: 4,  stopped: 5  },
];

const BY_EVENT = [
  { name:"Event A", sales: 312, returns: 6,  refunds: 9,  stopped: 14 },
  { name:"Event B", sales: 244, returns: 3,  refunds: 7,  stopped: 12 },
  { name:"Event C", sales: 401, returns: 5,  refunds: 8,  stopped: 18 },
  { name:"Event D", sales: 528, returns: 12, refunds: 11, stopped: 18 },
];

// Past-due dollars per bucket, grouped per program / event.
// Buckets are in same order: 0-30, 31-60, 61-90, 90+
const PASTDUE_OVERALL = { b:[8400, 6500, 4800, 5300] };

const PASTDUE_BY_PROGRAM = [
  { name:"Course A", b:[3200, 1860, 1240, 1240] },
  { name:"Course B", b:[1480,  980, 1500,  980] },
  { name:"Course C", b:[2200, 1500, 1500, 1500] },
  { name:"Course D", b:[ 760,  760,  380,  760] },
  { name:"Course E", b:[ 760, 1400,  180,  820] },
];

const PASTDUE_BY_EVENT = [
  { name:"Event A", b:[2400, 1620, 1240, 1240] },
  { name:"Event B", b:[1480,  980, 1500,  980] },
  { name:"Event C", b:[2520, 2100, 1320, 1500] },
  { name:"Event D", b:[2000, 1800,  740, 1580] },
];

// ───────────────────────────────────────── Helpers ─────────────────────────────────────────
const fmt$ = (n) => "$" + n.toLocaleString();
const fmtK = (n) => n >= 1000 ? "$" + (n/1000).toFixed(1) + "k" : "$" + n;
const sum  = (arr, k) => arr.reduce((a,r)=>a+r[k], 0);
const pct  = (a,b) => b ? (a/b)*100 : 0;
const dpct = (a,b) => b ? Math.round(((a-b)/b)*100) : 0;
const sumArr = (a) => a.reduce((x,y)=>x+y, 0);

const BUCKET_LABELS = ["0–30", "31–60", "61–90", "90+"];
const BUCKET_TONES  = ["ok", "warn", "hot", "crit"];
const BUCKET_VARS   = ["var(--ok)", "var(--warn)", "var(--hot)", "var(--crit)"];

// ───────────────────────────────────────── Atoms ─────────────────────────────────────────
function Sparkline({ data, accent }) {
  const W = 96, H = 28, P = 2;
  const max = Math.max(...data), min = Math.min(...data);
  const span = max - min || 1;
  const pts = data.map((v,i)=>{
    const x = P + (i*(W-P*2))/(data.length-1);
    const y = H - P - ((v-min)/span)*(H-P*2);
    return [x,y];
  });
  const d = pts.map((p,i)=> (i?"L":"M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = d + ` L ${pts[pts.length-1][0].toFixed(1)},${H-P} L ${pts[0][0].toFixed(1)},${H-P} Z`;
  return (
    <svg width={W} height={H} style={{display:"block"}}>
      <path d={area} fill={accent} opacity="0.08" />
      <path d={d} fill="none" stroke={accent} strokeWidth="1.5" strokeLinecap="round" />
      <circle cx={pts[pts.length-1][0]} cy={pts[pts.length-1][1]} r={2.5} fill={accent} />
    </svg>
  );
}

// ───────────────────────────────────────── Side nav ─────────────────────────────────────────
function SideNav({ route, setRoute }) {
  const items = [
    { id:"overview",   label:"Overview",     icon:"◐", count:null },
    { id:"collections",label:"Collections",  icon:"●", count:null },
    { id:"sales",      label:"Sales",        icon:"○", count:null },
    { id:"customers",  label:"Customers",    icon:"◑", count:null },
    { id:"reports",    label:"Reports",      icon:"◒", count:null },
  ];
  const lower = [
    { id:"settings",   label:"Settings",     icon:"◇" },
    { id:"team",       label:"Team",         icon:"◇" },
  ];
  return (
    <aside className="nav">
      <div className="brand">
        <div className="brand-mark">IR</div>
        <div className="brand-name">
          <div className="brand-line1">Industry Rockstar</div>
          <div className="brand-line2">Operations Console</div>
        </div>
      </div>

      <div className="nav-section">
        <div className="nav-cat">Main</div>
        {items.map(i=>(
          <button key={i.id}
            className={"nav-item " + (route===i.id ? "active" : "")}
            onClick={()=>setRoute(i.id)}>
            <span className="nav-icon">{i.icon}</span>
            <span className="nav-label">{i.label}</span>
            {i.count!=null && <span className="nav-count">{i.count}</span>}
          </button>
        ))}
      </div>

      <div className="nav-section">
        <div className="nav-cat">Workspace</div>
        {lower.map(i=>(
          <button key={i.id}
            className={"nav-item " + (route===i.id ? "active" : "")}
            onClick={()=>setRoute(i.id)}>
            <span className="nav-icon">{i.icon}</span>
            <span className="nav-label">{i.label}</span>
          </button>
        ))}
      </div>

      <div className="nav-foot">
        <div className="nav-user">
          <div className="nav-avatar">KC</div>
          <div className="nav-uinfo">
            <div className="nav-uname">Kenneth C.</div>
            <div className="nav-urole">Admin</div>
          </div>
          <span className="nav-dot" />
        </div>
      </div>
    </aside>
  );
}

// ───────────────────────────────────────── Topbar ─────────────────────────────────────────
function TopBar({ title, subtitle }) {
  return (
    <header className="topbar">
      <div>
        <div className="crumb">Collections <span className="crumb-sep">/</span> <span className="crumb-cur">Payment Tracking</span></div>
        <h1 className="page-title">{title}</h1>
        <div className="page-sub">{subtitle}</div>
      </div>
      <div className="topbar-right">
        <div className="search">
          <span className="search-i">⌕</span>
          <input placeholder="Search customer, program, invoice…" />
          <kbd>⌘K</kbd>
        </div>
        <button className="icon-btn" title="Refresh">↻</button>
        <button className="icon-btn" title="Export">↓</button>
        <button className="primary-btn">+ New Action</button>
      </div>
    </header>
  );
}

// ───────────────────────────────────────── View switcher ─────────────────────────────────────────
function ViewSwitcher({ view, setView }) {
  const tabs = [
    { id:"month",   label:"By Month" },
    { id:"event",   label:"By Event" },
    { id:"program", label:"By Program" },
  ];
  return (
    <div className="switcher">
      <div className="seg">
        {tabs.map(t=>(
          <button key={t.id}
            className={"seg-btn " + (view===t.id ? "on" : "")}
            onClick={()=>setView(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="switcher-meta">
        <span className="dot live" /> Live · synced from Keap 2m ago
      </div>
    </div>
  );
}

// ───────────────────────────────────────── KPI row ─────────────────────────────────────────
function KpiTile({ label, value, rate, delta, deltaTone, series, accent, onClick }) {
  // deltaTone: "good-up" or "bad-up". For sales, up is good. For returns/refunds/stopped, up is bad.
  const up = delta >= 0;
  const isBad = (deltaTone === "bad-up" && up) || (deltaTone === "good-up" && !up);
  return (
    <button className="kpi" onClick={onClick}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        <span className={"kpi-delta " + (isBad ? "bad" : "good")}>
          {up ? "▲" : "▼"} {Math.abs(delta)}%
        </span>
      </div>
      <div className="kpi-row">
        <div className="kpi-value">{value.toLocaleString()}</div>
        <Sparkline data={series} accent={accent} />
      </div>
      <div className="kpi-footer">
        {rate != null ? (
          <span className="kpi-rate">
            <span className="kpi-rate-v mono">{rate.toFixed(2)}%</span>
            <span className="kpi-rate-l">of sales</span>
          </span>
        ) : (
          <span className="kpi-rate kpi-rate-empty">vs. prior period</span>
        )}
      </div>
    </button>
  );
}

function KpiRow({ view, accent, onTileClick }) {
  const k = useMemo(()=>{
    if (view === "month") {
      const cur = MONTHLY[MONTHLY.length-1], prev = MONTHLY[MONTHLY.length-2];
      return {
        sales:   { value: cur.sales,    delta: dpct(cur.sales, prev.sales),       series: MONTHLY.map(x=>x.sales),   rate: null },
        returns: { value: cur.returns,  delta: dpct(cur.returns, prev.returns),   series: MONTHLY.map(x=>x.returns), rate: pct(cur.returns, cur.sales) },
        refunds: { value: cur.refunds,  delta: dpct(cur.refunds, prev.refunds),   series: MONTHLY.map(x=>x.refunds), rate: pct(cur.refunds, cur.sales) },
        stopped: { value: cur.stopped,  delta: dpct(cur.stopped, prev.stopped),   series: MONTHLY.map(x=>x.stopped), rate: pct(cur.stopped, cur.sales) },
      };
    }
    const src = view === "event" ? BY_EVENT : BY_PROGRAM;
    const tot = { sales:sum(src,"sales"), returns:sum(src,"returns"), refunds:sum(src,"refunds"), stopped:sum(src,"stopped") };
    return {
      sales:   { value: tot.sales,   delta: 9,   series: src.map(x=>x.sales),   rate: null },
      returns: { value: tot.returns, delta: 12,  series: src.map(x=>x.returns), rate: pct(tot.returns, tot.sales) },
      refunds: { value: tot.refunds, delta: -5,  series: src.map(x=>x.refunds), rate: pct(tot.refunds, tot.sales) },
      stopped: { value: tot.stopped, delta: 23,  series: src.map(x=>x.stopped), rate: pct(tot.stopped, tot.sales) },
    };
  }, [view]);

  return (
    <div className="kpi-row-grid">
      <KpiTile label="Sales"   value={k.sales.value}   rate={k.sales.rate}
               delta={k.sales.delta}   deltaTone="good-up" series={k.sales.series}
               accent={accent} onClick={()=>onTileClick("Sales")} />
      <KpiTile label="Returns" value={k.returns.value} rate={k.returns.rate}
               delta={k.returns.delta} deltaTone="bad-up"  series={k.returns.series}
               accent={accent} onClick={()=>onTileClick("Returns")} />
      <KpiTile label="Refunds" value={k.refunds.value} rate={k.refunds.rate}
               delta={k.refunds.delta} deltaTone="bad-up"  series={k.refunds.series}
               accent={accent} onClick={()=>onTileClick("Refunds")} />
      <KpiTile label="Stopped Paying" value={k.stopped.value} rate={k.stopped.rate}
               delta={k.stopped.delta} deltaTone="bad-up"  series={k.stopped.series}
               accent={accent} onClick={()=>onTileClick("Stopped Paying")} />
    </div>
  );
}

// ───────────────────────────────────────── Breakdown chart ─────────────────────────────────────────
function Breakdown({ view, accent }) {
  const { rows, label } = useMemo(()=>{
    if (view === "month")   return { rows: MONTHLY,    label:"Month" };
    if (view === "event")   return { rows: BY_EVENT,   label:"Event" };
    return { rows: BY_PROGRAM, label:"Program" };
  }, [view]);

  const maxVal = Math.max(...rows.map(r => r.returns + r.refunds + r.stopped));

  return (
    <section className="card">
      <header className="card-h">
        <div>
          <h3>Returns, Refunds &amp; Stopped Payments — by {label}</h3>
          <div className="card-sub">Stacked counts. Toggle the view above to recut.</div>
        </div>
        <div className="legend">
          <span className="lg"><i style={{background: accent}} /> Returns</span>
          <span className="lg"><i style={{background: "var(--warn)"}} /> Refunds</span>
          <span className="lg"><i style={{background: "var(--danger)"}} /> Stopped</span>
        </div>
      </header>

      <div className="bars">
        {rows.map((r,i)=>{
          const tot = r.returns + r.refunds + r.stopped;
          const w = (tot / maxVal) * 100;
          const segA = (r.returns / tot) * w;
          const segB = (r.refunds / tot) * w;
          const segC = (r.stopped / tot) * w;
          const rate = pct(tot, r.sales);
          return (
            <div className="bar-row" key={i}>
              <div className="bar-label">{r.name}</div>
              <div className="bar-track">
                <div className="bar-seg" style={{width: segA+"%", background: accent}} />
                <div className="bar-seg" style={{width: segB+"%", background: "var(--warn)"}} />
                <div className="bar-seg" style={{width: segC+"%", background: "var(--danger)"}} />
              </div>
              <div className="bar-total mono">{tot}</div>
              <div className="bar-rate mono">{rate.toFixed(1)}%</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ───────────────────────────────────────── Past Due ─────────────────────────────────────────
function PastDueAging({ pastDueStyle }) {
  const total = sumArr(PASTDUE_OVERALL.b);
  return (
    <div className="aging">
      {PASTDUE_OVERALL.b.map((amt, i)=>(
        <div key={i} className={"aging-tile tone-"+BUCKET_TONES[i]}>
          <div className="aging-bucket">{BUCKET_LABELS[i]} days</div>
          <div className="aging-amount">{fmt$(amt)}</div>
          <div className="aging-meta">
            <span className="aging-label">{Math.round((amt/total)*100)}% of past due</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function PastDueGrouped({ rows, pastDueStyle }) {
  const maxTotal = Math.max(...rows.map(r => sumArr(r.b)));

  // Traffic-light mode: show one solid pill per row in the WORST bucket present
  if (pastDueStyle === "traffic") {
    return (
      <table className="grouped-tbl">
        <thead>
          <tr>
            <th>Group</th>
            <th className="num">0–30</th>
            <th className="num">31–60</th>
            <th className="num">61–90</th>
            <th className="num">90+</th>
            <th className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r,i)=>{
            const total = sumArr(r.b);
            return (
              <tr key={i}>
                <td className="g-name">{r.name}</td>
                {r.b.map((v,j)=>(
                  <td key={j} className="num mono g-cell">
                    {v ? (
                      <span className={"traffic-cell tone-"+BUCKET_TONES[j]}>{fmtK(v)}</span>
                    ) : <span className="dim">—</span>}
                  </td>
                ))}
                <td className="num mono g-total">{fmt$(total)}</td>
              </tr>
            );
          })}
          <tr className="g-foot">
            <td>Total</td>
            {[0,1,2,3].map(j => (
              <td key={j} className="num mono">{fmt$(sum(rows.map(r=>({v:r.b[j]})), "v"))}</td>
            ))}
            <td className="num mono">{fmt$(sum(rows.map(r=>({v:sumArr(r.b)})), "v"))}</td>
          </tr>
        </tbody>
      </table>
    );
  }

  // Bucket mode: stacked horizontal bars
  return (
    <div className="bars">
      {rows.map((r,i)=>{
        const total = sumArr(r.b);
        const w = (total / maxTotal) * 100;
        return (
          <div className="bar-row" key={i}>
            <div className="bar-label">{r.name}</div>
            <div className="bar-track">
              {r.b.map((v,j)=>(
                <div key={j} className="bar-seg"
                  style={{ width: ((v/total) * w) + "%", background: BUCKET_VARS[j] }} />
              ))}
            </div>
            <div className="bar-total mono">{fmt$(total)}</div>
            <div className="bar-rate" />
          </div>
        );
      })}
    </div>
  );
}

function PastDueCard({ view, pastDueStyle }) {
  const total = view === "event"
    ? sum(PASTDUE_BY_EVENT.map(r=>({v:sumArr(r.b)})), "v")
    : view === "program"
    ? sum(PASTDUE_BY_PROGRAM.map(r=>({v:sumArr(r.b)})), "v")
    : sumArr(PASTDUE_OVERALL.b);

  return (
    <section className="card">
      <header className="card-h">
        <div>
          <h3>Past Due — Aging
            {view==="event" && " by Event"}
            {view==="program" && " by Program"}
          </h3>
          <div className="card-sub">
            {fmt$(total)} outstanding ·
            {view === "month" && " split across 30/60/90 buckets"}
            {view === "event" && " across active events"}
            {view === "program" && " across active programs"}
          </div>
        </div>
        {view !== "month" && (
          <div className="legend">
            {BUCKET_LABELS.map((b,i)=>(
              <span className="lg" key={i}>
                <i style={{background: BUCKET_VARS[i]}} /> {b}
              </span>
            ))}
          </div>
        )}
      </header>

      {view === "month"   && <PastDueAging   pastDueStyle={pastDueStyle} />}
      {view === "event"   && <PastDueGrouped rows={PASTDUE_BY_EVENT}   pastDueStyle={pastDueStyle} />}
      {view === "program" && <PastDueGrouped rows={PASTDUE_BY_PROGRAM} pastDueStyle={pastDueStyle} />}
    </section>
  );
}

// ───────────────────────────────────────── Revenue at risk summary ─────────────────────────────────────────
function RiskSummary({ view, accent }) {
  // Revenue at risk = total past-due $$$.
  const groups = view === "event" ? PASTDUE_BY_EVENT : view === "program" ? PASTDUE_BY_PROGRAM : null;
  const overall = sumArr(PASTDUE_OVERALL.b);
  const critical = PASTDUE_OVERALL.b[2] + PASTDUE_OVERALL.b[3]; // 60+ days

  // Top exposed group (only relevant for event/program views)
  let topGroup = null;
  if (groups) {
    const sorted = [...groups].sort((a,b)=> sumArr(b.b) - sumArr(a.b));
    topGroup = { name: sorted[0].name, amount: sumArr(sorted[0].b) };
  }

  return (
    <section className="card risk">
      <div className="risk-grid">
        <div className="risk-cell">
          <div className="risk-label">Total Past Due</div>
          <div className="risk-value">{fmt$(overall)}</div>
          <div className="risk-meta">across all programs &amp; events</div>
        </div>
        <div className="risk-cell hot">
          <div className="risk-label">Critical (60+ days)</div>
          <div className="risk-value">{fmt$(critical)}</div>
          <div className="risk-meta">{Math.round((critical/overall)*100)}% of outstanding</div>
        </div>
        <div className="risk-cell">
          <div className="risk-label">Recovery Rate</div>
          <div className="risk-value">68%</div>
          <div className="risk-meta">last 90 days</div>
        </div>
        <div className="risk-cell">
          <div className="risk-label">{topGroup ? "Top Exposure" : "Avg. Days Past Due"}</div>
          <div className="risk-value">{topGroup ? topGroup.name : "47d"}</div>
          <div className="risk-meta">{topGroup ? fmt$(topGroup.amount) + " outstanding" : "across all open accounts"}</div>
        </div>
      </div>
    </section>
  );
}

// ───────────────────────────────────────── KPI focus modal ─────────────────────────────────────────
function KpiModal({ which, view, onClose }) {
  useEffect(()=>{
    const k = (e)=> e.key==="Escape" && onClose();
    window.addEventListener("keydown", k);
    return ()=> window.removeEventListener("keydown", k);
  }, [onClose]);
  if (!which) return null;

  const key = which === "Sales" ? "sales"
            : which === "Returns" ? "returns"
            : which === "Refunds" ? "refunds"
            : "stopped";
  const rows = view==="event" ? BY_EVENT : view==="program" ? BY_PROGRAM : MONTHLY;
  const max = Math.max(...rows.map(r=>r[key]));
  const showRate = which !== "Sales";

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <header className="modal-h">
          <div>
            <div className="cust-id">{which} · By {view==="month"?"Month":view==="event"?"Event":"Program"}</div>
            <div className="cust-name lg">Detailed breakdown</div>
          </div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </header>
        <div className="modal-bars">
          {rows.map((r,i)=>(
            <div key={i} className="mb-row">
              <div className="mb-label">{r.name}</div>
              <div className="mb-track"><div className="mb-fill" style={{width: (r[key]/max)*100 + "%"}} /></div>
              <div className="mb-val mono">{r[key]}</div>
              {showRate && <div className="mb-rate mono">{pct(r[key], r.sales).toFixed(2)}%</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────── Empty route ─────────────────────────────────────────
function EmptyRoute({ name }) {
  return (
    <div className="empty">
      <div className="empty-mark">◌</div>
      <h2>{name}</h2>
      <p>This module isn't part of the MVP yet. Collections is where the action is — head back to see live data.</p>
    </div>
  );
}

// ───────────────────────────────────────── App ─────────────────────────────────────────
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [route, setRoute] = useState("collections");
  const [view, setView] = useState("month");
  const [kpiFocus, setKpiFocus] = useState(null);

  useEffect(()=>{
    document.documentElement.style.setProperty("--accent", t.accent);
  }, [t.accent]);

  const mainContent = route === "collections" ? (
    <>
      <ViewSwitcher view={view} setView={setView} />
      <KpiRow view={view} accent={t.accent} onTileClick={setKpiFocus} />
      <Breakdown view={view} accent={t.accent} />
      <RiskSummary view={view} accent={t.accent} />
      <PastDueCard view={view} pastDueStyle={t.pastDueStyle} />
    </>
  ) : (
    <EmptyRoute name={({
      overview:"Overview", sales:"Sales", customers:"Customers",
      reports:"Reports", settings:"Settings", team:"Team"
    })[route] || "Module"} />
  );

  return (
    <div className="app">
      <SideNav route={route} setRoute={setRoute} />
      <main className="main">
        <TopBar
          title="Payment Tracking"
          subtitle="Returns, refunds and stopped payments — synced from Keap" />
        <div className="content">{mainContent}</div>
      </main>

      <KpiModal which={kpiFocus} view={view} onClose={()=>setKpiFocus(null)} />

      <TweaksPanel>
        <TweakSection label="Past-due styling" />
        <TweakRadio
          label="Style"
          value={t.pastDueStyle}
          options={["buckets","traffic"]}
          onChange={(v)=>setTweak("pastDueStyle", v)}
        />
        <TweakSection label="Accent" />
        <TweakColor
          label="Color"
          value={t.accent}
          options={["#2D5BFF","#1F8A5B","#9333EA","#0F172A"]}
          onChange={(v)=>setTweak("accent", v)}
        />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
