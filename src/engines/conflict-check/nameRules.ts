// c57 — name knowledge used by the matcher: nickname groups (English and
// Spanish, for the Texas pilot), Spanish name particles, business suffixes,
// and a phonetic key. Pure data and pure functions, no database.
//
// These are MATCHING heuristics, not legal rules: they only decide what is
// shown to a human conflicts attorney. They are tuned to over-flag.

/**
 * Groups of given names that refer to the same person. A name may sit in
 * more than one group ("alex" is short for Alexander and Alejandro), so
 * lookups return every group a name belongs to.
 */
export const NICKNAME_GROUPS: readonly (readonly string[])[] = [
  ["william", "bill", "billy", "will", "willy", "liam", "guillermo", "memo"],
  ["robert", "bob", "bobby", "rob", "robbie", "bert", "roberto", "beto"],
  ["richard", "rick", "ricky", "dick", "rich", "ricardo", "ricky"],
  ["elizabeth", "liz", "lizzy", "beth", "betty", "eliza", "lisa", "elisa", "isabel", "chabela"],
  ["katherine", "catherine", "kathryn", "kathy", "kate", "katie", "cathy", "kat", "catalina"],
  ["margaret", "maggie", "peggy", "meg", "margarita", "rita"],
  ["james", "jim", "jimmy", "jamie", "jaime", "diego"],
  ["john", "jack", "johnny", "jon", "juan", "juanito"],
  ["joseph", "joe", "joey", "jose", "pepe", "chepe"],
  ["michael", "mike", "mikey", "mick", "miguel"],
  ["jennifer", "jen", "jenny"],
  ["christopher", "chris", "topher", "cristobal"],
  ["christina", "christine", "chris", "tina", "cristina"],
  ["daniel", "dan", "danny"],
  ["anthony", "tony", "antonio", "tono"],
  ["francisco", "frank", "paco", "pancho", "cisco", "francis"],
  ["guadalupe", "lupe", "lupita"],
  ["alejandro", "alex", "alejo", "jandro"],
  ["alexander", "alex", "sasha", "xander", "alejandro"],
  ["alexandra", "alex", "sandra", "alejandra"],
  ["maria", "mary", "mari", "marie", "maruca"],
  ["jesus", "chuy", "chucho"],
  ["enrique", "kike", "henry", "hank", "harry"],
  ["eduardo", "lalo", "edward", "ed", "eddie", "ted", "teddy"],
  ["ignacio", "nacho"],
  ["rosario", "chayo"],
  ["concepcion", "concha", "conchita"],
  ["dolores", "lola", "lolita"],
  ["mercedes", "meche"],
  ["gerardo", "jerry", "gerry"],
  ["alfredo", "fredo", "alfred", "al", "fred"],
  ["rafael", "rafa", "ralph"],
  ["manuel", "manny", "manolo", "emmanuel"],
  ["fernando", "nando", "ferdinand"],
  ["gabriel", "gabe", "gabi"],
  ["gabriela", "gaby", "gabi"],
  ["patricia", "pat", "patty", "tricia", "paty"],
  ["patrick", "pat", "paddy", "patricio"],
  ["thomas", "tom", "tommy", "tomas"],
  ["charles", "charlie", "chuck", "carlos", "charly"],
  ["steven", "stephen", "steve", "esteban"],
  ["matthew", "matt", "mateo"],
  ["andrew", "andy", "drew", "andres"],
  ["nicholas", "nick", "nicky", "nicolas"],
  ["samuel", "sam", "sammy"],
  ["samantha", "sam", "sammy"],
  ["benjamin", "ben", "benny", "benji"],
  ["jonathan", "jon", "johnny", "nathan"],
  ["timothy", "tim", "timmy"],
  ["gregory", "greg"],
  ["jeffrey", "jeff", "geoffrey"],
  ["lawrence", "larry", "laurence"],
  ["ronald", "ron", "ronnie"],
  ["donald", "don", "donnie"],
  ["kenneth", "ken", "kenny"],
  ["susan", "sue", "suzy", "susana"],
  ["deborah", "debbie", "deb", "debra"],
  ["rebecca", "becky", "becca"],
  ["victoria", "vicky", "tori"],
  ["abigail", "abby", "gail"],
  ["amanda", "mandy"],
  ["jessica", "jess", "jessie"],
  ["barbara", "barb", "barbie"],
  ["dorothy", "dot", "dottie"],
  ["virginia", "ginny", "ginger"],
  ["theresa", "teresa", "terry", "tere"],
  ["josephine", "josie", "jo", "josefina", "chepina"],
  ["cynthia", "cindy"],
  ["sylvia", "silvia", "chivis"],
];

const NICKNAME_INDEX: ReadonlyMap<string, ReadonlySet<number>> = (() => {
  const map = new Map<string, Set<number>>();
  NICKNAME_GROUPS.forEach((group, i) => {
    for (const name of group) {
      const set = map.get(name) ?? new Set<number>();
      set.add(i);
      map.set(name, set);
    }
  });
  return map;
})();

