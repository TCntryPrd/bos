import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, BookOpen, FileText, Mic, RefreshCw, Save, ShieldAlert } from 'lucide-react';
import { DictationButton } from '../components/DictationButton';
import healthJournalDoctorOfficeBg from '../assets/health-journal-doctor-office-bg.png';
import {
  dateNDaysAgo, healthDataApi, type HealthAnomaly, type HealthJournalEntry,
} from '../lib/healthData';

const today = () => new Date().toISOString().slice(0, 10);

function appendTranscript(current: string, incoming: string): string {
  const clean = incoming.trim();
  if (!clean) return current;
  if (!current.trim()) return clean;
  return `${current.trimEnd()}\n\n${clean}`;
}

function shortDate(value: string | null | undefined): string {
  if (!value) return '-';
  const d = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function HealthJournal() {
  const [entries, setEntries] = useState<HealthJournalEntry[]>([]);
  const [anomalies, setAnomalies] = useState<HealthAnomaly[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSpokenAt, setLastSpokenAt] = useState<string | null>(null);
  const [form, setForm] = useState({
    entry_date: today(),
    title: '',
    body: '',
    mood: '',
    energy: '',
    soreness: '',
    sleep_quality: '',
    tags: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const from = dateNDaysAgo(45);
      const to = today();
      const [journal, flags] = await Promise.all([
        healthDataApi.journal(from, to, 100),
        healthDataApi.anomalies(from, to, 'open', 50),
      ]);
      setEntries(journal.entries);
      setAnomalies(flags.anomalies);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const recentEntries = useMemo(() => entries.slice(0, 5), [entries]);
  const watchList = useMemo(() => anomalies.slice(0, 4), [anomalies]);

  const onTranscript = useCallback((text: string) => {
    setForm((cur) => ({ ...cur, body: appendTranscript(cur.body, text) }));
    setLastSpokenAt(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  }, []);

  async function submit() {
    if (!form.body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await healthDataApi.createJournal({
        entry_date: form.entry_date,
        title: form.title.trim() || null,
        body: form.body.trim(),
        mood: form.mood.trim() || null,
        energy: form.energy ? Number(form.energy) : null,
        soreness: form.soreness ? Number(form.soreness) : null,
        sleep_quality: form.sleep_quality ? Number(form.sleep_quality) : null,
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
      });
      setForm((cur) => ({ ...cur, title: '', body: '', tags: '' }));
      setLastSpokenAt(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const sceneStyle = {
    '--health-room-image': `url(${healthJournalDoctorOfficeBg})`,
  } as CSSProperties;

  return (
    <div className="health-room-page health-journal-room" style={sceneStyle}>
      <div className="health-room-shell">
        <header className="health-room-topbar">
          <div>
            <div className="health-room-kicker">Health Journal</div>
            <h1>Spoken clinical note</h1>
          </div>
          <nav className="health-room-nav" aria-label="Health journal navigation">
            <Link className="health-room-button" to="/health">
              <Activity size={15} /> Health
            </Link>
            <Link className="health-room-button" to="/health/records">
              <FileText size={15} /> Records
            </Link>
            <button className="health-room-icon" onClick={() => void load()} aria-label="Refresh">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
          </nav>
        </header>

        <main className="health-room-stage health-journal-stage">
          <div className="health-over-shoulder" aria-hidden />

          <section className="health-clinical-note" aria-label="Spoken journal entry">
            <div className="health-note-header">
              <div>
                <div className="health-note-label"><BookOpen size={16} /> Doctor note</div>
                <div className="health-note-subtitle">BOS health intake</div>
              </div>
              <label className="health-room-field health-room-date">
                <span>Date</span>
                <input
                  type="date"
                  value={form.entry_date}
                  onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
                />
              </label>
            </div>

            <div className="health-dictation-pad">
              <div className="health-mic-orbit">
                <DictationButton
                  compact={false}
                  className="health-journal-dictation"
                  title="Speak journal entry"
                  disabled={saving}
                  onTranscript={onTranscript}
                />
              </div>
              <div className="health-dictation-copy">
                <div className="health-dictation-title"><Mic size={16} /> Voice intake</div>
                <div className="health-dictation-status">
                  {lastSpokenAt ? `Last speech ${lastSpokenAt}` : 'Ready for voice'}
                </div>
              </div>
            </div>

            <label className="health-room-field health-transcript-field">
              <span>Transcript</span>
              <textarea
                value={form.body}
                placeholder="Clinical note transcript"
                onChange={(e) => setForm({ ...form, body: e.target.value })}
              />
            </label>

            <div className="health-room-grid">
              <label className="health-room-field">
                <span>Title</span>
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </label>
              <label className="health-room-field">
                <span>Mood</span>
                <input
                  value={form.mood}
                  onChange={(e) => setForm({ ...form, mood: e.target.value })}
                />
              </label>
              <label className="health-room-field">
                <span>Tags</span>
                <input
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                />
              </label>
            </div>

            <div className="health-room-scores">
              {(['energy', 'soreness', 'sleep_quality'] as const).map((key) => (
                <label key={key} className="health-room-field">
                  <span>{key.replace('_', ' ')}</span>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={form[key]}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                  />
                </label>
              ))}
            </div>

            {error && <div className="health-room-alert">{error}</div>}

            <button
              className="health-room-primary"
              disabled={saving || !form.body.trim()}
              onClick={() => void submit()}
            >
              <Save size={16} /> {saving ? 'Saving' : 'Save note'}
            </button>
          </section>

          <aside className="health-room-side" aria-label="Journal support panels">
            <section className="health-side-panel">
              <div className="health-side-title">
                <ShieldAlert size={16} /> Watch list
              </div>
              <div className="health-side-list">
                {watchList.map((a) => (
                  <article key={a.id} className="health-side-item">
                    <div className="health-side-item-head">
                      <span>{a.summary}</span>
                      <b>{a.severity}</b>
                    </div>
                    <p>{shortDate(a.day)} | {a.metric} | {a.value ?? '-'}</p>
                  </article>
                ))}
                {!loading && watchList.length === 0 && (
                  <div className="health-empty-room">No open findings</div>
                )}
              </div>
            </section>

            <section className="health-side-panel">
              <div className="health-side-title">
                <BookOpen size={16} /> Recent notes
              </div>
              <div className="health-side-list">
                {recentEntries.map((entry) => (
                  <article key={entry.id} className="health-side-item">
                    <div className="health-side-item-head">
                      <span>{entry.title || shortDate(entry.entry_date)}</span>
                      <b>{shortDate(entry.entry_date)}</b>
                    </div>
                    <p>{entry.body}</p>
                    {(entry.mood || entry.tags.length > 0) && (
                      <div className="health-room-tags">
                        {entry.mood && <span>{entry.mood}</span>}
                        {entry.tags.slice(0, 4).map((tag) => <span key={tag}>{tag}</span>)}
                      </div>
                    )}
                  </article>
                ))}
                {!loading && recentEntries.length === 0 && (
                  <div className="health-empty-room">No journal entries</div>
                )}
              </div>
            </section>
          </aside>
        </main>
      </div>
    </div>
  );
}
