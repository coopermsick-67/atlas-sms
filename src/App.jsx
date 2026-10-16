import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  AlertCircle, ArrowDownToLine, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown,
  CircleHelp, Clipboard, FileUp, LoaderCircle, LockKeyhole, LogOut,
  MessageCircle, MessageSquareText, MoreHorizontal, Plus, Search, Send, Settings,
  Shield, ShieldCheck, Smartphone, Trash2, Upload, Users, X
} from 'lucide-react';

const DEFAULT_MESSAGE = 'Hi {{first_name}}, this is {{business_name}}. Would you be open to discussing {{property_address}}? Reply STOP to opt out.';
const consentFields = [
  ['name', 'Name'], ['phone', 'Phone number'], ['property_address', 'Property address'],
  ['city', 'City'], ['state', 'State'], ['zip', 'ZIP code'], ['notes', 'Notes'],
  ['consent_status', 'SMS consent'], ['consent_source', 'Consent source'],
  ['consent_evidence', 'Consent proof'], ['consent_at', 'Consent date']
];

async function api(path, options = {}) {
  const { headers, ...requestOptions } = options;
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...requestOptions,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && path !== '/login' && path !== '/setup/admin') window.dispatchEvent(new Event('atlas-auth-expired'));
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function maskPhone(phone = '') {
  return phone.length > 5 ? `${phone.slice(0, 4)} ••• ••${phone.slice(-2)}` : phone;
}

function App() {
  const [stage, setStage] = useState('loading');
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [toast, setToast] = useState(null);
  const [page, setPage] = useState('leads');
  const [refreshToken, setRefreshToken] = useState(0);
  const [composerOpen, setComposerOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [importOpen, setImportOpen] = useState(false);
  const [consentLead, setConsentLead] = useState(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const toastTimer = useRef(null);

  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);
  const notify = useCallback((type, message) => {
    setToast({ type, message });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4400);
  }, []);

  useEffect(() => {
    let alive = true;
    api('/setup/status').then(async ({ needs_setup }) => {
      if (!alive) return;
      if (needs_setup) return setStage('setup');
      const me = await api('/me');
      if (alive) setStage(me.signed_in ? 'app' : 'login');
    }).catch(() => alive && setStage('offline'));
    return () => { alive = false; };
  }, [startupAttempt]);

  useEffect(() => {
    const onExpired = () => { setStage('login'); setConfirmSignOut(false); setComposerOpen(false); setSelectedIds([]); };
    window.addEventListener('atlas-auth-expired', onExpired);
    return () => window.removeEventListener('atlas-auth-expired', onExpired);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  async function signOut() {
    try {
      await api('/logout', { method: 'POST', body: '{}' });
      setStage('login');
      setPage('leads');
      setSelectedIds([]);
      setConfirmSignOut(false);
    } catch (err) { notify('error', err.message); }
  }

  if (stage === 'loading') return <div className="loading-screen"><LoaderCircle className="spin" size={24} /><span>Opening Atlas SMS…</span></div>;
  if (stage === 'offline') return <AuthPage icon={AlertCircle} title="Atlas SMS is unavailable" subtitle="Start the local Atlas API, then try connecting again."><button className="primary-button full-width" onClick={() => { setStage('loading'); setStartupAttempt((attempt) => attempt + 1); }}>Retry connection</button></AuthPage>;
  if (stage === 'setup') return <FirstRun onDone={() => setStage('app')} />;
  if (stage === 'login') return <Login onDone={() => setStage('app')} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><div className="brand-mark">A</div><span>Atlas <b>SMS</b></span></div>
        <div className="top-search"><Search size={17} /><span>Import leads, keep consent clear, and follow up.</span></div>
        <div className="top-actions">
          <span className="local-pill"><span className="green-dot" /> Local workspace</span>
          <button className="icon-button" aria-label="Help" title="Help" onClick={() => notify('info', 'Only contacts with documented SMS consent can enter a live campaign.')}><CircleHelp size={18} /></button>
          <button className="user-button" onClick={() => setConfirmSignOut(true)}><span className="avatar">A</span><span>Admin</span><ChevronDown size={14} /></button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-label">WORKSPACE</div>
          <NavItem icon={Users} label="Leads" active={page === 'leads'} onClick={() => setPage('leads')} />
          <NavItem icon={Send} label="Campaigns" active={page === 'campaigns'} onClick={() => setPage('campaigns')} />
          <NavItem icon={MessageCircle} label="Conversations" active={page === 'conversations'} onClick={() => setPage('conversations')} />
          <NavItem icon={Shield} label="Suppression list" active={page === 'suppression'} onClick={() => setPage('suppression')} />
          <div className="sidebar-divider" />
          <div className="sidebar-label">ADMIN</div>
          <NavItem icon={Settings} label="Settings & phone" active={page === 'settings'} onClick={() => setPage('settings')} />
          <div className="sidebar-foot">
            <div className="privacy-icon"><LockKeyhole size={15} /></div>
            <div><strong>Stored on this computer</strong><span>Lead data stays in the local database.</span></div>
          </div>
        </aside>

        <main className={`main-content ${composerOpen && page === 'leads' ? 'with-composer' : ''}`}>
          {page === 'leads' && <LeadsPage key={refreshToken} selectedIds={selectedIds} setSelectedIds={setSelectedIds} onImport={() => setImportOpen(true)} onNewCampaign={() => setComposerOpen(true)} onEditConsent={setConsentLead} notify={notify} />}
          {page === 'campaigns' && <CampaignsPage key={refreshToken} onRefresh={refresh} notify={notify} />}
          {page === 'conversations' && <ConversationsPage key={refreshToken} notify={notify} />}
          {page === 'suppression' && <SuppressionPage key={refreshToken} notify={notify} />}
          {page === 'settings' && <SettingsPage key={refreshToken} notify={notify} />}
        </main>

        {composerOpen && page === 'leads' && <CampaignComposer selectedIds={selectedIds} onClose={() => setComposerOpen(false)} onDone={(message) => { setComposerOpen(false); setSelectedIds([]); setPage('campaigns'); refresh(); notify('success', message); }} notify={notify} />}
      </div>

      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onImported={(message) => { setImportOpen(false); setSelectedIds([]); refresh(); notify('success', message); }} notify={notify} />}
      {consentLead && <ConsentDialog lead={consentLead} onClose={() => setConsentLead(null)} onSaved={() => { setConsentLead(null); refresh(); notify('success', 'Consent record saved. This lead is eligible after any active suppression is cleared.'); }} />}
      {confirmSignOut && <ConfirmDialog title="Sign out of Atlas SMS?" body="You will need your local workspace password to return." confirmLabel="Sign out" onCancel={() => setConfirmSignOut(false)} onConfirm={signOut} />}
      {toast && <div className={`toast toast-${toast.type}`} role="status">{toast.type === 'success' ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}{toast.message}</div>}
    </div>
  );
}

