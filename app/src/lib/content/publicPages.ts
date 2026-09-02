import type { Lang } from '@/lib/i18n/dictionary';

// The public pages, as content rather than as markup.
//
// WHY THE CONTENT LIVES HERE
// Two reasons. The pages are bilingual like the rest of the product, and a
// page whose French and English drift apart is a page where one language is
// quietly making a different promise. And a launch review has to be able to
// read every public claim in one place — which is exactly what
// verify:phase10 does with this file.
//
// WHAT IS NOT IN HERE, AND WILL NOT BE
// No number of drivers. No coverage claim beyond the declared pilot
// territory. No response time. No rating, no testimonial, no "trusted by".
// No 24/7. Every one of those is a sentence TowConnect cannot currently
// support, and the moment one appears on a marketing page it becomes a
// promise support has to break in person.

export interface Section {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
}

export interface PublicPageContent {
  title: string;
  lede: string;
  sections: Section[];
  /** Shown as a prominent banner. Used by the legal drafts. */
  banner?: string;
  cta?: { label: string; href: string };
}

export type PublicPageKey =
  | 'about'
  | 'how'
  | 'contact'
  | 'safety'
  | 'towing-montreal'
  | 'towing-south-shore'
  | 'roadside-montreal'
  | 'roadside-south-shore'
  | 'privacy'
  | 'terms'
  | 'partner-terms';

/** The one sentence about coverage that every page is allowed to make. */
export const PILOT_STATEMENT: Record<Lang, string> = {
  fr:
    'TowConnect est en phase pilote sur Montréal et la Rive-Sud. Le service est limité à ce territoire et le réseau de partenaires est en cours de constitution : nous ne promettons ni couverture 24/7 ni délai garanti.',
  en:
    'TowConnect is in a pilot phase covering Montréal and the South Shore. Service is limited to that territory and the partner network is still being built: we promise neither 24/7 coverage nor a guaranteed response time.',
};

export const LEGAL_DRAFT_BANNER: Record<Lang, string> = {
  fr:
    'DRAFT — LEGAL REVIEW REQUIRED. Ce texte décrit fidèlement le fonctionnement réel du système, mais il n’a été révisé par aucun professionnel du droit. Il n’a aucune valeur juridique en l’état.',
  en:
    'DRAFT — LEGAL REVIEW REQUIRED. This text accurately describes how the system actually works, but it has not been reviewed by any legal professional. It has no legal force as it stands.',
};