/** True when two given-name tokens can be the same person by nickname. Pure. */
export function isNicknamePair(a: string, b: string): boolean {
  if (a === b) return false;
  const ga = NICKNAME_INDEX.get(a);
  const gb = NICKNAME_INDEX.get(b);
  if (!ga || !gb) return false;
  for (const g of ga) if (gb.has(g)) return true;
  return false;
}

/** Business suffixes ignored when comparing organisation names ("Acme LLC" = "Acme"). */
export const ORG_SUFFIXES: ReadonlySet<string> = new Set([
  "llc", "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited", "lp", "llp", "pllc",
  "pc", "pa", "the", "and", "sa", "cv", "de", "srl", "trust", "holdings", "group", "enterprises",
]);

/** Spanish / Portuguese / Dutch surname particles ignored in comparisons ("Maria de la Cruz" = "Maria Cruz"). */
export const NAME_PARTICLES: ReadonlySet<string> = new Set(["de", "del", "la", "las", "los", "y", "da", "do", "dos", "van", "von", "der", "di"]);

/** Generational suffixes that never distinguish a person on their own. */
export const GENERATIONAL_SUFFIXES: ReadonlySet<string> = new Set(["jr", "sr", "ii", "iii", "iv"]);

/**
 * Comparable tokens of a normalised name: drops particles and generational
 * suffixes for people, and business suffixes for organisations. Never returns
 * an empty list when the input had tokens. Pure.
 */
export function comparableTokens(normalized: string, kind: "person" | "organization" | "unknown" = "unknown"): string[] {
  const toks = normalized.split(" ").filter(Boolean);
  const drop = (t: string) =>
    kind === "organization"
      ? ORG_SUFFIXES.has(t)
      : kind === "person"
        ? NAME_PARTICLES.has(t) || GENERATIONAL_SUFFIXES.has(t)
        : ORG_SUFFIXES.has(t) || NAME_PARTICLES.has(t) || GENERATIONAL_SUFFIXES.has(t);
  const kept = toks.filter((t) => !drop(t));
  return kept.length > 0 ? kept : toks;
}

/**
 * A phonetic key for one normalised token, tuned for English and Spanish
 * names as spoken in Texas: silent h, b/v, s/z/soft c, y/i/ll, ph/f, qu/k,
 * doubled letters, and vowels after the first letter all collapse. So
 * "Smyth" = "Smith", "Gonzales" = "Gonzalez", "Ybarra" = "Ibarra",
 * "Hernandez" = "Ernandez", "Jon" = "John". Digits are kept as-is. Pure.
 */
export function phoneticKey(token: string): string {
  if (!token) return "";
  if (/^\d+$/.test(token)) return token;
  let s = token.toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return "";
  s = s.replace(/^(kn|gn|pn|wr)/, (m) => m[1]!);
  s = s
    .replace(/ph/g, "v")
    .replace(/th/g, "t")
    .replace(/sch/g, "sk")
    .replace(/(ch|sh)/g, "9") // one "sh"-like sound
    .replace(/ll/g, "y")
    .replace(/qu/g, "k")
    .replace(/ck/g, "k")
    .replace(/gu(?=[ei])/g, "g")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/v/g, "b")
    .replace(/w/g, "u")
    .replace(/y/g, "i")
    .replace(/h/g, "");
  if (!s) return token.slice(0, 1);
  const first = /[aeiou]/.test(s[0]!) ? "a" : s[0]!;
  const rest = s.slice(1).replace(/[aeiou]/g, "");
  return (first + rest).replace(/(.)\1+/g, "$1");
}

/** Phonetic keys of a whole normalised name (one per comparable token). Pure. */
export function phoneticKeys(normalized: string): string[] {
  return comparableTokens(normalized).map(phoneticKey).filter(Boolean);
}

/**
 * Match keys stored for a party so the database prefilter can find
 * near-misses the SQL text filter would miss (typos in the first AND last
 * three letters, nicknames). One key per phonetic token plus one per
 * nickname group ("n:<group>"). Pure.
 */
export function matchKeysForName(normalized: string): string[] {
  const keys = new Set<string>();
  for (const t of comparableTokens(normalized)) {
    if (t.length < 2) continue;
    const p = phoneticKey(t);
    if (p) keys.add(`p:${p}`);
    for (const g of NICKNAME_INDEX.get(t) ?? []) keys.add(`n:${g}`);
  }
  return [...keys];
}

/** Normalise a postal address for comparison ("123 Main St., Apt 4" = "123 main street apt 4"). Pure. */
export function normalizeAddress(value: string | null | undefined): string {
  const words: Record<string, string> = {
    st: "street", str: "street", ave: "avenue", av: "avenue", rd: "road", dr: "drive", ln: "lane", blvd: "boulevard",
    ct: "court", hwy: "highway", pkwy: "parkway", apt: "unit", ste: "unit", suite: "unit", unit: "unit", n: "north",
    s: "south", e: "east", w: "west",
  };
  return (value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => words[w] ?? w)
    .join(" ");
}
