import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Archive, FileText, Mic, RefreshCw, Save } from 'lucide-react';
import { DictationButton } from '../components/DictationButton';
import healthRecordsNurseStationBg from '../assets/health-records-nurse-station-bg.png';
import {
  dateNDaysAgo, healthDataApi, type HealthMedicalRecord,
} from '../lib/healthData';

const today = () => new Date().toISOString().slice(0, 10);
const CATEGORIES = [
  'condition', 'vitals', 'medication', 'allergy', 'immunization',
  'encounter', 'lab', 'procedure', 'facility', 'demographic', 'note',
];

function label(text: string): string {
  return text.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

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
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function HealthMedicalRecords() {
  const [records, setRecords] = useState<HealthMedicalRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState('condition');
  const [lastSpokenAt, setLastSpokenAt] = useState<string | null>(null);
  const [form, setForm] = useState({
    record_date: today(),
    title: '',
    provider: '',
    facility: '',
    source: 'VA Blue Button',
    archive_only: true,
    notes: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await healthDataApi.medicalRecords(dateNDaysAgo(3650), today(), 300);
      setRecords(result.records);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const grouped = useMemo(() => {
    const out = new Map<string, HealthMedicalRecord[]>();
    for (const record of records) {
      const bucket = out.get(record.category) ?? [];
      bucket.push(record);
      out.set(record.category, bucket);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [records]);

  const onTranscript = useCallback((text: string) => {
    setForm((cur) => ({ ...cur, notes: appendTranscript(cur.notes, text) }));
    setLastSpokenAt(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
  }, []);

  async function submit() {
    if (!form.title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await healthDataApi.createMedicalRecord({
        record_date: form.record_date,
        category,
        title: form.title.trim(),
        provider: form.provider.trim() || null,
        facility: form.facility.trim() || null,
        source: form.source.trim() || null,
        archive_only: form.archive_only,
        notes: form.notes.trim() || null,
      });
      setForm((cur) => ({ ...cur, title: '', notes: '' }));
      setLastSpokenAt(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const sceneStyle = {
    '--health-room-image': `url(${healthRecordsNurseStationBg})`,
  } as CSSProperties;

  return (
    <div className="health-room-page health-records-room" style={sceneStyle}>
      <div className="health-room-shell">
        <header className="health-room-topbar">
          <div>
            <div className="health-room-kicker">Medical Records</div>
            <h1>Nurse station archive</h1>
          </div>
          <nav className="health-room-nav" aria-label="Health records navigation">
            <Link className="health-room-button" to="/health">
              <Activity size={15} /> Health
            </Link>
            <Link className="health-room-button" to="/health/journal">
              <FileText size={15} /> Journal
            </Link>
            <button className="health-room-icon" onClick={() => void load()} aria-label="Refresh">
              <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            </button>
          </nav>
        </header>

        <main className="health-room-stage health-records-stage">
          <div className="health-nurse-station" aria-hidden />

          <section className="health-record-intake" aria-label="Medical record intake">
            <div className="health-note-header">
              <div>
                <div className="health-note-label"><Archive size={16} /> Chart intake</div>
                <div className="health-note-subtitle">Archive and reference material</div>
              </div>
              <label className="health-room-archive-toggle">
                <input
                  type="checkbox"
                  checked={form.archive_only}
                  onChange={(e) => setForm({ ...form, archive_only: e.target.checked })}
                />
                Archive
              </label>
            </div>

            <div className="health-room-grid">
              <label className="health-room-field">
                <span>Date</span>
                <input
                  type="date"
                  value={form.record_date}
                  onChange={(e) => setForm({ ...form, record_date: e.target.value })}
                />
              </label>
              <label className="health-room-field">
                <span>Category</span>
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}
                </select>
              </label>
            </div>

            <label className="health-room-field">
              <span>Title</span>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </label>

            <div className="health-room-grid">
              <label className="health-room-field">
                <span>Provider</span>
                <input
                  value={form.provider}
                  onChange={(e) => setForm({ ...form, provider: e.target.value })}
                />
              </label>
              <label className="health-room-field">
                <span>Facility</span>
                <input
                  value={form.facility}
                  onChange={(e) => setForm({ ...form, facility: e.target.value })}
                />
              </label>
            </div>

            <label className="health-room-field">
              <span>Source</span>
              <input
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
              />
            </label>

            <div className="health-record-dictation-row">
              <DictationButton
                compact={false}
                className="health-records-dictation"
                title="Speak record note"
                disabled={saving}
                onTranscript={onTranscript}
              />
              <div>
                <div className="health-dictation-title"><Mic size={16} /> Voice note</div>
                <div className="health-dictation-status">
                  {lastSpokenAt ? `Last speech ${lastSpokenAt}` : 'Ready for voice'}
                </div>
              </div>
            </div>

            <label className="health-room-field health-transcript-field">
              <span>Notes</span>
              <textarea
                value={form.notes}
                placeholder="Record note"
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
              />
            </label>

            {error && <div className="health-room-alert">{error}</div>}

            <button
              className="health-room-primary"
              disabled={saving || !form.title.trim()}
              onClick={() => void submit()}
            >
              <Save size={16} /> {saving ? 'Saving' : 'Save record'}
            </button>
          </section>

          <section className="health-record-archive" aria-label="Medical record archive">
            <div className="health-note-header">
              <div>
                <div className="health-note-label"><FileText size={16} /> Chart rack</div>
                <div className="health-note-subtitle">{records.length} records on file</div>
              </div>
            </div>

            <div className="health-record-groups">
              {grouped.map(([group, items]) => (
                <section key={group} className="health-record-group">
                  <div className="health-record-group-title">{label(group)}</div>
                  <div className="health-side-list">
                    {items.map((record) => (
                      <article key={record.id} className="health-side-item">
                        <div className="health-side-item-head">
                          <span>{record.title}</span>
                          <b>{shortDate(record.record_date)}</b>
                        </div>
                        <div className="health-record-meta">
                          {record.provider && <span>{record.provider}</span>}
                          {record.facility && <span>{record.facility}</span>}
                          {record.source && <span>{record.source}</span>}
                          {record.archive_only && <span>Archive</span>}
                        </div>
                        {record.notes && <p>{record.notes}</p>}
                      </article>
                    ))}
                  </div>
                </section>
              ))}
              {!loading && grouped.length === 0 && (
                <div className="health-empty-room">No medical records</div>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
