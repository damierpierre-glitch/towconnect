'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { useToast } from '@/components/ToastProvider';
import { Card, StatCard } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Textarea } from '@/components/ui/Field';
import {
  approveDriver,
  getDriverDocumentSignedUrl,
  listPendingDriverDocuments,
  rejectDriver,
  reviewDriverDocument,
  type PendingDriverDocument,
} from '@/lib/actions/admin';
import { driverDocumentLabel, problemLabel, VEHICLE_TYPE_LABEL } from '@/lib/constants';
import { toMoney } from '@/lib/pricing';
import type { TowRequest } from '@/lib/supabase/types';

interface PendingDriver {
  profile_id: string;
  vehicle_type: string;
  province: string;
  name: string;
  created_at: string;
}

export function AdminDashboard() {
  const { t, lang } = useLanguage();
  const { showToast } = useToast();
  const [activeDrivers, setActiveDrivers] = useState(0);
  const [provinceCounts, setProvinceCounts] = useState<{ province: string; count: number }[]>([]);
  const [liveRequests, setLiveRequests] = useState<TowRequest[]>([]);
  const [pendingDrivers, setPendingDrivers] = useState<PendingDriver[]>([]);
  const [pendingDocuments, setPendingDocuments] = useState<PendingDriverDocument[]>([]);
  const [requestsToday, setRequestsToday] = useState(0);
  const [revenue, setRevenue] = useState(0);
  const [avgMinutes, setAvgMinutes] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [reasonBoxId, setReasonBoxId] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState('');

  useEffect(() => {
    const supabase = createClient();

    async function loadAll() {
      const [driversRes, requestsRes, pendingRes, eventsRes, pendingDocsRes] = await Promise.all([
        supabase.from('driver_profiles').select('province, is_online, approval_status'),
        supabase.from('requests').select('*').order('created_at', { ascending: false }).limit(200),
        supabase
          .from('driver_profiles')
          .select('profile_id, vehicle_type, province, updated_at, profiles(full_name)')
          .eq('approval_status', 'pending'),
        supabase
          .from('request_events')
          .select('request_id, status, created_at')
          .in('status', ['pending', 'matched'])
          .order('created_at', { ascending: true })
          .limit(1000),
        listPendingDriverDocuments(),
      ]);
      setPendingDocuments(pendingDocsRes);

      const drivers = driversRes.data ?? [];
      setActiveDrivers(drivers.filter((d) => d.is_online && d.approval_status === 'approved').length);

      const counts = new Map<string, number>();
      for (const d of drivers) {
        if (!d.province) continue;
        counts.set(d.province, (counts.get(d.province) ?? 0) + 1);
      }
      setProvinceCounts(
        [...counts.entries()].map(([province, count]) => ({ province, count })).sort((a, b) => b.count - a.count)
      );

      const requests = requestsRes.data ?? [];
      const today = new Date().toDateString();
      setRequestsToday(requests.filter((r) => new Date(r.created_at).toDateString() === today).length);
      setLiveRequests(requests.filter((r) => ['pending', 'matched', 'en_route', 'arrived', 'in_progress'].includes(r.status)));
      setRevenue(
        requests.filter((r) => r.status === 'completed').reduce((sum, r) => sum + toMoney(r.price_estimate), 0)
      );

      const events = eventsRes.data ?? [];
      const byRequest = new Map<string, { pending?: string; matched?: string }>();
      for (const e of events) {
        const entry = byRequest.get(e.request_id) ?? {};
        if (e.status === 'pending' && !entry.pending) entry.pending = e.created_at;
        if (e.status === 'matched' && !entry.matched) entry.matched = e.created_at;
        byRequest.set(e.request_id, entry);
      }
      const diffs = [...byRequest.values()]
        .filter((v) => v.pending && v.matched)
        .map((v) => (new Date(v.matched!).getTime() - new Date(v.pending!).getTime()) / 60000);
      setAvgMinutes(diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null);

      setPendingDrivers(
        (pendingRes.data ?? []).map((d) => {
          const profile = Array.isArray(d.profiles) ? d.profiles[0] : d.profiles;
          return {
            profile_id: d.profile_id,
            vehicle_type: d.vehicle_type,
            province: d.province,
            name: profile?.full_name || '—',
            created_at: d.updated_at,
          };
        })
      );

      setLoading(false);
    }

    loadAll();

    const channel = supabase
      .channel('admin-dashboard')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_profiles' }, loadAll)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_documents' }, loadAll)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function handleApprove(id: string) {
    try {
      await approveDriver(id);
      setPendingDrivers((prev) => prev.filter((d) => d.profile_id !== id));
      showToast('✅', lang === 'fr' ? 'Remorqueur approuvé!' : 'Driver approved!');
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  function startReject(id: string) {
    setReasonBoxId(id);
    setReasonText('');
  }

  async function confirmReject(id: string) {
    try {
      await rejectDriver(id, reasonText);
      setPendingDrivers((prev) => prev.filter((d) => d.profile_id !== id));
      setReasonBoxId(null);
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  async function handleReviewDocument(documentId: string, status: 'approved' | 'rejected', reason?: string) {
    try {
      await reviewDriverDocument(documentId, status, reason);
      setPendingDocuments((prev) => prev.filter((d) => d.id !== documentId));
      showToast(status === 'approved' ? '✅' : '❌', lang === 'fr' ? 'Document mis à jour.' : 'Document updated.');
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  async function handleViewDocument(storagePath: string) {
    try {
      const url = await getDriverDocumentSignedUrl(storagePath);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      showToast('⚠️', t('error_generic'));
    }
  }

  const maxCount = Math.max(1, ...provinceCounts.map((p) => p.count));

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="flex justify-between items-center mb-6 flex-wrap gap-3">
        <div>
          <h2 className="font-display text-2xl font-bold">{t('admin_title')}</h2>
          <p className="text-text-2 text-sm mt-1">{t('admin_sub')}</p>
        </div>
        <Badge tone="green">{lang === 'fr' ? 'Données en direct' : 'Live data'}</Badge>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatCard label={t('adm_drivers_active')} value={String(activeDrivers)} />
        <StatCard label={t('adm_requests_today')} value={String(requestsToday)} />
        <StatCard label={t('adm_avg_time')} value={avgMinutes ? `${avgMinutes.toFixed(1)} min` : '—'} />
        <StatCard label={t('adm_revenue')} value={`$${revenue.toFixed(0)}`} />
      </div>

      <div className="grid md:grid-cols-2 gap-4 mb-6">
        <Card>
          <h3 className="font-display text-base font-bold mb-4">{t('admin_prov_title')}</h3>
          {provinceCounts.length === 0 ? (
            <p className="text-sm text-muted">—</p>
          ) : (
            <div className="flex flex-col gap-3.5">
              {provinceCounts.map((p) => (
                <div key={p.province}>
                  <div className="flex justify-between text-sm mb-1">
                    <span>{p.province}</span>
                    <span className="text-muted">{p.count}</span>
                  </div>
                  <div className="h-1.5 bg-steel rounded-full overflow-hidden">
                    <div
                      className="h-full bg-orange rounded-full"
                      style={{ width: `${(p.count / maxCount) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <h3 className="font-display text-base font-bold mb-4">{t('admin_live_title')}</h3>
          {liveRequests.length === 0 ? (
            <p className="text-sm text-muted">{t('no_pending_requests')}</p>
          ) : (
            <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
              {liveRequests.map((r) => (
                <div key={r.id} className="bg-night-3 border border-steel rounded-lg px-3.5 py-2.5 flex justify-between items-center gap-2">
                  <div>
                    <div className="text-sm font-medium">{problemLabel(r.problem_type, lang)}</div>
                    <div className="text-xs text-muted">{r.location_text}</div>
                  </div>
                  <Badge tone={r.status === 'pending' ? 'yellow' : 'orange'}>{r.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="mb-6">
        <h3 className="font-display text-base font-bold mb-4">{t('admin_pending_title')}</h3>
        {loading ? (
          <p className="text-sm text-muted">…</p>
        ) : pendingDrivers.length === 0 ? (
          <p className="text-sm text-muted">—</p>
        ) : (
          <div className="flex flex-col gap-2">
            {pendingDrivers.map((d) => (
              <div key={d.profile_id} className="bg-night-3 border border-steel rounded-lg px-3.5 py-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-medium text-sm">{d.name}</div>
                    <div className="text-xs text-text-2 mt-0.5">
                      🍁 {d.province} · {VEHICLE_TYPE_LABEL[d.vehicle_type] ?? d.vehicle_type}
                    </div>
                  </div>
                  {reasonBoxId !== d.profile_id ? (
                    <div className="flex gap-2">
                      <Button variant="green" className="!px-3 !py-1.5 text-xs" onClick={() => handleApprove(d.profile_id)}>
                        ✓ {t('btn_approve')}
                      </Button>
                      <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={() => startReject(d.profile_id)}>
                        ✕ {t('btn_reject')}
                      </Button>
                    </div>
                  ) : null}
                </div>
                {reasonBoxId === d.profile_id ? (
                  <div className="mt-3 flex flex-col gap-2">
                    <Textarea
                      placeholder={lang === 'fr' ? 'Motif du rejet (visible par le remorqueur)…' : 'Rejection reason (visible to the driver)…'}
                      value={reasonText}
                      onChange={(e) => setReasonText(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={() => setReasonBoxId(null)}>
                        {lang === 'fr' ? 'Annuler' : 'Cancel'}
                      </Button>
                      <Button variant="red" className="!px-3 !py-1.5 text-xs" onClick={() => confirmReject(d.profile_id)}>
                        {lang === 'fr' ? 'Confirmer le rejet' : 'Confirm rejection'}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h3 className="font-display text-base font-bold mb-1">{lang === 'fr' ? 'Documents en attente' : 'Pending documents'}</h3>
        <p className="text-xs text-text-2 mb-4">
          {lang === 'fr'
            ? "Chaque document est examiné indépendamment — approuver ou rejeter un document ne change pas le statut du compte."
            : "Each document is reviewed independently — approving or rejecting one doesn't change the account's own status."}
        </p>
        {loading ? (
          <p className="text-sm text-muted">…</p>
        ) : pendingDocuments.length === 0 ? (
          <p className="text-sm text-muted">—</p>
        ) : (
          <div className="flex flex-col gap-2">
            {pendingDocuments.map((doc) => (
              <PendingDocumentRow key={doc.id} doc={doc} onView={handleViewDocument} onReview={handleReviewDocument} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function PendingDocumentRow({
  doc,
  onView,
  onReview,
}: {
  doc: PendingDriverDocument;
  onView: (storagePath: string) => void;
  onReview: (documentId: string, status: 'approved' | 'rejected', reason?: string) => void;
}) {
  const { lang } = useLanguage();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <div className="bg-night-3 border border-steel rounded-lg px-3.5 py-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="font-medium text-sm">{doc.driverName}</div>
          <div className="text-xs text-text-2 mt-0.5">
            {driverDocumentLabel(doc.type, lang)} · {new Date(doc.uploaded_at).toLocaleDateString(lang === 'fr' ? 'fr-CA' : 'en-CA')}
          </div>
        </div>
        {!rejecting ? (
          <div className="flex gap-2">
            <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={() => onView(doc.storage_path)}>
              👁️ {lang === 'fr' ? 'Voir' : 'View'}
            </Button>
            <Button variant="green" className="!px-3 !py-1.5 text-xs" onClick={() => onReview(doc.id, 'approved')}>
              ✓ {lang === 'fr' ? 'Approuver' : 'Approve'}
            </Button>
            <Button variant="red" className="!px-3 !py-1.5 text-xs" onClick={() => setRejecting(true)}>
              ✕ {lang === 'fr' ? 'Rejeter' : 'Reject'}
            </Button>
          </div>
        ) : null}
      </div>
      {rejecting ? (
        <div className="mt-3 flex flex-col gap-2">
          <Textarea
            placeholder={lang === 'fr' ? 'Motif du rejet (visible par le remorqueur)…' : 'Rejection reason (visible to the driver)…'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="secondary" className="!px-3 !py-1.5 text-xs" onClick={() => setRejecting(false)}>
              {lang === 'fr' ? 'Annuler' : 'Cancel'}
            </Button>
            <Button variant="red" className="!px-3 !py-1.5 text-xs" onClick={() => onReview(doc.id, 'rejected', reason)}>
              {lang === 'fr' ? 'Confirmer le rejet' : 'Confirm rejection'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
