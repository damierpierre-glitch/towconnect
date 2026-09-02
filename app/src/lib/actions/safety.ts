'use server';

import { randomBytes, createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import type { SafetyLink, SafetyLinkView, TrustedContact } from '@/lib/supabase/types';

// Safety Link — letting somebody watch a rescue without giving them an account.
//
// THE TOKEN IS A BEARER CREDENTIAL, SO IT IS NEVER STORED
// Only its SHA-256 lands in the database. The plaintext exists exactly once,
// in the response to the person who created it, and after that TowConnect
// cannot reproduce it — which is the point: reading the table must not be the
// same as holding every live link.
//
// requests.id is deliberately NOT the secret. It appears in admin URLs, in
// support tickets and in logs, and a share link built on it would make every
// one of those places a leak.

/** 32 random bytes. Not a UUID, not a counter, not derived from anything. */
function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}

async function thresholdSeconds(key: string, fallback: number): Promise<number> {
  const admin = createAdminClient();
  const { data } = await admin.from('ops_thresholds').select('value_seconds').eq('key', key).maybeSingle();
  return data?.value_seconds ?? fallback;
}

export interface CreatedSafetyLink {
  id: string;
  /** The only time this value is ever produced. It is not stored anywhere. */
  token: string;
  expiresAt: string;
}

/**
 * Create (or replace) the live Safety Link for one of the caller's own jobs.
 *
 * Regenerating revokes the previous link first — a unique index enforces one
 * live link per journey, so a link somebody was given cannot keep working
 * quietly beside a newer one.
 */
export async function createSafetyLink(requestId: string): Promise<CreatedSafetyLink> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // RLS would refuse anyway; this turns a silent empty result into a sentence.
  const { data: request } = await supabase
    .from('requests')
    .select('id, user_id, status')
    .eq('id', requestId)
    .maybeSingle();
  if (!request || request.user_id !== user.id) {
    throw new Error('You can only share your own rescue.');
  }

  const admin = createAdminClient();
  await admin
    .from('safety_links')
    .update({ revoked_at: new Date().toISOString(), revoked_by: user.id })
    .eq('request_id', requestId)
    .is('revoked_at', null);

  const lifetime = await thresholdSeconds('safety_link_lifetime', 21_600);
  const { token, hash } = mintToken();
  const expiresAt = new Date(Date.now() + lifetime * 1000).toISOString();

  const { data: link, error } = await admin
    .from('safety_links')
    .insert({
      request_id: requestId,
      token_hash: hash,
      created_by: user.id,
      expires_at: expiresAt,
    })
    .select('id')
    .single();
  if (error) throw error;

  revalidatePath('/request');
  return { id: link.id, token, expiresAt };
}

export async function revokeSafetyLink(requestId: string): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // Through the caller's own session, so RLS decides whether this is theirs.
  const { error } = await supabase
    .from('safety_links')
    .update({ revoked_at: new Date().toISOString(), revoked_by: user.id })
    .eq('request_id', requestId)
    .is('revoked_at', null);
  if (error) throw error;
  revalidatePath('/request');
}

/**
 * What the customer sees about their own link. Never the token: it cannot be
 * shown again, because it was never kept.
 */
export async function getSafetyLinkStatus(requestId: string): Promise<SafetyLink | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('safety_links')
    .select('*')
    .eq('request_id', requestId)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  // Expired links are not "live" from the customer's point of view even though
  // they are not revoked, so say so rather than showing a link that is dead.
  return new Date(data.expires_at).getTime() > Date.now() ? data : null;
}

/**
 * Resolve a token for the public page.
 *
 * Runs anonymously on purpose — the recipient has no account. Everything it
 * can return is listed in safety_link_view() (0046); nothing else is
 * reachable, because nothing else is selected.
 */
export async function viewSafetyLink(token: string): Promise<SafetyLinkView | null> {
  if (!token || token.length < 20) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('safety_link_view' as never, { p_token: token } as never);
  if (error) return null;
  const row = (data as SafetyLinkView[] | null)?.[0];
  return row ?? null;
}

// ---------------------------------------------------------- trusted contacts

/**
 * Somewhere to keep the person you would send a link to.
 *
 * Storing a contact grants that contact nothing. Sharing stays an explicit act
 * every time — "my sister can see all my journeys forever" is a different
 * product, and nobody has decided to build it.
 */
export async function listTrustedContacts(): Promise<TrustedContact[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('trusted_contacts').select('*').order('created_at');
  if (error) throw error;
  return data ?? [];
}

export async function addTrustedContact(input: {
  label: string;
  phone?: string | null;
  email?: string | null;
}): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  if (!input.phone?.trim() && !input.email?.trim()) {
    throw new Error('A trusted contact needs a phone number or an email address.');
  }

  const { error } = await supabase.from('trusted_contacts').insert({
    profile_id: user.id,
    label: input.label.trim(),
    phone: input.phone?.trim() || null,
    email: input.email?.trim() || null,
  });
  if (error) throw error;
  revalidatePath('/request');
}

export async function removeTrustedContact(contactId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.from('trusted_contacts').delete().eq('id', contactId);
  if (error) throw error;
  revalidatePath('/request');
}