const fr: Record<PublicPageKey, PublicPageContent> = {
  about: {
    title: 'À propos de TowConnect',
    lede:
      'TowConnect met en relation une personne immobilisée au bord de la route et une entreprise de remorquage disponible, avec un prix affiché avant confirmation et un suivi en direct.',
    sections: [
      {
        heading: 'Ce que nous sommes',
        paragraphs: [
          'TowConnect est une plateforme de mise en relation. Nous ne possédons aucun camion et n’employons aucun chauffeur : les interventions sont effectuées par des entreprises de remorquage indépendantes, avec leurs propres véhicules, leurs propres assurances et leurs propres permis.',
          'Notre rôle est de rendre la demande simple pour la personne immobilisée, et la répartition claire pour l’entreprise qui accepte le travail.',
        ],
      },
      {
        heading: 'Où nous en sommes',
        paragraphs: [
          PILOT_STATEMENT.fr,
          'Nous préférons le dire ici plutôt que de le découvrir ensemble au bord de la route. Si personne n’est disponible, l’application le dit ; elle n’affiche jamais un chauffeur qui n’existe pas.',
        ],
      },
      {
        heading: 'Ce que nous refusons de faire',
        paragraphs: [
          'Certaines décisions de conception valent mieux qu’une promesse commerciale :',
        ],
        bullets: [
          'Aucun délai d’arrivée n’est affiché s’il n’est pas calculé à partir d’une position récente du camion. En l’absence d’information fiable, l’application dit qu’elle ne sait pas.',
          'Aucune zone réglementée n’est activée sans un texte officiel et une géométrie vérifiable. Sur une autoroute où seul un remorqueur mandaté peut intervenir, l’application affiche l’instruction officielle plutôt que de vous envoyer quelqu’un.',
          'Le prix estimé est affiché avant toute confirmation, et il est calculé sur le serveur, pas dans votre navigateur.',
        ],
      },
    ],
    cta: { label: 'Comment ça marche', href: '/comment-ca-marche' },
  },

  how: {
    title: 'Comment ça marche',
    lede: 'Quatre étapes, sans appel téléphonique obligatoire.',
    sections: [
      {
        heading: '1. Vous décrivez la situation',
        paragraphs: [
          'Le type de panne, votre position et votre véhicule. La position est détectée automatiquement si vous l’autorisez ; sinon vous entrez une adresse. Un refus de géolocalisation n’interrompt pas la demande.',
        ],
      },
      {
        heading: '2. Vous voyez le prix avant de confirmer',
        paragraphs: [
          'Le montant estimé s’affiche avant tout engagement. Il est calculé côté serveur à partir de la distance réelle et du type de service.',
          'Si votre position se trouve dans une zone où le remorquage est encadré par une autorité (certaines autoroutes, certains ponts), l’instruction officielle s’affiche à la place — parce que dans ces zones, seul un remorqueur mandaté a le droit d’intervenir.',
        ],
      },
      {
        heading: '3. Un remorqueur est assigné',
        paragraphs: [
          'La répartition est automatique. L’offre est proposée à un chauffeur à la fois, avec un court délai de réponse ; s’il ne répond pas, elle passe au suivant. Vous n’avez personne à appeler.',
        ],
      },
      {
        heading: '4. Vous suivez l’arrivée',
        paragraphs: [
          'La position du camion s’affiche sur la carte. Vous pouvez écrire au chauffeur dans l’application, et partager un lien de suivi avec une personne de confiance — cette personne n’a pas besoin de compte.',
        ],
      },
    ],
    cta: { label: 'Demander de l’aide', href: '/signup' },
  },

  contact: {
    title: 'Nous joindre',
    lede: 'Ce que nous pouvons faire aujourd’hui, et ce que nous ne pouvons pas encore.',
    sections: [
      {
        heading: 'En cas d’urgence',
        paragraphs: [
          'Si vous êtes en danger — sur une voie de circulation, blessé, ou dans une situation qui se dégrade — appelez le 911. TowConnect n’est pas un service d’urgence et ne remplace pas les services d’urgence.',
        ],
      },
      {
        heading: 'Pendant une intervention',
        paragraphs: [
          'Une fois un chauffeur assigné, la messagerie de l’application est le canal le plus direct : elle est rattachée à votre intervention, donc la personne qui vous répond voit immédiatement de quoi il s’agit.',
        ],
      },
      {
        heading: 'Support',
        paragraphs: [
          'Aucun numéro de téléphone ni boîte courriel de support n’est publié à ce jour. Nous préférons ne rien afficher plutôt que d’afficher un canal que personne ne surveille : un numéro qui sonne dans le vide au bord de la route est pire que pas de numéro du tout.',
          'C’est un point ouvert de notre checklist de lancement, et il doit être réglé avant l’ouverture du pilote à des clients réels.',
        ],
      },
      {
        heading: 'Entreprises de remorquage',
        paragraphs: [
          'Si vous exploitez une entreprise de remorquage sur Montréal ou la Rive-Sud et que le projet vous intéresse, c’est exactement ce que nous cherchons en ce moment. Créez un compte et nous prendrons contact.',
        ],
      },
    ],
    cta: { label: 'Créer un compte', href: '/signup' },
  },

  safety: {
    title: 'Sécurité',
    lede: 'Ce que la plateforme fait pour la sécurité, et ce qu’elle ne peut pas faire.',
    sections: [
      {
        heading: 'D’abord : mettez-vous en sécurité',
        paragraphs: [
          'Sur une autoroute, la place la plus sûre est presque toujours derrière la glissière, pas dans le véhicule ni à côté. Allumez vos feux de détresse. Si vous êtes sur une voie de circulation ou si quelqu’un est blessé, appelez le 911 avant toute autre chose.',
        ],
      },
      {
        heading: 'Le lien de suivi',
        paragraphs: [
          'Vous pouvez générer un lien à envoyer à une personne de confiance. Elle voit votre intervention en direct — l’état, la position du camion, le prénom du chauffeur, l’entreprise et la plaque — sans créer de compte.',
          'Ce lien ne montre rien d’autre : aucun montant, aucun numéro de téléphone, aucune de vos autres interventions. Il expire, et vous pouvez le révoquer à tout moment.',
        ],
      },
      {
        heading: 'Qui vient vous chercher',
        paragraphs: [
          'Un chauffeur ne peut pas se mettre en ligne ni recevoir une intervention si ses documents obligatoires sont manquants ou expirés. Cette vérification est appliquée par le système, pas par une consigne interne.',
          'Avant l’arrivée, vous voyez le prénom du chauffeur, l’entreprise et la plaque du véhicule. Vérifiez-les avant de monter ou de confier votre véhicule.',
        ],
      },
      {
        heading: 'Les délais',
        paragraphs: [
          'Un délai d’arrivée n’est affiché que s’il est calculé à partir d’une position récente du camion. Sinon l’application vous dit ce qu’elle sait — par exemple « dernière position reçue il y a 30 minutes » — plutôt que d’inventer une heure d’arrivée.',
        ],
      },
    ],
  },

  'towing-montreal': {
    title: 'Remorquage à Montréal',
    lede:
      'Demander un remorquage sur l’île de Montréal, avec un prix affiché avant confirmation et un suivi en direct.',
    sections: [
      {
        heading: 'Comment se passe une demande',
        paragraphs: [
          'Vous décrivez la panne et votre position, le prix estimé s’affiche, et un remorqueur disponible est assigné automatiquement. Il n’y a pas d’appel obligatoire et pas de négociation au bord de la route.',
        ],
      },
      {
        heading: 'Zones encadrées',
        paragraphs: [
          'Sur certaines autoroutes et certains ponts de la région, le remorquage est réservé à un remorqueur mandaté par l’autorité responsable. Dans ces zones, TowConnect affiche l’instruction officielle et le numéro à appeler au lieu de vous envoyer quelqu’un — parce qu’aucun autre remorqueur n’a le droit d’intervenir.',
        ],
      },
      {
        heading: 'État du service',
        paragraphs: [PILOT_STATEMENT.fr],
      },
    ],
    cta: { label: 'Demander de l’aide', href: '/signup' },
  },

  'towing-south-shore': {
    title: 'Remorquage sur la Rive-Sud',
    lede:
      'Longueuil, Brossard, Saint-Hubert et les environs : demander un remorquage avec un prix affiché avant confirmation.',
    sections: [
      {
        heading: 'Comment se passe une demande',
        paragraphs: [
          'Vous décrivez la panne et votre position, le prix estimé s’affiche, et un remorqueur disponible est assigné automatiquement. Vous suivez ensuite l’arrivée sur la carte.',
        ],
      },
      {
        heading: 'Remorquage vers un garage',
        paragraphs: [
          'Pour un remorquage, vous indiquez la destination avant de confirmer : le prix tient compte de la distance réelle jusqu’à ce garage, et non d’un forfait décidé après coup.',
        ],
      },
      {
        heading: 'État du service',
        paragraphs: [PILOT_STATEMENT.fr],
      },
    ],
    cta: { label: 'Demander de l’aide', href: '/signup' },
  },

  'roadside-montreal': {
    title: 'Assistance routière à Montréal',
    lede: 'Batterie à plat, panne d’essence, pneu crevé, clés enfermées : demander de l’aide sans appeler.',
    sections: [
      {
        heading: 'Les situations couvertes',
        paragraphs: [
          'Toutes ne nécessitent pas un remorquage. Un survoltage, un dépannage d’essence ou un changement de pneu se règlent sur place, et la demande le précise dès le départ pour que le bon véhicule soit envoyé.',
        ],
      },
      {
        heading: 'Le prix',
        paragraphs: [
          'Le montant estimé s’affiche avant que vous confirmiez quoi que ce soit. Si l’intervention révèle un travail supplémentaire, le chauffeur doit vous le proposer et vous devez l’accepter : rien ne s’ajoute à votre facture sans votre accord.',
        ],
      },
      {
        heading: 'État du service',
        paragraphs: [PILOT_STATEMENT.fr],
      },
    ],
    cta: { label: 'Demander de l’aide', href: '/signup' },
  },

  'roadside-south-shore': {
    title: 'Assistance routière sur la Rive-Sud',
    lede: 'Batterie, essence, pneu, clés : de l’aide sur la Rive-Sud, avec le prix affiché à l’avance.',
    sections: [
      {
        heading: 'Sur place plutôt qu’au garage',
        paragraphs: [
          'La plupart des situations d’assistance routière se règlent là où vous êtes. Vous décrivez le problème, le prix s’affiche, et un intervenant équipé pour ce type de panne est assigné.',
        ],
      },
      {
        heading: 'Suivi et partage',
        paragraphs: [
          'Vous suivez l’arrivée sur la carte et pouvez partager un lien de suivi avec une personne de confiance, sans qu’elle ait besoin d’un compte.',
        ],
      },
      {
        heading: 'État du service',
        paragraphs: [PILOT_STATEMENT.fr],
      },
    ],
    cta: { label: 'Demander de l’aide', href: '/signup' },
  },

  privacy: {
    title: 'Politique de confidentialité',
    banner: LEGAL_DRAFT_BANNER.fr,
    lede: 'Ce que TowConnect enregistre, pourquoi, et qui peut le voir.',
    sections: [
      {
        heading: 'Ce que nous enregistrons',
        paragraphs: ['Le strict nécessaire au fonctionnement d’une intervention :'],
        bullets: [
          'Votre compte : nom, courriel, numéro de téléphone si vous le fournissez.',
          'Vos véhicules, si vous en enregistrez.',
          'Vos interventions : type de panne, lieu de prise en charge, destination, notes que vous écrivez, prix, état.',
          'Vos paiements : identifiants Stripe et montants. Aucune donnée de carte bancaire n’est stockée par TowConnect ; elles restent chez Stripe.',
          'Les messages échangés avec le chauffeur pendant une intervention.',
        ],
      },
      {
        heading: 'Ce que nous n’enregistrons pas',
        paragraphs: [
          'Nos statistiques d’usage ne contiennent aucune donnée personnelle : les propriétés autorisées sont limitées par une règle appliquée dans la base de données, et une adresse, un numéro ou le contenu d’un message y sont techniquement refusés.',
        ],
      },
      {
        heading: 'Qui voit quoi',
        paragraphs: [
          'Un chauffeur voit ce qui lui est nécessaire pour l’intervention qui lui est assignée, et rien des autres. Une entreprise voit ses propres chauffeurs et ses propres interventions. Le personnel de TowConnect n’accède qu’aux domaines correspondant à ses habilitations, et chaque export de données est journalisé.',
          'Ces règles sont appliquées par la base de données elle-même, et vérifiées par une suite de tests automatisés.',
        ],
      },
      {
        heading: 'Le lien de suivi',
        paragraphs: [
          'Si vous créez un lien de suivi, la personne qui le reçoit voit uniquement l’état de l’intervention en cours, la position du camion, le prénom du chauffeur, l’entreprise et la plaque. Le lien expire et vous pouvez le révoquer.',
        ],
      },
      {
        heading: 'Durée de conservation',
        paragraphs: [
          'Aucune durée de conservation n’a encore été arrêtée. Nous préférons l’écrire que de recopier une durée standard qui ne correspondrait à aucune décision réelle. C’est un point ouvert de notre checklist avant ouverture.',
        ],
      },
      {
        heading: 'Vos droits',
        paragraphs: [
          'Vous pouvez consulter vos données depuis votre compte. Pour toute autre demande, un canal de contact sera publié avant l’ouverture du pilote — il n’en existe pas encore, et nous ne voulons pas en afficher un qui ne serait pas relevé.',
        ],
      },
    ],
  },

  terms: {
    title: 'Conditions d’utilisation',
    banner: LEGAL_DRAFT_BANNER.fr,
    lede: 'Le rôle de TowConnect, et ce qui relève de l’entreprise de remorquage.',
    sections: [
      {
        heading: 'TowConnect est un intermédiaire',
        paragraphs: [
          'TowConnect met en relation une personne ayant besoin d’une assistance et une entreprise de remorquage indépendante. L’intervention est réalisée par cette entreprise, sous sa responsabilité, avec ses véhicules et son personnel.',
        ],
      },
      {
        heading: 'Prix et paiement',
        paragraphs: [
          'Le prix estimé est affiché avant confirmation. Le paiement est autorisé à ce moment-là et encaissé à la fin de l’intervention. Un supplément ne peut être ajouté que s’il vous est proposé et que vous l’acceptez.',
          'Aucun taux de commission TowConnect n’est actuellement configuré. Tant que ce n’est pas le cas, aucune intervention ne peut être facturée en production.',
        ],
      },
      {
        heading: 'Annulation',
        paragraphs: [
          'Vous pouvez annuler une demande. Selon l’avancement de l’intervention, des frais peuvent s’appliquer ; ils sont calculés selon la configuration économique en vigueur au moment où votre demande a été créée, et non selon une configuration ultérieure.',
        ],
      },
      {
        heading: 'Zones réglementées',
        paragraphs: [
          'Sur certaines routes, le remorquage est réservé à un opérateur mandaté par une autorité publique. TowConnect ne peut pas y envoyer de remorqueur et affiche l’instruction officielle. Ce n’est pas un choix commercial : c’est la règle applicable.',
        ],
      },
      {
        heading: 'Limites',
        paragraphs: [
          'TowConnect n’est pas un service d’urgence. En cas de danger immédiat, appelez le 911.',
          'Aucune disponibilité, aucun délai d’arrivée et aucune couverture géographique ne sont garantis pendant la phase pilote.',
        ],
      },
    ],
  },

  'partner-terms': {
    title: 'Conditions partenaires',
    banner: LEGAL_DRAFT_BANNER.fr,
    lede: 'Ce qu’une entreprise de remorquage peut attendre de TowConnect, et l’inverse.',
    sections: [
      {
        heading: 'Aucune obligation d’accepter',
        paragraphs: [
          'Une offre d’intervention peut toujours être refusée, sans justification et sans pénalité. Un refus fait simplement passer l’offre au candidat suivant.',
        ],
      },
      {
        heading: 'Conformité',
        paragraphs: [
          'Un chauffeur ne peut pas se mettre en ligne ni recevoir d’intervention si ses documents obligatoires sont manquants ou expirés. Cette règle est appliquée par le système et n’est pas négociable au cas par cas.',
          'L’entreprise demeure responsable de ses permis, de ses véhicules et de ses assurances.',
        ],
      },
      {
        heading: 'Rémunération',
        paragraphs: [
          'La compensation du partenaire est figée au moment où l’intervention est acceptée : une modification ultérieure de la configuration économique ne peut pas retarifer un travail déjà accepté.',
          'Aucun taux de commission n’est actuellement configuré. Ce texte ne peut donc pas être considéré comme définitif : le taux applicable devra y figurer avant toute signature.',
        ],
      },
      {
        heading: 'Versements',
        paragraphs: [
          'Les versements passent par Stripe Connect. Tant que le compte Connect d’une entreprise n’est pas complet, un montant peut lui être crédité dans le grand livre sans pouvoir lui être versé — et l’écran de finance distingue explicitement les deux.',
        ],
      },
      {
        heading: 'Assurance et responsabilité',
        paragraphs: [
          'Ce document part du principe que l’entreprise de remorquage porte sa propre couverture d’assurance pour les dommages survenus pendant une intervention. Il s’agit d’une description de l’arrangement envisagé, et non d’un arrangement validé par un assureur ou un juriste. Ce point est ouvert.',
        ],
      },
    ],
  },
};