function NavItem({ icon: Icon, label, active, onClick }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={onClick} aria-label={label} aria-current={active ? 'page' : undefined}><Icon size={18} strokeWidth={1.8} /><span>{label}</span></button>;
}

function FirstRun({ onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    setError('');
    if (password !== confirm) return setError('The passwords do not match.');
    setBusy(true);
    try { await api('/setup/admin', { method: 'POST', body: JSON.stringify({ password }) }); onDone(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <AuthPage icon={ShieldCheck} title="Set up your local workspace" subtitle="Create the password that protects this computer’s Atlas SMS data.">
    <form onSubmit={submit} className="auth-form">
      <label>Password<input type="password" autoComplete="new-password" minLength="12" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="At least 12 characters" /></label>
      <label>Confirm password<input type="password" autoComplete="new-password" minLength="12" value={confirm} onChange={(e) => setConfirm(e.target.value)} required placeholder="Enter it again" /></label>
      {error && <InlineError>{error}</InlineError>}
      <button className="primary-button full-width" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={16} />}Create workspace password</button>
    </form>
    <div className="auth-footnote"><LockKeyhole size={14} /> Your password is hashed and saved locally. There is no online account.</div>
  </AuthPage>;
}

function Login({ onDone }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/login', { method: 'POST', body: JSON.stringify({ password }) }); onDone(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <AuthPage icon={LockKeyhole} title="Welcome back" subtitle="Sign in to open your local Atlas SMS workspace.">
    <form onSubmit={submit} className="auth-form">
      <label>Workspace password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus /></label>
      {error && <InlineError>{error}</InlineError>}
      <button className="primary-button full-width" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={16} />}Sign in</button>
    </form>
    <div className="auth-footnote"><LockKeyhole size={14} /> The app runs on this computer and keeps data in its local database.</div>
  </AuthPage>;
}

function AuthPage({ icon: Icon, title, subtitle, children }) {
  return <div className="auth-page"><div className="auth-card"><div className="auth-brand"><div className="brand-mark">A</div><span>Atlas <b>SMS</b></span></div><div className="auth-icon"><Icon size={21} /></div><h1>{title}</h1><p>{subtitle}</p>{children}</div></div>;
}

function LeadsPage({ selectedIds, setSelectedIds, onImport, onNewCampaign, onEditConsent, notify }) {
  const [view, setView] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const requestSequence = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    try {
      const result = await api(`/leads?view=${view}&page=${page}&limit=50&q=${encodeURIComponent(query)}`);
      if (requestId === requestSequence.current) setData(result);
    } catch (err) {
      if (requestId === requestSequence.current) notify('error', err.message);
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, [view, page, query, notify]);
  useEffect(() => { const timer = window.setTimeout(load, 120); return () => window.clearTimeout(timer); }, [load]);
  const rows = data?.rows || [];
  const selected = new Set(selectedIds);
  const selectableRows = rows.filter((row) => row.eligibility.eligible);
  const allVisibleSelected = selectableRows.length > 0 && selectableRows.every((row) => selected.has(row.id));
  const stats = data?.stats || { total: 0, consented: 0, missing_consent: 0, suppressed: 0, eligible: 0 };
  const tabs = [
    ['all', 'All leads', stats.total], ['consented', 'Consented', stats.consented],
    ['missing', 'Missing consent', stats.missing_consent], ['suppressed', 'Suppressed', stats.suppressed]
  ];
  function toggle(id) { setSelectedIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]); }
  function selectPage() { setSelectedIds((current) => allVisibleSelected ? current.filter((id) => !selectableRows.some((row) => row.id === id)) : [...new Set([...current, ...selectableRows.map((row) => row.id)])]); }
  async function selectAllEligible() {
    try {
      const result = await api(`/leads/eligible-ids?q=${encodeURIComponent(query)}`);
      setSelectedIds(result.ids);
      notify('success', `${result.ids.length} eligible leads selected.${result.capped ? ' Selection is capped at 2,000 leads.' : ''} ${result.daily_limit.remaining} live sends remain in this 24-hour window (cap ${result.daily_limit.limit}).`);
    } catch (err) { notify('error', err.message); }
  }
  return <>
    <div className="page-heading">
      <div><h1>Leads</h1><p>Import your pipeline and track the consent record for each number.</p></div>
      <div className="heading-actions"><button className="secondary-button" onClick={onImport}><Upload size={16} />Import CSV</button><button className="primary-button" onClick={onNewCampaign}><Send size={15} />New campaign</button></div>
    </div>
    <div className="lead-toolbar">
      <div className="filter-tabs">{tabs.map(([id, label, count]) => <button key={id} className={`filter-tab ${view === id ? 'selected' : ''}`} onClick={() => { setView(id); setPage(1); }}>{label}<span>{count}</span></button>)}</div>
      <label className="search-field"><Search size={16} /><input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="Search name, phone or address" /></label>
    </div>
    <div className="selection-line">
      <div><strong>{selectedIds.length} selected</strong><span className="line-dot">·</span><span>{stats.eligible} eligible for SMS</span><button className="text-button" onClick={selectAllEligible} disabled={!stats.eligible}>Select all eligible</button>{selectedIds.length > 0 && <button className="text-button muted" onClick={() => setSelectedIds([])}>Clear</button>}</div>
      <span>{loading ? 'Updating…' : `${data?.total ?? 0} leads`}</span>
    </div>
    {loading ? <div className="table-loading"><LoaderCircle className="spin" size={18} />Loading leads</div> : rows.length ? <div className="table-scroll"><table className="lead-table"><thead><tr>
      <th className="check-cell"><input type="checkbox" aria-label="Select eligible leads on this page" checked={allVisibleSelected} onChange={selectPage} /></th><th>Name</th><th>Phone</th><th>Property address</th><th>Consent status</th><th>Consent source</th><th>Consent date</th><th></th>
    </tr></thead><tbody>{rows.map((lead) => <tr key={lead.id} className={selected.has(lead.id) ? 'row-selected' : ''}>
      <td className="check-cell"><input type="checkbox" aria-label={`Select ${lead.name || lead.phone}`} checked={selected.has(lead.id)} onChange={() => toggle(lead.id)} /></td>
      <td><div className="lead-name">{lead.name || 'Unnamed lead'}</div>{lead.city || lead.state ? <div className="subtext">{[lead.city, lead.state, lead.zip].filter(Boolean).join(', ')}</div> : null}</td>
      <td className="phone-cell">{lead.phone}</td><td className="address-cell">{lead.property_address || '—'}</td>
      <td><ConsentBadge lead={lead} onClick={() => onEditConsent(lead)} /></td><td className="source-cell">{lead.consent_source || '—'}</td><td className="date-cell">{fmtDate(lead.consent_at)}</td>
      <td><button className="row-menu" title="Record consent evidence" onClick={() => onEditConsent(lead)}><MoreHorizontal size={18} /></button></td>
    </tr>)}</tbody></table></div> : <EmptyLeads onImport={onImport} />}
    <div className="table-footer"><span>Showing {rows.length ? `${(page - 1) * 50 + 1}–${(page - 1) * 50 + rows.length}` : '0'} of {data?.total || 0}</span><div className="pagination"><button className="icon-button small" disabled={page <= 1} onClick={() => setPage((n) => Math.max(1, n - 1))} aria-label="Previous page"><ArrowLeft size={15} /></button><span>Page {page} of {data?.pages || 1}</span><button className="icon-button small" disabled={page >= (data?.pages || 1)} onClick={() => setPage((n) => n + 1)} aria-label="Next page"><ArrowRight size={15} /></button></div></div>
    <div className="consent-note"><ShieldCheck size={16} /><span>Live campaigns include only leads with a valid phone, a dated consent record, source, and supporting evidence. STOP replies suppress the number immediately.</span></div>
  </>;
}

