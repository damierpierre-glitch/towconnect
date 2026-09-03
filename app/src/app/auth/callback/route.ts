import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { recordEvent } from '@/lib/actions/analytics';
import { safeNext } from '@/lib/safeRedirect';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  // `next` comes from a URL somebody can craft, so it is validated rather than
  // concatenated. See src/lib/safeRedirect.ts for what is refused and why.
  const next = safeNext(searchParams.get('next'));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // The OAuth half of `auth_completed`. Recorded here rather than in the
      // browser because this redirect IS the completion for Google sign-in —
      // without it the funnel would count every Google start and no Google
      // finish, and the drop-off between the two would be pure fiction.
      //
      // A password recovery lands here too, and is deliberately NOT counted as
      // an authentication in the acquisition funnel: somebody resetting a
      // password is not a new customer arriving.
      if (next !== '/nouveau-mot-de-passe') {
        await recordEvent({ name: 'auth_completed', props: { source: 'oauth' } });
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
