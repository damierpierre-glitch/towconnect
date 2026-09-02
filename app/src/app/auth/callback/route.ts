import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { recordEvent } from '@/lib/actions/analytics';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // The OAuth half of `auth_completed`. Recorded here rather than in the
      // browser because this redirect IS the completion for Google sign-in —
      // without it the funnel would count every Google start and no Google
      // finish, and the drop-off between the two would be pure fiction.
      await recordEvent({ name: 'auth_completed', props: { source: 'oauth' } });
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
