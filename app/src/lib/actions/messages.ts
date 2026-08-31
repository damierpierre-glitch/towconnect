'use server';

import { createClient } from '@/lib/supabase/server';
import type { Message } from '@/lib/supabase/types';

// No revalidatePath here on purpose: messages are rendered entirely through
// the client's own Realtime subscription (see components/Chat.tsx), not
// through a server-rendered page — there is nothing server-cached to bust.
export async function sendMessage(input: {
  requestId: string;
  body?: string;
  templateKey?: string;
}): Promise<Message> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const body = input.body?.trim();
  if (!body && !input.templateKey) throw new Error('Message must have text or a template');

  const { data, error } = await supabase
    .from('messages')
    .insert({
      request_id: input.requestId,
      sender_id: user.id,
      body: body || null,
      template_key: input.templateKey || null,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}
