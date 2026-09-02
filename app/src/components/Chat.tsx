'use client';

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useLanguage } from '@/lib/i18n/LanguageProvider';
import { sendMessage } from '@/lib/actions/messages';
import { resolveMessageText, type QuickMessage } from '@/lib/constants';
import type { Message } from '@/lib/supabase/types';

// Reused as-is by both the rider's StepTracking and the driver's dashboard —
// same data model, same RLS, same realtime channel; only which quick
// messages are offered differs per role.
export function Chat({
  requestId,
  currentUserId,
  quickMessages,
}: {
  requestId: string;
  currentUserId: string;
  quickMessages: QuickMessage[];
}) {
  const { t, lang } = useLanguage();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendFailed, setSendFailed] = useState(false);
  const seenIds = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  function appendIfNew(message: Message) {
    if (seenIds.current.has(message.id)) return;
    seenIds.current.add(message.id);
    setMessages((prev) => [...prev, message]);
  }

  useEffect(() => {
    const supabase = createClient();

    async function loadAll() {
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('request_id', requestId)
        .order('created_at', { ascending: true });
      if (data) {
        seenIds.current = new Set(data.map((m) => m.id));
        setMessages(data);
      }
    }

    // Re-fetching on every (re)subscribe — not just once on mount — is what
    // makes this resilient to a dropped connection: the Realtime client
    // reconnects and re-fires this callback with 'SUBSCRIBED' on its own,
    // and this re-syncs whatever arrived while it was disconnected.
    const channel = supabase
      .channel(`messages-${requestId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `request_id=eq.${requestId}` },
        (payload) => appendIfNew(payload.new as Message)
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') loadAll();
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [requestId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function doSend(input: { body?: string; templateKey?: string }) {
    setSending(true);
    setSendFailed(false);
    try {
      const created = await sendMessage({ requestId, ...input });
      appendIfNew(created);
      setText('');
    } catch {
      setSendFailed(true);
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    doSend({ body: trimmed });
  }

  return (
    <div className="flex flex-col bg-night-3 border border-steel rounded-xl overflow-hidden">
      <div ref={listRef} className="flex flex-col gap-2 p-3 max-h-56 overflow-y-auto">
        {messages.length === 0 ? (
          <p className="text-xs text-muted text-center py-3">{t('chat_empty')}</p>
        ) : (
          messages.map((m) => {
            const mine = m.sender_id === currentUserId;
            return (
              <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-2xl text-sm ${
                    mine ? 'bg-orange-dark text-white rounded-br-sm' : 'bg-night-4 text-text rounded-bl-sm'
                  }`}
                >
                  {resolveMessageText(m, lang)}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="flex gap-1.5 px-3 py-2 overflow-x-auto border-t border-steel/60">
        {quickMessages.map((q) => (
          <button
            key={q.key}
            type="button"
            disabled={sending}
            onClick={() => doSend({ templateKey: q.key })}
            className="shrink-0 px-3 py-1.5 rounded-full border border-steel text-xs text-text-2 hover:border-orange hover:text-orange transition-colors disabled:opacity-50"
          >
            {lang === 'fr' ? q.fr : q.en}
          </button>
        ))}
      </div>

      {sendFailed ? (
        <div role="alert" className="flex items-center justify-between px-3 py-2 bg-red/10 text-red text-xs">
          <span>{t('chat_send_failed')}</span>
          <button type="button" className="font-semibold underline" onClick={() => doSend({ body: text.trim() })}>
            {t('chat_retry')}
          </button>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} className="flex gap-2 p-3 border-t border-steel/60">
        <label htmlFor="chat-message" className="sr-only">
          {t('chat_placeholder')}
        </label>
        <input
          id="chat-message"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('chat_placeholder')}
          disabled={sending}
          className="flex-1 px-3.5 py-2.5 bg-night-4 border border-steel rounded-xl text-sm outline-none focus:border-orange disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={sending || !text.trim()}
          className="px-4 py-2.5 rounded-xl bg-orange-dark text-white text-sm font-semibold disabled:opacity-50"
        >
          {sending ? '…' : t('chat_send')}
        </button>
      </form>
    </div>
  );
}
