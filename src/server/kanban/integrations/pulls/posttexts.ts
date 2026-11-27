// The fixed lines the office writes itself in a review it posts on a pull request (postreview.ts): the heading and the
// notes about a cut or empty review. They follow the project's public language for the nine
// languages the office suggests (shared/language.ts); any other language, or none, gets English. The reviewer's own text is not touched.

export interface PostTexts {
  /** The first line of the review. */
  heading(approved: boolean): string;
  /** Ends a review that was too long to post. */
  cutLong: string;
  /** Ends a review whose text the office cut. */
  cutKept: string;
  /** Stands for a review without any findings. */
  none: string;
}

function table(approved: string, changes: string, cutLong: string, cutKept: string, none: string): PostTexts {
  return { heading: (ok) => `**${ok ? approved : changes}**`, cutLong, cutKept, none };
}

const TEXTS: Record<string, PostTexts> = {
  english: table('Review: approved', 'Review: changes requested', '(The review is cut off here: it is too long to post.)', '(The text of the review was cut here: the office kept only its first part.)', '(The reviewer gave no findings.)'),
  finnish: table('Katselmointi: hyväksytty', 'Katselmointi: muutoksia pyydetty', '(Katselmointi katkeaa tähän: se on liian pitkä julkaistavaksi.)', '(Katselmoinnin teksti katkaistiin tästä: toimisto säilytti vain sen alkuosan.)', '(Katselmoija ei antanut löydöksiä.)'),
  swedish: table('Granskning: godkänd', 'Granskning: ändringar begärda', '(Granskningen avbryts här: den är för lång för att publiceras.)', '(Granskningens text klipptes här: kontoret behöll bara dess första del.)', '(Granskaren lämnade inga synpunkter.)'),
  norwegian: table('Gjennomgang: godkjent', 'Gjennomgang: endringer ønskes', '(Gjennomgangen avbrytes her: den er for lang til å publiseres.)', '(Teksten i gjennomgangen ble kuttet her: kontoret beholdt bare den første delen.)', '(Gjennomgangeren ga ingen funn.)'),
  danish: table('Gennemgang: godkendt', 'Gennemgang: ændringer ønskes', '(Gennemgangen afbrydes her: den er for lang til at blive offentliggjort.)', '(Gennemgangens tekst blev afskåret her: kontoret beholdt kun den første del.)', '(Gennemgangeren gav ingen fund.)'),
  estonian: table('Ülevaatus: heaks kiidetud', 'Ülevaatus: muudatusi küsitud', '(Ülevaatus katkeb siin: see on avaldamiseks liiga pikk.)', '(Ülevaatuse tekst lõigati siit: kontor jättis alles ainult selle algusosa.)', '(Ülevaataja ei esitanud leide.)'),
  german: table('Review: genehmigt', 'Review: Änderungen angefordert', '(Das Review wird hier abgeschnitten: es ist zu lang zum Veröffentlichen.)', '(Der Text des Reviews wurde hier gekürzt: das Büro hat nur den ersten Teil behalten.)', '(Der Reviewer hat keine Befunde angegeben.)'),
  french: table('Revue : approuvée', 'Revue : modifications demandées', '(La revue est tronquée ici : elle est trop longue pour être publiée.)', '(Le texte de la revue a été coupé ici : le bureau n’en a gardé que le début.)', '(Le relecteur n’a signalé aucun point.)'),
  spanish: table('Revisión: aprobada', 'Revisión: cambios solicitados', '(La revisión se corta aquí: es demasiado larga para publicarla.)', '(El texto de la revisión se cortó aquí: la oficina solo conservó su primera parte.)', '(El revisor no indicó ningún hallazgo.)'),
};

/** The fixed lines of a posted review in `language` (an English name, any case); English for any other language or none. */
export function postTexts(language?: string): PostTexts {
  const key = (language ?? '').trim().toLowerCase();
  return Object.hasOwn(TEXTS, key) ? TEXTS[key] : TEXTS.english;
}