function ConsentBadge({ lead, onClick }) {
  const state = lead.is_suppressed ? 'suppressed' : lead.eligibility.eligible ? 'consented' : lead.consent_status === 'consented' ? 'incomplete' : 'missing';
  const labels = { suppressed: 'Suppressed', consented: 'Consented', incomplete: 'Proof incomplete', missing: 'Missing consent' };
  const Icon = state === 'consented' ? CheckCircle2 : state === 'suppressed' ? Shield : AlertCircle;
  return <button className={`consent-badge ${state}`} onClick={onClick} title={lead.is_suppressed ? 'This number is on the suppression list' : 'Review consent evidence'}><Icon size={13} />{labels[state]}</button>;
}

function EmptyLeads({ onImport }) {
  return <div className="empty-state"><div className="empty-icon"><Users size={23} /></div><h2>Your lead list is empty</h2><p>Import a CSV to start organizing property leads. SMS consent fields are optional at import and default to blocked until proof is recorded.</p><button className="primary-button" onClick={onImport}><Upload size={15} />Import a CSV</button><a className="download-link" href="/atlas-leads-template.csv" download><ArrowDownToLine size={14} />Download CSV template</a></div>;
}

function ImportDialog({ onClose, onImported, notify }) {
  const [file, setFile] = useState(null);
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestSequence = useRef(0);
  async function chooseFile(selected) {
    const requestId = ++requestSequence.current;
    setFile(selected); setPreview(null); setMapping({}); setError('');
    if (!selected) return;
    if (selected.size > 7 * 1024 * 1024) return setError('Choose a CSV smaller than 7 MB.');
    try {
      const text = await selected.text();
      if (requestId !== requestSequence.current) return;
      setCsvText(text);
      const result = await api('/import/preview', { method: 'POST', body: JSON.stringify({ csv_text: text }) });
      if (requestId !== requestSequence.current) return;
      setPreview(result); setMapping(result.suggested_mapping);
    } catch (err) { if (requestId === requestSequence.current) setError(err.message || 'Could not read this file.'); }
  }
  async function importFile() {
    setBusy(true); setError('');
    try {
      const result = await api('/import', { method: 'POST', body: JSON.stringify({ csv_text: csvText, mapping }) });
      const skipped = result.skipped.length ? ` ${result.skipped.length} row(s) skipped for invalid phone numbers.` : '';
      onImported(`${result.imported} lead rows imported or updated.${skipped}`);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <Modal title="Import leads from CSV" subtitle="Map your columns once, then preview exactly what will be imported." onClose={onClose} wide>
    <div className="import-content">
      <label className="upload-drop"><input type="file" accept=".csv,text/csv" onChange={(e) => chooseFile(e.target.files?.[0] || null)} /><div className="upload-icon"><FileUp size={22} /></div><strong>{file?.name || 'Choose a CSV file'}</strong><span>{file ? `${Math.round(file.size / 1024)} KB · ${preview?.row_count ?? 'Reading…'} rows` : 'Headers are detected automatically. Files stay on this computer.'}</span><span className="secondary-button">Browse files</span></label>
      {preview && <>
        <div className="mapping-title"><div><h3>Match the CSV columns</h3><p>Phone is required. Consent imports only when source, proof, and date are all present.</p></div><span>{preview.row_count} data rows</span></div>
        <div className="mapping-grid">{consentFields.map(([key, label]) => <label key={key}>{label}{key === 'phone' && <em>Required</em>}<select value={mapping[key] || ''} onChange={(e) => setMapping((current) => ({ ...current, [key]: e.target.value }))}><option value="">Do not import</option>{preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}</select></label>)}</div>
        <div className="preview-table-wrap"><table className="preview-table"><thead><tr>{preview.headers.slice(0, 6).map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{preview.preview.map((row, index) => <tr key={index}>{preview.headers.slice(0, 6).map((header) => <td key={header}>{row[header] || '—'}</td>)}</tr>)}</tbody></table></div>
        <div className="import-warning"><ShieldCheck size={16} /><span>Rows without complete, documented SMS consent are imported as <b>Missing consent</b> and cannot be sent in a live campaign.</span></div>
      </>}
      {error && <InlineError>{error}</InlineError>}
      <div className="modal-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!preview || !mapping.phone || busy} onClick={importFile}>{busy ? <LoaderCircle className="spin" size={16} /> : <Upload size={15} />}Import {preview?.row_count || ''} rows</button></div>
    </div>
  </Modal>;
}

function ConsentDialog({ lead, onClose, onSaved }) {
  const [source, setSource] = useState(lead.consent_source || '');
  const [evidence, setEvidence] = useState(lead.consent_evidence || '');
  const [date, setDate] = useState(lead.consent_at ? new Date(lead.consent_at).toISOString().slice(0, 10) : '');
  const [attested, setAttested] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!attested) return setError('Confirm that the consent record exists before saving.');
    setBusy(true); setError('');
    try { await api(`/leads/${lead.id}/consent`, { method: 'PATCH', body: JSON.stringify({ consent_source: source, consent_evidence: evidence, consent_at: date }) }); onSaved(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <Modal title="Record SMS consent" subtitle={`${lead.name || 'This lead'} · ${lead.phone}`} onClose={onClose}>
    <div className="form-stack">
      {lead.is_suppressed && <div className="warning-banner"><Shield size={16} /><span>This number is suppressed. Recording consent alone will not remove the block; use the suppression page to document new consent before release.</span></div>}
      <label>Where did they opt in?<input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Website form, signed agreement…" /></label>
      <label>Consent date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label>Evidence reference<textarea rows="3" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Form submission ID, signed document path, or other auditable reference" /></label>
      <label className="check-label"><input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} /><span>I have verified this person affirmatively agreed to receive SMS from this business.</span></label>
      {error && <InlineError>{error}</InlineError>}
      <div className="modal-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !source || !date || !evidence} onClick={save}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={15} />}Save consent record</button></div>
    </div>
  </Modal>;
}

function CampaignComposer({ selectedIds, onClose, onDone, notify }) {
  const [name, setName] = useState(`Property follow-up · ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`);
  const [message, setMessage] = useState(DEFAULT_MESSAGE);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { setPreview(null); setConfirmOpen(false); setConfirmText(''); }, [selectedIds]);
  async function checkRecipients() {
    setLoading(true); setError('');
    try { setPreview(await api('/campaigns/preview', { method: 'POST', body: JSON.stringify({ contact_ids: selectedIds, message }) })); }
    catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  async function createCampaign(asDryRun, confirmation = '') {
    setLoading(true); setError('');
    let created = null;
    try {
      const expectedCount = preview?.eligible_count;
      if (!Number.isInteger(expectedCount)) throw new Error('Check recipients again before creating this campaign.');
      created = await api('/campaigns', { method: 'POST', body: JSON.stringify({ name, message, contact_ids: selectedIds, expected_count: expectedCount }) });
      const result = await api(`/campaigns/${created.id}/start`, { method: 'POST', body: JSON.stringify({ dry_run: asDryRun, confirmation }) });
      onDone(asDryRun ? `Dry-run preview saved for ${result.recipient_count} eligible recipients. No SMS was sent.` : `Campaign queued for ${result.recipient_count} consented leads.`);
    } catch (err) {
      if (created?.id) {
        const current = await api('/campaigns').catch(() => null);
        const saved = current?.campaigns?.find((campaign) => campaign.id === created.id);
        if (saved && saved.status !== 'draft') {
          onDone(`Campaign status is ${saved.status}. Check Campaigns before trying again.`);
          return;
        }
        await api(`/campaigns/${created.id}`, { method: 'DELETE' }).catch(() => {});
      }
      setError(err.message); notify('error', err.message);
    }
    finally { setLoading(false); }
  }
  return <aside className="composer-panel">
    <div className="composer-heading"><div><div className="panel-title">New campaign</div><p>Consent-checked before queueing</p></div><button className="icon-button" onClick={onClose} aria-label="Close campaign composer"><X size={18} /></button></div>
    <div className="composer-scroll">
      <section className="composer-section"><div className="section-heading"><span className="step-number">1</span><div><h2>Recipients</h2><p>Only documented, unsuppressed numbers can send.</p></div></div>
        <div className="recipient-counts"><div><span>Selected</span><strong>{selectedIds.length}</strong></div><div><span>Eligible</span><strong className="green-text">{preview?.eligible_count ?? '—'}</strong></div></div>
        {preview && <div className="eligibility-summary"><CheckCircle2 size={16} /><div><b>{preview.eligible_count} consented contacts can be messaged.</b><span>{preview.blocked_count} selected contact(s) are blocked and will not be included.</span></div></div>}
        {preview?.blocked?.length > 0 && <details className="blocked-details"><summary>Review blocked contacts and reasons</summary><ul>{preview.blocked.slice(0, 12).map((contact) => <li key={contact.id}><strong>{contact.name || contact.phone}</strong><span>{contact.reasons.join(' · ')}</span></li>)}</ul>{preview.blocked.length > 12 && <small>Showing 12 of {preview.blocked.length} blocked contacts.</small>}</details>}
        {!selectedIds.length && <div className="quiet-note">Select leads in the table or use “Select all eligible” first.</div>}
      </section>
      <section className="composer-section"><div className="section-heading"><span className="step-number">2</span><div><h2>Campaign message</h2><p>Personalize with <code>{'{{first_name}}'}</code>, <code>{'{{property_address}}'}</code>, and <code>{'{{business_name}}'}</code>.</p></div></div>
        <label className="field-label">Campaign name<input value={name} onChange={(e) => { setName(e.target.value); setPreview(null); }} maxLength={100} /></label>
        <label className="field-label">Message<textarea value={message} onChange={(e) => { setMessage(e.target.value); setPreview(null); }} rows={6} maxLength={480} /><span className="char-count">{message.length}/480</span></label>
        <div className="message-check"><CheckCircle2 size={15} /><span>Sender identity and STOP instruction are added if missing.</span></div>
      </section>
      <section className="composer-section"><div className="section-heading"><span className="step-number">3</span><div><h2>Send options</h2><p>Up to 100 messages in each 24-hour window.</p></div></div>
        <label className={`send-mode ${dryRun ? 'selected' : ''}`}><input type="radio" checked={dryRun} onChange={() => setDryRun(true)} /><span><strong>Dry run</strong><small>Save a recipient preview without sending SMS.</small></span></label>
        <label className={`send-mode ${!dryRun ? 'selected live-mode' : ''}`}><input type="radio" checked={!dryRun} onChange={() => setDryRun(false)} /><span><strong>Live send</strong><small>Queue messages through your paired Android SIM.</small></span></label>
        {preview?.daily_limit && !preview.daily_limit.ok && <div className="warning-banner"><AlertCircle size={16} /><span>{preview.daily_limit.remaining} live sends remain in the current 24-hour window.</span></div>}
        {!dryRun && <div className="live-warning"><Smartphone size={15} />The paired phone must be online with its SIM, SMS permission, and mobile service.</div>}
      </section>
      {preview?.messages?.length > 0 && <section className="sample-message"><div className="sample-title">PERSONALIZED PREVIEW</div><div className="message-bubble">{preview.messages[0].message}</div><span>To {maskPhone(preview.messages[0].phone)}</span></section>}
      {error && <InlineError>{error}</InlineError>}
    </div>
    <div className="composer-actions"><button className="secondary-button full-width" disabled={loading || !selectedIds.length || !message.trim()} onClick={checkRecipients}>{loading ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}Check recipients</button>
      {preview && <button className="primary-button full-width" disabled={loading || !preview.eligible_count || !name.trim() || (!dryRun && !preview.daily_limit.ok)} onClick={() => dryRun ? createCampaign(true) : setConfirmOpen(true)}>{loading ? <LoaderCircle className="spin" size={16} /> : dryRun ? <Clipboard size={15} /> : <Send size={15} />}{dryRun ? `Save dry run (${preview.eligible_count})` : `Review live send (${preview.eligible_count})`}</button>}
    </div>
    {confirmOpen && preview && <LiveConfirm count={preview.eligible_count} value={confirmText} setValue={setConfirmText} onCancel={() => { setConfirmOpen(false); setConfirmText(''); }} onConfirm={() => { setConfirmOpen(false); createCampaign(false, confirmText); }} />}
  </aside>;
}

function LiveConfirm({ count, value, setValue, onCancel, onConfirm }) {
  return <Modal title="Confirm live SMS campaign" subtitle={`${count} messages will be queued to eligible leads through the paired SIM.`} onClose={onCancel}>
    <div className="form-stack"><div className="warning-banner"><AlertCircle size={16} /><span>Check each recipient’s consent record. SMS sent through your carrier may use your messaging plan and carrier limits.</span></div><label>Type <b>SEND {count}</b> to continue<input value={value} onChange={(e) => setValue(e.target.value)} placeholder={`SEND ${count}`} autoFocus /></label><div className="modal-actions"><button className="secondary-button" onClick={onCancel}>Go back</button><button className="primary-button" disabled={value !== `SEND ${count}`} onClick={onConfirm}><Send size={15} />Queue live campaign</button></div></div>
  </Modal>;
}

function CampaignsPage({ onRefresh, notify }) {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  async function load() { setLoading(true); try { const result = await api('/campaigns'); setCampaigns(result.campaigns); } catch (err) { notify('error', err.message); } finally { setLoading(false); } }
  useEffect(() => { load(); const timer = window.setInterval(load, 5000); return () => window.clearInterval(timer); }, []);
  async function cancel(id) { try { await api(`/campaigns/${id}/cancel`, { method: 'POST', body: '{}' }); await load(); onRefresh(); notify('success', 'Queued messages were cancelled.'); } catch (err) { notify('error', err.message); } }
  return <>
    <div className="page-heading"><div><h1>Campaigns</h1><p>Review dry runs, queued texts, and campaign outcomes.</p></div></div>
    <div className="section-toolbar"><div className="section-title"><span className="section-icon"><Send size={17} /></span><div><strong>Recent campaigns</strong><span>Campaigns stay in this computer’s local database.</span></div></div><button className="icon-button" onClick={load} aria-label="Refresh campaigns"><LoaderCircle size={16} className={loading ? 'spin' : ''} /></button></div>
    {loading && !campaigns.length ? <div className="table-loading"><LoaderCircle className="spin" size={18} />Loading campaigns</div> : campaigns.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Campaign</th><th>Status</th><th>Recipients</th><th>Sent</th><th>Failed</th><th>Unknown</th><th>Created</th><th></th></tr></thead><tbody>{campaigns.map((campaign) => <tr key={campaign.id}><td><strong>{campaign.name}</strong><div className="subtext">{campaign.message_template.slice(0, 80)}{campaign.message_template.length > 80 ? '…' : ''}</div></td><td><StatusBadge value={campaign.status} /></td><td>{campaign.recipient_count || 0}</td><td>{campaign.sent_count || 0}</td><td>{campaign.failed_count || 0}</td><td>{campaign.unknown_count || 0}</td><td>{fmtTime(campaign.created_at)}</td><td>{['sending', 'draft'].includes(campaign.status) && <button className="text-button danger-text" onClick={() => cancel(campaign.id)}>Cancel</button>}</td></tr>)}</tbody></table></div> : <EmptyState icon={Send} title="No campaigns yet" body="Create a dry run from the Leads page to inspect personalized messages before sending." />}
    <div className="plain-note"><ShieldCheck size={16} /><span>Messages only leave the computer after a live campaign is confirmed and the paired phone claims each queued job.</span></div>
  </>;
}

function StatusBadge({ value }) {
  const status = String(value || 'draft').replaceAll('_', ' ');
  return <span className={`status-badge status-${String(value || 'draft').replaceAll('_', '-')}`}>{status}</span>;
}

function ConversationsPage({ notify }) {
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const messageRequestSequence = useRef(0);
  async function load() { setLoading(true); try { const result = await api('/conversations'); setRows(result.conversations); } catch (err) { notify('error', err.message); } finally { setLoading(false); } }
  useEffect(() => { load(); const timer = window.setInterval(load, 6000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const requestId = ++messageRequestSequence.current;
    if (!selected) { setMessages([]); return; }
    api(`/conversations/${encodeURIComponent(selected.phone)}`)
      .then((result) => { if (requestId === messageRequestSequence.current) setMessages(result.messages); })
      .catch((err) => { if (requestId === messageRequestSequence.current) notify('error', err.message); });
    return () => { if (requestId === messageRequestSequence.current) messageRequestSequence.current += 1; };
  }, [selected, notify]);
  return <>
    <div className="page-heading"><div><h1>Conversations</h1><p>Inbound replies from the paired SIM appear here. Opt-out replies suppress the number immediately.</p></div><button className="icon-button" onClick={load} aria-label="Refresh conversations"><LoaderCircle size={16} className={loading ? 'spin' : ''} /></button></div>
    <div className="conversation-layout"><div className="conversation-list">{rows.length ? rows.map((row) => <button key={row.phone} className={`conversation-row ${selected?.phone === row.phone ? 'chosen' : ''}`} onClick={() => setSelected(row)}><span className="conversation-avatar">{(row.name || row.phone).slice(0, 1).toUpperCase()}</span><span className="conversation-copy"><strong>{row.name || row.phone}</strong><small>{row.last_direction === 'inbound' ? 'Reply: ' : 'You: '}{row.last_body}</small></span><span className="conversation-meta"><time>{fmtDate(row.last_at)}</time>{row.is_suppressed ? <span className="mini-suppressed">Suppressed</span> : null}</span></button>) : <EmptyState icon={MessageCircle} title={loading ? 'Loading replies…' : 'No conversations yet'} body="Replies received on the paired phone will be stored locally and shown here." />}</div>
      <div className="conversation-detail">{selected ? <><div className="conversation-detail-head"><div><strong>{selected.name || selected.phone}</strong><span>{selected.phone} · {selected.property_address || 'No property address'}</span></div>{selected.is_suppressed && <StatusBadge value="suppressed" />}</div><div className="message-history">{messages.map((message) => <div key={message.id} className={`history-line ${message.direction}`}><div className="history-bubble">{message.body}<small>{message.direction === 'inbound' ? 'Received' : message.status} · {fmtTime(message.received_at)}</small></div></div>)}</div><div className="read-only-composer"><MessageSquareText size={16} /><span>Replies are recorded here. New messages must be sent through a reviewed campaign.</span></div></> : <div className="detail-placeholder"><MessageCircle size={24} /><strong>Select a conversation</strong><span>Choose a thread to view its message history.</span></div>}</div></div>
  </>;
}

function SuppressionPage({ notify }) {
  const [rows, setRows] = useState([]);
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('Manual do-not-contact request');
  const [loading, setLoading] = useState(true);
  const [release, setRelease] = useState(null);
  async function load() { setLoading(true); try { setRows((await api('/suppressions')).suppressions.filter((row) => !row.released_at)); } catch (err) { notify('error', err.message); } finally { setLoading(false); } }
  useEffect(() => { load(); }, []);
  async function add(event) { event.preventDefault(); try { await api('/suppressions', { method: 'POST', body: JSON.stringify({ phone, reason }) }); setPhone(''); await load(); notify('success', 'Number added to the suppression list.'); } catch (err) { notify('error', err.message); } }
  async function releaseNumber(data) { try { await api(`/suppressions/${encodeURIComponent(release.phone)}/release`, { method: 'POST', body: JSON.stringify(data) }); setRelease(null); await load(); notify('success', 'Suppression released with new consent evidence recorded.'); } catch (err) { notify('error', err.message); } }
  return <>
    <div className="page-heading"><div><h1>Suppression list</h1><p>Numbers on this list are excluded from every new campaign. STOP replies are added automatically.</p></div></div>
    <form className="suppression-form" onSubmit={add}><div><label>Phone number<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 513 555 0100" required /></label><label>Reason<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={180} required /></label></div><button className="primary-button"><Plus size={16} />Suppress number</button></form>
    {rows.length ? <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Phone</th><th>Lead</th><th>Reason</th><th>Added</th><th>Source</th><th></th></tr></thead><tbody>{rows.map((row) => <tr key={row.phone}><td className="phone-cell">{row.phone}</td><td>{row.name || '—'}</td><td>{row.reason}</td><td>{fmtDate(row.created_at)}</td><td>{row.source}</td><td><button className="text-button" onClick={() => setRelease(row)}>Release with new consent</button></td></tr>)}</tbody></table></div> : <EmptyState icon={Shield} title={loading ? 'Loading suppression list…' : 'No suppressed numbers'} body="Opt-outs from incoming SMS and manual do-not-contact requests will be recorded here." />}
    {release && <ReleaseSuppressionDialog row={release} onClose={() => setRelease(null)} onSubmit={releaseNumber} />}
  </>;
}

function ReleaseSuppressionDialog({ row, onClose, onSubmit }) {
  const [source, setSource] = useState(''); const [evidence, setEvidence] = useState(''); const [date, setDate] = useState('');
  return <Modal title="Document new consent" subtitle={`${row.phone} will be unsuppressed only after new affirmative consent is recorded.`} onClose={onClose}><div className="form-stack"><div className="warning-banner"><Shield size={16} /><span>This action is only for a later, new consent. An earlier opt-in does not undo a STOP request.</span></div><label>New consent source<input value={source} onChange={(e) => setSource(e.target.value)} placeholder="New website form, signed request…" /></label><label>New consent date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label><label>Evidence reference<textarea rows="3" value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Reference the new opt-in record" /></label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!source || !date || !evidence} onClick={() => onSubmit({ new_consent_source: source, new_consent_at: date, new_consent_evidence: evidence })}>Record and release</button></div></div></Modal>;
}

function SettingsPage({ notify }) {
  const [settings, setSettings] = useState(null);
  const [device, setDevice] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [businessName, setBusinessName] = useState('Atlas Property Buyers');
  const [dailyLimit, setDailyLimit] = useState('100');
  async function load() {
    try {
      const [nextSettings, nextDevice] = await Promise.all([api('/settings'), api('/bridge/devices')]);
      setSettings(nextSettings); setBusinessName(nextSettings.business_name); setDailyLimit(String(nextSettings.daily_send_limit)); setDevice(nextDevice.device);
    } catch (err) { notify('error', err.message); }
  }
  useEffect(() => { load(); const timer = window.setInterval(() => api('/bridge/devices').then((r) => setDevice(r.device)).catch(() => {}), 5000); return () => window.clearInterval(timer); }, []);
  async function save(event) { event.preventDefault(); setBusy(true); try { await api('/settings', { method: 'PATCH', body: JSON.stringify({ business_name: businessName, daily_send_limit: Number(dailyLimit) }) }); notify('success', 'Workspace settings saved.'); await load(); } catch (err) { notify('error', err.message); } finally { setBusy(false); } }
  async function generatePairCode() { try { setPairing(await api('/bridge/pair-code', { method: 'POST', body: '{}' })); } catch (err) { notify('error', err.message); } }
  async function unpair() { if (!device || !window.confirm(`Unpair ${device.name}? It will stop receiving campaign jobs.`)) return; try { await api(`/bridge/devices/${device.id}`, { method: 'DELETE' }); setDevice(null); setPairing(null); notify('success', 'Phone unpaired.'); } catch (err) { notify('error', err.message); } }
  return <>
    <div className="page-heading"><div><h1>Settings & phone</h1><p>Configure your business identity and pair the in-house Android SMS bridge.</p></div></div>
    <div className="settings-grid">
      <section className="settings-card"><div className="settings-title"><div className="settings-icon"><Settings size={18} /></div><div><h2>Workspace</h2><p>Message identity and local safety cap.</p></div></div><form className="form-stack" onSubmit={save}><label>Business name<input value={businessName} onChange={(e) => setBusinessName(e.target.value)} maxLength={100} required /></label><label>Maximum live sends in any 24-hour period<select value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)}>{[10, 25, 50, 75, 100].map((value) => <option key={value}>{value}</option>)}</select></label><div className="settings-hint"><ShieldCheck size={15} />This app-level cap is enforced before the phone receives jobs.</div><button className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={15} />}Save settings</button></form></section>
      <section className="settings-card phone-card"><div className="settings-title"><div className="settings-icon"><Smartphone size={18} /></div><div><h2>Android SIM bridge</h2><p>Your own phone and SIM carry each approved message.</p></div></div>
        {device ? <div className="paired-device"><div className="device-row"><div className="device-symbol"><Smartphone size={22} /></div><div><strong>{device.name}</strong><span>{device.phone_number || 'SIM number not shared'} · last seen {fmtTime(device.last_seen)}</span></div><StatusBadge value={device.connected ? 'connected' : 'offline'} /></div><div className={`bridge-state ${device.connected ? 'connected' : ''}`}><span className="green-dot" />{device.connected ? 'Connected and polling for queued messages' : 'Phone is offline. Live sending is paused.'}</div><button className="text-button danger-text" onClick={unpair}><Trash2 size={14} />Unpair phone</button></div> : <div className="pair-empty"><div className="pair-illustration"><Smartphone size={25} /><ArrowRight size={15} /><MessageSquareText size={22} /></div><strong>No phone paired</strong><p>Install the Atlas SMS Bridge app on an Android phone with an active SIM. Pair it on the same Wi-Fi network as this computer.</p><button className="primary-button" onClick={generatePairCode}><Plus size={15} />Generate pairing code</button><a href="https://github.com/coopermsick-67/atlas-sms/tree/main/android" target="_blank" rel="noreferrer" className="download-link">View Android bridge setup <ArrowRight size={13} /></a></div>}
        {pairing && <div className="pair-code-box"><div><span>ONE-TIME PAIR CODE</span><strong className="pair-code">{pairing.code}</strong><small>Expires in 5 minutes · enter it in your Atlas SMS Bridge app</small></div><div className="server-address"><span>COMPUTER ADDRESS</span><code>{pairing.server_url}</code><button className="icon-button small" onClick={() => navigator.clipboard?.writeText(pairing.server_url)} aria-label="Copy server address"><Clipboard size={14} /></button></div><button className="text-button" onClick={() => setPairing(null)}>Close</button></div>}
        <div className="carrier-note"><AlertCircle size={15} /><span>SMS requires an active SIM, carrier service, and Android SMS permission. Carrier plan limits and terms apply. The phone needs to remain online during a live campaign.</span></div>
      </section>
      <section className="settings-card full-span"><div className="settings-title"><div className="settings-icon"><LockKeyhole size={18} /></div><div><h2>Local data and access</h2><p>Lead records, message history, campaign logs, and suppression entries are stored in the app’s SQLite database on this computer.</p></div></div><div className="local-security-list"><div><CheckCircle2 size={16} /><span>Workspace password required on this computer</span></div><div><CheckCircle2 size={16} /><span>Android bridge pairs with a one-time, expiring code</span></div><div><CheckCircle2 size={16} /><span>Only a token hash is stored by the computer</span></div><div><CheckCircle2 size={16} /><span>No SMS provider account or external CRM connection</span></div></div></section>
    </div>
  </>;
}

function EmptyState({ icon: Icon, title, body }) { return <div className="empty-state compact"><div className="empty-icon"><Icon size={21} /></div><h2>{title}</h2><p>{body}</p></div>; }
function InlineError({ children }) { return <div className="inline-error"><AlertCircle size={15} />{children}</div>; }

function Modal({ title, subtitle, children, onClose, wide = false }) {
  const titleId = useId();
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement;
    const panel = panelRef.current;
    const focusable = () => [...(panel?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    (panel?.querySelector('[autofocus]') || focusable()[0] || panel)?.focus();
    function onKey(event) {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); panel?.focus(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
    }
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); if (previousFocus instanceof HTMLElement) previousFocus.focus(); };
  }, []);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) closeRef.current(); }}><section ref={panelRef} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><header className="modal-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={() => closeRef.current()} aria-label="Close dialog"><X size={18} /></button></header>{children}</section></div>;
}

function ConfirmDialog({ title, body, confirmLabel, onCancel, onConfirm }) {
  return <Modal title={title} subtitle={body} onClose={onCancel}><div className="modal-actions"><button className="secondary-button" onClick={onCancel}>Cancel</button><button className="primary-button" onClick={onConfirm}><LogOut size={15} />{confirmLabel}</button></div></Modal>;
}

export default App;
