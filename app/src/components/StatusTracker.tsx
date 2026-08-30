import type { RequestStatus } from '@/lib/supabase/types';

const ORDER: RequestStatus[] = ['pending', 'matched', 'en_route', 'arrived', 'completed'];

const ICONS: Record<RequestStatus, string> = {
  pending: '✅',
  matched: '✅',
  en_route: '🚛',
  arrived: '📍',
  completed: '🎉',
  cancelled: '❌',
};

export function StatusTracker({
  current,
  labels,
}: {
  current: RequestStatus;
  labels: Record<RequestStatus, string>;
}) {
  const currentIndex = ORDER.indexOf(current);

  return (
    <div className="flex flex-col">
      {ORDER.map((status, i) => {
        const done = i < currentIndex || current === 'completed';
        const active = i === currentIndex && current !== 'completed';
        return (
          <div key={status} className="flex gap-3.5">
            <div className="flex flex-col items-center">
              <div
                className={`w-3.5 h-3.5 rounded-full mt-1 shrink-0 ${
                  done || active ? 'bg-orange' : 'bg-steel'
                } ${active ? 'shadow-[0_0_0_4px_rgba(255,92,26,0.25)]' : ''}`}
              />
              {i < ORDER.length - 1 ? (
                <div className={`w-0.5 flex-1 min-h-7 my-1 ${done ? 'bg-orange' : 'bg-steel'}`} />
              ) : null}
            </div>
            <div className="pb-5">
              <div className="font-semibold text-sm">
                {done || active ? ICONS[status] : '⏳'} {labels[status]}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