const en: Record<PublicPageKey, PublicPageContent> = {
  about: {
    title: 'About TowConnect',
    lede:
      'TowConnect connects somebody stranded at the roadside with an available towing company, with the price shown before confirmation and live tracking after it.',
    sections: [
      {
        heading: 'What we are',
        paragraphs: [
          'TowConnect is a marketplace. We own no trucks and employ no drivers: the work is done by independent towing companies, with their own vehicles, their own insurance and their own permits.',
          'Our part is to make the request simple for the person stranded, and the dispatch clear for the company that takes it.',
        ],
      },
      {
        heading: 'Where we are',
        paragraphs: [
          PILOT_STATEMENT.en,
          'We would rather say so here than discover it together at the roadside. If nobody is available, the app says so; it never shows a driver who does not exist.',
        ],
      },
      {
        heading: 'What we refuse to do',
        paragraphs: ['A few design decisions are worth more than a marketing promise:'],
        bullets: [
          'No arrival time is shown unless it was computed from a recent truck position. With nothing reliable to compute from, the app says it does not know.',
          'No regulated zone is switched on without an official text and a verifiable geometry. On a highway where only an authorised operator may work, the app shows the official instruction instead of sending somebody.',
          'The estimated price is shown before any confirmation, and it is computed on the server, not in your browser.',
        ],
      },
    ],
    cta: { label: 'How it works', href: '/comment-ca-marche' },
  },

  how: {
    title: 'How it works',
    lede: 'Four steps, with no phone call required.',
    sections: [
      {
        heading: '1. Describe the situation',
        paragraphs: [
          'The kind of breakdown, where you are, and your vehicle. Location is detected automatically if you allow it; otherwise you type an address. Refusing location does not stop the request.',
        ],
      },
      {
        heading: '2. See the price before confirming',
        paragraphs: [
          'The estimate is shown before you commit to anything. It is computed on the server from the real distance and the type of service.',
          'If you are inside a zone where towing is controlled by an authority — some highways, some bridges — the official instruction is shown instead, because only an authorised operator may work there.',
        ],
      },
      {
        heading: '3. A driver is assigned',
        paragraphs: [
          'Dispatch is automatic. The job is offered to one driver at a time with a short response window; if they do not answer, it moves to the next. There is nobody for you to call.',
        ],
      },
      {
        heading: '4. Follow the arrival',
        paragraphs: [
          'The truck appears on the map. You can message the driver in the app, and share a tracking link with somebody you trust — they need no account.',
        ],
      },
    ],
    cta: { label: 'Get help', href: '/signup' },
  },

  contact: {
    title: 'Contact',
    lede: 'What we can do today, and what we cannot do yet.',
    sections: [
      {
        heading: 'In an emergency',
        paragraphs: [
          'If you are in danger — in a live traffic lane, injured, or in a situation that is getting worse — call 911. TowConnect is not an emergency service and does not replace one.',
        ],
      },
      {
        heading: 'During a job',
        paragraphs: [
          'Once a driver is assigned, the in-app chat is the most direct channel: it is attached to your job, so whoever answers can see immediately what it is about.',
        ],
      },
      {
        heading: 'Support',
        paragraphs: [
          'No support phone number or monitored inbox is published yet. We would rather publish nothing than publish a channel nobody is watching: a number that rings out while you are at the roadside is worse than no number.',
          'It is an open item on our launch checklist, and it has to be closed before the pilot opens to real customers.',
        ],
      },
      {
        heading: 'Towing companies',
        paragraphs: [
          'If you run a towing company in Montréal or on the South Shore and this interests you, that is exactly what we are looking for right now. Create an account and we will be in touch.',
        ],
      },
    ],
    cta: { label: 'Create an account', href: '/signup' },
  },

  safety: {
    title: 'Safety',
    lede: 'What the platform does for safety, and what it cannot do.',
    sections: [
      {
        heading: 'First: get yourself safe',
        paragraphs: [
          'On a highway, the safest place is almost always behind the barrier, not in the vehicle and not beside it. Put your hazards on. If you are in a live lane, or anybody is hurt, call 911 before anything else.',
        ],
      },
      {
        heading: 'The tracking link',
        paragraphs: [
          'You can create a link to send to somebody you trust. They see your job live — the state, the truck position, the driver’s first name, the company and the plate — without creating an account.',
          'The link shows nothing else: no amount, no phone number, none of your other jobs. It expires, and you can revoke it at any time.',
        ],
      },
      {
        heading: 'Who is coming',
        paragraphs: [
          'A driver cannot go online or be dispatched with a missing or expired mandatory document. That check is enforced by the system, not by an internal instruction.',
          'Before they arrive you see the driver’s first name, the company and the plate. Check them before you hand over your vehicle.',
        ],
      },
      {
        heading: 'Arrival times',
        paragraphs: [
          'An arrival time is shown only when it was computed from a recent truck position. Otherwise the app tells you what it knows — "last position received 30 minutes ago" — rather than inventing an hour.',
        ],
      },
    ],
  },

  'towing-montreal': {
    title: 'Towing in Montréal',
    lede: 'Request a tow on the island of Montréal, with the price shown before you confirm and live tracking after.',
    sections: [
      {
        heading: 'How a request works',
        paragraphs: [
          'You describe the breakdown and where you are, the estimate appears, and an available truck is assigned automatically. No mandatory phone call and no negotiating at the roadside.',
        ],
      },
      {
        heading: 'Controlled zones',
        paragraphs: [
          'On some highways and bridges in the region, towing is reserved for an operator mandated by the responsible authority. In those zones TowConnect shows the official instruction and the number to call rather than sending somebody, because no other operator is allowed to work there.',
        ],
      },
      { heading: 'Service status', paragraphs: [PILOT_STATEMENT.en] },
    ],
    cta: { label: 'Get help', href: '/signup' },
  },

  'towing-south-shore': {
    title: 'Towing on the South Shore',
    lede: 'Longueuil, Brossard, Saint-Hubert and nearby: request a tow with the price shown before you confirm.',
    sections: [
      {
        heading: 'How a request works',
        paragraphs: [
          'You describe the breakdown and where you are, the estimate appears, and an available truck is assigned automatically. You then follow the arrival on the map.',
        ],
      },
      {
        heading: 'Towing to a garage',
        paragraphs: [
          'For a tow you give the destination before confirming: the price reflects the real distance to that garage rather than a flat rate decided afterwards.',
        ],
      },
      { heading: 'Service status', paragraphs: [PILOT_STATEMENT.en] },
    ],
    cta: { label: 'Get help', href: '/signup' },
  },

  'roadside-montreal': {
    title: 'Roadside assistance in Montréal',
    lede: 'Flat battery, out of fuel, flat tyre, keys locked in: get help without calling.',
    sections: [
      {
        heading: 'What is covered',
        paragraphs: [
          'Not everything needs a tow. A jump start, a fuel delivery or a tyre change is handled on the spot, and the request says so from the start so the right vehicle is sent.',
        ],
      },
      {
        heading: 'The price',
        paragraphs: [
          'The estimate is shown before you confirm anything. If the job turns out to need extra work, the driver has to propose it and you have to accept: nothing is added to your bill without your agreement.',
        ],
      },
      { heading: 'Service status', paragraphs: [PILOT_STATEMENT.en] },
    ],
    cta: { label: 'Get help', href: '/signup' },
  },

  'roadside-south-shore': {
    title: 'Roadside assistance on the South Shore',
    lede: 'Battery, fuel, tyre, keys: help on the South Shore, with the price shown up front.',
    sections: [
      {
        heading: 'On the spot rather than at a garage',
        paragraphs: [
          'Most roadside situations are resolved where you are. You describe the problem, the price appears, and somebody equipped for that kind of breakdown is assigned.',
        ],
      },
      {
        heading: 'Tracking and sharing',
        paragraphs: [
          'You follow the arrival on the map, and can share a tracking link with somebody you trust, without them needing an account.',
        ],
      },
      { heading: 'Service status', paragraphs: [PILOT_STATEMENT.en] },
    ],
    cta: { label: 'Get help', href: '/signup' },
  },

  privacy: {
    title: 'Privacy policy',
    banner: LEGAL_DRAFT_BANNER.en,
    lede: 'What TowConnect records, why, and who can see it.',
    sections: [
      {
        heading: 'What we record',
        paragraphs: ['Only what a job needs to work:'],
        bullets: [
          'Your account: name, email, and phone number if you give one.',
          'Your vehicles, if you save any.',
          'Your jobs: kind of breakdown, pickup location, destination, notes you write, price, state.',
          'Your payments: Stripe identifiers and amounts. No card details are stored by TowConnect; they stay with Stripe.',
          'Messages exchanged with the driver during a job.',
        ],
      },
      {
        heading: 'What we do not record',
        paragraphs: [
          'Our usage analytics carry no personal data: the permitted properties are limited by a rule enforced inside the database, and an address, a phone number or the content of a message are technically refused.',
        ],
      },
      {
        heading: 'Who sees what',
        paragraphs: [
          'A driver sees what the job assigned to them requires and nothing of any other. A company sees its own drivers and its own jobs. TowConnect staff reach only the domains their capabilities cover, and every data export is logged.',
          'These rules are enforced by the database itself and verified by an automated test suite.',
        ],
      },
      {
        heading: 'The tracking link',
        paragraphs: [
          'If you create a tracking link, whoever receives it sees only the state of the current job, the truck position, the driver’s first name, the company and the plate. The link expires and you can revoke it.',
        ],
      },
      {
        heading: 'Retention',
        paragraphs: [
          'No retention period has been decided yet. We would rather write that than copy a standard number that reflects no actual decision. It is an open item on our checklist before opening.',
        ],
      },
      {
        heading: 'Your rights',
        paragraphs: [
          'You can see your data from your account. For anything else, a contact channel will be published before the pilot opens — none exists yet, and we do not want to show one nobody is reading.',
        ],
      },
    ],
  },

  terms: {
    title: 'Terms of service',
    banner: LEGAL_DRAFT_BANNER.en,
    lede: 'What TowConnect does, and what belongs to the towing company.',
    sections: [
      {
        heading: 'TowConnect is an intermediary',
        paragraphs: [
          'TowConnect connects somebody needing assistance with an independent towing company. The work is performed by that company, under its responsibility, with its vehicles and its people.',
        ],
      },
      {
        heading: 'Price and payment',
        paragraphs: [
          'The estimated price is shown before confirmation. Payment is authorized at that point and captured when the job ends. A supplement can only be added if it is proposed to you and you accept it.',
          'No TowConnect commission rate is currently configured. Until one is, no job can be billed in production.',
        ],
      },
      {
        heading: 'Cancellation',
        paragraphs: [
          'You can cancel a request. Depending on how far the job has progressed, a fee may apply; it is computed from the economic configuration in force when your request was created, never from a later one.',
        ],
      },
      {
        heading: 'Regulated zones',
        paragraphs: [
          'On some roads, towing is reserved for an operator mandated by a public authority. TowConnect cannot send a truck there and shows the official instruction instead. That is not a commercial choice: it is the applicable rule.',
        ],
      },
      {
        heading: 'Limits',
        paragraphs: [
          'TowConnect is not an emergency service. In immediate danger, call 911.',
          'No availability, no arrival time and no geographic coverage are guaranteed during the pilot.',
        ],
      },
    ],
  },

  'partner-terms': {
    title: 'Partner terms',
    banner: LEGAL_DRAFT_BANNER.en,
    lede: 'What a towing company can expect from TowConnect, and the other way round.',
    sections: [
      {
        heading: 'No obligation to accept',
        paragraphs: [
          'A job offer can always be declined, without justification and without penalty. Declining simply moves the offer to the next candidate.',
        ],
      },
      {
        heading: 'Compliance',
        paragraphs: [
          'A driver cannot go online or receive a job with a missing or expired mandatory document. That rule is enforced by the system and is not negotiable case by case.',
          'The company remains responsible for its permits, its vehicles and its insurance.',
        ],
      },
      {
        heading: 'Compensation',
        paragraphs: [
          'Partner compensation is frozen when the job is accepted: a later change to the economic configuration cannot reprice work that was already accepted.',
          'No commission rate is currently configured. This text therefore cannot be treated as final: the applicable rate has to appear in it before anybody signs.',
        ],
      },
      {
        heading: 'Payouts',
        paragraphs: [
          'Payouts run through Stripe Connect. While a company’s Connect account is incomplete, an amount can be credited to it in the ledger without being payable — and the finance screen distinguishes the two explicitly.',
        ],
      },
      {
        heading: 'Insurance and liability',
        paragraphs: [
          'This document assumes the towing company carries its own insurance for damage occurring during a job. That is a description of the intended arrangement, not one validated by an insurer or a lawyer. The point is open.',
        ],
      },
    ],
  },
};

export const PUBLIC_PAGES: Record<Lang, Record<PublicPageKey, PublicPageContent>> = { fr, en };
