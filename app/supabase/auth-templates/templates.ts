// The three transactional emails Supabase Auth sends on TowConnect's behalf.
//
// WHY THEY LIVE IN THE REPOSITORY
// They are applied to the project through the Supabase Management API, which
// means the live copy is a setting in somebody's dashboard — the classic
// place for text to drift from the product without anybody noticing. Keeping
// the canonical version here makes the copy reviewable in a pull request,
// and `verify:phase10` reads this file and compares it to what the project
// actually has.
//
// FRENCH FIRST, BOTH IN ONE MESSAGE
// The pilot is Montréal and the South Shore and the product renders French by
// default, so French leads. English follows inside the same email rather than
// in a separate template, because Supabase sends one template per event and a
// bilingual city deserves both in the envelope it receives.
//
// DELIBERATELY PLAIN
// No image, no external stylesheet, no tracking pixel. A transactional email
// that renders as an empty box because a mail client blocked a CDN is a
// customer who cannot create an account.

const FOOT_FR = 'TowConnect — remorquage et assistance routière, Montréal & Rive-Sud.';
const FOOT_EN = 'TowConnect — towing and roadside assistance, Montréal & South Shore.';

const wrap = (bodyFr: string, bodyEn: string) =>
  `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#1a1a1a;max-width:520px">
<p style="font-weight:700;font-size:18px;letter-spacing:-0.01em;margin:0 0 20px">TowConnect</p>
${bodyFr}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:28px 0">
${bodyEn}
<p style="color:#888;font-size:12px;margin:28px 0 0">${FOOT_FR}<br>${FOOT_EN}</p>
</div>`;

// #cc4400 rather than the brand orange: white on #ff5c1a measures 3.09:1,
// which fails WCAG AA. The same decision the buttons in the product took in
// Phase 10, applied here so an email and a screen do not disagree.
const button = (label: string) =>
  `<p style="margin:0 0 20px"><a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#cc4400;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:10px">${label}</a></p>`;

export const AUTH_TEMPLATES: Record<string, string> = {
  mailer_subjects_confirmation: 'Confirmez votre adresse courriel — TowConnect',
  mailer_templates_confirmation_content: wrap(
    `<p style="margin:0 0 12px">Confirmez cette adresse pour terminer la création de votre compte TowConnect.</p>
${button('Confirmer mon adresse')}
<p style="color:#666;font-size:13px;margin:0">Si vous n'avez pas créé de compte, ignorez ce message.</p>`,
    `<p style="margin:0 0 12px">Confirm this address to finish creating your TowConnect account.</p>
<p style="margin:0 0 12px"><a href="{{ .ConfirmationURL }}" style="color:#cc4400;font-weight:600">Confirm my email address</a></p>
<p style="color:#666;font-size:13px;margin:0">If you did not create an account, ignore this message.</p>`
  ),

  mailer_subjects_recovery: 'Réinitialiser votre mot de passe — TowConnect',
  mailer_templates_recovery_content: wrap(
    `<p style="margin:0 0 12px">Nous avons reçu une demande de réinitialisation de votre mot de passe.</p>
${button('Choisir un nouveau mot de passe')}
<p style="color:#666;font-size:13px;margin:0">Si vous n'avez rien demandé, ignorez ce message : votre mot de passe reste inchangé.</p>`,
    `<p style="margin:0 0 12px">We received a request to reset your password.</p>
<p style="margin:0 0 12px"><a href="{{ .ConfirmationURL }}" style="color:#cc4400;font-weight:600">Choose a new password</a></p>
<p style="color:#666;font-size:13px;margin:0">If you did not ask for this, ignore this message — your password is unchanged.</p>`
  ),

  mailer_subjects_magic_link: 'Votre lien de connexion — TowConnect',
  mailer_templates_magic_link_content: wrap(
    `<p style="margin:0 0 12px">Voici votre lien de connexion. Il expire rapidement et ne peut servir qu'une fois.</p>
${button('Se connecter')}
<p style="color:#666;font-size:13px;margin:0">Si vous n'avez rien demandé, ignorez ce message.</p>`,
    `<p style="margin:0 0 12px">Here is your sign-in link. It expires shortly and can only be used once.</p>
<p style="margin:0 0 12px"><a href="{{ .ConfirmationURL }}" style="color:#cc4400;font-weight:600">Sign in</a></p>
<p style="color:#666;font-size:13px;margin:0">If you did not ask for this, ignore this message.</p>`
  ),
};
